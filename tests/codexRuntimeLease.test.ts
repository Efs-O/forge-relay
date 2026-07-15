import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexHomeFingerprint, CodexRuntimeLease, normalizeCodexHome } from '../src/codexRuntimeLease';

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-relay-codex-lease-')); }

test('Codex home identity is stable across Windows case and slash variants', () => {
    assert.equal(normalizeCodexHome('C:\\Users\\ME\\.codex\\', 'win32'), 'c:\\users\\me\\.codex');
    assert.equal(
        codexHomeFingerprint('C:\\Users\\ME\\.codex', 'user:test', 'win32'),
        codexHomeFingerprint('c:/users/me/.codex/', 'user:test', 'win32'),
    );
});

test('same credential home is exclusive across repositories', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const alive = (pid: number | undefined) => pid === 101 || pid === 102 || pid === 201;
    const common = { lockDir, isPidAlive: alive, userIdentity: 'test', platform: 'linux' as const };
    const first = new CodexRuntimeLease('/home/me/.codex', '/repo-a', 101, '1.0', { ...common, ownerToken: 'first' });
    const second = new CodexRuntimeLease('/home/me/.codex', '/repo-b', 201, '2.0', { ...common, ownerToken: 'second' });
    assert.equal(first.tryAcquire(), 'acquired');
    first.markBridgeStarted(102);
    assert.equal(second.tryAcquire(), 'held-by-live-other');
    assert.equal(second.readCurrent()?.repoRoot, '/repo-a');
});

test('older extension live owner is never killed or replaced', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const alive = (pid: number | undefined) => pid === 301 || pid === 302;
    const opts = { lockDir, isPidAlive: alive, userIdentity: 'test', platform: 'linux' as const };
    const oldLease = new CodexRuntimeLease('/home/me/.codex', '/old', 301, '0.5', { ...opts, ownerToken: 'old' });
    const newLease = new CodexRuntimeLease('/home/me/.codex', '/new', 302, '9.0', { ...opts, ownerToken: 'new' });
    assert.equal(oldLease.tryAcquire(), 'acquired');
    assert.equal(newLease.tryAcquire(), 'held-by-live-other');
    assert.equal(oldLease.isOwned(), true);
});

test('dead owner and dead child are recovered without process killing', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const opts = { lockDir, isPidAlive: () => false, userIdentity: 'test', platform: 'linux' as const };
    const stale = new CodexRuntimeLease('/home/me/.codex', '/old', 401, '1', { ...opts, ownerToken: 'stale' });
    const next = new CodexRuntimeLease('/home/me/.codex', '/new', 501, '1', { ...opts, ownerToken: 'next' });
    assert.equal(stale.tryAcquire(), 'acquired');
    stale.markBridgeStarted(402);
    assert.equal(next.tryAcquire(), 'recovered-stale');
    assert.equal(next.readCurrent()?.pid, 501);
});

test('orphaned live child blocks recovery even when owner is dead', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const alive = (pid: number | undefined) => pid === 602;
    const opts = { lockDir, isPidAlive: alive, userIdentity: 'test', platform: 'linux' as const };
    const stale = new CodexRuntimeLease('/home/me/.codex', '/old', 601, '1', { ...opts, ownerToken: 'stale' });
    assert.equal(stale.tryAcquire(), 'acquired');
    stale.markBridgeStarted(602);
    const next = new CodexRuntimeLease('/home/me/.codex', '/new', 701, '1', { ...opts, ownerToken: 'next' });
    assert.equal(next.tryAcquire(), 'held-by-live-other');
});

test('malformed lease fails closed and is not removed', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const lease = new CodexRuntimeLease('/home/me/.codex', '/repo', 801, '1', {
        lockDir, isPidAlive: () => false, userIdentity: 'test', platform: 'linux', ownerToken: 'owner',
    });
    const fingerprint = codexHomeFingerprint('/home/me/.codex', 'test', 'linux');
    const leasePath = path.join(lockDir, `codex-${fingerprint}.lock`);
    fs.writeFileSync(leasePath, '{broken');
    assert.equal(lease.tryAcquire(), 'unknown');
    assert.equal(fs.readFileSync(leasePath, 'utf8'), '{broken');
});

test('heartbeat replacement remains valid and only owner can release', (t) => {
    const lockDir = tempDir();
    t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    const opts = { lockDir, isPidAlive: () => true, userIdentity: 'test', platform: 'linux' as const };
    const owner = new CodexRuntimeLease('/home/me/.codex', '/repo', 901, '1', { ...opts, ownerToken: 'owner' });
    const other = new CodexRuntimeLease('/home/me/.codex', '/repo', 902, '1', { ...opts, ownerToken: 'other' });
    assert.equal(owner.tryAcquire(), 'acquired');
    owner.renewHealthy('linked');
    assert.equal(owner.readCurrent()?.status, 'linked');
    other.releaseIfOwned();
    assert.equal(owner.isOwned(), true);
    owner.releaseIfOwned();
    assert.equal(owner.readCurrent(), null);
});
