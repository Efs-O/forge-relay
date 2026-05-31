import { Bridge } from './bridge';

/**
 * Local/cloud model backends a subagent can target. All three speak the
 * OpenAI-compatible `/v1/chat/completions` API (llama.cpp, the continue
 * llamacpp bridge, and Ollama's OpenAI-compat endpoint), so one client covers
 * them. AgentWatch reads Forge's config only for the *model list*; at runtime it
 * just needs one of these endpoints up (Decision #4, decoupled).
 */
export interface SubagentBackends {
    /** continue-llamacpp-bridge, OpenAI-compatible, API-keyed (default target). */
    bridgeUrl: string;   // e.g. http://127.0.0.1:9099/v1
    /** Ollama native daemon, OpenAI-compat surface. */
    ollamaUrl: string;   // e.g. http://127.0.0.1:11434/v1
    /** llama.cpp llama-server direct. */
    directUrl: string;   // e.g. http://127.0.0.1:8080/v1
    bridgeApiKey?: string;
    defaultBackend: 'bridge' | 'ollama' | 'direct';
}

export const DEFAULT_SUBAGENT_BACKENDS: SubagentBackends = {
    bridgeUrl: 'http://127.0.0.1:9099/v1',
    ollamaUrl: 'http://127.0.0.1:11434/v1',
    directUrl: 'http://127.0.0.1:8080/v1',
    defaultBackend: 'bridge',
};

export type SubagentToolMode = 'none' | 'readonly' | 'full';
export type SubagentRunMode = 'sync' | 'async';

export interface DispatchOptions {
    /** The orchestrator dispatching the worker (claude/codex). */
    dispatcher: string;
    /** Model id, optionally backend-prefixed: "ollama:qwen2.5-coder", "bridge:gemma", "direct:foo". */
    model: string;
    task: string;
    context?: string;
    tools?: SubagentToolMode;
    mode?: SubagentRunMode;
}

export interface ResolvedModel {
    backend: 'bridge' | 'ollama' | 'direct';
    model: string;
    baseUrl: string;
    apiKey?: string;
}

/** Resolve a (possibly prefixed) model id to a concrete backend + endpoint. */
export function resolveModel(model: string, backends: SubagentBackends): ResolvedModel {
    const sep = model.indexOf(':');
    let backend = backends.defaultBackend;
    let name = model;
    if (sep !== -1) {
        const prefix = model.slice(0, sep).toLowerCase();
        if (prefix === 'bridge' || prefix === 'ollama' || prefix === 'direct') {
            backend = prefix;
            name = model.slice(sep + 1);
        }
    }
    const baseUrl = backend === 'ollama' ? backends.ollamaUrl
        : backend === 'direct' ? backends.directUrl
        : backends.bridgeUrl;
    return {
        backend,
        model: name,
        baseUrl,
        apiKey: backend === 'bridge' ? backends.bridgeApiKey : undefined,
    };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** POST an OpenAI-compatible chat completion and return the assistant text. */
export async function chatCompletion(
    resolved: ResolvedModel,
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
    const url = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`;
    }
    const body = JSON.stringify({
        model: resolved.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
        stream: false,
    });

    const res = await fetch(url, { method: 'POST', headers, body, signal: opts.signal });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${resolved.backend} backend HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        throw new Error(`${resolved.backend} backend returned no message content`);
    }
    return content.trim();
}

/** Low-level OpenAI-compatible chat call returning the raw parsed response (for tool-calling loops). */
export async function chatCompletionRaw(
    resolved: ResolvedModel,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<unknown> {
    const url = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: resolved.model, stream: false, ...payload }),
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${resolved.backend} backend HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
}

const TIER1_SYSTEM_PROMPT = [
    'You are a focused worker subagent dispatched by an orchestrator on a shared coding board.',
    'Complete the single task you are given and return a concise, self-contained result.',
    'You have no file or tool access in this mode — reason from the task and any provided context only.',
].join(' ');

function workerAgentName(model: string): string {
    // Keep it board-friendly: worker:<model-without-backend-prefix>
    const bare = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
    return `worker:${bare}`.slice(0, 60);
}

export interface DispatchResult {
    subagentId: string;
    status: 'completed' | 'error' | 'dispatched';
    result?: string;
    error?: string;
}

/**
 * Tier 1 dispatch: a single OpenAI-compatible completion (no tools). The worker's
 * lifecycle is posted to the board as `worker:<model>` so it shows up in the
 * sidebar exactly like Claude/Codex. Tier 2 (read/write/edit/run) lands in P6.
 */
export async function dispatchSubagentTier1(
    bridge: Bridge,
    backends: SubagentBackends,
    opts: DispatchOptions,
): Promise<DispatchResult> {
    const subagentId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const worker = workerAgentName(opts.model);
    const resolved = resolveModel(opts.model, backends);

    bridge.post(worker, `started [${subagentId.slice(0, 10)}] (${resolved.backend}:${resolved.model}): ${opts.task}`.slice(0, 300));

    const messages: ChatMessage[] = [
        { role: 'system', content: TIER1_SYSTEM_PROMPT },
        { role: 'user', content: opts.context ? `${opts.task}\n\nContext:\n${opts.context}` : opts.task },
    ];

    try {
        const result = await chatCompletion(resolved, messages);
        bridge.post(worker, `done [${subagentId.slice(0, 10)}]: ${oneLine(result)}`.slice(0, 300));
        return { subagentId, status: 'completed', result };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        bridge.post(worker, `error [${subagentId.slice(0, 10)}]: ${oneLine(error)}`.slice(0, 300));
        return { subagentId, status: 'error', error };
    }
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

// ── Shared MCP tool surface (used by both mcpServer.ts and mcpStdio.ts) ──────────

export const DISPATCH_SUBAGENT_TOOL = {
    name: 'dispatch_subagent',
    description:
        'Delegate a self-contained task to a local model worker (Forge/Ollama/llama.cpp), like a Task subagent. '
        + 'Returns the worker result and posts its lifecycle to the AgentWatch board as worker:<model>. '
        + 'model may be backend-prefixed: "ollama:qwen2.5-coder", "bridge:gemma", "direct:foo". '
        + 'tools: "none" = reasoning-only single completion (available now); "readonly"/"full" = tool-using worker (arriving in a later update).',
    inputSchema: {
        type: 'object',
        properties: {
            agent: { type: 'string', description: 'Your agent identity dispatching the worker (claude, codex).' },
            model: { type: 'string', description: 'Worker model id, optionally backend-prefixed.' },
            task: { type: 'string', description: 'The self-contained instruction for the worker.' },
            context: { type: 'string', description: 'Optional inline context for the worker.' },
            tools: { type: 'string', enum: ['none', 'readonly', 'full'], description: 'Worker capability tier: none=reasoning only; readonly=read+propose_diff; full=read/write/edit/run.' },
            mode: { type: 'string', enum: ['sync', 'async'], description: 'sync blocks until done and returns the result inline (use for quick tasks). async returns immediately and the worker runs in the background, posting progress to the board and @mentioning you when finished so you can review (use for long build tasks).' },
        },
        required: ['agent', 'model', 'task'],
    },
} as const;

export { workerAgentName };
