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

test('coordinator validates, re-ensures for an event burst, and idle-releases', async (t) => {
    let ensures = 0, releases = 0, chats = 0;
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/ensure') { ensures++; res.end(JSON.stringify({ baseUrl: 'http://unused/v1', model: 'model-a', backend: 'llamacpp' })); return; }
        if (req.url === '/release') { releases++; res.end(JSON.stringify({ released: true })); return; }
        if (req.url === '/chat') { chats++; res.end(JSON.stringify({ choices: [{ message: { content: 'standing by' } }] })); return; }
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
        eventsPath: board.getEventsPath(), repoRoot: root, extensionVersion: 'test', idleReleaseMs: 40,
    });
    t.after(() => void coordinator.stop());

    assert.deepEqual(await ForgeCoordinatorBridge.listModels(controlUrl), [{ name: 'model-a', servable: true }]);
    await coordinator.start('model-a');
    assert.equal(ensures, 1);
    assert.equal(releases, 1);
    board.post('user', 'coordinate this');
    await wait(750);
    assert.equal(chats, 1);
    assert.equal(ensures, 2);
    assert.equal(releases, 2);
});
