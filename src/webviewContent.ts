import * as vscode from 'vscode';

export function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function getWebviewHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    nonce: string
): string {
    const mediaUri = (file: string) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

    const cssUri = mediaUri('board.css');
    const jsUri = mediaUri('board.js');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${cssUri}">
    <title>AgentWatch Board</title>
</head>
<body>
    <div id="app">
        <header>
            <h1>AgentWatch</h1>
            <span id="mcp-port" class="badge"></span>
            <div id="stop-banner" class="hidden">&#9632; STOP ACTIVE</div>
        </header>

        <section id="claims-section">
            <h2>Active Claims</h2>
            <div id="claims-list" class="empty-msg">No active claims.</div>
        </section>

        <section id="commands-section">
            <h2>Open Commands</h2>
            <div id="commands-list" class="empty-msg">No open commands.</div>
        </section>

        <section id="feed-section">
            <h2>Event Feed</h2>
            <div id="event-feed"></div>
        </section>

        <section id="controls-section">
            <h2>Controls</h2>
            <div class="control-row">
                <label>Agent</label>
                <input id="ctrl-agent" type="text" placeholder="claude / codex / user" value="user">
            </div>
            <div class="control-row">
                <label>Message</label>
                <input id="ctrl-note" type="text" placeholder="Progress note">
                <button id="btn-post">Post</button>
            </div>
            <div class="control-row">
                <label>Target</label>
                <input id="ctrl-target" type="text" placeholder="Repo-relative path">
                <button id="btn-claim">Claim</button>
                <button id="btn-release">Release</button>
            </div>
            <div class="control-row stop-row">
                <label>Operator</label>
                <select id="ctrl-cmd-target">
                    <option value="all">All agents</option>
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                </select>
                <button id="btn-stop" class="danger">STOP</button>
                <button id="btn-pause" class="warning">PAUSE</button>
                <button id="btn-resume">RESUME</button>
            </div>
        </section>
    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
