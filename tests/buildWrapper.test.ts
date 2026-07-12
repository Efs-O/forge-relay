import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bridge } from '../src/bridge';
import { runCoordinatedBuild } from '../src/buildWrapper';

function tempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forgerelay-build-test-'));
}

const node = JSON.stringify(process.execPath);

test('run_build refuses to run when no command is configured', async () => {
    const bridge = new Bridge(tempRepo());
    const result = await runCoordinatedBuild(bridge, {}, 'claude', '');
    assert.match(result, /no build command configured/);
});

test('run_build reports success on exit 0 and releases the claim', async () => {
    const bridge = new Bridge(tempRepo());
    const result = await runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "process.exit(0)"`, buildClaimTargets: ['dist'] },
        'claude',
        'build it',
    );
    assert.match(result, /build ok \(exit 0\)/);
    // The claim must be released — a second agent can claim the same target immediately after.
    assert.doesNotThrow(() => bridge.claim('codex', ['dist'], 60, 'now free'));
});

test('run_build reports a non-zero exit and still releases the claim', async () => {
    const bridge = new Bridge(tempRepo());
    const result = await runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "process.exit(1)"`, buildClaimTargets: ['dist'] },
        'claude',
        'build it',
    );
    assert.match(result, /build FAILED \(exit 1\)/);
    assert.doesNotThrow(() => bridge.claim('codex', ['dist'], 60, 'now free'));
});

test('run_build refuses to start when the claim is already held by another agent', async () => {
    const bridge = new Bridge(tempRepo());
    bridge.claim('codex', ['dist'], 60, 'already building');
    const result = await runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "process.exit(0)"`, buildClaimTargets: ['dist'] },
        'claude',
        'build it',
    );
    assert.match(result, /CLAIM DENIED/);
});

test('run_build refuses to start when blocked by an operator STOP', async () => {
    const bridge = new Bridge(tempRepo());
    bridge.postCommand('operator', 'STOP everything', 'all');
    const result = await runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "process.exit(0)"`, buildClaimTargets: ['dist'] },
        'claude',
        'build it',
    );
    assert.match(result, /BLOCKED/);
});

test('run_build stops an in-flight build on operator STOP and releases the claim', async () => {
    const bridge = new Bridge(tempRepo());
    const runPromise = runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "setTimeout(() => process.exit(0), 5000)"`, buildClaimTargets: ['dist'] },
        'claude',
        'long build',
    );
    // Give the child a moment to actually start before posting STOP.
    await new Promise(resolve => setTimeout(resolve, 200));
    bridge.postCommand('operator', 'STOP everything', 'all');
    const result = await runPromise;
    assert.match(result, /STOPPED by operator/);
    assert.doesNotThrow(() => bridge.claim('codex', ['dist'], 60, 'now free'));
});

test('run_build times out a build that exceeds the configured timeout', async () => {
    const bridge = new Bridge(tempRepo());
    const result = await runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "setTimeout(() => process.exit(0), 5000)"`, buildClaimTargets: ['dist'], buildTimeoutMs: 300 },
        'claude',
        'long build',
    );
    assert.match(result, /build TIMEOUT/);
    assert.doesNotThrow(() => bridge.claim('codex', ['dist'], 60, 'now free'));
});

test('run_build with no claim targets configured still runs and posts the result', async () => {
    const bridge = new Bridge(tempRepo());
    const result = await runCoordinatedBuild(
        bridge,
        { buildCommand: `${node} -e "process.exit(0)"` },
        'claude',
        '',
    );
    assert.match(result, /build ok \(exit 0\)/);
});
