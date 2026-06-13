import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, ResolvedModel } from '../src/subagent';
import { runWorkerLoop } from '../src/subagentLoop';
import { WorkerToolContext } from '../src/workerTools';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Capture the URL the next chat POST hits, returning a canned OpenAI response. */
function captureUrl(response: unknown): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify(response), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;
    return { urls };
}

test('postChat targets /chat for a forge-chat (cloud proxy) backend', async () => {
    const captured = captureUrl({ choices: [{ message: { content: 'hi' } }] });
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    await chatCompletion(resolved, [{ role: 'user', content: 'x' }]);
    assert.equal(captured.urls[0], 'http://127.0.0.1:8799/chat');
});

test('postChat targets /chat/completions for non-forge-chat backends', async () => {
    const captured = captureUrl({ choices: [{ message: { content: 'hi' } }] });
    const resolved: ResolvedModel = { backend: 'direct', model: 'm', baseUrl: 'http://127.0.0.1:8080/v1' };
    await chatCompletion(resolved, [{ role: 'user', content: 'x' }]);
    assert.equal(captured.urls[0], 'http://127.0.0.1:8080/v1/chat/completions');
});

test('runWorkerLoop surfaces an ERROR on empty content + finish_reason length (F1)', async () => {
    captureUrl({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] });
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    const ctx: WorkerToolContext = { repoRoot: process.cwd(), autonomy: 'draft' };
    await assert.rejects(
        () => runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 1 }),
        /token limit|length overflow/i,
    );
});

test('runWorkerLoop still completes when content is present (no false F1 trip)', async () => {
    captureUrl({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    const ctx: WorkerToolContext = { repoRoot: process.cwd(), autonomy: 'draft' };
    const r = await runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 1 });
    assert.equal(r.finalText, 'done');
});
