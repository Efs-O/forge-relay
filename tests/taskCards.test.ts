import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bridge } from '../src/bridge';
import { executeBoardTool } from '../src/boardTools';
import { createSubagentRun } from '../src/subagentRuns';
import { DEFAULT_SUBAGENT_BACKENDS } from '../src/subagent';

function tempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-task-test-'));
}

// ── Bridge-level lifecycle ──────────────────────────────────────────────────

test('createTask defaults to open/medium and appends an audit event', () => {
    const bridge = new Bridge(tempRepo());
    const task = bridge.createTask('claude', 'Write docs');
    assert.equal(task.state, 'open');
    assert.equal(task.severity, 'medium');
    assert.equal(task.created_by, 'claude');
    assert.deepEqual(task.depends_on, []);

    const events = bridge.getState().events;
    assert.ok(events.some(e => e.type === 'task' && e.meta?.task_id === task.id));
});

test('createTask rejects an empty title and an invalid severity', () => {
    const bridge = new Bridge(tempRepo());
    assert.throws(() => bridge.createTask('claude', '   '), /title must not be empty/);
    assert.throws(
        () => bridge.createTask('claude', 'x', { severity: 'urgent' as never }),
        /Invalid task severity/,
    );
});

test('task cards persist across Bridge instances (same repo)', () => {
    const repo = tempRepo();
    const first = new Bridge(repo);
    const task = first.createTask('claude', 'Persisted task', { severity: 'high', owner: 'codex' });

    const second = new Bridge(repo);
    const reloaded = second.listTasks().find(t => t.id === task.id);
    assert.ok(reloaded);
    assert.equal(reloaded?.severity, 'high');
    assert.equal(reloaded?.owner, 'codex');
});

test('startTask moves open -> in_progress, blockTask requires a reason', () => {
    const bridge = new Bridge(tempRepo());
    const task = bridge.createTask('claude', 'Ship feature');

    assert.throws(() => bridge.blockTask('claude', task.id, '   '), /blocking reason is required/);

    const blocked = bridge.blockTask('claude', task.id, 'waiting on API key');
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blocking_reason, 'waiting on API key');

    const unblocked = bridge.unblockTask('claude', task.id);
    assert.equal(unblocked.state, 'in_progress');
    assert.equal(unblocked.blocking_reason, undefined);
});

test('completeTask and cancelTask are terminal — no further transitions are allowed', () => {
    const bridge = new Bridge(tempRepo());
    const done = bridge.createTask('claude', 'Finish it');
    bridge.completeTask('claude', done.id);
    assert.throws(() => bridge.startTask('claude', done.id), /Invalid task transition: done -> in_progress/);

    const cancelled = bridge.createTask('claude', 'Drop it');
    bridge.cancelTask('claude', cancelled.id, 'no longer needed');
    assert.throws(() => bridge.blockTask('claude', cancelled.id, 'x'), /Invalid task transition: cancelled -> blocked/);
});

test('assignTask and updateTask do not change lifecycle state', () => {
    const bridge = new Bridge(tempRepo());
    const task = bridge.createTask('claude', 'Original title');
    const assigned = bridge.assignTask('claude', task.id, 'codex');
    assert.equal(assigned.owner, 'codex');
    assert.equal(assigned.state, 'open');

    const updated = bridge.updateTask('claude', task.id, { title: 'New title', severity: 'critical' });
    assert.equal(updated.title, 'New title');
    assert.equal(updated.severity, 'critical');
    assert.equal(updated.state, 'open');
    assert.throws(() => bridge.updateTask('claude', task.id, { severity: 'nope' as never }), /Invalid task severity/);
});

test('findTask resolves an unambiguous id prefix and rejects unknown ids', () => {
    const bridge = new Bridge(tempRepo());
    const task = bridge.createTask('claude', 'Prefix lookup');
    const short = task.id.slice(0, 8);
    const found = bridge.assignTask('claude', short, 'codex');
    assert.equal(found.id, task.id);

    assert.throws(() => bridge.assignTask('claude', 'deadbeef', 'codex'), /Unknown task id/);
});

test('a new Bridge on a fresh repo creates tasks.json with no tasks (no migration needed)', () => {
    const bridge = new Bridge(tempRepo());
    assert.deepEqual(bridge.listTasks(), []);
    assert.deepEqual(bridge.getState().tasks, []);
});

test('sequential task mutations from two agents do not clobber each other (lock discipline)', () => {
    const bridge = new Bridge(tempRepo());
    const a = bridge.createTask('claude', 'Task A');
    const b = bridge.createTask('codex', 'Task B');
    bridge.assignTask('claude', a.id, 'claude');
    bridge.assignTask('codex', b.id, 'codex');

    const tasks = bridge.listTasks();
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find(t => t.id === a.id)?.owner, 'claude');
    assert.equal(tasks.find(t => t.id === b.id)?.owner, 'codex');
});

// ── MCP tool layer ───────────────────────────────────────────────────────────

test('create_task / list_tasks / block_task tools round-trip through executeBoardTool', async () => {
    const bridge = new Bridge(tempRepo());
    const created = await executeBoardTool(bridge, DEFAULT_SUBAGENT_BACKENDS, 'create_task', { agent: 'claude', title: 'Tool task', severity: 'high' });
    assert.match(created, /^CREATED/);
    const idMatch = created.match(/^CREATED (\w+):/);
    assert.ok(idMatch);
    const shortId = idMatch![1];

    const blocked = await executeBoardTool(bridge, DEFAULT_SUBAGENT_BACKENDS, 'block_task', { agent: 'claude', task_id: shortId, reason: 'needs review' });
    assert.match(blocked, /-> blocked \(needs review\)/);

    const listed = await executeBoardTool(bridge, DEFAULT_SUBAGENT_BACKENDS, 'list_tasks', { agent: 'claude' });
    assert.match(listed, /Tool task/);
    assert.match(listed, /blocked: needs review/);
});

test('get_status reports open tasks but omits done/cancelled ones', async () => {
    const bridge = new Bridge(tempRepo());
    const open = bridge.createTask('claude', 'Still open');
    const done = bridge.createTask('claude', 'Already done');
    bridge.completeTask('claude', done.id);

    const status = await executeBoardTool(bridge, DEFAULT_SUBAGENT_BACKENDS, 'get_status', { agent: 'claude' });
    assert.match(status, /Still open/);
    assert.doesNotMatch(status, /Already done/);
    void open;
});

test('get_subagent_run returns durable async lifecycle state', async () => {
    const bridge = new Bridge(tempRepo());
    createSubagentRun(bridge.getRepoRoot(), { runId: 'sa_board_1', worker: 'worker-1:m', model: 'm' });
    const result = await executeBoardTool(bridge, DEFAULT_SUBAGENT_BACKENDS, 'get_subagent_run', { agent: 'claude', run_id: 'sa_board_1' });
    assert.match(result, /"state":"accepted"/);
    assert.match(result, /"runId":"sa_board_1"/);
});
