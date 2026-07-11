import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { endpointIdentity, endpointKey, RuntimeLease } from '../src/runtimeLease';

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-relay-lease-'));
}

test('endpoint lock is shared across different repo roots', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const alive = (pid: number | undefined) => pid === 101 || pid === 102 || pid === 201;
    const first = new RuntimeLease('http://127.0.0.1:7879/sse', 'claude', 'C:/repo-a', 101, '0.4.2', { lockDir, isPidAlive: alive });
    const second = new RuntimeLease('http://127.0.0.1:7879/sse', 'claude', 'C:/repo-b', 201, '0.4.2', { lockDir, isPidAlive: alive });

    assert.equal(first.tryAcquire(), 'acquired');
    first.markBridgeStarted(102);
    assert.equal(second.tryAcquire(), 'held-by-live-other');
    assert.equal(second.readCurrent()?.repoRoot, 'C:/repo-a');
});

test('dead lock holder is recovered', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const first = new RuntimeLease('http://localhost:7879/sse', 'claude', '/old', 301, '0.4.2', { lockDir, isPidAlive: () => false });
    const second = new RuntimeLease('http://localhost:7879/sse', 'claude', '/new', 302, '0.4.2', { lockDir, isPidAlive: () => false });

    assert.equal(first.tryAcquire(), 'acquired');
    assert.equal(second.tryAcquire(), 'recovered-stale');
    assert.equal(second.readCurrent()?.pid, 302);
});

test('new extension version kills old bridge tree and takes lock', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const killed: number[] = [];
    const alive = (pid: number | undefined) => pid === 401 || pid === 402 || pid === 501;
    const oldLease = new RuntimeLease('http://localhost:7879/sse', 'claude', '/old', 401, '0.4.1', { lockDir, isPidAlive: alive });
    const newLease = new RuntimeLease('http://localhost:7879/sse', 'claude', '/new', 501, '0.4.2', {
        lockDir,
        isPidAlive: alive,
        killPidTree: (pid) => killed.push(pid),
    });

    assert.equal(oldLease.tryAcquire(), 'acquired');
    oldLease.markBridgeStarted(402);
    assert.equal(newLease.tryAcquire(), 'replaced-old-version');
    assert.deepEqual(killed, [402]);
    assert.equal(oldLease.isOwned(), false);
});

test('lock filename is keyed only by normalized endpoint host and port', () => {
    assert.equal(endpointKey('http://127.0.0.1:7879/sse'), '127.0.0.1-7879');
    assert.equal(endpointKey('https://relay.example/sse'), 'relay.example-443');
    assert.equal(endpointIdentity('http://LOCALHOST:7879/sse'), endpointIdentity('http://localhost:7879/mcp'));
});
