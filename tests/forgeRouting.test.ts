import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decideForgeRoute,
    handleListModels,
    ForgeCatalogProbe,
    SubagentBackends,
} from '../src/subagent';

const BACKENDS: SubagentBackends = {
    bridgeUrl: 'http://127.0.0.1:9099/v1',
    ollamaUrl: 'http://127.0.0.1:11434/v1',
    directUrl: 'http://127.0.0.1:8080/v1',
    bridgeApiKey: 'k',
    defaultBackend: 'bridge',
    forgeControlUrl: 'http://127.0.0.1:8799',
};

const CATALOG: { control: ForgeCatalogProbe; bridge: ForgeCatalogProbe } = {
    control: {
        backend: 'forge-control',
        baseUrl: BACKENDS.forgeControlUrl!,
        ok: true,
        models: [
            { name: 'gemma-local', canonical: 'forge:gemma-local', routeFamily: 'forge-control', backend: 'llamacpp', loaded: true },
            // Ollama-style colon-tagged id: the colon is part of the NAME, not a route prefix.
            { name: 'gemma4:31b-cloud', canonical: 'forge:gemma4:31b-cloud', routeFamily: 'forge-control', backend: 'ollama', loaded: false },
        ],
    },
    bridge: {
        backend: 'forge-bridge',
        baseUrl: BACKENDS.bridgeUrl,
        ok: true,
        models: [
            { name: 'grok-3-mini', canonical: 'bridge:grok-3-mini', routeFamily: 'forge-bridge', provider: 'xai' },
        ],
    },
};

const AMBIGUOUS_CATALOG: { control: ForgeCatalogProbe; bridge: ForgeCatalogProbe } = {
    control: CATALOG.control,
    bridge: {
        ...CATALOG.bridge,
        models: [
            { name: 'gemma-local', canonical: 'bridge:gemma-local', routeFamily: 'forge-bridge', provider: 'forge-local', backend: 'llamacpp' },
            ...(CATALOG.bridge.models ?? []),
        ],
    },
};

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

test('decideForgeRoute sends local bare ids to Forge control', () => {
    const route = decideForgeRoute('gemma-local', BACKENDS, CATALOG);
    assert.equal(route.kind, 'forge-control');
    if (route.kind !== 'forge-control') { return; }
    assert.equal(route.model, 'gemma-local');
    assert.equal(route.canonical, 'forge:gemma-local');
});

test('decideForgeRoute sends provider bare ids to the Forge bridge', () => {
    const route = decideForgeRoute('grok-3-mini', BACKENDS, CATALOG);
    assert.equal(route.kind, 'resolved');
    if (route.kind !== 'resolved') { return; }
    assert.equal(route.resolved.backend, 'bridge');
    assert.equal(route.resolved.baseUrl, BACKENDS.bridgeUrl);
    assert.equal(route.canonical, 'bridge:grok-3-mini');
    assert.equal(route.note, ' (via Forge bridge)');
});

test('decideForgeRoute fails clearly when a bare id is ambiguous across Forge control and bridge', () => {
    const route = decideForgeRoute('gemma-local', BACKENDS, AMBIGUOUS_CATALOG);
    assert.equal(route.kind, 'error');
    if (route.kind !== 'error') { return; }
    assert.match(route.message, /ambiguous across the Forge-exposed catalog/i);
    assert.match(route.message, /forge:gemma-local/i);
    assert.match(route.message, /bridge:gemma-local/i);
});

test('decideForgeRoute keeps explicit raw prefixes as overrides', () => {
    const route = decideForgeRoute('direct:anything', BACKENDS, CATALOG);
    assert.equal(route.kind, 'resolved');
    if (route.kind !== 'resolved') { return; }
    assert.equal(route.resolved.backend, 'direct');
    assert.equal(route.resolved.baseUrl, BACKENDS.directUrl);
    assert.equal(route.resolved.model, 'anything');
});

test('decideForgeRoute keeps colons inside unprefixed Ollama-style ids (no first-colon split)', () => {
    const route = decideForgeRoute('gemma4:31b-cloud', BACKENDS, CATALOG);
    assert.equal(route.kind, 'forge-control');
    if (route.kind !== 'forge-control') { return; }
    assert.equal(route.model, 'gemma4:31b-cloud');
    assert.equal(route.canonical, 'forge:gemma4:31b-cloud');
});

