import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    parseArgs,
    buildUserMessage,
    buildKeepAliveMessage,
    collectToolNames,
} = require('../scripts/claude-auto-bridge.js');

test('Claude bridge parses debug keep-alive flags', () => {
    const args = parseArgs([
        '--repo-root', '.',
        '--debug-keep-alive-ms', '240000',
        '--debug-keep-alive-log-payloads', 'true',
    ]);

    assert.equal(args.debugKeepAliveMs, 240000);
    assert.equal(args.debugKeepAliveLogPayloads, true);
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
