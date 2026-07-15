import { randomUUID, createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type CodexRuntimeLeaseStatus = 'starting' | 'waiting' | 'linked' | 'restarting' | 'stopped';
export type CodexRuntimeLeaseAcquireResult = 'acquired' | 'recovered-stale' | 'held-by-live-other' | 'unknown';

export interface CodexRuntimeLeaseRecord {
    version: 1;
    ownerToken: string;
    pid: number;
    childPid?: number;
    startedAt: string;
    heartbeatAt: string;
    extensionVersion: string;
    repoRoot: string;
    homeFingerprint: string;
    status: CodexRuntimeLeaseStatus;
}

export interface CodexRuntimeLeaseOptions {
    lockDir?: string;
    isPidAlive?: (pid: number | undefined) => boolean;
    now?: () => Date;
    ownerToken?: string;
    userIdentity?: string;
    platform?: NodeJS.Platform;
}

type LeaseRead =
    | { kind: 'missing' }
    | { kind: 'invalid' }
    | { kind: 'valid'; record: CodexRuntimeLeaseRecord };

function defaultLockDir(): string {
    const base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    return path.join(base, 'forge-relay', 'codex-runtime');
}

function defaultUserIdentity(): string {
    if (typeof process.getuid === 'function') {
        return `uid:${process.getuid()}`;
    }
    try { return `user:${os.userInfo().username}`; } catch { return 'user:unknown'; }
}

function defaultIsPidAlive(pid: number | undefined): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) { return false; }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Normalize the effective CODEX_HOME without reading anything inside it. */
export function normalizeCodexHome(home: string, platform: NodeJS.Platform = process.platform): string {
    const raw = home.trim();
    if (!raw) { throw new Error('Effective Codex home is empty.'); }
    if (platform === 'win32') {
        return path.win32.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
    }
    return path.posix.resolve(raw).replace(/\/+$/, '') || '/';
}

/** Non-secret identity used only as the machine-local lease filename. */
export function codexHomeFingerprint(
    home: string,
    userIdentity = defaultUserIdentity(),
    platform: NodeJS.Platform = process.platform,
): string {
    const normalized = normalizeCodexHome(home, platform);
    return createHash('sha256').update(`${platform}\0${userIdentity}\0${normalized}`, 'utf8').digest('hex');
}

/**
 * Machine-local, credential-home keyed lease for one Relay-owned Codex app-server.
 *
 * This deliberately does not kill or replace a live owner, including an owner
 * from an older extension version. An unreadable record also fails closed.
 */
export class CodexRuntimeLease {
    private readonly leasePath: string;
    private readonly fingerprint: string;
    private readonly isPidAlive: (pid: number | undefined) => boolean;
    private readonly now: () => Date;
    private readonly ownerToken: string;

    constructor(
        effectiveCodexHome: string,
        private readonly repoRoot: string,
        private readonly ownerPid: number,
        private readonly extensionVersion: string,
        options: CodexRuntimeLeaseOptions = {},
    ) {
        this.fingerprint = codexHomeFingerprint(
            effectiveCodexHome,
            options.userIdentity ?? defaultUserIdentity(),
            options.platform ?? process.platform,
        );
        const lockDir = options.lockDir ?? defaultLockDir();
        fs.mkdirSync(lockDir, { recursive: true });
        this.leasePath = path.join(lockDir, `codex-${this.fingerprint}.lock`);
        this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
        this.now = options.now ?? (() => new Date());
        this.ownerToken = options.ownerToken ?? randomUUID();
    }

    readCurrent(): CodexRuntimeLeaseRecord | null {
        const read = this.readLease();
        return read.kind === 'valid' ? read.record : null;
    }

    tryAcquire(): CodexRuntimeLeaseAcquireResult {
        return this.tryAcquireInternal(true, 'acquired');
    }

    markBridgeStarted(childPid: number): void {
        this.updateOwned({ childPid, status: 'waiting', heartbeatAt: this.now().toISOString() });
    }

