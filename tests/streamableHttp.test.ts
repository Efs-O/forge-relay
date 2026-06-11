import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Bridge } from '../src/bridge';
import { McpServer } from '../src/mcpServer';

// Regression for the streamable-HTTP transport: handleRequest() must receive a
// *parsed* JSON body, not the raw Buffer — the raw Buffer fails the SDK's
// JSON-RPC schema validation and every POST to /mcp died with
// "Invalid JSON-RPC message" (found live during the vortex3d run, 2026-06-11).

let tmpRoot: string;
let server: McpServer;
let port: number;

before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-mcp-test-'));
    server = new McpServer(new Bridge(tmpRoot));
    port = await server.start(17878);
});

after(() => {
    server.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function postMcp(body: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body,
    });
    return { status: res.status, text: await res.text() };
}

test('POST /mcp initialize round-trips (body is parsed before the SDK sees it)', async () => {
    const { status, text } = await postMcp(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'regression-test', version: '0.0.0' },
        },
    }));
    assert.equal(status, 200, `unexpected status ${status}: ${text}`);
    assert.ok(!text.includes('Invalid JSON-RPC message'), `SDK rejected the body: ${text}`);
    assert.match(text, /"serverInfo"/, `no initialize result in response: ${text}`);
});

test('POST /mcp with malformed JSON returns a -32700 parse error, not a crash', async () => {
    const { status, text } = await postMcp('{not json');
    assert.equal(status, 400);
    assert.match(text, /-32700/);
});
