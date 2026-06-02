import { spawnSync } from 'child_process';
import { Bridge } from './bridge';
import {
    chatCompletionRaw, dispatchSubagentTier1, resolveModel, ResolvedModel,
    SubagentBackends, SubagentToolMode, workerAgentName, validateBackend, modelRoutingNote,
    forgeRoute, forgeHealthz, withConnRetry, BackendConnectionError,
} from './subagent';
import { forgeHolds, forgeSlots } from './forgeHold';
import { executeWorkerTool, workerToolSchemas, WorkerAutonomy, WorkerToolContext, WorkerToolResult } from './workerTools';

interface OpenAiToolCall {
    id?: string;
    function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
    role: string;
    content?: string | null;
    tool_calls?: OpenAiToolCall[];
}

export interface WorkerLoopOptions {
    maxSteps?: number;
    /** Return a non-null reason to abort the loop between steps (e.g. board STOP). */
    shouldAbort?: () => string | null;
    /** Notified after each tool call so the caller can post it to the board. */
    onToolCall?: (name: string, res: WorkerToolResult) => void;
    /** Notified after each model turn with token usage (when the backend reports it). */
    onUsage?: (promptTokens: number, totalTokens: number) => void;
    /** Notified before each transient-connection retry of a model turn (for board debug logging). */
    onRetry?: (attempt: number, delayMs: number, err: BackendConnectionError) => void;
    signal?: AbortSignal;
}

export interface WorkerLoopResult {
    finalText: string;
    steps: number;
    toolCalls: number;
    aborted?: string;
    /** Input/context tokens of the last model turn (how full the window got). */
    promptTokens?: number;
    /** Cumulative tokens across all model turns this dispatch. */
    totalTokens?: number;
}

const MAX_STEPS_DEFAULT = 12;

function systemPrompt(autonomy: string): string {
    const capability = autonomy === 'clanker'
        ? 'You may read, search, write, edit, and run commands. Destructive commands are refused automatically.'
        : 'You are in DRAFT mode: read and search freely, but you cannot write directly — use propose_diff to suggest changes for the orchestrator to apply.';
    return [
        'You are an autonomous worker subagent on a shared coding board, dispatched by an orchestrator.',
        'Work the task to completion using the provided tools, one step at a time.',
        capability,
        'Keep going until the task is done, then give a short final summary of what you did (no tool call).',
    ].join(' ');
}

/**
 * Tier 2 agentic worker loop (plan §3.3, Decision #3 revised). Runs an
 * OpenAI-style tool-calling ReAct loop against the resolved model endpoint,
 * executing AgentWatch's own sandboxed tools. Capability is bounded by the
 * autonomy mode in `ctx` (draft = readonly+propose_diff, clanker = full r/w/run).
 */
export async function runWorkerLoop(
    resolved: ResolvedModel,
    ctx: WorkerToolContext,
    task: string,
    context: string | undefined,
    opts: WorkerLoopOptions = {},
): Promise<WorkerLoopResult> {
    const maxSteps = opts.maxSteps ?? MAX_STEPS_DEFAULT;
    const tools = workerToolSchemas(ctx.autonomy);
    const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: systemPrompt(ctx.autonomy) },
        { role: 'user', content: context ? `${task}\n\nContext:\n${context}` : task },
    ];

    let toolCalls = 0;
    let promptTokens = 0;
    let totalTokens = 0;
    for (let step = 0; step < maxSteps; step++) {
        const abort = opts.shouldAbort?.();
        if (abort) {
            return { finalText: `Aborted: ${abort}`, steps: step, toolCalls, aborted: abort, promptTokens, totalTokens };
        }

        // Fix B: a single transient ECONNRESET (e.g. a still-warming backend in the
        // opening burst of a fan-out) is retried with short backoff instead of
        // killing the worker. HTTP errors and aborts still surface immediately.
        const res = await withConnRetry(
            () => chatCompletionRaw(resolved, { messages, tools, tool_choice: 'auto', temperature: 0.2 }, opts.signal),
            { signal: opts.signal, onRetry: opts.onRetry },
        ) as { choices?: Array<{ message?: OpenAiMessage }>; usage?: { prompt_tokens?: number; total_tokens?: number } };

        // Track context/token usage when the backend reports it (llama.cpp, Ollama
        // and the bridge all include an OpenAI `usage` block).
        const usage = res.usage;
        if (usage) {
            if (typeof usage.prompt_tokens === 'number') { promptTokens = usage.prompt_tokens; }
            if (typeof usage.total_tokens === 'number') { totalTokens += usage.total_tokens; }
            opts.onUsage?.(promptTokens, totalTokens);
        }

        const msg = res.choices?.[0]?.message;
        if (!msg) {
            return { finalText: 'Worker returned no message.', steps: step + 1, toolCalls, promptTokens, totalTokens };
        }

        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
            return { finalText: (msg.content ?? '').trim() || '(worker finished with no summary)', steps: step + 1, toolCalls, promptTokens, totalTokens };
        }

        // Echo the assistant tool-call message, then append each tool result.
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        for (const call of calls) {
            const name = call.function?.name ?? '';
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* leave empty */ }

            const toolResult = await executeWorkerTool(name, args, ctx);
            toolCalls++;
            opts.onToolCall?.(name, toolResult);
            messages.push({ role: 'tool', tool_call_id: call.id ?? name, content: toolResult.result.slice(0, 8_000) });
        }
    }

    return { finalText: `Reached step limit (${maxSteps}) without finishing.`, steps: maxSteps, toolCalls, promptTokens, totalTokens };
}

