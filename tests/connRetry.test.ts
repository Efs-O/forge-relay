import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConnRetry, BackendConnectionError } from '../src/subagent';

const FAST = { delaysMs: [5, 5, 5] };

test('B: a single transient ECONNRESET is retried then succeeds', async () => {
    let calls = 0;
    const retries: number[] = [];
    const result = await withConnRetry(async () => {
        calls++;
        if (calls === 1) { throw new BackendConnectionError('reset by peer', 'ECONNRESET'); }
        return { ok: true };
    }, { ...FAST, onRetry: (attempt) => retries.push(attempt) });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2, 'one failure + one successful retry');
    assert.deepEqual(retries, [1], 'onRetry fired once for attempt 1');
});

test('B: HTTP errors (plain Error) are NOT retried', async () => {
    let calls = 0;
    await assert.rejects(
        () => withConnRetry(async () => {
            calls++;
            throw new Error('bridge backend HTTP 500 at /chat/completions: boom');
        }, FAST),
        /HTTP 500/,
    );
    assert.equal(calls, 1, 'an HTTP response is a real answer — surfaced immediately');
});

test('B: gives up after exhausting the backoff schedule', async () => {
    let calls = 0;
    await assert.rejects(
        () => withConnRetry(async () => {
            calls++;
            throw new BackendConnectionError('connection refused', 'ECONNREFUSED');
        }, FAST),
        /connection refused/,
    );
    // delaysMs has 3 entries → 3 retries → 4 attempts total.
    assert.equal(calls, 4);
});

test('B: success on the first call makes no retries', async () => {
    let calls = 0, retried = 0;
    const r = await withConnRetry(async () => { calls++; return 42; }, { ...FAST, onRetry: () => { retried++; } });
    assert.equal(r, 42);
    assert.equal(calls, 1);
    assert.equal(retried, 0);
});

test('B: an aborted signal stops retrying mid-backoff', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = withConnRetry(async () => {
        calls++;
        if (calls === 1) { ac.abort(); }
        throw new BackendConnectionError('reset', 'ECONNRESET');
    }, { delaysMs: [50, 50, 50], signal: ac.signal });

    await assert.rejects(p, (err: Error) => err.name === 'AbortError');
    assert.equal(calls, 1, 'no further attempts once the signal aborts during backoff');
});
