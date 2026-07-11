import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    parseArgs,
    buildUserMessage,
    buildKeepAliveMessage,
    collectToolNames,
    extractTelemetry,
    shouldTrigger,
} = require('../scripts/claude-auto-bridge.js');

test('shared bridge event filter suppresses self posts and session markers', () => {
    assert.equal(shouldTrigger({ type: 'post', agent: 'forge-coordinator', message: 'mine' }, 'forge-coordinator', 'all'), false);
    assert.equal(shouldTrigger({ type: 'post', agent: 'user', message: 'SESSION_START' }, 'forge-coordinator', 'all'), false);
    assert.equal(shouldTrigger({ type: 'post', agent: 'user', message: 'work' }, 'forge-coordinator', 'all'), true);
});

test('Claude bridge parses debug keep-alive flags', () => {
    const args = parseArgs([
        '--repo-root', '.',
        '--debug-keep-alive-ms', '240000',
        '--debug-keep-alive-log-payloads', 'true',
    ]);

    assert.equal(args.debugKeepAliveMs, 240000);
    assert.equal(args.debugKeepAliveLogPayloads, true);
});

test('Claude bridge keep-alive defaults to a bounded ping cap', () => {
    const defaults = parseArgs(['--repo-root', '.']);
    assert.equal(defaults.keepAliveMaxPings, 3);

    const overridden = parseArgs(['--repo-root', '.', '--keep-alive-max-pings', '0']);
    assert.equal(overridden.keepAliveMaxPings, 0);
});

test('Claude bridge board-event turns are explicitly tagged', () => {
    const msg = buildUserMessage({ type: 'post', agent: 'user', message: 'check in' }, 'claude');
    const text = msg.message.content[0].text;

    assert.match(text, /\[AW_TURN_TYPE: board-event\]/);
    assert.match(text, /Forge Relay MCP tools/);
});

test('Claude bridge keep-alive turns stay inert-by-contract', () => {
    const msg = buildKeepAliveMessage();
    const text = msg.message.content[0].text;

    assert.match(text, /\[AW_TURN_TYPE: keep-alive\]/);
    assert.match(text, /Do not use tools\./);
    assert.match(text, /\[AW_KEEPALIVE_OK\]/);
});

test('Claude bridge defaults telemetry on with a .coordination path', () => {
    const args = parseArgs(['--repo-root', '.']);
    assert.equal(args.telemetry, true);
    assert.match(args.telemetryPath.replace(/\\/g, '/'), /\.coordination\/claude-telemetry\.ndjson$/);

    const off = parseArgs(['--repo-root', '.', '--telemetry', 'false']);
    assert.equal(off.telemetry, false);
});

test('Claude telemetry flattens a result payload and sums billed input', () => {
    const row = extractTelemetry({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        duration_ms: 4200,
        total_cost_usd: 0.0123,
        session_id: 'sess-1',
        usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 5000,
        },
    }, { agent: 'claude', turn: 3, kind: 'board-event', trigger: 'worker done' });

    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 200);
    assert.equal(row.cache_read_input_tokens, 5000);
    assert.equal(row.cache_creation_input_tokens, 50);
    assert.equal(row.billed_input_tokens, 5150);
    assert.equal(row.total_cost_usd, 0.0123);
    assert.equal(row.turn, 3);
    assert.equal(row.kind, 'board-event');
});

test('Claude telemetry tolerates a usage-less payload', () => {
    const row = extractTelemetry({ type: 'result', subtype: 'success' }, { kind: 'keep-alive' });
    assert.equal(row.input_tokens, null);
    assert.equal(row.billed_input_tokens, null);
    assert.equal(row.total_cost_usd, null);
    assert.equal(row.kind, 'keep-alive');
});

test('Claude bridge keep-alive payload scan surfaces tool names', () => {
    const tools: string[] = [];
    collectToolNames({
        type: 'message',
        content: [
            { type: 'tool_use', name: 'mcp__forgerelay__post' },
            { type: 'text', text: 'ignored' },
            { type: 'server_tool_use', name: 'Read' },
        ],
    }, tools);

    assert.deepEqual(tools, ['mcp__forgerelay__post', 'Read']);
});
