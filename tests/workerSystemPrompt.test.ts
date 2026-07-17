import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitCheckpoint, systemPrompt } from '../src/subagentLoop';

// Locks the worker-prompt invariant: every worker dispatch sends a non-empty
// system message as messages[0], for BOTH autonomy modes. Any OpenAI-compatible
// serving layer in front of the model may treat "no system message" as license
// to inject its own role prompt, so an empty prompt here would silently hand the
// worker the wrong instructions. (Historically this guarded the Forge Python
// bridge's bridge.yaml injection; that bridge is gone, but the invariant stays.)
for (const autonomy of ['draft', 'clanker'] as const) {
    test(`systemPrompt(${autonomy}) is a non-empty, non-whitespace string`, () => {
        const prompt = systemPrompt(autonomy);
        assert.equal(typeof prompt, 'string');
        assert.ok(prompt.trim().length > 0, 'worker system prompt must not be empty/whitespace');
    });
}

test('systemPrompt differs between draft and clanker (capability line present)', () => {
    const draft = systemPrompt('draft');
    const clanker = systemPrompt('clanker');
    assert.notEqual(draft, clanker);
    assert.match(draft, /DRAFT mode/);
    assert.match(clanker, /write, edit, and run/);
});

test('systemPrompt exposes the platform and shell-free argv contract', () => {
    const prompt = systemPrompt('clanker', 'C:\\workspace\\forge-relay');
    assert.match(prompt, /repo_root=C:\\workspace\\forge-relay/);
    assert.match(prompt, new RegExp(`platform=${process.platform}`));
    assert.match(prompt, /executable-plus-argv/);
    assert.match(prompt, /no shell operators/);
});

test('git checkpoint never recommends repository-wide restore', () => {
    const checkpoint = gitCheckpoint(process.cwd());
    assert.doesNotMatch(checkpoint, /git restore \.|reset --hard|git clean/i);
    assert.match(checkpoint, /restore only worker-owned paths/i);
});
