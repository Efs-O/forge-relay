import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { RuntimeManager } from './runtimeManager';
import { ExtensionMessage, WebviewMessage } from './types';
import { getNonce, getWebviewHtml, sessionStartNoticeWithCodexMode } from './webviewContent';

export class BoardPanel {
    public static current: BoardPanel | undefined;
    private static readonly viewType = 'forgeRelay.board';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly bridge: Bridge;
    private readonly runtime: RuntimeManager;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private runtimeSub: { dispose(): void } | null = null;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(extensionUri: vscode.Uri, bridge: Bridge, runtime: RuntimeManager): void {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (BoardPanel.current) {
            BoardPanel.current.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            BoardPanel.viewType,
            'Forge Relay Board',
            column,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true,
            }
        );

        BoardPanel.current = new BoardPanel(panel, extensionUri, bridge, runtime);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, bridge: Bridge, runtime: RuntimeManager) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.bridge = bridge;
        this.runtime = runtime;

        this.panel.webview.html = this.getHtml();
        this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');

        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handleWebviewMessage(msg),
            null,
            this.disposables
        );

        this.runtimeSub = this.runtime.onChange((snapshot) =>
            this.panel.webview.postMessage({ type: 'runtimeStatus', runtime: snapshot } satisfies ExtensionMessage));

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.startPolling();
    }

    private startPolling(): void {
        const push = () => {
            try {
                const state = this.bridge.getState();
                const msg: ExtensionMessage = { type: 'stateUpdate', state };
                this.panel.webview.postMessage(msg);
                this.panel.webview.postMessage({ type: 'sessionState', session: this.bridge.getSessionState() } satisfies ExtensionMessage);
            } catch { /* bridge unavailable */ }
        };
        push();
        this.pollTimer = setInterval(push, 2000);
    }

    /** Push the live board state, session presence, and saved-session list. */
    private refreshFeed(): void {
        try {
            this.panel.webview.postMessage({ type: 'stateUpdate', state: this.bridge.getState() } satisfies ExtensionMessage);
            this.panel.webview.postMessage({ type: 'sessionState', session: this.bridge.getSessionState() } satisfies ExtensionMessage);
            this.panel.webview.postMessage({ type: 'sessionList', sessions: this.bridge.listSessions() } satisfies ExtensionMessage);
        } catch { /* bridge unavailable */ }
    }

    private handleWebviewMessage(msg: WebviewMessage): void {
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
                    this.panel.webview.postMessage({
                        type: 'notice',
                        message: resolved > 0
                            ? `Cleared ${resolved} STOP/PAUSE command(s).`
                            : 'No open STOP/PAUSE commands to clear.',
                    } satisfies ExtensionMessage);
                    break;
                }
                case 'clearHistory': {
                    const archived = this.bridge.archiveAndReset();
                    this.panel.webview.postMessage({
                        type: 'notice',
                        message: archived
                            ? `Feed archived as "${archived.label}" and cleared.`
                            : 'Feed already empty — nothing to archive.',
                    } satisfies ExtensionMessage);
                    this.refreshFeed();
                    break;
                }
                case 'newSession': {
                    const archived = this.bridge.archiveAndReset(msg.label);
                    this.panel.webview.postMessage({
                        type: 'notice',
                        message: archived
                            ? `New session started — previous feed saved as "${archived.label}".`
                            : 'New session started.',
                    } satisfies ExtensionMessage);
                    this.refreshFeed();
                    break;
                }
                case 'listSessions':
                    this.panel.webview.postMessage({ type: 'sessionList', sessions: this.bridge.listSessions() } satisfies ExtensionMessage);
                    break;
                case 'loadSession':
                    this.panel.webview.postMessage({ type: 'sessionEvents', id: msg.id, events: this.bridge.readSessionEvents(msg.id) } satisfies ExtensionMessage);
                    break;
                case 'claim':
                    this.bridge.claim(msg.agent, msg.targets, msg.ttlMinutes ?? defaultTtl, msg.note);
                    break;
                case 'release':
                    this.bridge.release(msg.agent, msg.targets, msg.note ?? '');
                    break;
                case 'connectSession':
                    this.runtime.setRoster(msg.roster, msg.claudeMode, msg.managedCodexBridge);
                    this.bridge.startSession(msg.agent, {
                        roster: msg.roster,
                        claudeMode: msg.claudeMode,
                        managedCodexBridge: msg.managedCodexBridge,
                    });
                    this.panel.webview.postMessage({
                        type: 'notice',
                        message: sessionStartNoticeWithCodexMode(msg.roster, msg.claudeMode, msg.managedCodexBridge),
                    } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'stateUpdate', state: this.bridge.getState() } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'sessionState', session: this.bridge.getSessionState() } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'runtimeStatus', runtime: this.runtime.getSnapshot() } satisfies ExtensionMessage);
                    break;
                case 'disconnectSession':
                    this.bridge.endSession(msg.agent);
                    this.runtime.setRoster({ claude: false, codex: false }, this.runtime.getClaudeMode(), false);
                    this.panel.webview.postMessage({
                        type: 'notice',
                        message: 'SESSION_END posted; runtime bridges stopped.',
                    } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'sessionState', session: this.bridge.getSessionState() } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'runtimeStatus', runtime: this.runtime.getSnapshot() } satisfies ExtensionMessage);
                    break;
                case 'toggleAutonomy': {
                    const next = this.bridge.getAutonomyMode() === 'clanker' ? 'draft' : 'clanker';
                    this.bridge.setAutonomyMode(next);
                    this.panel.webview.postMessage({ type: 'autonomyState', mode: next } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'notice', message: next === 'clanker'
                        ? '💥 Clanker Mode ON — workers may write/edit/run (destructive commands still blocked).'
                        : 'Draft mode — workers are read-only and propose diffs for review.' } satisfies ExtensionMessage);
                    break;
                }
                case 'ready':
                    this.panel.webview.postMessage({ type: 'runtimeStatus', runtime: this.runtime.getSnapshot() } satisfies ExtensionMessage);
                    this.panel.webview.postMessage({ type: 'autonomyState', mode: this.bridge.getAutonomyMode() } satisfies ExtensionMessage);
                    this.refreshFeed();
                    break;
            }
        } catch (err) {
            const message = `Forge Relay: ${err instanceof Error ? err.message : String(err)}`;
            vscode.window.showErrorMessage(message);
            this.panel.webview.postMessage({ type: 'error', message } satisfies ExtensionMessage);
        }
    }

    public updateMcpPort(port: number): void {
        const msg: ExtensionMessage = { type: 'mcpPort', port };
        this.panel.webview.postMessage(msg);
    }

    public postAutonomy(mode: 'draft' | 'clanker'): void {
        this.panel.webview.postMessage({ type: 'autonomyState', mode } satisfies ExtensionMessage);
    }

    private getHtml(): string {
        return getWebviewHtml(this.panel.webview, this.extensionUri, getNonce());
    }

    dispose(): void {
        BoardPanel.current = undefined;
        if (this.pollTimer) { clearInterval(this.pollTimer); }
        this.runtimeSub?.dispose();
        this.runtimeSub = null;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}
