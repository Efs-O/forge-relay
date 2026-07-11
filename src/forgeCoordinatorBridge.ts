import * as fs from 'fs';
import { Bridge } from './bridge';
import { RuntimeLease } from './runtimeLease';
import { RuntimeStatus } from './runtimeBridge';
import { SubagentBackends, forgeEnsure, forgeRelease } from './subagent';
import { BOARD_TOOL_SCHEMAS, executeBoardTool } from './boardTools';
import { BoardEvent } from './types';
const { shouldTrigger } = require('../scripts/bridgeEventFilter') as { shouldTrigger: (event: BoardEvent, agent: string, mode?: string) => boolean };

export interface ForgeCoordinatorModel { name: string; profile?: string; profiles?: string[]; servable?: boolean; }
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
    private abort: AbortController | null = null;
    private history: Message[] = [];
    private readonly lease: RuntimeLease;

    constructor(private readonly opts: ForgeCoordinatorOptions) {
        this.lease = new RuntimeLease(opts.boardEndpoint, AGENT, opts.repoRoot, process.pid, opts.extensionVersion);
    }

    static async listModels(controlUrl: string): Promise<ForgeCoordinatorModel[]> {
        const res = await fetch(`${controlUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Forge /models HTTP ${res.status}`);
        const data = await res.json() as { models?: ForgeCoordinatorModel[] };
        return (data.models ?? []).flatMap(model => model.profiles?.length
            ? model.profiles.map(profile => ({ ...model, name: `${model.name}@${profile}`, profile, profiles: undefined }))
            : [model]);
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
            this.requiresHold = catalog.find(entry => entry.name === model)?.servable !== false;
            if (this.requiresHold) {
                await forgeEnsure(this.opts.controlUrl, model);
                await forgeRelease(this.opts.controlUrl, model);
            }
        } catch (err) {
            this.lease.releaseIfOwned();
            throw err;
        }
        this.running = true;
        this.cursor = fs.existsSync(this.opts.eventsPath) ? fs.statSync(this.opts.eventsPath).size : 0;
        this.history = [{ role: 'system', content: this.systemPrompt() }];
        this.opts.onStatus?.('waiting', `Forge coordinator ${model} waiting for board events.`);
        this.poll = setInterval(() => void this.scan(), 500);
        this.stopPoll = setInterval(() => {
            if (this.processing && this.opts.bridge.getBlockingCommands(AGENT).length) this.abort?.abort();
        }, 250);
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
                await forgeEnsure(this.opts.controlUrl, this.model);
                this.held = true;
            }
            this.history.push({ role: 'user', content: `Board event burst:\n${events.map(e => JSON.stringify(e)).join('\n')}` });
            await this.runToolLoop();
            this.trimHistory();
            this.armIdleRelease();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.opts.onLog?.(`Forge coordinator failure: ${message}`);
            const blocking = this.opts.bridge.getBlockingCommands(AGENT);
            if (blocking.length) {
                for (const command of blocking) {
                    try { this.opts.bridge.ack(AGENT, command.id, 'Coordinator stopped in-flight work.'); } catch { /* already acknowledged */ }
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

    private async runToolLoop(): Promise<void> {
        for (let step = 0; step < 12; step++) {
            if (this.opts.bridge.getBlockingCommands(AGENT).length) { this.abort?.abort(); return; }
            const response = await fetch(`${this.opts.controlUrl.replace(/\/$/, '')}/chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: this.abort?.signal,
                body: JSON.stringify({ model: this.model, messages: this.history, tools: BOARD_TOOL_SCHEMAS.map(t => ({ type: 'function', function: t })), tool_choice: 'auto' }),
            });
            if (!response.ok) throw new Error(`Forge /chat HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
            const data = await response.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
            const msg = data.choices?.[0]?.message;
            if (!msg) throw new Error('Forge /chat returned no assistant message');
            this.history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
            if (!msg.tool_calls?.length) return;
            for (const call of msg.tool_calls) {
                if (this.opts.bridge.getBlockingCommands(AGENT).length) { this.abort?.abort(); return; }
                const name = call.function?.name ?? '';
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* handler returns useful error */ }
                args.agent = AGENT;
                const result = await executeBoardTool(this.opts.bridge, this.opts.backends, name, args).catch(err => `ERROR: ${err instanceof Error ? err.message : String(err)}`);
                this.history.push({ role: 'tool', tool_call_id: call.id ?? name, content: result });
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

    private trimHistory(): void {
        const limit = this.opts.historyLimit ?? 40;
        if (this.history.length > limit) this.history = [this.history[0], ...this.history.slice(-(limit - 1))];
    }

    private systemPrompt(): string {
        return 'You are the forge-coordinator on a shared Forge Relay board. Coordinate only through the provided board tools. Never edit files or run terminal commands. Check STOP/PAUSE before actions, avoid reacting to your own posts, dispatch workers for implementation, and keep posts concise.';
    }
}
