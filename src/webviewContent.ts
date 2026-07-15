import * as vscode from 'vscode';
import { ClaudeMode, CodexMode, SessionRoster } from './types';

export function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Human-readable notice describing what Connect just started, given the roster. */
export function sessionStartNotice(roster: SessionRoster, claudeMode: ClaudeMode, codexMode: CodexMode = 'mcp'): string {
    if (!roster.claude && !roster.codex && !roster.forgeCoordinator) {
        return 'No orchestrator selected - session posted but no agent will react.';
    }
    const parts: string[] = [];
    if (roster.codex) {
        parts.push(codexMode === 'managed-exclusive'
            ? 'managed Codex starting in exclusive mode'
            : 'Codex expected through its own MCP session');
    }
    if (roster.forgeCoordinator) parts.push('Forge model coordinator starting');
    if (roster.claude) {
        parts.push(claudeMode === 'A'
            ? 'paste the Claude /loop prompt to start Claude'
            : 'Claude headless bridge starting');
    }
    return `Session started - ${parts.join('; ')}.`;
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
    <title>Forge Relay Board</title>
</head>
<body>
    <div id="app">
        <header class="topbar">
            <div class="brand">
                <h1>Forge Relay</h1>
                <p class="subtitle">Shared coordination session for Claude and Codex</p>
            </div>
            <div class="topbar-meta">
                <span id="mcp-port" class="badge"></span>
                <button id="autonomy-pill" class="autonomy-pill draft" title="Toggle worker autonomy. Draft = read-only + propose diffs. Clanker = workers write/edit/run (destructive commands still blocked).">Workers: Draft</button>
                <span id="last-activity" class="meta-text">Last activity: none</span>
            </div>
        </header>

        <section id="status-section" class="status-section">
            <div class="status-grid">
                <article class="status-card" data-agent="claude">
                    <div class="status-head">
                        <span class="status-dot" id="status-dot-claude"></span>
                        <div>
                            <h2>Claude</h2>
                            <p id="status-text-claude" class="status-text">Stopped</p>
                        </div>
                    </div>
                    <p id="status-detail-claude" class="status-detail">No board activity yet.</p>
                </article>

                <article class="status-card" data-agent="codex">
                    <div class="status-head">
                        <span class="status-dot" id="status-dot-codex"></span>
                        <div>
                            <h2>Codex</h2>
                            <p id="status-text-codex" class="status-text">Stopped</p>
                        </div>
                    </div>
                    <p id="status-detail-codex" class="status-detail">No board activity yet.</p>
                </article>
            </div>

            <div class="session-actions">
                <button id="btn-connect" class="primary">Connect</button>
                <button id="btn-disconnect">Disconnect</button>
            </div>
        </section>

        <div id="message-banner" class="message-banner hidden"></div>

        <section id="task-section" class="task-section">
            <div class="section-head">
                <h2>Post Task</h2>
                <p>Post the real implementation request here once both agents are running.</p>
            </div>
            <div class="task-row">
                <textarea id="ctrl-note" rows="4" placeholder="Describe the task, plan file, or handoff. Enter to post · Shift+Enter for a new line."></textarea>
                <button id="btn-post-task" class="primary">Post</button>
            </div>
        </section>

        <main class="main-grid">
            <section id="feed-section" class="panel-section feed-section">
                <div class="section-head">
                    <div>
                        <h2>Live Board Feed</h2>
                        <p>Claims, progress, blockers, and coordination.</p>
                    </div>
                    <div class="feed-actions">
                        <select id="session-picker" title="View a saved session (read-only) or return to the live board">
                            <option value="live">● Live session</option>
                        </select>
                        <button id="btn-new-session" class="small" title="Save the current feed as a session and start a fresh one. Nothing is deleted.">New Session</button>
                        <button id="btn-clear-history" class="small" title="Archive the current feed to a saved session, then clear it. Non-destructive.">Clear</button>
                    </div>
                </div>
                <div id="viewing-banner" class="viewing-banner hidden">
                    <span id="viewing-banner-text">Viewing a saved session (read-only).</span>
                    <button id="btn-back-to-live" class="small">Back to live</button>
                </div>
                <div id="event-feed" class="event-feed"></div>
                <div id="feed-empty" class="empty-msg">No events yet.</div>
            </section>

            <aside class="side-stack">
                <section id="claims-section" class="panel-section">
                    <div class="section-head">
                        <h2>Active Claims</h2>
                        <p>Recent ownership to avoid collisions.</p>
                    </div>
                    <div id="claims-list" class="empty-msg">No active claims.</div>
                </section>

                <section id="tasks-section" class="panel-section">
                    <div class="section-head">
                        <h2>Task Cards</h2>
                        <p>Tracked work items and handoffs.</p>
                    </div>
                    <div id="tasks-list" class="empty-msg">No tasks.</div>
                    <div class="control-row">
                        <label for="task-title">Title</label>
                        <input id="task-title" type="text" placeholder="Task title">
                    </div>
                    <div class="control-row">
                        <label for="task-severity">Severity</label>
                        <select id="task-severity">
                            <option value="low">low</option>
                            <option value="medium" selected>medium</option>
                            <option value="high">high</option>
                            <option value="critical">critical</option>
                        </select>
                    </div>
                    <div class="control-row">
                        <label for="task-owner">Owner</label>
                        <input id="task-owner" type="text" placeholder="unassigned">
                    </div>
                    <div class="button-row">
                        <button id="btn-create-task">Create Task</button>
                    </div>
                </section>

                <section id="commands-section" class="panel-section">
                    <div class="section-head commands-head">
                        <div>
                            <h2>Open Commands</h2>
                            <p>STOP and PAUSE control state.</p>
                        </div>
                        <button id="btn-clear-commands" class="small">Clear All Commands</button>
                    </div>
                    <div id="commands-list" class="empty-msg">No open commands.</div>
                </section>

                <section id="manual-section" class="panel-section">
                    <div class="section-head">
                        <h2>Manual Board Actions</h2>
                        <p>Fallback tools for direct board operations.</p>
                    </div>
                    <div class="control-row">
                        <label for="ctrl-agent">Agent</label>
                        <input id="ctrl-agent" type="text" placeholder="claude / codex / user" value="user">
                    </div>
                    <div class="control-row">
                        <label for="ctrl-target">Target</label>
                        <input id="ctrl-target" type="text" placeholder="Repo-relative path">
                    </div>
                    <div class="button-row">
                        <button id="btn-claim">Claim</button>
                        <button id="btn-release">Release</button>
                    </div>
                    <div class="control-row">
                        <label for="ctrl-cmd-target">Command</label>
                        <select id="ctrl-cmd-target">
                            <option value="all">All agents</option>
                            <option value="claude">claude</option>
                            <option value="codex">codex</option>
                            <option value="forge-coordinator">forge-coordinator</option>
                        </select>
                    </div>
                    <div class="button-row">
                        <button id="btn-stop" class="danger">STOP</button>
                        <button id="btn-pause" class="warning">PAUSE</button>
                    </div>
                </section>
            </aside>
        </main>
    </div>

    <div id="connect-modal" class="modal hidden" aria-hidden="true">
        <div class="modal-card">
            <div class="modal-head">
                <div>
                    <h2>Start Agent Session</h2>
                    <p>Choose which orchestrators participate. Only selected agents react to the board; the rest stay inactive.</p>
                </div>
                <button id="btn-close-modal" class="icon-button" aria-label="Close">×</button>
            </div>

            <div class="roster-block">
                <h3>Orchestrators</h3>
                <label class="check-row"><input type="checkbox" id="roster-claude" checked> Claude</label>
                <label class="check-row"><input type="checkbox" id="roster-codex"> Codex</label>
                <label class="check-row"><input type="checkbox" id="roster-forge"> Forge model coordinator</label>
                <div class="control-row hidden" id="forge-model-block">
                    <label for="forge-model">Forge model</label>
                    <select id="forge-model"><option value="">Loading Forge models...</option></select>
                    <p id="forge-model-error" class="prompt-note"></p>
                </div>
                <p class="prompt-note modal-note">Use your existing Codex session normally. Experimental managed mode is exclusive and refuses to start while another Codex app-server is detected.</p>
            </div>

            <div class="mode-block" id="claude-mode-block">
                <h3>Claude mode</h3>
                <label class="check-row"><input type="radio" name="claude-mode" value="B" checked> Run Claude in the background — zero paste, uses your Claude Code login (recommended)</label>
                <label class="check-row"><input type="radio" name="claude-mode" value="A"> Drive Claude from your own chat — paste <code>/loop</code>, you approve every action</label>
            </div>

            <div class="mode-block hidden" id="codex-mode-block">
                <h3>Codex mode</h3>
                <label class="check-row"><input type="radio" name="codex-mode" value="mcp" checked> Use my existing Codex session (recommended)</label>
                <label class="check-row hidden" id="codex-managed-option"><input type="radio" name="codex-mode" value="managed-exclusive"> Run managed Codex exclusively (experimental)</label>
                <p id="codex-managed-warning" class="prompt-note hidden">Close Codex IDE/desktop sessions first. Forge Relay performs a conservative process check and will fail closed if exclusivity cannot be established.</p>
            </div>

            <div class="prompt-block" id="claude-prompt-block">
                <div class="prompt-head">
                    <h3>Claude Code — paste this once</h3>
                    <button id="btn-copy-claude" class="small">Copy</button>
                </div>
                <pre id="prompt-claude" class="prompt-text"></pre>
            </div>

            <div class="prompt-block" id="codex-info-block">
                <div class="prompt-head">
                    <h3>Codex path</h3>
                </div>
                <p class="prompt-note" id="codex-path-note">Codex joins through its own session with the <code>forgerelay</code> MCP server in <code>~/.codex/config.toml</code>. Managed mode is opt-in, experimental, and exclusive because concurrent app-servers sharing authentication/state are not guaranteed safe.</p>
            </div>

            <div class="modal-actions">
                <button id="btn-confirm-connect" class="primary">Start session</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
