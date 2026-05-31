import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { guardWorkerCommand } from './workerDenyList';

export type WorkerAutonomy = 'draft' | 'clanker';

export interface WorkerToolContext {
    repoRoot: string;
    /** draft = readonly + propose_diff only; clanker = real writes/exec (denylist-bounded). */
    autonomy: WorkerAutonomy;
}

export interface WorkerToolResult {
    result: string;
    /** Set when this call mutated the repo (for board logging). */
    mutated?: boolean;
    /** Path the worker touched, for an advisory claim / board post. */
    touched?: string;
}

const MAX_READ_BYTES = 60_000;
const MAX_EXEC_OUTPUT = 10_000;
const MAX_SEARCH_RESULTS = 80;

/** Resolve a repo-relative (or absolute) path, refusing anything outside repoRoot. */
function resolveInRepo(repoRoot: string, input: string): string {
    const abs = path.isAbsolute(input) ? input : path.join(repoRoot, input);
    const full = path.resolve(abs);
    const root = path.resolve(repoRoot);
    if (full.toLowerCase() !== root.toLowerCase() && !full.toLowerCase().startsWith(root.toLowerCase() + path.sep.toLowerCase())) {
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

function proposeDiffTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(repoRoot, String(args.path ?? ''));
    const newContent = String(args.content ?? '');
    const oldContent = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    const diff = unifiedDiff(oldContent, newContent, rel(repoRoot, full));
    return { result: `PROPOSED DIFF (not applied):\n${diff}`, touched: rel(repoRoot, full) };
}

// ── Mutating tools (clanker autonomy only) ───────────────────────────────────

function writeFileTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(repoRoot, String(args.path ?? ''));
    const content = String(args.content ?? '');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { result: `WROTE ${rel(repoRoot, full)} (${content.length} bytes)`, mutated: true, touched: rel(repoRoot, full) };
}

function replaceInFileTool(repoRoot: string, args: Record<string, unknown>): WorkerToolResult {
    const full = resolveInRepo(repoRoot, String(args.path ?? ''));
    const search = String(args.search ?? '');
    const replace = String(args.replace ?? '');
    if (!search) { throw new Error('replace_in_file requires a non-empty search string'); }
    const before = fs.readFileSync(full, 'utf8');
    if (!before.includes(search)) { throw new Error('search string not found in file'); }
    const after = before.split(search).join(replace);
    fs.writeFileSync(full, after, 'utf8');
    return { result: `REPLACED in ${rel(repoRoot, full)} (${before.length}→${after.length} bytes)`, mutated: true, touched: rel(repoRoot, full) };
}

function runCommandTool(repoRoot: string, args: Record<string, unknown>): Promise<WorkerToolResult> {
    const command = String(args.command ?? '');
    const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const timeoutMs = Number(args.timeout_ms ?? 30_000);
    const cwd = args.cwd ? resolveInRepo(repoRoot, String(args.cwd)) : repoRoot;

    const guard = guardWorkerCommand(command, cmdArgs);
    if (!guard.ok) {
        return Promise.resolve({ result: `REFUSED: ${guard.reason}` });
    }

    return new Promise((resolve) => {
        let stdout = '', stderr = '', done = false;
        let child;
        try {
            child = spawn(command, cmdArgs, { cwd, shell: false });
        } catch (err) {
            resolve({ result: `spawn error: ${err instanceof Error ? err.message : String(err)}` });
            return;
        }
        const timer = setTimeout(() => { done = true; try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
        child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ result: `spawn error: ${err.message}`, mutated: true });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            let out = stdout.slice(0, MAX_EXEC_OUTPUT);
            if (stderr) { out += `\n[stderr]\n${stderr.slice(0, MAX_EXEC_OUTPUT)}`; }
            out += done ? `\n[timed out after ${timeoutMs}ms]` : `\n[exit code: ${code ?? 'null'}]`;
            resolve({ result: out, mutated: true });
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
            fn('run_command', 'Run a binary directly (no shell). Destructive commands are refused.', { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeout_ms: { type: 'integer' } }, ['command', 'args']),
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
            return { result: `REFUSED: ${name} is disabled in draft mode — use propose_diff so the orchestrator can review and apply.` };
        }
        switch (name) {
            case 'read_file': return readFileTool(ctx.repoRoot, args);
            case 'list_directory': return listDirectoryTool(ctx.repoRoot, args);
            case 'search_code': return searchCodeTool(ctx.repoRoot, args);
            case 'propose_diff': return proposeDiffTool(ctx.repoRoot, args);
            case 'write_file': return writeFileTool(ctx.repoRoot, args);
            case 'replace_in_file': return replaceInFileTool(ctx.repoRoot, args);
            case 'run_command': return await runCommandTool(ctx.repoRoot, args);
            default: return { result: `unknown tool: ${name}` };
        }
    } catch (err) {
        return { result: `ERROR (${name}): ${err instanceof Error ? err.message : String(err)}` };
    }
}

export { READONLY_TOOLS, MUTATING_TOOLS };
