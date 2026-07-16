import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Bridge } from './bridge';
import { McpServer } from './mcpServer';
import { BoardPanel } from './boardPanel';
import { BoardViewProvider } from './boardView';
import { BoardWatcher } from './boardWatcher';
import { RuntimeManager } from './runtimeManager';
import { subagentEnvFromBackends } from './subagent';
import { RuntimeStatus } from './runtimeBridge';
import { BoardEvent, ClaudeMode, CodexMode, normalizeCodexMode, SessionRoster } from './types';
import { isVsCodeInstallDir } from './vscodeInstallDir';
import { resolveForgeControlUrl } from './forgeControlDiscovery';
import { probeCodexAppServers } from './codexProcessProbe';
import { CodexManagedProfile, ensureCodexManagedProfile } from './codexManagedProfile';
import { configureManagedCodexApiKey } from './codexManagedAuth';

let mcpServer: McpServer | null = null;
let runtimeManager: RuntimeManager | null = null;

const ROSTER_KEY = 'forgeRelay.sessionRoster';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('Forge Relay: Open a workspace folder first.');
        return;
    }

    const config = vscode.workspace.getConfiguration('forgeRelay');
    const desiredPort = config.get<number>('port', 7878);
    const coordPath = config.get<string>('coordinationPath', '').trim();
    const repoRoot = coordPath || workspaceRoot;

    // Never write the .coordination board into a VS Code installation directory.
    // Doing so leaves the MCP server holding mcpstdio.log open inside the folder
    // the auto-updater must wipe, which makes every update fail with os error 5
    // ("Access is denied" deleting .coordination). Bail out cleanly instead.
    if (isVsCodeInstallDir(repoRoot)) {
        vscode.window.showWarningMessage(
            `Forge Relay: refusing to coordinate the VS Code install folder ` +
            `(${repoRoot}). Open your project folder instead, or set ` +
            `"forgeRelay.coordinationPath" to a real repo.`,
        );
        return;
    }

    // "Forge Relay" Output channel: a single place to watch managed-bridge output
    // (startup banners, [[AW_STATUS]] transitions, telemetry lines, crashes) from
    // View -> Output. Bridge stdout/stderr funnels here through RuntimeManager.onLog.
    const output = vscode.window.createOutputChannel('Forge Relay');
    context.subscriptions.push(output);
    const log = (line: string): void => {
        output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    };
    log(`Forge Relay activated — repoRoot=${repoRoot}`);

    const bridge = new Bridge(repoRoot);
    bridge.ensureAutonomyDefault(config.get<'draft' | 'clanker'>('defaultAutonomy', 'draft'));
    const forgeControl = await resolveForgeControlUrl(config.get<string>('subagentForgeControlUrl', ''));
    log(`[forge-control] ${forgeControl.detail}${forgeControl.url ? ` url=${forgeControl.url}` : ''}`);
    const subagentBackends = {
        bridgeUrl: config.get<string>('subagentBridgeUrl', '').trim(),
        ollamaUrl: config.get<string>('subagentOllamaUrl', 'http://127.0.0.1:11434/v1').trim(),
        directUrl: config.get<string>('subagentDirectUrl', 'http://127.0.0.1:8080/v1').trim(),
        bridgeApiKey: config.get<string>('subagentBridgeApiKey', '').trim() || undefined,
        defaultBackend: config.get<'bridge' | 'ollama' | 'direct'>('subagentDefaultBackend', 'ollama'),
        forgeControlUrl: forgeControl.url,
        defaultRunMode: config.get<'sync' | 'async'>('subagentDefaultMode', 'sync'),
        ollamaAutoStart: config.get<boolean>('ollamaAutoStart', false),
        ollamaExecutable: config.get<string>('ollamaExecutable', '').trim() || undefined,
        codexExecutable: config.get<string>('codexExecutable', '').trim() || undefined,
        codexTimeoutMs: config.get<number>('codexWorkerTimeoutMs', 0) || undefined,
        buildCommand: config.get<string>('build.command', '').trim() || undefined,
        buildClaimTargets: config.get<string[]>('build.claimTargets', []).map(t => t.trim()).filter(Boolean),
        buildTimeoutMs: config.get<number>('build.timeoutMs', 0) || undefined,
    };
    mcpServer = new McpServer(bridge, subagentBackends);

    let port: number;
    try {
        // Binds desiredPort if free, else scans upward — so multiple windows don't
        // collide on one fixed port. `port` is the actual bound port from here on.
        port = await mcpServer.start(desiredPort);
    } catch (err) {
        log(`ERROR: could not start MCP server (tried from port ${desiredPort}): ${err}`);
        vscode.window.showErrorMessage(`Forge Relay: Could not start MCP server (tried from port ${desiredPort}). ${err}`);
        return;
    }

    // File watcher — push board events to VS Code as notifications.
    // B7: take the events path from the bridge so the watcher, the MCP server and
    // the stdio server all agree on a single coordination dir.
    const eventsPath = bridge.getEventsPath();

    // Resolve a workspace-specific managed profile outside both the repository
    // and the user's ordinary Codex home. Existing IDE/CLI Codex processes are
    // allowed to coexist; only a second Relay owner of this exact profile is
    // rejected by the runtime lease.
    const managedFeatureRequested = config.get<boolean>('experimentalManagedCodex', false);
    const resolveManagedProfile = async (): Promise<CodexManagedProfile> => {
        const configuredRoot = config.get<string>('codexManagedProfileRoot', '').trim();
        const globalStorageRoot = configuredRoot || context.globalStorageUri.fsPath;
        if (isVsCodeInstallDir(globalStorageRoot)) {
            throw new Error('Managed Codex profile root must not be a VS Code installation directory.');
        }
        return ensureCodexManagedProfile({
            globalStorageRoot,
            repoRoot,
            remoteAuthority: vscode.env.remoteName,
            defaultCodexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        });
    };
    let managedProfile: CodexManagedProfile | undefined;
    let managedProfileError: string | undefined;
    if (managedFeatureRequested) {
        try {
            managedProfile = await resolveManagedProfile();
            log(`[codex] isolated profile=${managedProfile.root} sqlite=${managedProfile.sqliteHome}`);
        } catch (error) {
            managedProfileError = error instanceof Error ? error.message : String(error);
            log(`[codex] isolated profile unavailable: ${managedProfileError}`);
            vscode.window.showWarningMessage(`Forge Relay: isolated managed Codex is unavailable. ${managedProfileError}`);
        }
    }

    // Supervised runtime bridges. Codex remains MCP-only unless its experimental
    // managed-isolated mode is both enabled and explicitly selected.
    const runtimeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runtimeStatusBar.command = 'forgeRelay.openBoard';

    runtimeManager = new RuntimeManager({
        claudeScriptPath: path.join(context.extensionUri.fsPath, 'scripts', 'claude-auto-bridge.js'),
        mcpStdioPath: path.join(context.extensionUri.fsPath, 'out', 'mcpStdio.js'),
        mcpUrl: `http://127.0.0.1:${port}/sse`,
        extensionVersion: String(context.extension.packageJSON.version || 'dev'),
        bridge,
        subagentBackends,
        forgeControlUrl: subagentBackends.forgeControlUrl,
        repoRoot,
        eventsPath,
        nodePath: config.get<string>('nodePath', '').trim() || undefined,
        claudePermissionMode: config.get<string>('claudePermissionMode', 'acceptEdits').trim() || undefined,
        claudeModel: config.get<string>('claudeModel', '').trim() || undefined,
        claudeKeepAliveMs: config.get<number>('claudeKeepAliveMs', 0),
        claudeKeepAliveMaxPings: config.get<number>('claudeKeepAliveMaxPings', 3),
        experimentalManagedCodex: managedFeatureRequested && Boolean(managedProfile),
        codexExecutable: subagentBackends.codexExecutable,
        codexManagedProfile: managedProfile,
        codexManagedModel: config.get<string>('codexManagedModel', '').trim() || undefined,
        codexManagedTurnTimeoutMs: config.get<number>('codexManagedTurnTimeoutMs', 900_000),
        subagentEnv: subagentEnvFromBackends(subagentBackends),
        onLog: (line) => { log(`[bridge] ${line}`); console.log('[forgerelay:bridge]', line); },
        onDuplicateSuppressed: (ownerPid, ownerRepoRoot) => {
            bridge.post('claude', `bridge-duplicate-suppressed (pid ${ownerPid}, window ${ownerRepoRoot})`);
        },
    });
    const rm = runtimeManager;

    const renderStatusBar = (): void => {
        const snap = rm.getSnapshot();
        const managedCodex = snap.codexMode === 'managed-isolated' && snap.roster.codex;
        const primaryStatus = managedCodex ? snap.codex.status : snap.claude.status;
        runtimeStatusBar.text = `$(${statusBarIcon(primaryStatus)}) Forge Relay: `
            + (managedCodex ? `Codex ${snap.codex.status}` : `Claude ${snap.claude.status}`);
        runtimeStatusBar.tooltip = `Claude bridge - ${snap.claude.detail}\nCodex - ${snap.codex.detail}\nClick to open the board.`;
        runtimeStatusBar.show();
    };
    rm.onChange((snapshot) => {
        renderStatusBar();
        // Persist the roster so the selected bridges auto-reconnect after a reload.
        void context.workspaceState.update(ROSTER_KEY, {
            roster: snapshot.roster,
            claudeMode: snapshot.claudeMode,
            codexMode: snapshot.codexMode,
            forgeCoordinatorModel: snapshot.forgeCoordinator.model,
        });
    });
    renderStatusBar();

    // Sidebar view
    const boardViewProvider = new BoardViewProvider(context.extensionUri, bridge, rm);
    boardViewProvider.updateMcpPort(port);

    const watcher = new BoardWatcher(eventsPath, (event) => handleBoardEvent(event));
    watcher.start();

    // Restore the previous session roster so selected bridges auto-reconnect
    // after a window reload (survives restart, per P2/P3).
    const savedSession = context.workspaceState.get<{
        roster: SessionRoster;
        claudeMode: ClaudeMode;
        codexMode?: CodexMode | 'managed-exclusive';
        forgeCoordinatorModel?: string;
    }>(ROSTER_KEY);
    if (savedSession?.roster && (savedSession.roster.claude || savedSession.roster.codex || savedSession.roster.forgeCoordinator)) {
        try {
            await rm.setRoster(
                { ...savedSession.roster },
                savedSession.claudeMode ?? 'A',
                savedSession.forgeCoordinatorModel,
                normalizeCodexMode(savedSession.codexMode),
            );
        } catch (error) {
            log(`[bridge] saved session restore failed: ${error instanceof Error ? error.message : String(error)}`);
            vscode.window.showWarningMessage(
                `Forge Relay: could not restore the managed session. ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            BoardViewProvider.viewId,
            boardViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),

        vscode.commands.registerCommand('forgeRelay.openBoard', () => {
            BoardPanel.createOrShow(context.extensionUri, bridge, rm);
            BoardPanel.current?.updateMcpPort(mcpServer?.getPort() ?? port);
        }),

        vscode.commands.registerCommand('forgeRelay.stopAll', () => {
            bridge.postCommand('user', 'STOP — operator halt', 'all');
            vscode.window.showWarningMessage('Forge Relay: STOP posted to all agents.');
        }),

        vscode.commands.registerCommand('forgeRelay.toggleClanker', () => {
            const next = bridge.getAutonomyMode() === 'clanker' ? 'draft' : 'clanker';
            bridge.setAutonomyMode(next);
            vscode.window.showInformationMessage(next === 'clanker'
                ? 'Forge Relay: 💥 Clanker Mode ON — workers may write/edit/run (destructive commands still blocked).'
                : 'Forge Relay: Draft mode — workers are read-only and propose diffs for review.');
            boardViewProvider.postAutonomy(next);
            BoardPanel.current?.postAutonomy(next);
        }),

        vscode.commands.registerCommand('forgeRelay.showMcpConfig', () => {
            const cfg = buildMcpConfig(context.extensionUri.fsPath, repoRoot, mcpServer?.getPort() ?? port);
            vscode.workspace.openTextDocument({ content: cfg, language: 'markdown' })
                .then(doc => vscode.window.showTextDocument(doc));
        }),

        vscode.commands.registerCommand('forgeRelay.verifySetup', async () => {
            const managedEnabled = config.get<boolean>('experimentalManagedCodex', false);
            let profile = managedProfile;
            let profileError = managedProfileError;
            if (managedEnabled && !profile && !profileError) {
                try { profile = await resolveManagedProfile(); }
                catch (error) { profileError = error instanceof Error ? error.message : String(error); }
            }
            const report = buildVerifySetupReport(
                context.extensionUri.fsPath,
                repoRoot,
                mcpServer?.getPort() ?? port,
                {
                    enabled: managedEnabled,
                    profile,
                    profileError,
                    probe: managedEnabled ? probeCodexAppServers() : undefined,
                },
            );
            const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
            await vscode.window.showTextDocument(doc);
        }),

        vscode.commands.registerCommand('forgeRelay.configureCodex', async () => {
            const result = configureCodexMcp(context.extensionUri.fsPath);
            const fwd = toForwardSlashes(result.path);
            const openConfig = async (): Promise<void> => {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.path));
                await vscode.window.showTextDocument(doc);
            };
            if (result.status === 'error') {
                vscode.window.showErrorMessage(`Forge Relay: could not write Codex config (${fwd}): ${result.detail}`);
                return;
            }
            if (result.status === 'already') {
                const action = await vscode.window.showInformationMessage(
                    `Forge Relay: Codex is already configured in ${fwd}.`, 'Open config', 'Verify Setup');
                if (action === 'Open config') { await openConfig(); }
                else if (action === 'Verify Setup') { vscode.commands.executeCommand('forgeRelay.verifySetup'); }
                return;
            }
            const verb = result.status === 'created' ? 'Created' : 'Updated';
            const action = await vscode.window.showInformationMessage(
                `Forge Relay: ${verb} Codex MCP config at ${fwd}. Restart Codex to pick it up.`, 'Open config');
            if (action === 'Open config') { await openConfig(); }
        }),

        vscode.commands.registerCommand('forgeRelay.configureManagedCodex', async () => {
            let profile: CodexManagedProfile;
            try {
                profile = await resolveManagedProfile();
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Forge Relay: could not create the isolated Codex profile. ${error instanceof Error ? error.message : String(error)}`,
                );
                return;
            }
            let apiKey = await vscode.window.showInputBox({
                title: 'Configure Isolated Managed Codex',
                prompt: 'Enter an OpenAI Platform API key. Managed usage is API-billed. The key is sent only to Codex login over stdin and is not retained by Forge Relay.',
                placeHolder: 'sk-...',
                password: true,
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : 'An API key is required.',
            });
            if (!apiKey) return;
            try {
                const result = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Configuring isolated managed Codex...',
                    cancellable: false,
                }, () => configureManagedCodexApiKey({
                    profile,
                    apiKey: apiKey!,
                    configuredExecutable: subagentBackends.codexExecutable,
                    cwd: repoRoot,
                }));
                if (result.ok) {
                    managedProfile = profile;
                    managedProfileError = undefined;
                    vscode.window.showInformationMessage(
                        'Forge Relay: isolated managed Codex authentication configured. Reload the window if the managed option was previously unavailable.',
                    );
                } else {
                    vscode.window.showErrorMessage(`Forge Relay: ${result.message}`);
                }
            } finally {
                apiKey = undefined;
            }
        }),

        vscode.commands.registerCommand('forgeRelay.configureClaude', async () => {
            const result = configureClaudeMcp(mcpServer?.getPort() ?? port);
            const fwd = toForwardSlashes(result.path);
            if (result.status === 'error') {
                vscode.window.showErrorMessage(`Forge Relay: could not write Claude config (${fwd}): ${result.detail}`);
                return;
            }
            if (result.status === 'already') {
                vscode.window.showInformationMessage(`Forge Relay: Claude is already configured in ${fwd}.`);
                return;
            }
            const verb = result.status === 'created' ? 'Created' : 'Updated';
            const action = await vscode.window.showInformationMessage(
                `Forge Relay: ${verb} Claude MCP config at ${fwd}. Restart Claude Code to pick it up.`, 'Open config');
            if (action === 'Open config') {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.path));
                await vscode.window.showTextDocument(doc);
            }
        }),

        vscode.commands.registerCommand('forgeRelay.getStarted', async () => {
            // One-shot onboarding: wire both agents, then show the verify report so
            // the user sees green checks (or exactly what is still missing).
            const codex = configureCodexMcp(context.extensionUri.fsPath);
            const claude = configureClaudeMcp(mcpServer?.getPort() ?? port);
            const summarize = (name: string, r: { status: string; detail?: string }): string => {
                switch (r.status) {
                    case 'created': case 'appended': case 'updated': return `${name}: configured`;
                    case 'already': return `${name}: already configured`;
                    default: return `${name}: FAILED (${r.detail ?? 'unknown error'})`;
                }
            };
            vscode.window.showInformationMessage(
                `Forge Relay Get Started — ${summarize('Codex', codex)}; ${summarize('Claude', claude)}. Opening the verification report…`);
            await vscode.commands.executeCommand('forgeRelay.verifySetup');

            // Offer the shared agent protocol file. It tells agents that board
            // usage is opt-in ("start using the board"), so agents stay quiet —
            // and cheap — on solo work. Never overwrite an existing AGENTS.md.
            const agentsTarget = path.join(repoRoot, 'AGENTS.md');
            if (!fs.existsSync(agentsTarget)) {
                const choice = await vscode.window.showInformationMessage(
                    'Forge Relay: Create an AGENTS.md in this workspace? It teaches agents the board protocol (opt-in: agents only use the board when you say "start using the board").',
                    'Create AGENTS.md', 'Skip');
                if (choice === 'Create AGENTS.md') {
                    try {
                        const template = path.join(context.extensionUri.fsPath, 'resources', 'AGENTS.template.md');
                        fs.copyFileSync(template, agentsTarget);
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(agentsTarget));
                        await vscode.window.showTextDocument(doc);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Forge Relay: could not create AGENTS.md: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }),

        runtimeStatusBar,

        {
            dispose: () => {
                mcpServer?.stop();
                watcher.stop();
                void rm.stopAll();
            }
        }
    );
}

