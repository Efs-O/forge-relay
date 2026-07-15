import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnixRows, parseWindowsRows, probeCodexAppServers, ProcessCommandRunner } from '../src/codexProcessProbe';

function runner(result: ReturnType<ProcessCommandRunner>): ProcessCommandRunner {
    return () => result;
}

test('Windows probe blocks on an external app-server and ignores exact owned PID', () => {
    const stdout = JSON.stringify([
        { pid: 100, commandLine: 'C:\\tools\\codex.exe app-server --listen stdio://' },
        { pid: 200, commandLine: 'C:\\tools\\codex.exe exec -' },
    ]);
    const blocked = probeCodexAppServers({ platform: 'win32', runner: runner({ status: 0, stdout }) });
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.pids, [100]);
    assert.equal(blocked.detail.includes('C:\\tools'), false, 'details must not expose command lines');

    const clear = probeCodexAppServers({ platform: 'win32', ownedChildPid: 100, runner: runner({ status: 0, stdout }) });
    assert.equal(clear.status, 'clear');
});

test('Unix probe recognizes native and npm-shim app-server command lines', () => {
    const stdout = [
        ' 11 /usr/bin/codex app-server --listen stdio://',
        ' 12 node /opt/@openai/codex/bin/codex.js app-server --listen stdio://',
        ' 13 /usr/bin/codex exec -',
    ].join('\n');
    const result = probeCodexAppServers({ platform: 'linux', runner: runner({ status: 0, stdout }) });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.pids, [11, 12]);
    assert.equal(result.detail.includes('/opt/'), false);
});

test('empty process list is clear', () => {
    assert.equal(probeCodexAppServers({ platform: 'linux', runner: runner({ status: 0, stdout: '' }) }).status, 'clear');
    assert.deepEqual(parseWindowsRows(''), []);
    assert.deepEqual(parseUnixRows(''), []);
});

test('malformed output, command errors, and nonzero exits fail closed', () => {
    assert.equal(probeCodexAppServers({ platform: 'win32', runner: runner({ status: 0, stdout: '{bad' }) }).status, 'unknown');
    assert.equal(probeCodexAppServers({ platform: 'linux', runner: runner({ status: 0, stdout: 'not ps output' }) }).status, 'unknown');
    assert.equal(probeCodexAppServers({ platform: 'linux', runner: runner({ status: 1, stderr: 'secret path' }) }).status, 'unknown');
    const failed = probeCodexAppServers({
        platform: 'linux',
        runner: runner({ status: null, error: Object.assign(new Error('secret path'), { code: 'ETIMEDOUT' }) }),
    });
    assert.equal(failed.status, 'unknown');
    assert.equal(failed.detail.includes('secret'), false);
});

test('parsers reject partially malformed rows instead of overlooking contention', () => {
    assert.equal(parseWindowsRows('[{"pid":5,"commandLine":null}]'), null);
    assert.equal(parseUnixRows('5 codex app-server\nmalformed'), null);
});
