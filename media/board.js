// @ts-check
/// <reference lib="dom" />
'use strict';

const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const stopBanner     = /** @type {HTMLElement} */ (document.getElementById('stop-banner'));
const mcpPortBadge   = /** @type {HTMLElement} */ (document.getElementById('mcp-port'));
const claimsList     = /** @type {HTMLElement} */ (document.getElementById('claims-list'));
const commandsList   = /** @type {HTMLElement} */ (document.getElementById('commands-list'));
const eventFeed      = /** @type {HTMLElement} */ (document.getElementById('event-feed'));

const ctrlAgent      = /** @type {HTMLInputElement} */ (document.getElementById('ctrl-agent'));
const ctrlNote       = /** @type {HTMLInputElement} */ (document.getElementById('ctrl-note'));
const ctrlTarget     = /** @type {HTMLInputElement} */ (document.getElementById('ctrl-target'));
const ctrlCmdTarget  = /** @type {HTMLSelectElement} */ (document.getElementById('ctrl-cmd-target'));

// ── Message from extension ────────────────────────────────────────────────────
window.addEventListener('message', (/** @type {MessageEvent} */ e) => {
    const msg = e.data;
    if (msg.type === 'stateUpdate') { renderState(msg.state); }
    if (msg.type === 'mcpPort')     { mcpPortBadge.textContent = `MCP :${msg.port}`; }
});

// ── Render ────────────────────────────────────────────────────────────────────
/**
 * @param {{ claims: any[], commands: any[], events: any[] }} state
 */
function renderState(state) {
    renderClaims(state.claims ?? []);
    renderCommands(state.commands ?? []);
    renderEvents(state.events ?? []);

    const hasStop = (state.commands ?? []).some(c =>
        (c.status === 'open' || c.status === 'acknowledged') &&
        /\bSTOP\b/i.test(c.text)
    );
    stopBanner.classList.toggle('hidden', !hasStop);
}

/** @param {any[]} claims */
function renderClaims(claims) {
    if (claims.length === 0) {
        claimsList.className = 'empty-msg';
        claimsList.textContent = 'No active claims.';
        return;
    }
    claimsList.className = '';
    claimsList.innerHTML = claims.map(c => `
        <div class="claim-card">
            <span class="claim-agent">${esc(c.agent)}</span>
            <span class="claim-paths">${esc((c.paths ?? []).join('  •  '))}</span>
            <span class="claim-meta">
                ${esc(c.note ?? '')}
                &nbsp;·&nbsp; expires ${fmtRelative(c.expires_at)}
            </span>
        </div>
    `).join('');
}

/** @param {any[]} commands */
function renderCommands(commands) {
    const open = commands.filter(c => c.status !== 'resolved');
    if (open.length === 0) {
        commandsList.className = 'empty-msg';
        commandsList.textContent = 'No open commands.';
        return;
    }
    commandsList.className = '';
    commandsList.innerHTML = open.map(c => `
        <div class="command-card ${/\bSTOP\b/i.test(c.text) ? 'stop' : ''}">
            <span class="command-text">${esc(c.text)}</span>
            <div class="command-meta">
                <span>by ${esc(c.created_by)}</span>
                <span>→ ${esc(c.target_agent)}</span>
                <span>${esc(c.status)}</span>
                <span>${fmtRelative(c.created_at)}</span>
            </div>
            <div class="command-actions">
                <button class="small" onclick="doAck('${esc(c.id)}')">ACK</button>
                <button class="small" onclick="doResolve('${esc(c.id)}')">Resolve</button>
            </div>
        </div>
    `).join('');
}

/** @param {any[]} events */
function renderEvents(events) {
    if (events.length === 0) {
        eventFeed.innerHTML = '';
        return;
    }

    const collapsedEvents = collapseConsecutiveEvents(events);
    eventFeed.innerHTML = '';

    for (const entry of collapsedEvents) {
        const e = entry.event;
        const row = document.createElement('div');
        row.className = `event-row type-${e.type}`;
        const agentClass = `agent-${agentSlug(e.agent)}`;
        const duplicateCount = entry.count > 1
            ? `<span class="event-dup-count">x${entry.count}</span>`
            : '';
        row.innerHTML = `
            <span class="event-ts">${fmtTime(e.timestamp)}</span>
            <span class="event-type">${esc(e.type)}</span>
            <span class="event-agent ${agentClass}">${esc(e.agent)}</span>
            <span class="event-msg">${esc(e.message)}${duplicateCount}</span>
        `;
        eventFeed.appendChild(row);
    }

    // keep max 200 rows in the DOM
    while (eventFeed.children.length > 200) {
        eventFeed.removeChild(eventFeed.firstChild);
    }
    eventFeed.scrollTop = eventFeed.scrollHeight;
}

// ── Button handlers ───────────────────────────────────────────────────────────
document.getElementById('btn-post')?.addEventListener('click', () => {
    const note = ctrlNote.value.trim();
    if (!note) { return; }
    vscode.postMessage({ type: 'post', agent: agent(), note });
    ctrlNote.value = '';
});

document.getElementById('btn-claim')?.addEventListener('click', () => {
    const target = ctrlTarget.value.trim();
    if (!target) { return; }
    vscode.postMessage({ type: 'claim', agent: agent(), targets: [target], ttlMinutes: 120, note: ctrlNote.value.trim() });
    ctrlTarget.value = '';
});

document.getElementById('btn-release')?.addEventListener('click', () => {
    const target = ctrlTarget.value.trim();
    if (!target) { return; }
    vscode.postMessage({ type: 'release', agent: agent(), targets: [target], note: '' });
    ctrlTarget.value = '';
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'command', agent: agent(), targetAgent: ctrlCmdTarget.value, note: 'STOP — operator halt' });
});

document.getElementById('btn-pause')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'command', agent: agent(), targetAgent: ctrlCmdTarget.value, note: 'PAUSE — operator hold' });
});

document.getElementById('btn-resume')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'post', agent: agent(), note: 'RESUME — operator cleared' });
});

// ── Inline command actions (called from innerHTML onclick) ────────────────────
/** @param {string} id */
window.doAck = function(id) {
    vscode.postMessage({ type: 'ack', agent: agent(), commandId: id, note: 'Acknowledged via board' });
};

/** @param {string} id */
window.doResolve = function(id) {
    vscode.postMessage({ type: 'resolve', agent: agent(), commandId: id, note: 'Resolved via board' });
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function agent() { return ctrlAgent.value.trim() || 'user'; }

/** @param {string} s */
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** @param {string} iso */
function fmtTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return iso; }
}

/** @param {string} iso */
function fmtRelative(iso) {
    try {
        const diff = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
        if (diff < 0) { return `${Math.abs(diff)}s ago`; }
        if (diff < 3600) { return `in ${Math.round(diff / 60)}m`; }
        return `in ${Math.round(diff / 3600)}h`;
    } catch { return iso; }
}

/** @param {string} value */
function agentSlug(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-');
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

// Tell extension we are ready
vscode.postMessage({ type: 'ready' });
