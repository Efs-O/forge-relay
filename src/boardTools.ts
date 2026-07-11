import { Bridge } from './bridge';
import { SubagentBackends, DISPATCH_SUBAGENT_TOOL, LIST_MODELS_TOOL, handleListModels } from './subagent';
import { handleDispatchSubagent } from './subagentLoop';

export const COORDINATOR_TOOL_NAMES = [
    'board_check', 'post', 'claim', 'release', 'ack_command', 'resolve_command',
    'dispatch_subagent', 'list_models', 'get_status',
] as const;

export const BOARD_TOOL_SCHEMAS = [
    { name: 'board_check', description: 'Preflight board check for blocking commands and recent events.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
    { name: 'claim', description: 'Claim files before editing.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, ttl_minutes: { type: 'number' } }, required: ['agent', 'targets', 'note'] } },
    { name: 'release', description: 'Release claimed files.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['agent', 'targets'] } },
    { name: 'post', description: 'Post a one-line board update.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, note: { type: 'string' } }, required: ['agent', 'note'] } },
    { name: 'get_status', description: 'List active claims and commands.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
    { name: 'ack_command', description: 'Acknowledge STOP or PAUSE.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, command_id: { type: 'string' }, note: { type: 'string' } }, required: ['agent', 'command_id'] } },
    { name: 'resolve_command', description: 'Resolve a command.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, command_id: { type: 'string' }, note: { type: 'string' } }, required: ['agent', 'command_id'] } },
    DISPATCH_SUBAGENT_TOOL,
    LIST_MODELS_TOOL,
];

export async function executeBoardTool(bridge: Bridge, backends: SubagentBackends, name: string, args: Record<string, unknown>): Promise<string> {
    const str = (v: unknown) => String(v ?? '');
    const arr = (v: unknown) => Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
    switch (name) {
        case 'board_check': {
            const blocking = bridge.getBlockingCommands(str(args.agent));
            const state = bridge.getState();
            if (blocking.length) return `BLOCKED\n\n${blocking.map(c => `[${c.id.slice(0, 8)}] ${c.text} (by ${c.created_by})`).join('\n')}`;
            return `CLEAR\n\nActive claims: ${state.claims.length}\nRecent events:\n${state.events.slice(-10).map(e => `${e.timestamp} [${e.type}] ${e.agent}: ${e.message}`).join('\n') || '(none)'}`;
        }
        case 'claim': bridge.claim(str(args.agent), arr(args.targets), Number(args.ttl_minutes ?? 120), str(args.note)); return `CLAIMED: ${arr(args.targets).join(', ')}`;
        case 'release': bridge.release(str(args.agent), arr(args.targets), str(args.note)); return `RELEASED: ${arr(args.targets).join(', ')}`;
        case 'post': bridge.post(str(args.agent), str(args.note)); return 'POSTED';
        case 'get_status': {
            const state = bridge.getState();
            const claims = state.claims.length ? state.claims.map(c => `  ${c.agent}: ${c.paths.join(', ')} (expires ${c.expires_at})`).join('\n') : 'No active claims.';
            const open = state.commands.filter(c => c.status !== 'resolved');
            const commands = open.length ? open.map(c => `  [${c.id.slice(0, 8)}] ${c.text} -> ${c.target_agent} (${c.status})`).join('\n') : 'No open commands.';
            return `CLAIMS:\n${claims}\n\nCOMMANDS:\n${commands}`;
        }
        case 'ack_command': bridge.ack(str(args.agent), str(args.command_id), str(args.note)); return `ACKNOWLEDGED ${str(args.command_id)}`;
        case 'resolve_command': bridge.resolve(str(args.agent), str(args.command_id), str(args.note)); return `RESOLVED ${str(args.command_id)}`;
        case 'dispatch_subagent': return handleDispatchSubagent(bridge, backends, args);
        case 'list_models': return handleListModels(backends);
        default: return `Unknown tool: ${name}`;
    }
}
