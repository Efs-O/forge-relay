import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import { RuntimeLease, RuntimeLeaseStatus } from './runtimeLease';

/**
 * Runtime status for an agent's wakeup bridge, surfaced as the per-agent status
 * dot in the panel.
 *
 *  - inactive    not connected / not selected for this session
 *  - waiting     child spawned, runtime still coming up
 *  - linked      runtime is up and tailing the board
 *  - follower    another window owns the managed bridge for this repo
 *  - error       crashed; the supervisor is backing off and will restart
 *  - unsupported the underlying CLI is not installed
 *  - stopped     gave up after exhausting restarts
 */
export type RuntimeStatus = 'inactive' | 'waiting' | 'linked' | 'follower' | 'error' | 'unsupported' | 'stopped';

export interface AgentRuntimeBridge {
    readonly agent: string;
    start(): void;
    stop(): void;
    status(): RuntimeStatus;
    detailText(): string;
}

export interface RuntimeBridgeOptions {
    agent: string;
    scriptPath: string;
    repoRoot: string;
    eventsPath: string;
    extraArgs?: string[];
    linkedPattern?: RegExp;
    nodePath?: string;
    onStatus?: (status: RuntimeStatus, detail: string) => void;
    onLog?: (line: string) => void;
}

const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 15_000;
const MAX_RESTARTS = 6;
const LEASE_HEARTBEAT_MS = 5_000;
const FOLLOWER_RETRY_MS = 10_000;

export class ScriptRuntimeBridge implements AgentRuntimeBridge {
    readonly agent: string;

    private child: ChildProcess | null = null;
    private _status: RuntimeStatus = 'inactive';
    private detail = 'Not connected.';
    private wantRunning = false;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private markedUnsupported = false;
    private readonly lease: RuntimeLease;
    private ownsLease = false;
    private leaseHeartbeatTimer: NodeJS.Timeout | null = null;
    private leaseRetryTimer: NodeJS.Timeout | null = null;
    private stopping = false;

    constructor(private readonly opts: RuntimeBridgeOptions) {
        this.agent = opts.agent;
        this.lease = new RuntimeLease(path.dirname(opts.eventsPath), opts.agent, opts.repoRoot, process.pid);
    }

    status(): RuntimeStatus {
        return this._status;
    }

    detailText(): string {
        return this.detail;
    }

    start(): void {
        this.wantRunning = true;
        this.stopping = false;
        this.markedUnsupported = false;
        if (this.child || this.leaseRetryTimer) {
            return;
        }
        this.restartAttempts = 0;
        this.tryBecomeOwner();
    }

    stop(): void {
        this.wantRunning = false;
        this.stopping = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.clearFollowerRetry();
        this.stopLeaseHeartbeat();
        if (this.child) {
            this.killChild(this.child);
            return;
        }
        this.releaseLease();
        this.stopping = false;
        this.setStatus('inactive', 'Disconnected.');
    }

    private killChild(child: ChildProcess): void {
        if (process.platform === 'win32' && child.pid) {
            try {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
                return;
            } catch {
                // Fall through to child.kill().
            }
        }
        try {
            child.kill();
        } catch {
            // Already gone.
        }
    }

    private tryBecomeOwner(): void {
        if (!this.wantRunning || this.child) {
            return;
        }
        const result = this.lease.tryAcquire();
        if (result === 'held-by-live-other') {
            this.ownsLease = false;
            this.setStatus('follower', `${this.agent} bridge owned by another window.`);
            this.scheduleFollowerRetry();
            return;
        }
        this.ownsLease = true;
        this.clearFollowerRetry();
        this.spawnChild();
    }

