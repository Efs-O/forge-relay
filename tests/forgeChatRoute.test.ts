import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, DISPATCH_SUBAGENT_TOOL, dispatchSubagentTier1, nextWorkerOrdinal, ResolvedModel, SubagentBackends, workerCompletionPayload } from '../src/subagent';
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

/** Capture parsed JSON request bodies, returning a canned OpenAI response. */
function captureBody(response: unknown): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(response), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;
    return { bodies };
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

test('Tier-1 llama.cpp workers disable thinking and default to 4096 tokens', async () => {
    const captured = captureBody({ choices: [{ message: { content: 'hi' } }] });
    const resolved: ResolvedModel = { backend: 'llama.cpp', model: 'gemma', baseUrl: 'http://127.0.0.1:8080/v1' };
    await chatCompletion(resolved, [{ role: 'user', content: 'x' }]);
    assert.equal(captured.bodies[0].max_tokens, 4096);
    assert.deepEqual(captured.bodies[0].chat_template_kwargs, { enable_thinking: false });
});

test('Tier-1 maxTokens overrides the default worker cap', async () => {
    const captured = captureBody({ choices: [{ message: { content: 'hi' } }] });
    const resolved: ResolvedModel = { backend: 'direct', model: 'gemma', baseUrl: 'http://127.0.0.1:8080/v1' };
    await chatCompletion(resolved, [{ role: 'user', content: 'x' }], { maxTokens: 8192 });
    assert.equal(captured.bodies[0].max_tokens, 8192);
    assert.deepEqual(captured.bodies[0].chat_template_kwargs, { enable_thinking: false });
});

test('workerCompletionPayload only changes thinking for llama.cpp backends', () => {
    const llama: ResolvedModel = { backend: 'llamacpp', model: 'gemma', baseUrl: 'http://localhost' };
    const cloud: ResolvedModel = { backend: 'forge-chat', model: 'grok', baseUrl: 'http://localhost' };
    assert.deepEqual(workerCompletionPayload(llama, { messages: [] }, 6000), {
        messages: [], max_tokens: 6000, chat_template_kwargs: { enable_thinking: false },
    });
    assert.deepEqual(workerCompletionPayload(cloud, { messages: [] }), { messages: [] });
});

test('runWorkerLoop classifies empty length-overflow as exhausted (F1)', async () => {
    captureUrl({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] });
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    const ctx: WorkerToolContext = { repoRoot: process.cwd(), autonomy: 'draft' };
    const result = await runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 1 });
    assert.equal(result.state, 'exhausted');
    assert.match(result.finalText, /token limit|length overflow/i);
});

test('runWorkerLoop still completes when content is present (no false F1 trip)', async () => {
    captureUrl({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    const ctx: WorkerToolContext = { repoRoot: process.cwd(), autonomy: 'draft' };
    const r = await runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 1 });
    assert.equal(r.state, 'succeeded');
    assert.equal(r.finalText, 'done');
});

test('runWorkerLoop classifies step and total-token limits as exhausted', async () => {
    const toolCall = { choices: [{ message: { role: 'assistant', tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] } }], usage: { total_tokens: 20 } };
    captureUrl(toolCall);
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    const ctx: WorkerToolContext = { repoRoot: process.cwd(), autonomy: 'draft' };
    const steps = await runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 1 });
    assert.equal(steps.state, 'exhausted');
    const budget = await runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 3, maxTotalTokens: 10 });
    assert.equal(budget.state, 'exhausted');
    assert.match(budget.finalText, /token budget/i);
});

test('dispatch schema keeps per-round, total, compatibility, and step limits distinct', () => {
    const properties = DISPATCH_SUBAGENT_TOOL.inputSchema.properties;
    assert.ok(properties.max_tokens);
    assert.ok(properties.max_total_tokens);
    assert.match(properties.token_budget.description, /Deprecated compatibility alias/);
    assert.ok(properties.max_steps);
});

test('runWorkerLoop classifies an unrecovered terminal tool failure as failed', async () => {
    const responses = [
        { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'bad', function: { name: 'unknown_tool', arguments: '{}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: 'I could not complete the requested mutation.' }, finish_reason: 'stop' }] },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const resolved: ResolvedModel = { backend: 'forge-chat', model: 'grok-4', baseUrl: 'http://127.0.0.1:8799' };
    const ctx: WorkerToolContext = { repoRoot: process.cwd(), autonomy: 'draft' };
    const result = await runWorkerLoop(resolved, ctx, 'do a thing', undefined, { maxSteps: 2 });
    assert.equal(result.state, 'failed');
    assert.match(result.finalText, /unknown[_ ]tool/i);
});

test('chatCompletion errors on empty content + finish_reason length (F1 Tier-1)', async () => {
    captureUrl({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    const resolved: ResolvedModel = { backend: 'direct', model: 'm', baseUrl: 'http://127.0.0.1:8080/v1' };
    await assert.rejects(
        () => chatCompletion(resolved, [{ role: 'user', content: 'x' }]),
        /token limit|length overflow/i,
    );
});

test('dispatchSubagentTier1 reuses a passed worker name without consuming an ordinal (F2)', async () => {
    captureUrl({ choices: [{ message: { content: 'ok' } }] });
    const posts: string[] = [];
    const bridge = { post: (agent: string) => { posts.push(agent); } } as never;
    const backends = { defaultBackend: 'direct', directUrl: 'http://127.0.0.1:8080/v1' } as unknown as SubagentBackends;
    const resolved: ResolvedModel = { backend: 'direct', model: 'm', baseUrl: 'http://127.0.0.1:8080/v1' };

    const before = nextWorkerOrdinal();
    await dispatchSubagentTier1(bridge, backends, { dispatcher: 'claude', model: 'm', task: 't' }, resolved, 'worker-5:m');
    await dispatchSubagentTier1(bridge, backends, { dispatcher: 'claude', model: 'm', task: 't' }, resolved, 'worker-6:m');
    const after = nextWorkerOrdinal();

    // With the fix, neither dispatch calls beginWorkerRun, so the only advance is
    // our second probe (+1). The old double-begin would have advanced by +3.
    assert.equal(after, before + 1);
    assert.ok(posts.includes('worker-5:m'));
    assert.ok(posts.includes('worker-6:m'));
});
