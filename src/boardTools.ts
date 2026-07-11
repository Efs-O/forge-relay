import { Bridge } from './bridge';
import { SubagentBackends, DISPATCH_SUBAGENT_TOOL, LIST_MODELS_TOOL, handleListModels } from './subagent';
import { handleDispatchSubagent } from './subagentLoop';

export const COORDINATOR_TOOL_NAMES = [
    'board_check', 'post', 'claim', 'release', 'ack_command', 'resolve_command',
    'dispatch_subagent', 'list_models', 'get_status',
] as const;

export const BOARD_TOOL_SCHEMAS = [
    { name: 'board_check', description: 'Pre-flight check. Returns blocking status and any new board events since last call. Run this before any substantial edit, build, or long task.', inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Your agent identity (claude, codex, etc.)' } }, required: ['agent'] } },
    { name: 'claim', description: 'Claim one or more files or folders before editing them. Prevents collisions with other agents.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, targets: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to claim' }, note: { type: 'string', description: 'Brief description of what you are doing' }, ttl_minutes: { type: 'number', description: 'How long to hold the claim (default 120)' } }, required: ['agent', 'targets', 'note'] } },
    { name: 'release', description: 'Release a claim when you are done with those files or folders.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['agent', 'targets'] } },
    { name: 'post', description: 'Post a progress update, blocker, or handoff note to the shared board.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, note: { type: 'string', description: 'Plain ASCII message, one line' } }, required: ['agent', 'note'] } },
    { name: 'get_status', description: 'Get all active claims and open operator commands.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
    { name: 'ack_command', description: 'Acknowledge an operator command (e.g. STOP or PAUSE). Always ack before stopping work.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, command_id: { type: 'string' }, note: { type: 'string' } }, required: ['agent', 'command_id'] } },
    { name: 'resolve_command', description: 'Mark an operator command as resolved once work is stopped or paused.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, command_id: { type: 'string' }, note: { type: 'string' } }, required: ['agent', 'command_id'] } },
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
            if (blocking.length) return `BLOCKED\n\nYou have ${blocking.length} blocking command(s). Acknowledge and stop work.\n\n${blocking.map(c => `[${c.id.slice(0, 8)}] ${c.text} (by ${c.created_by})`).join('\n')}`;
            return `CLEAR\n\nActive claims: ${state.claims.length}\nRecent events:\n${state.events.slice(-10).map(e => `${e.timestamp} [${e.type}] ${e.agent}: ${e.message}`).join('\n') || '(none)'}`;
        }
        case 'claim': bridge.claim(str(args.agent), arr(args.targets), Number(args.ttl_minutes ?? 120), str(args.note)); return `CLAIMED: ${arr(args.targets).join(', ')}`;
        case 'release': bridge.release(str(args.agent), arr(args.targets), str(args.note)); return `RELEASED: ${arr(args.targets).join(', ')}`;
        case 'post': {
            const note = str(args.note).trim();
            if (!note) return 'ERROR: post note must not be empty';
            bridge.post(str(args.agent), note);
            return 'POSTED';
        }
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