    private spawnChild(): void {
        const node = this.opts.nodePath || 'node';
        if (this.ownsLease) {
            this.lease.markState('starting');
            this.startLeaseHeartbeat();
        }
        this.setStatus('waiting', `Starting ${this.agent} bridge...`);

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
        if (this.ownsLease && child.pid) {
            this.lease.markBridgeStarted(child.pid);
        }
        child.stdout?.on('data', (b: Buffer) => this.handleOutput(b.toString()));
        child.stderr?.on('data', (b: Buffer) => this.handleOutput(b.toString()));

        child.on('error', (err) => {
            this.markedUnsupported = true;
            this.setStatus('unsupported', `Could not run node: ${err.message}`);
        });

        child.on('exit', (code, signal) => {
            if (this.child !== child) {
                return;
            }
            this.child = null;
            if (!this.wantRunning || this.stopping) {
                this.stopLeaseHeartbeat();
                this.releaseLease();
                this.stopping = false;
                this.setStatus('inactive', 'Disconnected.');
                return;
            }
            if (this.markedUnsupported) {
                this.stopLeaseHeartbeat();
                this.releaseLease();
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
                    this.setStatus('linked', `${this.agent} bridge linked - reacting to board events.`);
                    this.renewLeaseHeartbeat('linked');
                } else if (token === 'waiting') {
                    this.setStatus('waiting', `${this.agent} bridge connecting...`);
                    this.renewLeaseHeartbeat('waiting');
                } else if (token === 'unsupported') {
                    this.markedUnsupported = true;
                    this.setStatus('unsupported', `${this.agent} CLI is not installed or not on PATH.`);
                }
                continue;
            }

            if (this.opts.linkedPattern && this.opts.linkedPattern.test(line)) {
                this.restartAttempts = 0;
                this.setStatus('linked', `${this.agent} bridge linked - reacting to board events.`);
                this.renewLeaseHeartbeat('linked');
            }
        }
    }

    private scheduleRestart(): void {
        if (!this.wantRunning || this.restartTimer || this.markedUnsupported) {
            return;
        }
        if (this.restartAttempts >= MAX_RESTARTS) {
            this.stopLeaseHeartbeat();
            this.releaseLease();
            this.setStatus('stopped', `${this.agent} bridge stopped after ${MAX_RESTARTS} failed restarts.`);
            return;
        }
        this.restartAttempts += 1;
        const delay = Math.min(RESTART_BASE_MS * 2 ** (this.restartAttempts - 1), RESTART_MAX_MS);
        this.setStatus('error', `${this.detail} Restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts}/${MAX_RESTARTS}).`);
        this.renewLeaseHeartbeat('restarting');
        this.startLeaseHeartbeat();
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.wantRunning && !this.child) {
                if (this.ownsLease) {
                    this.spawnChild();
                } else {
                    this.tryBecomeOwner();
                }
            }
        }, delay);
    }

    private scheduleFollowerRetry(): void {
        if (!this.wantRunning || this.leaseRetryTimer) {
            return;
        }
        this.leaseRetryTimer = setTimeout(() => {
            this.leaseRetryTimer = null;
            if (this.wantRunning && !this.child) {
                this.tryBecomeOwner();
            }
        }, FOLLOWER_RETRY_MS);
    }

    private clearFollowerRetry(): void {
        if (this.leaseRetryTimer) {
            clearTimeout(this.leaseRetryTimer);
            this.leaseRetryTimer = null;
        }
    }

    private startLeaseHeartbeat(): void {
        if (!this.ownsLease || this.leaseHeartbeatTimer) {
            return;
        }
        this.leaseHeartbeatTimer = setInterval(() => {
            const status = this.currentLeaseStatus();
            if (!status) {
                this.stopLeaseHeartbeat();
                return;
            }
            this.lease.renewHealthy(status);
        }, LEASE_HEARTBEAT_MS);
    }

    private stopLeaseHeartbeat(): void {
        if (this.leaseHeartbeatTimer) {
            clearInterval(this.leaseHeartbeatTimer);
            this.leaseHeartbeatTimer = null;
        }
    }

    private renewLeaseHeartbeat(status: RuntimeLeaseStatus): void {
        if (!this.ownsLease) {
            return;
        }
        this.lease.renewHealthy(status);
        this.startLeaseHeartbeat();
    }

    private currentLeaseStatus(): RuntimeLeaseStatus | null {
        if (!this.ownsLease || !this.wantRunning) {
            return null;
        }
        if (this.child) {
            if (this._status === 'linked') {
                return 'linked';
            }
            if (this._status === 'waiting') {
                return 'waiting';
            }
            return 'starting';
        }
        if (this.restartTimer) {
            return 'restarting';
        }
        return null;
    }

    private releaseLease(): void {
        if (!this.ownsLease) {
            return;
        }
        this.lease.releaseIfOwned();
        this.ownsLease = false;
    }

    private setStatus(status: RuntimeStatus, detail: string): void {
        this._status = status;
        this.detail = detail;
        this.opts.onStatus?.(status, detail);
    }
}
