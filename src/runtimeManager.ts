import * as fs from 'fs';
import * as path from 'path';
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
    managedCodexBridge: boolean;
}

export interface RuntimeManagerOptions {
    /** Absolute path to scripts/codex-auto-bridge.js */
    codexScriptPath: string;
    /** Absolute path to scripts/claude-auto-bridge.js */
    claudeScriptPath: string;
    /** Absolute path to out/mcpStdio.js, used to bind Codex to this workspace's board. */
    mcpStdioPath: string;
    /** SSE URL of the Forge Relay MCP server, attached to the headless Claude bridge. */
    mcpUrl: string;
    repoRoot: string;
    eventsPath: string;
    nodePath?: string;
    /** Claude headless permission mode (default "acceptEdits"). */
    claudePermissionMode?: string;
    /** Optional Claude model override for the headless bridge. */
    claudeModel?: string;
    /**
     * Cache keep-alive interval (ms) for the headless Claude bridge. When > 0 it
     * is passed through as `--debug-keep-alive-ms`, so the bridge sends an inert
     * no-op turn after this much idle to keep the prompt cache warm. 0 = off.
     */
    claudeKeepAliveMs?: number;
    /**
     * Max consecutive keep-alive pings to send while idle before pausing (passed
     * through as `--keep-alive-max-pings`). A real board event resets the count.
     * Bounds the idle cache-warming cost; the bridge defaults to 3. 0 = unbounded
     * (the old runaway behavior — not recommended).
     */
    claudeKeepAliveMaxPings?: number;
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
    private managedCodexBridge = false;
    /** Absolute path to this extension build's out/mcpStdio.js (resolved from
     *  context.extensionUri at activation, so it always points at the *current*
     *  install — this is what makes the Mode A config self-healing). */
    private readonly mcpStdioPath: string;
    private readonly repoRoot: string;
    private readonly onLog?: (line: string) => void;

    constructor(opts: RuntimeManagerOptions) {
        this.mcpStdioPath = opts.mcpStdioPath;
        this.repoRoot = opts.repoRoot;
        this.onLog = opts.onLog;
        const codexArgs = ['--mcp-stdio-path', opts.mcpStdioPath, '--mcp-repo-root', opts.repoRoot];
        this.codex = new ScriptRuntimeBridge({
            agent: 'codex',
            scriptPath: opts.codexScriptPath,
            repoRoot: opts.repoRoot,
            eventsPath: opts.eventsPath,
            nodePath: opts.nodePath,
            extraArgs: codexArgs,
            linkedPattern: /codex thread started/i,
            onStatus: () => this.emit(),
            onLog: opts.onLog,
        });

        // Attach the Forge Relay MCP server. Mode defaults to the orchestrator
        // policy (react to the operator + @mentions, not peer chatter).
        const claudeArgs = ['--mcp-url', opts.mcpUrl];
        if (opts.claudePermissionMode) {
            claudeArgs.push('--permission-mode', opts.claudePermissionMode);
        }
        if (opts.claudeModel) {
            claudeArgs.push('--model', opts.claudeModel);
        }
        if (opts.claudeKeepAliveMs && opts.claudeKeepAliveMs > 0) {
            claudeArgs.push('--debug-keep-alive-ms', String(opts.claudeKeepAliveMs));
        }
        if (typeof opts.claudeKeepAliveMaxPings === 'number' && opts.claudeKeepAliveMaxPings >= 0) {
            claudeArgs.push('--keep-alive-max-pings', String(opts.claudeKeepAliveMaxPings));
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
            managedCodexBridge: this.managedCodexBridge,
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
    setRoster(roster: SessionRoster, claudeMode: ClaudeMode, managedCodexBridge = false): void {
        this.roster = { ...roster };
        this.claudeMode = claudeMode;
        this.managedCodexBridge = managedCodexBridge;

        if (roster.codex && this.managedCodexBridge) {
            this.codex.start();
        } else {
            this.codex.stop();
        }

        if (roster.claude && claudeMode === 'B') {
            this.claude.start();
        } else {
            this.claude.stop();
        }

        // Mode A is the user's own interactive /loop session, which reads the
        // workspace .mcp.json at startup. Mode B self-wires MCP via SSE and needs
        // no file. So only for Claude + Mode A do we make sure .mcp.json points at
        // this build's MCP server — otherwise the orchestrator launches with no
        // forgerelay tools (no board_check/post/dispatch_subagent) and silently
        // cannot dispatch workers. Resolving from this build's own path means an
        // extension upgrade auto-repairs the (otherwise version-stale) entry.
        if (roster.claude && claudeMode === 'A') {
            this.ensureClaudeMcpConfig();
        }

        this.emit();
    }

    /**
     * Write/merge the `forgerelay` MCP entry into the workspace `.mcp.json` so a
     * fresh Claude Mode A `/loop` session picks up the Forge Relay tools. Only the
     * single `forgerelay` key is managed; any other servers the user configured
     * are preserved. Idempotent — only writes when the resolved entry differs, so
     * Connect does not churn the file. Best-effort: failures are logged, never
     * thrown (a config-write problem must not break Connect).
     */
    private ensureClaudeMcpConfig(): void {
        const configPath = path.join(this.repoRoot, '.mcp.json');
        const stdioPath = this.mcpStdioPath.replace(/\\/g, '/');
        const repoRoot = this.repoRoot.replace(/\\/g, '/');
        const desired = { command: 'node', args: [stdioPath, '--repoRoot', repoRoot] };

        try {
            let config: { mcpServers?: Record<string, unknown> } = {};
            if (fs.existsSync(configPath)) {
                const raw = fs.readFileSync(configPath, 'utf8').trim();
                if (raw) {
                    try {
                        config = JSON.parse(raw);
                    } catch {
                        // Malformed file: back it up rather than silently clobber,
                        // then start from a clean object.
                        fs.renameSync(configPath, configPath + '.bak');
                        this.onLog?.(`[mcp-config] .mcp.json was invalid JSON; backed up to .mcp.json.bak`);
                        config = {};
                    }
                }
            }
            if (!config.mcpServers || typeof config.mcpServers !== 'object') {
                config.mcpServers = {};
            }

            const existing = config.mcpServers.forgerelay;
            if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
                return; // already correct — no write, no churn
            }

            config.mcpServers.forgerelay = desired;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            this.onLog?.(`[mcp-config] wrote forgerelay entry to ${configPath.replace(/\\/g, '/')} -> ${stdioPath}`);
        } catch (err) {
            this.onLog?.(`[mcp-config] failed to update .mcp.json: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    connectCodex(): void {
        this.roster.codex = true;
        this.managedCodexBridge = true;
        this.codex.start();
        this.emit();
    }

    disconnectCodex(): void {
        this.managedCodexBridge = false;
        this.codex.stop();
        this.emit();
    }

    /** Whether any managed runtime is currently active (or trying to be). */
    isAnyActive(): boolean {
        return this.codex.status() !== 'inactive' || this.claude.status() !== 'inactive';
    }

    stopAll(): void {
        this.roster = { claude: false, codex: false };
        this.managedCodexBridge = false;
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
