import * as fs from 'fs';
import { Bridge } from './bridge';
import { RuntimeLease } from './runtimeLease';
import { RuntimeStatus } from './runtimeBridge';
import { SubagentBackends, ResolvedModel, chatCompletionRaw, forgeEnsure, forgeRelease } from './subagent';
import { BOARD_TOOL_SCHEMAS, executeBoardTool } from './boardTools';
import { BoardEvent } from './types';
import { CompletionResponse, runToolCompletionRound } from './toolCompletionRound';
import { ToolLoopGuard } from './toolLoopGuard';
const { shouldTrigger } = require('../scripts/bridgeEventFilter') as { shouldTrigger: (event: BoardEvent, agent: string, mode?: string) => boolean };

export interface ForgeCoordinatorModel {
    name: string;
    profile?: string;
    profiles?: string[];
    servable?: boolean;
    provider?: string;
    backend?: string;
    route?: 'ensure' | 'chat';
    availability?: 'ready' | 'loadable' | 'loading' | 'busy' | 'degraded' | 'unavailable' | 'unknown';
    availabilityReason?: string;
}
export interface ForgeCoordinatorOptions {
    bridge: Bridge;
    backends: SubagentBackends;
    controlUrl: string;
    boardEndpoint: string;
    eventsPath: string;
    repoRoot: string;
    extensionVersion: string;
    idleReleaseMs?: number;
    historyLimit?: number;
    onStatus?: (status: RuntimeStatus, detail: string) => void;
    onLog?: (line: string) => void;
}

type Message = Record<string, unknown>;
const AGENT = 'forge-coordinator';

export class ForgeCoordinatorBridge {
    private model = '';
    private running = false;
    private processing = false;
    private cursor = 0;
    private poll: NodeJS.Timeout | null = null;
    private stopPoll: NodeJS.Timeout | null = null;
    private idleRelease: NodeJS.Timeout | null = null;
    private held = false;
    private requiresHold = true;
    private resolved: ResolvedModel | null = null;
    private selectedEntry: ForgeCoordinatorModel | null = null;
    private abort: AbortController | null = null;
    private history: Message[] = [];
    private stoppingForCommand = false;
    private readonly acknowledgedCommands = new Set<string>();
    private readonly lease: RuntimeLease;

    constructor(private readonly opts: ForgeCoordinatorOptions) {
        this.lease = new RuntimeLease(opts.boardEndpoint, AGENT, opts.repoRoot, process.pid, opts.extensionVersion);
    }

    static async listModels(controlUrl: string): Promise<ForgeCoordinatorModel[]> {
        const res = await fetch(`${controlUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Forge /models HTTP ${res.status}`);
        const data = await res.json() as { models?: Array<ForgeCoordinatorModel & { reason?: string }> };
        const profileRank = (profile?: string) => profile === 'main' ? 0 : profile === 'subcoordinator' ? 1 : 2;
        return (data.models ?? []).flatMap(raw => {
            const reason = raw.availabilityReason ?? raw.reason;
            const model = { ...raw, ...(reason ? { availabilityReason: reason } : {}) };
            return model.profiles?.length
                ? model.profiles.map(profile => ({ ...model, name: `${model.name}@${profile}`, profile, profiles: undefined }))
                : [model];
        })
            // Coordinator dropdown: @main entries first so the usual pick is near the top.
            .sort((a, b) => profileRank(a.profile) - profileRank(b.profile) || a.name.localeCompare(b.name));
    }

    status(): RuntimeStatus { return this.running ? (this.processing ? 'linked' : 'waiting') : 'inactive'; }
    selectedModel(): string { return this.model; }

