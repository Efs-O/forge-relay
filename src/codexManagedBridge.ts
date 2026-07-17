import { EventTail } from './eventTail';
import { RuntimeStatus } from './runtimeBridge';
import { BoardEvent, Command } from './types';

const { shouldTrigger } = require('../scripts/bridgeEventFilter') as {
    shouldTrigger: (event: BoardEvent, agent: string, mode?: string) => boolean;
};

const AGENT = 'codex';

export interface CodexAppServerAdapter {
    start(): Promise<void>;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): Promise<void> | void;
    onNotification(listener: (notification: { method: string; params?: unknown }) => void): (() => void) | void;
    onServerRequest?(listener: (method: string, params: Record<string, unknown>) => Promise<unknown>): (() => void) | void;
    onClose?(listener: (error?: Error) => void): (() => void) | void;
    onExit?(listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void): (() => void) | void;
    close(): Promise<void> | void;
    childPid?: number;
    pid?: number;
}

export type CodexLeaseAcquireResult = 'acquired' | 'recovered-stale' | 'held-by-live-other' | 'unknown';

export interface CodexManagedLease {
    tryAcquire(): CodexLeaseAcquireResult | Promise<CodexLeaseAcquireResult>;
    markBridgeStarted?(childPid: number): void;
    markState?(status: 'starting' | 'waiting' | 'linked' | 'restarting' | 'stopped'): void;
    renewHealthy?(status: 'starting' | 'waiting' | 'linked' | 'restarting' | 'stopped'): void;
    releaseIfOwned(): void;
}

export interface CodexManagedBoard {
    getBlockingCommands(agent: string): Command[];
    getAutonomyMode(): 'draft' | 'clanker';
    ack(agent: string, commandId: string, note: string): void;
    post(agent: string, message: string): void;
}

export interface CodexManagedBridgeOptions {
    board: CodexManagedBoard;
    eventsPath: string;
    repoRoot: string;
    clientFactory: (handlers: {
        handleServerRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    }) => CodexAppServerAdapter;
    lease: CodexManagedLease;
    model?: string;
    developerInstructions?: string;
    eventMode?: 'all' | 'mentions';
    eventPollMs?: number;
    burstWindowMs?: number;
    blockingPollMs?: number;
    turnTimeoutMs?: number;
    interruptTimeoutMs?: number;
    restartBaseMs?: number;
    restartMaxMs?: number;
    maxRestarts?: number;
    maxFallbackPostChars?: number;
    onStatus?: (status: RuntimeStatus, detail: string, threadId?: string) => void;
    onLog?: (line: string) => void;
}

interface ActiveTurn {
    generation: number;
    events: BoardEvent[];
    threadId: string;
    turnId?: string;
    finalText: string;
    usedRelayTool: boolean;
    settled: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    completion: Promise<void>;
    deferredNotifications: Array<{ method: string; params: Record<string, unknown> }>;
}

export type CodexFailureKind = 'fatal-auth' | 'fatal-protocol' | 'fatal-contention' | 'transient';

interface ManagedCodexServerRequestContext {
    threadId?: string;
    turnId?: string;
}

export interface ManagedCodexServerRequestResolution {
    response: unknown;
    audit: 'accepted-forgerelay-mcp' | 'declined-elicitation' | 'declined-approval';
}

function isExactEmptyObjectSchema(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const schema = value as Record<string, unknown>;
    if (schema.type !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(schema, 'properties')
        || !schema.properties
        || typeof schema.properties !== 'object'
        || Array.isArray(schema.properties)) return false;
    const properties = schema.properties as Record<string, unknown>;
    if (Object.keys(properties).length !== 0) return false;
    const required = schema.required;
    if (required !== undefined && (!Array.isArray(required) || required.length !== 0)) return false;
    return Object.keys(schema).every(key => key === 'type' || key === 'properties' || key === 'required');
}

/**
 * Resolve app-server requests without granting general Codex permissions.
 * The sole accepted request is Codex's current-turn approval form for a tool
 * on the configured Forge Relay MCP server. Everything else stays denied.
 */
