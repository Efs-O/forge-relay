import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerAgentName, nextWorkerOrdinal, beginWorkerRun, endWorkerRun, formatWorkerPost } from '../src/subagent';

test('workerAgentName includes a numbered worker prefix', () => {
    const worker = workerAgentName('forge:gemma-3n', 3);
    assert.equal(worker, 'worker-3:gemma-3n');
});

test('nextWorkerOrdinal increments monotonically', () => {
    const first = nextWorkerOrdinal();
    const second = nextWorkerOrdinal();
    assert.equal(second, first + 1);
});

test('worker numbering restarts at 1 once a batch fully drains', () => {
    // Force the shared counter to a known-drained state (other test files share
    // this module-level state); endWorkerRun floors activeWorkerRuns at 0.
    for (let i = 0; i < 32; i++) { endWorkerRun(); }

    // Simulate an 8-worker batch: begin all 8, then finish all 8.
    const ordinals = Array.from({ length: 8 }, () => beginWorkerRun());
    assert.equal(ordinals[0], 1);
    assert.equal(ordinals[7], 8);
    for (let i = 0; i < 8; i++) { endWorkerRun(); }

    // Next batch must restart at worker-1 — this is the regression guard for the
    // leaked counter (success paths that never called endWorkerRun → 9,10,11…).
    assert.equal(beginWorkerRun(), 1);
    endWorkerRun();
});

test('a worker run that overlaps the next keeps numbering monotonic within the batch', () => {
    const a = beginWorkerRun(); // batch starts → 1
    const b = beginWorkerRun(); // 2
    endWorkerRun();             // a finishes, but b still live → no reset
    const c = beginWorkerRun(); // 3 (not reset, because activeWorkerRuns > 0)
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(c, 3);
    endWorkerRun(); endWorkerRun(); // drain b and c
});

test('formatWorkerPost keeps long worker output but remains bounded', () => {
    const longText = `done: ${'x'.repeat(9000)}`;
    const formatted = formatWorkerPost(longText);

    assert.equal(formatted.startsWith('done: '), true);
    assert.equal(formatted.length, 8192);
});
