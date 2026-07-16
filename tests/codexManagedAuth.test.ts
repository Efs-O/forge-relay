import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { configureManagedCodexApiKey, ManagedAuthChild, ManagedAuthSpawn } from '../src/codexManagedAuth';
import { CodexManagedProfile } from '../src/codexManagedProfile';

const profile: CodexManagedProfile = {
    profileId: 'abc', root: '/isolated', home: '/isolated/home', sqliteHome: '/isolated/sqlite',
    env: { CODEX_HOME: '/isolated/home', CODEX_SQLITE_HOME: '/isolated/sqlite' },
};

class FakeChild extends EventEmitter implements ManagedAuthChild {
    input = '';
    killed = false;
    stdin = { end: (data = '') => { this.input += data; } };
    stdout = { on: (_event: 'data', _listener: (chunk: unknown) => void) => undefined };
    stderr = { on: (_event: 'data', _listener: (chunk: unknown) => void) => undefined };
    kill(): boolean { this.killed = true; return true; }
}

test('API key reaches login only through stdin with isolated environment and shell false', async () => {
    const secret = 'sk-test-super-secret';
    const child = new FakeChild();
    let invocation: { executable: string; args: readonly string[]; options: Parameters<ManagedAuthSpawn>[2] } | undefined;
    const spawn: ManagedAuthSpawn = (executable, args, options) => {
        invocation = { executable, args, options };
        queueMicrotask(() => child.emit('close', 0));
        return child;
    };
    const result = await configureManagedCodexApiKey({
        profile, apiKey: secret, configuredExecutable: 'codex-custom', spawn,
        baseEnv: { PATH: '/bin', OPENAI_API_KEY: secret, ACCIDENTAL_COPY: secret },
        resolveExecutable: options => ({ executable: '/node', argsPrefix: ['/codex.js', options.configuredExecutable!], shell: false }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(invocation!.args, [
        '/codex.js', 'codex-custom', 'login',
        '-c', 'sqlite_home="/isolated/sqlite"',
        '-c', 'cli_auth_credentials_store="file"',
        '--with-api-key',
    ]);
    assert.equal(invocation!.options.shell, false);
    assert.deepEqual(invocation!.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(invocation!.options.env!.CODEX_HOME, profile.home);
    assert.equal(invocation!.options.env!.CODEX_SQLITE_HOME, profile.sqliteHome);
    assert.equal(Object.values(invocation!.options.env!).includes(secret), false);
    assert.equal(JSON.stringify(invocation).includes(secret), false);
    assert.equal(child.input, `${secret}\n`);
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test('spawn errors and nonzero exits return fixed redacted failures', async () => {
    const secret = 'sk-secret-in-error';
    for (const event of ['error', 'close'] as const) {
        const child = new FakeChild();
        const promise = configureManagedCodexApiKey({
            profile, apiKey: secret, spawn: () => {
                queueMicrotask(() => event === 'error'
                    ? child.emit('error', new Error(secret))
                    : child.emit('close', 1));
                return child;
            },
            resolveExecutable: () => ({ executable: 'codex', argsPrefix: [], shell: false }),
        });
        const result = await promise;
        assert.equal(result.ok, false);
        assert.equal(JSON.stringify(result).includes(secret), false);
    }
});

test('a supplied shell-free launch spec is used without invoking the resolver', async () => {
    const child = new FakeChild();
    let executable = '';
    let args: readonly string[] = [];
    const result = await configureManagedCodexApiKey({
        profile, apiKey: 'sk-direct', launchSpec: { executable: '/safe/codex', argsPrefix: ['prefix'], shell: false },
        resolveExecutable: () => { throw new Error('must not resolve twice'); },
        spawn: (value, values) => {
            executable = value; args = values;
            queueMicrotask(() => child.emit('close', 0));
            return child;
        },
    });
    assert.equal(result.ok, true);
    assert.equal(executable, '/safe/codex');
    assert.deepEqual(args, [
        'prefix', 'login',
        '-c', 'sqlite_home="/isolated/sqlite"',
        '-c', 'cli_auth_credentials_store="file"',
        '--with-api-key',
    ]);
});

test('login timeout is bounded, kills the child, and reports no secret', async () => {
    const child = new FakeChild();
    const result = await configureManagedCodexApiKey({
        profile, apiKey: 'sk-timeout-secret', timeoutMs: 1, spawn: () => child,
        resolveExecutable: () => ({ executable: 'codex', argsPrefix: [], shell: false }),
    });
    assert.equal(result.timedOut, true);
    assert.equal(child.killed, true);
    assert.equal(JSON.stringify(result).includes('sk-timeout-secret'), false);
});
