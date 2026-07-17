import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isManagedCodexAuthenticationError,
    startWithManagedCodexSignIn,
} from '../src/managedCodexStart';

test('managed start offers sign-in and retries once after successful authentication', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const started = await startWithManagedCodexSignIn('managed-isolated', {
        start: async () => {
            calls.push('start');
            if (++attempts === 1) throw new Error('Unauthenticated Codex account; ChatGPT subscription login required.');
        },
        promptSignIn: async () => { calls.push('prompt'); return true; },
        signIn: async () => { calls.push('sign-in'); return true; },
    });
    assert.equal(started, true);
    assert.deepEqual(calls, ['start', 'prompt', 'sign-in', 'start']);
});

test('managed start stops cleanly when sign-in is declined or cancelled', async () => {
    for (const [promptAccepted, signInSucceeded, expected] of [
        [false, true, ['start', 'prompt']],
        [true, false, ['start', 'prompt', 'sign-in']],
    ] as const) {
        const calls: string[] = [];
        const started = await startWithManagedCodexSignIn('managed-isolated', {
            start: async () => { calls.push('start'); throw new Error('not authenticated with ChatGPT subscription'); },
            promptSignIn: async () => { calls.push('prompt'); return promptAccepted; },
            signIn: async () => { calls.push('sign-in'); return signInSucceeded; },
        });
        assert.equal(started, false);
        assert.deepEqual(calls, expected);
    }
});

test('MCP mode and unrelated managed failures never trigger the sign-in flow', async () => {
    for (const [mode, error] of [
        ['mcp', new Error('Unauthenticated Codex account')],
        ['managed-isolated', new Error('app-server transport closed')],
    ] as const) {
        let prompted = false;
        await assert.rejects(startWithManagedCodexSignIn(mode, {
            start: async () => { throw error; },
            promptSignIn: async () => { prompted = true; return true; },
            signIn: async () => true,
        }), error);
        assert.equal(prompted, false);
    }
});

test('authentication error classification recognizes only the managed subscription messages', () => {
    assert.equal(isManagedCodexAuthenticationError(new Error('Unauthenticated Codex account')), true);
    assert.equal(isManagedCodexAuthenticationError(new Error('ChatGPT subscription login required')), true);
    assert.equal(isManagedCodexAuthenticationError(new Error('not authenticated with ChatGPT subscription access')), true);
    assert.equal(isManagedCodexAuthenticationError(new Error('token invalidated')), false);
});
