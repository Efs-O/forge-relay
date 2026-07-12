import { spawn } from 'child_process';
import { Bridge } from './bridge';

const BLOCK_POLL_MS = 1000;
const OUTPUT_TAIL_CHARS = 4000;

export interface BuildWrapperConfig {
    /** Full shell command line to run, e.g. "npm run build" or "dotnet build". Trusted config only — never taken from a tool-call argument. */
    buildCommand?: string;
    /** Repo-relative paths to claim for the duration of the build. Empty = no claim, board_check-only coordination. */
    buildClaimTargets?: string[];
    /** Wall-clock cap in ms; the build process is killed past it. */
    buildTimeoutMs?: number;
}

function truncateTail(s: string, max: number): string {
    return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Coordinate a build: pre-flight board check, claim the configured target(s),
 * run the configured command, post start/result, and release the claim on
 * success, failure, timeout, or operator STOP/PAUSE. The command itself is
 * never accepted from a tool-call argument — only from trusted local config
 * (VS Code setting or FORGERELAY_BUILD_COMMAND env var) — so there is no
 * command-injection surface from a model-controlled argument.
 */
export async function runCoordinatedBuild(bridge: Bridge, config: BuildWrapperConfig, agent: string, note: string): Promise<string> {
    const command = (config.buildCommand ?? '').trim();
    if (!command) {
        return 'ERROR: no build command configured (set "forgeRelay.build.command" or FORGERELAY_BUILD_COMMAND)';
    }

    const blocking = bridge.getBlockingCommands(agent);
    if (blocking.length) {
        return `BLOCKED\n\nYou have ${blocking.length} blocking command(s). Acknowledge and stop work.\n\n${blocking.map(c => `[${c.id.slice(0, 8)}] ${c.text} (by ${c.created_by})`).join('\n')}`;
    }

    const targets = config.buildClaimTargets ?? [];
    if (targets.length) {
        try {
            bridge.claim(agent, targets, 60, note || `build: ${command}`);
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
    }

    let released = false;
    const release = (): void => {
        if (released || !targets.length) { return; }
        released = true;
        try { bridge.release(agent, targets, 'build complete'); } catch { /* already released or expired */ }
    };

    try {
        bridge.post(agent, `build start: ${command}`.slice(0, 1000));
        const result = await runCommand(bridge, agent, command, bridge.getRepoRoot(), config.buildTimeoutMs ?? 600_000);
        const summary = result.timedOut
            ? `build TIMEOUT after ${config.buildTimeoutMs ?? 600_000}ms\n${truncateTail(result.output, OUTPUT_TAIL_CHARS)}`
            : result.stopped
                ? `build STOPPED by operator command\n${truncateTail(result.output, OUTPUT_TAIL_CHARS)}`
                : result.code === 0
                    ? `build ok (exit 0)\n${truncateTail(result.output, OUTPUT_TAIL_CHARS)}`
                    : `build FAILED (exit ${result.code})\n${truncateTail(result.output, OUTPUT_TAIL_CHARS)}`;
        bridge.post(agent, summary.replace(/\s+/g, ' ').slice(0, 1000));
        return summary;
    } finally {
        release();
    }
}

interface CommandResult { code: number | null; output: string; timedOut: boolean; stopped: boolean; }

function runCommand(bridge: Bridge, agent: string, command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
        // A trusted, locally-configured command line runs through the shell so
        // operators can use their normal build invocations (e.g. "npm run build",
        // "dotnet build -c Release") unmodified; this is never a tool-call argument.
        const child = spawn(command, { cwd, shell: true, timeout: timeoutMs });
        let output = '';
        let timedOut = false;
        let stopped = false;
        child.stdout?.on('data', (d) => { output += d.toString(); });
        child.stderr?.on('data', (d) => { output += d.toString(); });
        child.on('error', (err) => { output += `\n${err.message}`; });

        const stopCheck = setInterval(() => {
            if (bridge.getBlockingCommands(agent).length) {
                stopped = true;
                clearInterval(stopCheck);
                child.kill();
            }
        }, BLOCK_POLL_MS);

        child.on('close', (code, signal) => {
            clearInterval(stopCheck);
            timedOut = signal === 'SIGTERM' && !stopped && timeoutMs > 0 && !!child.killed;
            resolve({ code, output, timedOut, stopped });
        });
    });
}
