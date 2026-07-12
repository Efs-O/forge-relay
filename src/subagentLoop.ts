import { spawnSync } from 'child_process';
import { Bridge } from './bridge';
import {
    chatCompletionRaw, dispatchSubagentTier1, ResolvedModel,
    SubagentBackends, SubagentToolMode, workerAgentName, validateBackend, modelRoutingNote, beginWorkerRun, endWorkerRun, formatWorkerPost,
    decideForgeRoute, fetchForgeCatalog, forgeHealthz, withConnRetry, BackendConnectionError,
} from './subagent';
import { forgeHolds, forgeSlots, Semaphore } from './forgeHold';
import { ensureOllamaDaemon } from './daemonSupervisor';
import {
    isCodexModel, codexModelOverride, codexDefaultModel, buildCodexPrompt, probeCodexCli, runCodexExec,
    DEFAULT_CODEX_TIMEOUT_MS,
} from './codexWorker';
import { executeWorkerTool, workerToolSchemas, WorkerAutonomy, WorkerToolContext, WorkerToolResult } from './workerTools';
import { CompletionResponse, runToolCompletionRound } from './toolCompletionRound';

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

/**
 * Codex concurrency guard (see docs/NOTE-codex-concurrency-guard.md). Overlapping
 * `codex exec` dispatches were each getting their own untracked process with no
 * queue — a real risk given a second concurrent `codex exec` under the same
 * ChatGPT OAuth login can trip `token_revoked` and kill both sessions. This caps
 * Codex dispatches to one in flight at a time; extra dispatches queue instead of
 * racing. To revert: delete this Semaphore, the `codexSlot.acquire()` /
 * `releaseSlot()` calls in `runCodex` below, and the `Semaphore` import above.
 */
const codexSlot = new Semaphore(1);

/**
 * Worker system prompt. Contract: this must ALWAYS return a non-empty string —
 * every worker dispatch sends it as messages[0], so the serving side never has
 * to invent role instructions for a worker. Exported for the regression test
 * that locks this invariant (tests/workerSystemPrompt.test.ts).
 */
