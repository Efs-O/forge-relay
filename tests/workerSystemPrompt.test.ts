import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/subagentLoop';

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
