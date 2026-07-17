import * as fs from 'node:fs';
import * as path from 'node:path';

export const CODEX_FORGERELAY_SAFE_AUTO_APPROVE_TOOLS = Object.freeze([
    'board_check', 'get_status', 'post', 'claim', 'release',
    'ack_command', 'resolve_command',
    'create_task', 'update_task', 'assign_task', 'start_task',
    'block_task', 'unblock_task', 'complete_task', 'cancel_task', 'list_tasks',
    'list_models', 'get_subagent_run',
]);

export type CodexMcpConfigResult = {
    status: 'created' | 'appended' | 'updated' | 'already' | 'error';
    path: string;
    detail?: string;
};

function serverHeader(stdioPath: string): string[] {
    return [
        '[mcp_servers.forgerelay]',
        'command = "node"',
        `args = ["${stdioPath.replace(/\\/g, '/')}"]`,
        '',
    ];
}

function approvalBlock(tool: string): string[] {
    return [
        `[mcp_servers.forgerelay.tools.${tool}]`,
        'approval_mode = "approve"',
        '',
    ];
}

export function buildCodexMcpConfigBlock(stdioPath: string, includeServer = true): string {
    return [
        ...(includeServer ? serverHeader(stdioPath) : []),
        ...CODEX_FORGERELAY_SAFE_AUTO_APPROVE_TOOLS.flatMap(approvalBlock),
    ].join('\n');
}

export function inspectCodexMcpApprovals(content: string): { missing: string[]; conflicts: string[] } {
    const missing: string[] = [];
    const conflicts: string[] = [];
    for (const tool of CODEX_FORGERELAY_SAFE_AUTO_APPROVE_TOOLS) {
        const header = new RegExp(`^\\s*\\[mcp_servers\\.forgerelay\\.tools\\.${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`, 'mi');
        const match = header.exec(content);
        if (!match) {
            missing.push(tool);
            continue;
        }
        const tail = content.slice(match.index + match[0].length);
        const section = tail.split(/^\s*\[/m, 1)[0];
        if (!/^\s*approval_mode\s*=\s*["']approve["']\s*$/mi.test(section)) conflicts.push(tool);
    }
    return { missing, conflicts };
}

export function configureCodexMcpConfig(
    configPath: string,
    stdioPath: string,
): CodexMcpConfigResult {
    try {
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, buildCodexMcpConfigBlock(stdioPath), 'utf8');
            return { status: 'created', path: configPath };
        }
        const existing = fs.readFileSync(configPath, 'utf8');
        const hasServer = /^\s*\[mcp_servers\.forgerelay\]\s*$/mi.test(existing);
        const approvals = inspectCodexMcpApprovals(existing);
        if (approvals.conflicts.length) {
            return {
                status: 'error',
                path: configPath,
                detail: `existing approval policy is not "approve" for: ${approvals.conflicts.join(', ')}; refusing to overwrite user policy`,
            };
        }
        if (hasServer && approvals.missing.length === 0) return { status: 'already', path: configPath };
        const additions = [
            ...(!hasServer ? serverHeader(stdioPath) : []),
            ...approvals.missing.flatMap(approvalBlock),
        ].join('\n');
        const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
        fs.appendFileSync(configPath, prefix + additions, 'utf8');
        return { status: hasServer ? 'updated' : 'appended', path: configPath };
    } catch (error) {
        return { status: 'error', path: configPath, detail: error instanceof Error ? error.message : String(error) };
    }
}
