import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Codex-as-worker backend: routes `codex` / `codex:<model>` dispatches to the
 * OpenAI Codex CLI (`codex exec`) instead of an OpenAI-compatible HTTP endpoint.
 *
 * Why this exists: local models are the cheap-but-weak worker tier; Codex is the
 * frontier-quality worker most users already pay for flat-rate. This backend
 * lets `dispatch_subagent` hand a work order to Codex while keeping Relay's
 * board lifecycle (started/done posts, STOP abort, draft/clanker bounds).
 *
 * Safety mapping: Relay's autonomy mode maps onto Codex's own sandbox —
 * draft → `--sandbox read-only` (investigate/report only), clanker →
 * `--sandbox workspace-write` (edit + run inside the workspace). Relay never
 * passes `--dangerously-bypass-approvals-and-sandbox`.
 *
 * OAuth caveat (documented in README): `codex exec` is a second Codex process.
 * On a ChatGPT-subscription login, running it concurrently with a long-lived
 * interactive Codex session has historically risked `refresh_token_reused`
 * revocation. Short sequential exec runs are the intended shape.
 */

export interface CodexExecOptions {
    /** Codex CLI executable (default: `codex` on PATH). */
    executable?: string;
    /** Working directory the worker operates in (the coordinated repo). */
    repoRoot: string;
    /** Full prompt text; passed via stdin so quoting/length never break on Windows. */
    prompt: string;
    /** Optional model override (`codex:<model>` suffix), e.g. `gpt-5.5-codex`. */
    model?: string;
    sandbox: 'read-only' | 'workspace-write';
    /** Hard wall-clock cap; the process is killed past it. */
    timeoutMs: number;
    /** Polled every 2s; return a non-null reason to abort (board STOP/PAUSE). */
    shouldAbort?: () => string | null;
}

export interface CodexExecResult {
    ok: boolean;
    /** The worker's final message (from --output-last-message, stdout fallback). */
    output: string;
    exitCode: number | null;
    /** Set when the run was killed: the abort reason or 'timeout'. */
    aborted?: string;
    error?: string;
    /** The model codex reported in its run header, when present. */
    model?: string;
}

/** True when a dispatch model id targets the Codex CLI backend. */
export function isCodexModel(model: string): boolean {
    return /^codex(:|$)/i.test(model.trim());
}

/** The optional model override carried after `codex:` (empty → CLI default). */
export function codexModelOverride(model: string): string | undefined {
    const sep = model.indexOf(':');
    if (sep === -1) { return undefined; }
    const override = model.slice(sep + 1).trim();
    return override || undefined;
}

export const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60_000;

/**
 * The model a plain `codex` dispatch will run: the top-level `model = "..."`
 * from ~/.codex/config.toml. Used only to label board posts — codex itself
 * resolves its default; this never feeds back into the exec args.
 */
export function codexDefaultModel(configPath?: string): string | undefined {
    const file = configPath ?? path.join(os.homedir(), '.codex', 'config.toml');
    try {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.startsWith('[')) { break; } // top-level keys end at the first table
            const match = /^model\s*=\s*"([^"]+)"/.exec(trimmed);
            if (match) { return match[1]; }
        }
    } catch { /* no config — codex will use its built-in default */ }
    return undefined;
}

/** The `model: <name>` line codex exec prints in its run header. Exported for tests. */
export function parseCodexModelHeader(stdout: string): string | undefined {
    const match = /^\s*model:\s*(\S+)/m.exec(stdout);
    return match?.[1];
}

/** Build the `codex exec` argv (without the executable). Exported for tests. */
export function buildCodexArgs(opts: { model?: string; sandbox: string; lastMessagePath: string }): string[] {
    const args = ['exec', '--skip-git-repo-check', '--sandbox', opts.sandbox];
    if (opts.model) { args.push('-m', opts.model); }
    args.push('--output-last-message', opts.lastMessagePath);
    args.push('-'); // read the prompt from stdin
    return args;
}

/**
 * Compose the worker prompt. Codex gets the task as a self-contained work
 * order; the sandbox line keeps a draft worker from burning turns attempting
 * writes the sandbox will refuse anyway. Exported for tests.
 */
