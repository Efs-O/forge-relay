import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Bridge } from './bridge';
import { McpServer } from './mcpServer';
import { BoardPanel } from './boardPanel';
import { BoardViewProvider } from './boardView';
import { BoardWatcher } from './boardWatcher';
import { RuntimeManager } from './runtimeManager';
import { RuntimeStatus } from './runtimeBridge';
import { BoardEvent, ClaudeMode, SessionRoster } from './types';

let mcpServer: McpServer | null = null;
let runtimeManager: RuntimeManager | null = null;

const ROSTER_KEY = 'agentwatch.sessionRoster';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('AgentWatch: Open a workspace folder first.');
        return;
    }

    const config = vscode.workspace.getConfiguration('agentwatch');
    const desiredPort = config.get<number>('port', 7878);
    const coordPath = config.get<string>('coordinationPath', '').trim();
    const repoRoot = coordPath || workspaceRoot;

    const bridge = new Bridge(repoRoot);
    bridge.ensureAutonomyDefault(config.get<'draft' | 'clanker'>('defaultAutonomy', 'draft'));
    mcpServer = new McpServer(bridge, {
        bridgeUrl: config.get<string>('subagentBridgeUrl', 'http://127.0.0.1:9099/v1').trim(),
        ollamaUrl: config.get<string>('subagentOllamaUrl', 'http://127.0.0.1:11434/v1').trim(),
        directUrl: config.get<string>('subagentDirectUrl', 'http://127.0.0.1:8080/v1').trim(),
        bridgeApiKey: config.get<string>('subagentBridgeApiKey', '').trim() || undefined,
        defaultBackend: config.get<'bridge' | 'ollama' | 'direct'>('subagentDefaultBackend', 'bridge'),
        forgeControlUrl: config.get<string>('subagentForgeControlUrl', '').trim() || undefined,
    });

    let port: number;
    try {
        // Binds desiredPort if free, else scans upward — so multiple windows don't
        // collide on one fixed port. `port` is the actual bound port from here on.
        port = await mcpServer.start(desiredPort);
    } catch (err) {
        vscode.window.showErrorMessage(`AgentWatch: Could not start MCP server (tried from port ${desiredPort}). ${err}`);
        return;
    }

    // File watcher — push board events to VS Code as notifications.
    // B7: take the events path from the bridge so the watcher, the MCP server and
    // the stdio server all agree on a single coordination dir.
    const eventsPath = bridge.getEventsPath();

    // P2: supervised runtime bridges (Codex app-server wakeup, productized from
    // the old `npm run codex:auto`). The status bar item reflects the dot.
    const runtimeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runtimeStatusBar.command = 'agentwatch.toggleCodexBridge';

    runtimeManager = new RuntimeManager({
        codexScriptPath: path.join(context.extensionUri.fsPath, 'scripts', 'codex-auto-bridge.js'),
        claudeScriptPath: path.join(context.extensionUri.fsPath, 'scripts', 'claude-auto-bridge.js'),
        mcpUrl: `http://127.0.0.1:${port}/sse`,
        repoRoot,
        eventsPath,
        nodePath: config.get<string>('nodePath', '').trim() || undefined,
        claudePermissionMode: config.get<string>('claudePermissionMode', 'acceptEdits').trim() || undefined,
        claudeModel: config.get<string>('claudeModel', '').trim() || undefined,
        onLog: (line) => console.log('[agentwatch:bridge]', line),
    });
    const rm = runtimeManager;

    const renderStatusBar = (): void => {
        const snap = rm.getSnapshot();
        // Lead with the most "active" bridge so the bar reflects the live wakeup path.
        const lead = snap.codex.status !== 'inactive' ? { name: 'Codex', ...snap.codex }
            : snap.claude.status !== 'inactive' ? { name: 'Claude', ...snap.claude }
            : { name: 'Codex', ...snap.codex };
        runtimeStatusBar.text = `$(${statusBarIcon(lead.status)}) AgentWatch: ${lead.name} ${lead.status}`;
        runtimeStatusBar.tooltip = `Codex bridge — ${snap.codex.detail}\nClaude bridge — ${snap.claude.detail}\nClick to ${rm.isAnyActive() ? 'disconnect Codex' : 'connect Codex'}.`;
        runtimeStatusBar.show();
    };
    rm.onChange((snapshot) => {
        renderStatusBar();
        // Persist the roster so the selected bridges auto-reconnect after a reload.
        void context.workspaceState.update(ROSTER_KEY, { roster: snapshot.roster, claudeMode: snapshot.claudeMode });
    });
    renderStatusBar();

    // Sidebar view
    const boardViewProvider = new BoardViewProvider(context.extensionUri, bridge, rm);
    boardViewProvider.updateMcpPort(port);

    const watcher = new BoardWatcher(eventsPath, (event) => handleBoardEvent(event));
    watcher.start();

    // Restore the previous session roster so selected bridges auto-reconnect
    // after a window reload (survives restart, per P2/P3).
    const savedSession = context.workspaceState.get<{ roster: SessionRoster; claudeMode: ClaudeMode }>(ROSTER_KEY);
    if (savedSession?.roster && (savedSession.roster.claude || savedSession.roster.codex)) {
        rm.setRoster(savedSession.roster, savedSession.claudeMode ?? 'A');
    }

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            BoardViewProvider.viewId,
            boardViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),

        vscode.commands.registerCommand('agentwatch.openBoard', () => {
            BoardPanel.createOrShow(context.extensionUri, bridge, rm);
            BoardPanel.current?.updateMcpPort(mcpServer?.getPort() ?? port);
        }),

        vscode.commands.registerCommand('agentwatch.stopAll', () => {
            bridge.postCommand('user', 'STOP — operator halt', 'all');
            vscode.window.showWarningMessage('AgentWatch: STOP posted to all agents.');
        }),

        vscode.commands.registerCommand('agentwatch.toggleClanker', () => {
            const next = bridge.getAutonomyMode() === 'clanker' ? 'draft' : 'clanker';
            bridge.setAutonomyMode(next);
            vscode.window.showInformationMessage(next === 'clanker'
                ? 'AgentWatch: 💥 Clanker Mode ON — workers may write/edit/run (destructive commands still blocked).'
                : 'AgentWatch: Draft mode — workers are read-only and propose diffs for review.');
            boardViewProvider.postAutonomy(next);
            BoardPanel.current?.postAutonomy(next);
        }),

        vscode.commands.registerCommand('agentwatch.toggleCodexBridge', () => {
            if (rm.getSnapshot().codex.status === 'inactive') {
                rm.connectCodex();
                vscode.window.setStatusBarMessage('AgentWatch: Codex runtime bridge connecting…', 4000);
            } else {
                rm.disconnectCodex();
                vscode.window.setStatusBarMessage('AgentWatch: Codex runtime bridge disconnected.', 4000);
            }
        }),

        vscode.commands.registerCommand('agentwatch.showMcpConfig', () => {
            const cfg = buildMcpConfig(context.extensionUri.fsPath, repoRoot, mcpServer?.getPort() ?? port);
            vscode.workspace.openTextDocument({ content: cfg, language: 'markdown' })
                .then(doc => vscode.window.showTextDocument(doc));
        }),

        vscode.commands.registerCommand('agentwatch.verifySetup', async () => {
            const report = buildVerifySetupReport(context.extensionUri.fsPath, repoRoot, mcpServer?.getPort() ?? port);
            const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
            await vscode.window.showTextDocument(doc);
        }),

        runtimeStatusBar,

        {
            dispose: () => {
                mcpServer?.stop();
                watcher.stop();
                rm.stopAll();
            }
        }
    );
}

