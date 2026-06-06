import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerAgentName, nextWorkerOrdinal, formatWorkerPost } from '../src/subagent';

test('workerAgentName includes a numbered worker prefix', () => {
    const worker = workerAgentName('forge:gemma-3n', 3);
    assert.equal(worker, 'worker-3:gemma-3n');
});

test('nextWorkerOrdinal increments monotonically', () => {
    const first = nextWorkerOrdinal();
    const second = nextWorkerOrdinal();
    assert.equal(second, first + 1);
});

test('formatWorkerPost keeps long worker output but remains bounded', () => {
    const longText = `done: ${'x'.repeat(9000)}`;
    const formatted = formatWorkerPost(longText);

    assert.equal(formatted.startsWith('done: '), true);
    assert.equal(formatted.length, 8192);
});
