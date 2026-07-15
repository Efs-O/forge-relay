import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveCodexExecutable } from '../src/codexExecutable';

const NODE = 'C:\\runtime\\node.exe';

test('Unix configured and default commands remain direct and shell-free', () => {
    assert.deepEqual(resolveCodexExecutable({ platform: 'linux' }), {
        executable: 'codex', argsPrefix: [], shell: false,
    });
    assert.deepEqual(resolveCodexExecutable({ platform: 'darwin', configuredExecutable: '/opt/codex' }), {
        executable: '/opt/codex', argsPrefix: [], shell: false,
    });
});

test('Windows native executable remains direct', () => {
    assert.deepEqual(resolveCodexExecutable({
        platform: 'win32', configuredExecutable: 'C:\\tools\\codex.exe', nodeExecutable: NODE,
    }), { executable: 'C:\\tools\\codex.exe', argsPrefix: [], shell: false });
});

test('Windows PATH resolution prefers native exe over npm shims', () => {
    const result = resolveCodexExecutable({
        platform: 'win32', nodeExecutable: NODE,
        where: () => ['C:\\npm\\codex.cmd', 'C:\\native\\codex.exe'],
        existsSync: () => false,
    });
    assert.deepEqual(result, { executable: 'C:\\native\\codex.exe', argsPrefix: [], shell: false });
});

test('Windows .cmd npm shim resolves to Node plus the installed Codex JS entry', () => {
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
    const script = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const result = resolveCodexExecutable({
        platform: 'win32', nodeExecutable: NODE, where: () => [shim],
        existsSync: candidate => path.win32.normalize(candidate) === path.win32.normalize(script),
    });
    assert.deepEqual(result, { executable: NODE, argsPrefix: [script], shell: false });
});

test('configured PowerShell shim uses the same shell-free npm resolution', () => {
    const shim = 'D:\\npm\\codex.ps1';
    const script = 'D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const result = resolveCodexExecutable({
        platform: 'win32', configuredExecutable: shim, nodeExecutable: NODE,
        where: () => { throw new Error('explicit shim must not query PATH'); },
        existsSync: candidate => path.win32.normalize(candidate) === path.win32.normalize(script),
    });
    assert.deepEqual(result, { executable: NODE, argsPrefix: [script], shell: false });
});

test('explicit Codex JS entry launches through Node without a shell', () => {
    const script = 'C:\\packages\\@openai\\codex\\bin\\codex.js';
    assert.deepEqual(resolveCodexExecutable({
        platform: 'win32', configuredExecutable: script, nodeExecutable: NODE, existsSync: value => value === script,
    }), { executable: NODE, argsPrefix: [script], shell: false });
});

test('unresolvable Windows shim fails with an actionable error', () => {
    assert.throws(() => resolveCodexExecutable({
        platform: 'win32', nodeExecutable: NODE,
        where: () => ['C:\\npm\\codex.cmd'], existsSync: () => false,
    }), /Cannot launch Codex safely.*Reinstall @openai\/codex.*codex\.exe/s);
});

test('PATH lookup failure fails closed instead of falling back to shell', () => {
    assert.throws(() => resolveCodexExecutable({
        platform: 'win32', nodeExecutable: NODE, where: () => { throw new Error('where denied'); },
    }), /Cannot launch Codex safely/);
});
