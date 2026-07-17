import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRuntimeAcceptanceReport, runRuntimeAcceptanceMatrix } from '../src/runtimeAcceptance';

test('runtime acceptance runs every case and retains actionable failures', async () => {
    const visited: string[] = [];
    const results = await runRuntimeAcceptanceMatrix([
        { name: 'first', run: () => { visited.push('first'); return 'ready'; } },
        { name: 'broken', run: () => { visited.push('broken'); throw new Error('route unavailable'); } },
        { name: 'last', run: async () => { visited.push('last'); return 'done'; } },
    ]);
    assert.deepEqual(visited, ['first', 'broken', 'last']);
    assert.deepEqual(results.map(result => result.ok), [true, false, true]);
    assert.match(results[1].detail, /route unavailable/);
    const report = formatRuntimeAcceptanceReport(results);
    assert.match(report, /Result: 2\/3 passed/);
    assert.match(report, /\| FAIL \| broken \| route unavailable \|/);
});