export async function deactivate(): Promise<void> {
    mcpServer?.stop();
    await runtimeManager?.stopAll();
}

// ── Board event → VS Code notification ───────────────────────────────────────

function handleBoardEvent(event: BoardEvent): void {
    const isStop    = event.type === 'command' && /\bSTOP\b/i.test(event.message);
    const isPause   = event.type === 'command' && /\bPAUSE\b/i.test(event.message);
    const isPost    = event.type === 'post';
    const isClaim   = event.type === 'claim';

    if (isStop) {
        // Persistent warning — stays until dismissed
        vscode.window.showWarningMessage(
            `Forge Relay STOP [${event.agent}]: ${event.message}`,
            'Open Board', 'Dismiss'
        ).then(action => {
            if (action === 'Open Board') {
                vscode.commands.executeCommand('forgeRelay.openBoard');
            }
        });
        return;
    }

    if (isPause) {
        vscode.window.showWarningMessage(
            `Forge Relay PAUSE [${event.agent}]: ${event.message}`,
            'Open Board'
        ).then(action => {
            if (action === 'Open Board') {
                vscode.commands.executeCommand('forgeRelay.openBoard');
            }
        });
        return;
    }

    if (isPost) {
        // Keep board traffic inside Forge Relay instead of routing into whichever chat provider
        // VS Code considers active.
        vscode.window.showInformationMessage(
            `Forge Relay [${event.agent}]: ${event.message}`,
            'Open Board'
        ).then(action => {
            if (action === 'Open Board') {
                vscode.commands.executeCommand('forgeRelay.openBoard');
            }
        });
        return;
    }

    if (isClaim) {
        // Subtle status bar hint for claims — not a full popup
        vscode.window.setStatusBarMessage(
            `Forge Relay: ${event.agent} claimed ${event.paths.join(', ')}`,
            5000
        );
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBarIcon(status: RuntimeStatus): string {
    switch (status) {
        case 'linked': return 'pass-filled';
        case 'waiting': return 'sync~spin';
        case 'follower': return 'eye';
        case 'error': return 'warning';
        case 'unsupported': return 'circle-slash';
        case 'stopped': return 'error';
        default: return 'circle-outline';
    }
}

function buildMcpConfig(extensionPath: string, repoRoot: string, mcpPort: number): string {
    const stdioPath = getStdioPath(extensionPath);
    const claudePaths = getClaudeConfigPaths(repoRoot);

    return [
        '# Forge Relay MCP Config',
        '',
        'Forge Relay no longer writes MCP config into the workspace or your home directory.',
        'Paste one of the snippets below into the client config file you want to manage manually.',
        '',
        '## What Forge Relay handles automatically',
        '',
        '- Ships extension-owned UI metadata such as icons and commands.',
        '- Starts the local Forge Relay MCP server when VS Code opens the workspace.',
        '- Maintains the workspace `.mcp.json` entry when a Claude Mode A orchestrator is started (Mode A only).',
        '',
        '## What you still need to configure manually on each machine',
        '',
        '- Codex: run `Forge Relay: Configure Codex` to write the entry automatically, or paste the snippet below into `config.toml` (without hardwiring `--repoRoot` in the global entry).',
        '- Add the Forge Relay MCP entry to the Claude `settings.json` file you want to use.',
        '- Run `Forge Relay: Verify Setup` after configuring both tools.',
        '',
        '## Verified config sources in this environment',
        '',
        '- Claude Code reads `settings.json` style files. Observed paths:',
        `  - User: \`${toForwardSlashes(claudePaths.user)}\``,
        `  - Workspace: \`${toForwardSlashes(claudePaths.workspace)}\``,
        `  - Workspace local override: \`${toForwardSlashes(claudePaths.workspaceLocal)}\``,
        `- Codex reads \`${toForwardSlashes(getCodexConfigPath())}\`.`,
        '',
        `## Codex (\`${toForwardSlashes(getCodexConfigPath())}\`)`,
        '',
        '```toml',
        '[mcp_servers.forgerelay]',
        'command = "node"',
        `args = ["${stdioPath}"]`,
        '```',
        '',
        'Codex should resolve the board from the current workspace `cwd` by default.',
        'Do not keep a single global `--repoRoot "n:/vs code apps/forge-relay"` style argument in this entry, or every Codex workspace will write to the same board.',
        '',
        '## Claude Code (`settings.json` file)',
        '',
        'Add or merge this under the top-level object in the Claude settings file you want to use:',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "forgerelay": {',
        '      "type": "sse",',
        `      "url": "http://127.0.0.1:${mcpPort}/sse"`,
        '    }',
        '  }',
        '}',
        '```',
        '',
        '## Recovery',
        '',
        '- If Claude stops launching, rename workspace `.claude/settings.json` first.',
        '- If that does not recover it, rename workspace `.claude/settings.local.json` or the whole workspace `.claude` folder.',
        '- Prefer renaming for rollback; do not delete the files first.',
        '',
    ].join('\n');
}

function buildVerifySetupReport(
    extensionPath: string,
    repoRoot: string,
    mcpPort: number,
    managed?: {
        enabled: boolean;
        profile?: CodexManagedProfile;
        profileError?: string;
        probe?: ReturnType<typeof probeCodexAppServers>;
    },
): string {
    const stdioPath = getStdioPath(extensionPath);
    const codexConfigPath = getCodexConfigPath();
    const claudePaths = getClaudeConfigPaths(repoRoot);
    const nodeCheck = checkNodeRuntime();
    const stdioExists = fs.existsSync(stdioPath);
    const codexConfig = inspectFile(codexConfigPath, hasCodexForgeRelayConfig);
    const codexHardwiredRepoRoot = inspectFile(codexConfigPath, hasCodexHardwiredRepoRoot);
    const claudeUserConfig = inspectFile(claudePaths.user, hasClaudeForgeRelayConfig);
    const claudeWorkspaceConfig = inspectFile(claudePaths.workspace, hasClaudeForgeRelayConfig);
    const claudeWorkspaceLocalConfig = inspectFile(claudePaths.workspaceLocal, hasClaudeForgeRelayConfig);
    const anyClaudeConfigured = [claudeUserConfig, claudeWorkspaceConfig, claudeWorkspaceLocalConfig]
        .some(result => result.hasEntry);

    return [
        '# Forge Relay Verify Setup',
        '',
        `Checked at: ${new Date().toISOString()}`,
        `Repo root: \`${toForwardSlashes(repoRoot)}\``,
        `Coordination dir: \`${toForwardSlashes(path.join(repoRoot, '.coordination'))}\``,
        '',
        '## Verification',
        '',
        formatCheck('Node runtime available', nodeCheck.ok, nodeCheck.detail),
        formatCheck('Built MCP stdio bundle exists', stdioExists, toForwardSlashes(stdioPath)),
        formatCheck('Codex config has `forgerelay` entry', codexConfig.hasEntry, describeInspection(codexConfig)),
        formatCheck('Codex config does not hardwire a global `--repoRoot`', !codexHardwiredRepoRoot.hasEntry, describeInspection(codexHardwiredRepoRoot)),
        formatCheck('At least one checked Claude settings file has `forgerelay` entry', anyClaudeConfigured, summarizeClaudeStatus([claudeUserConfig, claudeWorkspaceConfig, claudeWorkspaceLocalConfig])),
        ...(managed?.enabled ? [
            formatCheck('Managed Codex isolated profile available', Boolean(managed.profile),
                managed.profile?.root ?? managed.profileError ?? 'Profile was not resolved.'),
        ] : []),
        ...(managed?.enabled && managed.probe ? [
            `- Codex process diagnostics: ${managed.probe.detail} This is informational and does not block isolated managed startup.`,
        ] : []),
        `- Managed Codex feature: ${managed?.enabled ? 'enabled (experimental)' : 'disabled; MCP-only is the default'}.`,
        ...(managed?.profile ? [
            `- Isolated managed CODEX_HOME: \`${toForwardSlashes(managed.profile.home)}\`.`,
            `- Isolated managed CODEX_SQLITE_HOME: \`${toForwardSlashes(managed.profile.sqliteHome)}\`.`,
        ] : []),
        '',
        '## Claude file inspection',
        '',
        formatFileInspection('User settings', claudeUserConfig),
        formatFileInspection('Workspace settings', claudeWorkspaceConfig),
        formatFileInspection('Workspace local settings', claudeWorkspaceLocalConfig),
        '',
        '## Interpretation',
        '',
        `- Codex config status: ${summarizeStatus(codexConfig)}${codexHardwiredRepoRoot.hasEntry ? '; global --repoRoot should be removed' : ''}.`,
        `- Claude config status: ${summarizeClaudeStatus([claudeUserConfig, claudeWorkspaceConfig, claudeWorkspaceLocalConfig])}.`,
        '- This command does not modify any config files.',
        '',
        buildMcpConfig(extensionPath, repoRoot, mcpPort),
    ].join('\n');
}

function getStdioPath(extensionPath: string): string {
    return toForwardSlashes(path.join(extensionPath, 'out', 'mcpStdio.js'));
}

type CodexConfigResult = {
    status: 'created' | 'appended' | 'already' | 'error';
    path: string;
    detail?: string;
};

/**
 * Write the `[mcp_servers.forgerelay]` entry into the user's Codex config.toml,
 * so Codex setup is zero-touch like Claude's. Deliberately omits a global
 * `--repoRoot` (Codex resolves the board from its workspace cwd; a hardwired
 * root would make every workspace share one board — see buildMcpConfig). Never
 * clobbers an existing entry: if one is present we leave it and report `already`.
 */
function configureCodexMcp(extensionPath: string): CodexConfigResult {
    const configPath = getCodexConfigPath();
    const stdioPath = getStdioPath(extensionPath);
    const block = [
        '[mcp_servers.forgerelay]',
        'command = "node"',
        `args = ["${stdioPath}"]`,
        '',
    ].join('\n');
    try {
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, block, 'utf8');
            return { status: 'created', path: configPath };
        }
        const existing = fs.readFileSync(configPath, 'utf8');
        if (hasCodexForgeRelayConfig(existing)) {
            return { status: 'already', path: configPath };
        }
        const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
        fs.appendFileSync(configPath, prefix + block, 'utf8');
        return { status: 'appended', path: configPath };
    } catch (err) {
        return { status: 'error', path: configPath, detail: err instanceof Error ? err.message : String(err) };
    }
}

function getCodexConfigPath(): string {
    return path.join(os.homedir(), '.codex', 'config.toml');
}

type ClaudeConfigResult = {
    status: 'created' | 'updated' | 'already' | 'error';
    path: string;
    detail?: string;
};

/**
 * Write the `forgerelay` MCP entry into the user-level Claude settings
 * (`~/.claude/settings.json`), the Claude twin of `configureCodexMcp`. Merges
 * into the existing JSON and never clobbers: an existing `forgerelay` entry is
 * left untouched (`already`), and an unparseable file is reported as an error
 * instead of being overwritten. Uses the actual bound MCP port so the entry
 * matches this window's server.
 */
function configureClaudeMcp(mcpPort: number): ClaudeConfigResult {
    const configPath = path.join(os.homedir(), '.claude', 'settings.json');
    const entry = { type: 'sse', url: `http://127.0.0.1:${mcpPort}/sse` };
    try {
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { forgerelay: entry } }, null, 2) + '\n', 'utf8');
            return { status: 'created', path: configPath };
        }
        const raw = fs.readFileSync(configPath, 'utf8');
        let parsed: Record<string, unknown>;
        try {
            parsed = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
        } catch (err) {
            return {
                status: 'error', path: configPath,
                detail: `existing file is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix or rename it first; refusing to overwrite`,
            };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { status: 'error', path: configPath, detail: 'existing file is not a JSON object — refusing to overwrite' };
        }
        const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
        if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
            return { status: 'error', path: configPath, detail: '"mcpServers" is not an object — refusing to overwrite' };
        }
        if (servers.forgerelay !== undefined) {
            return { status: 'already', path: configPath };
        }
        servers.forgerelay = entry;
        parsed.mcpServers = servers;
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        return { status: 'updated', path: configPath };
    } catch (err) {
        return { status: 'error', path: configPath, detail: err instanceof Error ? err.message : String(err) };
    }
}

