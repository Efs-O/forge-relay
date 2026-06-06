import * as fs from 'fs';
import * as path from 'path';

export type RuntimeLeaseStatus = 'starting' | 'waiting' | 'linked' | 'restarting' | 'stopped';
export type RuntimeLeaseAcquireResult = 'acquired' | 'held-by-live-other';

export interface RuntimeLeaseRecord {
    agent: string;
    owner_pid: number;
    bridge_pid?: number;
    repo_root: string;
    started_at: string;
    heartbeat_at: string;
    status: RuntimeLeaseStatus;
}

const START_GRACE_MS = 20_000;
const STALE_HEARTBEAT_MS = 20_000;

function isPidAlive(pid: number | undefined): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

export class RuntimeLease {
    private readonly leasePath: string;

    constructor(
        coordDir: string,
        private readonly agent: string,
        private readonly repoRoot: string,
        private readonly ownerPid: number,
    ) {
        this.leasePath = path.join(coordDir, `runtime-${agent}.json`);
    }

    readCurrent(): RuntimeLeaseRecord | null {
        try {
            const raw = fs.readFileSync(this.leasePath, 'utf8').trim();
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw) as RuntimeLeaseRecord;
            if (!parsed || parsed.agent !== this.agent || parsed.repo_root !== this.repoRoot) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    tryAcquire(): RuntimeLeaseAcquireResult {
        return this.tryAcquireInternal(true);
    }

    markBridgeStarted(bridgePid: number): void {
        this.updateOwned({
            bridge_pid: bridgePid,
            heartbeat_at: new Date().toISOString(),
            status: 'waiting',
        });
    }

    renewHealthy(status: RuntimeLeaseStatus): void {
        this.updateOwned({
            heartbeat_at: new Date().toISOString(),
            status,
        });
    }

    markState(status: RuntimeLeaseStatus): void {
        this.updateOwned({
            heartbeat_at: new Date().toISOString(),
            status,
        });
    }

    releaseIfOwned(): void {
        try {
            const current = this.readCurrent();
            if (current && current.owner_pid === this.ownerPid) {
                fs.unlinkSync(this.leasePath);
            }
        } catch {
            // Best-effort cleanup only.
        }
    }

    private tryAcquireInternal(canReap: boolean): RuntimeLeaseAcquireResult {
        const now = new Date().toISOString();
        const initialRecord: RuntimeLeaseRecord = {
            agent: this.agent,
            owner_pid: this.ownerPid,
            repo_root: this.repoRoot,
            started_at: now,
            heartbeat_at: now,
            status: 'starting',
        };

        try {
            fs.writeFileSync(this.leasePath, JSON.stringify(initialRecord, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
            return 'acquired';
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
                return 'held-by-live-other';
            }
        }

        const current = this.readCurrent();
        if (!current) {
            if (canReap) {
                this.tryRemoveLease();
                return this.tryAcquireInternal(false);
            }
            return 'held-by-live-other';
        }

        if (current.owner_pid === this.ownerPid) {
            return 'acquired';
        }

        const nowMs = Date.now();
        const heartbeatMs = Date.parse(current.heartbeat_at);
        const startedMs = Date.parse(current.started_at);
        const recentHeartbeat = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= STALE_HEARTBEAT_MS;
        const inGraceWindow = Number.isFinite(startedMs) && nowMs - startedMs <= START_GRACE_MS;
        const ownerAlive = isPidAlive(current.owner_pid);
        const bridgeAlive = isPidAlive(current.bridge_pid);
        const shouldHold =
            ownerAlive && (
                (bridgeAlive && recentHeartbeat) ||
                (!current.bridge_pid && inGraceWindow && (current.status === 'starting' || current.status === 'restarting'))
            );

        if (shouldHold) {
            return 'held-by-live-other';
        }

        if (canReap) {
            this.tryRemoveLease();
            return this.tryAcquireInternal(false);
        }
        return 'held-by-live-other';
    }

    private updateOwned(patch: Partial<RuntimeLeaseRecord>): void {
        const current = this.readCurrent();
        if (!current || current.owner_pid !== this.ownerPid) {
            return;
        }
        const next: RuntimeLeaseRecord = {
            ...current,
            ...patch,
        };
        try {
            fs.writeFileSync(this.leasePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
        } catch {
            // Best-effort lease maintenance only.
        }
    }

    private tryRemoveLease(): void {
        try {
            fs.unlinkSync(this.leasePath);
        } catch {
            // Ignore races.
        }
    }
}
