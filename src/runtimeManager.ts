import * as fs from 'fs';
import * as path from 'path';
import { AgentRuntimeBridge, ScriptRuntimeBridge, RuntimeStatus } from './runtimeBridge';
import { ClaudeMode, SessionRoster } from './types';

export interface RuntimeAgentSnapshot {
    status: RuntimeStatus;
    detail: string;
}

export interface RuntimeSnapshot {
    claude: RuntimeAgentSnapshot;
    roster: SessionRoster;
    claudeMode: ClaudeMode;
}

export interface RuntimeManagerOptions {
    /** Absolute path to scripts/claude-auto-bridge.js */
    claudeScriptPath: string;
    /** Absolute path to out/mcpStdio.js, used by the Mode A .mcp.json self-heal. */
    mcpStdioPath: string;
    /** SSE URL of the Forge Relay MCP server, attached to the headless Claude bridge. */
    mcpUrl: string;
    /** Version of the supervising extension, used to reap old bridge builds. */
    extensionVersion: string;
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
    /**
     * `FORGERELAY_*` env vars mirroring the workspace subagent settings (see
     * subagentEnvFromBackends). Injected into the managed `.mcp.json` entry so
     * the stdio MCP server resolves models with the same Forge route / backend
     * URLs as the extension's HTTP server — without it, a Mode A Claude session
     * gets the forgerelay tools but no Forge catalog.
     */
    subagentEnv?: Record<string, string>;
    onLog?: (line: string) => void;
    onDuplicateSuppressed?: (ownerPid: number, ownerRepoRoot: string) => void;
}

/**
 * Owns the Claude runtime bridge and fans its status changes out to any number
 * of listeners (the status-bar item and each open webview).
 *
 *  - Claude Mode A: the user's own interactive /loop session — no managed
 *    process, so the Claude bridge stays inactive.
 *  - Claude Mode B: supervised headless Claude Agent SDK bridge (P4).
 *  - Codex: NEVER spawned by Relay. Two codex app-servers on one ChatGPT OAuth
 *    login trip token_revoked server-side and kill both sessions, so Codex only
 *    participates via the forgerelay MCP entry in its own ~/.codex/config.toml.
 */
export class RuntimeManager {
    private readonly claude: ScriptRuntimeBridge;
    private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
    private roster: SessionRoster = { claude: false, codex: false };
    // Default matches the session-start modal's pre-checked option (Mode B,
    // the zero-paste headless bridge). Inert until a roster selects Claude.
    private claudeMode: ClaudeMode = 'B';
    /** Absolute path to this extension build's out/mcpStdio.js (resolved from
     *  context.extensionUri at activation, so it always points at the *current*
     *  install — this is what makes the Mode A config self-healing). */
    private readonly mcpStdioPath: string;
    private readonly repoRoot: string;
    private readonly subagentEnv?: Record<string, string>;
    private readonly onLog?: (line: string) => void;

    constructor(opts: RuntimeManagerOptions) {
        this.mcpStdioPath = opts.mcpStdioPath;
        this.repoRoot = opts.repoRoot;
        this.subagentEnv = opts.subagentEnv;
        this.onLog = opts.onLog;

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
            boardEndpoint: opts.mcpUrl,
            extensionVersion: opts.extensionVersion,
            nodePath: opts.nodePath,
            extraArgs: claudeArgs,
            onStatus: () => this.emit(),
            onLog: opts.onLog,
            onDuplicateSuppressed: opts.onDuplicateSuppressed,
        });
    }

    onChange(listener: (snapshot: RuntimeSnapshot) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    getSnapshot(): RuntimeSnapshot {
        return {
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
     * Apply the orchestrator selection chosen at Connect (plan §2.4). The Claude
     * headless bridge runs only for selected + Mode B; Mode A is the user's own
     * /loop paste (no managed process). roster.codex is informational only —
     * Codex joins via its own MCP session, never a Relay-spawned process.
     */
    setRoster(roster: SessionRoster, claudeMode: ClaudeMode): void {
        this.roster = { ...roster };
        this.claudeMode = claudeMode;

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
        const desired: { command: string; args: string[]; env?: Record<string, string> } =
            { command: 'node', args: [stdioPath, '--repoRoot', repoRoot] };
        if (this.subagentEnv && Object.keys(this.subagentEnv).length > 0) {
            desired.env = this.subagentEnv;
        }

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

    /** Whether any managed runtime is currently active (or trying to be). */
    isAnyActive(): boolean {
        return this.claude.status() !== 'inactive';
    }

    stopAll(): void {
        this.roster = { claude: false, codex: false };
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
