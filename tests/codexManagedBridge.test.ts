import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CodexAppServerAdapter,
    CodexManagedBridge,
    CodexManagedBoard,
    CodexManagedLease,
    classifyCodexManagedFailure,
} from '../src/codexManagedBridge';
import { BoardEvent, Command } from '../src/types';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string, timeout = 1_000): Promise<void> {
    const end = Date.now() + timeout;
    while (!check()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
        await wait(5);
    }
}

class FakeClient implements CodexAppServerAdapter {
    started = false;
    closed = false;
    childPid = 4321;
    requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    notifications: Array<{ method: string; params: unknown }> = [];
    account: Record<string, unknown> = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    turnCounter = 0;
    onInterrupt?: (params: Record<string, unknown>) => void;
    onTurnStart?: (turnId: string, params: Record<string, unknown>) => void;
    private notificationListeners = new Set<(notification: { method: string; params?: unknown }) => void>();
    private closeListeners = new Set<(error?: Error) => void>();
    private requestListener?: (method: string, params: Record<string, unknown>) => Promise<unknown>;

    async start(): Promise<void> { this.started = true; }
    async request<T>(method: string, rawParams?: unknown): Promise<T> {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        this.requests.push({ method, params });
        if (method === 'initialize') return {} as T;
        if (method === 'account/read') return this.account as T;
        if (method === 'thread/start') return { thread: { id: `thread-${this.childPid}` } } as T;
        if (method === 'turn/start') {
            const turnId = `turn-${++this.turnCounter}`;
            this.onTurnStart?.(turnId, params);
            return { turn: { id: turnId } } as T;
        }
        if (method === 'turn/interrupt') {
            this.onInterrupt?.(params);
            return {} as T;
        }
        return {} as T;
    }
    notify(method: string, params?: unknown): void { this.notifications.push({ method, params }); }
    onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void {
        this.notificationListeners.add(listener);
        return () => this.notificationListeners.delete(listener);
    }
    onServerRequest(listener: (method: string, params: Record<string, unknown>) => Promise<unknown>): () => void {
        this.requestListener = listener;
        return () => { this.requestListener = undefined; };
    }
    onClose(listener: (error?: Error) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }
    async serverRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        if (!this.requestListener) throw new Error('no server request listener');
        return this.requestListener(method, params);
    }
    emit(method: string, params: Record<string, unknown>): void {
        for (const listener of this.notificationListeners) listener({ method, params });
    }
    crash(error = new Error('transport closed')): void {
        for (const listener of this.closeListeners) listener(error);
    }
    close(): void { this.closed = true; }
}

class FakeBoard implements CodexManagedBoard {
    commands: Command[] = [];
    posts: string[] = [];
    acks: string[] = [];
    autonomy: 'draft' | 'clanker' = 'draft';
    getBlockingCommands(): Command[] { return this.commands.filter(command => command.status !== 'resolved'); }
    getAutonomyMode(): 'draft' | 'clanker' { return this.autonomy; }
    ack(_agent: string, commandId: string): void { this.acks.push(commandId); }
    post(_agent: string, message: string): void { this.posts.push(message); }
}

class FakeLease implements CodexManagedLease {
    acquired = 0;
    released = 0;
    childPid?: number;
    result: 'acquired' | 'held-by-live-other' = 'acquired';
    tryAcquire(): 'acquired' | 'held-by-live-other' { this.acquired++; return this.result; }
    markBridgeStarted(childPid?: number): void { this.childPid = childPid; }
    releaseIfOwned(): void { this.released++; }
}

function event(agent: string, message: string): BoardEvent {
    return { timestamp: new Date().toISOString(), type: 'post', agent, paths: [], message };
}

function append(eventsPath: string, ...events: BoardEvent[]): void {
    fs.appendFileSync(eventsPath, events.map(value => JSON.stringify(value)).join('\n') + '\n');
}

function fixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-managed-'));
    const eventsPath = path.join(root, 'events.ndjson');
    fs.writeFileSync(eventsPath, '');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const board = new FakeBoard();
    const lease = new FakeLease();
    const clients: FakeClient[] = [];
    const statuses: string[] = [];
    const bridge = new CodexManagedBridge({
        board, lease, eventsPath, repoRoot: root,
        clientFactory: () => { const client = new FakeClient(); clients.push(client); return client; },
        eventPollMs: 60_000, blockingPollMs: 60_000, burstWindowMs: 1,
        turnTimeoutMs: 500, interruptTimeoutMs: 100, restartBaseMs: 1, restartMaxMs: 2,
        onStatus: status => statuses.push(status),
    });
    t.after(() => void bridge.stop());
    return { root, eventsPath, board, lease, clients, statuses, bridge };
}

