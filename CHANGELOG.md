# Changelog

All notable changes to the Forge Relay extension.

## Unreleased

## 0.5.2

- Fixed llama.cpp workers exhausting their completion budget on hidden reasoning:
  worker requests now disable template-level thinking, Tier-1 dispatch defaults
  to 4,096 completion tokens, and `dispatch_subagent` accepts a validated
  `max_tokens` override for larger tasks.
- Test builds now clear stale generated bundles, preventing removed tests from a
  previously checked-out branch from contaminating the current branch's run.

## 0.5.1

- Added task cards (FR-5): persistent, board-visible work items with a
  validated lifecycle (open/in_progress/blocked/done/cancelled), severity
  tags, owner assignment, and blocking reasons — distinct from operator
  STOP/PAUSE and file claims. Nine new MCP tools (`create_task`,
  `update_task`, `assign_task`, `start_task`, `block_task`, `unblock_task`,
  `complete_task`, `cancel_task`, `list_tasks`) plus a Task Cards section in
  the sidebar and tab panel.
- Serialized `codex exec` dispatches to one in flight at a time — overlapping
  dispatches previously spawned untracked concurrent Codex processes, which
  risks `token_revoked` under a shared ChatGPT OAuth login.

## 0.5.0

- File and folder claims now conflict on parent/child path overlap, not just
  exact-path matches (e.g. claiming `src` correctly conflicts with an existing
  claim on `src/bridge.ts`), closing a collision-safety gap. Same-agent claims
  still never block that agent; sibling and prefix-only paths (`src/auth` vs
  `src/authentication`) still do not conflict.
- The board sidebar and tab panel now push state updates immediately on new
  board events via a per-view file watcher, instead of relying solely on a
  flat 2-second poll (a slower backstop poll remains as defense in depth).