/** Compact token count for board posts: 12345 → "12k", 800 → "800". */
function ktok(n: number): string {
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Heuristic soft ceiling for warning that context is filling up (local models
 * commonly run 4k–32k windows; we don't get num_ctx over the API). */
const SOFT_CTX_WARN = 24_000;

/** ", ctx ~12k, ~30k tok" suffix for board/result lines, when usage was reported. */
function usageSuffix(r: WorkerLoopResult): string {
    const parts: string[] = [];
    if (r.promptTokens) { parts.push(`ctx ~${ktok(r.promptTokens)}`); }
    if (r.totalTokens) { parts.push(`~${ktok(r.totalTokens)} tok`); }
    return parts.length ? `, ${parts.join(', ')}` : '';
}

/** Record a git checkpoint so a clanker worker's changes are revertible. */
function gitCheckpoint(repoRoot: string): string {
    try {
        const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
        if (head.status !== 0) { return 'no git repo (changes not checkpointed)'; }
        const sha = (head.stdout || '').trim();
        const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
        const dirty = (status.stdout || '').trim().split('\n').filter(Boolean).length;
        return `git @ ${sha}${dirty ? ` (+${dirty} uncommitted)` : ' (clean)'} — revert worker edits with: git restore .`;
    } catch {
        return 'git checkpoint unavailable';
    }
}

/**
 * Shared handler for the `dispatch_subagent` MCP tool.
 *  - tools:"none"      → Tier 1 single completion (no file access).
 *  - tools:"readonly"  → Tier 2 worker forced into DRAFT (readonly + propose_diff).
 *  - tools:"full"      → Tier 2 worker using the current board autonomy mode
 *                        (clanker = real writes/exec, draft = propose_diff).
 * Workers honor board STOP/PAUSE and post their lifecycle as worker:<model>.
 */
export async function handleDispatchSubagent(
    bridge: Bridge,
    backends: SubagentBackends,
    args: Record<string, unknown>,
): Promise<string> {
    const dispatcher = String(args.agent ?? 'orchestrator');
    const model = String(args.model ?? '').trim();
    const task = String(args.task ?? '').trim();
    if (!model) { return 'ERROR: dispatch_subagent requires a model.'; }
    if (!task) { return 'ERROR: dispatch_subagent requires a task.'; }

    const requestedTools = (String(args.tools ?? 'none') as SubagentToolMode);
    const context = args.context !== undefined ? String(args.context) : undefined;
    const mode = String(args.mode ?? 'sync') === 'async' ? 'async' : 'sync';

    const worker = workerAgentName(model);

    // Resolve the worker endpoint and a teardown hook. The Forge route (opt-in,
    // forgeControlUrl set or a "forge:" prefix) asks Forge to load the model and
    // wait until it is healthy, then dispatches to the endpoint Forge returns.
    // Instead of one /ensure + /release per worker (N racing cycles on a same-model
    // fan-out), it joins a process-wide ref-counted batch hold: the first worker
    // ensures, concurrent same-model workers reuse the load, the last to finish
    // releases — exactly 1 /ensure + 1 /release per overlapping batch (Fix A). A
    // per-model slot cap then bounds in-flight workers to n_parallel (Fix C). When
    // the Forge route is off, this is exactly the previous direct/ollama/bridge probe.
    const route = forgeRoute(model, backends);
    let resolved: ResolvedModel;
    let modelNote = '';
    let release: () => Promise<void> = async () => { /* no-op when not routing via Forge */ };
    // Off the Forge route there is no slot cap — non-Forge routing is unchanged.
    let acquireSlot: () => Promise<() => void> = async () => () => { /* no-op */ };

    if (route.viaForge && !backends.forgeControlUrl) {
        // A "forge:" prefix was used but no control URL is configured.
        return `SUBAGENT not dispatched (${model}) — "forge:" routing requested but no forgeControlUrl is configured (set agentwatch.subagentForgeControlUrl / AGENTWATCH_FORGE_CONTROL_URL).`;
    }
    if (route.viaForge) {
        const controlUrl = backends.forgeControlUrl!;
        if (!(await forgeHealthz(controlUrl))) {
            const msg = `Forge control API not reachable at ${controlUrl} — is Forge running with control_server.enabled?`;
            bridge.post(worker, `not dispatched (${model}): ${msg}`.slice(0, 300));
            return `SUBAGENT not dispatched (${model}) — ${msg}`;
        }
        try {
            const hold = await forgeHolds.acquire(controlUrl, route.model, () => {
                bridge.post(worker, `⚠ Forge /release for ${route.model} not confirmed — its load may stay held`);
            });
            // The resolved endpoint carries the real backend Forge loaded the model
            // on (llamacpp/ollama/…); the "via Forge" marker keeps routing visible.
            resolved = hold.resolved;
            release = hold.release;
            modelNote = ' (via Forge)';
        } catch (err) {
            // 404 unknown / 409 busy / 502 load error all arrive as clear messages.
            const msg = err instanceof Error ? err.message : String(err);
            bridge.post(worker, `not dispatched (${model}): ${msg}`.slice(0, 300));
            return `SUBAGENT not dispatched (${model}) — ${msg}`;
        }
        // Bound same-model fan-out to the slot count; the (N+1)th worker queues
        // here instead of oversubscribing the backend.
        acquireSlot = () => forgeSlots.acquire(route.model);
    } else {
        // #7: validate the backend is reachable before we post "dispatched" or burn
        // a turn. Fail fast with a clear message if the model server is down;
        // otherwise carry a routing note (e.g. direct ignores the model id, or the
        // id isn't served) so the orchestrator knows what actually ran.
        resolved = resolveModel(model, backends);
        const probe = await validateBackend(resolved);
        if (!probe.reachable) {
            return `SUBAGENT not dispatched (${model}) — ${probe.message}`;
        }
        modelNote = modelRoutingNote(resolved, probe.models);
    }

    // Tier 1 — reasoning-only completion.
    if (requestedTools === 'none') {
        const slot = await acquireSlot();
        try {
            const r = await dispatchSubagentTier1(bridge, backends, { dispatcher, model, task, context }, resolved);
            return r.status === 'completed'
                ? `SUBAGENT ${r.subagentId} (${model})${modelNote} COMPLETED:\n\n${r.result}`
                : `SUBAGENT ${r.subagentId} (${model}) ERROR: ${r.error}`;
        } finally {
            slot();
            await release();
        }
    }

    // Tier 2 — agentic worker loop.
    const subagentId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const autonomy: WorkerAutonomy = requestedTools === 'readonly' ? 'draft' : bridge.getAutonomyMode();
    const ctx: WorkerToolContext = { repoRoot: bridge.getRepoRoot(), autonomy };

    const checkpoint = autonomy === 'clanker' ? gitCheckpoint(ctx.repoRoot) : 'draft mode (no writes)';
    bridge.post(worker, `started [${subagentId.slice(0, 10)}] ${mode} ${autonomy} (${resolved.backend}:${resolved.model})${modelNote}: ${task} | ${checkpoint}`.slice(0, 400));

    // The worker run, shared by sync and async. In async mode the done/error post
    // @mentions the dispatcher so the wake-on-@mention rule pulls the supervisor
    // back to evaluate the work; in sync mode the dispatcher already gets the
    // result inline, so we don't mention (and don't double-wake) them.
    const runWork = async (mentionDispatcher: boolean): Promise<WorkerLoopResult> => {
        const wake = mentionDispatcher ? `${dispatcher}: ` : '';
        // #6: files this worker actually writes get an advisory board claim so its
        // ownership shows in Active Claims and two workers won't draft the same
        // file. Released when the worker finishes (even on error/abort).
        const claimed = new Set<string>();
        let warnedCtx = false;
        // Fix C: hold a slot for the whole worker run so a same-model fan-out never
        // exceeds n_parallel in flight; the (N+1)th worker queues here. No-op off
        // the Forge route. Acquired inside runWork so async dispatches queue in the
        // background rather than blocking the dispatch call.
        const slot = await acquireSlot();
        try {
            const result = await runWorkerLoop(resolved, ctx, task, context, {
                shouldAbort: () => {
                    const blocking = bridge.getBlockingCommands(worker);
                    return blocking.length ? `board STOP/PAUSE (${blocking[0].text})` : null;
                },
                onRetry: (attempt, delayMs, err) => {
                    // Surface the transient churn so it is visible but non-fatal.
                    bridge.post(worker, `⚠ transient ${err.code ?? 'conn'} — retry ${attempt} in ${delayMs}ms: ${err.message.replace(/\s+/g, ' ').slice(0, 100)}`.slice(0, 200));
                },
                onUsage: (prompt) => {
                    // #4: surface context pressure once, so a long worker run that's
                    // filling its window is visible before it errors/degrades.
                    if (!warnedCtx && prompt >= SOFT_CTX_WARN) {
                        warnedCtx = true;
                        bridge.post(worker, `⚠ ctx ~${ktok(prompt)} tokens — context is filling up; consider a tighter task or splitting the work.`);
                    }
                },
                onToolCall: (name, res) => {
                    // Only surface mutations / proposals on the board to avoid spam.
                    if (name === 'propose_diff' && res.proposalPath) {
                        // Point the orchestrator at the saved full diff instead of a
                        // truncated inline blob (P0 #2).
                        bridge.post(worker, `propose_diff ${res.touched ?? ''} → full diff saved to ${res.proposalPath} (review & apply)`.slice(0, 300));
                    } else if (res.mutated || name === 'propose_diff') {
                        bridge.post(worker, `${name} ${res.touched ?? ''}: ${res.result.replace(/\s+/g, ' ').slice(0, 160)}`.slice(0, 300));
                    }
                    if (res.mutated && res.touched && !claimed.has(res.touched)) {
                        claimed.add(res.touched);
                        try { bridge.claim(worker, [res.touched], 60, `worker auto-claim ${subagentId.slice(0, 10)}`); } catch { /* advisory — ignore conflicts */ }
                    }
                },
            });
            bridge.post(worker, `${wake}done [${subagentId.slice(0, 10)}] (${result.steps} steps, ${result.toolCalls} tools${usageSuffix(result)}): ${result.finalText.replace(/\s+/g, ' ').slice(0, 180)}`.slice(0, 400));
            return result;
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            bridge.post(worker, `${wake}error [${subagentId.slice(0, 10)}]: ${error.replace(/\s+/g, ' ').slice(0, 180)}`.slice(0, 300));
            throw err;
        } finally {
            for (const p of claimed) {
                try { bridge.release(worker, [p], `worker ${subagentId.slice(0, 10)} done`); } catch { /* ignore */ }
            }
            // Free the slot before releasing the model hold so a queued sibling can
            // start immediately while we drop our share of the batch hold.
            slot();
            // Forge ref-count discipline: release the model hold whether the worker
            // finished, errored, or aborted. Runs once for both sync and async, since
            // runWork wraps the entire worker run in either mode (no-op off the route).
            await release();
        }
    };

    // Async — return a ticket immediately; the worker runs in the background and
    // wakes the dispatcher via its @mentioned done post.
    if (mode === 'async') {
        void runWork(true).catch(() => { /* error already posted to the board */ });
        return `SUBAGENT ${subagentId} (${model}, ${autonomy}) DISPATCHED (async). It is working in the background and will post progress as worker:${resolved.model}, then notify ${dispatcher} on the board when done. [${checkpoint}]`;
    }

    // Sync — block until done and return the result inline.
    try {
        const result = await runWork(false);
        const head = result.aborted
            ? `SUBAGENT ${subagentId} (${model}) ABORTED: ${result.aborted}`
            : `SUBAGENT ${subagentId} (${model}, ${autonomy}) COMPLETED (${result.steps} steps, ${result.toolCalls} tool calls${usageSuffix(result)}):`;
        return `${head}\n\n${result.finalText}\n\n[${checkpoint}]`;
    } catch (err) {
        return `SUBAGENT ${subagentId} (${model}) ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
}
