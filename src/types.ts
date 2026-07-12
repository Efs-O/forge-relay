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
    type: 'claim' | 'release' | 'post' | 'command' | 'ack' | 'resolve' | 'expired' | 'task';
    agent: string;
    paths: string[];
    message: string;
    meta?: Record<string, unknown>;
}

export type TaskState = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
    id: string;
    title: string;
    description?: string;
    state: TaskState;
    severity: TaskSeverity;
    owner?: string;
    blocking_reason?: string;
    depends_on: string[];
    created_at: string;
    created_by: string;
    updated_at: string;
}

export interface BoardState {
    generated_at: string;
    claims: Claim[];
    commands: Command[];
    tasks: Task[];
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

export type RuntimeBridgeStatus = 'inactive' | 'waiting' | 'linked' | 'follower' | 'error' | 'unsupported' | 'stopped';

export interface SessionRoster {
    claude: boolean;
    codex: boolean;
    forgeCoordinator?: boolean;
}

// Mode A = interactive /loop paste (the user's own Claude chat); Mode B = headless
// SDK bridge (P4). Codex participates via its own MCP session — Relay never
// spawns a Codex process (two app-servers on one ChatGPT login trip token_revoked).
export type ClaudeMode = 'A' | 'B';

export interface RuntimeStatusSnapshot {
    claude: { status: RuntimeBridgeStatus; detail: string };
    forgeCoordinator: { status: RuntimeBridgeStatus; detail: string; model: string };
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
    | { type: 'forgeModels'; models: Array<{ name: string; profile?: string; servable?: boolean; provider?: string }>; error?: string }
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
    | { type: 'connectSession'; agent: string; roster: SessionRoster; claudeMode: ClaudeMode; forgeCoordinatorModel?: string }
    | { type: 'disconnectSession'; agent: string }
    | { type: 'toggleAutonomy' }
    | { type: 'createTask'; agent: string; title: string; description?: string; severity?: TaskSeverity; owner?: string }
    | { type: 'updateTask'; agent: string; taskId: string; title?: string; description?: string; severity?: TaskSeverity }
    | { type: 'assignTask'; agent: string; taskId: string; owner: string }
    | { type: 'startTask'; agent: string; taskId: string }
    | { type: 'blockTask'; agent: string; taskId: string; reason: string }
    | { type: 'unblockTask'; agent: string; taskId: string }
    | { type: 'completeTask'; agent: string; taskId: string }
    | { type: 'cancelTask'; agent: string; taskId: string; note?: string }
    | { type: 'ready' };
