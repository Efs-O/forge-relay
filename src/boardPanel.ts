import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { ExtensionMessage, WebviewMessage } from './types';
import { getNonce, getWebviewHtml } from './webviewContent';

export class BoardPanel {
    public static current: BoardPanel | undefined;
    private static readonly viewType = 'agentwatch.board';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly bridge: Bridge;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(extensionUri: vscode.Uri, bridge: Bridge): void {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (BoardPanel.current) {
            BoardPanel.current.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            BoardPanel.viewType,
            'AgentWatch Board',
            column,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true,
            }
        );

        BoardPanel.current = new BoardPanel(panel, extensionUri, bridge);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, bridge: Bridge) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.bridge = bridge;

        this.panel.webview.html = this.getHtml();
        this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');

        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handleWebviewMessage(msg),
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.startPolling();
    }

    private startPolling(): void {
        const push = () => {
            try {
                const state = this.bridge.getState();
                const msg: ExtensionMessage = { type: 'stateUpdate', state };
                this.panel.webview.postMessage(msg);
            } catch { /* bridge unavailable */ }
        };
        push();
        this.pollTimer = setInterval(push, 2000);
    }

    private handleWebviewMessage(msg: WebviewMessage): void {
        const config = vscode.workspace.getConfiguration('agentwatch');
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
                case 'claim':
                    this.bridge.claim(msg.agent, msg.targets, msg.ttlMinutes ?? defaultTtl, msg.note);
                    break;
                case 'release':
                    this.bridge.release(msg.agent, msg.targets, msg.note ?? '');
                    break;
                case 'ready':
                    // webview mounted — send immediate state + MCP port
                    try {
                        const state = this.bridge.getState();
                        this.panel.webview.postMessage({ type: 'stateUpdate', state } satisfies ExtensionMessage);
                    } catch { /* ignore */ }
                    break;
            }
        } catch (err) {
            vscode.window.showErrorMessage(`AgentWatch: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    public updateMcpPort(port: number): void {
        const msg: ExtensionMessage = { type: 'mcpPort', port };
        this.panel.webview.postMessage(msg);
    }

    private getHtml(): string {
        return getWebviewHtml(this.panel.webview, this.extensionUri, getNonce());
    }

    dispose(): void {
        BoardPanel.current = undefined;
        if (this.pollTimer) { clearInterval(this.pollTimer); }
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

