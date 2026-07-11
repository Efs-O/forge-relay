import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Bridge } from '../src/bridge';
import { ForgeCoordinatorBridge } from '../src/forgeCoordinatorBridge';
import { SubagentBackends } from '../src/subagent';

const backends: SubagentBackends = { bridgeUrl: '', ollamaUrl: '', directUrl: '', defaultBackend: 'direct' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('listModels expands profiles and sorts main-profile entries first', async (t) => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [
            { name: 'zeta', profiles: ['main', 'worker'], servable: true },
            { name: 'alpha', profiles: ['worker', 'main', 'subcoordinator'], servable: false, provider: 'cerebras' },
            { name: 'bare-model', servable: true },
        ] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const models = await ForgeCoordinatorBridge.listModels(`http://127.0.0.1:${address.port}`);
    assert.deepEqual(models.map(m => m.name), ['alpha@main', 'zeta@main', 'alpha@subcoordinator', 'alpha@worker', 'bare-model', 'zeta@worker']);
    assert.equal(models.find(m => m.name === 'alpha@main')?.provider, 'cerebras', 'provider display name must pass through for the dropdown');
});

test('coordinator validates, re-ensures for an event burst, and idle-releases', async (t) => {
    let ensures = 0, releases = 0, chats = 0;
    let delayChat = false;
    let lastChatBody: { tools?: Array<{ type: string; function: Record<string, unknown> }> } = {};
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/ensure') {
            ensures++;
            const address = server.address();
            assert.ok(address && typeof address === 'object');
            res.end(JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'model-a', backend: 'llamacpp' }));
            return;
        }
        if (req.url === '/release') { releases++; res.end(JSON.stringify({ released: true })); return; }
        if (req.url === '/v1/chat/completions') {
            chats++;
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                lastChatBody = JSON.parse(Buffer.concat(chunks).toString());
                const respond = () => res.end(JSON.stringify({ choices: [{ message: { content: 'standing by' } }] }));
                if (delayChat) setTimeout(respond, 500); else respond();
            });
            return;
        }
        if (req.url === '/models') { res.end(JSON.stringify({ models: [{ name: 'model-a', servable: true }] })); return; }
        res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const controlUrl = `http://127.0.0.1:${address.port}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-coordinator-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const board = new Bridge(root);
    const coordinator = new ForgeCoordinatorBridge({
        bridge: board, backends, controlUrl, boardEndpoint: `http://127.0.0.1:${address.port + 1}/sse`,
        eventsPath: board.getEventsPath(), repoRoot: root, extensionVersion: 'test', idleReleaseMs: 1_000,
    });
    t.after(() => void coordinator.stop());

    assert.deepEqual(await ForgeCoordinatorBridge.listModels(controlUrl), [{ name: 'model-a', servable: true }]);
    await coordinator.start('model-a');
    assert.equal(ensures, 1);
    assert.equal(releases, 1);
    const handleBurst = (coordinator as unknown as { handleBurst(events: Array<Record<string, unknown>>): Promise<void> }).handleBurst.bind(coordinator);
    await handleBurst([{ type: 'post', agent: 'user', message: 'coordinate this' }]);
    assert.equal(chats, 1);
    assert.ok(lastChatBody.tools && lastChatBody.tools.length > 0, 'coordinator completion must send board tools');
    for (const tool of lastChatBody.tools) {
        assert.equal(tool.type, 'function');
        assert.ok(tool.function.parameters, 'OpenAI-compatible tools must use function.parameters');
        assert.equal('inputSchema' in tool.function, false, 'MCP inputSchema key must not leak into provider payloads');
    }
    assert.equal(ensures, 2);
    assert.equal(releases, 1);
    assert.equal(board.getState().events.some(event => event.agent === 'forge-coordinator' && event.message === 'standing by'), true);
    await handleBurst([{ type: 'post', agent: 'user', message: 'coordinate another burst' }]);
    assert.equal(chats, 2);
    assert.equal(ensures, 2, 'a second burst must reuse the active coordinator hold');
    await wait(1_100);
    assert.equal(releases, 2);

    delayChat = true;
    const stoppedBurst = handleBurst([{ type: 'post', agent: 'user', message: 'long completion' }]);
    await wait(50);
    const commandId = board.postCommand('user', 'STOP - test halt', 'forge-coordinator');
    await (coordinator as unknown as { stopForBlockingCommand(): Promise<void> }).stopForBlockingCommand();
    await stoppedBurst;
    assert.equal(releases, 3, 'STOP must release the active coordinator hold immediately');
    assert.equal(board.getState().events.some(event =>
        event.type === 'ack' && event.agent === 'forge-coordinator' && event.meta?.command_id === commandId
    ), true);
});
