import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { guardWorkerCommand, needsWindowsShell } from './workerDenyList';

export type WorkerAutonomy = 'draft' | 'clanker';

export interface WorkerToolContext {
    repoRoot: string;
    /** draft = readonly + propose_diff only; clanker = real writes/exec (denylist-bounded). */
    autonomy: WorkerAutonomy;
    /** Claim/authorize a repo-relative target before any mutation begins. */
    authorizeMutation?: (target: string) => void;
}

export interface WorkerToolResult {
    result: string;
    /** False means the tool was refused or failed and still requires recovery. */
    ok?: boolean;
    errorKind?: 'policy_refusal' | 'permission' | 'invalid_path' | 'claim_conflict' | 'spawn_error' | 'nonzero_exit' | 'timeout' | 'tool_error' | 'unknown_tool';
    /** Set when this call mutated the repo (for board logging). */
    mutated?: boolean;
    /** Path the worker touched, for an advisory claim / board post. */
    touched?: string;
    /** Repo-relative path of a saved proposal diff (draft mode), for the board ref. */
    proposalPath?: string;
}

const MAX_READ_BYTES = 60_000;
const MAX_EXEC_OUTPUT = 10_000;
const MAX_SEARCH_RESULTS = 80;

/** Resolve a repo-relative (or absolute) path, refusing anything outside repoRoot. */
function resolveInRepo(repoRoot: string, input: string): string {
    const abs = path.isAbsolute(input) ? input : path.join(repoRoot, input);
    const full = path.resolve(abs);
    const root = path.resolve(repoRoot);
    const relative = path.relative(root, full);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`path is outside the repo root: ${input}`);
    }
    return full;
}

function rel(repoRoot: string, full: string): string {
    return path.relative(repoRoot, full).replace(/\\/g, '/') || '.';
}

// ── Read-only tools (available in every mode) ────────────────────────────────

function readFileTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(repoRoot, String(args.path ?? ''));
    const buf = fs.readFileSync(full);
    const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
    const truncated = buf.length > MAX_READ_BYTES ? `\n…[truncated ${buf.length - MAX_READ_BYTES} bytes]` : '';
    return { result: text + truncated };
}

function listDirectoryTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(repoRoot, String(args.path ?? '.'));
    const entries = fs.readdirSync(full, { withFileTypes: true })
        .filter(e => e.name !== 'node_modules' && e.name !== '.git')
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
    return { result: entries.length ? entries.join('\n') : '(empty)' };
}

function searchCodeTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const query = String(args.query ?? '');
    if (!query) { throw new Error('search_code requires a query'); }
    const startRel = String(args.path ?? '.');
    const start = resolveInRepo(repoRoot, startRel);
    let re: RegExp;
    try { re = new RegExp(query, 'i'); } catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

    const hits: string[] = [];
    const walk = (dir: string): void => {
        if (hits.length >= MAX_SEARCH_RESULTS) { return; }
        let dirents: fs.Dirent[];
        try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of dirents) {
            if (hits.length >= MAX_SEARCH_RESULTS) { return; }
            if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'out' || ent.name === 'dist') { continue; }
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(p); continue; }
            let content: string;
            try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    hits.push(`${rel(repoRoot, p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                    if (hits.length >= MAX_SEARCH_RESULTS) { break; }
                }
            }
        }
    };
    walk(start);
    return { result: hits.length ? hits.join('\n') : '(no matches)' };
}

// ── Diff (used by propose_diff and draft-mode write feedback) ─────────────────

/** Minimal LCS-based unified-ish line diff — enough for human/orchestrator review. */
export function unifiedDiff(oldText: string, newText: string, label: string): string {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const n = a.length, m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push(`- ${a[i]}`); i++; }
        else { out.push(`+ ${b[j]}`); j++; }
    }
    while (i < n) { out.push(`- ${a[i++]}`); }
    while (j < m) { out.push(`+ ${b[j++]}`); }
    return out.join('\n');
}

const MAX_DIFF_INLINE = 1_500;

function proposeDiffTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(repoRoot, String(args.path ?? ''));
    const relPath = rel(repoRoot, full);
    const newContent = String(args.content ?? '');
    const oldContent = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    const diff = unifiedDiff(oldContent, newContent, relPath);

    // Persist the FULL diff to disk. In draft mode the board post is the only
    // place a proposal would otherwise live, and board posts are sliced (~160
    // chars), so a multi-line diff would be lost. Saving it lets the orchestrator
    // read and apply the complete proposal. (.coordination/ is git-ignored.)
    const proposalsDir = path.join(repoRoot, '.coordination', 'proposals');
    let proposalRel: string | undefined;
    try {
        fs.mkdirSync(proposalsDir, { recursive: true });
        const safe = relPath.replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9_.-]/g, '_');
        const proposalFull = path.join(proposalsDir, `${safe}-${Date.now().toString(36)}.diff`);
        fs.writeFileSync(proposalFull, diff + '\n', 'utf8');
        proposalRel = rel(repoRoot, proposalFull);
    } catch { /* fall back to inline-only if the proposals dir can't be written */ }

    const preview = diff.length > MAX_DIFF_INLINE ? diff.slice(0, MAX_DIFF_INLINE) + '\n…[truncated — see saved diff]' : diff;
    const ref = proposalRel ? `\nFull diff saved to ${proposalRel} for the orchestrator to review/apply.` : '';
    return {
        result: `PROPOSED DIFF for ${relPath} (NOT applied).${ref}\n${preview}`,
        touched: relPath,
        proposalPath: proposalRel,
    };
}

// ── Mutating tools (clanker autonomy only) ───────────────────────────────────

function authorize(ctx: WorkerToolContext, full: string): string {
    const target = rel(ctx.repoRoot, full);
    ctx.authorizeMutation?.(target);
    return target;
}

function writeFileTool(ctx: WorkerToolContext, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(ctx.repoRoot, String(args.path ?? ''));
    const target = authorize(ctx, full);
    const content = String(args.content ?? '');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { result: `WROTE ${target} (${content.length} bytes)`, ok: true, mutated: true, touched: target };
}

function replaceInFileTool(ctx: WorkerToolContext, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(ctx.repoRoot, String(args.path ?? ''));
    const search = String(args.search ?? '');
    const replace = String(args.replace ?? '');
    if (!search) { throw new Error('replace_in_file requires a non-empty search string'); }
    const before = fs.readFileSync(full, 'utf8');
    if (!before.includes(search)) { throw new Error('search string not found in file'); }
    const target = authorize(ctx, full);
    const after = before.split(search).join(replace);
    fs.writeFileSync(full, after, 'utf8');
    return { result: `REPLACED in ${target} (${before.length}→${after.length} bytes)`, ok: true, mutated: true, touched: target };
}

/** Kill a worker child and its descendants (cmd.exe → npm → node can orphan on win32). */
function killTree(pid: number | undefined): void {
    if (pid === undefined) { return; }
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { /* ignore */ });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch { /* ignore */ }
}

function runCommandTool(ctx: WorkerToolContext, args: Record<string, unknown>): Promise<WorkerToolResult> {
    const command = String(args.command ?? '');
    const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const timeoutMs = Number(args.timeout_ms ?? 30_000);
    const cwd = args.cwd ? resolveInRepo(ctx.repoRoot, String(args.cwd)) : ctx.repoRoot;

    const guard = guardWorkerCommand(command, cmdArgs);
    if (!guard.ok) {
        return Promise.resolve({ result: `REFUSED [kind=policy_refusal]: ${guard.reason}`, ok: false, errorKind: 'policy_refusal' });
    }
    authorize(ctx, cwd);

    // Windows: shell builtins (mkdir) and .cmd shims (npm/npx/tsc/…) can't be
    // launched with shell:false. Route the allowlisted set through cmd.exe /c.
    // The denylist + shell-operator ban were already enforced above, so cmd
    // only ever sees an operator-free, non-destructive command line.
    let program = command;
    let spawnArgs = cmdArgs;
    if (process.platform === 'win32' && needsWindowsShell(command)) {
        program = process.env.ComSpec || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', command, ...cmdArgs];
    }

    return new Promise((resolve) => {
        let stdout = '', stderr = '', done = false;
        let child;
        try {
            child = spawn(program, spawnArgs, { cwd, shell: false });
        } catch (err) {
            resolve({ result: `ERROR [kind=spawn_error]: ${err instanceof Error ? err.message : String(err)}`, ok: false, errorKind: 'spawn_error' });
            return;
        }
        const timer = setTimeout(() => { done = true; killTree(child.pid); }, timeoutMs);
        child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ result: `ERROR [kind=spawn_error]: ${err.message}`, ok: false, errorKind: 'spawn_error' });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            let out = stdout.slice(0, MAX_EXEC_OUTPUT);
            if (stderr) { out += `\n[stderr]\n${stderr.slice(0, MAX_EXEC_OUTPUT)}`; }
            out += done ? `\n[timed out after ${timeoutMs}ms]` : `\n[exit code: ${code ?? 'null'}]`;
            const ok = !done && code === 0;
            const errorKind = done ? 'timeout' : ok ? undefined : 'nonzero_exit';
            const prefix = errorKind ? `ERROR [kind=${errorKind}]\n` : '';
            resolve({ result: prefix + out, ok, ...(errorKind ? { errorKind } : {}), mutated: true, touched: rel(ctx.repoRoot, cwd) });
        });
    });
}

// ── Executor ─────────────────────────────────────────────────────────────────

const READONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_code', 'propose_diff']);
const MUTATING_TOOLS = new Set(['write_file', 'replace_in_file', 'run_command']);

/** Tool schemas offered to the model for a given autonomy mode (OpenAI function format). */
export function workerToolSchemas(autonomy: WorkerAutonomy): unknown[] {
    const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
        ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

    const tools: unknown[] = [
        fn('read_file', 'Read a repo file.', { path: { type: 'string' } }, ['path']),
        fn('list_directory', 'List a repo directory.', { path: { type: 'string' } }, ['path']),
        fn('search_code', 'Regex-search the repo for a string.', { query: { type: 'string' }, path: { type: 'string' } }, ['query']),
    ];

    if (autonomy === 'clanker') {
        tools.push(
            fn('write_file', 'Create or overwrite a repo file with new content.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
            fn('replace_in_file', 'Replace occurrences of a search string in a repo file.', { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, ['path', 'search', 'replace']),
            fn('run_command', 'Run a command (no shell operators — pass args as the args array, not one string). Common dev tools work cross-platform: mkdir, npm, npx, node, git, python, tsc, etc. Destructive commands are refused.', { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeout_ms: { type: 'integer' } }, ['command', 'args']),
        );
    } else {
        // Draft mode: no direct writes — the worker proposes a diff instead.
        tools.push(
            fn('propose_diff', 'Propose new content for a file as a unified diff (NOT applied; the orchestrator reviews/applies).', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
        );
    }
    return tools;
}

/** Execute a single worker tool call, enforcing autonomy + sandbox. */
export async function executeWorkerTool(name: string, args: Record<string, unknown>, ctx: WorkerToolContext): Promise<WorkerToolResult> {
    try {
        // Defense in depth: mutating tools never run in draft mode even if the
        // model somehow calls one.
        if (MUTATING_TOOLS.has(name) && ctx.autonomy !== 'clanker') {
            return { result: `REFUSED [kind=permission]: ${name} is disabled in draft mode — use propose_diff so the orchestrator can review and apply.`, ok: false, errorKind: 'permission' };
        }
        switch (name) {
            case 'read_file': return readFileTool(ctx.repoRoot, args);
            case 'list_directory': return listDirectoryTool(ctx.repoRoot, args);
            case 'search_code': return searchCodeTool(ctx.repoRoot, args);
            case 'propose_diff': return proposeDiffTool(ctx.repoRoot, args);
            case 'write_file': return writeFileTool(ctx, args);
            case 'replace_in_file': return replaceInFileTool(ctx, args);
            case 'run_command': return await runCommandTool(ctx, args);
            default: return { result: `ERROR [kind=unknown_tool]: ${name}`, ok: false, errorKind: 'unknown_tool' };
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorKind = /outside the repo root/i.test(message) ? 'invalid_path'
            : /claim|held by|conflict/i.test(message) ? 'claim_conflict'
                : 'tool_error';
        return { result: `ERROR [kind=${errorKind}] (${name}): ${message}`, ok: false, errorKind };
    }
}

export { READONLY_TOOLS, MUTATING_TOOLS };
