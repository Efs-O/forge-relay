import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { asyncDispatchReceipt, createSubagentRun, readSubagentRun, updateSubagentRun } from '../src/subagentRuns';

test('async subagent lifecycle is durable and queryable', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const created = createSubagentRun(root, { runId: 'sa_test_1', worker: 'worker-1:m', model: 'm' });
    assert.equal(created.state, 'accepted');
    assert.match(asyncDispatchReceipt(created), /"runId":"sa_test_1"/);
    updateSubagentRun(root, created.runId, 'running');
    updateSubagentRun(root, created.runId, 'succeeded', 'done');
    assert.deepEqual(readSubagentRun(root, created.runId)?.state, 'succeeded');
});
