#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, CallToolResult, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from './bridge';
import { EventTail } from './eventTail';
import { DEFAULT_SUBAGENT_BACKENDS, SubagentBackends } from './subagent';
import { BOARD_TOOL_SCHEMAS, executeBoardTool } from './boardTools';
import { isVsCodeInstallDir, fallbackCoordinationRoot } from './vscodeInstallDir';

// repoRoot resolution order: FORGERELAY_REPO_ROOT env wins, then --repoRoot, then
// cwd. The codex/claude auto-bridge injects FORGERELAY_REPO_ROOT with the actual
// workspace it is running in, which must override the --repoRoot baked into the
// *global* ~/.codex/config.toml — otherwise every codex window posts to whichever
// single repo that config names, instead of its own workspace board.
const repoRootArg = process.argv.indexOf('--repoRoot');
let repoRoot = process.env.FORGERELAY_REPO_ROOT
    || (repoRootArg !== -1 ? process.argv[repoRootArg + 1] : process.cwd());

// Never write the .coordination board into a VS Code install dir. When spawned
// with cwd inside the install folder (no real workspace), creating the board
// there keeps mcpstdio.log open and blocks the auto-updater forever
// ("Access is denied (os error 5)"). This headless server can't prompt, so it
// redirects the board to a safe per-user fallback instead of poisoning the dir.
if (isVsCodeInstallDir(repoRoot)) {
    repoRoot = fallbackCoordinationRoot();
}

const bridge = new Bridge(repoRoot);
// B7: single source of truth for the coordination dir — ask the bridge rather
// than recomputing the path here, so the two can never drift apart.
const eventsPath = bridge.getEventsPath();

// Routing breadcrumb: which board THIS MCP server (the one codex spawned) writes
// to, and whether the per-workspace env override actually reached us. Written to
// a file, never stdout — stdout is the JSON-RPC channel and must stay clean.
try {
    const argRepo = repoRootArg !== -1 ? process.argv[repoRootArg + 1] : '(none)';
    fs.appendFileSync(
        path.join(path.dirname(eventsPath), 'mcpstdio.log'),
        `[${new Date().toISOString()}] mcpStdio start pid=${process.pid} -> board=${eventsPath} `
        + `(env FORGERELAY_REPO_ROOT=${process.env.FORGERELAY_REPO_ROOT || '(unset)'}, --repoRoot arg=${argRepo}, cwd=${process.cwd()})\n`,
    );
} catch {
    // logging is best-effort; never block startup
}

// Per-call breadcrumb so we can finally answer "did Codex's model actually CALL
// a tool, or only spawn the server?" (see docs/CODEX_MCP_VS_SCRIPTS_VERIFICATION.md
// §2). Written to the same mcpstdio.log, never stdout (that's the JSON-RPC channel).
function logToolCall(tool: string, agent: string): void {
    try {
        fs.appendFileSync(
            path.join(path.dirname(eventsPath), 'mcpstdio.log'),
            `[${new Date().toISOString()}] tool=${tool} agent=${agent || '(none)'} pid=${process.pid}\n`,
        );
    } catch {
        // best-effort; never block a tool call on logging
    }
}

// Subagent backends — defaults can be overridden via env vars so Codex (which
// spawns this stdio server itself) can point at the same endpoints as the
// extension without sharing VS Code settings.
const subagentBackends: SubagentBackends = {
    bridgeUrl: process.env.FORGERELAY_BRIDGE_URL || DEFAULT_SUBAGENT_BACKENDS.bridgeUrl,
    ollamaUrl: process.env.FORGERELAY_OLLAMA_URL || DEFAULT_SUBAGENT_BACKENDS.ollamaUrl,
    directUrl: process.env.FORGERELAY_DIRECT_URL || DEFAULT_SUBAGENT_BACKENDS.directUrl,
    bridgeApiKey: process.env.FORGERELAY_BRIDGE_API_KEY || undefined,
    defaultBackend: (process.env.FORGERELAY_DEFAULT_BACKEND as SubagentBackends['defaultBackend']) || DEFAULT_SUBAGENT_BACKENDS.defaultBackend,
    forgeControlUrl: process.env.FORGERELAY_FORGE_CONTROL_URL || undefined,
    defaultRunMode: (process.env.FORGERELAY_DEFAULT_MODE as SubagentBackends['defaultRunMode']) || DEFAULT_SUBAGENT_BACKENDS.defaultRunMode,
    ollamaAutoStart: process.env.FORGERELAY_OLLAMA_AUTO_START === '1',
    ollamaExecutable: process.env.FORGERELAY_OLLAMA_EXECUTABLE || undefined,
    codexExecutable: process.env.FORGERELAY_CODEX_EXECUTABLE || undefined,
    codexTimeoutMs: Number(process.env.FORGERELAY_CODEX_TIMEOUT_MS) || undefined,
};

const server = new Server(
    { name: 'forgerelay', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BOARD_TOOL_SCHEMAS,
}));

// Codex's MCP client probes resources/list and resources/templates/list at
// connect. Forge Relay is tools-only, so without these handlers the SDK answers
// -32601 Method not found and Codex logs two warnings on every connect. Declaring
// the resources capability above and returning empty lists here gives Codex a
// clean, valid (empty) catalog instead of an error. Claude-class clients that DO
// consume resources simply see none — no behavioural change, just no noise.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    logToolCall(request.params.name, str(args.agent));

    try {
        return text(await executeBoardTool(bridge, subagentBackends, request.params.name, args));
    } catch (err) {
        return text(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // B5: tail events.ndjson via the shared EventTail and push MCP notifications
    // to the connected client. EventTail handles rotation/truncation/partial
    // lines, so this loop stays trivial.
    const tail = new EventTail(eventsPath);
    const timer = setInterval(() => {
        for (const event of tail.readNew()) {
            server.notification({
                method: 'notifications/message',
                params: {
                    level: /\bSTOP\b/i.test(event.message) ? 'alert' : 'info',
                    logger: 'forgerelay.board',
                    data: { type: 'board_event', event },
                },
            });
        }
    }, 500);
    timer.unref?.();
}

main().catch(err => {
    process.stderr.write(`[forgerelay-stdio] fatal: ${err}\n`);
    process.exit(1);
});

function str(v: unknown): string { return String(v ?? ''); }
function text(content: string): CallToolResult {
    return { content: [{ type: 'text', text: content }] };
}
