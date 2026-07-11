// @ts-check
/// <reference lib="dom" />
'use strict';

const vscode = acquireVsCodeApi();

const eventFeed = /** @type {HTMLElement} */ (document.getElementById('event-feed'));
const feedEmpty = /** @type {HTMLElement} */ (document.getElementById('feed-empty'));
const claimsList = /** @type {HTMLElement} */ (document.getElementById('claims-list'));
const commandsList = /** @type {HTMLElement} */ (document.getElementById('commands-list'));
const mcpPortBadge = /** @type {HTMLElement} */ (document.getElementById('mcp-port'));
const lastActivity = /** @type {HTMLElement} */ (document.getElementById('last-activity'));
const banner = /** @type {HTMLElement} */ (document.getElementById('message-banner'));

const ctrlAgent = /** @type {HTMLInputElement} */ (document.getElementById('ctrl-agent'));
const ctrlNote = /** @type {HTMLTextAreaElement} */ (document.getElementById('ctrl-note'));
const ctrlTarget = /** @type {HTMLInputElement} */ (document.getElementById('ctrl-target'));
const sessionPicker = /** @type {HTMLSelectElement} */ (document.getElementById('session-picker'));
const viewingBanner = /** @type {HTMLElement} */ (document.getElementById('viewing-banner'));
const viewingBannerText = /** @type {HTMLElement} */ (document.getElementById('viewing-banner-text'));
const ctrlCmdTarget = /** @type {HTMLSelectElement} */ (document.getElementById('ctrl-cmd-target'));

const connectModal = /** @type {HTMLElement} */ (document.getElementById('connect-modal'));
const promptClaude = /** @type {HTMLElement} */ (document.getElementById('prompt-claude'));
const rosterClaude = /** @type {HTMLInputElement} */ (document.getElementById('roster-claude'));
const rosterCodex = /** @type {HTMLInputElement} */ (document.getElementById('roster-codex'));
const claudePromptBlock = /** @type {HTMLElement} */ (document.getElementById('claude-prompt-block'));
const claudeModeBlock = /** @type {HTMLElement} */ (document.getElementById('claude-mode-block'));
const codexInfoBlock = /** @type {HTMLElement} */ (document.getElementById('codex-info-block'));

/** @type {any[]}*/
let latestEvents = [];
/** @type {any[]} */
let currentFeedEvents = [];
/** @type {{ event: any, count: number }[]}*/
let latestRenderedEntries = [];
const expandedEventIndices = new Set();
const EVENT_MESSAGE_PREVIEW_CHARS = 700;
let currentSessionState = null;
let shouldAutoScroll = true;
/** @type {{ status: string, detail: string }} */
let claudeRuntime = { status: 'inactive', detail: 'Not connected.' };
/** @type {'A'|'B'} */
let currentClaudeMode = 'B';
/** @type {{ claude: any, codex: any }} */
let lastPresence = { claude: null, codex: null };
/** @type {{ claude: boolean, codex: boolean } | null} */
let currentRoster = null;
// When set, the feed is showing a saved (read-only) session and live polling
// must not overwrite it. null = viewing the live board.
/** @type {string | null} */
let viewingSessionId = null;

eventFeed.addEventListener('scroll', () => {
    const distanceFromBottom = eventFeed.scrollHeight - eventFeed.scrollTop - eventFeed.clientHeight;
    shouldAutoScroll = distanceFromBottom < 24;
});

window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
    const msg = event.data;
    if (msg.type === 'stateUpdate') {
        renderState(msg.state);
    }
    if (msg.type === 'sessionState') {
        currentSessionState = msg.session;
        renderSessionState(msg.session);
    }
    if (msg.type === 'mcpPort') {
        mcpPortBadge.textContent = `MCP :${msg.port}`;
        renderSessionPrompts(msg.port);
    }
    if (msg.type === 'error') {
        renderErrorState();
        showBanner(msg.message, 'error');
    }
    if (msg.type === 'notice') {
        showBanner(msg.message, 'notice');
    }
    if (msg.type === 'autonomyState') {
        renderAutonomy(msg.mode);
    }
    if (msg.type === 'sessionList') {
        renderSessionList(msg.sessions);
    }
    if (msg.type === 'sessionEvents') {
        // Only render if it's still the session the user asked to view.
        if (viewingSessionId === msg.id) {
            renderEvents(msg.events);
        }
    }
    if (msg.type === 'runtimeStatus') {
        claudeRuntime = msg.runtime.claude;
        currentRoster = msg.runtime.roster;
        currentClaudeMode = msg.runtime.claudeMode;
        // Re-render both cards so bridge status + roster greying show immediately.
        if (lastPresence.codex) {
            renderAgentCard('codex', lastPresence.codex, currentSessionState ?? undefined);
        }
        if (lastPresence.claude) {
            renderAgentCard('claude', lastPresence.claude, currentSessionState ?? undefined);
        }
    }
});

