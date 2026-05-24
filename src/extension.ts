import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Bridge } from './bridge';
import { McpServer } from './mcpServer';
import { BoardPanel } from './boardPanel';
import { BoardViewProvider } from './boardView';
import { BoardWatcher } from './boardWatcher';
import { BoardEvent } from './types';

let mcpServer: McpServer | null = null;

export function activate(context: vscode.ExtensionContext): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('AgentWatch: Open a workspace folder first.');
        return;
    }

    const config = vscode.workspace.getConfiguration('agentwatch');
    const port = config.get<number>('port', 7878);
    const coordPath = config.get<string>('coordinationPath', '').trim();
    const repoRoot = coordPath || workspaceRoot;

    const bridge = new Bridge(repoRoot);
    mcpServer = new McpServer(bridge);

    try {
        mcpServer.start(port);
    } catch (err) {
        vscode.window.showErrorMessage(`AgentWatch: Could not start MCP server on port ${port}. ${err}`);
        return;
    }

    // Auto-write .mcp.json so CLI agents in the coordinated repo connect automatically
    writeMcpJson(repoRoot, context.extensionUri.fsPath);

    // Sidebar view
    const boardViewProvider = new BoardViewProvider(context.extensionUri, bridge);
    boardViewProvider.updateMcpPort(port);

    // File watcher — push board events to VS Code as notifications
    const eventsPath = path.join(repoRoot, '.coordination', 'events.ndjson');
    const watcher = new BoardWatcher(eventsPath, (event) => handleBoardEvent(event));
    watcher.start();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            BoardViewProvider.viewId,
            boardViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),

        vscode.commands.registerCommand('agentwatch.openBoard', () => {
            BoardPanel.createOrShow(context.extensionUri, bridge);
            BoardPanel.current?.updateMcpPort(mcpServer?.getPort() ?? port);
        }),

        vscode.commands.registerCommand('agentwatch.stopAll', () => {
            bridge.postCommand('user', 'STOP — operator halt', 'all');
            vscode.window.showWarningMessage('AgentWatch: STOP posted to all agents.');
        }),

        vscode.commands.registerCommand('agentwatch.showMcpConfig', () => {
            const cfg = buildMcpConfig(context.extensionUri.fsPath, repoRoot);
            vscode.workspace.openTextDocument({ content: cfg, language: 'json' })
                .then(doc => vscode.window.showTextDocument(doc));
        }),

        {
            dispose: () => {
                mcpServer?.stop();
                watcher.stop();
            }
        }
    );
}

export function deactivate(): void {
    mcpServer?.stop();
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

function writeMcpJson(workspaceRoot: string, extensionPath: string): void {
    const mcpPath = path.join(workspaceRoot, '.mcp.json');
    try {
        const existing = fs.existsSync(mcpPath)
            ? JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
            : {};
        existing.mcpServers = existing.mcpServers ?? {};
        existing.mcpServers.agentwatch = {
            command: 'node',
            args: [path.join(extensionPath, 'out', 'mcpStdio.js'), '--repoRoot', workspaceRoot],
        };
        fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2), 'utf8');
    } catch (err) {
        vscode.window.showWarningMessage(`AgentWatch: Could not write .mcp.json — ${err}`);
    }
}

function buildMcpConfig(extensionPath: string, repoRoot: string): string {
    return JSON.stringify(
        {
            mcpServers: {
                agentwatch: {
                    command: 'node',
                    args: [path.join(extensionPath, 'out', 'mcpStdio.js'), '--repoRoot', repoRoot],
                },
            },
        },
        null, 2
    );
}