export function deactivate(): void {
    mcpServer?.stop();
    runtimeManager?.stopAll();
}

// ── Board event → VS Code notification ───────────────────────────────────────

function handleBoardEvent(event: BoardEvent): void {
    const isStop    = event.type === 'command' && /\bSTOP\b/i.test(event.message);
    const isPause   = event.type === 'command' && /\bPAUSE\b/i.test(event.message);
    const isPost    = event.type === 'post';
    const isClaim   = event.type === 'claim';

    if (isStop) {
        // Persistent warning — stays until dismissed
        vscode.window.showWarningMessage(
            `AgentWatch STOP [${event.agent}]: ${event.message}`,
            'Open Board', 'Dismiss'
        ).then(action => {
            if (action === 'Open Board') {
                vscode.commands.executeCommand('agentwatch.openBoard');
            }
        });
        return;
    }

    if (isPause) {
        vscode.window.showWarningMessage(
            `AgentWatch PAUSE [${event.agent}]: ${event.message}`,
            'Open Board'
        ).then(action => {
            if (action === 'Open Board') {
                vscode.commands.executeCommand('agentwatch.openBoard');
            }
        });
        return;
    }

    if (isPost) {
        // Keep board traffic inside AgentWatch instead of routing into whichever chat provider
        // VS Code considers active.
        vscode.window.showInformationMessage(
            `AgentWatch [${event.agent}]: ${event.message}`,
            'Open Board'
        ).then(action => {
            if (action === 'Open Board') {
                vscode.commands.executeCommand('agentwatch.openBoard');
            }
        });
        return;
    }

    if (isClaim) {
        // Subtle status bar hint for claims — not a full popup
        vscode.window.setStatusBarMessage(
            `AgentWatch: ${event.agent} claimed ${event.paths.join(', ')}`,
            5000
        );
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBarIcon(status: RuntimeStatus): string {
    switch (status) {
        case 'linked': return 'pass-filled';
        case 'waiting': return 'sync~spin';
        case 'error': return 'warning';
        case 'unsupported': return 'circle-slash';
        case 'stopped': return 'error';
        default: return 'circle-outline';
    }
}

function buildMcpConfig(extensionPath: string, repoRoot: string, mcpPort: number): string {
    const stdioPath = getStdioPath(extensionPath);
    const repoRootNormalized = toForwardSlashes(repoRoot);
    const claudePaths = getClaudeConfigPaths(repoRoot);

    return [
        '# AgentWatch MCP Config',
        '',
        'AgentWatch no longer writes MCP config into the workspace or your home directory.',
        'Paste one of the snippets below into the client config file you want to manage manually.',
        '',
        '## What AgentWatch handles automatically',
        '',
        '- Ships extension-owned UI metadata such as icons and commands.',
        '- Starts the local AgentWatch MCP server when VS Code opens the workspace.',
        '- Includes repo-owned helper scripts such as `npm run codex:auto`.',
        '',
        '## What you still need to configure manually on each machine',
        '',
        '- Add the AgentWatch MCP entry to Codex `config.toml`.',
        '- Add the AgentWatch MCP entry to the Claude `settings.json` file you want to use.',
        '- Run `AgentWatch: Verify Setup` after configuring both tools.',
        '',
        '## Verified config sources in this environment',
        '',
        '- Claude Code reads `settings.json` style files. Observed paths:',
        `  - User: \`${toForwardSlashes(claudePaths.user)}\``,
        `  - Workspace: \`${toForwardSlashes(claudePaths.workspace)}\``,
        `  - Workspace local override: \`${toForwardSlashes(claudePaths.workspaceLocal)}\``,
        `- Codex reads \`${toForwardSlashes(getCodexConfigPath())}\`.`,
        '',
        `## Codex (\`${toForwardSlashes(getCodexConfigPath())}\`)`,
        '',
        '```toml',
        '[mcp_servers.agentwatch]',
        'command = "node"',
        `args = ["${stdioPath}", "--repoRoot", "${repoRootNormalized}"]`,
        '```',
        '',
        '## Claude Code (`settings.json` file)',
        '',
        'Add or merge this under the top-level object in the Claude settings file you want to use:',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "agentwatch": {',
        '      "type": "sse",',
        `      "url": "http://127.0.0.1:${mcpPort}/sse"`,
        '    }',
        '  }',
        '}',
        '```',
        '',
        '## Recovery',
        '',
        '- If Claude stops launching, rename workspace `.claude/settings.json` first.',
        '- If that does not recover it, rename workspace `.claude/settings.local.json` or the whole workspace `.claude` folder.',
        '- Prefer renaming for rollback; do not delete the files first.',
        '',
    ].join('\n');
}

function buildVerifySetupReport(extensionPath: string, repoRoot: string, mcpPort: number): string {
    const stdioPath = getStdioPath(extensionPath);
    const codexConfigPath = getCodexConfigPath();
    const claudePaths = getClaudeConfigPaths(repoRoot);
    const nodeCheck = checkNodeRuntime();
    const stdioExists = fs.existsSync(stdioPath);
    const codexConfig = inspectFile(codexConfigPath, hasCodexAgentwatchConfig);
    const claudeUserConfig = inspectFile(claudePaths.user, hasClaudeAgentwatchConfig);
    const claudeWorkspaceConfig = inspectFile(claudePaths.workspace, hasClaudeAgentwatchConfig);
    const claudeWorkspaceLocalConfig = inspectFile(claudePaths.workspaceLocal, hasClaudeAgentwatchConfig);
    const anyClaudeConfigured = [claudeUserConfig, claudeWorkspaceConfig, claudeWorkspaceLocalConfig]
        .some(result => result.hasEntry);

    return [
        '# AgentWatch Verify Setup',
        '',
        `Checked at: ${new Date().toISOString()}`,
        `Repo root: \`${toForwardSlashes(repoRoot)}\``,
        `Coordination dir: \`${toForwardSlashes(path.join(repoRoot, '.coordination'))}\``,
        '',
        '## Verification',
        '',
        formatCheck('Node runtime available', nodeCheck.ok, nodeCheck.detail),
        formatCheck('Built MCP stdio bundle exists', stdioExists, toForwardSlashes(stdioPath)),
        formatCheck('Codex config has `agentwatch` entry', codexConfig.hasEntry, describeInspection(codexConfig)),
        formatCheck('At least one checked Claude settings file has `agentwatch` entry', anyClaudeConfigured, summarizeClaudeStatus([claudeUserConfig, claudeWorkspaceConfig, claudeWorkspaceLocalConfig])),
        '',
        '## Claude file inspection',
        '',
        formatFileInspection('User settings', claudeUserConfig),
        formatFileInspection('Workspace settings', claudeWorkspaceConfig),
        formatFileInspection('Workspace local settings', claudeWorkspaceLocalConfig),
        '',
        '## Interpretation',
        '',
        `- Codex config status: ${summarizeStatus(codexConfig)}.`,
        `- Claude config status: ${summarizeClaudeStatus([claudeUserConfig, claudeWorkspaceConfig, claudeWorkspaceLocalConfig])}.`,
        '- This command does not modify any config files.',
        '',
        buildMcpConfig(extensionPath, repoRoot, mcpPort),
    ].join('\n');
}

function getStdioPath(extensionPath: string): string {
    return toForwardSlashes(path.join(extensionPath, 'out', 'mcpStdio.js'));
}

function getCodexConfigPath(): string {
    return path.join(os.homedir(), '.codex', 'config.toml');
}

function getClaudeConfigPaths(repoRoot: string): { user: string; workspace: string; workspaceLocal: string } {
    return {
        user: path.join(os.homedir(), '.claude', 'settings.json'),
        workspace: path.join(repoRoot, '.claude', 'settings.json'),
        workspaceLocal: path.join(repoRoot, '.claude', 'settings.local.json'),
    };
}

function checkNodeRuntime(): { ok: boolean; detail: string } {
    const result = spawnSync('node', ['--version'], { encoding: 'utf8' });
    if (result.error) {
        return { ok: false, detail: `node --version failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
        return { ok: false, detail: `node --version failed: ${detail}` };
    }
    return { ok: true, detail: (result.stdout || '').trim() };
}

function inspectFile(filePath: string, matcher: (content: string) => boolean): { path: string; exists: boolean; hasEntry: boolean; detail: string } {
    if (!fs.existsSync(filePath)) {
        return { path: filePath, exists: false, hasEntry: false, detail: 'missing' };
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const hasEntry = matcher(content);
        return {
            path: filePath,
            exists: true,
            hasEntry,
            detail: hasEntry ? 'entry found' : 'entry missing',
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { path: filePath, exists: true, hasEntry: false, detail: `read failed: ${message}` };
    }
}

function hasCodexAgentwatchConfig(content: string): boolean {
    return /\[mcp_servers\.agentwatch\]/i.test(content);
}

function hasClaudeAgentwatchConfig(content: string): boolean {
    return /"agentwatch"\s*:/i.test(content);
}

function formatCheck(label: string, ok: boolean, detail: string): string {
    return `- ${ok ? 'PASS' : 'FAIL'}: ${label} (${detail})`;
}

function formatFileInspection(label: string, result: { path: string; exists: boolean; hasEntry: boolean; detail: string }): string {
    return `- ${label}: ${result.detail}; ${toForwardSlashes(result.path)}`;
}

function describeInspection(result: { path: string; exists: boolean; detail: string }): string {
    return `${result.detail}; ${toForwardSlashes(result.path)}`;
}

function summarizeStatus(result: { exists: boolean; hasEntry: boolean }): string {
    if (result.hasEntry) {
        return 'configured';
    }
    if (result.exists) {
        return 'file exists but agentwatch entry is missing';
    }
    return 'config file missing';
}

function summarizeClaudeStatus(results: Array<{ exists: boolean; hasEntry: boolean; path: string }>): string {
    const configured = results.filter(result => result.hasEntry);
    if (configured.length > 0) {
        return `configured in ${configured.map(result => `\`${toForwardSlashes(result.path)}\``).join(', ')}`;
    }
    if (results.some(result => result.exists)) {
        return 'settings files exist but no agentwatch entry was found';
    }
    return 'no checked settings file currently contains an agentwatch entry';
}

function toForwardSlashes(value: string): string {
    return value.replace(/\\/g, '/');
}