export function buildCodexPrompt(task: string, context: string | undefined, sandbox: 'read-only' | 'workspace-write'): string {
    const lines = [
        'You are a worker agent dispatched by an orchestrator through Forge Relay.',
        sandbox === 'read-only'
            ? 'Your sandbox is READ-ONLY: investigate and report; do not attempt writes or state-changing commands.'
            : 'You may edit files and run commands inside this workspace (network access may be restricted by the sandbox).',
        'Complete the task below, then end with a short summary of what you did or found.',
        '',
        'TASK:',
        task,
    ];
    if (context) {
        lines.push('', 'CONTEXT:', context);
    }
    return lines.join('\n');
}

// Node refuses to spawn .cmd/.bat shims without a shell (CVE-2024-27980), and
// the npm-installed Codex CLI on Windows is exactly such a shim — so Windows
// runs through the shell with explicit quoting of space-containing args.
const useShell = process.platform === 'win32';

function shellQuote(arg: string): string {
    if (!useShell || !/[\s"]/.test(arg)) { return arg; }
    return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Probe `codex --version` so a missing CLI fails the dispatch with a clear message. */
export function probeCodexCli(executable?: string): { ok: boolean; detail: string } {
    const exe = executable?.trim() || 'codex';
    try {
        const res = spawnSync(shellQuote(exe), ['--version'], {
            encoding: 'utf8', shell: useShell, timeout: 15_000, windowsHide: true,
        });
        if (res.error) { return { ok: false, detail: res.error.message }; }
        if (res.status !== 0) {
            return { ok: false, detail: (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 200) };
        }
        return { ok: true, detail: (res.stdout || '').trim() };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}

function killTree(pid: number | undefined): void {
    if (!pid) { return; }
    try {
        if (process.platform === 'win32') {
            // child.kill() would only hit the shell wrapper; take the tree down.
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch { /* already gone */ }
}

/** Run one `codex exec` work order to completion (or abort/timeout). */
export function runCodexExec(opts: CodexExecOptions): Promise<CodexExecResult> {
    const exe = opts.executable?.trim() || 'codex';
    const lastMessagePath = path.join(
        os.tmpdir(),
        `forgerelay-codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`,
    );
    const args = buildCodexArgs({ model: opts.model, sandbox: opts.sandbox, lastMessagePath });

    return new Promise<CodexExecResult>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(
                shellQuote(exe),
                useShell ? args.map(shellQuote) : args,
                { cwd: opts.repoRoot, shell: useShell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
            );
        } catch (err) {
            resolve({ ok: false, output: '', exitCode: null, error: err instanceof Error ? err.message : String(err) });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let aborted: string | undefined;

        const finish = (result: CodexExecResult): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timeoutTimer);
            clearInterval(abortPoll);
            try { fs.unlinkSync(lastMessagePath); } catch { /* best-effort */ }
            resolve(result);
        };

        const timeoutTimer = setTimeout(() => {
            aborted = `timeout after ${Math.round(opts.timeoutMs / 1000)}s`;
            killTree(child.pid);
        }, opts.timeoutMs);

        const abortPoll = setInterval(() => {
            const reason = opts.shouldAbort?.();
            if (reason && !aborted) {
                aborted = reason;
                killTree(child.pid);
            }
        }, 2_000);

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

        child.on('error', (err) => {
            finish({ ok: false, output: '', exitCode: null, error: err.message });
        });

        child.on('close', (code) => {
            let last = '';
            try { last = fs.readFileSync(lastMessagePath, 'utf8').trim(); } catch { /* fall back to stdout */ }
            const output = last || stdout.trim().slice(-4_000);
            const model = parseCodexModelHeader(stdout);
            if (aborted) {
                finish({ ok: false, output, exitCode: code, aborted, model });
                return;
            }
            if (code !== 0) {
                finish({
                    ok: false,
                    output,
                    exitCode: code,
                    error: `codex exec exited ${code}: ${(stderr || stdout).trim().slice(-500)}`,
                    model,
                });
                return;
            }
            finish({ ok: true, output: output || '(codex finished with no final message)', exitCode: code, model });
        });

        child.stdin?.on('error', () => { /* the close handler reports the real failure */ });
        child.stdin?.end(opts.prompt, 'utf8');
    });
}
