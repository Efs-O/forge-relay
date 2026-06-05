import { ResolvedModel, forgeEnsure, forgeRelease } from './subagent';

/**
 * Batch-level Forge model hold (TODO-forge-concurrency-hardening, Fix A + C).
 *
 * The Forge route used to take one `/ensure` and one `/release` per worker. With
 * a same-model fan-out (N workers, M in flight) that is N independent
 * ensure/release cycles racing on one shared ref-count inside Forge — the count
 * can momentarily misread and the load can be torn down / treated as evictable
 * while siblings are mid-request (the `ECONNRESET` + `⚠ /release not confirmed`
 * burst we observed).
 *
 * This module collapses those N Forge calls into 1 `/ensure` + 1 `/release` for
 * the duration of an overlapping batch: a process-wide ref-counted hold keyed by
 * `(controlUrl, model)`. The first acquirer ensures and pins the load; every
 * concurrent same-model acquirer just increments and reuses the resolved
 * endpoint; the last to release fires the single Forge `/release`. While any
 * worker is in flight the count stays ≥ 1, so Forge can never evict the load
 * mid-batch. A non-overlapping (truly sequential) dispatch still gets its own
 * 1 + 1 pair, exactly as before.
 */

export interface ForgeHoldDeps {
    ensure: (controlUrl: string, model: string) => Promise<{ baseUrl: string; model: string; backend: string }>;
    release: (controlUrl: string, model: string) => Promise<boolean>;
}

export interface ForgeHold {
    /** The endpoint Forge resolved the model to (shared by every holder in the batch). */
    resolved: ResolvedModel;
    /**
     * Drop this acquirer's share of the hold. The real Forge `/release` only
     * fires when the last holder leaves. Idempotent (safe in a `finally`).
     */
    release: () => Promise<void>;
}

interface HoldEntry {
    count: number;
    ensurePromise: Promise<{ baseUrl: string; model: string; backend: string }>;
}

export class ForgeHoldRegistry {
    private readonly holds = new Map<string, HoldEntry>();

    constructor(private readonly deps: ForgeHoldDeps = { ensure: forgeEnsure, release: forgeRelease }) {}

    private key(controlUrl: string, model: string): string {
        // A control URL never contains whitespace and model ids never contain
        // " :: ", so this delimiter is collision-free for the (url, model) pair.
        return `${controlUrl} :: ${model}`;
    }

    /**
     * Join (or open) the shared hold for `(controlUrl, model)`. Resolves once the
     * model is healthy on Forge; rejects with whatever `/ensure` threw (the
     * acquirer is backed out so a failed ensure never leaks a phantom hold).
     */
    async acquire(controlUrl: string, model: string, onReleaseUnconfirmed?: () => void): Promise<ForgeHold> {
        const key = this.key(controlUrl, model);
        let entry = this.holds.get(key);
        if (!entry) {
            // First acquirer for this model: open the hold and kick off the single
            // /ensure. Increment *before* awaiting so a concurrent acquirer that
            // arrives mid-ensure reuses this same entry instead of opening a second.
            entry = { count: 0, ensurePromise: this.deps.ensure(controlUrl, model) };
            this.holds.set(key, entry);
        }
        entry.count++;

        let ensured: { baseUrl: string; model: string; backend: string };
        try {
            ensured = await entry.ensurePromise;
        } catch (err) {
            // Ensure failed — back this acquirer out. Drop the poisoned entry once
            // the last waiter on it has bailed so the next acquire re-ensures.
            entry.count--;
            if (entry.count <= 0 && this.holds.get(key) === entry) {
                this.holds.delete(key);
            }
            throw err;
        }

        const resolved: ResolvedModel = { backend: ensured.backend, model: ensured.model, baseUrl: ensured.baseUrl };
        let released = false;
        const release = async (): Promise<void> => {
            if (released) { return; }
            released = true;
            entry!.count--;
            if (entry!.count <= 0 && this.holds.get(key) === entry) {
                this.holds.delete(key);
                const ok = await this.deps.release(controlUrl, model);
                if (!ok) { onReleaseUnconfirmed?.(); }
            }
        };
        return { resolved, release };
    }

    /** Live holder count for a key (diagnostics / tests). */
    activeCount(controlUrl: string, model: string): number {
        return this.holds.get(this.key(controlUrl, model))?.count ?? 0;
    }
}

/**
 * Fair, hand-off counting semaphore. A released slot is transferred directly to
 * the next waiter (not freed-then-reacquired), so a same-tick `acquire()` can
 * never barge ahead of a queued waiter and oversubscribe the limit.
 */
export class Semaphore {
    private readonly waiters: Array<() => void> = [];
    private inUse = 0;

    constructor(private readonly limit: number) {}

    async acquire(): Promise<() => void> {
        if (this.inUse < this.limit) {
            this.inUse++;
            return this.makeRelease();
        }
        await new Promise<void>(resolve => this.waiters.push(resolve));
        // A slot was handed to us; inUse already accounts for it.
        return this.makeRelease();
    }

    private makeRelease(): () => void {
        let released = false;
        return () => {
            if (released) { return; }
            released = true;
            const next = this.waiters.shift();
            if (next) {
                next();           // hand the slot off; inUse is unchanged
            } else {
                this.inUse--;     // nobody waiting; free the slot
            }
        };
    }
}

/** Per-key concurrency cap — one {@link Semaphore} per model, created on demand. */
export class ConcurrencyLimiter {
    private readonly sems = new Map<string, Semaphore>();

    constructor(private readonly limit: number) {}

    acquire(key: string): Promise<() => void> {
        let sem = this.sems.get(key);
        if (!sem) {
            sem = new Semaphore(this.limit);
            this.sems.set(key, sem);
        }
        return sem.acquire();
    }
}

/**
 * Default in-flight cap for a same-model Forge fan-out (Fix C). Mirrors the
 * `n_parallel` slot count Forge/llama-server is configured with (4). Override
 * with `FORGERELAY_FORGE_PARALLEL` for fleets tuned to a different slot count.
 */
export const FORGE_PARALLEL_DEFAULT: number = (() => {
    const n = Number(process.env.FORGERELAY_FORGE_PARALLEL);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
})();

/** Process-wide singletons shared across all dispatch_subagent calls in the MCP server. */
export const forgeHolds = new ForgeHoldRegistry();
export const forgeSlots = new ConcurrencyLimiter(FORGE_PARALLEL_DEFAULT);
