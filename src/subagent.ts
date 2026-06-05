import { Bridge } from './bridge';

/**
 * Local/cloud model backends a subagent can target. All three speak the
 * OpenAI-compatible `/v1/chat/completions` API (llama.cpp, the continue
 * llamacpp bridge, and Ollama's OpenAI-compat endpoint), so one client covers
 * them. Forge Relay reads Forge's config only for the *model list*; at runtime it
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
    /**
     * Forge model-control API base, e.g. `http://127.0.0.1:8799`. Opt-in: when
     * set, dispatch routes through Forge — it loads the requested model on
     * demand, waits until it is healthy, and hands back its endpoint (killing
     * the `fetch failed` / wrong-model failures of the blind direct route). Unset
     * (default) keeps the existing bridge/ollama/direct routing untouched.
     */
    forgeControlUrl?: string;
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
    /** Plain Forge-exposed model id, or an explicit route override like "bridge:foo". */
    model: string;
    task: string;
    context?: string;
    tools?: SubagentToolMode;
    mode?: SubagentRunMode;
}

export interface ResolvedModel {
    /**
     * Routing/display label. The direct routes use the known literals; the Forge
     * route carries the *real* backend Forge reports for the loaded model (e.g.
     * `llamacpp`, `ollama`), so the board shows what actually served the request.
     */
    backend: 'bridge' | 'ollama' | 'direct' | (string & {});
    model: string;
    baseUrl: string;
    apiKey?: string;
}

export interface CatalogModelEntry {
    name: string;
    canonical: string;
    routeFamily: 'forge-control' | 'forge-bridge' | 'raw-bridge' | 'raw-ollama' | 'raw-direct';
    backend?: string;
    provider?: string;
    loaded?: boolean;
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

function modelName(model: string): string {
    const sep = model.indexOf(':');
    return sep === -1 ? model : model.slice(sep + 1);
}

function modelPrefix(model: string): string | null {
    const sep = model.indexOf(':');
    return sep === -1 ? null : model.slice(0, sep).toLowerCase();
}

/**
 * Decide whether a dispatch should route through Forge's control API, and return
 * the bare Forge model name to pass to `/ensure` (the `forge:` prefix stripped).
 * Rules: an explicit `forge:` prefix always routes via Forge; an explicit
 * `bridge:`/`ollama:`/`direct:` prefix always keeps its existing direct routing
 * (so the Forge route never overrides a deliberate backend choice); anything else
 * (unprefixed, or an unknown prefix) routes via Forge only when `forgeControlUrl`
 * is set. When it is unset, this always returns `viaForge: false`.
 */
export function forgeRoute(model: string, backends: SubagentBackends): { viaForge: boolean; model: string } {
    const sep = model.indexOf(':');
    if (sep !== -1) {
        const prefix = model.slice(0, sep).toLowerCase();
        if (prefix === 'forge') { return { viaForge: true, model: model.slice(sep + 1) }; }
        if (prefix === 'bridge' || prefix === 'ollama' || prefix === 'direct') {
            return { viaForge: false, model };
        }
    }
    return { viaForge: Boolean(backends.forgeControlUrl), model };
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
        // Connection-level failure (refused / reset / DNS / socket hang-up). Tag it
        // so callers can retry it transiently; an HTTP error response (below) is a
        // real answer from the server and must NOT be retried.
        const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
        throw new BackendConnectionError(describeFetchError(err, url, resolved.backend), code);
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

/**
 * A connection-level failure talking to a backend (ECONNRESET / ECONNREFUSED /
 * `fetch failed` / socket hang-up), as opposed to an HTTP error response. These
 * are transient — a still-warming backend or a momentary reset under load — and
 * safe to retry. {@link postChat} throws this only from its connect/transport
 * catch; non-2xx responses stay plain `Error`s and are never retried.
 */
export class BackendConnectionError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = 'BackendConnectionError';
    }
}

/** Default backoff for {@link withConnRetry}: 3 retries (4 attempts total). */
const CONN_RETRY_DELAYS_MS = [250, 1_000, 2_000];