/**
 * @param {{ claims: any[], commands: any[], events: any[] }} state
 */
function renderState(state) {
    latestEvents = state.events ?? [];
    renderClaims(state.claims ?? []);
    renderCommands(state.commands ?? []);
    // While viewing a saved session, leave the feed frozen on that history;
    // the live state still updates claims/commands and the activity line.
    if (!viewingSessionId) {
        renderEvents(latestEvents);
    }

    if (currentSessionState?.last_activity_at) {
        lastActivity.textContent = `Last activity: ${fmtRelativePast(currentSessionState.last_activity_at)}`;
    } else {
        lastActivity.textContent = 'Last activity: none';
    }
}

/**
 * @param {{ claude: any, codex: any, last_activity_at: string | null, session_started_at: string | null, is_session_active: boolean, has_session_end: boolean }} session
 */
function renderSessionState(session) {
    lastPresence.claude = session.claude;
    lastPresence.codex = session.codex;
    renderAgentCard('claude', session.claude, session);
    renderAgentCard('codex', session.codex, session);
    lastActivity.textContent = session.last_activity_at
        ? `Last activity: ${fmtRelativePast(session.last_activity_at)}`
        : 'Last activity: none';
}

/**
 * @param {'claude'|'codex'} agent
 * @param {{ status: string, last_event_at: string | null, last_event_type: string | null }} presence
 * @param {{ is_session_active?: boolean }} [session]
 */
function renderAgentCard(agent, presence, session) {
    const dot = /** @type {HTMLElement} */ (document.getElementById(`status-dot-${agent}`));
    const text = /** @type {HTMLElement} */ (document.getElementById(`status-text-${agent}`));
    const detail = /** @type {HTMLElement} */ (document.getElementById(`status-detail-${agent}`));
    const card = /** @type {HTMLElement | null} */ (document.querySelector(`.status-card[data-agent="${agent}"]`));

    // P3 / #12: an orchestrator not selected in the active session's roster is
    // greyed but kept visible — the whole card dims so it's clearly out of this
    // session, without hiding it.
    if (currentRoster && session?.is_session_active && !currentRoster[agent]) {
        card?.classList.add('card-inactive');
        dot.className = 'status-dot status-inactive';
        text.textContent = 'Inactive';
        detail.textContent = 'Not selected for this session.';
        return;
    }
    card?.classList.remove('card-inactive');

    const status = presence?.status ?? 'stopped';

    dot.className = `status-dot status-${status}`;
    text.textContent = capitalize(status);

    let detailText;
    if (!presence?.last_event_at) {
        detailText = session?.is_session_active
            ? 'Waiting for board activity in the current session.'
            : 'No board activity yet.';
    } else {
        const relative = fmtRelativePast(presence.last_event_at);
        detailText = `Last ${presence.last_event_type ?? 'event'} ${relative}.`;
    }

    // Surface the actual activation path alongside board presence.
    if (agent === 'codex') {
        detailText += currentRoster?.codex
            ? ' · Board path: own MCP session'
            : ' · Not in session';
    } else if (agent === 'claude' && currentClaudeMode === 'B') {
        detailText += ` · Managed bridge: ${claudeRuntime.status}`;
    } else if (agent === 'claude' && currentRoster?.claude) {
        detailText += ' · Interactive (/loop in your chat)';
    }
    detail.textContent = detailText;
}

function renderErrorState() {
    renderAgentCard('claude', { status: 'error', last_event_at: null, last_event_type: null });
    renderAgentCard('codex', { status: 'error', last_event_at: null, last_event_type: null });
    lastActivity.textContent = 'Last activity: unavailable';
}