test('managed bridge initializes, authenticates, starts one persistent thread, and cleans up', async (t) => {
    const { bridge, clients, lease, statuses } = fixture(t);
    await bridge.start();
    const client = clients[0];
    assert.deepEqual(client.requests.map(request => request.method), ['initialize', 'account/read', 'thread/start']);
    assert.deepEqual(client.notifications.map(notification => notification.method), ['initialized']);
    assert.equal(bridge.activeThreadId(), 'thread-4321');
    assert.equal(lease.childPid, 4321);
    assert.equal(statuses.at(-1), 'linked');
    await bridge.stop();
    assert.equal(client.closed, true);
    assert.equal(lease.released, 1);
    assert.equal(bridge.status(), 'inactive');
});

test('safe event tail coalesces a burst, preserves follow-up order, and correlates terminal turns', async (t) => {
    const { bridge, clients, eventsPath, board } = fixture(t);
    await bridge.start();
    const client = clients[0];
    append(eventsPath, event('codex', 'self'), event('user', 'first'), event('user', 'second'));
    await bridge.pollEventsNow();
    await waitFor(() => client.requests.filter(r => r.method === 'turn/start').length === 1, 'first turn');
    const first = client.requests.find(r => r.method === 'turn/start')!;
    assert.match(JSON.stringify(first.params.input), /first.*second/);

    append(eventsPath, event('user', 'third'));
    await bridge.pollEventsNow();
    client.emit('turn/completed', { threadId: 'other-thread', turn: { id: 'turn-1' } });
    await wait(15);
    assert.equal(client.requests.filter(r => r.method === 'turn/start').length, 1, 'wrong-thread completion must be ignored');
    client.emit('item/started', { threadId: 'thread-4321', turnId: 'turn-1', item: { type: 'mcpToolCall', server: 'forgerelay', tool: 'post' } });
    client.emit('turn/completed', { threadId: 'thread-4321', turn: { id: 'turn-1' } });
    await waitFor(() => client.requests.filter(r => r.method === 'turn/start').length === 2, 'queued follow-up turn');
    const second = client.requests.filter(r => r.method === 'turn/start')[1];
    assert.match(JSON.stringify(second.params.input), /third/);
    client.emit('turn/completed', { threadId: 'thread-4321', turnId: 'turn-2' });
    await wait(10);
    assert.deepEqual(board.posts, [], 'MCP-used turns do not produce fallback posts');
});

test('posts bounded final text only when a completed turn used no Forge Relay MCP tool', async (t) => {
    const { bridge, clients, eventsPath, board } = fixture(t);
    await bridge.start();
    append(eventsPath, event('user', 'answer this'));
    await bridge.pollEventsNow();
    const client = clients[0];
    await waitFor(() => client.requests.some(r => r.method === 'turn/start'), 'turn start');
    client.emit('item/agentMessage/delta', { threadId: 'thread-4321', turnId: 'turn-1', delta: 'finished ' });
    client.emit('item/agentMessage/delta', { threadId: 'thread-4321', turnId: 'turn-1', delta: 'without a tool' });
    client.emit('turn/completed', { threadId: 'thread-4321', turnId: 'turn-1' });
    await waitFor(() => board.posts.length === 1, 'fallback post');
    assert.equal(board.posts[0], 'finished without a tool');
});

test('buffers notifications that race turn/start response and then correlates them', async (t) => {
    const { bridge, clients, eventsPath, board } = fixture(t);
    await bridge.start();
    const client = clients[0];
    client.onTurnStart = (turnId, params) => {
        const threadId = String(params.threadId);
        client.emit('item/agentMessage/delta', { threadId, turnId, delta: 'raced final' });
        client.emit('turn/completed', { threadId, turnId });
    };
    append(eventsPath, event('user', 'race notifications'));
    await bridge.pollEventsNow();
    await waitFor(() => board.posts.length === 1, 'correlated raced completion');
    assert.equal(board.posts[0], 'raced final');
});

test('EventTail holds partial lines and safely resynchronizes after truncation', async (t) => {
    const { bridge, clients, eventsPath } = fixture(t);
    await bridge.start();
    const partial = JSON.stringify(event('user', 'partial'));
    fs.appendFileSync(eventsPath, partial);
    await bridge.pollEventsNow();
    await wait(10);
    assert.equal(clients[0].requests.some(request => request.method === 'turn/start'), false);
    fs.appendFileSync(eventsPath, '\n');
    await bridge.pollEventsNow();
    await waitFor(() => clients[0].requests.some(request => request.method === 'turn/start'), 'completed partial event');
    clients[0].emit('turn/completed', { threadId: 'thread-4321', turnId: 'turn-1' });
    await wait(5);

    fs.writeFileSync(eventsPath, '');
    await bridge.pollEventsNow();
    append(eventsPath, event('user', 'after truncation'));
    await bridge.pollEventsNow();
    await waitFor(() => clients[0].requests.filter(request => request.method === 'turn/start').length === 2, 'post-truncation event');
    clients[0].emit('turn/completed', { threadId: 'thread-4321', turnId: 'turn-2' });
});

