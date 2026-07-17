import * as fs from 'fs';
import * as path from 'path';
import { AgentRuntimeBridge, ScriptRuntimeBridge, RuntimeStatus } from './runtimeBridge';
import { ClaudeMode, CodexMode, SessionRoster } from './types';
import { Bridge } from './bridge';
import { SubagentBackends } from './subagent';
import { ForgeCoordinatorBridge } from './forgeCoordinatorBridge';
import { CodexManagedBridge, CodexAppServerAdapter } from './codexManagedBridge';
import { CodexAppServerClient, CodexRpcNotification, CodexServerRequest } from './codexAppServerClient';
import { CodexRuntimeLease } from './codexRuntimeLease';
import { resolveCodexExecutable } from './codexExecutable';
import {
    CodexManagedProfile,
    codexManagedRuntimeOverrides,
    managedCodexEnvironment,
} from './codexManagedProfile';

export interface RuntimeAgentSnapshot {
    status: RuntimeStatus;
    detail: string;
}

export interface RuntimeSnapshot {
    claude: RuntimeAgentSnapshot;
    codex: RuntimeAgentSnapshot & { threadId?: string };
    forgeCoordinator: RuntimeAgentSnapshot & { model: string };
    roster: SessionRoster;
    claudeMode: ClaudeMode;
    codexMode: CodexMode;
    managedCodexAvailable: boolean;
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
    bridge: Bridge;
    subagentBackends: SubagentBackends;
    forgeControlUrl?: string;
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
    /** Opt-in feature gate. MCP-only remains the default and fallback. */
    experimentalManagedCodex?: boolean;
    codexExecutable?: string;
    codexManagedProfile?: CodexManagedProfile;
    codexManagedModel?: string;
    codexManagedTurnTimeoutMs?: number;
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
 *  - Codex MCP mode: the user's own interactive session (the safe default).
 *  - Codex managed-isolated mode: an opt-in app-server session with a
 *    workspace-specific home/SQLite profile and Relay-only ownership lease.
 */
export class RuntimeManager {
    private readonly claude: ScriptRuntimeBridge;
    private readonly forgeCoordinator: ForgeCoordinatorBridge | null;
    private readonly codexManaged: CodexManagedBridge | null;
    private forgeStatus: RuntimeAgentSnapshot = { status: 'inactive', detail: 'Not connected.' };
    private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
    private roster: SessionRoster = { claude: false, codex: false };
    // Default matches the session-start modal's pre-checked option (Mode B,
    // the zero-paste headless bridge). Inert until a roster selects Claude.
    private claudeMode: ClaudeMode = 'B';
    private codexMode: CodexMode = 'mcp';
    /** Absolute path to this extension build's out/mcpStdio.js (resolved from
     *  context.extensionUri at activation, so it always points at the *current*
     *  install — this is what makes the Mode A config self-healing). */
    private readonly mcpStdioPath: string;
    private readonly repoRoot: string;
    private readonly subagentEnv?: Record<string, string>;
    private readonly onLog?: (line: string) => void;
    private readonly forgeControlUrl?: string;

    constructor(opts: RuntimeManagerOptions) {
        this.mcpStdioPath = opts.mcpStdioPath;
        this.repoRoot = opts.repoRoot;
        this.subagentEnv = opts.subagentEnv;
        this.onLog = opts.onLog;
        this.forgeControlUrl = opts.forgeControlUrl;
        this.forgeCoordinator = opts.forgeControlUrl ? new ForgeCoordinatorBridge({
            bridge: opts.bridge, backends: opts.subagentBackends, controlUrl: opts.forgeControlUrl,
            boardEndpoint: opts.mcpUrl, eventsPath: opts.eventsPath, repoRoot: opts.repoRoot,
            extensionVersion: opts.extensionVersion, onLog: opts.onLog,
            onStatus: (status, detail) => { this.forgeStatus = { status, detail }; this.emit(); },
        }) : null;

        if (opts.experimentalManagedCodex) {
            const managedProfile = opts.codexManagedProfile;
            if (!managedProfile?.home || !managedProfile.sqliteHome || !managedProfile.root) {
                throw new Error('Managed Codex requires a complete isolated runtime profile.');
            }
            const lease = new CodexRuntimeLease(managedProfile.root, opts.repoRoot, process.pid, opts.extensionVersion);
            const nodeExecutable = opts.nodePath?.trim() || 'node';
            const mcpEnv = { ...(opts.subagentEnv ?? {}) };
            const appServerEnv = managedCodexEnvironment(process.env, managedProfile);
            const createAdapter = (handlers: {
                handleServerRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
            }): CodexAppServerAdapter => {
                const launch = resolveCodexExecutable({
                    configuredExecutable: opts.codexExecutable,
                    nodeExecutable,
                });
                const notificationListeners = new Set<(notification: { method: string; params?: unknown }) => void>();
                const closeListeners = new Set<(error?: Error) => void>();
                let closeNotified = false;
                const notifyClose = (error?: Error): void => {
                    if (closeNotified) return;
                    closeNotified = true;
                    for (const listener of closeListeners) listener(error);
                };
                const client = new CodexAppServerClient({
                    executable: launch.executable,
                    executableArgsPrefix: launch.argsPrefix,
                    shell: false,
                    cwd: opts.repoRoot,
                    env: appServerEnv,
                    requestTimeoutMs: 30_000,
                    configOverrides: {
                        // Command-line config wins over project .codex/config.toml.
                        // Keep both database state and persisted credentials inside
                        // the Relay-owned profile even when a repository requests a
                        // shared sqlite path or operating-system credential store.
                        ...codexManagedRuntimeOverrides(managedProfile),
                        'mcp_servers.forgerelay': {
                            command: nodeExecutable,
                            args: [opts.mcpStdioPath, '--repoRoot', opts.repoRoot],
                            env: mcpEnv,
                            required: true,
                        },
                    },
                    handleServerRequest: async (request: CodexServerRequest) => {
                        return handlers.handleServerRequest(request.method, (request.params ?? {}) as Record<string, unknown>);
                    },
                    onNotification: (notification: CodexRpcNotification) => {
                        for (const listener of notificationListeners) listener(notification);
                    },
                    onProtocolError: notifyClose,
                    onExit: exit => notifyClose(exit.code === 0 ? undefined :
                        new Error(`Codex app-server exited (${exit.signal ?? `code ${exit.code}`}).`)),
                    onStderr: text => opts.onLog?.(`[codex] ${text.trimEnd()}`),
                });
                return {
                    start: () => client.start(),
                    request: <T = unknown>(method: string, params?: unknown) => client.request<T>(method, params),
                    notify: (method, params) => client.notify(method, params),
                    close: () => client.close(),
                    get childPid() { return client.pid; },
                    onNotification: listener => { notificationListeners.add(listener); return () => notificationListeners.delete(listener); },
                    onClose: listener => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
                };
            };
            this.codexManaged = new CodexManagedBridge({
                board: opts.bridge,
                eventsPath: opts.eventsPath,
                repoRoot: opts.repoRoot,
                clientFactory: createAdapter,
                lease,
                model: opts.codexManagedModel,
                acceptanceCommand: nodeExecutable,
                turnTimeoutMs: opts.codexManagedTurnTimeoutMs,
                onLog: opts.onLog,
                onStatus: () => this.emit(),
            });
        } else {
            this.codexManaged = null;
        }

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
            codex: {
                status: this.codexManaged?.status() ?? 'inactive',
                detail: this.codexManaged?.detailText() ?? 'MCP-only mode; Relay does not own this Codex process.',
                threadId: this.codexManaged?.activeThreadId(),
            },
            forgeCoordinator: { ...this.forgeStatus, model: this.forgeCoordinator?.selectedModel() ?? '' },
            roster: { ...this.roster },
            claudeMode: this.claudeMode,
            codexMode: this.codexMode,
            managedCodexAvailable: this.codexManaged !== null,
        };
    }