    async start(model: string): Promise<void> {
        await this.stop();
        if (!model) throw new Error('Select a Forge coordinator model.');
        let acquired = this.lease.tryAcquire();
        for (let i = 0; acquired === 'held-by-live-other' && i < 8; i++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            acquired = this.lease.tryAcquire();
        }
        if (acquired === 'held-by-live-other') throw new Error('Another coordinator or Claude bridge already owns this board.');
        this.model = model;
        try {
            const catalog = await ForgeCoordinatorBridge.listModels(this.opts.controlUrl);
            const entry = catalog.find(candidate => candidate.name === model);
            if (!entry) throw new Error(`Selected Forge coordinator model "${model}" is stale or missing from the current catalog.`);
            if (entry.availability === 'loading' || entry.availability === 'busy' || entry.availability === 'unavailable') {
                throw new Error(`Forge coordinator model "${model}" is ${entry.availability}${entry.availabilityReason ? ` (${entry.availabilityReason})` : ''}.`);
            }
            this.selectedEntry = entry;
            this.requiresHold = entry.route ? entry.route === 'ensure' : entry.servable !== false;
        } catch (err) {
            this.lease.releaseIfOwned();
            throw err;
        }
        this.running = true;
        this.acknowledgedCommands.clear();
        this.cursor = fs.existsSync(this.opts.eventsPath) ? fs.statSync(this.opts.eventsPath).size : 0;
        this.history = [{ role: 'system', content: this.systemPrompt() }];
        this.lease.markBridgeStarted(process.pid);
        this.opts.onStatus?.('waiting', `Forge coordinator ${model} waiting for board events.`);
        this.poll = setInterval(() => void this.scan(), 500);
        this.stopPoll = setInterval(() => void this.stopForBlockingCommand(), 250);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.poll) clearInterval(this.poll);
        if (this.stopPoll) clearInterval(this.stopPoll);
        if (this.idleRelease) clearTimeout(this.idleRelease);
        this.poll = this.stopPoll = this.idleRelease = null;
        this.abort?.abort();
        this.abort = null;
        if (this.requiresHold && this.held && this.model) await forgeRelease(this.opts.controlUrl, this.model);
        this.held = false;
        this.resolved = null;
        this.selectedEntry = null;
        this.lease.releaseIfOwned();
        this.opts.onStatus?.('inactive', 'Forge coordinator disconnected.');
    }

    private async scan(): Promise<void> {
        if (!this.running || this.processing || !fs.existsSync(this.opts.eventsPath)) return;
        const stat = fs.statSync(this.opts.eventsPath);
        if (stat.size < this.cursor) this.cursor = 0;
        if (stat.size === this.cursor) return;
        const fd = fs.openSync(this.opts.eventsPath, 'r');
        try {
            const buffer = Buffer.alloc(stat.size - this.cursor);
            fs.readSync(fd, buffer, 0, buffer.length, this.cursor);
            this.cursor = stat.size;
            const events = buffer.toString('utf8').split('\n').map(line => { try { return JSON.parse(line) as BoardEvent; } catch { return null; } }).filter(Boolean) as BoardEvent[];
            const triggering = events.filter(e => shouldTrigger(e, AGENT, 'all'));
            if (triggering.length) await this.handleBurst(triggering);
        } finally { fs.closeSync(fd); }
    }

    private async handleBurst(events: BoardEvent[], attempt = 0): Promise<void> {
        this.processing = true;
        this.abort = new AbortController();
        this.opts.onStatus?.('linked', `Forge coordinator ${this.model} handling ${events.length} event(s).`);
        try {
            const blocking = this.opts.bridge.getBlockingCommands(AGENT);
            if (blocking.length) { this.abort.abort(); return; }
            if (this.requiresHold) {
                if (!this.held) {
                    const ensured = await forgeEnsure(this.opts.controlUrl, this.model);
                    this.validateEnsure(ensured);
                    this.resolved = { backend: ensured.backend, model: ensured.model, baseUrl: ensured.baseUrl };
                    this.held = true;
                }
            } else {
                this.resolved = { backend: 'forge-chat', model: this.model, baseUrl: this.opts.controlUrl };
            }
            this.history.push({ role: 'user', content: `Board event burst:\n${events.map(e => JSON.stringify(e)).join('\n')}` });
            await this.runToolLoop();
            this.trimHistory();
            this.armIdleRelease();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.opts.onLog?.(`Forge coordinator failure: ${message}`);
            if (this.requiresHold && this.held) {
                await forgeRelease(this.opts.controlUrl, this.model);
                this.held = false;
                this.resolved = null;
            }
            const blocking = this.opts.bridge.getBlockingCommands(AGENT);
            if (blocking.length) {
                for (const command of blocking) {
                    if (this.acknowledgedCommands.has(command.id)) continue;
                    try {
                        this.opts.bridge.ack(AGENT, command.id, 'Coordinator stopped in-flight work.');
                        this.acknowledgedCommands.add(command.id);
                    } catch { /* already resolved */ }
                }
            } else if (this.running && attempt < 3) {
                const delay = 1000 * 2 ** attempt;
                this.opts.bridge.post(AGENT, `Forge coordinator error: ${message}; retrying in ${delay}ms`.replace(/\s+/g, ' ').slice(0, 1000));
                await new Promise(resolve => setTimeout(resolve, delay));
                if (this.running) await this.handleBurst(events, attempt + 1);
            } else if (!blocking.length) {
                this.opts.bridge.post(AGENT, `Forge coordinator error: ${message}`.replace(/\s+/g, ' ').slice(0, 1000));
            }
        } finally {
            this.processing = false;
            this.abort = null;
            if (this.running) this.opts.onStatus?.('waiting', `Forge coordinator ${this.model} waiting for board events.`);
        }
    }

    private async stopForBlockingCommand(): Promise<void> {
        if (!this.processing || this.stoppingForCommand) return;
        const blocking = this.opts.bridge.getBlockingCommands(AGENT);
        if (!blocking.length) return;
        this.stoppingForCommand = true;
        try {
            for (const command of blocking) {
                if (this.acknowledgedCommands.has(command.id)) continue;
                try {
                    this.opts.bridge.ack(AGENT, command.id, 'Coordinator stopped in-flight work.');
                    this.acknowledgedCommands.add(command.id);
                } catch { /* already resolved */ }
            }
            this.abort?.abort();
            if (this.requiresHold && this.held) {
                this.held = false;
                this.resolved = null;
                await forgeRelease(this.opts.controlUrl, this.model);
            }
        } finally {
            this.stoppingForCommand = false;
        }
    }

    private async runToolLoop(): Promise<void> {
        let usedTools = false;
        const loopGuard = new ToolLoopGuard();
        for (let step = 0; step < 12; step++) {
            if (this.opts.bridge.getBlockingCommands(AGENT).length) { this.abort?.abort(); return; }
            const round = await runToolCompletionRound({
                messages: this.history,
                complete: () => {
                    if (!this.resolved) throw new Error('Forge coordinator has no resolved model endpoint');
                    return chatCompletionRaw(this.resolved, {
                        messages: this.history,
                        // OpenAI-compatible providers require `function.parameters`; the MCP-shaped
                        // `inputSchema` key is rejected outright by strict ones (e.g. Cerebras HTTP 400).
                        tools: BOARD_TOOL_SCHEMAS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
                        tool_choice: 'auto',
                    }, this.abort?.signal) as Promise<CompletionResponse>;
                },
                beforeTool: (name, args) => {
                    if (this.opts.bridge.getBlockingCommands(AGENT).length) {
                        this.abort?.abort();
                        throw new DOMException('Coordinator stopped before tool execution.', 'AbortError');
                    }
                    loopGuard.beforeCall(name, args);
                },
                executeTool: async (name, args) => {
                    args.agent = AGENT;
                    const result = await executeBoardTool(this.opts.bridge, this.opts.backends, name, args)
                        .catch(err => `ERROR: ${err instanceof Error ? err.message : String(err)}`);
                    loopGuard.afterCall(result);
                    return result;
                },
                missingMessageError: 'Forge /chat returned no assistant message',
                emptyLengthError: 'coordinator produced no output and hit the token limit (reasoning/length overflow)',
                maxToolResultChars: 8_000,
            });
            usedTools ||= round.toolCalls > 0;
            if (round.finished) {
                if (!usedTools && round.finalText) {
                    this.opts.bridge.post(AGENT, round.finalText.replace(/\s+/g, ' ').slice(0, 1000));
                }
                return;
            }
        }
        throw new Error('Coordinator exceeded 12 tool rounds for one event burst');
    }

    private armIdleRelease(): void {
        if (this.idleRelease) clearTimeout(this.idleRelease);
        this.idleRelease = setTimeout(() => void (async () => {
            if (this.requiresHold && this.held) await forgeRelease(this.opts.controlUrl, this.model);
            this.held = false;
        })(), this.opts.idleReleaseMs ?? 300_000);
    }

    private validateEnsure(ensured: { model: string; backend: string }): void {
        if (ensured.model !== this.model) {
            throw new Error(`Forge routing drift: selected "${this.model}" but /ensure resolved "${ensured.model}".`);
        }
        if (this.selectedEntry?.backend && ensured.backend !== this.selectedEntry.backend) {
            throw new Error(`Forge backend drift for "${this.model}": catalog=${this.selectedEntry.backend}, ensure=${ensured.backend}.`);
        }
    }

    private trimHistory(): void {
        const limit = this.opts.historyLimit ?? 40;
        if (this.history.length <= limit) return;
        const kept = this.history.slice(-(limit - 1));
        // A positional cut can land between an assistant tool_calls message and its
        // paired tool-response message(s); an orphaned leading 'tool' message makes
        // the next completion request invalid ("role 'tool' must follow tool_calls").
        while (kept.length && kept[0].role === 'tool') kept.shift();
        this.history = [this.history[0], ...kept];
    }

    private systemPrompt(): string {
        return 'You are the forge-coordinator on a shared Forge Relay board. Coordinate only through the provided board tools. Never edit files or run terminal commands. Check STOP/PAUSE before actions, avoid reacting to your own posts, dispatch workers for implementation, and keep posts concise.';
    }
}
