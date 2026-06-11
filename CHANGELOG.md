# Changelog

All notable changes to the Forge Relay extension.

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
