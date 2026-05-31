#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from './bridge';
import { EventTail } from './eventTail';
import { DEFAULT_SUBAGENT_BACKENDS, DISPATCH_SUBAGENT_TOOL, LIST_MODELS_TOOL, handleListModels, SubagentBackends } from './subagent';
import { handleDispatchSubagent } from './subagentLoop';

// --repoRoot <path>  (defaults to cwd)
const repoRootArg = process.argv.indexOf('--repoRoot');
const repoRoot = repoRootArg !== -1
    ? process.argv[repoRootArg + 1]
    : process.cwd();

const bridge = new Bridge(repoRoot);
// B7: single source of truth for the coordination dir — ask the bridge rather
// than recomputing the path here, so the two can never drift apart.
const eventsPath = bridge.getEventsPath();

// Subagent backends — defaults can be overridden via env vars so Codex (which
// spawns this stdio server itself) can point at the same endpoints as the
// extension without sharing VS Code settings.
const subagentBackends: SubagentBackends = {
    bridgeUrl: process.env.AGENTWATCH_BRIDGE_URL || DEFAULT_SUBAGENT_BACKENDS.bridgeUrl,
    ollamaUrl: process.env.AGENTWATCH_OLLAMA_URL || DEFAULT_SUBAGENT_BACKENDS.ollamaUrl,
    directUrl: process.env.AGENTWATCH_DIRECT_URL || DEFAULT_SUBAGENT_BACKENDS.directUrl,
    bridgeApiKey: process.env.AGENTWATCH_BRIDGE_API_KEY || undefined,
    defaultBackend: (process.env.AGENTWATCH_DEFAULT_BACKEND as SubagentBackends['defaultBackend']) || DEFAULT_SUBAGENT_BACKENDS.defaultBackend,
};

const server = new Server(
    { name: 'agentwatch', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'board_check',
            description: 'Pre-flight check. Returns blocking status and any new board events since last call. Run this before any substantial edit, build, or long task.',
            inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
        },
        {
            name: 'claim',
            description: 'Claim one or more files or folders before editing them.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    targets: { type: 'array', items: { type: 'string' } },
                    note: { type: 'string' },
                    ttl_minutes: { type: 'number' },
                },
                required: ['agent', 'targets', 'note'],
            },
        },
        {
            name: 'release',
            description: 'Release a claim when done with those files or folders.',
            inputSchema: {
                type: 'object',
                properties: { agent: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
                required: ['agent', 'targets'],
            },
        },
        {
            name: 'post',
            description: 'Post a progress update, blocker, or handoff note to the shared board.',
            inputSchema: {
                type: 'object',
                properties: { agent: { type: 'string' }, note: { type: 'string' } },
                required: ['agent', 'note'],
            },
        },
        {
            name: 'get_status',
            description: 'Get all active claims and recent board events.',
            inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
        },
        {
            name: 'ack_command',
            description: 'Acknowledge an operator command (STOP or PAUSE).',
            inputSchema: {
                type: 'object',
                properties: { agent: { type: 'string' }, command_id: { type: 'string' }, note: { type: 'string' } },
                required: ['agent', 'command_id'],
            },
        },
        {
            name: 'resolve_command',
            description: 'Mark an operator command as resolved.',
            inputSchema: {
                type: 'object',
                properties: { agent: { type: 'string' }, command_id: { type: 'string' }, note: { type: 'string' } },
                required: ['agent', 'command_id'],
            },
        },
        DISPATCH_SUBAGENT_TOOL,
        LIST_MODELS_TOOL,
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
        switch (request.params.name) {
            case 'board_check': {
                const agent = str(args.agent);
                const blocking = bridge.getBlockingCommands(agent);
                const state = bridge.getState();
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
                bridge.claim(str(args.agent), strArr(args.targets), num(args.ttl_minutes ?? 120), str(args.note ?? ''));
                return text(`CLAIMED: ${strArr(args.targets).join(', ')}`);
            }
            case 'release': {
                bridge.release(str(args.agent), strArr(args.targets), str(args.note ?? ''));
                return text(`RELEASED: ${strArr(args.targets).join(', ')}`);
            }
            case 'post': {
                bridge.post(str(args.agent), str(args.note));
                return text('POSTED');
            }
            case 'get_status': {
                const state = bridge.getState();
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
                bridge.ack(str(args.agent), str(args.command_id), str(args.note ?? ''));
                return text(`ACKNOWLEDGED ${str(args.command_id)}`);
            }
            case 'resolve_command': {
                bridge.resolve(str(args.agent), str(args.command_id), str(args.note ?? ''));
                return text(`RESOLVED ${str(args.command_id)}`);
            }
            case 'dispatch_subagent': {
                const result = await handleDispatchSubagent(bridge, subagentBackends, args);
                return text(result);
            }
            case 'list_models': {
                return text(await handleListModels(subagentBackends));
            }
            default:
                return text(`Unknown tool: ${request.params.name}`);
        }
    } catch (err) {
        return text(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // B5: tail events.ndjson via the shared EventTail and push MCP notifications
    // to the connected client. EventTail handles rotation/truncation/partial
    // lines, so this loop stays trivial.
    const tail = new EventTail(eventsPath);
    const timer = setInterval(() => {
        for (const event of tail.readNew()) {
            server.notification({
                method: 'notifications/message',
                params: {
                    level: /\bSTOP\b/i.test(event.message) ? 'alert' : 'info',
                    logger: 'agentwatch.board',
                    data: { type: 'board_event', event },
                },
            });
        }
    }, 500);
    timer.unref?.();
}

main().catch(err => {
    process.stderr.write(`[agentwatch-stdio] fatal: ${err}\n`);
    process.exit(1);
});

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