    renewHealthy(status: CodexRuntimeLeaseStatus): void {
        this.updateOwned({ status, heartbeatAt: this.now().toISOString() });
    }

    markState(status: CodexRuntimeLeaseStatus): void {
        this.renewHealthy(status);
    }

    isOwned(): boolean {
        const read = this.readLease();
        return read.kind === 'valid' && read.record.ownerToken === this.ownerToken;
    }

    releaseIfOwned(): void {
        const read = this.readLease();
        if (read.kind !== 'valid' || read.record.ownerToken !== this.ownerToken) { return; }
        try { fs.unlinkSync(this.leasePath); } catch { /* best effort */ }
    }

    private tryAcquireInternal(
        canRecover: boolean,
        success: CodexRuntimeLeaseAcquireResult,
    ): CodexRuntimeLeaseAcquireResult {
        const now = this.now().toISOString();
        const record: CodexRuntimeLeaseRecord = {
            version: 1,
            ownerToken: this.ownerToken,
            pid: this.ownerPid,
            startedAt: now,
            heartbeatAt: now,
            extensionVersion: this.extensionVersion,
            repoRoot: this.repoRoot,
            homeFingerprint: this.fingerprint,
            status: 'starting',
        };
        try {
            fs.writeFileSync(this.leasePath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
            return success;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { return 'unknown'; }
        }

        const current = this.readLease();
        if (current.kind === 'invalid') { return 'unknown'; }
        if (current.kind === 'missing') {
            return canRecover ? this.tryAcquireInternal(false, 'recovered-stale') : 'unknown';
        }
        if (current.record.ownerToken === this.ownerToken) { return 'acquired'; }

        // A live owner OR child always wins. Never kill or take over a live process.
        if (this.isPidAlive(current.record.pid) || this.isPidAlive(current.record.childPid)) {
            return 'held-by-live-other';
        }
        if (!canRecover) { return 'held-by-live-other'; }

        // Re-read immediately before unlinking so a newly acquired owner cannot be
        // removed after the liveness decision above.
        const confirmed = this.readLease();
        if (confirmed.kind !== 'valid' || confirmed.record.ownerToken !== current.record.ownerToken) {
            return confirmed.kind === 'invalid' ? 'unknown' : 'held-by-live-other';
        }
        try { fs.unlinkSync(this.leasePath); } catch { return 'held-by-live-other'; }
        return this.tryAcquireInternal(false, 'recovered-stale');
    }

    private readLease(): LeaseRead {
        let raw: string;
        try {
            raw = fs.readFileSync(this.leasePath, 'utf8');
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
        }
        try {
            const record = JSON.parse(raw) as Partial<CodexRuntimeLeaseRecord>;
            if (record.version !== 1 || record.homeFingerprint !== this.fingerprint
                || typeof record.ownerToken !== 'string' || !record.ownerToken
                || !Number.isInteger(record.pid) || (record.pid ?? 0) <= 0
                || typeof record.startedAt !== 'string' || typeof record.heartbeatAt !== 'string'
                || typeof record.extensionVersion !== 'string' || typeof record.repoRoot !== 'string'
                || !['starting', 'waiting', 'linked', 'restarting', 'stopped'].includes(String(record.status))) {
                return { kind: 'invalid' };
            }
            if (record.childPid !== undefined && (!Number.isInteger(record.childPid) || record.childPid <= 0)) {
                return { kind: 'invalid' };
            }
            return { kind: 'valid', record: record as CodexRuntimeLeaseRecord };
        } catch {
            return { kind: 'invalid' };
        }
    }

    private updateOwned(patch: Partial<CodexRuntimeLeaseRecord>): void {
        const current = this.readLease();
        if (current.kind !== 'valid' || current.record.ownerToken !== this.ownerToken) { return; }
        const next = { ...current.record, ...patch };
        const tempPath = `${this.leasePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(tempPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
            // The destination and temp file share a directory, making the visible
            // replacement atomic on supported local filesystems.
            fs.renameSync(tempPath, this.leasePath);
        } catch {
            try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
        }
    }
}
