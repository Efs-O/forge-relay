import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Bridge } from '../src/bridge';
import { executeBoardTool } from '../src/boardTools';
import { SubagentBackends } from '../src/subagent';

const backends: SubagentBackends = { bridgeUrl: '', ollamaUrl: '', directUrl: '', defaultBackend: 'direct' };

test('shared board executor rejects empty posts', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bridge = new Bridge(root);

    assert.equal(await executeBoardTool(bridge, backends, 'post', { agent: 'forge-coordinator', note: '   ' }), 'ERROR: post note must not be empty');
    assert.equal(bridge.getState().events.length, 0);
});