export interface ConnRetryHooks {
    /** Aborts both the in-flight call and any pending backoff sleep. */
    signal?: AbortSignal;
    /** Override the backoff schedule (one entry per retry). */
    delaysMs?: number[];
    /** Called before each retry sleep (e.g. to log the churn to the board). */
    onRetry?: (attempt: number, delayMs: number, err: BackendConnectionError) => void;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abortErr = (): Error => { const e = new Error('Aborted'); e.name = 'AbortError'; return e; };
        if (signal?.aborted) { reject(abortErr()); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortErr()); }, { once: true });
    });
}

/**
 * Run a backend call, retrying ONLY connection-level failures
 * ({@link BackendConnectionError}) with short exponential backoff
 * (250ms → 1s → 2s by default). HTTP 4xx/5xx responses and aborts surface
 * immediately. Keeps a single transient `ECONNRESET` (e.g. dispatching against a
 * still-warming backend) from killing a whole worker (Fix B).
 */
export async function withConnRetry<T>(doCall: () => Promise<T>, hooks: ConnRetryHooks = {}): Promise<T> {
    const delays = hooks.delaysMs ?? CONN_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            return await doCall();
        } catch (err) {
            if (!(err instanceof BackendConnectionError) || attempt >= delays.length) {
                throw err;
            }
            const ms = delays[attempt];
            hooks.onRetry?.(attempt + 1, ms, err);
            await sleepAbortable(ms, hooks.signal);
        }
    }
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

function canonicalForSource(source: 'forge-control' | 'forge-bridge' | 'bridge' | 'ollama' | 'direct', name: string): string {
    switch (source) {
        case 'forge-control': return `forge:${name}`;
        case 'forge-bridge': return `bridge:${name}`;
        case 'ollama': return `ollama:${name}`;
        case 'direct': return `direct:${name}`;
        default: return `bridge:${name}`;
    }
}

function routeFamilyForSource(source: 'forge-control' | 'forge-bridge' | 'bridge' | 'ollama' | 'direct'): CatalogModelEntry['routeFamily'] {
    switch (source) {
        case 'forge-control': return 'forge-control';
        case 'forge-bridge': return 'forge-bridge';
        case 'ollama': return 'raw-ollama';
        case 'direct': return 'raw-direct';
        default: return 'raw-bridge';
    }
}

