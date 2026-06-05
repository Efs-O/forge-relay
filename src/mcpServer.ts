import * as crypto from 'crypto';
import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    CallToolResult,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BoardWatcher } from './boardWatcher';
import { Bridge } from './bridge';
import { BoardEvent, BoardEventNotificationData } from './types';
import { DEFAULT_SUBAGENT_BACKENDS, DISPATCH_SUBAGENT_TOOL, LIST_MODELS_TOOL, handleListModels, SubagentBackends } from './subagent';
import { handleDispatchSubagent } from './subagentLoop';

type SseSession = {
    server: Server;
    transport: SSEServerTransport;
};

type StreamableSession = {
    server: Server;
    transport: StreamableHTTPServerTransport;
};

export class McpServer {
    private readonly bridge: Bridge;
    private readonly subagentBackends: SubagentBackends;
    private httpServer: http.Server | null = null;
    private readonly sseSessions = new Map<string, SseSession>();
    private readonly streamableSessions = new Map<string, StreamableSession>();
    private boardWatcher: BoardWatcher | null = null;
    private port = 7878;

    constructor(bridge: Bridge, subagentBackends: SubagentBackends = DEFAULT_SUBAGENT_BACKENDS) {
        this.bridge = bridge;
        this.subagentBackends = subagentBackends;
    }

    /**
     * Bind the MCP HTTP server. Tries `desiredPort` first and, if it is already
     * in use (another Forge Relay window, a stale server), scans upward for a free
     * port instead of failing. This keeps multiple VS Code windows from colliding
     * on a single fixed port — the primary window keeps the configured port, and
     * later windows transparently move up. Resolves with the actual bound port,
     * which every consumer (Claude bridge URL, webview, config snippet) must read
     * via {@link getPort} rather than assuming the default.
     */
    async start(desiredPort: number, maxAttempts = 20): Promise<number> {
        this.startBoardWatcher();

        this.httpServer = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

            if (req.method === 'GET' && url.pathname === '/sse') {
                const server = this.buildMcpServer();
                const transport = new SSEServerTransport('/messages', res);
                const sessionId = transport.sessionId;

                transport.onclose = () => this.sseSessions.delete(sessionId);
                req.on('close', () => this.sseSessions.delete(sessionId));

                await server.connect(transport);
                this.sseSessions.set(sessionId, { server, transport });
                return;
            }

            if (req.method === 'POST' && url.pathname === '/messages') {
                const sessionId = url.searchParams.get('sessionId') ?? '';
                const session = this.sseSessions.get(sessionId);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session not found' }));
                    return;
                }

                await session.transport.handlePostMessage(req, res);
                return;
            }

            if (url.pathname === '/mcp') {
                const body = await readBody(req);
                const sessionId = req.headers['mcp-session-id'] as string | undefined;

                if (req.method === 'POST') {
                    const session = await this.getOrCreateStreamableSession(sessionId);
                    await session.transport.handleRequest(req, res, body);
                    return;
                }

                if (req.method === 'GET') {
                    if (sessionId && this.streamableSessions.has(sessionId)) {
                        await this.streamableSessions.get(sessionId)!.transport.handleRequest(req, res);
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing mcp-session-id header' }));
                    }
                    return;
                }

                if (req.method === 'DELETE') {
                    if (sessionId && this.streamableSessions.has(sessionId)) {
                        const session = this.streamableSessions.get(sessionId)!;
                        await session.transport.handleRequest(req, res);
                        this.streamableSessions.delete(sessionId);
                    } else {
                        res.writeHead(404);
                        res.end();
                    }
                    return;
                }
            }

