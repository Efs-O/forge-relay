import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexMode } from '../src/types';

test('Codex mode migration accepts isolated mode and upgrades the 0.6.x exclusive value', () => {
    assert.equal(normalizeCodexMode('managed-isolated'), 'managed-isolated');
    assert.equal(normalizeCodexMode('managed-exclusive'), 'managed-isolated');
});

test('missing and unknown Codex modes fail safely to existing-session MCP', () => {
    assert.equal(normalizeCodexMode(undefined), 'mcp');
    assert.equal(normalizeCodexMode('future-mode'), 'mcp');
    assert.equal(normalizeCodexMode({}), 'mcp');
});
