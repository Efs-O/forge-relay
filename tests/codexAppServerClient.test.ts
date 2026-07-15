import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import {
    buildCodexAppServerArgs,
    CodexAppServerClient,
    CodexRequestTimeoutError,
    CodexRpcError,
    CodexTransportClosedError,
    encodeTomlValue,
} from '../src/codexAppServerClient';

const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'fake-codex-app-server.js');
const activeClients = new Set<CodexAppServerClient>();

afterEach(async () => {
    const clients = [...activeClients];
    activeClients.clear();
    await Promise.all(clients.map(instance => instance.close()));
});

function client(overrides: ConstructorParameters<typeof CodexAppServerClient>[0] = {}): CodexAppServerClient {
    const instance = new CodexAppServerClient({
        executable: process.execPath,
        executableArgsPrefix: [fixture],
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
        ...overrides,
    });
    activeClients.add(instance);
    return instance;
}

function notification(
    instance: CodexAppServerClient,
    method: string,
    timeoutMs = 1_000,
): Promise<{ method: string; params?: unknown }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            dispose();
            reject(new Error(`notification ${method} timed out`));
        }, timeoutMs);
        const dispose = instance.onNotification(value => {
            if (value.method !== method) { return; }
            clearTimeout(timer);
            dispose();
            resolve(value);
        });
    });
}

