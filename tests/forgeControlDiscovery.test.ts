import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveForgeControlUrl } from '../src/forgeControlDiscovery';

function registryFile(record: unknown): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-control-discovery-'));
    const file = path.join(dir, 'control-server.json');
    fs.writeFileSync(file, JSON.stringify(record), 'utf8');
    return { dir, file };
}

const healthyFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('explicit setting wins without consulting discovery', async () => {
    const result = await resolveForgeControlUrl('http://127.0.0.1:9900/', { registryPath: 'missing' });
    assert.equal(result.source, 'setting');
    assert.equal(result.url, 'http://127.0.0.1:9900');
});

test('discovers a live localhost Forge registry entry', async (t) => {
    const { dir, file } = registryFile({ url: 'http://127.0.0.1:8799', pid: 42, startedAt: 'now', version: '1.2.3' });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await resolveForgeControlUrl('', { registryPath: file, isPidAlive: () => true, fetchFn: healthyFetch as typeof fetch });
    assert.equal(result.source, 'registry');
    assert.equal(result.url, 'http://127.0.0.1:8799');
});

test('rejects stale, remote, and unhealthy registry entries', async (t) => {
    const stale = registryFile({ url: 'http://127.0.0.1:8799', pid: 42 });
    const remote = registryFile({ url: 'http://example.com:8799', pid: 42 });
    const unhealthy = registryFile({ url: 'http://localhost:8799', pid: 42 });
    t.after(() => { for (const x of [stale, remote, unhealthy]) fs.rmSync(x.dir, { recursive: true, force: true }); });

    assert.equal((await resolveForgeControlUrl('', { registryPath: stale.file, isPidAlive: () => false })).source, 'none');
    assert.match((await resolveForgeControlUrl('', { registryPath: remote.file, isPidAlive: () => true })).detail, /non-local/);
    const badFetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 });
    assert.match((await resolveForgeControlUrl('', { registryPath: unhealthy.file, isPidAlive: () => true, fetchFn: badFetch as typeof fetch })).detail, /did not report ok/);
});
