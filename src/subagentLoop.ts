import { spawnSync } from 'child_process';
import { Bridge } from './bridge';
import {
    chatCompletionRaw, dispatchSubagentTier1, resolveModel, ResolvedModel,
    SubagentBackends, SubagentToolMode, workerAgentName,
} from './subagent';
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
    signal?: AbortSignal;
}

export interface WorkerLoopResult {
    finalText: string;
    steps: number;
    toolCalls: number;
    aborted?: string;
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
    for (let step = 0; step < maxSteps; step++) {
        const abort = opts.shouldAbort?.();
        if (abort) {
            return { finalText: `Aborted: ${abort}`, steps: step, toolCalls, aborted: abort };
        }

        const res = await chatCompletionRaw(resolved, { messages, tools, tool_choice: 'auto', temperature: 0.2 }, opts.signal) as
            { choices?: Array<{ message?: OpenAiMessage }> };
        const msg = res.choices?.[0]?.message;
        if (!msg) {
            return { finalText: 'Worker returned no message.', steps: step + 1, toolCalls };
        }

        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
            return { finalText: (msg.content ?? '').trim() || '(worker finished with no summary)', steps: step + 1, toolCalls };
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

    return { finalText: `Reached step limit (${maxSteps}) without finishing.`, steps: maxSteps, toolCalls };
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

    // Tier 1 — reasoning-only completion.
    if (requestedTools === 'none') {
        const r = await dispatchSubagentTier1(bridge, backends, { dispatcher, model, task, context });
        return r.status === 'completed'
            ? `SUBAGENT ${r.subagentId} (${model}) COMPLETED:\n\n${r.result}`
            : `SUBAGENT ${r.subagentId} (${model}) ERROR: ${r.error}`;
    }

    // Tier 2 — agentic worker loop.
    const subagentId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const worker = workerAgentName(model);
    const resolved = resolveModel(model, backends);
    const autonomy: WorkerAutonomy = requestedTools === 'readonly' ? 'draft' : bridge.getAutonomyMode();
    const ctx: WorkerToolContext = { repoRoot: bridge.getRepoRoot(), autonomy };

    const checkpoint = autonomy === 'clanker' ? gitCheckpoint(ctx.repoRoot) : 'draft mode (no writes)';
    bridge.post(worker, `started [${subagentId.slice(0, 10)}] ${mode} ${autonomy} (${resolved.backend}:${resolved.model}): ${task} | ${checkpoint}`.slice(0, 400));

    // The worker run, shared by sync and async. In async mode the done/error post
    // @mentions the dispatcher so the wake-on-@mention rule pulls the supervisor
    // back to evaluate the work; in sync mode the dispatcher already gets the
    // result inline, so we don't mention (and don't double-wake) them.
    const runWork = async (mentionDispatcher: boolean): Promise<WorkerLoopResult> => {
        const wake = mentionDispatcher ? `${dispatcher}: ` : '';
        try {
            const result = await runWorkerLoop(resolved, ctx, task, context, {
                shouldAbort: () => {
                    const blocking = bridge.getBlockingCommands(worker);
                    return blocking.length ? `board STOP/PAUSE (${blocking[0].text})` : null;
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
                },
            });
            bridge.post(worker, `${wake}done [${subagentId.slice(0, 10)}] (${result.steps} steps, ${result.toolCalls} tools): ${result.finalText.replace(/\s+/g, ' ').slice(0, 180)}`.slice(0, 400));
            return result;
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            bridge.post(worker, `${wake}error [${subagentId.slice(0, 10)}]: ${error.replace(/\s+/g, ' ').slice(0, 180)}`.slice(0, 300));
            throw err;
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
            : `SUBAGENT ${subagentId} (${model}, ${autonomy}) COMPLETED (${result.steps} steps, ${result.toolCalls} tool calls):`;
        return `${head}\n\n${result.finalText}\n\n[${checkpoint}]`;
    } catch (err) {
        return `SUBAGENT ${subagentId} (${model}) ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
}
