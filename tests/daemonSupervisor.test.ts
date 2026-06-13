import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaHealthz, ensureOllamaDaemon } from '../src/daemonSupervisor';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('ollamaHealthz probes /api/tags at the root (strips /v1) and returns true when up', async () => {
    let probed = '';
    globalThis.fetch = (async (input: string | URL) => {
        probed = String(input);
        return new Response('{}', { status: 200 });
    }) as typeof fetch;
    assert.equal(await ollamaHealthz('http://127.0.0.1:11434/v1'), true);
    assert.equal(probed, 'http://127.0.0.1:11434/api/tags');
});

test('ollamaHealthz returns false (never throws) when the daemon is down', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    assert.equal(await ollamaHealthz('http://127.0.0.1:11434/v1'), false);
});

test('ensureOllamaDaemon disabled: no spawn, returns an actionable down message', async () => {
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
    const r = await ensureOllamaDaemon('http://127.0.0.1:11434/v1', { autoStart: false });
    assert.equal(r.up, false);
    assert.equal(r.started, false);
    assert.match(r.message, /ollamaAutoStart is off/i);
});

test('ensureOllamaDaemon no-ops when ollama is already up', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const r = await ensureOllamaDaemon('http://127.0.0.1:11434/v1', { autoStart: true });
    assert.equal(r.up, true);
    assert.equal(r.started, false);
});

test('ensureOllamaDaemon enabled + still down after start: surfaces a bounded-timeout error', async () => {
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
    // A bogus executable fails to spawn synchronously on some platforms; either way
    // the result must be up:false with a non-empty message and never throw.
    const r = await ensureOllamaDaemon('http://127.0.0.1:11434/v1', {
        autoStart: true,
        executable: 'definitely-not-a-real-binary-xyz',
        startBudgetMs: 1000,
    });
    assert.equal(r.up, false);
    assert.ok(r.message.length > 0);
});