function getClaudeConfigPaths(repoRoot: string): { user: string; workspace: string; workspaceLocal: string } {
    return {
        user: path.join(os.homedir(), '.claude', 'settings.json'),
        workspace: path.join(repoRoot, '.claude', 'settings.json'),
        workspaceLocal: path.join(repoRoot, '.claude', 'settings.local.json'),
    };
}

function checkNodeRuntime(): { ok: boolean; detail: string } {
    const result = spawnSync('node', ['--version'], { encoding: 'utf8' });
    if (result.error) {
        return { ok: false, detail: `node --version failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
        return { ok: false, detail: `node --version failed: ${detail}` };
    }
    return { ok: true, detail: (result.stdout || '').trim() };
}

function inspectFile(filePath: string, matcher: (content: string) => boolean): { path: string; exists: boolean; hasEntry: boolean; detail: string } {
    if (!fs.existsSync(filePath)) {
        return { path: filePath, exists: false, hasEntry: false, detail: 'missing' };
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const hasEntry = matcher(content);
        return {
            path: filePath,
            exists: true,
            hasEntry,
            detail: hasEntry ? 'entry found' : 'entry missing',
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { path: filePath, exists: true, hasEntry: false, detail: `read failed: ${message}` };
    }
}

function hasCodexForgeRelayConfig(content: string): boolean {
    return /\[mcp_servers\.forgerelay\]/i.test(content);
}

function hasCodexHardwiredRepoRoot(content: string): boolean {
    return /\[mcp_servers\.forgerelay\][\s\S]*?--repoRoot/i.test(content);
}

function hasClaudeForgeRelayConfig(content: string): boolean {
    return /"forgerelay"\s*:/i.test(content);
}

function formatCheck(label: string, ok: boolean, detail: string): string {
    return `- ${ok ? 'PASS' : 'FAIL'}: ${label} (${detail})`;
}

function formatFileInspection(label: string, result: { path: string; exists: boolean; hasEntry: boolean; detail: string }): string {
    return `- ${label}: ${result.detail}; ${toForwardSlashes(result.path)}`;
}

function describeInspection(result: { path: string; exists: boolean; detail: string }): string {
    return `${result.detail}; ${toForwardSlashes(result.path)}`;
}

function summarizeStatus(result: { exists: boolean; hasEntry: boolean }): string {
    if (result.hasEntry) {
        return 'configured';
    }
    if (result.exists) {
        return 'file exists but forgerelay entry is missing';
    }
    return 'config file missing';
}

function summarizeClaudeStatus(results: Array<{ exists: boolean; hasEntry: boolean; path: string }>): string {
    const configured = results.filter(result => result.hasEntry);
    if (configured.length > 0) {
        return `configured in ${configured.map(result => `\`${toForwardSlashes(result.path)}\``).join(', ')}`;
    }
    if (results.some(result => result.exists)) {
        return 'settings files exist but no forgerelay entry was found';
    }
    return 'no checked settings file currently contains a forgerelay entry';
}

function toForwardSlashes(value: string): string {
    return value.replace(/\\/g, '/');
}
