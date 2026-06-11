import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { RuntimeManager } from './runtimeManager';
import { BoardState, ExtensionMessage, WebviewMessage } from './types';
import { getNonce, getWebviewHtml, sessionStartNotice } from './webviewContent';

export class BoardViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'forgeRelay.boardView';

    private view?: vscode.WebviewView;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private mcpPort = 7878;
    private runtimeSub: { dispose(): void } | null = null;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly bridge: Bridge,
        private readonly runtime: RuntimeManager,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };

        webviewView.webview.html = getWebviewHtml(
            webviewView.webview,
            this.extensionUri,
            getNonce(),
        );

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
            this.handleMessage(msg)
        );

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.startPolling();
            } else {
                this.stopPolling();
            }
        });

        this.runtimeSub?.dispose();
        this.runtimeSub = this.runtime.onChange((snapshot) => this.post({ type: 'runtimeStatus', runtime: snapshot }));

        webviewView.onDidDispose(() => {
            this.stopPolling();
            this.runtimeSub?.dispose();
            this.runtimeSub = null;
        });

        this.startPolling();
    }

    updateMcpPort(port: number): void {
        this.mcpPort = port;
        this.post({ type: 'mcpPort', port });
    }

    postAutonomy(mode: 'draft' | 'clanker'): void {
        this.post({ type: 'autonomyState', mode });
    }

    private startPolling(): void {
        this.stopPolling();
        const push = () => {
            try {
                const state = this.bridge.getState();
                this.post({ type: 'stateUpdate', state });
                this.post({ type: 'sessionState', session: this.bridge.getSessionState() });
            } catch { /* bridge unavailable */ }
        };
        push();
        this.pollTimer = setInterval(push, 2000);
    }

    private stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private post(msg: ExtensionMessage): void {
        this.view?.webview.postMessage(msg);
    }

    /** Push the live board state, session presence, and saved-session list. */
    private refreshFeed(): void {
        try {
            this.post({ type: 'stateUpdate', state: this.bridge.getState() });
            this.post({ type: 'sessionState', session: this.bridge.getSessionState() });
            this.post({ type: 'sessionList', sessions: this.bridge.listSessions() });
        } catch { /* bridge unavailable */ }
    }

    private handleMessage(msg: WebviewMessage): void {
        const config = vscode.workspace.getConfiguration('forgeRelay');
        const defaultTtl = config.get<number>('claimTtlMinutes', 120);

        try {
            switch (msg.type) {
                case 'post':
                    this.bridge.post(msg.agent, msg.note);
                    break;
                case 'command':
                    this.bridge.postCommand(msg.agent, msg.note, msg.targetAgent);
                    break;
                case 'ack':
                    this.bridge.ack(msg.agent, msg.commandId, msg.note);
                    break;
                case 'resolve':
                    this.bridge.resolve(msg.agent, msg.commandId, msg.note);
                    break;
                case 'clearAllCommands': {
                    const resolved = this.bridge.clearAllCommands(msg.agent, msg.note);
                    this.post({
                        type: 'notice',
                        message: resolved > 0
                            ? `Cleared ${resolved} STOP/PAUSE command(s).`
                            : 'No open STOP/PAUSE commands to clear.',
                    });
                    break;
                }
                case 'clearHistory': {
                    const archived = this.bridge.archiveAndReset();
                    this.post({ type: 'notice', message: archived
                        ? `Feed archived as "${archived.label}" and cleared.`
                        : 'Feed already empty — nothing to archive.' });
                    this.refreshFeed();
                    break;
                }
                case 'newSession': {
                    const archived = this.bridge.archiveAndReset(msg.label);
                    this.post({ type: 'notice', message: archived
                        ? `New session started — previous feed saved as "${archived.label}".`
                        : 'New session started.' });
                    this.refreshFeed();
                    break;
                }
                case 'listSessions':
                    this.post({ type: 'sessionList', sessions: this.bridge.listSessions() });
                    break;
                case 'loadSession':
                    this.post({ type: 'sessionEvents', id: msg.id, events: this.bridge.readSessionEvents(msg.id) });
                    break;
                case 'claim':
                    this.bridge.claim(msg.agent, msg.targets, msg.ttlMinutes ?? defaultTtl, msg.note);
                    break;
                case 'release':
                    this.bridge.release(msg.agent, msg.targets, msg.note ?? '');
                    break;
                case 'connectSession': {
                    // P3: apply the chosen roster. Only selected agents participate
                    // in the session; Codex joins via its own MCP session.
                    this.runtime.setRoster(msg.roster, msg.claudeMode);
                    this.bridge.startSession(msg.agent, {
                        roster: msg.roster,
                        claudeMode: msg.claudeMode,
                    });
                    this.post({
                        type: 'notice',
                        message: sessionStartNotice(msg.roster, msg.claudeMode),
                    });
                    this.post({ type: 'stateUpdate', state: this.bridge.getState() });
                    this.post({ type: 'sessionState', session: this.bridge.getSessionState() });
                    this.post({ type: 'runtimeStatus', runtime: this.runtime.getSnapshot() });
                    break;
                }
                case 'disconnectSession':
                    this.bridge.endSession(msg.agent);
                    this.runtime.setRoster({ claude: false, codex: false }, this.runtime.getClaudeMode());
                    this.post({ type: 'notice', message: 'SESSION_END posted; runtime bridges stopped.' });
                    this.post({ type: 'sessionState', session: this.bridge.getSessionState() });
                    this.post({ type: 'runtimeStatus', runtime: this.runtime.getSnapshot() });
                    break;
                case 'toggleAutonomy': {
                    const next = this.bridge.getAutonomyMode() === 'clanker' ? 'draft' : 'clanker';
                    this.bridge.setAutonomyMode(next);
                    this.post({ type: 'autonomyState', mode: next });
                    this.post({ type: 'notice', message: next === 'clanker'
                        ? '💥 Clanker Mode ON — workers may write/edit/run (destructive commands still blocked).'
                        : 'Draft mode — workers are read-only and propose diffs for review.' });
                    break;
                }
                case 'ready':
                    this.post({ type: 'mcpPort', port: this.mcpPort });
                    this.post({ type: 'runtimeStatus', runtime: this.runtime.getSnapshot() });
                    this.post({ type: 'autonomyState', mode: this.bridge.getAutonomyMode() });
                    this.refreshFeed();
                    break;
            }
        } catch (err) {
            const message = `Forge Relay: ${err instanceof Error ? err.message : String(err)}`;
            vscode.window.showErrorMessage(message);
            this.post({ type: 'error', message });
        }
    }
}
