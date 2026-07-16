# Codex managed relay reassessment (2026-07-14)

## Executive conclusion

The findings are materially different from the June/July 2026 conclusion in this repository, but they are **not an unconditional all-clear**.

Current Codex now has official programmatic surfaces suitable for rebuilding a managed, event-driven Forge Relay participant:

- `codex app-server` is the documented deep-integration interface used by the Codex VS Code extension. Its stable stdio protocol supports starting/resuming threads, starting/steering/interrupting turns, approvals, streamed events, and MCP-backed tools.
- OpenAI now publishes TypeScript and Python Codex SDKs.
- `codex mcp-server` is documented as a long-running MCP server exposing `codex` and `codex-reply` tools.
- ChatGPT login is explicitly supported by the CLI/app-server, while API-key login remains available for separately billed automation. Enterprise users can also use Codex access tokens for trusted non-interactive automation.

Therefore the old statement that Codex has no supported headless/programmatic path is obsolete. A managed Codex relay is technically supportable now.

However, Forge Relay still should **not claim that a second long-lived Codex process is always safe beside the Codex IDE/desktop process when both share the same ChatGPT login and `CODEX_HOME`**. Current upstream evidence does not establish that guarantee, Windows still has multi-app-server state-locking reports, and the installed Codex CLI's singleton daemon lifecycle is Unix-only. The safe product conclusion is:

> Add managed Codex only as an opt-in, Relay-owned exclusive runtime (or with isolated API-key/enterprise-token credentials). Keep the existing MCP-only mode as the default. Do not revive the old WebSocket bridge unchanged and do not advertise simultaneous shared-ChatGPT-auth app-servers as guaranteed safe.

## Implementation update (2026-07-16)

The recommended exclusive prototype has now been implemented separately on
`feat/managed-codex-relay`. Release commit `0a2f4b8` produces
`forge-relay-managed-codex-experimental-0.6.0.vsix` and includes the stable
0.5.2 worker fixes. The feature remains opt-in and fails closed using an
external-process probe, credential-home lease, shared Codex execution gate,
approval denial, bounded recovery, and independent STOP/PAUSE interruption.

Validation passed TypeScript type-checking, the production build, VSIX content
inspection, and all 171 feature-branch tests. This is a prototype milestone,
not an all-clear: it has not been merged into stable `main`, published to the
Marketplace, or completed the token-refresh/IDE-coexistence soak gates below.

## What the repository currently assumes

The current code intentionally supports two Codex shapes:

1. An existing interactive Codex session joins the Forge Relay board through the `forgerelay` MCP entry in `~/.codex/config.toml`.
2. `dispatch_subagent` may run serialized, short-lived `codex exec` workers.

The managed bridge was removed in commit `6f3d042` after the project observed `refresh_token_reused` / `token_revoked` failures. That decision is still encoded in:

- `src/runtimeManager.ts`: Codex is never spawned as a managed runtime.
- `src/types.ts` and `src/webviewContent.ts`: Codex is described as joining through its own MCP session.
- `src/codexWorker.ts` and `docs/NOTE-codex-concurrency-guard.md`: short-lived `codex exec` dispatches are serialized because of the historical shared-login risk.
- Git history: `scripts/codex-auto-bridge.js` used a Relay-spawned `codex app-server` over WebSocket and injected the workspace-specific Forge Relay MCP configuration.

The old removal was reasonable for the Codex version and failures observed at the time. The part that is now outdated is the categorical wording that there is no supported Relay-side/programmatic solution.

## What has changed upstream

### 1. App-server is now a documented integration surface

