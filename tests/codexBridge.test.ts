import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    parseArgs,
    extractCodexUsage,
    codexCostUsd,
} = require('../scripts/codex-auto-bridge.js');

test('Codex bridge defaults telemetry on with a .coordination path', () => {
    const args = parseArgs(['--repo-root', '.']);
    assert.equal(args.telemetry, true);
    assert.match(args.telemetryPath, /[\\/]\.coordination[\\/]codex-telemetry\.ndjson$/);
});

test('Codex bridge --telemetry false disables capture', () => {
    const args = parseArgs(['--repo-root', '.', '--telemetry', 'false']);
    assert.equal(args.telemetry, false);
    assert.equal(args.telemetryPath, '');
});

test('extractCodexUsage probes known usage field shapes', () => {
    const u = extractCodexUsage({
        usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300, total_tokens: 1500 },
    });
    assert.equal(u.inputTotal, 1200);
    assert.equal(u.cached, 1000);
    assert.equal(u.output, 300);
    assert.equal(u.total, 1500);
});

test('extractCodexUsage tolerates a missing usage block', () => {
    const u = extractCodexUsage({});
    assert.equal(u.inputTotal, null);
    assert.equal(u.cached, null);
    assert.equal(u.output, null);
});

test('codexCostUsd prices at Opus 4.8 rates: uncached input $5, cache-read $0.50, output $25 /1M', () => {
    // input_tokens (1.2M) includes 1M cached → 0.2M uncached @ $5 = $1.00
    //   + 1.0M cache-read @ $0.50 = $0.50
    //   + 0.3M output @ $25 = $7.50  → $9.00
    const cost = codexCostUsd({ inputTotal: 1_200_000, cached: 1_000_000, output: 300_000 });
    assert.equal(Math.round(cost * 100) / 100, 9.0);
});

test('codexCostUsd treats null fields as zero', () => {
    assert.equal(codexCostUsd({ inputTotal: null, cached: null, output: null }), 0);
});
