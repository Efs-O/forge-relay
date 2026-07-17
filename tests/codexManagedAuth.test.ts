import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    configureManagedCodexSubscription,
    ManagedLoginTransport,
} from '../src/codexManagedAuth';
import { CodexManagedProfile } from '../src/codexManagedProfile';

const profile: CodexManagedProfile = {
    profileId: 'abc', root: '/isolated', home: '/isolated/home', sqliteHome: '/isolated/sqlite',
    env: { CODEX_HOME: '/isolated/home', CODEX_SQLITE_HOME: '/isolated/sqlite' },
};

class FakeTransport implements ManagedLoginTransport {
    started = false;
    closed = false;
    accountReads = 0;
    existingAccount: Record<string, unknown> | null = null;
    completedAccount: Record<string, unknown> | null = { type: 'chatgpt', planType: 'plus' };
    loginResult: Record<string, unknown> = {
        type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/codex/login?test=1',
    };
    complete = true;
    requests: Array<{ method: string; params?: unknown }> = [];
    notifications: Array<{ method: string; params?: unknown }> = [];
    listeners = new Set<(notification: { method: string; params?: unknown }) => void>();

    async start(): Promise<void> { this.started = true; }
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
        this.requests.push({ method, params });
        if (method === 'initialize') return {} as T;
        if (method === 'account/read') {
            const account = this.accountReads++ === 0 ? this.existingAccount : this.completedAccount;
            return { account, requiresOpenaiAuth: true } as T;
        }
        if (method === 'account/login/start') {
            if (this.complete) queueMicrotask(() => this.emit('account/login/completed', {
                loginId: this.loginResult.loginId, success: true, error: null,
            }));
            return this.loginResult as T;
        }
        if (method === 'account/login/cancel') return {} as T;
        throw new Error(`Unexpected request ${method}`);
    }
    async notify(method: string, params?: unknown): Promise<void> { this.notifications.push({ method, params }); }
    onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async close(): Promise<void> { this.closed = true; }
    emit(method: string, params?: unknown): void {
        for (const listener of this.listeners) listener({ method, params });
    }
}

function configure(transport: FakeTransport, openExternal = async () => true, timeoutMs?: number) {
    return configureManagedCodexSubscription({
        profile, cwd: '/repo', transportFactory: () => transport, openExternal, timeoutMs,
    });
}

test('existing isolated ChatGPT login is accepted without opening a browser', async () => {
    const transport = new FakeTransport();
    transport.existingAccount = { type: 'chatgpt', planType: 'pro' };
    let opened = false;
    const result = await configure(transport, async () => { opened = true; return true; });
    assert.deepEqual(result, {
        ok: true, planType: 'pro', message: 'Isolated managed Codex is already signed in with ChatGPT.',
    });
    assert.equal(opened, false);
    assert.equal(transport.closed, true);
    assert.deepEqual(transport.requests.map(value => value.method), ['initialize', 'account/read']);
});

test('browser flow requests ChatGPT-managed auth and verifies the resulting subscription', async () => {
    const transport = new FakeTransport();
    let opened = '';
    const states: string[] = [];
    const result = await configureManagedCodexSubscription({
        profile, cwd: '/repo', transportFactory: () => transport,
        openExternal: async url => { opened = url; return true; },
        onState: state => states.push(state),
    });
    assert.equal(result.ok, true);
    assert.equal(result.planType, 'plus');
    assert.equal(opened, transport.loginResult.authUrl);
    const login = transport.requests.find(value => value.method === 'account/login/start');
    assert.deepEqual(login?.params, {
        type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex',
    });
    assert.deepEqual(transport.notifications, [{ method: 'initialized', params: {} }]);
    assert.equal(states.some(value => /browser/i.test(value)), true);
    assert.equal(transport.closed, true);
});

test('non-OpenAI auth URL is rejected and the pending login is cancelled', async () => {
    const transport = new FakeTransport();
    transport.loginResult.authUrl = 'https://attacker.example/login';
    let opened = false;
    const result = await configure(transport, async () => { opened = true; return true; });
    assert.equal(result.ok, false);
    assert.equal(opened, false);
    assert.equal(transport.requests.some(value => value.method === 'account/login/cancel'), true);
    assert.equal(transport.closed, true);
});

test('browser refusal cancels the matching login without exposing its URL', async () => {
    const transport = new FakeTransport();
    const result = await configure(transport, async () => false);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('chatgpt.com'), false);
    const cancel = transport.requests.find(value => value.method === 'account/login/cancel');
    assert.deepEqual(cancel?.params, { loginId: 'login-1' });
});

test('login timeout is bounded, redacted, cancelled, and closes the app-server', async () => {
    const transport = new FakeTransport();
    transport.complete = false;
    const result = await configure(transport, async () => true, 1);
    assert.deepEqual(result, {
        ok: false, message: 'ChatGPT sign-in timed out. Run the configuration command to try again.',
    });
    assert.equal(transport.requests.some(value => value.method === 'account/login/cancel'), true);
    assert.equal(transport.closed, true);
});

test('API-key profile is replaced only after successful ChatGPT login verification', async () => {
    const transport = new FakeTransport();
    transport.existingAccount = { type: 'apiKey' };
    const result = await configure(transport);
    assert.equal(result.ok, true);
    assert.equal(transport.requests.some(value => value.method === 'account/login/start'), true);
    assert.equal(transport.accountReads, 2);
});

test('transport failures expose only a fixed error kind, never OAuth diagnostics', async () => {
    const transport = new FakeTransport();
    transport.start = async () => { throw new Error('https://chatgpt.com/login?secret=oauth-secret'); };
    const logs: string[] = [];
    const result = await configureManagedCodexSubscription({
        profile, cwd: '/repo', transportFactory: () => transport, openExternal: async () => true,
        onLog: value => logs.push(value),
    });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify({ result, logs }).includes('oauth-secret'), false);
    assert.deepEqual(logs, ['Managed Codex subscription login failed: Error']);
});