- Added a coordinated build tool (`run_build`): runs a locally-configured
  build command with pre-flight board checks, claims the configured target(s),
  posts start/result to the board, and always releases the claim on success,
  failure, timeout, or operator STOP — configured via `forgeRelay.build.command`
  / `.claimTargets` / `.timeoutMs` (the command itself is never a tool-call
  argument, so it can't be redirected by a model).
- Fixed the Forge coordinator's history trimming dropping an `assistant`
  tool-call message while keeping its paired tool-response message, which
  produced `role 'tool' must follow tool_calls` HTTP 400s from `forge-chat`
  under bursty coordinator activity.
- Centralized board tool schemas and execution across MCP HTTP, MCP stdio, and the Forge coordinator.
- Shared the worker/coordinator completion round; coordinator history now truncates tool results to 8,000 characters and reports empty token-limit completions as errors.
- Fixed the coordinator tools payload for strict OpenAI-compatible providers: board tool schemas are now sent as `function.parameters` instead of the MCP `inputSchema` key, which Cerebras rejected with HTTP 400.
- Sorted the coordinator model dropdown: `@main` profile entries first, alphabetical within each profile group.
- The coordinator dropdown now names the actual provider for cloud models (e.g. `(cerebras)`, `(OpenRouter)`) when Forge >= 0.12.28 reports the new `provider` field on `GET /models`; older Forge versions keep the generic `(provider)` tag.
- Added the Forge model coordinator MVP to the Connect dialog. A selected
  Forge `model@profile` reacts to board events with persistent bounded history,
  uses only board/dispatch tools, suppresses its own events, and never receives
  file or terminal capabilities.
- Added coordinator model lifecycle management: validate on connect, lazy
  re-ensure for event bursts, five-minute idle release, release on disconnect
  and shutdown, visible failures, bounded retry backoff, and STOP cancellation.
- Added automatic Forge control discovery through the live per-user registry
  `%LOCALAPPDATA%/forge-llm/control-server.json`. The explicit
  `forgeRelay.subagentForgeControlUrl` setting remains available as an override.
- Added a machine-wide, board-endpoint-keyed runtime lock shared by Claude and
  Forge coordinators, including stale-owner recovery, old-version process-tree
  cleanup, duplicate suppression notices, and shutdown release.
- Extracted shared Claude/Forge board-event filtering and added coordinator,
  control-discovery, and cross-runtime-lock regression tests.

## 0.4.2

- Session-start dialog: the headless Claude bridge (Mode B) is now the
  pre-selected default, and both options are described in plain language
  ("Run Claude in the background" / "Drive Claude from your own chat")
  instead of Mode A/B jargon. Internal values and settings are unchanged.

## 0.4.1

- Codex worker board posts now name the model: the started post shows the
  `codex:<model>` override or the `~/.codex/config.toml` default, and the done
  post shows the model `codex exec` actually reported in its run header.
- Coordination-lock fix: an error thrown inside a locked operation (e.g.
  "Unknown command id") now propagates immediately instead of being retried
  for 10 s and misreported as "Could not acquire coordination lock".
- `resolve_command` / `ack_command` accept an unambiguous command-id prefix
  (≥6 chars), matching the truncated ids that `board_check` and the board
  webview display.

## 0.4.0

- **Codex worker backend**: `dispatch_subagent` now accepts model `"codex"` (or
  `"codex:<model>"`) and runs the task as one short-lived `codex exec` work
  order in the coordinated repo. The worker inherits the full board lifecycle —
  `worker-N:codex` started/done posts, STOP/PAUSE aborts the process, async
  mode @mentions the dispatcher — and is sandboxed by board autonomy: draft →
  `--sandbox read-only`, clanker → `--sandbox workspace-write`. Relay never
  passes Codex's sandbox-bypass flags. New settings:
  `forgeRelay.codexExecutable` and `forgeRelay.codexWorkerTimeoutMs` (default
  15 min), mirrored to the stdio MCP server as `FORGERELAY_CODEX_*` env.
  `list_models` advertises the Codex worker when the CLI is installed.
- **Configure Claude** command: writes the `forgerelay` MCP entry into
  `~/.claude/settings.json` (merges into existing JSON, refuses to touch
  malformed files, never clobbers an existing entry) — the Claude twin of
  Configure Codex.
- **Get Started** command: one-shot onboarding that runs Configure Codex +
  Configure Claude and opens the Verify Setup report.
- README: rewritten opening pitch around the collision-prevention story;
  documented the Codex worker and the new commands.

## 0.3.26

- The stdio MCP server now answers Codex's `resources/list` and
  `resources/templates/list` probes with empty lists (and declares the
  `resources` capability) instead of returning `-32601 Method not found`. Forge
  Relay is tools-only, so Codex logged two warnings on every connect; this gives
  it a clean empty catalog and silences the noise. No behavioural change for
  Claude-class clients.
- Board webview: the feed/section header actions (session picker, New Session,
  Clear) now wrap to a second line in a narrow sidebar instead of being clipped
  off the panel edge.

## 0.3.25

- Added a **Forge Relay: Configure Codex** command so Codex setup is zero-touch
  like Claude's. It writes the `[mcp_servers.forgerelay]` entry into
  `~/.codex/config.toml` (creating the file/dir if needed), deliberately without
  a global `--repoRoot` so each Codex workspace keeps its own board. It never
  clobbers an existing entry — if one is present it reports it and offers to open
  the file or run Verify Setup. New users no longer have to hand-edit Codex
  config.

## 0.3.24

- Closed the second path that could write `.coordination` into a VS Code install
  dir. 0.3.23 only guarded the in-extension HTTP server; the standalone stdio MCP
  server (`mcpStdio.ts`) still fell back to `process.cwd()`, which is the install
  dir when Codex/Claude spawned it without a real workspace — so it kept
  recreating the board (and the os error 5 update failure). The install-dir check
  is now a shared helper (`vscodeInstallDir.ts`) used by both paths; the headless
  stdio server redirects the board to a per-user fallback
  (`~/.forge-relay/orphan-board`) instead of poisoning the install dir.

## 0.3.23

- Fixed a recurring VS Code update failure ("There was an error while Deleting a
  directory ... `.coordination`: Access is denied (os error 5)"). If the VS Code
  install folder was ever opened as a workspace, Forge Relay created its
  `.coordination` board there and kept `mcpstdio.log` open, so the auto-updater
  could never delete that directory. Activation now detects a VS Code
  installation directory (launcher plus `resources/app/product.json`) and
  refuses to coordinate it, surfacing a warning instead of writing the board.
  Normal project workspaces are unaffected.

## 0.3.19

- Fixed colon-id routing: an unprefixed Ollama-style model id (e.g.
  `gemma4:31b-cloud`) was split at its first colon, so the entire colon-tagged
  Ollama/cloud family failed catalog lookup unless wrapped in an explicit
  `forge:` prefix. Only the four route prefixes (`forge:` / `bridge:` /
  `ollama:` / `direct:`) are stripped now; any other first segment is part of
  the model name. Worker board names get the same treatment (no more
  `worker-1:31b-cloud`).
- Unified subagent config across Relay's two MCP servers: the managed
  `.mcp.json` entry now carries a `FORGERELAY_*` env block mirroring the
  workspace `forgeRelay.subagent*` settings, so the stdio server Claude spawns
  resolves models with the same Forge route and backend URLs as the extension's
  HTTP server (previously it silently ran with defaults — no Forge catalog).
- Removed the dead `forgeRoute()` helper (superseded by `decideForgeRoute`).

## 0.3.18

- Fixed the streamable-HTTP MCP transport: `POST /mcp` handed the raw request
  Buffer to the SDK, so every request failed with "Invalid JSON-RPC message"
  (clients had to fall back to SSE). The body is now parsed before dispatch,
  with a proper `-32700` JSON-RPC error for malformed JSON. Also fixed
  streamable session registration (it raced the SDK's initialize handling, so
  every follow-up request failed "Server not initialized"); sessions now
  register via the SDK's `onsessioninitialized` callback. Both locked by
  end-to-end regression tests (initialize → tools/list on one session).
- Removed the managed Codex bridge entirely. Codex participates on the board
  MCP-only via its own `~/.codex/config.toml`; a Relay-spawned headless Codex
  on a ChatGPT OAuth login triggers server-side token revocation and cannot be
  fixed Relay-side.
- Retired the dead `:9099` Python-bridge route: `forgeRelay.subagentBridgeUrl`
  now defaults to empty, the `bridge:` prefix is opt-in, and the default
  fallback backend is Ollama.
- Worker numbering now resets to 1 once a dispatch batch fully drains, while
  staying monotonic within overlapping batches.
- Claude Mode B keep-alive pings are capped, and per-turn token/cost telemetry
  is captured to `.coordination/claude-telemetry.ndjson`.
- Hardened the worker system prompt (non-empty guarantee, draft/clanker
  capability line) with dedicated tests.

## 0.3.15

- New setting `forgeRelay.claudeKeepAliveMs` (0 = off) — opt-in prompt-cache
  keep-alive ping for the Claude Mode B bridge.
- New setting `forgeRelay.subagentDefaultMode` (`sync` | `async`) — default
  dispatch mode for `dispatch_subagent` (async remains available per-call).
- Removed a temporary startup diagnostic from the MCP stdio server.

## 0.3.13

- Fixed VSIX packaging that omitted `scripts/bridgeLog.js`, which crashed the
  Claude bridge on spawn in installed (non-dev) copies.
- Async worker dispatch via `mode: "async"` on `dispatch_subagent`.

## 0.3.9 – 0.3.12

- Codex moved to a single-process MCP-only configuration to avoid ChatGPT
  OAuth token rotation conflicts; the Connect modal defaults to Claude-only.
- Claude Mode B headless bridge: orchestrator turns driven by board events.
- MCP stdio server logs every tool call to `.coordination/mcpstdio.log`.

## 0.3.6 – 0.3.7

- Forge routing: batch-level model hold (one `/ensure`/`/release` per batch)
  and transient-error retry with backoff.
- Mode A self-heal: starting a Claude orchestrator maintains the `forgerelay`
  entry in the workspace `.mcp.json`.

## 0.3.0 – 0.3.5

- Fixed cross-window port collisions: dynamic port search, correct port on
  MCP retry, per-workspace board routing for bridges.
- `list_models` tool with merged Forge-first catalog and pre-dispatch
  validation; worker self-claims; worker context/token usage on the board.
- Opt-in Forge model-control route for worker dispatch.
- Rebranded AgentWatch → Forge Relay; license changed MIT → Apache-2.0.

## 0.1.0

- Initial release (as AgentWatch): shared coordination board for multiple
  coding agents — file claims with TTL, append-only event feed, STOP/PAUSE
  operator commands, VS Code sidebar + tab panels, MCP server on :7878,
  local subagent dispatch (`dispatch_subagent`) with draft/clanker autonomy.