test('STOP polling interrupts independently, acknowledges, clears queued work, and resumes only after resolution', async (t) => {
    const { bridge, clients, eventsPath, board } = fixture(t);
    await bridge.start();
    append(eventsPath, event('user', 'long work'));
    await bridge.pollEventsNow();
    const client = clients[0];
    await waitFor(() => client.requests.some(r => r.method === 'turn/start'), 'active turn');
    board.commands = [{
        id: 'stop-1', created_at: new Date().toISOString(), created_by: 'user', target_agent: 'codex',
        text: 'STOP now', status: 'open', acknowledgements: [],
    }];
    client.onInterrupt = params => setTimeout(() => client.emit('turn/completed', {
        threadId: params.threadId, turnId: params.turnId,
    }), 1);
    await bridge.pollBlockingNow();
    assert.equal(client.requests.some(r => r.method === 'turn/interrupt'), true);
    assert.deepEqual(board.acks, ['stop-1']);
    assert.equal(bridge.isHalted(), true);
    append(eventsPath, event('user', 'must not queue while stopped'));
    await bridge.pollEventsNow();
    board.commands[0].status = 'resolved';
    await bridge.pollBlockingNow();
    assert.equal(bridge.isHalted(), false);
    assert.equal(client.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('unexpected approval requests are denied without expanding permissions', async (t) => {
    const { bridge, clients } = fixture(t);
    await bridge.start();
    assert.deepEqual(await clients[0].serverRequest('item/commandExecution/requestApproval'), { decision: 'decline', approved: false });
});

test('fatal authentication and same-profile ownership failures release without restart', async (t) => {
    const auth = fixture(t);
    const client = new FakeClient();
    client.account = { account: null, requiresOpenaiAuth: true };
    (auth.bridge as unknown as { opts: { clientFactory: () => FakeClient } }).opts.clientFactory = () => client;
    await assert.rejects(auth.bridge.start(), /Unauthenticated/);
    assert.equal(auth.bridge.status(), 'stopped');
    assert.match(auth.bridge.detailText(), /Sign In Isolated Codex with ChatGPT/);
    assert.equal(auth.lease.released, 1);

    for (const [label, account] of [
        ['API key', { account: { type: 'apiKey' }, requiresOpenaiAuth: true }],
        ['personal access token', { account: { type: 'personalAccessToken' }, requiresOpenaiAuth: false }],
        ['unknown account', { account: { type: 'futureMode' }, requiresOpenaiAuth: false }],
    ] as const) {
        const nonSubscription = fixture(t);
        const nonSubscriptionClient = new FakeClient();
        nonSubscriptionClient.account = account;
        (nonSubscription.bridge as unknown as { opts: { clientFactory: () => FakeClient } }).opts.clientFactory = () => nonSubscriptionClient;
        await assert.rejects(nonSubscription.bridge.start(), /not authenticated with ChatGPT subscription/, label);
        assert.equal(nonSubscription.bridge.status(), 'stopped', label);
        assert.equal(nonSubscription.lease.released, 1, label);
    }

    const held = fixture(t);
    held.lease.result = 'held-by-live-other';
    await assert.rejects(held.bridge.start(), /profile ownership lease is held/);
    assert.equal(held.clients.length, 0, 'contention must prevent app-server creation');
    assert.equal(held.bridge.status(), 'stopped');
    assert.match(held.bridge.detailText(), /another Forge Relay runtime/);
    assert.doesNotMatch(held.bridge.detailText(), /close other Codex app-server/i);
});

test('a transient transport close performs bounded recovery with a new persistent session', async (t) => {
    const { bridge, clients } = fixture(t);
    await bridge.start();
    clients[0].crash();
    await waitFor(() => clients.length === 2 && bridge.status() === 'linked', 'restarted session');
    assert.equal(clients[0].closed, true);
    assert.equal(clients[1].requests.some(r => r.method === 'thread/start'), true);
});

test('failure classification separates token/auth and protocol faults from transient errors', () => {
    assert.equal(classifyCodexManagedFailure(new Error('refresh_token_reused')), 'fatal-auth');
    assert.equal(classifyCodexManagedFailure(new Error('unsupported protocol response')), 'fatal-protocol');
    assert.equal(classifyCodexManagedFailure(new Error('managed profile ownership lease is held by another live runtime')), 'fatal-contention');
    assert.equal(classifyCodexManagedFailure(new Error('external Codex app-server detected')), 'transient');
    assert.equal(classifyCodexManagedFailure(new Error('process probe is unknown')), 'transient');
    assert.equal(classifyCodexManagedFailure(new Error('socket closed')), 'transient');
});