test('decideForgeRoute strips an explicit forge: prefix but keeps the colon-tagged remainder intact', () => {
    const route = decideForgeRoute('forge:gemma4:31b-cloud', BACKENDS, CATALOG);
    assert.equal(route.kind, 'forge-control');
    if (route.kind !== 'forge-control') { return; }
    assert.equal(route.model, 'gemma4:31b-cloud');
    assert.equal(route.canonical, 'forge:gemma4:31b-cloud');
});

test('decideForgeRoute routes ollama:-prefixed colon-tagged ids to the ollama backend with the full name', () => {
    const route = decideForgeRoute('ollama:gemma4:31b-cloud', BACKENDS, CATALOG);
    assert.equal(route.kind, 'resolved');
    if (route.kind !== 'resolved') { return; }
    assert.equal(route.resolved.backend, 'ollama');
    assert.equal(route.resolved.baseUrl, BACKENDS.ollamaUrl);
    assert.equal(route.resolved.model, 'gemma4:31b-cloud');
});

test('decideForgeRoute sends a servable:false (cloud) control match to the Forge /chat proxy', () => {
    const cloudCatalog: { control: ForgeCatalogProbe; bridge: ForgeCatalogProbe } = {
        control: {
            backend: 'forge-control',
            baseUrl: BACKENDS.forgeControlUrl!,
            ok: true,
            models: [
                { name: 'grok-4', canonical: 'forge:grok-4', routeFamily: 'forge-control', backend: 'xai', servable: false },
            ],
        },
        bridge: { backend: 'forge-bridge', baseUrl: BACKENDS.bridgeUrl, ok: true, models: [] },
    };
    const route = decideForgeRoute('grok-4', BACKENDS, cloudCatalog);
    assert.equal(route.kind, 'resolved');
    if (route.kind !== 'resolved') { return; }
    assert.equal(route.resolved.backend, 'forge-chat');
    assert.equal(route.resolved.baseUrl, BACKENDS.forgeControlUrl);
    assert.equal(route.resolved.model, 'grok-4');
    assert.equal(route.canonical, 'forge:grok-4');
});

test('decideForgeRoute keeps a servable:true control match on the local /ensure route', () => {
    const localCatalog: { control: ForgeCatalogProbe; bridge: ForgeCatalogProbe } = {
        control: {
            backend: 'forge-control',
            baseUrl: BACKENDS.forgeControlUrl!,
            ok: true,
            models: [
                { name: 'gemma-local', canonical: 'forge:gemma-local', routeFamily: 'forge-control', backend: 'llamacpp', servable: true },
            ],
        },
        bridge: { backend: 'forge-bridge', baseUrl: BACKENDS.bridgeUrl, ok: true, models: [] },
    };
    const route = decideForgeRoute('gemma-local', BACKENDS, localCatalog);
    assert.equal(route.kind, 'forge-control');
});

test('decideForgeRoute fails clearly when a bare id is missing from Forge catalogs', () => {
    const route = decideForgeRoute('missing-model', BACKENDS, CATALOG);
    assert.equal(route.kind, 'error');
    if (route.kind !== 'error') { return; }
    assert.match(route.message, /not found in the Forge control or Forge bridge catalogs/i);
});

test('handleListModels returns a merged Forge-first view and flags ambiguous names explicitly', async () => {
    globalThis.fetch = (async (input: string | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8799/models') {
            return new Response(JSON.stringify({
                models: [
                    { name: 'gemma-local', backend: 'llamacpp', loaded: true },
                ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url === 'http://127.0.0.1:9099/v1/models') {
            return new Response(JSON.stringify({
                data: [
                    { id: 'gemma-local', owned_by: 'forge-local' },
                    { id: 'grok-3-mini', owned_by: 'xai' },
                ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const text = await handleListModels(BACKENDS);
    assert.match(text, /AVAILABLE WORKER MODELS - normal dispatch accepts the plain model name/i);
    assert.match(text, /MERGED FORGE-FIRST CATALOG/i);
    assert.match(text, /gemma-local -> AMBIGUOUS:/i);
    assert.match(text, /forge:gemma-local/i);
    assert.match(text, /bridge:gemma-local/i);
    assert.match(text, /grok-3-mini -> bridge:grok-3-mini/i);
    assert.match(text, /SOURCE STATUS:/i);
});
