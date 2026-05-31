import { AgentRuntimeBridge, ScriptRuntimeBridge, RuntimeStatus } from './runtimeBridge';
import { ClaudeMode, SessionRoster } from './types';

export interface RuntimeAgentSnapshot {
    status: RuntimeStatus;
    detail: string;
}

export interface RuntimeSnapshot {
    codex: RuntimeAgentSnapshot;
    claude: RuntimeAgentSnapshot;
    roster: SessionRoster;
    claudeMode: ClaudeMode;
}

export interface RuntimeManagerOptions {
    /** Absolute path to scripts/codex-auto-bridge.js */
    codexScriptPath: string;
    /** Absolute path to scripts/claude-auto-bridge.js */
    claudeScriptPath: string;
    /** SSE URL of the AgentWatch MCP server, attached to the headless Claude bridge. */
    mcpUrl: string;
    repoRoot: string;
    eventsPath: string;
    nodePath?: string;
    /** Claude headless permission mode (default "acceptEdits"). */
    claudePermissionMode?: string;
    /** Optional Claude model override for the headless bridge. */
    claudeModel?: string;
    onLog?: (line: string) => void;
}

/**
 * Owns the per-agent runtime bridges and fans their status changes out to any
 * number of listeners (the status-bar item and each open webview).
 *
 *  - Codex: supervised app-server bridge (P2).
 *  - Claude Mode A: the user's own interactive /loop session — no managed
 *    process, so the Claude bridge stays inactive.
 *  - Claude Mode B: supervised headless Claude Agent SDK bridge (P4).
 */
export class RuntimeManager {
    private readonly codex: ScriptRuntimeBridge;
    private readonly claude: ScriptRuntimeBridge;
    private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
    private roster: SessionRoster = { claude: false, codex: false };
    private claudeMode: ClaudeMode = 'A';

    constructor(opts: RuntimeManagerOptions) {
        this.codex = new ScriptRuntimeBridge({
            agent: 'codex',
            scriptPath: opts.codexScriptPath,
            repoRoot: opts.repoRoot,
            eventsPath: opts.eventsPath,
            nodePath: opts.nodePath,
            linkedPattern: /codex thread started/i,
            onStatus: () => this.emit(),
            onLog: opts.onLog,
        });

        // Attach the AgentWatch MCP server. Mode defaults to the orchestrator
        // policy (react to the operator + @mentions, not peer chatter).
        const claudeArgs = ['--mcp-url', opts.mcpUrl];
        if (opts.claudePermissionMode) {
            claudeArgs.push('--permission-mode', opts.claudePermissionMode);
        }
        if (opts.claudeModel) {
            claudeArgs.push('--model', opts.claudeModel);
        }
        this.claude = new ScriptRuntimeBridge({
            agent: 'claude',
            scriptPath: opts.claudeScriptPath,
            repoRoot: opts.repoRoot,
            eventsPath: opts.eventsPath,
            nodePath: opts.nodePath,
            extraArgs: claudeArgs,
            onStatus: () => this.emit(),
            onLog: opts.onLog,
        });
    }

    onChange(listener: (snapshot: RuntimeSnapshot) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    getSnapshot(): RuntimeSnapshot {
        return {
            codex: { status: this.codex.status(), detail: this.codex.detailText() },
            claude: { status: this.claude.status(), detail: this.claude.detailText() },
            roster: { ...this.roster },
            claudeMode: this.claudeMode,
        };
    }

    getRoster(): SessionRoster {
        return { ...this.roster };
    }

    getClaudeMode(): ClaudeMode {
        return this.claudeMode;
    }

    /**
     * Apply the orchestrator selection chosen at Connect (plan §2.4). Only the
     * selected agents get a runtime bridge; the unselected one stays inactive.
     * The Claude headless bridge runs only for selected + Mode B; Mode A is the
     * user's own /loop paste (no managed process).
     */
    setRoster(roster: SessionRoster, claudeMode: ClaudeMode): void {
        this.roster = { ...roster };
        this.claudeMode = claudeMode;

        if (roster.codex) {
            this.codex.start();
        } else {
            this.codex.stop();
        }

        if (roster.claude && claudeMode === 'B') {
            this.claude.start();
        } else {
            this.claude.stop();
        }

        this.emit();
    }

    connectCodex(): void {
        this.roster.codex = true;
        this.codex.start();
    }

    disconnectCodex(): void {
        this.roster.codex = false;
        this.codex.stop();
    }

    /** Whether any managed runtime is currently active (or trying to be). */
    isAnyActive(): boolean {
        return this.codex.status() !== 'inactive' || this.claude.status() !== 'inactive';
    }

    stopAll(): void {
        this.roster = { claude: false, codex: false };
        this.codex.stop();
        this.claude.stop();
    }

    private emit(): void {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}

export type { RuntimeStatus, AgentRuntimeBridge };
