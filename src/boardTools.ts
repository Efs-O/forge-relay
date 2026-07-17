import { Bridge } from './bridge';
import { SubagentBackends, DISPATCH_SUBAGENT_TOOL, LIST_MODELS_TOOL, handleListModels } from './subagent';
import { handleDispatchSubagent } from './subagentLoop';
import { runCoordinatedBuild } from './buildWrapper';
import { Task } from './types';
import { readSubagentRun } from './subagentRuns';

export const COORDINATOR_TOOL_NAMES = [
    'board_check', 'post', 'claim', 'release', 'ack_command', 'resolve_command',
    'dispatch_subagent', 'get_subagent_run', 'list_models', 'get_status', 'run_build',
    'create_task', 'update_task', 'assign_task', 'start_task', 'block_task', 'unblock_task', 'complete_task', 'cancel_task', 'list_tasks',
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
    { name: 'get_subagent_run', description: 'Read the durable lifecycle state of an async subagent run by its runId.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, run_id: { type: 'string' } }, required: ['agent', 'run_id'] } },
    LIST_MODELS_TOOL,
    { name: 'run_build', description: 'Run the configured build command with board coordination: pre-flight check, claim the configured build target(s), run the command, post start/result, and release on success, failure, timeout, or operator STOP/PAUSE. The command itself is fixed by local config ("forgeRelay.build.command"), not by this call, so it cannot be redirected via arguments.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, note: { type: 'string', description: 'Optional context for the board post' } }, required: ['agent'] } },
    { name: 'create_task', description: 'Create a task card: persistent, board-visible work item with a lifecycle distinct from file claims and STOP/PAUSE commands.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Default: medium' }, owner: { type: 'string' } }, required: ['agent', 'title'] } },
    { name: 'update_task', description: 'Update a task card\'s title, description, or severity. Does not change lifecycle state — use start_task/block_task/unblock_task/complete_task/cancel_task for that.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } }, required: ['agent', 'task_id'] } },
    { name: 'assign_task', description: 'Assign a task card to an owner.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' }, owner: { type: 'string' } }, required: ['agent', 'task_id', 'owner'] } },
    { name: 'start_task', description: 'Move a task card to in_progress (valid from open or blocked).', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' } }, required: ['agent', 'task_id'] } },
    { name: 'block_task', description: 'Move a task card to blocked with a required reason (valid from open or in_progress). This is task-level blocker metadata, separate from operator STOP/PAUSE commands.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['agent', 'task_id', 'reason'] } },
    { name: 'unblock_task', description: 'Move a blocked task card back to in_progress.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' } }, required: ['agent', 'task_id'] } },
    { name: 'complete_task', description: 'Mark a task card done (valid from open, in_progress, or blocked).', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' } }, required: ['agent', 'task_id'] } },
    { name: 'cancel_task', description: 'Cancel a task card (valid from open, in_progress, or blocked).', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, task_id: { type: 'string' }, note: { type: 'string' } }, required: ['agent', 'task_id'] } },
    { name: 'list_tasks', description: 'List all task cards with their current state, severity, owner, and blocking reason.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
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
            const openTasks = state.tasks.filter(t => t.state !== 'done' && t.state !== 'cancelled');
            const tasks = openTasks.length ? openTasks.map(t => `  [${t.id.slice(0, 8)}] (${t.severity}/${t.state}) ${t.title}${t.owner ? ` — ${t.owner}` : ''}`).join('\n') : 'No open tasks.';
            return `CLAIMS:\n${claims}\n\nCOMMANDS:\n${commands}\n\nTASKS:\n${tasks}`;
        }
        case 'ack_command': bridge.ack(str(args.agent), str(args.command_id), str(args.note)); return `ACKNOWLEDGED ${str(args.command_id)}`;
        case 'resolve_command': bridge.resolve(str(args.agent), str(args.command_id), str(args.note)); return `RESOLVED ${str(args.command_id)}`;
        case 'dispatch_subagent': return handleDispatchSubagent(bridge, backends, args);
        case 'get_subagent_run': {
            const record = readSubagentRun(bridge.getRepoRoot(), str(args.run_id));
            return record ? JSON.stringify(record) : `ERROR: unknown subagent run ${str(args.run_id)}`;
        }
        case 'list_models': return handleListModels(backends);
        case 'run_build': return runCoordinatedBuild(bridge, backends, str(args.agent), str(args.note));
        case 'create_task': {
            const task = bridge.createTask(str(args.agent), str(args.title), {
                description: args.description !== undefined ? str(args.description) : undefined,
                severity: args.severity !== undefined ? (str(args.severity) as Task['severity']) : undefined,
                owner: args.owner !== undefined ? str(args.owner) : undefined,
            });
            return `CREATED ${task.id.slice(0, 8)}: ${task.title} [${task.state}/${task.severity}]`;
        }
        case 'update_task': {
            const task = bridge.updateTask(str(args.agent), str(args.task_id), {
                title: args.title !== undefined ? str(args.title) : undefined,
                description: args.description !== undefined ? str(args.description) : undefined,
                severity: args.severity !== undefined ? (str(args.severity) as Task['severity']) : undefined,
            });
            return `UPDATED ${task.id.slice(0, 8)}: ${task.title} [${task.state}/${task.severity}]`;
        }
        case 'assign_task': {
            const task = bridge.assignTask(str(args.agent), str(args.task_id), str(args.owner));
            return `ASSIGNED ${task.id.slice(0, 8)} -> ${task.owner}`;
        }
        case 'start_task': {
            const task = bridge.startTask(str(args.agent), str(args.task_id));
            return `${task.id.slice(0, 8)} -> ${task.state}`;
        }
        case 'block_task': {
            const task = bridge.blockTask(str(args.agent), str(args.task_id), str(args.reason));
            return `${task.id.slice(0, 8)} -> ${task.state} (${task.blocking_reason})`;
        }
        case 'unblock_task': {
            const task = bridge.unblockTask(str(args.agent), str(args.task_id));
            return `${task.id.slice(0, 8)} -> ${task.state}`;
        }
        case 'complete_task': {
            const task = bridge.completeTask(str(args.agent), str(args.task_id));
            return `${task.id.slice(0, 8)} -> ${task.state}`;
        }
        case 'cancel_task': {
            const task = bridge.cancelTask(str(args.agent), str(args.task_id), args.note !== undefined ? str(args.note) : undefined);
            return `${task.id.slice(0, 8)} -> ${task.state}`;
        }
        case 'list_tasks': {
            const tasks = bridge.listTasks();
            if (!tasks.length) { return 'No tasks.'; }
            return tasks.map(t => `[${t.id.slice(0, 8)}] (${t.severity}/${t.state}) ${t.title}${t.owner ? ` — ${t.owner}` : ''}${t.blocking_reason ? ` — blocked: ${t.blocking_reason}` : ''}`).join('\n');
        }
        default: return `Unknown tool: ${name}`;
    }
}