/** @param {any[]} claims */
function renderClaims(claims) {
    if (claims.length === 0) {
        claimsList.className = 'empty-msg';
        claimsList.textContent = 'No active claims.';
        return;
    }

    claimsList.className = 'stack-list';
    claimsList.innerHTML = claims.map(claim => `
        <article class="claim-card">
            <div class="claim-top">
                <span class="claim-agent">${esc(claim.agent)}</span>
                <span class="claim-expiry">${fmtRelativeFuture(claim.expires_at)}</span>
            </div>
            <div class="claim-paths">${esc((claim.paths ?? []).join(' | '))}</div>
            <div class="claim-meta">${esc(claim.note ?? '') || 'No note'}</div>
        </article>
    `).join('');
}

/** @param {any[]} commands */
function renderCommands(commands) {
    const open = commands.filter(command => command.status !== 'resolved');
    if (open.length === 0) {
        commandsList.className = 'empty-msg';
        commandsList.textContent = 'No open commands.';
        return;
    }

    commandsList.className = 'stack-list';
    commandsList.innerHTML = open.map(command => `
        <article class="command-card ${/\bSTOP\b/i.test(command.text) ? 'stop' : 'pause'}">
            <div class="command-top">
                <span class="command-text">${esc(command.text)}</span>
                <span class="command-status">${esc(command.status)}</span>
            </div>
            <div class="command-meta">
                <span>by ${esc(command.created_by)}</span>
                <span>to ${esc(command.target_agent)}</span>
                <span>${fmtRelativePast(command.created_at)}</span>
            </div>
            <div class="command-actions">
                <button class="small" data-ack="${esc(command.id)}">Ack</button>
                <button class="small" data-resolve="${esc(command.id)}">Resolve</button>
            </div>
        </article>
    `).join('');
}

/** @param {any[]} events */
function renderEvents(events) {
    currentFeedEvents = events;
    if (events.length === 0) {
        latestRenderedEntries = [];
        expandedEventIndices.clear();
        eventFeed.innerHTML = '';
        feedEmpty.classList.remove('hidden');
        return;
    }

    feedEmpty.classList.add('hidden');
    const collapsed = collapseConsecutiveEvents(events);
    latestRenderedEntries = collapsed;
    eventFeed.innerHTML = collapsed.map((entry, index) => {
        const event = entry.event;
        const message = String(event.message ?? '');
        const expanded = expandedEventIndices.has(index);
        const truncated = message.length > EVENT_MESSAGE_PREVIEW_CHARS;
        const displayMessage = truncated && !expanded
            ? `${message.slice(0, EVENT_MESSAGE_PREVIEW_CHARS)}...`
            : message;
        return `
            <article class="event-row type-${esc(event.type)}">
                <div class="event-top">
                    <div class="event-meta">
                        ${agentBadge(event.agent)}
                        <span class="event-type">${esc(event.type)}</span>
                        <span class="event-time">${fmtRelativePast(event.timestamp)}</span>
                    </div>
                    <button class="small event-copy-button" data-copy-event="${index}" type="button">Copy</button>
                </div>
                <div class="event-message ${truncated && !expanded ? 'is-collapsed' : ''}">
                    ${esc(displayMessage)}
                    ${entry.count > 1 ? `<span class="event-dup-count">x${entry.count}</span>` : ''}
                </div>
                ${truncated ? `<div class="event-actions-inline"><button class="link-button event-expand-button" data-expand-event="${index}" type="button">${expanded ? 'Show less' : 'Show more'}</button></div>` : ''}
            </article>
        `;
    }).join('');

    if (shouldAutoScroll) {
        eventFeed.scrollTop = eventFeed.scrollHeight;
    }
}

function renderSessionPrompts() {
    promptClaude.textContent = `/loop Watch the Forge Relay board via the MCP board_check and get_status tools. When a new post from "user" or "codex" appears, act on it and reply with the post tool. Your agent name is "claude" — claim files before editing and post progress updates. Self-pace; keep going until you see SESSION_END.`;
}

