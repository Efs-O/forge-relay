import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildCodexMcpConfigBlock,
    CODEX_FORGERELAY_SAFE_AUTO_APPROVE_TOOLS,
    configureCodexMcpConfig,
    inspectCodexMcpApprovals,
} from '../src/codexMcpConfig';

test('generated Codex MCP config approves every safe lifecycle tool including release', () => {
    const block = buildCodexMcpConfigBlock('N:\\Relay\\out\\mcpStdio.js');
    assert.match(block, /args = \["N:\/Relay\/out\/mcpStdio\.js"\]/);
    for (const tool of CODEX_FORGERELAY_SAFE_AUTO_APPROVE_TOOLS) {
        assert.match(block, new RegExp(`tools\\.${tool}\\]`), tool);
    }
    assert.deepEqual(inspectCodexMcpApprovals(block), { missing: [], conflicts: [] });
    assert.doesNotMatch(block, /dispatch_subagent|run_build/);
});

test('configure updates an existing server with missing safe approval sections', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.toml');
    fs.writeFileSync(config, '[mcp_servers.forgerelay]\ncommand = "node"\nargs = ["old.js"]\n', 'utf8');
    const result = configureCodexMcpConfig(config, 'new.js');
    assert.equal(result.status, 'updated');
    const content = fs.readFileSync(config, 'utf8');
    assert.match(content, /args = \["old\.js"\]/, 'existing server entry remains untouched');
    assert.deepEqual(inspectCodexMcpApprovals(content), { missing: [], conflicts: [] });
    assert.equal(configureCodexMcpConfig(config, 'new.js').status, 'already');
});

test('configure refuses to overwrite a conflicting explicit approval policy', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.toml');
    fs.writeFileSync(config, '[mcp_servers.forgerelay]\ncommand="node"\n\n[mcp_servers.forgerelay.tools.release]\napproval_mode="prompt"\n', 'utf8');
    const result = configureCodexMcpConfig(config, 'mcp.js');
    assert.equal(result.status, 'error');
    assert.match(result.detail ?? '', /release.*refusing to overwrite/);
});
