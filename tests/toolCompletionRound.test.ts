import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolCompletionRound } from '../src/toolCompletionRound';

test('shared completion round truncates tool results only in model history', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const full = 'x'.repeat(9_000);
    let observed = '';
    const result = await runToolCompletionRound({
        messages,
        complete: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: '1', function: { name: 'get_status', arguments: '{}' } }] } }] }),
        executeTool: async () => full,
        onToolCall: (_name, value) => { observed = value; },
        emptyLengthError: 'length',
    });

    assert.equal(result.finished, false);
    assert.equal(observed.length, 9_000);
    assert.equal(messages[1].content, full.slice(0, 8_000));
});

test('shared completion round surfaces empty length-overflow responses', async () => {
    await assert.rejects(
        runToolCompletionRound({
            messages: [],
            complete: async () => ({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }),
            executeTool: async () => '',
            emptyLengthError: 'coordinator length overflow',
        }),
        /coordinator length overflow/,
    );
});

test('shared completion round preflights every tool before execution', async () => {
    let executions = 0;
    await assert.rejects(
        runToolCompletionRound({
            messages: [],
            complete: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ function: { name: 'post', arguments: '{}' } }] } }] }),
            beforeTool: () => { throw new Error('STOP'); },
            executeTool: async () => { executions++; return 'unexpected'; },
            emptyLengthError: 'length',
        }),
        /STOP/,
    );
    assert.equal(executions, 0);
});