OpenAI documents app-server as the interface for rich clients and provides a complete thread/turn protocol. For this project, the important stable operations are `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, streamed item notifications, approval requests, and account/rate-limit reads.

This directly matches the old `codex-auto-bridge.js` job: keep one Codex thread alive, forward relevant board events as turns, and let the thread call Forge Relay MCP tools.

Source: [Codex App Server documentation](https://developers.openai.com/codex/app-server/)

### 2. Supported programmatic alternatives now exist

OpenAI now documents the Codex SDK for controlling Codex threads from applications and `codex mcp-server` for exposing Codex to an MCP orchestrator. This means Forge Relay no longer needs to depend on an undocumented reverse-engineered control route.

Sources: [Codex SDK](https://developers.openai.com/codex/sdk/), [Codex as an MCP server](https://developers.openai.com/codex/guides/agents-sdk/)

### 3. Authentication guidance is clearer

The current authentication documentation says the desktop app, CLI, and IDE extension cache and reuse login state; ChatGPT sessions refresh automatically; API-key auth is recommended for programmatic automation; and Enterprise can issue Codex access tokens for trusted non-interactive workflows.

This is different from saying that any second process is forbidden by the API. In an upstream concurrent-app-server report, an OpenAI collaborator stated that the server permits limited replay of a rotated refresh token specifically to tolerate races and network failures. That makes the repository's absolute statement that two app-servers necessarily revoke both sessions too strong.

Sources: [Codex authentication](https://developers.openai.com/codex/auth/), [OpenAI collaborator response on concurrent refresh behavior](https://github.com/openai/codex/issues/10332)

## What has not changed enough for an all-clear

### 1. There is no published guarantee for concurrent shared-login app-servers

The authentication docs explain shared cached credentials and automatic refresh, but do not promise that independently managed long-lived app-server processes sharing one `auth.json` and state directory are conflict-free.

The upstream issue about concurrent refresh races was closed as not planned because the server-side replay window should mitigate the simple race, not because multi-process safety was formally guaranteed. The same collaborator acknowledged that refresh-token-reused reports still existed. A later attempt to serialize managed ChatGPT token refreshes ([PR #24663](https://github.com/openai/codex/pull/24663)) was closed without merge.

### 2. Current auth and recovery failures still exist

There are current upstream reports of `refresh_token_reused` / invalidated-token recovery failures in Codex clients. These do not prove every multi-process launch will fail, but they are enough to reject a product promise of zero risk.

Source: [open refresh-token recovery issue #19803](https://github.com/openai/codex/issues/19803)

### 3. Windows has an additional shared-state collision

An open Windows report shows the VS Code extension's app-server holding shared SQLite files while the desktop client tries to open the same Codex state. This is separate from OAuth and is another reason not to start a second app-server in the same `CODEX_HOME` by default.

Source: [Windows app-server SQLite locking issue #21782](https://github.com/openai/codex/issues/21782)

### 4. The safest single-daemon path is not portable here

Codex 0.144.4 includes `codex app-server daemon` and a proxy/control-socket design, which is promising because several clients can target one owner process rather than race as separate owners. On this Windows development machine, however, the CLI returns:

```text
Error: codex app-server daemon lifecycle is only supported on Unix platforms
```

The local CLI does support `codex app-server --listen ws://...` and `codex --remote`, but the official documentation labels WebSocket transport experimental and unsupported. The old Forge Relay bridge used exactly that WebSocket route, so it should not simply be restored.

### 5. `codex mcp-server` does not by itself solve shared ChatGPT auth

The official MCP orchestration guide demonstrates a long-running Codex MCP server and asks for an OpenAI API key. Running the same server with cached ChatGPT credentials would still create another Codex process and would need the same lifecycle/auth isolation analysis. It is a useful control protocol, not an automatic credential-safety fix.

## Deployment decision matrix

| Proposed mode | Current assessment | Reason |
|---|---|---|
| Existing interactive Codex joins Forge Relay through `forgerelay` MCP | Safe default; keep | No Relay-owned Codex process and already implemented |
| Relay-owned app-server, while other Codex app-servers are stopped | Reasonable opt-in | One long-lived Codex owner; uses documented app-server stdio protocol |
| Relay-owned app-server plus IDE/desktop app-server, same ChatGPT login and `CODEX_HOME` | Do not claim safe | No formal concurrency guarantee; auth recovery and Windows SQLite risks remain |
| Relay-owned app-server with a dedicated API key and isolated `CODEX_HOME` | Supported, but separately billed | Avoids ChatGPT refresh-token sharing; API usage is billed at Platform rates |
| Relay-owned app-server with a dedicated Enterprise Codex access token and isolated state | Supported candidate for Enterprise | Official trusted-automation credential; requires Enterprise permission and operational token rotation |
| Shared Unix app-server daemon with clients attaching through its control socket | Best future direction on Unix | Single owner avoids duplicate app-server state, but Windows daemon lifecycle is currently unavailable |
| Restore the historical WebSocket bridge unchanged | No | WebSocket app-server transport remains experimental/unsupported and the old process/auth assumptions remain |

## Recommended Forge Relay design

### Phase 1: managed Codex, exclusive and opt-in

