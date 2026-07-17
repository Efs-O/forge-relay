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
    canonicalManagedWorkspaceRoot,
    managedPermissionsProfile,
    resolveManagedCodexServerRequest,
} from '../src/codexManagedBridge';
import { BoardEvent, Command } from '../src/types';
import { MANAGED_CLANKER_PERMISSION_PROFILE } from '../src/codexManagedProfile';

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
    threadCwd?: string;
    threadRuntimeWorkspaceRoots?: unknown[];
    omitRuntimeWorkspaceRoots = false;
    activePermissionProfileId?: string;
    omitActivePermissionProfile = false;
    commandExecResult: Record<string, unknown> = {
        exitCode: 0,
        stdout: 'forge-relay-create|forge-relay-update',
        stderr: '',
    };
    private notificationListeners = new Set<(notification: { method: string; params?: unknown }) => void>();
    private closeListeners = new Set<(error?: Error) => void>();
    private requestListener?: (method: string, params: Record<string, unknown>) => Promise<unknown>;

    async start(): Promise<void> { this.started = true; }
    async request<T>(method: string, rawParams?: unknown): Promise<T> {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        this.requests.push({ method, params });
        if (method === 'initialize') return {} as T;
        if (method === 'account/read') return this.account as T;
        if (method === 'thread/start') return {
            thread: { id: `thread-${this.childPid}` },
            cwd: this.threadCwd ?? params.cwd,
            ...(!this.omitActivePermissionProfile ? {
                activePermissionProfile: { id: this.activePermissionProfileId ?? params.permissions },
            } : {}),
            ...(!this.omitRuntimeWorkspaceRoots ? {
                runtimeWorkspaceRoots: this.threadRuntimeWorkspaceRoots ?? params.runtimeWorkspaceRoots,
            } : {}),
        } as T;
        if (method === 'turn/start') {
            const turnId = `turn-${++this.turnCounter}`;
            this.onTurnStart?.(turnId, params);
            return { turn: { id: turnId } } as T;
        }
        if (method === 'command/exec') return this.commandExecResult as T;
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
    claims: string[] = [];
    releases: string[] = [];
    getBlockingCommands(): Command[] { return this.commands.filter(command => command.status !== 'resolved'); }
    getAutonomyMode(): 'draft' | 'clanker' { return this.autonomy; }
    ack(_agent: string, commandId: string): void { this.acks.push(commandId); }
    post(_agent: string, message: string): void { this.posts.push(message); }
    claim(_agent: string, targets: string[]): void { this.claims.push(...targets); }
    release(_agent: string, targets: string[]): void { this.releases.push(...targets); }
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

test('managed bridge initializes with a canonical workspace and cleans up', async (t) => {
    const { bridge, clients, lease, statuses, root } = fixture(t);
    await bridge.start();
    const client = clients[0];
    assert.deepEqual(client.requests.map(request => request.method), ['initialize', 'account/read', 'thread/start']);
    assert.deepEqual(client.notifications.map(notification => notification.method), ['initialized']);
    const initialize = client.requests.find(request => request.method === 'initialize')!;
    assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
    const start = client.requests.find(request => request.method === 'thread/start')!;
    const workspace = canonicalManagedWorkspaceRoot(root);
    assert.equal(start.params.cwd, workspace);
    assert.deepEqual(start.params.runtimeWorkspaceRoots, [workspace]);
    assert.equal(start.params.permissions, ':read-only');
    assert.equal('sandbox' in start.params, false);
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

test('clanker turns use the workspace permission profile with explicit project roots', async (t) => {
    const { bridge, clients, eventsPath, board, root } = fixture(t);
    board.autonomy = 'clanker';
    await bridge.start();
    append(eventsPath, event('user', 'write inside the repo'));
    await bridge.pollEventsNow();
    await waitFor(() => clients[0].requests.some(request => request.method === 'turn/start'), 'clanker turn');
    const turn = clients[0].requests.find(request => request.method === 'turn/start')!;
    const workspace = canonicalManagedWorkspaceRoot(root);
    assert.equal(turn.params.cwd, workspace);
    assert.deepEqual(turn.params.runtimeWorkspaceRoots, [workspace]);
    assert.equal(turn.params.permissions, MANAGED_CLANKER_PERMISSION_PROFILE);
    assert.equal('sandboxPolicy' in turn.params, false);
    const probe = clients[0].requests.find(request => request.method === 'command/exec')!;
    assert.equal(probe.params.permissionProfile, MANAGED_CLANKER_PERMISSION_PROFILE);
    assert.equal(probe.params.cwd, workspace);
    assert.deepEqual(board.claims, board.releases);
});

test('managed startup fails closed when app-server omits or changes runtime workspace roots', async (t) => {
    for (const [label, configure] of [
        ['missing roots', (client: FakeClient) => { client.omitRuntimeWorkspaceRoots = true; }],
        ['wrong root', (client: FakeClient) => { client.threadRuntimeWorkspaceRoots = [path.dirname(process.cwd())]; }],
        ['extra root', (client: FakeClient) => { client.threadRuntimeWorkspaceRoots = [process.cwd(), path.dirname(process.cwd())]; }],
    ] as const) {
        const subject = fixture(t);
        const client = new FakeClient();
        configure(client);
        (subject.bridge as unknown as { opts: { clientFactory: () => FakeClient } }).opts.clientFactory = () => client;
        await assert.rejects(subject.bridge.start(), /runtime workspace roots mismatch/, label);
        assert.equal(subject.bridge.status(), 'error', label);
        assert.equal(subject.lease.released, 1, label);
    }
});

test('managed startup fails closed when app-server omits or changes the active permission profile', async (t) => {
    for (const [label, configure] of [
        ['missing profile', (client: FakeClient) => { client.omitActivePermissionProfile = true; }],
        ['wrong profile', (client: FakeClient) => { client.activePermissionProfileId = ':danger-full-access'; }],
    ] as const) {
        const subject = fixture(t);
        const client = new FakeClient();
        configure(client);
        (subject.bridge as unknown as { opts: { clientFactory: () => FakeClient } }).opts.clientFactory = () => client;
        await assert.rejects(subject.bridge.start(), /permissions mismatch/, label);
        assert.equal(subject.bridge.status(), 'error', label);
        assert.equal(subject.lease.released, 1, label);
    }
});

test('managed permission helper keeps draft read-only and clanker workspace-scoped', () => {
    assert.equal(managedPermissionsProfile('draft'), ':read-only');
    assert.equal(managedPermissionsProfile('clanker'), MANAGED_CLANKER_PERMISSION_PROFILE);
});

test('managed Clanker fails closed before a model turn when native workspace acceptance fails', async (t) => {
    const subject = fixture(t);
    subject.board.autonomy = 'clanker';
    const client = new FakeClient();
    client.commandExecResult = { exitCode: 1, stdout: '', stderr: 'sandbox refused split roots' };
    (subject.bridge as unknown as { opts: { clientFactory: () => FakeClient } }).opts.clientFactory = () => client;
    await assert.rejects(subject.bridge.start(), /Clanker acceptance failed.*split roots/);
    assert.equal(client.requests.some(request => request.method === 'turn/start'), false);
    assert.deepEqual(subject.board.claims, subject.board.releases);
    assert.equal(classifyCodexManagedFailure(new Error('Managed Codex Clanker acceptance failed')), 'fatal-protocol');
});

test('only the active Forge Relay MCP tool elicitation is accepted', () => {
    const context = { threadId: 'thread-1', turnId: 'turn-1' };
    const valid = {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'forgerelay',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
        message: 'Allow the Forge Relay MCP tool call?',
        requestedSchema: { type: 'object', properties: {} },
    };
    assert.deepEqual(resolveManagedCodexServerRequest('mcpServer/elicitation/request', valid, context), {
        response: { action: 'accept', content: {}, _meta: null },
        audit: 'accepted-forgerelay-mcp',
    });

    for (const [label, params, requestContext] of [
        ['wrong server', { ...valid, serverName: 'other' }, context],
        ['wrong thread', { ...valid, threadId: 'thread-2' }, context],
        ['wrong turn', { ...valid, turnId: 'turn-2' }, context],
        ['no active turn', valid, { threadId: 'thread-1' }],
        ['wrong mode', { ...valid, mode: 'url' }, context],
        ['missing marker', { ...valid, _meta: {} }, context],
        ['missing properties', { ...valid, requestedSchema: { type: 'object' } }, context],
        ['array properties', { ...valid, requestedSchema: { type: 'object', properties: [] } }, context],
        ['nonempty schema', { ...valid, requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } }, context],
    ] as const) {
        assert.deepEqual(
            resolveManagedCodexServerRequest('mcpServer/elicitation/request', params, requestContext),
            {
                response: { action: 'decline', content: null, _meta: null },
                audit: 'declined-elicitation',
            },
            label,
        );
    }
});

test('bridge accepts MCP elicitation only after turn/start establishes the active turn', async (t) => {
    const { bridge, clients, eventsPath } = fixture(t);
    await bridge.start();
    const client = clients[0];
    let response: unknown;
    client.onTurnStart = (turnId, params) => {
        setTimeout(async () => {
            response = await client.serverRequest('mcpServer/elicitation/request', {
                threadId: params.threadId,
                turnId,
                serverName: 'forgerelay',
                mode: 'form',
                _meta: { codex_approval_kind: 'mcp_tool_call' },
                message: 'Allow the Forge Relay MCP tool call?',
                requestedSchema: { type: 'object', properties: {} },
            });
            client.emit('item/started', {
                threadId: params.threadId,
                turnId,
                item: { type: 'mcpToolCall', server: 'forgerelay', tool: 'post' },
            });
            client.emit('turn/completed', { threadId: params.threadId, turnId });
        }, 1);
    };
    append(eventsPath, event('user', 'respond through Forge Relay'));
    await bridge.pollEventsNow();
    await waitFor(() => response !== undefined, 'MCP elicitation response');
    assert.deepEqual(response, { action: 'accept', content: {}, _meta: null });
});

test('unrelated app-server requests remain unsupported', () => {
    assert.throws(
        () => resolveManagedCodexServerRequest('item/tool/requestUserInput', {}, {}),
        /Unsupported app-server request/,
    );
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
