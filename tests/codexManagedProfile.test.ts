import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexManagedIsolationOverrides, ensureCodexManagedProfile } from '../src/codexManagedProfile';

test('managed profile is stable for normalized workspace identity and creates both homes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-profile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'repo');
    const storage = path.join(root, 'storage');
    await fs.mkdir(workspace);
    const first = await ensureCodexManagedProfile({
        globalStorageRoot: storage, repoRoot: `${workspace}${path.sep}`,
        remoteAuthority: ' SSH-REMOTE+HOST ', userIdentity: ' User ',
        defaultCodexHome: path.join(root, 'ordinary-codex'),
    });
    const second = await ensureCodexManagedProfile({
        globalStorageRoot: storage, repoRoot: workspace,
        remoteAuthority: 'ssh-remote+host', userIdentity: 'user',
        defaultCodexHome: path.join(root, 'ordinary-codex'),
    });
    assert.equal(first.profileId, second.profileId);
    assert.equal(first.root, second.root);
    assert.deepEqual(first.env, { CODEX_HOME: first.home, CODEX_SQLITE_HOME: first.sqliteHome });
    assert.deepEqual(codexManagedIsolationOverrides(first), {
        sqlite_home: first.sqliteHome,
        cli_auth_credentials_store: 'file',
    });
    assert.equal((await fs.stat(first.home)).isDirectory(), true);
    assert.equal((await fs.stat(first.sqliteHome)).isDirectory(), true);
    assert.match(path.basename(first.root), /^[a-f0-9]{64}$/);
});

test('different workspace, remote authority, or user gets a distinct profile', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-profile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const common = { globalStorageRoot: path.join(root, 'storage'), defaultCodexHome: path.join(root, 'default') };
    const a = await ensureCodexManagedProfile({ ...common, repoRoot: path.join(root, 'a'), userIdentity: 'u' });
    const b = await ensureCodexManagedProfile({ ...common, repoRoot: path.join(root, 'b'), userIdentity: 'u' });
    const remote = await ensureCodexManagedProfile({ ...common, repoRoot: path.join(root, 'a'), userIdentity: 'u', remoteAuthority: 'ssh-x' });
    const user = await ensureCodexManagedProfile({ ...common, repoRoot: path.join(root, 'a'), userIdentity: 'v' });
    assert.equal(new Set([a.profileId, b.profileId, remote.profileId, user.profileId]).size, 4);
});

test('profile roots inside the repository or overlapping the default Codex home are rejected', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-profile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(ensureCodexManagedProfile({
        globalStorageRoot: path.join(root, 'repo', '.storage'), repoRoot: path.join(root, 'repo'),
        defaultCodexHome: path.join(root, 'default'),
    }), /outside the workspace repository/);
    await assert.rejects(ensureCodexManagedProfile({
        globalStorageRoot: path.join(root, 'default'), repoRoot: path.join(root, 'repo'),
        defaultCodexHome: path.join(root, 'default'),
    }), /default Codex home/);
});
