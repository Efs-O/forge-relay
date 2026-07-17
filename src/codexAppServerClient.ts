import { ChildProcess, SpawnOptions, spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';

export type CodexConfigValue =
    | string
    | number
    | boolean
    | readonly CodexConfigValue[]
    | { readonly [key: string]: CodexConfigValue };

export interface CodexRpcNotification {
    method: string;
    params?: unknown;
}

export interface CodexServerRequest {
    id: string | number;
    method: string;
    params?: unknown;
}

export interface CodexProcessExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export type SpawnChild = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type KillProcessTree = (child: ChildProcess) => void | Promise<void>;
export type ServerRequestHandler = (request: CodexServerRequest) => unknown | Promise<unknown>;

export interface CodexAppServerClientOptions {
    executable?: string;
    executableArgsPrefix?: readonly string[];
    configOverrides?: Readonly<Record<string, CodexConfigValue>>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Explicit escape hatch for callers that accept shell parsing. Defaults to false on every platform. */
    shell?: boolean;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    maxStderrBytes?: number;
    maxProtocolLineBytes?: number;
    spawnChild?: SpawnChild;
    killProcessTree?: KillProcessTree;
    handleServerRequest?: ServerRequestHandler;
    onStderr?: (text: string) => void;
    onNotification?: (notification: CodexRpcNotification) => void;
    onProtocolError?: (error: Error) => void;
    onExit?: (exit: CodexProcessExit) => void;
}

interface PendingRequest {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tomlKey(key: string): string {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** Encode the TOML subset accepted by `codex -c key=value`. */
export function encodeTomlValue(value: CodexConfigValue): string {
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('Codex config numbers must be finite.');
        }
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(encodeTomlValue).join(',')}]`;
    }
    if (isRecord(value)) {
        return `{${Object.entries(value).map(([key, child]) => `${tomlKey(key)}=${encodeTomlValue(child as CodexConfigValue)}`).join(',')}}`;
    }
    throw new Error('Unsupported Codex configuration value.');
}

/** Build direct argv entries; no shell command string is constructed. */
export function buildCodexAppServerArgs(
    configOverrides: Readonly<Record<string, CodexConfigValue>> = {},
): string[] {
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(configOverrides)) {
        if (!/^[A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_-]+))*$/.test(key)) {
            throw new Error(`Invalid Codex config override key: ${key}`);
        }
        args.push('-c', `${key}=${encodeTomlValue(value)}`);
    }
    return args;
}

export class CodexRpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown,
    ) {
        super(message);
        this.name = 'CodexRpcError';
    }
}

export class CodexRequestTimeoutError extends Error {
    constructor(readonly method: string, readonly timeoutMs: number) {
        super(`Codex app-server request ${method} timed out after ${timeoutMs}ms.`);
        this.name = 'CodexRequestTimeoutError';
    }
}

export class CodexTransportClosedError extends Error {
    constructor(message = 'Codex app-server transport is closed.') {
        super(message);
        this.name = 'CodexTransportClosedError';
    }
}

export function defaultKillProcessTree(child: ChildProcess): void {
    if (!child.pid) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
        } else {
            child.kill('SIGKILL');
        }
    } catch {
        // The process may already have exited.
    }
}

export class CodexAppServerClient {
    private readonly requestTimeoutMs: number;
    private readonly shutdownTimeoutMs: number;
    private readonly maxStderrBytes: number;
    private readonly maxProtocolLineBytes: number;
    private readonly spawnChild: SpawnChild;
    private readonly killTree: KillProcessTree;
    private readonly stdoutDecoder = new StringDecoder('utf8');
    private readonly stderrDecoder = new StringDecoder('utf8');
    private readonly pending = new Map<number, PendingRequest>();
    private readonly notificationListeners = new Set<(notification: CodexRpcNotification) => void>();
    private readonly protocolErrorListeners = new Set<(error: Error) => void>();
    private readonly exitListeners = new Set<(exit: CodexProcessExit) => void>();
    private child: ChildProcess | null = null;
    private state: 'idle' | 'starting' | 'running' | 'closing' | 'closed' = 'idle';
    private nextRequestId = 1;
    private stdoutBuffer = '';
    private discardingOversizedLine = false;
    private stderrTail = Buffer.alloc(0);
    private exitResult: CodexProcessExit | null = null;
    private exitWaiters: Array<(exit: CodexProcessExit) => void> = [];

    constructor(private readonly options: CodexAppServerClientOptions = {}) {
        this.requestTimeoutMs = positive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
        this.shutdownTimeoutMs = positive(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 'shutdownTimeoutMs');
        this.maxStderrBytes = positive(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 'maxStderrBytes');
        this.maxProtocolLineBytes = positive(options.maxProtocolLineBytes, DEFAULT_MAX_PROTOCOL_LINE_BYTES, 'maxProtocolLineBytes');
        this.spawnChild = options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
        this.killTree = options.killProcessTree ?? defaultKillProcessTree;
        if (options.onNotification) { this.notificationListeners.add(options.onNotification); }
        if (options.onProtocolError) { this.protocolErrorListeners.add(options.onProtocolError); }
        if (options.onExit) { this.exitListeners.add(options.onExit); }
    }

    get pid(): number | undefined {
        return this.child?.pid;
    }

    get running(): boolean {
        return this.state === 'running';
    }

    getStderrTail(): string {
        return this.stderrTail.toString('utf8');
    }

    onNotification(listener: (notification: CodexRpcNotification) => void): () => void {
        this.notificationListeners.add(listener);
        return () => this.notificationListeners.delete(listener);
    }

    onProtocolError(listener: (error: Error) => void): () => void {
        this.protocolErrorListeners.add(listener);
        return () => this.protocolErrorListeners.delete(listener);
    }

    onExit(listener: (exit: CodexProcessExit) => void): () => void {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }

    async start(): Promise<void> {
        if (this.state !== 'idle') {
            throw new Error(`Cannot start Codex app-server client while ${this.state}.`);
        }
        this.state = 'starting';
        const executable = this.options.executable?.trim() || 'codex';
        const args = [
            ...(this.options.executableArgsPrefix ?? []),
            ...buildCodexAppServerArgs(this.options.configOverrides),
        ];
        let child: ChildProcess;
        try {
            child = this.spawnChild(executable, args, {
                cwd: this.options.cwd,
                env: this.options.env ?? process.env,
                shell: this.options.shell ?? false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            this.state = 'closed';
            throw asError(error);
        }
        this.child = child;
        this.attachChild(child);

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const onSpawn = (): void => {
                if (settled) { return; }
                settled = true;
                cleanup();
                if (this.state === 'starting') { this.state = 'running'; }
                resolve();
            };
            const onError = (error: Error): void => {
                if (settled) { return; }
                settled = true;
                cleanup();
                this.state = 'closed';
                reject(error);
            };
            const cleanup = (): void => {
                child.off('spawn', onSpawn);
                child.off('error', onError);
            };
            child.once('spawn', onSpawn);
            child.once('error', onError);
        });
    }

    request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
        if (this.state !== 'running' || !this.child?.stdin?.writable) {
            return Promise.reject(new CodexTransportClosedError('Codex app-server is not running.'));
        }
        if (!method) {
            return Promise.reject(new Error('Codex app-server request method is required.'));
        }
        const boundedTimeout = positive(timeoutMs, this.requestTimeoutMs, 'timeoutMs');
        const id = this.nextRequestId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(id)) { return; }
                reject(new CodexRequestTimeoutError(method, boundedTimeout));
            }, boundedTimeout);
            this.pending.set(id, {
                method,
                resolve: value => resolve(value as T),
                reject,
                timer,
            });
            try {
                this.writeMessage(params === undefined ? { method, id } : { method, id, params });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(asError(error));
            }
        });
    }

    notify(method: string, params?: unknown): void {
        if (this.state !== 'running') {
            throw new CodexTransportClosedError('Codex app-server is not running.');
        }
        this.writeMessage(params === undefined ? { method } : { method, params });
    }

    async close(): Promise<void> {
        if (this.state === 'closed') { return; }
        if (this.state === 'idle') {
            this.state = 'closed';
            return;
        }
        this.state = 'closing';
        this.rejectAllPending(new CodexTransportClosedError('Codex app-server client is closing.'));
        const child = this.child;
        if (!child || this.exitResult) {
            this.state = 'closed';
            return;
        }
        try { child.stdin?.end(); } catch { /* process already closing */ }
        const exitedGracefully = await this.waitForExit(this.shutdownTimeoutMs);
        if (!exitedGracefully && !this.exitResult) {
            await this.killTree(child);
            const exitedAfterKill = await this.waitForExit(this.shutdownTimeoutMs);
            if (!exitedAfterKill) {
                this.state = 'closed';
                throw new CodexTransportClosedError('Codex app-server did not exit after process-tree termination.');
            }
        }
        this.state = 'closed';
    }

    private attachChild(child: ChildProcess): void {
        child.stdout?.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            this.consumeStdout(this.stdoutDecoder.write(buffer));
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            this.stderrTail = Buffer.concat([this.stderrTail, buffer]);
            if (this.stderrTail.length > this.maxStderrBytes) {
                this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - this.maxStderrBytes);
            }
            try { this.options.onStderr?.(this.stderrDecoder.write(buffer)); } catch { /* observer isolation */ }
        });
        child.stdin?.on('error', error => {
            if (this.state === 'running') {
                this.rejectAllPending(new CodexTransportClosedError(`Codex app-server stdin failed: ${error.message}`));
            }
        });
        child.on('error', error => {
            if (this.state === 'running') {
                this.rejectAllPending(new CodexTransportClosedError(`Codex app-server process failed: ${error.message}`));
            }
        });
        // `close` follows stream drain; using `exit` can reject a request before its final
        // stdout response has been delivered by Node.
        child.once('close', (code, signal) => this.handleExit(child, { code, signal }));
    }

    private handleExit(child: ChildProcess, exit: CodexProcessExit): void {
        if (this.child !== child || this.exitResult) { return; }
        this.consumeStdout(this.stdoutDecoder.end());
        const remainder = this.stdoutBuffer.trim();
        if (remainder) {
            this.reportProtocolError(new Error('Codex app-server exited with an incomplete JSONL record.'));
        }
        this.stdoutBuffer = '';
        try { this.options.onStderr?.(this.stderrDecoder.end()); } catch { /* observer isolation */ }
        this.exitResult = exit;
        if (this.state !== 'closing') { this.state = 'closed'; }
        this.rejectAllPending(new CodexTransportClosedError(
            `Codex app-server exited (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'}).`,
        ));
        for (const listener of this.exitListeners) {
            try { listener(exit); } catch (error) {
                this.reportProtocolError(new Error(`Codex exit listener failed: ${asError(error).message}`));
            }
        }
        const waiters = this.exitWaiters.splice(0);
        for (const waiter of waiters) { waiter(exit); }
    }

    private consumeStdout(text: string): void {
        if (!text) { return; }
        if (this.discardingOversizedLine) {
            const newline = text.indexOf('\n');
            if (newline === -1) { return; }
            this.discardingOversizedLine = false;
            text = text.slice(newline + 1);
        }
        this.stdoutBuffer += text;
        let newline: number;
        while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
            let line = this.stdoutBuffer.slice(0, newline);
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line.endsWith('\r')) { line = line.slice(0, -1); }
            if (Buffer.byteLength(line, 'utf8') > this.maxProtocolLineBytes) {
                this.reportProtocolError(new Error('Codex app-server emitted an oversized JSONL record.'));
                continue;
            }
            if (line.trim()) { this.handleLine(line); }
        }
        if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxProtocolLineBytes) {
            this.stdoutBuffer = '';
            this.discardingOversizedLine = true;
            this.reportProtocolError(new Error('Codex app-server emitted an oversized JSONL record.'));
        }
    }

    private handleLine(line: string): void {
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            this.reportProtocolError(new Error('Codex app-server emitted malformed JSON.'));
            return;
        }
        if (!isRecord(message)) {
            this.reportProtocolError(new Error('Codex app-server emitted a non-object JSON-RPC message.'));
            return;
        }
        const method = typeof message.method === 'string' ? message.method : undefined;
        const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
        if (method && id !== undefined) {
            void this.handleServerRequest({ id, method, params: message.params });
            return;
        }
        if (method) {
            const notification = { method, params: message.params };
            for (const listener of this.notificationListeners) {
                try { listener(notification); } catch (error) {
                    this.reportProtocolError(new Error(`Codex notification listener failed: ${asError(error).message}`));
                }
            }
            return;
        }
        if (typeof id === 'number') {
            const pending = this.pending.get(id);
            if (!pending) {
                this.reportProtocolError(new Error(`Codex app-server returned unknown request id ${id}.`));
                return;
            }
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (isRecord(message.error)) {
                const code = typeof message.error.code === 'number' ? message.error.code : -32603;
                const detail = typeof message.error.message === 'string' ? message.error.message : 'Codex app-server request failed.';
                pending.reject(new CodexRpcError(code, detail, message.error.data));
            } else if ('result' in message) {
                pending.resolve(message.result);
            } else {
                pending.reject(new CodexRpcError(-32603, 'Codex app-server response had neither result nor error.'));
            }
            return;
        }
        this.reportProtocolError(new Error('Codex app-server emitted an unrecognized JSON-RPC message.'));
    }

    private async handleServerRequest(request: CodexServerRequest): Promise<void> {
        if (!this.options.handleServerRequest) {
            this.safeWrite({
                id: request.id,
                error: { code: -32601, message: `Unsupported server request: ${request.method}` },
            });
            return;
        }
        try {
            const result = await this.options.handleServerRequest(request);
            this.safeWrite({ id: request.id, result: result ?? {} });
        } catch {
            this.safeWrite({
                id: request.id,
                error: { code: -32603, message: 'Server request handler failed.' },
            });
        }
    }

    private safeWrite(message: Record<string, unknown>): void {
        if (this.state !== 'running') { return; }
        try { this.writeMessage(message); } catch { /* process exit path reports failure */ }
    }

    private writeMessage(message: Record<string, unknown>): void {
        const stdin = this.child?.stdin;
        if (!stdin?.writable) {
            throw new CodexTransportClosedError();
        }
        stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
    }

    private rejectAllPending(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private reportProtocolError(error: Error): void {
        for (const listener of this.protocolErrorListeners) {
            try { listener(error); } catch { /* observer isolation */ }
        }
    }

    private async waitForExit(timeoutMs: number): Promise<boolean> {
        if (this.exitResult) { return true; }
        return new Promise<boolean>(resolve => {
            let settled = false;
            const waiter = (): void => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(true);
            };
            this.exitWaiters.push(waiter);
            const timer = setTimeout(() => {
                if (settled) { return; }
                settled = true;
                const index = this.exitWaiters.indexOf(waiter);
                if (index !== -1) { this.exitWaiters.splice(index, 1); }
                resolve(false);
            }, timeoutMs);
        });
    }
}

function positive(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved <= 0) {
        throw new Error(`${name} must be a positive finite number.`);
    }
    return resolved;
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