/** Show only the prompt/info blocks relevant to the current roster + Claude mode. */
function updateModalVisibility() {
    const claudeOn = rosterClaude?.checked ?? true;
    const mode = selectedClaudeMode();
    // Claude paste prompt only matters for Mode A.
    claudeModeBlock?.classList.toggle('hidden', !claudeOn);
    claudePromptBlock?.classList.toggle('hidden', !(claudeOn && mode === 'A'));
    codexInfoBlock?.classList.remove('hidden');
}

function selectedClaudeMode() {
    const checked = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="claude-mode"]:checked'));
    return checked?.value === 'A' ? 'A' : 'B';
}

/** @param {'draft'|'clanker'} mode */
function renderAutonomy(mode) {
    const pill = document.getElementById('autonomy-pill');
    if (!pill) { return; }
    if (mode === 'clanker') {
        pill.className = 'autonomy-pill clanker';
        pill.textContent = '💥 Clanker Mode';
    } else {
        pill.className = 'autonomy-pill draft';
        pill.textContent = 'Workers: Draft';
    }
}

document.getElementById('autonomy-pill')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleAutonomy' });
});

function showBanner(message, kind) {
    banner.textContent = message;
    banner.className = `message-banner ${kind}`;
    window.clearTimeout(showBanner.timeoutId);
    showBanner.timeoutId = window.setTimeout(() => {
        banner.className = 'message-banner hidden';
    }, 5000);
}
showBanner.timeoutId = 0;

function postTask() {
    const note = ctrlNote.value.trim();
    if (!note) {
        return;
    }
    vscode.postMessage({ type: 'post', agent: agent(), note });
    ctrlNote.value = '';
}

document.getElementById('btn-post-task')?.addEventListener('click', postTask);

// Enter posts; Shift+Enter inserts a newline. Ignore while an IME is composing.
ctrlNote.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        postTask();
    }
});

document.getElementById('btn-claim')?.addEventListener('click', () => {
    const target = ctrlTarget.value.trim();
    if (!target) {
        return;
    }
    vscode.postMessage({ type: 'claim', agent: agent(), targets: [target], ttlMinutes: 120, note: ctrlNote.value.trim() });
    ctrlTarget.value = '';
});

document.getElementById('btn-release')?.addEventListener('click', () => {
    const target = ctrlTarget.value.trim();
    if (!target) {
        return;
    }
    vscode.postMessage({ type: 'release', agent: agent(), targets: [target], note: '' });
    ctrlTarget.value = '';
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'command', agent: agent(), targetAgent: ctrlCmdTarget.value, note: 'STOP - operator halt' });
});

document.getElementById('btn-pause')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'command', agent: agent(), targetAgent: ctrlCmdTarget.value, note: 'PAUSE - operator hold' });
});

document.getElementById('btn-clear-commands')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearAllCommands', agent: agent(), note: 'Cleared from Forge Relay panel' });
});

document.getElementById('btn-clear-history')?.addEventListener('click', () => {
    backToLive();
    vscode.postMessage({ type: 'clearHistory', agent: agent() });
});

document.getElementById('btn-new-session')?.addEventListener('click', () => {
    backToLive();
    vscode.postMessage({ type: 'newSession', agent: agent() });
});

document.getElementById('btn-back-to-live')?.addEventListener('click', backToLive);

sessionPicker?.addEventListener('change', () => {
    const value = sessionPicker.value;
    if (value === 'live') {
        backToLive();
        return;
    }
    viewingSessionId = value;
    updateViewingBanner();
    vscode.postMessage({ type: 'loadSession', id: value });
});

/** Return the feed to the live board and request fresh state. */
function backToLive() {
    if (!viewingSessionId && sessionPicker?.value === 'live') {
        return;
    }
    viewingSessionId = null;
    if (sessionPicker) { sessionPicker.value = 'live'; }
    updateViewingBanner();
    renderEvents(latestEvents);
}

/** Show/hide the read-only banner and label it for the current session. */
function updateViewingBanner() {
    if (!viewingBanner) { return; }
    if (!viewingSessionId) {
        viewingBanner.classList.add('hidden');
        return;
    }
    const selected = sessionPicker?.selectedOptions?.[0];
    const label = (selected && selected.value !== 'live' ? selected.textContent : null) || 'a saved session';
    if (viewingBannerText) {
        viewingBannerText.textContent = `Viewing ${label} (read-only).`;
    }
    viewingBanner.classList.remove('hidden');
}

