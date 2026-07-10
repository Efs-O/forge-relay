import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isCodexModel, codexModelOverride, buildCodexArgs, buildCodexPrompt, probeCodexCli,
} from '../src/codexWorker';
import { subagentEnvFromBackends, DEFAULT_SUBAGENT_BACKENDS } from '../src/subagent';

// ── model id routing ─────────────────────────────────────────────────────────

test('isCodexModel matches "codex" and "codex:<model>" only', () => {
    assert.ok(isCodexModel('codex'));
    assert.ok(isCodexModel('CODEX'));
    assert.ok(isCodexModel('codex:gpt-5.5-codex'));
    assert.ok(isCodexModel('  codex  '));
    // Must NOT swallow other backends or ollama-style colon ids.
    assert.ok(!isCodexModel('gemma4:31b-cloud'));
    assert.ok(!isCodexModel('forge:gemma4-12b'));
    assert.ok(!isCodexModel('ollama:codex')); // an (unlikely) local model named codex
    assert.ok(!isCodexModel('codexish-model'));
});

test('codexModelOverride returns the suffix or undefined', () => {
    assert.equal(codexModelOverride('codex'), undefined);
    assert.equal(codexModelOverride('codex:'), undefined);
    assert.equal(codexModelOverride('codex:gpt-5.5-codex'), 'gpt-5.5-codex');
});

// ── argv construction ────────────────────────────────────────────────────────

test('buildCodexArgs: sandboxed, stdin prompt, last-message capture', () => {
    const args = buildCodexArgs({ sandbox: 'read-only', lastMessagePath: '/tmp/x.txt' });
    assert.deepEqual(args, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', '/tmp/x.txt', '-']);
});

test('buildCodexArgs includes -m only when a model override is given', () => {
    const withModel = buildCodexArgs({ model: 'gpt-5.5-codex', sandbox: 'workspace-write', lastMessagePath: 'o.txt' });
    assert.ok(withModel.includes('-m'));
    assert.equal(withModel[withModel.indexOf('-m') + 1], 'gpt-5.5-codex');
    const without = buildCodexArgs({ sandbox: 'workspace-write', lastMessagePath: 'o.txt' });
    assert.ok(!without.includes('-m'));
});

test('buildCodexArgs never bypasses the sandbox', () => {
    for (const sandbox of ['read-only', 'workspace-write']) {
        const args = buildCodexArgs({ sandbox, lastMessagePath: 'o.txt' });
        assert.ok(!args.includes('--yolo'));
        assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    }
});

// ── prompt composition ───────────────────────────────────────────────────────

test('buildCodexPrompt carries task, context and the read-only warning', () => {
    const p = buildCodexPrompt('fix the bug', 'see src/x.ts', 'read-only');
    assert.match(p, /READ-ONLY/);
    assert.match(p, /TASK:\nfix the bug/);
    assert.match(p, /CONTEXT:\nsee src\/x\.ts/);
});

test('buildCodexPrompt omits the context block when none is given', () => {
    const p = buildCodexPrompt('do it', undefined, 'workspace-write');
    assert.ok(!p.includes('CONTEXT:'));
    assert.match(p, /edit files and run commands/);
});

// ── CLI probe ────────────────────────────────────────────────────────────────

test('probeCodexCli fails cleanly for a nonexistent executable', () => {
    const probe = probeCodexCli('definitely-not-a-real-codex-cli-xyz');
    assert.equal(probe.ok, false);
    assert.ok(probe.detail.length > 0);
});

// ── env plumbing (stdio server parity) ───────────────────────────────────────

test('subagentEnvFromBackends mirrors the codex worker settings', () => {
    const env = subagentEnvFromBackends({
        ...DEFAULT_SUBAGENT_BACKENDS,
        codexExecutable: 'C:/tools/codex.cmd',
        codexTimeoutMs: 120000,
    });
    assert.equal(env.FORGERELAY_CODEX_EXECUTABLE, 'C:/tools/codex.cmd');
    assert.equal(env.FORGERELAY_CODEX_TIMEOUT_MS, '120000');
    const bare = subagentEnvFromBackends({ ...DEFAULT_SUBAGENT_BACKENDS });
    assert.ok(!('FORGERELAY_CODEX_EXECUTABLE' in bare));
    assert.ok(!('FORGERELAY_CODEX_TIMEOUT_MS' in bare));
});
