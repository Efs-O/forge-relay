import { spawn, spawnSync, ChildProcess } from 'child_process';

/**
 * Runtime status for an agent's wakeup bridge, surfaced as the per-agent status
 * dot in the panel (see AUTO_TRIGGER_AND_SUBAGENTS_PLAN.md Part 2.4):
 *
 *  - inactive    — not connected / not selected for this session
 *  - waiting     — child spawned, runtime still coming up
 *  - linked      — runtime is up and tailing the board (real wakeup path live)
 *  - error       — crashed; the supervisor is backing off and will restart
 *  - unsupported — the underlying CLI (e.g. `codex`) is not installed
 *  - stopped     — gave up after exhausting restarts
 */
export type RuntimeStatus = 'inactive' | 'waiting' | 'linked' | 'error' | 'unsupported' | 'stopped';

export interface AgentRuntimeBridge {
    readonly agent: string;
    start(): void;
    stop(): void;
    status(): RuntimeStatus;
    detailText(): string;
}

export interface RuntimeBridgeOptions {
    agent: string;
    /** Absolute path to the bridge script (codex-auto-bridge.js / claude-auto-bridge.js). */
    scriptPath: string;
    repoRoot: string;
    eventsPath: string;
    /** Extra CLI args appended after the standard --repo-root/--event-path/--agent. */
    extraArgs?: string[];
    /** Optional fallback regex that also flips status to "linked" if matched in output. */
    linkedPattern?: RegExp;
    /** `node` binary to run the bridge with. Defaults to "node" on PATH. */
    nodePath?: string;
    onStatus?: (status: RuntimeStatus, detail: string) => void;
    onLog?: (line: string) => void;
}

const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 15_000;
const MAX_RESTARTS = 6;

/**
 * Supervises a bridge script (codex-auto-bridge.js or claude-auto-bridge.js) as a
 * managed child process: launches it, parses its `[[AW_STATUS]]` markers to track
 * health, and restarts it with exponential backoff if it dies unexpectedly. This
 * is the "productized" form of the previously-manual `npm run codex:auto`
 * (plan Part 2.2, Phases P2/P4).
 */
export class ScriptRuntimeBridge implements AgentRuntimeBridge {
    readonly agent: string;

    private child: ChildProcess | null = null;
    private _status: RuntimeStatus = 'inactive';
    private detail = 'Not connected.';
    private wantRunning = false;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private markedUnsupported = false;

    constructor(private readonly opts: RuntimeBridgeOptions) {
        this.agent = opts.agent;
    }

    status(): RuntimeStatus {
        return this._status;
    }

    detailText(): string {
        return this.detail;
    }

    start(): void {
        this.wantRunning = true;
        this.markedUnsupported = false;
        this.restartAttempts = 0;
        if (this.child) {
            return;
        }
        this.spawnChild();
    }

    stop(): void {
        this.wantRunning = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const child = this.child;
        this.child = null;
        if (child) {
            this.killChild(child);
        }
        this.setStatus('inactive', 'Disconnected.');
    }

    /**
     * Kill the bridge child AND its descendants. The bridge script spawns the
     * agent CLI (codex/claude) through a shell on Windows (.cmd shims), so a plain
     * kill() only reaps the cmd.exe wrapper and orphans the real app-server —
     * which then holds its port and goes stale. taskkill /T tears down the whole
     * tree so nothing is left behind.
     */
    private killChild(child: ChildProcess): void {
        if (process.platform === 'win32' && child.pid) {
            try {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
                return;
            } catch { /* fall through to kill() */ }
        }
        try { child.kill(); } catch { /* already gone */ }
    }

    private spawnChild(): void {
        const node = this.opts.nodePath || 'node';
        this.setStatus('waiting', 'Starting Codex app-server…');

        let child: ChildProcess;
        try {
            child = spawn(
                node,
                [
                    this.opts.scriptPath,
                    '--repo-root', this.opts.repoRoot,
                    '--event-path', this.opts.eventsPath,
                    '--agent', this.agent,
                    ...(this.opts.extraArgs ?? []),
                ],
                { cwd: this.opts.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
            );
        } catch (err) {
            this.setStatus('error', `Failed to spawn bridge: ${err instanceof Error ? err.message : String(err)}`);
            this.scheduleRestart();
            return;
        }

        this.child = child;
        child.stdout?.on('data', (b: Buffer) => this.handleOutput(b.toString()));
        child.stderr?.on('data', (b: Buffer) => this.handleOutput(b.toString()));

        child.on('error', (err) => {
            // e.g. `node` itself missing from PATH.
            this.markedUnsupported = true;
            this.setStatus('unsupported', `Could not run node: ${err.message}`);
        });

        child.on('exit', (code, signal) => {
            if (this.child !== child) {
                return; // superseded by a newer child or an explicit stop()
            }
            this.child = null;
            if (!this.wantRunning) {
                return;
            }
            if (this.markedUnsupported) {
                this.setStatus('unsupported', this.detail);
                return;
            }
            this.setStatus('error', `Bridge exited (code=${code ?? 'null'} signal=${signal ?? 'null'}).`);
            this.scheduleRestart();
        });
    }

    private handleOutput(text: string): void {
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line) {
                continue;
            }
            this.opts.onLog?.(line);

            if (line.includes('[[AW_STATUS]]')) {
                const token = line.split('[[AW_STATUS]]')[1].trim().split(/\s+/)[0];
                if (token === 'linked') {
                    this.restartAttempts = 0;
                    this.setStatus('linked', `${this.agent} bridge linked — reacting to board events.`);
                } else if (token === 'waiting') {
                    this.setStatus('waiting', `${this.agent} bridge connecting…`);
                } else if (token === 'unsupported') {
                    this.markedUnsupported = true;
                    this.setStatus('unsupported', `${this.agent} CLI is not installed or not on PATH.`);
                }
                continue;
            }

            // Optional per-script heuristic fallback in case the marker is missed.
            if (this.opts.linkedPattern && this.opts.linkedPattern.test(line)) {
                this.restartAttempts = 0;
                this.setStatus('linked', `${this.agent} bridge linked — reacting to board events.`);
            }
        }
    }

    private scheduleRestart(): void {
        if (!this.wantRunning || this.restartTimer || this.markedUnsupported) {
            return;
        }
        if (this.restartAttempts >= MAX_RESTARTS) {
            this.setStatus('stopped', `Codex bridge stopped after ${MAX_RESTARTS} failed restarts.`);
            return;
        }
        this.restartAttempts += 1;
        const delay = Math.min(RESTART_BASE_MS * 2 ** (this.restartAttempts - 1), RESTART_MAX_MS);
        this.setStatus('error', `${this.detail} Restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts}/${MAX_RESTARTS}).`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.wantRunning && !this.child) {
                this.spawnChild();
            }
        }, delay);
    }

    private setStatus(status: RuntimeStatus, detail: string): void {
        this._status = status;
        this.detail = detail;
        this.opts.onStatus?.(status, detail);
    }
}
