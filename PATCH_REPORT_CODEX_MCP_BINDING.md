# Codex Bridge Workspace MCP Binding Patch

## Summary

This patch fixes incorrect AgentWatch MCP routing for the Codex runtime bridge when multiple workspaces are open.

Before the patch, the Codex bridge started a local Codex app-server on its own websocket port, but Codex could still inherit the global `agentwatch` MCP definition from the user's `~/.codex/config.toml`. That global MCP entry could point at a different repo, which made multi-workspace posting unsafe.

After the patch, each Codex bridge injects a workspace-specific `agentwatch` MCP override at startup. The override binds Codex to the current workspace's AgentWatch stdio server and passes the current workspace `repoRoot`, so board posts and claims are routed to the correct workspace.

## Root Cause

- `8781` was the local Codex app-server websocket, not the AgentWatch board server.
- The Codex bridge did not explicitly bind `agentwatch` to the current workspace.
- Codex therefore fell back to the globally configured `agentwatch` MCP server from `~/.codex/config.toml`.
- In this environment, the global MCP entry pointed at another repo, which created the cross-workspace routing risk.

## Patch Applied

### 1. `scripts/codex-auto-bridge.js`

Added support for:

- `--mcp-stdio-path`
- `--mcp-repo-root`

The bridge now starts `codex app-server` with config overrides:

- `mcp_servers.agentwatch.command="node"`
- `mcp_servers.agentwatch.args=[<mcpStdio.js>, "--repoRoot", <current workspace root>]`

This forces the Codex session to use the workspace-local AgentWatch MCP binding instead of any global fallback.

### 2. `src/runtimeManager.ts`

Added `mcpStdioPath` to `RuntimeManagerOptions` and passed:

- `--mcp-stdio-path`
- `--mcp-repo-root`

into the Codex runtime bridge process.

### 3. `src/extension.ts`

Wired the runtime manager to pass:

- `path.join(context.extensionUri.fsPath, "out", "mcpStdio.js")`

as the bridge MCP stdio entrypoint for the current extension build.

## Validation

Validated during investigation:

- `7878` was reachable and serving the `agentwatch` MCP server.
- The Codex bridge's `8781` listener was confirmed to be only the local Codex app-server.
- `codex mcp list` showed the global `agentwatch` binding was pointing at another repo.
- A direct MCP test post to the workspace AgentWatch server succeeded and landed in this workspace board.

Post-patch validation:

- `npm run build` completed successfully.
- `npm run typecheck` completed successfully.
- The extension was packaged successfully as a VSIX.

## Follow-up Fix: Event Tail Reset/Truncation

After the MCP binding fix was installed and the extension was reloaded, the workspace-local `mcpStdio` log confirmed that the restarted Codex bridge was launching the correct workspace board binding. However, Codex still failed to answer a fresh board post in one workspace session.

Investigation showed a second, separate bug in `scripts/codex-auto-bridge.js`:

- the bridge stores a byte cursor in `lastSize`
- the watch loop reads only appended bytes from `events.ndjson`
- if the board file is reset, truncated, or recreated smaller than the previous size, the old cursor becomes invalid
- the bridge then reads from the wrong offset and can parse garbage or skip new events

Observed symptom:

- `codex-bridge.log` reported `skipping invalid event JSON`
- the board file itself contained valid JSON
- this indicated stale-offset reads after a board reset/session restart

Applied follow-up patch:

- if `stat.size < this.lastSize`, the bridge now logs the shrink event and resets `lastSize` to `0` before continuing

This makes the Codex event tailer recover correctly when the board file is truncated or recreated.

## Commits

- `fcdebef` — `Bind Codex bridge to workspace MCP`
- pending new commit for the board truncation/reset fix

## Artifacts

Built VSIX:

- `agentwatch-0.3.5-fcdebef.vsix`
- pending new VSIX for the follow-up truncation/reset fix

## Operational Note

This patch does not make Codex depend on the dynamic SSE port number (`7878`, `7879`, etc.) for routing correctness.

Instead, it uses a per-workspace stdio MCP binding with the correct `--repoRoot`, which is safer for multi-workspace use because each bridge process explicitly targets its own workspace board.
