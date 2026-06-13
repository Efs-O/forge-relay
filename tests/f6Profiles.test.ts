import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideForgeRoute, splitProfile, ForgeCatalogProbe, SubagentBackends } from '../src/subagent';

const BACKENDS: SubagentBackends = {
    bridgeUrl: 'http://127.0.0.1:9099/v1',
    ollamaUrl: 'http://127.0.0.1:11434/v1',
    directUrl: 'http://127.0.0.1:8080/v1',
    defaultBackend: 'bridge',
    forgeControlUrl: 'http://127.0.0.1:8799',
};

const CATALOG: { control: ForgeCatalogProbe; bridge: ForgeCatalogProbe } = {
    control: {
        backend: 'forge-control',
        baseUrl: BACKENDS.forgeControlUrl!,
        ok: true,
        models: [
            { name: 'gemma-local', canonical: 'forge:gemma-local', routeFamily: 'forge-control', backend: 'llamacpp', servable: true },
            { name: 'gemma4:31b-cloud', canonical: 'forge:gemma4:31b-cloud', routeFamily: 'forge-control', backend: 'ollama', servable: true },
            { name: 'grok-4', canonical: 'forge:grok-4', routeFamily: 'forge-control', backend: 'xai', servable: false },
        ],
    },
    bridge: { backend: 'forge-bridge', baseUrl: BACKENDS.bridgeUrl, ok: true, models: [] },
};

// ── splitProfile ────────────────────────────────────────────────────────────

test('splitProfile: bare name has no profile', () => {
    assert.deepEqual(splitProfile('gemma-local'), { base: 'gemma-local' });
});

test('splitProfile: trailing @worker is split off', () => {
    assert.deepEqual(splitProfile('gemma-local@worker'), { base: 'gemma-local', profile: 'worker' });
});

test('splitProfile: colon-tagged ollama id keeps its colon', () => {
    assert.deepEqual(splitProfile('gemma4:31b-cloud@worker'), { base: 'gemma4:31b-cloud', profile: 'worker' });
});

test('splitProfile: leading @ is not a valid split', () => {
    assert.deepEqual(splitProfile('@worker'), { base: '@worker' });
});

// ── decideForgeRoute matches on base, carries the @profile ───────────────────

test('decideForgeRoute matches the base of a model@profile and carries the pair to /ensure', () => {
    const route = decideForgeRoute('gemma-local@worker', BACKENDS, CATALOG);
    assert.equal(route.kind, 'forge-control');
    if (route.kind !== 'forge-control') { return; }
    assert.equal(route.model, 'gemma-local@worker');
    assert.equal(route.canonical, 'forge:gemma-local@worker');
});

test('decideForgeRoute carries @profile through forge: prefix + colon id', () => {
    const route = decideForgeRoute('forge:gemma4:31b-cloud@main', BACKENDS, CATALOG);
    assert.equal(route.kind, 'forge-control');
    if (route.kind !== 'forge-control') { return; }
    assert.equal(route.model, 'gemma4:31b-cloud@main');
    assert.equal(route.canonical, 'forge:gemma4:31b-cloud@main');
});

test('decideForgeRoute routes a servable:false base@profile to Forge /chat with the pair', () => {
    const route = decideForgeRoute('grok-4@worker', BACKENDS, CATALOG);
    assert.equal(route.kind, 'resolved');
    if (route.kind !== 'resolved') { return; }
    assert.equal(route.resolved.backend, 'forge-chat');
    assert.equal(route.resolved.model, 'grok-4@worker');
    assert.equal(route.canonical, 'forge:grok-4@worker');
});

test('decideForgeRoute strips the profile for raw backend prefixes', () => {
    const route = decideForgeRoute('ollama:gemma4:31b-cloud@worker', BACKENDS, CATALOG);
    assert.equal(route.kind, 'resolved');
    if (route.kind !== 'resolved') { return; }
    assert.equal(route.resolved.backend, 'ollama');
    assert.equal(route.resolved.model, 'gemma4:31b-cloud'); // profile dropped for raw routes
});

test('decideForgeRoute reports the base when a model@profile base is unknown', () => {
    const route = decideForgeRoute('missing@worker', BACKENDS, CATALOG);
    assert.equal(route.kind, 'error');
    if (route.kind !== 'error') { return; }
    assert.match(route.message, /"missing" was not found/i);
});
