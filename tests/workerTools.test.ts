import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeWorkerTool } from '../src/workerTools';

test('clanker authorizes a path before writing it', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls: string[] = [];
    const result = await executeWorkerTool('write_file', { path: 'docs/a.md', content: 'x' }, {
        repoRoot: root,
        autonomy: 'clanker',
        authorizeMutation: target => {
            calls.push(target);
            assert.equal(fs.existsSync(path.join(root, 'docs', 'a.md')), false, 'authorization must happen before the write');
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['docs/a.md']);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8'), 'x');
});

test('claim refusal prevents a clanker mutation', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await executeWorkerTool('write_file', { path: 'a.md', content: 'x' }, {
        repoRoot: root,
        autonomy: 'clanker',
        authorizeMutation: () => { throw new Error('claimed by another agent'); },
    });
    assert.equal(result.ok, false);
    assert.match(result.result, /claimed by another agent/);
    assert.equal(fs.existsSync(path.join(root, 'a.md')), false);
});

test('paths outside repoRoot remain refused', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await executeWorkerTool('write_file', { path: path.join(root, '..', 'outside.md'), content: 'x' }, {
        repoRoot: root,
        autonomy: 'clanker',
    });
    assert.equal(result.ok, false);
    assert.match(result.result, /outside the repo root/);
});
