import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RuntimeManager } from '../src/runtimeManager';
import { subagentEnvFromBackends, SubagentBackends } from '../src/subagent';
import { Bridge } from '../src/bridge';
import { resolveStdioSubagentBackends } from '../src/stdioBackends';

const BACKENDS: SubagentBackends = {
    bridgeUrl: '',
    ollamaUrl: 'http://127.0.0.1:11434/v1',
    directUrl: 'http://127.0.0.1:8080/v1',
    defaultBackend: 'ollama',
    forgeControlUrl: 'http://127.0.0.1:8799',
    defaultRunMode: 'async',
};

test('subagentEnvFromBackends mirrors set values and omits empty ones', () => {
    const env = subagentEnvFromBackends(BACKENDS);
    assert.equal(env.FORGERELAY_FORGE_CONTROL_URL, 'http://127.0.0.1:8799');
    assert.equal(env.FORGERELAY_OLLAMA_URL, 'http://127.0.0.1:11434/v1');
    assert.equal(env.FORGERELAY_DIRECT_URL, 'http://127.0.0.1:8080/v1');
    assert.equal(env.FORGERELAY_DEFAULT_BACKEND, 'ollama');
    assert.equal(env.FORGERELAY_DEFAULT_MODE, 'async');
    // bridgeUrl '' (route off) and bridgeApiKey unset must not appear at all.
    assert.equal('FORGERELAY_BRIDGE_URL' in env, false);
    assert.equal('FORGERELAY_BRIDGE_API_KEY' in env, false);
});

test('standalone stdio discovers Forge control when the environment omits it', async () => {
    const resolved = await resolveStdioSubagentBackends({
        FORGERELAY_OLLAMA_URL: 'http://ollama/v1',
    }, async explicit => ({
        url: explicit || 'http://127.0.0.1:8799',
        source: explicit ? 'setting' : 'registry',
        detail: 'test discovery',
    }));
    assert.equal(resolved.backends.forgeControlUrl, 'http://127.0.0.1:8799');
    assert.equal(resolved.backends.ollamaUrl, 'http://ollama/v1');
    assert.equal(resolved.forge.source, 'registry');
});

test('standalone stdio keeps an explicit Forge control environment override', async () => {
    const resolved = await resolveStdioSubagentBackends({
        FORGERELAY_FORGE_CONTROL_URL: 'http://127.0.0.1:9900',
    }, async explicit => ({ url: explicit, source: 'setting', detail: 'explicit' }));
    assert.equal(resolved.backends.forgeControlUrl, 'http://127.0.0.1:9900');
    assert.equal(resolved.forge.source, 'setting');
});

function makeManager(repoRoot: string, subagentEnv?: Record<string, string>): RuntimeManager {
    return new RuntimeManager({
        claudeScriptPath: path.join(repoRoot, 'claude-auto-bridge.js'),
        mcpStdioPath: path.join(repoRoot, 'out', 'mcpStdio.js'),
        extensionVersion: 'test',
        bridge: new Bridge(repoRoot),
        subagentBackends: { ...BACKENDS, forgeControlUrl: undefined },
        mcpUrl: 'http://127.0.0.1:7878/sse',
        repoRoot,
        eventsPath: path.join(repoRoot, '.coordination', 'events.ndjson'),
        subagentEnv,
    });
}

function readMcpConfig(repoRoot: string): { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, '.mcp.json'), 'utf8'));
}

test('ensureClaudeMcpConfig injects the FORGERELAY_* env block into the managed entry', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-mcpenv-'));
    try {
        const env = subagentEnvFromBackends(BACKENDS);
        // setRoster(claude, Mode A) is the path that self-heals .mcp.json.
        makeManager(repoRoot, env).setRoster({ claude: true, codex: false }, 'A');

        const entry = readMcpConfig(repoRoot).mcpServers.forgerelay;
        assert.ok(entry, '.mcp.json must gain a forgerelay entry');
        assert.deepEqual(entry.env, env);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('ensureClaudeMcpConfig omits the env block entirely when no settings map to env vars', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-mcpenv-'));
    try {
        makeManager(repoRoot, {}).setRoster({ claude: true, codex: false }, 'A');
        const entry = readMcpConfig(repoRoot).mcpServers.forgerelay;
        assert.ok(entry);
        assert.equal('env' in entry, false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('ensureClaudeMcpConfig rewrites a stale entry when the env block changes', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-mcpenv-'));
    try {
        makeManager(repoRoot, {}).setRoster({ claude: true, codex: false }, 'A');
        assert.equal('env' in readMcpConfig(repoRoot).mcpServers.forgerelay, false);

        const env = subagentEnvFromBackends(BACKENDS);
        makeManager(repoRoot, env).setRoster({ claude: true, codex: false }, 'A');
        assert.deepEqual(readMcpConfig(repoRoot).mcpServers.forgerelay.env, env);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
