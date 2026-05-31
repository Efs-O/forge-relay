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

/**
 * Turn an opaque fetch failure into something a human can act on. Node's global
 * fetch throws a bare `TypeError: fetch failed` on connection refused / DNS /
 * timeout, which (during testing) cost a port probe to realise the model server
 * was simply down or mid-swap. We surface the endpoint and a hint instead.
 */
function describeFetchError(err: unknown, url: string, backend: string): string {
    const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
    const code = cause?.code;
    const base = `could not reach ${backend} backend at ${url} — is the model server running?`;
    const hint =
        code === 'ECONNREFUSED' ? 'connection refused'
        : code === 'ENOTFOUND' ? 'host not found'
        : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connection timed out'
        : code ? code
        : (err instanceof Error ? err.message : String(err));
    return `${base} (${hint})`;
}

/** Shared POST to the resolved backend's /chat/completions, with clear errors. */
async function postChat(
    resolved: ResolvedModel,
    body: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<unknown> {
    const url = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`;
    }

    let res: Response;
    try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') { throw err; }
        throw new Error(describeFetchError(err, url, resolved.backend));
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${resolved.backend} backend HTTP ${res.status} at ${url}: ${text.slice(0, 300)}`);
    }
    return res.json();
}

/** POST an OpenAI-compatible chat completion and return the assistant text. */
export async function chatCompletion(
    resolved: ResolvedModel,
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
    const data = await postChat(resolved, {
        model: resolved.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
        stream: false,
    }, opts.signal) as { choices?: Array<{ message?: { content?: string } }> };
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
    return postChat(resolved, { model: resolved.model, stream: false, ...payload }, signal);
}

// ── Model discovery + endpoint validation (list_models tool + pre-dispatch check) ─

const PROBE_TIMEOUT_MS = 4_000;

/** GET a backend's /models and return the served model ids (OpenAI or Ollama shape). */
async function fetchModels(baseUrl: string, backend: string, apiKey?: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) { headers['Authorization'] = `Bearer ${apiKey}`; }

    let res: Response;
    try {
        res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (err) {
        throw new Error(describeFetchError(err, url, backend));
    }
    if (!res.ok) {
        throw new Error(`${backend} backend HTTP ${res.status} at ${url}`);
    }
    const data = await res.json().catch(() => ({})) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    const ids = (data.data ?? []).map(m => m.id).filter((x): x is string => Boolean(x));
    if (ids.length) { return ids; }
    return (data.models ?? []).map(m => m.name).filter((x): x is string => Boolean(x));
}

export interface BackendModels {
    backend: 'bridge' | 'ollama' | 'direct';
    baseUrl: string;
    ok: boolean;
    models?: string[];
    error?: string;
}

/** Probe all three backends' /models in parallel for the list_models tool. */
export async function listModels(backends: SubagentBackends): Promise<BackendModels[]> {
    const targets: Array<{ backend: BackendModels['backend']; baseUrl: string; apiKey?: string }> = [
        { backend: 'bridge', baseUrl: backends.bridgeUrl, apiKey: backends.bridgeApiKey },
        { backend: 'ollama', baseUrl: backends.ollamaUrl },
        { backend: 'direct', baseUrl: backends.directUrl },
    ];
    return Promise.all(targets.map(async (t): Promise<BackendModels> => {
        try {
            return { backend: t.backend, baseUrl: t.baseUrl, ok: true, models: await fetchModels(t.baseUrl, t.backend, t.apiKey) };
        } catch (err) {
            return { backend: t.backend, baseUrl: t.baseUrl, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }));
}

/** Check whether the resolved backend is reachable (connection-level) before dispatch. */
export async function validateBackend(resolved: ResolvedModel): Promise<{ reachable: boolean; message: string; models?: string[] }> {
    try {
        const models = await fetchModels(resolved.baseUrl, resolved.backend, resolved.apiKey);
        return { reachable: true, message: '', models };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "could not reach …" is a connection-level failure (server down) → not
        // reachable. An HTTP error means something IS listening (e.g. /models
        // unsupported) → treat as reachable and let the dispatch proceed.
        return { reachable: !msg.startsWith('could not reach'), message: msg };
    }
}

/** A short advisory note about model routing, given what the backend actually serves. */
export function modelRoutingNote(resolved: ResolvedModel, served?: string[]): string {
    if (!served || served.length === 0) { return ''; }
    if (resolved.backend === 'direct') {
        return ` (note: direct backend serves "${served[0]}" and ignores the requested model id)`;
    }
    if (!served.includes(resolved.model)) {
        return ` (warning: "${resolved.model}" not in ${resolved.backend} model list: ${served.slice(0, 6).join(', ')})`;
    }
    return '';
}

/** Human-readable model menu for the list_models tool. */
export async function handleListModels(backends: SubagentBackends): Promise<string> {
    const results = await listModels(backends);
    const blocks = results.map(r => {
        if (!r.ok) { return `${r.backend} @ ${r.baseUrl} — DOWN: ${r.error}`; }
        const list = r.models && r.models.length
            ? r.models.map(m => `  ${r.backend}:${m}`).join('\n')
            : '  (reachable, but no models reported)';
        return `${r.backend} @ ${r.baseUrl} — UP:\n${list}`;
    });
    return `AVAILABLE WORKER MODELS — pass to dispatch_subagent as "<backend>:<model>":\n\n${blocks.join('\n\n')}`;
}

export const LIST_MODELS_TOOL = {
    name: 'list_models',
    description:
        'List worker models available across the local backends (bridge :9099, ollama :11434, direct llama-server :8080). '
        + 'Use it to discover what you can pass to dispatch_subagent (as "<backend>:<model>") and to route multi-model jobs. '
        + 'Backends that are down are reported so you can pick a live one.',
    inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string', description: 'Your agent identity.' } },
    },
} as const;

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
        + 'model may be backend-prefixed: "ollama:qwen2.5-coder", "bridge:gemma", "direct:foo" (use list_models to discover what is available). '
        + 'tools: "none" = reasoning-only single completion; "readonly" = read/search + propose_diff (no writes); "full" = read/write/edit/run, bounded by the destructive-command denylist and the board autonomy mode.',
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
