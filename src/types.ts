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

export interface BoardEventNotificationData {
    type: 'board_event';
    event: BoardEvent;
}

// Messages sent from extension → webview
export type ExtensionMessage =
    | { type: 'stateUpdate'; state: BoardState }
    | { type: 'mcpPort'; port: number };

// Messages sent from webview → extension
export type WebviewMessage =
    | { type: 'post'; agent: string; note: string }
    | { type: 'command'; agent: string; targetAgent: string; note: string }
    | { type: 'ack'; agent: string; commandId: string; note: string }
    | { type: 'resolve'; agent: string; commandId: string; note: string }
    | { type: 'claim'; agent: string; targets: string[]; ttlMinutes: number; note: string }
    | { type: 'release'; agent: string; targets: string[]; note: string }
    | { type: 'ready' };
