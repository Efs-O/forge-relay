import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bridge } from '../src/bridge';
import { parseCodexModelHeader, codexDefaultModel } from '../src/codexWorker';

function tempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-bridge-test-'));
}

// ── command id prefix matching ───────────────────────────────────────────────

test('resolve accepts the exact id, a unique prefix, and records the full id', () => {
    const repo = tempRepo();
    const bridge = new Bridge(repo);
    const id = bridge.postCommand('user', 'STOP - test halt', 'all');

    // The board UI shows a truncated id; resolving by prefix must work.
    bridge.resolve('claude', id.slice(0, 8), 'resolved by prefix');

    const events = fs.readFileSync(path.join(repo, '.coordination', 'events.ndjson'), 'utf8');
    const resolveEvent = events.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'resolve');
    assert.equal(resolveEvent.meta.command_id, id, 'event must carry the full id, not the prefix');
});

test('resolve rejects unknown ids and ambiguous prefixes fast (no lock-timeout stall)', () => {
    const repo = tempRepo();
    const bridge = new Bridge(repo);
    bridge.postCommand('user', 'STOP one', 'all');

    const started = Date.now();
    assert.throws(() => bridge.resolve('claude', 'ffffffff', 'nope'), /Unknown command id/);
    // The old withLock retried a throwing fn for the full 10s timeout and then
    // reported a bogus lock error; the real error must surface immediately.
    assert.ok(Date.now() - started < 2_000, 'error must propagate without burning the lock timeout');
});

test('resolve rejects too-short prefixes', () => {
    const repo = tempRepo();
    const bridge = new Bridge(repo);
    const id = bridge.postCommand('user', 'STOP short', 'all');
    assert.throws(() => bridge.resolve('claude', id.slice(0, 4), 'nope'), /Unknown command id/);
});

test('ack accepts a unique prefix too', () => {
    const repo = tempRepo();
    const bridge = new Bridge(repo);
    const id = bridge.postCommand('user', 'PAUSE for ack test', 'claude');
    bridge.ack('claude', id.slice(0, 10), 'acked by prefix');
    const blocking = bridge.getBlockingCommands('claude');
    assert.equal(blocking.length, 1, 'acknowledged command still blocks until resolved');
    assert.equal(blocking[0].status, 'acknowledged');
});

// ── codex model labelling ────────────────────────────────────────────────────

test('parseCodexModelHeader reads the model from the codex exec run header', () => {
    const stdout = [
        '--------',
        'workdir: N:\\repo',
        'model: gpt-5.6-sol',
        'provider: openai',
        '--------',
        'the actual answer',
    ].join('\n');
    assert.equal(parseCodexModelHeader(stdout), 'gpt-5.6-sol');
    assert.equal(parseCodexModelHeader('no header here'), undefined);
});

test('codexDefaultModel reads only the top-level model key from config.toml', () => {
    const dir = tempRepo();
    const config = path.join(dir, 'config.toml');
    fs.writeFileSync(config, ['model = "gpt-5.6-sol"', '', '[profiles.fast]', 'model = "gpt-5.5-mini"'].join('\n'), 'utf8');
    assert.equal(codexDefaultModel(config), 'gpt-5.6-sol');

    fs.writeFileSync(config, ['[profiles.fast]', 'model = "gpt-5.5-mini"'].join('\n'), 'utf8');
    assert.equal(codexDefaultModel(config), undefined, 'a model inside a table is not the default');

    assert.equal(codexDefaultModel(path.join(dir, 'missing.toml')), undefined);
});
