import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

export type RuntimeLeaseStatus = 'starting' | 'waiting' | 'linked' | 'restarting' | 'stopped';
export type RuntimeLeaseAcquireResult = 'acquired' | 'recovered-stale' | 'replaced-old-version' | 'held-by-live-other';

export interface RuntimeLeaseRecord {
    pid: number;
    bridgePid?: number;
    startedAt: string;
    heartbeatAt: string;
    extensionVersion: string;
    repoRoot: string;
    boardEndpoint: string;
    agent: string;
    status: RuntimeLeaseStatus;
}

export interface RuntimeLeaseOptions {
    lockDir?: string;
    isPidAlive?: (pid: number | undefined) => boolean;
    killPidTree?: (pid: number) => void;
}

const START_GRACE_MS = 20_000;
const STALE_HEARTBEAT_MS = 20_000;

function defaultLockDir(): string {
    const base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    return path.join(base, 'forge-relay');
}

function endpointKey(endpoint: string): string {
    return endpointIdentity(endpoint).replace(':', '-').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function endpointIdentity(endpoint: string): string {
    try {
        const url = new URL(endpoint);
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        return `${url.hostname.toLowerCase()}:${port}`;
    } catch {
        return endpoint.toLowerCase();
    }
}

function defaultIsPidAlive(pid: number | undefined): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) { return false; }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

function defaultKillPidTree(pid: number): void {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
        return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** Machine-wide bridge lease keyed by the board endpoint, never by workspace. */
export class RuntimeLease {
    private readonly leasePath: string;
    private readonly boardEndpoint: string;
    private readonly isPidAlive: (pid: number | undefined) => boolean;
    private readonly killPidTree: (pid: number) => void;

    constructor(
        boardEndpoint: string,
        private readonly agent: string,
        private readonly repoRoot: string,
        private readonly ownerPid: number,
        private readonly extensionVersion: string,
        options: RuntimeLeaseOptions = {},
    ) {
        this.boardEndpoint = endpointIdentity(boardEndpoint);
        const lockDir = options.lockDir || defaultLockDir();
        fs.mkdirSync(lockDir, { recursive: true });
        this.leasePath = path.join(lockDir, `bridge-${endpointKey(boardEndpoint)}.lock`);
        this.isPidAlive = options.isPidAlive || defaultIsPidAlive;
        this.killPidTree = options.killPidTree || defaultKillPidTree;
    }

    readCurrent(): RuntimeLeaseRecord | null {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.leasePath, 'utf8')) as RuntimeLeaseRecord;
            return parsed && parsed.boardEndpoint === this.boardEndpoint ? parsed : null;
        } catch { return null; }
    }

    tryAcquire(): RuntimeLeaseAcquireResult {
        return this.tryAcquireInternal(true, 'acquired');
    }

    markBridgeStarted(bridgePid: number): void {
        this.updateOwned({ bridgePid, heartbeatAt: new Date().toISOString(), status: 'waiting' });
    }

    renewHealthy(status: RuntimeLeaseStatus): void {
        this.updateOwned({ heartbeatAt: new Date().toISOString(), status });
    }

    markState(status: RuntimeLeaseStatus): void {
        this.updateOwned({ heartbeatAt: new Date().toISOString(), status });
    }

    releaseIfOwned(): void {
        try {
            if (this.readCurrent()?.pid === this.ownerPid) { fs.unlinkSync(this.leasePath); }
        } catch { /* best effort */ }
    }

    isOwned(): boolean {
        return this.readCurrent()?.pid === this.ownerPid;
    }

    private tryAcquireInternal(canReap: boolean, success: RuntimeLeaseAcquireResult): RuntimeLeaseAcquireResult {
        const now = new Date().toISOString();
        const record: RuntimeLeaseRecord = {
            pid: this.ownerPid,
            startedAt: now,
            heartbeatAt: now,
            extensionVersion: this.extensionVersion,
            repoRoot: this.repoRoot,
            boardEndpoint: this.boardEndpoint,
            agent: this.agent,
            status: 'starting',
        };
        try {
            fs.writeFileSync(this.leasePath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
            return success;
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') { return 'held-by-live-other'; }
        }

        const current = this.readCurrent();
        if (!current) {
            return canReap ? this.reapAndRetry('recovered-stale') : 'held-by-live-other';
        }
        if (current.pid === this.ownerPid) { return 'acquired'; }

        if (current.extensionVersion !== this.extensionVersion) {
            if (!canReap) { return 'held-by-live-other'; }
            if (current.bridgePid && this.isPidAlive(current.bridgePid)) { this.killPidTree(current.bridgePid); }
            return this.reapAndRetry('replaced-old-version');
        }

        const nowMs = Date.now();
        const heartbeatMs = Date.parse(current.heartbeatAt);
        const startedMs = Date.parse(current.startedAt);
        const recent = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= STALE_HEARTBEAT_MS;
        const grace = Number.isFinite(startedMs) && nowMs - startedMs <= START_GRACE_MS;
        const ownerAlive = this.isPidAlive(current.pid);
        const bridgeAlive = this.isPidAlive(current.bridgePid);
        const live = ownerAlive && ((bridgeAlive && recent) || (!current.bridgePid && grace));
        if (live) { return 'held-by-live-other'; }
        return canReap ? this.reapAndRetry('recovered-stale') : 'held-by-live-other';
    }

    private reapAndRetry(success: RuntimeLeaseAcquireResult): RuntimeLeaseAcquireResult {
        try { fs.unlinkSync(this.leasePath); } catch { return 'held-by-live-other'; }
        return this.tryAcquireInternal(false, success);
    }

    private updateOwned(patch: Partial<RuntimeLeaseRecord>): void {
        const current = this.readCurrent();
        if (!current || current.pid !== this.ownerPid) { return; }
        try { fs.writeFileSync(this.leasePath, JSON.stringify({ ...current, ...patch }, null, 2) + '\n', 'utf8'); } catch { /* best effort */ }
    }
}

export { endpointKey, endpointIdentity };