/** @param {{ id: string, label: string, event_count: number }[]} sessions */
function renderSessionList(sessions) {
    if (!sessionPicker) { return; }
    const previous = sessionPicker.value;
    const options = ['<option value="live">● Live session</option>']
        .concat((sessions ?? []).map(s =>
            `<option value="${esc(s.id)}">${esc(s.label)} (${s.event_count})</option>`));
    sessionPicker.innerHTML = options.join('');
    // Preserve the current selection if it still exists, else fall back to live.
    const stillThere = (sessions ?? []).some(s => s.id === previous) || previous === 'live';
    sessionPicker.value = stillThere ? previous : 'live';
    if (!stillThere) {
        backToLive();
    }
}

document.getElementById('btn-connect')?.addEventListener('click', () => {
    // Open the chooser only - the session is started on confirm with the roster.
    if (currentRoster) {
        rosterClaude.checked = Boolean(currentRoster.claude);
        rosterCodex.checked = Boolean(currentRoster.codex);
    }
    updateModalVisibility();
    connectModal.classList.remove('hidden');
    connectModal.setAttribute('aria-hidden', 'false');
});

document.getElementById('btn-disconnect')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'disconnectSession', agent: agent() });
});

document.getElementById('btn-close-modal')?.addEventListener('click', closeModal);

document.getElementById('btn-confirm-connect')?.addEventListener('click', () => {
    const roster = { claude: rosterClaude?.checked ?? true, codex: rosterCodex?.checked ?? true };
    if (!roster.claude && !roster.codex) {
        showBanner('Select at least one orchestrator.', 'error');
        return;
    }
    vscode.postMessage({
        type: 'connectSession',
        agent: agent(),
        roster,
        claudeMode: selectedClaudeMode(),
    });
    closeModal();
});

rosterClaude?.addEventListener('change', updateModalVisibility);
rosterCodex?.addEventListener('change', updateModalVisibility);
for (const radio of document.querySelectorAll('input[name="claude-mode"]')) {
    radio.addEventListener('change', updateModalVisibility);
}

document.getElementById('btn-copy-claude')?.addEventListener('click', async () => {
    await copyPrompt(promptClaude.textContent || '');
});

commandsList.addEventListener('click', event => {
    const target = /** @type {HTMLElement | null} */ (event.target instanceof HTMLElement ? event.target : null);
    if (!target) {
        return;
    }

    const ackId = target.getAttribute('data-ack');
    if (ackId) {
        vscode.postMessage({ type: 'ack', agent: agent(), commandId: ackId, note: 'Acknowledged via Forge Relay panel' });
        return;
    }

    const resolveId = target.getAttribute('data-resolve');
    if (resolveId) {
        vscode.postMessage({ type: 'resolve', agent: agent(), commandId: resolveId, note: 'Resolved via Forge Relay panel' });
    }
});

eventFeed.addEventListener('click', async event => {
    const target = /** @type {HTMLElement | null} */ (event.target instanceof HTMLElement ? event.target : null);
    if (!target) {
        return;
    }

    const expandIndex = target.getAttribute('data-expand-event');
    if (expandIndex !== null) {
        const index = Number(expandIndex);
        if (expandedEventIndices.has(index)) {
            expandedEventIndices.delete(index);
        } else {
            expandedEventIndices.add(index);
        }
        renderEvents(currentFeedEvents);
        return;
    }

    const copyIndex = target.getAttribute('data-copy-event');
    if (copyIndex === null) {
        return;
    }

    const entry = latestRenderedEntries[Number(copyIndex)];
    if (!entry) {
        return;
    }

    const eventText = `${entry.event.agent}: ${entry.event.message}`;
    try {
        await navigator.clipboard.writeText(eventText);
        showBanner('Event copied.', 'notice');
    } catch {
        showBanner('Copy failed for that event.', 'error');
    }
});

