import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { BoardState, ExtensionMessage, WebviewMessage } from './types';
import { getNonce, getWebviewHtml } from './webviewContent';

export class BoardViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'agentwatch.boardView';

    private view?: vscode.WebviewView;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private mcpPort = 7878;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly bridge: Bridge,
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

        webviewView.onDidDispose(() => this.stopPolling());

        this.startPolling();
    }

    updateMcpPort(port: number): void {
        this.mcpPort = port;
        this.post({ type: 'mcpPort', port });
    }

    private startPolling(): void {
        this.stopPolling();
        const push = () => {
            try {
                const state = this.bridge.getState();
                this.post({ type: 'stateUpdate', state });
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

    private handleMessage(msg: WebviewMessage): void {
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
                    this.post({ type: 'mcpPort', port: this.mcpPort });
                    try {
                        const state = this.bridge.getState();
                        this.post({ type: 'stateUpdate', state });
                    } catch { /* ignore */ }
                    break;
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                `AgentWatch: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }
}