Add a second Codex connection choice alongside the current MCP-only option:

- **Codex through existing session (default):** current behavior.
- **Managed Codex, exclusive (experimental):** Forge Relay owns one app-server and warns that the Codex IDE/desktop session must not be used concurrently with the same state directory.

Implementation constraints:

1. Use app-server over **stdio**, not WebSocket.
2. Generate protocol bindings from the installed CLI (`codex app-server generate-ts`) or keep a small version-negotiated JSON-RPC client. App-server schemas are version-specific.
3. Launch exactly one Relay-owned Codex runtime per machine/credential-state lane, protected by the existing machine-wide runtime lease pattern. A per-board lease alone is insufficient if two workspaces share one `CODEX_HOME`.
4. Preflight for other `codex app-server` processes. If a non-Relay owner is present, refuse managed mode and direct the user to MCP-only mode. Process detection is a guardrail, not a proof, so failure must be conservative.
5. Keep a persistent Codex thread and forward board events with `turn/start`; use `turn/steer` only for a genuinely active turn and `turn/interrupt` for STOP/PAUSE.
6. Inject the workspace-specific `forgerelay` MCP server at launch, preserving the current coordination-directory safety guard and current `--repoRoot` binding.
7. Surface typed auth failures and stop restart loops. Prompt the user to reauthenticate instead of repeatedly refreshing a revoked token.
8. Keep current sandbox/autonomy mapping. Do not pass sandbox bypass flags.
9. Keep the existing serialized `codex exec` guard until a separate concurrency soak proves it unnecessary.

### Phase 2: isolated credentials/state

Offer dedicated managed-runtime configuration:

- `forgeRelay.codexManagedHome` (a separate `CODEX_HOME`)
- credential mode: API key, Enterprise access token, or explicitly authenticated ChatGPT session
- a setup/verify flow that checks auth without reading or logging secret material

Never copy `~/.codex/auth.json` automatically. A dedicated ChatGPT login may reduce local file/state collisions, but it should remain experimental until it survives a token-refresh soak; separate local state alone is not proof against account-level token invalidation.

### Phase 3: shared daemon when portable and supported

Prefer a single Codex daemon with multiple client attachments once daemon lifecycle and a supported transport are available on Windows and documented for third-party clients. That architecture most closely matches the desired Claude-style always-on relay without duplicate credential owners.

## Required validation before changing the default

A short happy-path test is insufficient because the historical failure appears around credential refresh and long-lived state. Require all of the following:

1. Windows 11 and Unix coverage with the same Codex version Forge Relay declares supported.
2. At least one test spanning an actual ChatGPT token refresh interval, with no copied auth file and no secret logging.
3. Simultaneous-workspace tests proving the machine-wide owner lock suppresses duplicate managed runtimes.
4. IDE/desktop coexistence tests only for modes that the UI claims are supported.
5. App-server restart, thread resume, board truncation/partial-line recovery, STOP/PAUSE, and MCP initialization failure tests.
6. Explicit recovery tests for `refresh_token_reused`, `token_invalidated`, stale SQLite locks, and app-server version/schema mismatch.
7. A feature flag and telemetry limited to status/error categories, never tokens, prompts, or auth files.

## Final verdict

The new findings justify reopening managed Codex work, so this report exists. They do **not** justify restoring the old implementation or removing the repository's safety guards.

The defensible statement for Forge Relay today is:

> Codex can now be integrated as a supported managed runtime through app-server/SDK interfaces. It is safe to prototype and ship as an exclusive, opt-in Relay-owned runtime, or with isolated API-key/Enterprise-token credentials. Concurrent long-lived Codex processes sharing consumer ChatGPT auth and state are still not safe enough to promise, especially on Windows.

## Evidence checked

- Repository history through commit `6f3d042` and the deleted `scripts/codex-auto-bridge.js`.
- Current source: `src/runtimeManager.ts`, `src/runtimeBridge.ts`, `src/codexWorker.ts`, `src/subagentLoop.ts`, `src/types.ts`, and `src/webviewContent.ts`.
- Current local CLI: `codex-cli 0.144.4`, published 2026-07-14.
- Current Codex manual fetched 2026-07-14.
- Current installed CLI help for app-server, daemon, remote-control, and MCP-server.
- Official OpenAI Codex documentation and the upstream OpenAI Codex repository/issues linked above.
