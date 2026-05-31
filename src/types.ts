export interface Claim {
    agent: string;
    paths: string[];
    claimed_at: string;
    expires_at: string;
    note: string;
}

export interface Acknowledgement {
    agent: string;
    acknowledged_at: string;
    note: string;
}

export interface Command {
    id: string;
    created_at: string;
    created_by: string;
    target_agent: string;
    text: string;
    status: 'open' | 'acknowledged' | 'resolved';
    acknowledgements: Acknowledgement[];
    resolved_at?: string;
    resolved_by?: string;
    resolution_note?: string;
}

export interface BoardEvent {
    timestamp: string;
    type: 'claim' | 'release' | 'post' | 'command' | 'ack' | 'resolve' | 'expired';
    agent: string;
    paths: string[];
    message: string;
    meta?: Record<string, unknown>;
}

export interface BoardState {
    generated_at: string;
    claims: Claim[];
    commands: Command[];
    events: BoardEvent[];   // last 200 only
}

export type AgentStatus = 'active' | 'idle' | 'stopped' | 'error';

export interface AgentPresence {
    agent: 'claude' | 'codex';
    status: AgentStatus;
    last_event_at: string | null;
    last_event_type: BoardEvent['type'] | null;
}

export interface SessionState {
    claude: AgentPresence;
    codex: AgentPresence;
    last_activity_at: string | null;
    session_started_at: string | null;
    is_session_active: boolean;
    has_session_end: boolean;
}

// One archived board history span, saved to .coordination/sessions/<id>.ndjson.
// Created when the operator clears the feed or starts a new session, so history
// is never destroyed — only rolled into its own file (like a saved chat).
export interface SessionSummary {
    id: string;
    label: string;
    started_at: string | null;
    ended_at: string | null;
    archived_at: string;
    event_count: number;
}

export interface BoardEventNotificationData {
    type: 'board_event';
    event: BoardEvent;
}

export type RuntimeBridgeStatus = 'inactive' | 'waiting' | 'linked' | 'error' | 'unsupported' | 'stopped';

export interface SessionRoster {
    claude: boolean;
    codex: boolean;
}

// Mode A = interactive /loop paste (the user's own Claude chat); Mode B = headless
// SDK bridge (P4). Codex always uses its productized runtime bridge.
export type ClaudeMode = 'A' | 'B';

export interface RuntimeStatusSnapshot {
    codex: { status: RuntimeBridgeStatus; detail: string };
    claude: { status: RuntimeBridgeStatus; detail: string };
    roster: SessionRoster;
    claudeMode: ClaudeMode;
}

// Messages sent from extension → webview
export type ExtensionMessage =
    | { type: 'stateUpdate'; state: BoardState }
    | { type: 'mcpPort'; port: number }
    | { type: 'error'; message: string }
    | { type: 'notice'; message: string }
    | { type: 'sessionState'; session: SessionState }
    | { type: 'runtimeStatus'; runtime: RuntimeStatusSnapshot }
    | { type: 'autonomyState'; mode: 'draft' | 'clanker' }
    | { type: 'sessionList'; sessions: SessionSummary[] }
    | { type: 'sessionEvents'; id: string; events: BoardEvent[] };

// Messages sent from webview → extension
export type WebviewMessage =
    | { type: 'post'; agent: string; note: string }
    | { type: 'command'; agent: string; targetAgent: string; note: string }
    | { type: 'ack'; agent: string; commandId: string; note: string }
    | { type: 'resolve'; agent: string; commandId: string; note: string }
    | { type: 'claim'; agent: string; targets: string[]; ttlMinutes: number; note: string }
    | { type: 'release'; agent: string; targets: string[]; note: string }
    | { type: 'clearAllCommands'; agent: string; note: string }
    | { type: 'clearHistory'; agent: string }
    | { type: 'newSession'; agent: string; label?: string }
    | { type: 'listSessions' }
    | { type: 'loadSession'; id: string }
    | { type: 'connectSession'; agent: string; roster: SessionRoster; claudeMode: ClaudeMode }
    | { type: 'disconnectSession'; agent: string }
    | { type: 'toggleAutonomy' }
    | { type: 'ready' };
