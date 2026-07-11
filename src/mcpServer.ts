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
import { DEFAULT_SUBAGENT_BACKENDS, SubagentBackends } from './subagent';
import { BOARD_TOOL_SCHEMAS, executeBoardTool } from './boardTools';

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
                    // The SDK's handleRequest expects a *pre-parsed* JSON body (the
                    // "body-parser middleware" contract) — handing it the raw Buffer
                    // fails schema validation and every POST dies with "Invalid
                    // JSON-RPC message". The request stream is already consumed by
                    // readBody, so the SDK cannot re-read it: parse here, 400 on bad JSON.
                    let parsedBody: unknown;
                    try {
                        parsedBody = JSON.parse(body.toString('utf8'));
                    } catch {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            jsonrpc: '2.0',
                            error: { code: -32700, message: 'Parse error: request body is not valid JSON' },
                            id: null,
                        }));
                        return;
                    }
                    const session = await this.getOrCreateStreamableSession(sessionId);
                    await session.transport.handleRequest(req, res, parsedBody);
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
            tools: BOARD_TOOL_SCHEMAS,
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
            const args = request.params.arguments as Record<string, unknown> ?? {};

            try {
                return text(await executeBoardTool(this.bridge, this.subagentBackends, request.params.name, args));
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

        // transport.sessionId is only assigned while the SDK handles the
        // *initialize* request — i.e. after this function returns. Registering
        // the session right after connect() therefore always saw undefined and
        // the map stayed empty, so every follow-up request landed on a fresh
        // transport and died with "Server not initialized". Register through the
        // SDK's onsessioninitialized callback instead, which fires with the real id.
        let session: StreamableSession;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid: string) => {
                this.streamableSessions.set(sid, session);
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) {
                this.streamableSessions.delete(transport.sessionId);
            }
        };

        const server = this.buildMcpServer();
        await server.connect(transport);

        session = { server, transport };
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