export function resolveManagedCodexServerRequest(
    method: string,
    params: Record<string, unknown>,
    context: ManagedCodexServerRequestContext,
): ManagedCodexServerRequestResolution {
    if (method === 'mcpServer/elicitation/request') {
        const meta = record(params._meta);
        const valid = params.serverName === 'forgerelay'
            && typeof context.threadId === 'string'
            && params.threadId === context.threadId
            && typeof context.turnId === 'string'
            && params.turnId === context.turnId
            && params.mode === 'form'
            && meta.codex_approval_kind === 'mcp_tool_call'
            && isExactEmptyObjectSchema(params.requestedSchema);
        return valid
            ? {
                response: { action: 'accept', content: {}, _meta: null },
                audit: 'accepted-forgerelay-mcp',
            }
            : {
                response: { action: 'decline', content: null, _meta: null },
                audit: 'declined-elicitation',
            };
    }
    if (/approval/i.test(method)) {
        return {
            response: { decision: 'decline', approved: false },
            audit: 'declined-approval',
        };
    }
    throw new Error(`Unsupported app-server request: ${method}`);
}

/** Keep authentication and protocol failures out of restart loops. */
export function classifyCodexManagedFailure(error: unknown): CodexFailureKind {
    const message = error instanceof Error ? error.message : String(error);
    if (/refresh[_ -]?token[_ -]?reused|token[_ -]?invalidated|invalid[_ -]?grant|unauthenticated|not authenticated|not logged in|login required|401\b/i.test(message)) {
        return 'fatal-auth';
    }
    if (/managed profile (?:ownership )?lease|managed profile is (?:already )?owned|held by (?:another|live)|contention/i.test(message)) {
        return 'fatal-contention';
    }
    if (/unsupported protocol|malformed protocol|method not found|invalid initialize|mcp .*failed to (?:start|initialize)|required mcp/i.test(message)) {
        return 'fatal-protocol';
    }
    return 'transient';
}

export function buildCodexManagedTurnInput(events: BoardEvent[]): Array<{ type: 'text'; text: string }> {
    return [{
        type: 'text',
        text: [
            '[FORGE_RELAY_TURN: board-event]',
            `A burst of ${events.length} ordered Forge Relay board event(s) may require coordination work.`,
            'Use the Forge Relay MCP tools for board actions. Continue the underlying task; do not merely summarize the event.',
            'Check blocking commands before actions and never act after STOP or PAUSE.',
            '',
            ...events.map((event, index) => `Event ${index + 1}: ${JSON.stringify(event)}`),
        ].join('\n'),
    }];
}