    async runManagedCodexAcceptanceProbe(): Promise<void> {
        if (!this.codexManaged) {
            throw new Error('Managed Codex is disabled. Enable forgeRelay.experimentalManagedCodex first.');
        }
        await this.codexManaged.runClankerAcceptanceProbe(undefined, true);
    }

    getRoster(): SessionRoster {
        return { ...this.roster };
    }

    getClaudeMode(): ClaudeMode {
        return this.claudeMode;
    }

    async listForgeCoordinatorModels(): Promise<Awaited<ReturnType<typeof ForgeCoordinatorBridge.listModels>>> {
        if (!this.forgeCoordinator || !this.forgeControlUrl) {
            throw new Error('Forge control URL is not configured.');
        }
        return ForgeCoordinatorBridge.listModels(this.forgeControlUrl);
    }

    /**
     * Apply the orchestrator selection chosen at Connect (plan §2.4). The Claude
     * headless bridge runs only for selected + Mode B; Mode A is the user's own
     * /loop paste (no managed process). Codex is MCP-only unless the explicit,
     * feature-gated managed-isolated mode was selected.
     */
    async setRoster(roster: SessionRoster, claudeMode: ClaudeMode, forgeModel?: string, codexMode: CodexMode = 'mcp'): Promise<void> {
        if (forgeModel) {
            this.claude.stop();
            if (!this.forgeCoordinator) throw new Error('Forge control URL is not configured.');
            await this.forgeCoordinator.start(forgeModel);
        } else if (roster.claude && claudeMode === 'B') {
            void this.forgeCoordinator?.stop();
            this.claude.start();
        } else {
            void this.forgeCoordinator?.stop();
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

        const wantsManagedCodex = roster.codex && codexMode === 'managed-isolated';
        if (wantsManagedCodex) {
            if (!this.codexManaged) {
                throw new Error('Managed Codex is disabled. Enable forgeRelay.experimentalManagedCodex or use MCP-only mode.');
            }
            const status = this.codexManaged.status();
            if (status === 'stopped') {
                await this.codexManaged.stop();
            }
            if (status === 'inactive' || status === 'stopped') {
                try {
                    await this.codexManaged.start();
                } catch (error) {
                    await this.codexManaged.stop();
                    throw error;
                }
            }
        } else {
            const managed = this.codexManaged;
            if (managed && managed.status() !== 'inactive') await managed.stop();
        }

        // Persist/advertise the requested mode only after every selected runtime
        // starts successfully. A failed exclusive preflight must not auto-retry
        // the rejected roster on the next VS Code reload.
        this.roster = { ...roster };
        this.claudeMode = claudeMode;
        this.codexMode = codexMode;
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
        return this.claude.status() !== 'inactive' || this.forgeStatus.status !== 'inactive'
            || (this.codexManaged?.status() ?? 'inactive') !== 'inactive';
    }

    async stopAll(): Promise<void> {
        this.roster = { claude: false, codex: false, forgeCoordinator: false };
        this.claude.stop();
        await this.codexManaged?.stop();
        await this.forgeCoordinator?.stop();
    }

    private emit(): void {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}

export type { RuntimeStatus, AgentRuntimeBridge };