test('TOML and argv encoding preserve Windows paths, spaces, quotes, and backslashes', () => {
    const windowsPath = 'N:\\vs code apps\\forge-relay\\out\\mcpStdio.js';
    assert.equal(encodeTomlValue(windowsPath), '"N:\\\\vs code apps\\\\forge-relay\\\\out\\\\mcpStdio.js"');
    assert.equal(encodeTomlValue({ PLAIN: 'a b', 'ODD.KEY': 'say "hi"' }), '{PLAIN="a b","ODD.KEY"="say \\"hi\\""}');
    const args = buildCodexAppServerArgs({
        'mcp_servers.forgerelay.command': 'node',
        'mcp_servers.forgerelay.args': [windowsPath, '--repoRoot', 'N:\\vs code apps\\forge-relay'],
        'mcp_servers.forgerelay.env': { FORGERELAY_REPO_ROOT: 'N:\\vs code apps\\forge-relay' },
        'mcp_servers.forgerelay.required': true,
    });
    assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
    assert.equal(args[3], '-c');
    assert.equal(args[4], 'mcp_servers.forgerelay.command="node"');
    assert.match(args[6], /^mcp_servers\.forgerelay\.args=\["N:\\\\vs code apps/);
    assert.equal(args.at(-1), 'mcp_servers.forgerelay.required=true');
    assert.throws(() => buildCodexAppServerArgs({ 'bad key': true }));
    assert.throws(() => encodeTomlValue(Number.NaN));
});

test('spawn receives an argv array and defaults to shell false', async () => {
    let seenCommand = '';
    let seenArgs: string[] = [];
    let seenShell: unknown;
    const instance = client({
        configOverrides: { 'mcp_servers.forgerelay.command': 'node with spaces' },
        spawnChild: (command, args, options) => {
            seenCommand = command;
            seenArgs = [...args];
            seenShell = options.shell;
            return require('node:child_process').spawn(command, args, options);
        },
    });
    await instance.start();
    assert.equal(seenCommand, process.execPath);
    assert.equal(seenShell, false);
    assert.deepEqual(seenArgs.slice(0, 4), [fixture, 'app-server', '--listen', 'stdio://']);
    assert.ok(seenArgs.includes('mcp_servers.forgerelay.command="node with spaces"'));
    await instance.close();
});

test('correlates out-of-order responses and decodes split UTF-8 JSONL records', async () => {
    const instance = client();
    await instance.start();
    const slow = instance.request<string>('test/echo', { delayMs: 30, value: 'slow' });
    const fast = instance.request<string>('test/echo', { delayMs: 1, value: 'fast' });
    assert.equal(await fast, 'fast');
    assert.equal(await slow, 'slow');
    assert.deepEqual(await instance.request('test/partial'), { text: 'split 🚀 payload' });
    await instance.close();
});

test('dispatches notifications assembled from partial lines', async () => {
    const instance = client();
    await instance.start();
    const progress = notification(instance, 'test/progress');
    await instance.request('test/notification');
    assert.deepEqual((await progress).params, { value: 7 });
    await instance.close();
});

test('rejects unexpected server requests with a safe method-not-found response', async () => {
    const instance = client();
    await instance.start();
    const response = notification(instance, 'test/serverResponse');
    await instance.request('test/serverRequest');
    const params = (await response).params as { id: string; error: { code: number; message: string } };
    assert.equal(params.id, 'server-1');
    assert.equal(params.error.code, -32601);
    assert.match(params.error.message, /Unsupported server request/);
    await instance.close();
});

test('handles explicitly supported server requests and sanitizes handler failures', async () => {
    let fail = false;
    const instance = client({
        handleServerRequest: request => {
            assert.equal(request.method, 'item/tool/requestUserInput');
            if (fail) { throw new Error('secret handler detail'); }
            return { accepted: false };
        },
    });
    await instance.start();
    let response = notification(instance, 'test/serverResponse');
    await instance.request('test/serverRequest');
    let params = (await response).params as { result: unknown };
    assert.deepEqual(params.result, { accepted: false });

    fail = true;
    response = notification(instance, 'test/serverResponse');
    await instance.request('test/serverRequest');
    params = (await response).params as { result: unknown };
    assert.equal((params as unknown as { error: { code: number; message: string } }).error.code, -32603);
    assert.equal((params as unknown as { error: { message: string } }).error.message, 'Server request handler failed.');
    await instance.close();
});

test('surfaces JSON-RPC errors and request timeouts with typed errors', async () => {
    const instance = client();
    await instance.start();
    await assert.rejects(instance.request('test/error'), (error: unknown) => {
        assert.ok(error instanceof CodexRpcError, `unexpected error: ${String(error)}`);
        assert.equal(error.code, 451);
        assert.deepEqual(error.data, { safe: true });
        return true;
    });
    await assert.rejects(instance.request('test/hang', undefined, 30), CodexRequestTimeoutError);
    await instance.close();
});

test('reports malformed records without losing subsequent valid responses', async () => {
    const errors: Error[] = [];
    const instance = client({ onProtocolError: error => errors.push(error) });
    await instance.start();
    assert.deepEqual(await instance.request('test/malformed'), { recovered: true });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /malformed JSON/);
    await instance.close();
});

test('bounds oversized protocol lines and resumes at the next JSONL record', async () => {
    const errors: Error[] = [];
    const instance = client({
        maxProtocolLineBytes: 128,
        onProtocolError: error => errors.push(error),
    });
    await instance.start();
    assert.deepEqual(await instance.request('test/oversized'), { recovered: true });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /oversized JSONL/);
    await instance.close();
});

test('stderr capture is bounded to the configured tail', async () => {
    const instance = client({ maxStderrBytes: 32 });
    await instance.start();
    await instance.request('test/stderr', { bytes: 200 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(Buffer.byteLength(instance.getStderrTail()), 32);
    assert.equal(instance.getStderrTail(), 'x'.repeat(32));
    await instance.close();
});

test('child exit rejects pending requests and emits exit metadata', async () => {
    const exits: Array<{ code: number | null }> = [];
    const instance = client({ onExit: exit => exits.push(exit) });
    await instance.start();
    const pending = instance.request('test/exit');
    await assert.rejects(pending, CodexTransportClosedError);
    assert.equal(exits[0]?.code, 23);
    assert.equal(instance.running, false);
});

test('close escalates to the injected process-tree killer after a grace period', async () => {
    let killed: ChildProcess | null = null;
    const instance = client({
        env: { ...process.env, FAKE_CODEX_HOLD_OPEN: '1' },
        shutdownTimeoutMs: 25,
        killProcessTree: child => {
            killed = child;
            child.kill('SIGKILL');
        },
    });
    await instance.start();
    await instance.close();
    assert.ok(killed);
});