export function systemPrompt(autonomy: string): string {
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
 * executing Forge Relay's own sandboxed tools. Capability is bounded by the
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
    const sys = systemPrompt(ctx.autonomy);
    if (!sys.trim()) {
        throw new Error('worker system prompt resolved empty — refusing to dispatch a worker without role instructions');
    }
    const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: sys },
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
        const round = await runToolCompletionRound({
            messages,
            complete: () => withConnRetry(
                () => chatCompletionRaw(resolved, { messages, tools, tool_choice: 'auto', temperature: 0.2 }, opts.signal),
                { signal: opts.signal, onRetry: opts.onRetry },
            ) as Promise<CompletionResponse>,
            executeTool: async (name, args) => {
                const result = await executeWorkerTool(name, args, ctx);
                opts.onToolCall?.(name, result);
                return result.result;
            },
            onResponse: res => {
                const usage = res.usage;
                if (usage) {
                    if (typeof usage.prompt_tokens === 'number') promptTokens = usage.prompt_tokens;
                    if (typeof usage.total_tokens === 'number') totalTokens += usage.total_tokens;
                    opts.onUsage?.(promptTokens, totalTokens);
                }
            },
            missingMessageText: 'Worker returned no message.',
            emptyLengthError: 'worker produced no output and hit the token limit (reasoning/length overflow — raise max_tokens or lower reasoning_effort)',
        });
        toolCalls += round.toolCalls;
        if (round.finished) {
            return { finalText: round.finalText || '(worker finished with no summary)', steps: step + 1, toolCalls, promptTokens, totalTokens };
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

    const toolsSpecified = args.tools !== undefined;
    let requestedTools = (String(args.tools ?? 'none') as SubagentToolMode);
    const context = args.context !== undefined ? String(args.context) : undefined;
    const mode = String(args.mode ?? backends.defaultRunMode ?? 'sync') === 'async' ? 'async' : 'sync';

    let workerRunReleased = false;
    const finishWorkerRun = () => {
        if (!workerRunReleased) {
            workerRunReleased = true;
            endWorkerRun();
        }
    };
    const worker = workerAgentName(model, beginWorkerRun());

    // Codex CLI worker — `codex` / `codex:<model>` runs the task as one
    // `codex exec` work order in the repo, sandboxed by board autonomy. It never
    // touches the OpenAI-compatible HTTP routing below (Codex brings its own
    // agentic loop and tools), but shares the full board lifecycle: started/done
    // posts, STOP/PAUSE abort, async @mention wake, worker numbering.
    if (isCodexModel(model)) {
        const probe = probeCodexCli(backends.codexExecutable);
        if (!probe.ok) {
            finishWorkerRun();
            return `SUBAGENT not dispatched (${model}) — Codex CLI not available (${probe.detail}). Install it (npm i -g @openai/codex) or set forgeRelay.codexExecutable.`;
        }
        const subagentId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const autonomy: WorkerAutonomy = bridge.getAutonomyMode();
        const sandbox = autonomy === 'clanker' ? 'workspace-write' as const : 'read-only' as const;
        const checkpoint = autonomy === 'clanker' ? gitCheckpoint(bridge.getRepoRoot()) : 'draft mode (read-only sandbox)';
        // Best-effort model label for the board: the explicit codex:<model>
        // override, else the user's ~/.codex/config.toml default. The done post
        // upgrades to the model codex actually reported in its run header.
        const modelLabel = codexModelOverride(model) ?? codexDefaultModel() ?? 'default model';
        bridge.post(worker, formatWorkerPost(`started [${subagentId.slice(0, 10)}] ${mode} ${autonomy} (codex exec ${modelLabel}, sandbox ${sandbox}, ${probe.detail}): ${task} | ${checkpoint}`));

        const runCodex = async (mentionDispatcher: boolean): Promise<string> => {
            const wake = mentionDispatcher ? `${dispatcher}: ` : '';
            const releaseSlot = await codexSlot.acquire();
            try {
                const res = await runCodexExec({
                    executable: backends.codexExecutable,
                    repoRoot: bridge.getRepoRoot(),
                    prompt: buildCodexPrompt(task, context, sandbox),
                    model: codexModelOverride(model),
                    sandbox,
                    timeoutMs: backends.codexTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
                    shouldAbort: () => {
                        const blocking = bridge.getBlockingCommands(worker);
                        return blocking.length ? `board STOP/PAUSE (${blocking[0].text})` : null;
                    },
                });
                if (res.aborted) {
                    bridge.post(worker, formatWorkerPost(`${wake}aborted [${subagentId.slice(0, 10)}]: ${res.aborted}`));
                    return `SUBAGENT ${subagentId} (${model}) ABORTED: ${res.aborted}${res.output ? `\n\nPartial output:\n${res.output}` : ''}`;
                }
                if (!res.ok) {
                    bridge.post(worker, formatWorkerPost(`${wake}error [${subagentId.slice(0, 10)}]: ${res.error ?? 'codex exec failed'}`));
                    return `SUBAGENT ${subagentId} (${model}) ERROR: ${res.error ?? 'codex exec failed'}${res.output ? `\n\nPartial output:\n${res.output}` : ''}`;
                }
                bridge.post(worker, formatWorkerPost(`${wake}done [${subagentId.slice(0, 10)}] (${res.model ?? modelLabel}): ${res.output}`));
                return `SUBAGENT ${subagentId} (${model} → ${res.model ?? modelLabel}, ${autonomy}) COMPLETED:\n\n${res.output}\n\n[${checkpoint}]`;
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                bridge.post(worker, formatWorkerPost(`${wake}error [${subagentId.slice(0, 10)}]: ${error}`));
                return `SUBAGENT ${subagentId} (${model}) ERROR: ${error}`;
            } finally {
                releaseSlot();
                finishWorkerRun();
            }
        };

        if (mode === 'async') {
            void runCodex(true).catch(() => { /* error already posted to the board */ });
            return `SUBAGENT ${subagentId} (${model}, ${autonomy}) DISPATCHED (async). Codex is working in the background as ${worker} and will notify ${dispatcher} on the board when done. [${checkpoint}]`;
        }
        return runCodex(false);
    }

    // Resolve the worker endpoint and a teardown hook. The Forge route (opt-in,
    // forgeControlUrl set or a "forge:" prefix) asks Forge to load the model and
    // wait until it is healthy, then dispatches to the endpoint Forge returns.
    // Instead of one /ensure + /release per worker (N racing cycles on a same-model
    // fan-out), it joins a process-wide ref-counted batch hold: the first worker
    // ensures, concurrent same-model workers reuse the load, the last to finish
    // releases — exactly 1 /ensure + 1 /release per overlapping batch (Fix A). A
    // per-model slot cap then bounds in-flight workers to n_parallel (Fix C). When
    // the Forge route is off, this is exactly the previous direct/ollama/bridge probe.
    const route = decideForgeRoute(
        model,
        backends,
        backends.forgeControlUrl ? await fetchForgeCatalog(backends) : {
            control: { backend: 'forge-control', baseUrl: '', ok: false, error: 'Forge control route is off.' },
            bridge: { backend: 'forge-bridge', baseUrl: backends.bridgeUrl, ok: false, error: 'Forge route is off.' },
        },
    );
    let resolved: ResolvedModel;
    let modelNote = '';
    let release: () => Promise<void> = async () => { /* no-op when not routing via Forge */ };
    // Off the Forge route there is no slot cap — non-Forge routing is unchanged.
    let acquireSlot: () => Promise<() => void> = async () => () => { /* no-op */ };

    if (route.kind === 'error') {
        finishWorkerRun();
        return `SUBAGENT not dispatched (${model}) - ${route.message}`;
    }
    if (route.kind === 'forge-control') {
        const controlUrl = backends.forgeControlUrl!;
        if (!(await forgeHealthz(controlUrl))) {
            const msg = `Forge control API not reachable at ${controlUrl} — is Forge running with control_server.enabled?`;
            bridge.post(worker, formatWorkerPost(`not dispatched (${model}): ${msg}`));
            finishWorkerRun();
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
            bridge.post(worker, formatWorkerPost(`not dispatched (${model}): ${msg}`));
            finishWorkerRun();
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
        resolved = route.resolved;
        let probe = await validateBackend(resolved);
        // F6 Part B: opt-in ollama auto-start. Forge control is NOT auto-startable
        // from Relay (it lives in the VS Code extension host) — only probed above.
        if (!probe.reachable && resolved.backend === 'ollama') {
            const sup = await ensureOllamaDaemon(backends.ollamaUrl, {
                autoStart: backends.ollamaAutoStart,
                executable: backends.ollamaExecutable,
            });
            if (sup.started || sup.message) {
                bridge.post(worker, formatWorkerPost(`ollama auto-start: ${sup.up ? 'daemon up' : sup.message}`));
            }
            if (sup.up) { probe = await validateBackend(resolved); }
        }
        if (!probe.reachable) {
            finishWorkerRun();
            return `SUBAGENT not dispatched (${model}) — ${probe.message}`;
        }
        modelNote = route.note ?? modelRoutingNote(resolved, probe.models);
    }

    // Cloud-provider workers (Forge /chat) run on the provider's hardware, so the
    // VRAM-rationing Tier 1/2 split doesn't apply — default them to full agentic
    // tools. Write safety still comes from the board autonomy mode + denylist.
    if (resolved.backend === 'forge-chat' && !toolsSpecified) {
        requestedTools = 'full';
    }

    // Tier 1 — reasoning-only completion.
    if (requestedTools === 'none') {
        const slot = await acquireSlot();
        try {
            // Reuse the worker identity already reserved above (F2: avoids a second
            // beginWorkerRun that double-counts the ordinal and collides on worker-N).
            const r = await dispatchSubagentTier1(bridge, backends, { dispatcher, model, task, context }, resolved, worker);
            return r.status === 'completed'
                ? `SUBAGENT ${r.subagentId} (${model})${modelNote} COMPLETED:\n\n${r.result}`
                : `SUBAGENT ${r.subagentId} (${model}) ERROR: ${r.error}`;
        } finally {
            slot();
            await release();
            finishWorkerRun();
        }
    }

    // Tier 2 — agentic worker loop.
    const subagentId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const autonomy: WorkerAutonomy = requestedTools === 'readonly' ? 'draft' : bridge.getAutonomyMode();
    const ctx: WorkerToolContext = { repoRoot: bridge.getRepoRoot(), autonomy };

    const checkpoint = autonomy === 'clanker' ? gitCheckpoint(ctx.repoRoot) : 'draft mode (no writes)';
    bridge.post(worker, formatWorkerPost(`started [${subagentId.slice(0, 10)}] ${mode} ${autonomy} (${resolved.backend}:${resolved.model})${modelNote}: ${task} | ${checkpoint}`));

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
                        bridge.post(worker, formatWorkerPost(`propose_diff ${res.touched ?? ''} → full diff saved to ${res.proposalPath} (review & apply)`));
                    } else if (res.mutated || name === 'propose_diff') {
                        bridge.post(worker, formatWorkerPost(`${name} ${res.touched ?? ''}: ${res.result}`));
                    }
                    if (res.mutated && res.touched && !claimed.has(res.touched)) {
                        claimed.add(res.touched);
                        try { bridge.claim(worker, [res.touched], 60, `worker auto-claim ${subagentId.slice(0, 10)}`); } catch { /* advisory — ignore conflicts */ }
                    }
                },
            });
            bridge.post(worker, formatWorkerPost(`${wake}done [${subagentId.slice(0, 10)}] (${result.steps} steps, ${result.toolCalls} tools${usageSuffix(result)}): ${result.finalText}`));
            return result;
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            bridge.post(worker, formatWorkerPost(`${wake}error [${subagentId.slice(0, 10)}]: ${error}`));
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
            // Worker-numbering discipline: mark this run finished so activeWorkerRuns
            // can drain to zero and the next batch restarts at worker-1. Lives in
            // runWork's finally so it fires when the work actually completes — for
            // async that's in the background, not when the dispatch call returns.
            finishWorkerRun();
        }
    };

    // Async — return a ticket immediately; the worker runs in the background and
    // wakes the dispatcher via its @mentioned done post.
    if (mode === 'async') {
        void runWork(true).catch(() => { /* error already posted to the board */ });
        return `SUBAGENT ${subagentId} (${model}, ${autonomy}) DISPATCHED (async). It is working in the background and will post progress as ${worker}, then notify ${dispatcher} on the board when done. [${checkpoint}]`;
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