            if (req.method === 'GET' && url.pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, port: this.port, transports: ['sse', 'streamable-http'] }));
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        });

        return this.listenWithFallback(desiredPort, maxAttempts);
    }

    /** Try to listen on `port`; on EADDRINUSE, retry the next port up to `attemptsLeft` times. */
    private listenWithFallback(port: number, attemptsLeft: number): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = this.httpServer;
            if (!server) { reject(new Error('MCP http server not created')); return; }

            const cleanup = (): void => {
                server.removeListener('error', onError);
                server.removeListener('listening', onListening);
            };
            const onError = (err: NodeJS.ErrnoException): void => {
                cleanup();
                if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
                    console.log(`[Forge Relay] MCP port ${port} in use; trying ${port + 1}`);
                    this.listenWithFallback(port + 1, attemptsLeft - 1).then(resolve, reject);
                } else {
                    reject(err);
                }
            };
            const onListening = (): void => {
                cleanup();
                this.port = port;
                console.log(`[Forge Relay] MCP server listening on http://127.0.0.1:${port}/sse`);
                resolve(port);
            };

            // Do NOT use listen(port, host, cb): that callback is registered as a
            // once('listening') handler that is NOT cleared when the bind fails with
            // EADDRINUSE, so on the retry's successful bind the stale callback ALSO
            // fires and resolves with the wrong (original) port — which then becomes
            // the bridge URL and the board's displayed port. Our own removable
            // listeners, cleared on every attempt, avoid that cross-attempt leak.
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        });
    }

    stop(): void {
        this.httpServer?.close();
        this.httpServer = null;
        this.boardWatcher?.stop();
        this.boardWatcher = null;
        this.sseSessions.clear();
        this.streamableSessions.clear();
    }

    getPort(): number {
        return this.port;
    }

    private buildMcpServer(): Server {
        const server = new Server(
            { name: 'forgerelay', version: '0.1.0' },
            { capabilities: { tools: {}, logging: {} } }
        );

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'board_check',
                    description: 'Pre-flight check. Returns blocking status and any new board events since last call. Run this before any substantial edit, build, or long task.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string', description: 'Your agent identity (claude, codex, etc.)' },
                        },
                        required: ['agent'],
                    },
                },
                {
                    name: 'claim',
                    description: 'Claim one or more files or folders before editing them. Prevents collisions with other agents.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string' },
                            targets: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to claim' },
                            note: { type: 'string', description: 'Brief description of what you are doing' },
                            ttl_minutes: { type: 'number', description: 'How long to hold the claim (default 120)' },
                        },
                        required: ['agent', 'targets', 'note'],
                    },
                },
                {
                    name: 'release',
                    description: 'Release a claim when you are done with those files or folders.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string' },
                            targets: { type: 'array', items: { type: 'string' } },
                            note: { type: 'string' },
                        },
                        required: ['agent', 'targets'],
                    },
                },
                {
                    name: 'post',
                    description: 'Post a progress update, blocker, or handoff note to the shared board.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string' },
                            note: { type: 'string', description: 'Plain ASCII message, one line' },
                        },
                        required: ['agent', 'note'],
                    },
                },
                {
                    name: 'get_status',
                    description: 'Get all active claims and recent board events.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string' },
                        },
                        required: ['agent'],
                    },
                },
                {
                    name: 'ack_command',
                    description: 'Acknowledge an operator command (e.g. STOP or PAUSE). Always ack before stopping work.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string' },
                            command_id: { type: 'string' },
                            note: { type: 'string' },
                        },
                        required: ['agent', 'command_id'],
                    },
                },
                {
                    name: 'resolve_command',
                    description: 'Mark an operator command as resolved once work is stopped or paused.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string' },
                            command_id: { type: 'string' },
                            note: { type: 'string' },
                        },
                        required: ['agent', 'command_id'],
                    },
                },
                DISPATCH_SUBAGENT_TOOL,
                LIST_MODELS_TOOL,
            ],
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
            const args = request.params.arguments as Record<string, unknown> ?? {};

            try {
                switch (request.params.name) {
                    case 'board_check': {
                        const agent = str(args.agent);
                        const blocking = this.bridge.getBlockingCommands(agent);
                        const state = this.bridge.getState();
                        if (blocking.length > 0) {
                            const summary = blocking.map(c => `[${c.id.slice(0, 8)}] ${c.text} (by ${c.created_by})`).join('\n');
                            return text(`BLOCKED\n\nYou have ${blocking.length} blocking command(s). Acknowledge and stop work.\n\n${summary}`);
                        }
                        const recent = state.events.slice(-10).map(e =>
                            `${e.timestamp} [${e.type}] ${e.agent}: ${e.message}`
                        ).join('\n');
                        return text(`CLEAR\n\nActive claims: ${state.claims.length}\nRecent events:\n${recent || '(none)'}`);
                    }

                    case 'claim': {
                        const agent = str(args.agent);
                        const targets = strArr(args.targets);
                        const note = str(args.note ?? '');
                        const ttl = num(args.ttl_minutes ?? 120);
                        this.bridge.claim(agent, targets, ttl, note);
                        return text(`CLAIMED: ${targets.join(', ')}`);
                    }

                    case 'release': {
                        const agent = str(args.agent);
                        const targets = strArr(args.targets);
                        const note = str(args.note ?? '');
                        this.bridge.release(agent, targets, note);
                        return text(`RELEASED: ${targets.join(', ')}`);
                    }

                    case 'post': {
                        const agent = str(args.agent);
                        const note = str(args.note);
                        this.bridge.post(agent, note);
                        return text('POSTED');
                    }

                    case 'get_status': {
                        const state = this.bridge.getState();
                        const claimSummary = state.claims.length === 0
                            ? 'No active claims.'
                            : state.claims.map(c => `  ${c.agent}: ${c.paths.join(', ')} (expires ${c.expires_at})`).join('\n');
                        const cmdSummary = state.commands.filter(c => c.status !== 'resolved').length === 0
                            ? 'No open commands.'
                            : state.commands.filter(c => c.status !== 'resolved')
                                .map(c => `  [${c.id.slice(0, 8)}] ${c.text} -> ${c.target_agent} (${c.status})`).join('\n');
                        return text(`CLAIMS:\n${claimSummary}\n\nCOMMANDS:\n${cmdSummary}`);
                    }

                    case 'ack_command': {
                        const agent = str(args.agent);
                        const commandId = str(args.command_id);
                        const note = str(args.note ?? '');
                        this.bridge.ack(agent, commandId, note);
                        return text(`ACKNOWLEDGED ${commandId}`);
                    }

                    case 'resolve_command': {
                        const agent = str(args.agent);
                        const commandId = str(args.command_id);
                        const note = str(args.note ?? '');
                        this.bridge.resolve(agent, commandId, note);
                        return text(`RESOLVED ${commandId}`);
                    }

                    case 'dispatch_subagent': {
                        const result = await handleDispatchSubagent(this.bridge, this.subagentBackends, args);
                        return text(result);
                    }

                    case 'list_models': {
                        return text(await handleListModels(this.subagentBackends));
                    }

                    default:
                        return text(`Unknown tool: ${request.params.name}`);
                }
            } catch (err) {
                return text(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
            }
        });

        return server;
    }

    private async getOrCreateStreamableSession(sessionId?: string): Promise<StreamableSession> {
        if (sessionId && this.streamableSessions.has(sessionId)) {
            return this.streamableSessions.get(sessionId)!;
        }

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
        });
        transport.onclose = () => {
            if (transport.sessionId) {
                this.streamableSessions.delete(transport.sessionId);
            }
        };

        const server = this.buildMcpServer();
        await server.connect(transport);

        const session = { server, transport };
        if (transport.sessionId) {
            this.streamableSessions.set(transport.sessionId, session);
        }

        return session;
    }

    private startBoardWatcher(): void {
        if (this.boardWatcher) {
            return;
        }

        this.boardWatcher = new BoardWatcher(this.bridge.getEventsPath(), (event) => {
            void this.broadcastBoardEvent(event);
        });
        this.boardWatcher.start();
    }

    private async broadcastBoardEvent(event: BoardEvent): Promise<void> {
        const payload: BoardEventNotificationData = {
            type: 'board_event',
            event,
        };
        const sessions = [
            ...this.sseSessions.values(),
            ...this.streamableSessions.values(),
        ];

        await Promise.allSettled(
            sessions.map(session =>
                session.server.sendLoggingMessage({
                    level: 'info',
                    logger: 'forgerelay.board',
                    data: payload,
                })
            )
        );
    }
}

function str(v: unknown): string { return String(v ?? ''); }
function num(v: unknown): number { return Number(v ?? 0); }
function strArr(v: unknown): string[] {
    if (Array.isArray(v)) { return v.map(String); }
    if (typeof v === 'string') { return [v]; }
    return [];
}
function text(content: string): CallToolResult {
    return { content: [{ type: 'text', text: content }] };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