function idFrom(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function threadIdFrom(params: Record<string, unknown>): string | undefined {
    return idFrom(params.threadId) ?? idFrom(record(params.thread).id) ?? idFrom(record(params.turn).threadId);
}

function turnIdFrom(params: Record<string, unknown>): string | undefined {
    return idFrom(params.turnId) ?? idFrom(record(params.turn).id);
}

function itemFrom(params: Record<string, unknown>): Record<string, unknown> {
    return record(params.item);
}

function isRelayToolItem(item: Record<string, unknown>): boolean {
    const type = String(item.type ?? '').toLowerCase();
    if (!type.includes('mcp') || !type.includes('tool')) return false;
    const server = String(item.server ?? item.serverName ?? '').toLowerCase();
    const tool = String(item.tool ?? item.toolName ?? item.name ?? '').toLowerCase();
    return server === 'forgerelay' || tool.startsWith('mcp__forgerelay__') || tool.includes('forgerelay');
}

function finalTextFrom(item: Record<string, unknown>): string {
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string') return item.content;
    if (Array.isArray(item.content)) {
        return item.content.map(part => typeof part === 'string' ? part : String(record(part).text ?? '')).join('');
    }
    return '';
}

function boundedMessage(message: string, max: number): string {
    return message.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Product-level managed Codex coordinator. Transport and isolated-profile
 * ownership are adapters so those policies do not leak into the board/turn
 * state machine. External Codex processes are intentionally irrelevant here.
 */
export class CodexManagedBridge {
    readonly agent = AGENT;
    private readonly tail: EventTail;
    private client: CodexAppServerAdapter | null = null;
    private threadId: string | undefined;
    private running = false;
    private stopping = false;
    private halted = false;
    private leaseOwned = false;
    private generation = 0;
    private restartAttempts = 0;
    private eventTimer: NodeJS.Timeout | null = null;
    private stopTimer: NodeJS.Timeout | null = null;
    private burstTimer: NodeJS.Timeout | null = null;
    private restartTimer: NodeJS.Timeout | null = null;
    private pendingEvents: BoardEvent[] = [];
    private active: ActiveTurn | null = null;
    private draining = false;
    private currentStatus: RuntimeStatus = 'inactive';
    private detail = 'Not connected.';
    private readonly acknowledgedCommands = new Set<string>();
    private subscriptions: Array<() => void> = [];

    constructor(private readonly opts: CodexManagedBridgeOptions) {
        this.tail = new EventTail(opts.eventsPath);
    }

    status(): RuntimeStatus { return this.currentStatus; }
    detailText(): string { return this.detail; }
    activeThreadId(): string | undefined { return this.threadId; }
    isHalted(): boolean { return this.halted; }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.stopping = false;
        this.halted = false;
        this.restartAttempts = 0;
        this.tail.reset();
        this.setStatus('waiting', 'Acquiring isolated managed profile ownership...');
        try {
            const acquired = await this.opts.lease.tryAcquire();
            if (acquired === 'held-by-live-other') {
                throw new Error('Managed profile ownership lease is held by another live Forge Relay runtime.');
            }
            if (acquired === 'unknown') {
                throw new Error('Managed profile ownership lease could not be read or acquired safely.');
            }
            this.leaseOwned = true;
            await this.openSession();
            this.startTimers();
        } catch (error) {
            const kind = classifyCodexManagedFailure(error);
            await this.unwind(true);
            this.running = false;
            this.setStatus(kind === 'transient' ? 'error' : 'stopped', this.actionableError(error, kind));
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        this.running = false;
        this.clearTimers();
        this.pendingEvents = [];
        this.rejectActive(new Error('Managed Codex bridge stopped.'));
        await this.unwind(true);
        this.stopping = false;
        this.halted = false;
        this.setStatus('inactive', 'Managed Codex disconnected.');
    }

    /** Deterministic hook used by tests and by callers that want immediate scans. */
    async pollEventsNow(): Promise<void> {
        if (!this.running || this.halted) return;
        for (const event of this.tail.readNew()) {
            if (shouldTrigger(event, AGENT, this.opts.eventMode === 'all' ? 'all' : 'mentions')) {
                this.pendingEvents.push(event);
            }
        }
        if (this.pendingEvents.length && !this.active && !this.draining) this.armBurst();
    }

    /** Independent STOP/PAUSE lane; never waits behind an active turn. */
    async pollBlockingNow(): Promise<void> {
        if (!this.running) return;
        const blocking = this.opts.board.getBlockingCommands(AGENT);
        if (!blocking.length) {
            if (this.halted) {
                this.halted = false;
                this.setStatus('linked', 'Managed Codex resumed after blocking command resolution.');
            }
            return;
        }
        this.halted = true;
        this.pendingEvents = [];
        if (this.burstTimer) clearTimeout(this.burstTimer);
        this.burstTimer = null;
        for (const command of blocking) {
            if (this.acknowledgedCommands.has(command.id)) continue;
            try {
                this.opts.board.ack(AGENT, command.id, 'Managed Codex interrupted in-flight work and halted.');
                this.acknowledgedCommands.add(command.id);
            } catch { /* command may have raced to resolved */ }
        }
        const active = this.active;
        if (active?.turnId && this.client) {
            this.setStatus('waiting', 'STOP/PAUSE received; interrupting managed Codex turn.', this.threadId);
            try {
                await this.withTimeout(
                    this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }),
                    this.opts.interruptTimeoutMs ?? 5_000,
                    'turn interrupt request',
                );
                await this.withTimeout(active.completion, this.opts.interruptTimeoutMs ?? 5_000, 'turn interrupt completion');
            } catch (error) {
                this.opts.onLog?.(`Managed Codex interrupt recovery: ${error instanceof Error ? error.message : String(error)}`);
                this.rejectActive(error instanceof Error ? error : new Error(String(error)));
            }
        }
        this.setStatus('waiting', 'Managed Codex halted by STOP/PAUSE until the command is resolved.', this.threadId);
    }

    private async openSession(): Promise<void> {
        const generation = ++this.generation;
        const client = this.opts.clientFactory({
            handleServerRequest: (method, params) => this.onServerRequest(method, params),
        });
        this.client = client;
        this.bindClient(client, generation);
        this.opts.lease.markState?.('starting');
        await client.start();
        const childPid = client.pid ?? client.childPid;
        if (childPid !== undefined) this.opts.lease.markBridgeStarted?.(childPid);
        await client.request('initialize', {
            clientInfo: { name: 'forge-relay-managed-codex', version: '1' },
            capabilities: { experimentalApi: false },
        });
        await client.notify('initialized', {});
        const accountResult = await client.request<Record<string, unknown>>('account/read', { refreshToken: false });
        const account = record(accountResult.account ?? record(accountResult.result).account);
        if (!Object.keys(account).length) {
            throw new Error('Unauthenticated Codex account; ChatGPT subscription login required before managed mode can start.');
        }
        if (account.type !== 'chatgpt') {
            throw new Error('Managed Codex profile is not authenticated with ChatGPT subscription access.');
        }
        const thread = await client.request<Record<string, unknown>>('thread/start', {
            cwd: this.opts.repoRoot,
            approvalPolicy: 'never',
            sandbox: this.opts.board.getAutonomyMode() === 'clanker' ? 'workspace-write' : 'read-only',
            ...(this.opts.model ? { model: this.opts.model } : {}),
            developerInstructions: this.opts.developerInstructions ?? this.defaultInstructions(),
            ephemeral: true,
        });
        this.threadId = idFrom(record(thread.thread).id) ?? idFrom(thread.threadId);
        if (!this.threadId) throw new Error('Malformed protocol response: thread/start returned no thread id.');
        this.restartAttempts = 0;
        this.opts.lease.renewHealthy?.('linked');
        this.setStatus('linked', 'Managed Codex linked and waiting for board events.', this.threadId);
    }

    private bindClient(client: CodexAppServerAdapter, generation: number): void {
        this.clearSubscriptions();
        const notificationOff = client.onNotification(notification => {
            this.onNotification(generation, notification.method, record(notification.params));
        });
        if (notificationOff) this.subscriptions.push(notificationOff);
        const requestOff = client.onServerRequest?.((method, params) => this.onServerRequest(method, params));
        if (requestOff) this.subscriptions.push(requestOff);
        const closeOff = client.onClose?.(error => void this.onUnexpectedClose(generation, error));
        if (closeOff) this.subscriptions.push(closeOff);
        const exitOff = client.onExit?.(exit => void this.onUnexpectedClose(
            generation,
            new Error(`Codex app-server exited (code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}).`),
        ));
        if (exitOff) this.subscriptions.push(exitOff);
    }

    private async onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
        const resolution = resolveManagedCodexServerRequest(method, params, {
            threadId: this.threadId,
            turnId: this.active?.turnId,
        });
        if (resolution.audit === 'accepted-forgerelay-mcp') {
            this.opts.onLog?.('Managed Codex accepted active Forge Relay MCP tool approval.');
        } else {
            this.opts.onLog?.(`Managed Codex safely denied server request: ${method}`);
        }
        return resolution.response;
    }

    private onNotification(generation: number, method: string, params: Record<string, unknown>): void {
        if (generation !== this.generation) return;
        const active = this.active;
        if (!active) return;
        const threadId = threadIdFrom(params);
        const turnId = turnIdFrom(params);
        if (threadId && threadId !== active.threadId) return;
        // Notifications may race the turn/start response. Buffer them until the
        // returned turn id is authoritative, then replay through this same gate.
        if (!active.turnId) {
            if (threadId === active.threadId && turnId) active.deferredNotifications.push({ method, params });
            return;
        }
        if (threadId !== active.threadId || turnId !== active.turnId) return;
        const item = itemFrom(params);
        if (isRelayToolItem(item)) active.usedRelayTool = true;
        if (method === 'item/agentMessage/delta') {
            active.finalText += typeof params.delta === 'string' ? params.delta : '';
            return;
        }
        if (method === 'item/completed') {
            if (String(item.type ?? '').toLowerCase().includes('agentmessage')) {
                const text = finalTextFrom(item);
                if (text) active.finalText = text;
            }
            return;
        }
        if (method === 'turn/completed') {
            this.resolveActive(active);
            return;
        }
        if (method === 'turn/failed') {
            this.rejectActive(new Error(`Codex turn failed: ${JSON.stringify(params).slice(0, 1_000)}`), active);
        }
    }

    private armBurst(): void {
        if (this.burstTimer || this.halted || !this.running) return;
        this.burstTimer = setTimeout(() => {
            this.burstTimer = null;
            void this.drain();
        }, this.opts.burstWindowMs ?? 75);
    }

    private async drain(): Promise<void> {
        if (this.draining || this.active || this.halted || !this.running || !this.pendingEvents.length) return;
        this.draining = true;
        const events = this.pendingEvents.splice(0);
        try {
            await this.runTurn(events);
        } catch (error) {
            if (!this.halted && this.running) await this.handleRuntimeFailure(error, events);
        } finally {
            this.draining = false;
            if (this.pendingEvents.length && !this.halted && this.running) this.armBurst();
            else if (this.running && !this.halted) this.setStatus('linked', 'Managed Codex linked and waiting for board events.', this.threadId);
        }
    }

    private async runTurn(events: BoardEvent[]): Promise<void> {
        const client = this.client;
        const threadId = this.threadId;
        if (!client || !threadId) throw new Error('Managed Codex session is not connected.');
        if (this.opts.board.getBlockingCommands(AGENT).length) {
            await this.pollBlockingNow();
            return;
        }
        const active = this.makeActive(events, threadId);
        this.active = active;
        this.setStatus('linked', `Managed Codex handling ${events.length} board event(s).`, threadId);
        try {
            const response = await client.request<Record<string, unknown>>('turn/start', {
                threadId,
                input: buildCodexManagedTurnInput(events),
                approvalPolicy: 'never',
                sandboxPolicy: { type: this.opts.board.getAutonomyMode() === 'clanker' ? 'workspaceWrite' : 'readOnly' },
            });
            active.turnId = idFrom(record(response.turn).id) ?? idFrom(response.turnId);
            if (!active.turnId) throw new Error('Malformed protocol response: turn/start returned no turn id.');
            for (const deferred of active.deferredNotifications.splice(0)) {
                this.onNotification(active.generation, deferred.method, deferred.params);
            }
            await this.withTimeout(active.completion, this.opts.turnTimeoutMs ?? 900_000, 'managed Codex turn');
            if (!active.usedRelayTool && active.finalText.trim()) {
                const fallback = boundedMessage(active.finalText, this.opts.maxFallbackPostChars ?? 1_000);
                if (fallback) this.opts.board.post(AGENT, fallback);
            }
        } finally {
            if (this.active === active) this.active = null;
        }
    }

    private makeActive(events: BoardEvent[], threadId: string): ActiveTurn {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const completion = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        // The promise is awaited immediately by runTurn; this also prevents a
        // STOP that races turn/start from creating an unhandled rejection.
        void completion.catch(() => undefined);
        return {
            generation: this.generation, events, threadId, finalText: '', usedRelayTool: false,
            settled: false, resolve, reject, completion, deferredNotifications: [],
        };
    }

    private resolveActive(active = this.active): void {
        if (!active || active.settled) return;
        active.settled = true;
        active.resolve();
    }

    private rejectActive(error: Error, active = this.active): void {
        if (!active || active.settled) return;
        active.settled = true;
        active.reject(error);
        if (this.active === active) this.active = null;
    }

    private async handleRuntimeFailure(error: unknown, events: BoardEvent[]): Promise<void> {
        const kind = classifyCodexManagedFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        this.opts.onLog?.(`Managed Codex ${kind}: ${message}`);
        if (kind !== 'transient') {
            this.running = false;
            this.clearTimers();
            await this.unwind(true);
            this.setStatus('stopped', this.actionableError(error, kind));
            return;
        }
        // Retain the failed burst ahead of later work so restart never reorders events.
        this.pendingEvents = [...events, ...this.pendingEvents];
        await this.scheduleRecovery(error);
    }

    private async onUnexpectedClose(generation: number, error?: Error): Promise<void> {
        if (generation !== this.generation || !this.running || this.stopping) return;
        this.rejectActive(error ?? new Error('Codex app-server transport closed unexpectedly.'));
        await this.scheduleRecovery(error ?? new Error('Codex app-server transport closed unexpectedly.'));
    }

    private async scheduleRecovery(error: unknown): Promise<void> {
        if (!this.running || this.stopping || this.restartTimer) return;
        const max = this.opts.maxRestarts ?? 3;
        if (this.restartAttempts >= max) {
            this.running = false;
            this.clearTimers();
            await this.unwind(true);
            this.setStatus('stopped', `Managed Codex stopped after ${max} transient restart attempts: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const delay = Math.min((this.opts.restartBaseMs ?? 500) * 2 ** this.restartAttempts, this.opts.restartMaxMs ?? 5_000);
        this.restartAttempts++;
        this.setStatus('error', `Managed Codex connection failed; restarting in ${delay}ms (${this.restartAttempts}/${max}).`, this.threadId);
        await this.closeClient();
        this.threadId = undefined;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.recover();
        }, delay);
    }

    private async recover(): Promise<void> {
        if (!this.running || this.stopping) return;
        try {
            await this.openSession();
            if (this.pendingEvents.length && !this.halted) this.armBurst();
        } catch (error) {
            const kind = classifyCodexManagedFailure(error);
            if (kind === 'transient') await this.scheduleRecovery(error);
            else {
                this.running = false;
                this.clearTimers();
                await this.unwind(true);
                this.setStatus('stopped', this.actionableError(error, kind));
            }
        }
    }

    private startTimers(): void {
        this.eventTimer = setInterval(() => void this.pollEventsNow(), this.opts.eventPollMs ?? 100);
        this.stopTimer = setInterval(() => void this.pollBlockingNow(), this.opts.blockingPollMs ?? 250);
    }

    private clearTimers(): void {
        if (this.eventTimer) clearInterval(this.eventTimer);
        if (this.stopTimer) clearInterval(this.stopTimer);
        if (this.burstTimer) clearTimeout(this.burstTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.eventTimer = this.stopTimer = this.burstTimer = this.restartTimer = null;
    }

    private clearSubscriptions(): void {
        for (const unsubscribe of this.subscriptions.splice(0)) {
            try { unsubscribe(); } catch { /* best effort */ }
        }
    }

    private async closeClient(): Promise<void> {
        const client = this.client;
        this.client = null;
        this.clearSubscriptions();
        if (client) {
            try { await client.close(); } catch (error) { this.opts.onLog?.(`Managed Codex close: ${String(error)}`); }
        }
    }

    private async unwind(releaseLease: boolean): Promise<void> {
        await this.closeClient();
        this.threadId = undefined;
        if (releaseLease && this.leaseOwned) {
            this.opts.lease.releaseIfOwned();
            this.leaseOwned = false;
        } else if (!this.running && this.leaseOwned) {
            this.opts.lease.releaseIfOwned();
            this.leaseOwned = false;
        }
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
    }

    private actionableError(error: unknown, kind: CodexFailureKind): string {
        const message = error instanceof Error ? error.message : String(error);
        if (kind === 'fatal-auth') {
            return `Managed Codex subscription authentication failed. Run "Forge Relay: Sign In Isolated Codex with ChatGPT", then reconnect. ${message}`;
        }
        if (kind === 'fatal-contention') {
            return `This isolated managed profile is already owned by another Forge Relay runtime. Stop that Relay runtime or use existing-session MCP mode. ${message}`;
        }
        if (kind === 'fatal-protocol') return `Managed Codex protocol setup failed; use MCP-only mode until Codex is compatible. ${message}`;
        return `Managed Codex startup failed: ${message}`;
    }

    private setStatus(status: RuntimeStatus, detail: string, threadId = this.threadId): void {
        this.currentStatus = status;
        this.detail = detail;
        this.opts.onStatus?.(status, detail, threadId);
    }

    private defaultInstructions(): string {
        return 'You are the codex orchestrator on a Forge Relay board. Coordinate through Forge Relay MCP tools, check STOP/PAUSE before actions, never react to your own posts, keep one persistent coordination thread, continue assigned work through completion, and keep board posts concise.';
    }
}