// Use the native `copy` event rather than intercepting keydown Ctrl/Cmd+C: the
// copy event fires once the browser has committed the copy and the selection is
// current, so it works for keyboard, right-click→Copy, and menu copy alike.
// (The earlier keydown handler raced selection/focus and silently did nothing.)
document.addEventListener('copy', event => {
    if (isEditableTarget(event.target)) {
        return;
    }
    const selection = window.getSelection();
    const text = selection ? selection.toString() : '';
    if (!text.trim()) {
        return;
    }
    if (event.clipboardData) {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        showBanner('Selection copied.', 'notice');
    }
});

function closeModal() {
    connectModal.classList.add('hidden');
    connectModal.setAttribute('aria-hidden', 'true');
}

async function copyPrompt(text) {
    try {
        await navigator.clipboard.writeText(text);
        showBanner('Prompt copied.', 'notice');
    } catch {
        showBanner('Copy failed. Select and copy the prompt manually.', 'error');
    }
}

function agent() {
    return ctrlAgent.value.trim() || 'user';
}

/** @param {string} value */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** @param {string} value */
function agentSlug(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-');
}

/**
 * Render the agent label for an event. Workers (`worker:<model>`) get a fixed
 * "WORKER" chip plus a separate, per-model-tinted model chip showing a short
 * model name (full id on hover) — so multiple models posting at once are
 * tellable apart. Orchestrators/user keep their single coloured label.
 * @param {string} agent
 */
function agentBadge(agent) {
    const raw = String(agent ?? '');
    const workerMatch = /^worker(?:-(\d+))?:(.+)$/i.exec(raw);
    if (workerMatch) {
        const ordinal = workerMatch[1];
        const modelId = workerMatch[2];
        const tint = modelTint(modelId);
        return `<span class="event-agent event-agent-worker">${ordinal ? `WORKER-${esc(ordinal)}` : 'WORKER'}</span>`
            + `<span class="event-agent event-agent-model" title="${esc(modelId)}" style="color:${tint}">${esc(shortenModel(modelId))}</span>`;
    }
    return `<span class="event-agent event-agent-${agentSlug(raw)}">${esc(raw)}</span>`;
}

function isEditableTarget(target) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return Boolean(target.closest('textarea, input, [contenteditable="true"]'));
}

/** Trim a model id to something board-friendly (strip backend prefix + .gguf). */
function shortenModel(id) {
    let s = String(id ?? '').trim();
    const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (slash >= 0) { s = s.slice(slash + 1); }
    s = s.replace(/\.gguf$/i, '');
    if (s.length > 26) { s = s.slice(0, 25) + '…'; }
    return s || 'model';
}

/** Stable HSL tint derived from the model id, so each model gets its own hue. */
function modelTint(id) {
    const str = String(id ?? '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 68%)`;
}

/** @param {string} iso */
function fmtRelativePast(iso) {
    if (!iso) {
        return 'unknown time';
    }
    const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSeconds < 60) {
        return `${diffSeconds}s ago`;
    }
    if (diffSeconds < 3600) {
        return `${Math.round(diffSeconds / 60)}m ago`;
    }
    return `${Math.round(diffSeconds / 3600)}h ago`;
}

/** @param {string} iso */
function fmtRelativeFuture(iso) {
    if (!iso) {
        return 'unknown expiry';
    }
    const diffSeconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (diffSeconds <= 0) {
        return 'expired';
    }
    if (diffSeconds < 3600) {
        return `expires in ${Math.max(1, Math.round(diffSeconds / 60))}m`;
    }
    return `expires in ${Math.round(diffSeconds / 3600)}h`;
}

function capitalize(value) {
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

/** @param {any[]} events */
function collapseConsecutiveEvents(events) {
    /** @type {{ event: any, count: number }[]} */
    const collapsed = [];

    for (const event of events) {
        const previous = collapsed[collapsed.length - 1];
        if (previous && isSameEventSignature(previous.event, event)) {
            previous.count += 1;
            previous.event = event;
            continue;
        }

        collapsed.push({ event, count: 1 });
    }

    return collapsed;
}

/** @param {any} left @param {any} right */
function isSameEventSignature(left, right) {
    return left.type === right.type
        && left.agent === right.agent
        && left.message === right.message
        && JSON.stringify(left.paths ?? []) === JSON.stringify(right.paths ?? []);
}

renderSessionPrompts();
vscode.postMessage({ type: 'ready' });