function uniqueEntries(entries: CatalogModelEntry[]): CatalogModelEntry[] {
    const seen = new Set<string>();
    return entries.filter((entry) => {
        const key = `${entry.canonical}::${entry.provider ?? ''}::${entry.backend ?? ''}`;
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

/** GET a backend's /models and return catalog entries from either OpenAI or Forge shape. */
async function fetchModelCatalog(
    baseUrl: string,
    backend: 'forge-control' | 'forge-bridge' | 'bridge' | 'ollama' | 'direct',
    apiKey?: string,
): Promise<CatalogModelEntry[]> {
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
    const data = await res.json().catch(() => ({})) as {
        data?: Array<{ id?: string; provider?: string; owned_by?: string; backend?: string }>;
        models?: Array<{ name?: string; provider?: string; backend?: string; loaded?: boolean }>;
    };
    const forgeModels = (data.models ?? [])
        .filter((m): m is { name: string; provider?: string; backend?: string; loaded?: boolean } => typeof m.name === 'string' && m.name.length > 0)
        .map((m) => ({
            name: m.name,
            canonical: canonicalForSource(backend, m.name),
            routeFamily: routeFamilyForSource(backend),
            backend: m.backend,
            provider: m.provider,
            loaded: m.loaded,
        }));
    if (forgeModels.length) { return uniqueEntries(forgeModels); }

    const openAiModels = (data.data ?? [])
        .filter((m): m is { id: string; provider?: string; owned_by?: string; backend?: string } => typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({
            name: m.id,
            canonical: canonicalForSource(backend, m.id),
            routeFamily: routeFamilyForSource(backend),
            backend: m.backend,
            provider: m.provider ?? m.owned_by,
        }));
    return uniqueEntries(openAiModels);
}

/** GET a backend's /models and return the served model ids (OpenAI or Ollama shape). */
async function fetchModels(baseUrl: string, backend: string, apiKey?: string): Promise<string[]> {
    return (await fetchModelCatalog(baseUrl, backend as 'forge-control' | 'forge-bridge' | 'bridge' | 'ollama' | 'direct', apiKey)).map(m => m.name);
}

export interface BackendModels {
    backend: 'bridge' | 'ollama' | 'direct' | 'forge';
    baseUrl: string;
    ok: boolean;
    models?: string[];
    error?: string;
}

export interface ForgeCatalogProbe {
    backend: 'forge-control' | 'forge-bridge';
    baseUrl: string;
    ok: boolean;
    models?: CatalogModelEntry[];
    error?: string;
}

/**
 * Probe the backends' /models in parallel for the list_models tool. When
 * `forgeControlUrl` is set it is added (and listed first) as the preferred source
 * of truth for worker model names — Forge's `GET /models` shares the
 * `{ models: [{ name }] }` shape that {@link fetchModels} already understands.
 */
export async function listModels(backends: SubagentBackends): Promise<BackendModels[]> {
    const targets: Array<{ backend: BackendModels['backend']; baseUrl: string; apiKey?: string }> = [
        { backend: 'bridge', baseUrl: backends.bridgeUrl, apiKey: backends.bridgeApiKey },
        { backend: 'ollama', baseUrl: backends.ollamaUrl },
        { backend: 'direct', baseUrl: backends.directUrl },
    ];
    if (backends.forgeControlUrl) {
        targets.unshift({ backend: 'forge', baseUrl: backends.forgeControlUrl });
    }
    return Promise.all(targets.map(async (t): Promise<BackendModels> => {
        try {
            return { backend: t.backend, baseUrl: t.baseUrl, ok: true, models: await fetchModels(t.baseUrl, t.backend, t.apiKey) };
        } catch (err) {
            return { backend: t.backend, baseUrl: t.baseUrl, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }));
}

/** Probe Forge control plus the Forge bridge to build the normal merged catalog. */
export async function fetchForgeCatalog(backends: SubagentBackends): Promise<{ control: ForgeCatalogProbe; bridge: ForgeCatalogProbe }> {
    const controlUrl = backends.forgeControlUrl;
    const control = !controlUrl
        ? { backend: 'forge-control' as const, baseUrl: '', ok: false, error: 'Forge control route is off (forgeRelay.subagentForgeControlUrl is unset).' }
        : await (async (): Promise<ForgeCatalogProbe> => {
            try {
                return {
                    backend: 'forge-control',
                    baseUrl: controlUrl,
                    ok: true,
                    models: await fetchModelCatalog(controlUrl, 'forge-control'),
                };
            } catch (err) {
                return {
                    backend: 'forge-control',
                    baseUrl: controlUrl,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        })();

    const bridge = await (async (): Promise<ForgeCatalogProbe> => {
        try {
            return {
                backend: 'forge-bridge',
                baseUrl: backends.bridgeUrl,
                ok: true,
                models: await fetchModelCatalog(backends.bridgeUrl, 'forge-bridge', backends.bridgeApiKey),
            };
        } catch (err) {
            return {
                backend: 'forge-bridge',
                baseUrl: backends.bridgeUrl,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    })();

    return { control, bridge };
}

export type DispatchRouteDecision =
    | { kind: 'forge-control'; model: string; canonical: string; note?: string }
    | { kind: 'resolved'; resolved: ResolvedModel; canonical: string; note?: string }
    | { kind: 'error'; message: string };

function formatCatalogEntry(entry: CatalogModelEntry): string {
    const meta: string[] = [];
    if (entry.provider) { meta.push(`provider ${entry.provider}`); }
    if (entry.backend) { meta.push(`backend ${entry.backend}`); }
    if (entry.loaded !== undefined) { meta.push(entry.loaded ? 'loaded' : 'not loaded'); }
    return meta.length ? `${entry.canonical} (${meta.join(', ')})` : entry.canonical;
}

export function decideForgeRoute(
    model: string,
    backends: SubagentBackends,
    catalog: { control: ForgeCatalogProbe; bridge: ForgeCatalogProbe },
): DispatchRouteDecision {
    const prefix = modelPrefix(model);
    const name = modelName(model).trim();
    if (!name) { return { kind: 'error', message: 'worker model id is empty.' }; }

    if (prefix === 'bridge' || prefix === 'ollama' || prefix === 'direct') {
        return { kind: 'resolved', resolved: resolveModel(model, backends), canonical: `${prefix}:${name}` };
    }
    if (prefix === 'forge') {
        if (!backends.forgeControlUrl) {
            return { kind: 'error', message: '"forge:" routing requested but no forgeControlUrl is configured (set forgeRelay.subagentForgeControlUrl / FORGERELAY_FORGE_CONTROL_URL).' };
        }
        return { kind: 'forge-control', model: name, canonical: `forge:${name}` };
    }
    if (!backends.forgeControlUrl) {
        return { kind: 'resolved', resolved: resolveModel(model, backends), canonical: `${backends.defaultBackend}:${name}` };
    }

    const controlMatches = (catalog.control.models ?? []).filter(entry => entry.name === name);
    if (controlMatches.length > 0) {
        return { kind: 'forge-control', model: name, canonical: `forge:${name}` };
    }

    const bridgeMatches = uniqueEntries((catalog.bridge.models ?? []).filter(entry => entry.name === name));
    if (bridgeMatches.length === 1) {
        return {
            kind: 'resolved',
            resolved: {
                backend: 'bridge',
                model: name,
                baseUrl: backends.bridgeUrl,
                apiKey: backends.bridgeApiKey,
            },
            canonical: bridgeMatches[0].canonical,
            note: ' (via Forge bridge)',
        };
    }
    if (bridgeMatches.length > 1) {
        const options = bridgeMatches.map(formatCatalogEntry).join('; ');
        return {
            kind: 'error',
            message: `model "${name}" is ambiguous in the Forge bridge catalog. Retry with an explicit target. Valid options: ${options}`,
        };
    }

    const details: string[] = [];
    if (!catalog.control.ok) { details.push(`Forge control catalog unavailable: ${catalog.control.error}`); }
    if (!catalog.bridge.ok) { details.push(`Forge bridge catalog unavailable: ${catalog.bridge.error}`); }
    const suffix = details.length ? ` ${details.join(' | ')}` : ' Run list_models to inspect the Forge-exposed catalog.';
    return { kind: 'error', message: `model "${name}" was not found in the Forge control or Forge bridge catalogs.${suffix}` };
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

// ── Forge model-control client (opt-in route; see docs/forge-control-client.md) ──

/** `/ensure` waits until the model is healthy, so it can block while a load runs. */
const FORGE_ENSURE_TIMEOUT_MS = 180_000;

export interface ForgeEnsureResult {
    /** OpenAI-compatible base that already ends in `/v1`; dispatch to `${baseUrl}/chat/completions`. */
    baseUrl: string;
    model: string;
    backend: string;
}

/** Carries the HTTP status from a failed `/ensure` so callers can map 404/409/502. */
export class ForgeEnsureError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'ForgeEnsureError';
    }
}

function forgeEnsureMessage(status: number, model: string, text: string): string {
    const detail = text ? `: ${text.slice(0, 200)}` : '';
    switch (status) {
        case 404: return `unknown model "${model}" (not in Forge config)`;
        case 409: return `worker model busy — Forge capacity is full and all loaded models are in use; retry later`;
        case 502: return `worker model "${model}" failed to load${detail}`;
        default: return `Forge /ensure HTTP ${status}${detail}`;
    }
}

/**
 * POST `{controlUrl}/ensure { model }` — Forge loads/hot-swaps to the model,
 * waits until it is healthy, and returns the endpoint to dispatch to. Throws a
 * {@link ForgeEnsureError} (carrying the HTTP status) on a non-200 so the caller
 * can post a clear board message. Every successful ensure MUST be paired with a
 * {@link forgeRelease}.
 */
export async function forgeEnsure(controlUrl: string, model: string): Promise<ForgeEnsureResult> {
    const url = `${controlUrl.replace(/\/$/, '')}/ensure`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(FORGE_ENSURE_TIMEOUT_MS),
        });
    } catch (err) {
        throw new ForgeEnsureError(0, describeFetchError(err, url, 'forge'));
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ForgeEnsureError(res.status, forgeEnsureMessage(res.status, model, text));
    }
    const data = await res.json().catch(() => ({})) as Partial<ForgeEnsureResult>;
    if (!data.baseUrl) {
        throw new ForgeEnsureError(502, `Forge /ensure returned no baseUrl for "${model}"`);
    }
    return { baseUrl: data.baseUrl, model: data.model ?? model, backend: data.backend ?? 'forge' };
}

/**
 * POST `{controlUrl}/release { model }` — decrement Forge's hold count for the
 * model. Best-effort and never throws (so it is safe in a `finally`); returns
 * whether Forge confirmed the release.
 */
export async function forgeRelease(controlUrl: string, model: string): Promise<boolean> {
    const url = `${controlUrl.replace(/\/$/, '')}/release`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) { return false; }
        const data = await res.json().catch(() => ({})) as { released?: boolean };
        return data.released === true;
    } catch {
        return false;
    }
}

/** GET `{controlUrl}/healthz` → true when Forge's control API is up. Never throws. */
export async function forgeHealthz(controlUrl: string): Promise<boolean> {
    const url = `${controlUrl.replace(/\/$/, '')}/healthz`;
    try {
        const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) { return false; }
        const data = await res.json().catch(() => ({})) as { ok?: boolean };
        return data.ok === true;
    } catch {
        return false;
    }
}

/** Human-readable model menu for the list_models tool. */
export async function handleListModels(backends: SubagentBackends): Promise<string> {
    if (backends.forgeControlUrl) {
        const { control, bridge } = await fetchForgeCatalog(backends);
        const controlNames = new Set((control.models ?? []).map(m => m.name));
        const bridgeModels = (bridge.models ?? []).filter(m => !controlNames.has(m.name));

        const controlBlock = control.ok
            ? (control.models?.length
                ? control.models
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(m => `  ${m.name} -> ${formatCatalogEntry(m)}`)
                    .join('\n')
                : '  (reachable, but no local Forge control models reported)')
            : `  DOWN: ${control.error}`;
        const bridgeBlock = bridge.ok
            ? (bridgeModels.length
                ? bridgeModels
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(m => `  ${m.name} -> ${formatCatalogEntry(m)}`)
                    .join('\n')
                : '  (reachable, but no Forge bridge-only models reported)')
            : `  DOWN: ${bridge.error}`;

        return [
            'AVAILABLE WORKER MODELS - normal dispatch accepts the plain model name shown below.',
            '',
            'FORGE CONTROL (local GGUF, preferred when a model is local):',
            controlBlock,
            '',
            'FORGE BRIDGE (provider-backed models and any Forge-exposed non-local route):',
            bridgeBlock,
            '',
            'DEBUG OVERRIDES:',
            '  Explicit route prefixes still work: forge:<model>, bridge:<model>, ollama:<model>, direct:<model>.',
            '  Unprefixed ids resolve through the Forge-exposed catalogs first; there is no silent raw fallback.',
        ].join('\n');
    }

    const results = await listModels(backends);
    const blocks = results.map(r => {
        if (!r.ok) { return `${r.backend} @ ${r.baseUrl} — DOWN: ${r.error}`; }
        const list = r.models && r.models.length
            ? r.models.map(m => `  ${r.backend}:${m}`).join('\n')
            : '  (reachable, but no models reported)';
        return `${r.backend} @ ${r.baseUrl} — UP:\n${list}`;
    });
    const forgeNote = backends.forgeControlUrl
        ? `\n\nForge route is ON (${backends.forgeControlUrl}): unprefixed or "forge:<model>" ids load on demand via Forge and dispatch only once the model is warm.`
        : '';
    return `AVAILABLE WORKER MODELS — pass to dispatch_subagent as "<backend>:<model>":\n\n${blocks.join('\n\n')}${forgeNote}`;
}

export const LIST_MODELS_TOOL = {
    name: 'list_models',
    description:
        'List worker models available to Forge Relay. '
        + 'When the Forge route is enabled, this returns a merged Forge-first catalog for normal dispatch by plain model name, plus explicit override forms for debugging. '
        + 'When the Forge route is off, it falls back to the raw backend model menus.',
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

const WORKER_POST_MAX_CHARS = 8 * 1024;
let workerOrdinal = 0;

export function nextWorkerOrdinal(): number {
    workerOrdinal += 1;
    return workerOrdinal;
}

function workerAgentName(model: string, ordinal?: number): string {
    // Keep it board-friendly: worker-N:<model-without-backend-prefix>
    const bare = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
    const prefix = ordinal ? `worker-${ordinal}:` : 'worker:';
    return `${prefix}${bare}`.slice(0, 60);
}

export function formatWorkerPost(text: string): string {
    return oneLine(text).slice(0, WORKER_POST_MAX_CHARS);
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
    resolvedOverride?: ResolvedModel,
): Promise<DispatchResult> {
    const subagentId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const worker = workerAgentName(opts.model, nextWorkerOrdinal());
    const resolved = resolvedOverride ?? resolveModel(opts.model, backends);

    bridge.post(worker, formatWorkerPost(`started [${subagentId.slice(0, 10)}] (${resolved.backend}:${resolved.model}): ${opts.task}`));

    const messages: ChatMessage[] = [
        { role: 'system', content: TIER1_SYSTEM_PROMPT },
        { role: 'user', content: opts.context ? `${opts.task}\n\nContext:\n${opts.context}` : opts.task },
    ];

    try {
        const result = await chatCompletion(resolved, messages);
        bridge.post(worker, formatWorkerPost(`done [${subagentId.slice(0, 10)}]: ${result}`));
        return { subagentId, status: 'completed', result };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        bridge.post(worker, formatWorkerPost(`error [${subagentId.slice(0, 10)}]: ${error}`));
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
        + 'Returns the worker result and posts its lifecycle to the Forge Relay board as worker:<model>. '
        + 'Pass a plain Forge-exposed model name for normal routing, or an explicit override such as "forge:<model>", "bridge:<model>", "ollama:<model>", or "direct:<model>" for debugging. '
        + 'When the Forge route is enabled, unprefixed ids resolve through the Forge-exposed catalogs first: local models go through Forge control and provider-backed models go through the Forge bridge. '
        + 'tools: "none" = reasoning-only single completion; "readonly" = read/search + propose_diff (no writes); "full" = read/write/edit/run, bounded by the destructive-command denylist and the board autonomy mode.',
    inputSchema: {
        type: 'object',
        properties: {
            agent: { type: 'string', description: 'Your agent identity dispatching the worker (claude, codex).' },
            model: { type: 'string', description: 'Worker model id. Prefer a plain Forge-exposed name; raw prefixes are explicit overrides.' },
            task: { type: 'string', description: 'The self-contained instruction for the worker.' },
            context: { type: 'string', description: 'Optional inline context for the worker.' },
            tools: { type: 'string', enum: ['none', 'readonly', 'full'], description: 'Worker capability tier: none=reasoning only; readonly=read+propose_diff; full=read/write/edit/run.' },
            mode: { type: 'string', enum: ['sync', 'async'], description: 'sync blocks until done and returns the result inline (use for quick tasks). async returns immediately and the worker runs in the background, posting progress to the board and @mentioning you when finished so you can review (use for long build tasks).' },
        },
        required: ['agent', 'model', 'task'],
    },
} as const;

export { workerAgentName };
