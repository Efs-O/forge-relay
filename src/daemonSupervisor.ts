import { spawn } from 'node:child_process';

/**
 * F6 Part B — opt-in daemon health-check / auto-start (friction-#4).
 *
 * Only the ollama daemon is auto-startable from Relay. Forge's control server
 * runs inside the VS Code extension host and CANNOT be started from here — the
 * caller probes it (forgeHealthz) and surfaces a clear message instead. All
 * helpers are bounded, opt-in, and never throw; the caller boards any message.
 */

const PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_START_BUDGET_MS = 10_000;
const REPROBE_INTERVAL_MS = 500;

/** GET `{ollamaUrl}/api/tags` → true when the ollama daemon answers. The OpenAI
 *  surface lives under `/v1`, but `/api/tags` is at the root — strip a trailing
 *  `/v1` before probing. Never throws. */
export async function ollamaHealthz(ollamaUrl: string): Promise<boolean> {
    const root = ollamaUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    try {
        const res = await fetch(`${root}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
}

export interface OllamaSupervisorOpts {
    /** Opt-in: when false/undefined, never spawn — just report down. */
    autoStart?: boolean;
    /** Executable to launch; defaults to `ollama` on PATH. */
    executable?: string;
    /** Total budget for the post-spawn re-probe loop. */
    startBudgetMs?: number;
}

export interface DaemonEnsureResult {
    up: boolean;
    started: boolean;
    message: string;
}

/**
 * Ensure the ollama daemon is reachable. If it is already up, no-op. If down and
 * `autoStart` is enabled, spawn `ollama serve` detached and re-probe within a
 * bounded budget (single attempt). Otherwise return a clear, actionable message.
 */
export async function ensureOllamaDaemon(ollamaUrl: string, opts: OllamaSupervisorOpts): Promise<DaemonEnsureResult> {
    if (await ollamaHealthz(ollamaUrl)) { return { up: true, started: false, message: '' }; }
    if (!opts.autoStart) {
        return { up: false, started: false, message: `ollama daemon down at ${ollamaUrl} and forgeRelay.ollamaAutoStart is off — start it with "ollama serve".` };
    }
    const exe = opts.executable || 'ollama';
    let spawnError = '';
    try {
        const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore' });
        // ENOENT / EACCES surface as an async 'error' event, not a throw — capture
        // it so it never becomes an unhandled exception. The re-probe loop below
        // still bounds the wait and reports down if the daemon never answers.
        child.on('error', (err) => { spawnError = err instanceof Error ? err.message : String(err); });
        child.unref();
    } catch (err) {
        return { up: false, started: false, message: `failed to spawn "${exe} serve": ${err instanceof Error ? err.message : String(err)}` };
    }
    const budget = opts.startBudgetMs ?? DEFAULT_START_BUDGET_MS;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, REPROBE_INTERVAL_MS));
        if (await ollamaHealthz(ollamaUrl)) { return { up: true, started: true, message: '' }; }
    }
    const why = spawnError ? `failed to spawn "${exe} serve": ${spawnError}` : `started "${exe} serve" but ollama did not become healthy at ${ollamaUrl} within ${budget / 1000}s.`;
    return { up: false, started: true, message: why };
}
