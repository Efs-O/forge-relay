# Isolated subscription-managed Codex runtime plan

**Date:** 2026-07-17

**Branch:** `feat/managed-codex-relay`

**Status:** Installed R3 managed subscription runtime and independent Codex
worker acceptance pass. Do not merge to `main` until second-workspace,
STOP/restart, and token-refresh/soak gates pass.

## 1. Correction to the 0.7.0 prototype

The 0.7.0 prototype proved process, workspace, SQLite, lease, and MCP-routing
isolation, but selected an OpenAI Platform API key as the supported managed
credential. That changes the billing model and does not satisfy the product
goal. It is rejected as the final architecture.

The corrected experiment must:

- use ChatGPT-managed Codex authentication and subscription limits;
- never require, request, inherit, or fall back to a Platform API key;
- keep the ordinary OpenAI sidebar and CLI profiles untouched;
- retain the isolation and process-ownership improvements proven in 0.7.0;
- remain experimental until concurrent token refresh is observed safely.

## 2. Product outcome

Forge Relay supports two distinct Codex paths:

1. **Existing Codex session / MCP:** Forge Relay does not own or wake Codex.
   The user's IDE or CLI session calls Forge Relay MCP tools. This remains the
   default and stable path.
2. **Isolated subscription-managed Codex:** Forge Relay owns a standalone
   `codex app-server --listen stdio://`, one persistent thread, and one
   workspace-specific local profile authenticated through Codex's official
   ChatGPT browser OAuth flow.

Target topology:

```text
VS Code workspace A
|- OpenAI Codex sidebar PID (ordinary OpenAI-owned profile)
`- Forge Relay Codex PID A
   |- isolated CODEX_HOME A (ChatGPT-managed OAuth)
   |- isolated CODEX_SQLITE_HOME A
   `- workspace-A Forge Relay MCP binding

VS Code workspace B
|- optional OpenAI Codex sidebar PID
`- Forge Relay Codex PID B
   |- isolated CODEX_HOME B (ChatGPT-managed OAuth)
   |- isolated CODEX_SQLITE_HOME B
   `- workspace-B Forge Relay MCP binding

Terminal
`- independent Codex CLI session
```

The processes may use the same ChatGPT account and Codex subscription, but do
not share local auth files, SQLite databases, stdio, threads, session history,
leases, or workspace routing. Subscription quota and rate limits remain shared
at the account/workspace level.

Process isolation does not prevent two agents from editing the same files.
Forge Relay claims or separate Git worktrees are still required for concurrent
work in one repository.

## 3. Authentication contract

### 3.1 Supported path: app-server-managed ChatGPT OAuth

Current Codex app-server documentation exposes this stable auth sequence:

```text
initialize
initialized
account/read { refreshToken: false }
account/login/start { type: "chatgpt" }
open returned authUrl in the browser
wait for account/login/completed
account/read -> account.type == "chatgpt"
```

Codex owns the browser callback, token persistence, and token refresh. Forge
Relay sees the login ID, approved OpenAI URL, completion status, auth mode, and
optional plan type; it never receives or parses access or refresh tokens.

Rules:

- Force `forced_login_method="chatgpt"` for login and managed runtime.
- Force file-backed credentials inside the isolated `CODEX_HOME`; never use a
  shared operating-system keyring entry.
- Remove `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` from the
  child environment so they cannot silently replace subscription auth.
- Accept a managed start only when `account/read` reports `type: "chatgpt"`.
- Reject API-key, access-token, missing, or unknown auth modes with an
  actionable ChatGPT sign-in message.
- Allow browser URLs only on HTTPS OpenAI/ChatGPT hosts.
- Never copy, read, display, log, or mutate the ordinary `~/.codex/auth.json`.
- Never put credentials in VS Code settings, `config.yaml`, repository files,
  command arguments, logs, status text, or telemetry.

### 3.2 Explicit non-goals and fallback policy

- Platform API-key billing is not an acceptable fallback.
- Business/Enterprise Codex access tokens are not the consumer subscription
  path and are not part of this experiment.
- Copying the ordinary sidebar credential into an isolated home is prohibited.
- Sharing the sidebar's default `CODEX_HOME` is prohibited.
- If current ChatGPT OAuth cannot survive the required concurrency/refresh
  acceptance, managed subscription mode does not ship. The fallback is the
  existing-session MCP mode until OpenAI provides an attachable existing
  app-server or another supported subscription automation surface.

## 4. Current upstream evidence and unresolved risk

The current official `openai/codex` app-server documentation:

- calls ChatGPT-managed auth the recommended mode;
- supports `account/login/start` with `type: "chatgpt"` or
  `chatgptDeviceCode`;
- reports `planType` for Plus, Pro, Business, and Enterprise logins;
- states Codex persists and automatically refreshes the tokens;
- identifies app-server as the integration surface used by rich clients such
  as the VS Code extension.

Historical Forge Relay runs and open Codex issues observed
`refresh_token_reused` / `token_invalidated`. A current OpenAI collaborator has
stated that server-side replay tolerance mitigates ordinary concurrent refresh
races, while also acknowledging that occasional refresh-reuse reports still
exist. Therefore process startup success is insufficient: a real concurrent
refresh/soak test remains a merge gate.

## 5. Isolated profile layout

Forge Relay derives an upgrade-stable fingerprint from the normalized
workspace root, local/remote authority, and platform user identity.

```text
<extension-global-storage>/managed-codex/profiles/<fingerprint>/
|- home/
`- sqlite/
```

The login and managed app-server receive:

```text
CODEX_HOME=<profile>/home
CODEX_SQLITE_HOME=<profile>/sqlite
-c sqlite_home="<profile>/sqlite"
-c cli_auth_credentials_store="file"
-c forced_login_method="chatgpt"
```

Command-line overrides prevent project `.codex/config.toml` from redirecting
credentials or SQLite state into shared storage.

Requirements:

- paths remain outside the repository, ordinary Codex home, and VS Code install;
- symlink-resolved paths are checked after creation;
- same workspace resolves to the same profile across reloads;
- different workspaces resolve to different profiles;
- no credential or state file is copied between profiles.

## 6. Runtime ownership and coexistence

### Relay ownership lease

The atomic machine-local lease is keyed to the isolated managed profile. It:

- blocks only a second Forge Relay owner of the exact same profile;
- allows different workspace profiles concurrently;
- recovers stale ownership without killing unrelated processes;
- records operational metadata and non-secret fingerprints only;
- never takes over a live owner.

### External Codex processes

External app-server discovery remains diagnostic only. Forge Relay reports
redacted PIDs, never blocks because another Codex process exists, and never
offers bulk termination.

### Worker lane

Short-lived Relay `codex exec` workers remain serialized with one another. The
isolated managed runtime does not acquire that lifetime semaphore. Subscription
acceptance must prove whether a normal CLI/worker can coexist safely; if it
cannot, worker dispatch must be disabled or deferred while managed mode runs.

## 7. Components retained, replaced, and removed

Retain:

- shell-free Codex executable resolution;
- private stdio JSON-RPC transport and owned-child tree shutdown;
- persistent thread, ordered event turns, STOP/PAUSE, approval denial, bounded
  recovery, and fallback board posting;
- workspace-specific Forge Relay MCP injection;
- deterministic profile resolver and profile ownership lease;
- diagnostics-only external PID discovery;
- existing-session MCP and serialized worker paths;
- coordination-directory VS Code-install guards.

Replace:

- API-key subprocess provisioning with app-server ChatGPT browser OAuth;
- API billing/setup copy with subscription login and quota copy;
- generic authenticated-account acceptance with strict `chatgpt` mode checking;
- 0.7.0 package identity with a corrected experimental version.

Remove:

- API-key input UI and all `codex login --with-api-key` production code/tests;
- Platform billing claims and API-key acceptance instructions;
- inherited API/access-token environment overrides;
- stale comments saying managed mode holds the worker semaphore;
- external PID startup blocking and instructions to close other Codex clients;
- arbitrary `codexManagedHome` and normal-home fallback.

Persisted `managed-exclusive` values continue to migrate to
`managed-isolated`; missing or unknown values remain MCP mode.

## 8. Commands and UI

Command:

**Forge Relay: Sign In Isolated Codex with ChatGPT**

Behavior:

1. Resolve/create the isolated workspace profile.
2. Start a temporary shell-free app-server using the isolated environment.
3. Initialize and inspect existing auth.
4. If already `chatgpt`, report the plan without opening a browser.
5. Otherwise start the official ChatGPT login RPC.
6. Validate and open the returned OpenAI/ChatGPT HTTPS URL.
7. Wait with a bounded timeout for the matching completion notification.
8. Re-read the account and require `type: "chatgpt"`.
9. Close the temporary app-server and report only bounded non-secret status.

The command remains available directly. In 0.8.1, starting an unauthenticated
managed session from either Forge Relay webview offers this login flow and
retries the requested session once after successful authentication. Cancelling
login leaves the session stopped; unrelated startup errors do not open auth UI.

Connect choices remain:

- **Use my existing Codex session (recommended)**
- **Run isolated managed Codex (experimental)**

The confirmation explains that another isolated PID starts, existing clients
remain active, and usage follows the ChatGPT Codex subscription and limits.

## 9. Automated validation

Required:

```powershell
npm run typecheck
npm test
npm run build
npx --yes @vscode/vsce package --no-dependencies --out <experimental-vsix>
```

Tests must prove:

- stable/distinct safe profile resolution;
- forced ChatGPT/file/SQLite overrides;
- removal of API/access-token environment variables;
- browser auth request shape, notification correlation, URL allowlist,
  cancellation, timeout, existing-login fast path, and final account check;
- managed startup rejects `apiKey`, `personalAccessToken`, missing, and unknown
  modes and accepts only `chatgpt`;
- different profiles coexist while same-profile ownership is rejected;
- external process discovery is informational;
- mode migration, event ordering, STOP, approval denial, recovery, transport
  framing, and MCP routing remain green;
- package contains runtime bundles and no source tests or credentials.

## 10. Live Windows acceptance

1. Keep the ordinary OpenAI Codex sidebar signed in and active.
2. **Passed 2026-07-17:** sign the isolated workspace profile in through the
   new ChatGPT command.
3. Confirm `account/read` reports `chatgpt` and the expected plan type.
4. **Passed 2026-07-17 on 0.8.2:** start managed Codex and complete a real
   board-event turn/MCP post.
5. **Passed 2026-07-17 on installed R3:** an independent subscription-backed
   synchronous worker and durable asynchronous worker completed while managed
   Codex remained connected.
6. Sign in and start a second workspace profile concurrently.
7. Confirm all external PIDs remain alive and each managed profile routes only
   to its own workspace board.
8. STOP/PAUSE one managed runtime; unrelated Codex clients must survive.
9. Reload/crash/restart; confirm no orphan, stale lease, or SQLite lock.
10. Keep sidebar and managed processes active across an actual token refresh
    window or an explicit safe refresh probe, then complete turns in both.
11. Inspect logs for `refresh_token_reused`, `token_invalidated`, 401 loops,
    cross-workspace routing, protocol mismatch, or token/URL leakage.

Do not deliberately copy or force-refresh the ordinary sidebar credential.
Refresh validation must use each client's own supported auth path.

## 11. Merge decision

Do not merge merely because unit tests, startup, or one model turn pass.

Merge readiness requires:

- all automated/build/package gates pass;
- installed VSIX subscription login and real board turns pass;
- sidebar, managed runtime, CLI/worker, and two workspace profiles coexist;
- refresh/soak produces no auth invalidation in any client;
- no external process is blocked or killed;
- disabling/removing the experimental VSIX leaves stable MCP behavior intact;
- the operator reviews the evidence and explicitly approves the merge.

If the refresh gate fails, do not add an API-key fallback. Disable managed
subscription mode and retain existing-session MCP pending upstream support.

## 12. Evidence ledger

### Retained evidence from the rejected 0.7.0 prototype

These results remain valid for non-authentication architecture:

- TypeScript and 181-test baseline passed.
- Production build, VSIX inspection, and disposable VS Code activation passed.
- Isolated stdio initialize/account-read passed against `codex-cli 0.144.4`.
- One existing app-server plus two isolated disposable app-servers coexisted
  (`1 -> 3 -> 1`) and the existing PID survived.
- Ordinary `~/.codex/auth.json` was unchanged by disposable profile tests.

The 0.7.0 API-key login smoke proves only path isolation and is not evidence
that the subscription requirement is met.

### Corrected evidence completed on 2026-07-17

- TypeScript, all 184 automated tests, and the production build passed.
- A live isolated app-server on `codex-cli 0.144.4` successfully returned a
  valid official ChatGPT login response and accepted cancellation while two
  existing app-server processes stayed alive. The auth URL was not logged.
- `forge-relay-subscription-codex-experimental-0.8.0.vsix` was inspected and
  installed as `efsoo.forge-relay@0.8.0`. SHA-256:
  `be0dd26f7f27594f703aa6c9b78386e00c54bcaba0b296ad728d3bce52833591`.
- The 0.8.1 automatic sign-in recovery passes all 188 tests and the production
  build. Its inspected VSIX is installed as `efsoo.forge-relay@0.8.1` with
  SHA-256 `7a190816652c44bde0be2f8f47d9a1e93ad36f78928052d1bac639a2d6c5e7d0`.
- The first authenticated 0.8.1 board-turn attempt exposed a Codex 0.144.4
  protocol mismatch rather than a login or process-isolation failure. Codex
  sent `mcpServer/elicitation/request` before its Forge Relay MCP tool call;
  the bridge treated that method as unsupported, and Codex recorded the tool
  decision as declined. Version 0.8.2 handles the exact current-turn Forge
  Relay MCP elicitation while continuing to deny all broader approvals.
- The 0.8.2 approval-boundary regression passes all 191 tests, TypeScript, and
  the production build. The inspected VSIX is installed as
  `efsoo.forge-relay@0.8.2`; SHA-256:
  `5fc03484e06c4123308f3dca9d8b1a00d3aa1ca7abd27c255060b6f7db6e6320`.
- After the operator completed isolated ChatGPT sign-in and reloaded VS Code,
  managed Codex received a user-authored board post and posted a reply through
  Forge Relay. This validates the installed 0.8.2 board-event, app-server,
  elicitation-approval, MCP, and reply path while the existing Codex session
  remained usable.
- A follow-up post authored as `codex` did not trigger another managed Codex
  reply. This is expected: the shared event filter suppresses self-authored
  events to prevent an infinite `codex -> codex` feedback loop. Use a `user` or
  different-agent post for future connectivity acceptance.
- Installed R3 (`forge-relay-subscription-codex-experimental-0.8.2-batch-fixes-r3.vsix`,
  SHA-256 `9DBDECD30315334F01E75EBAD8757EAA07BED71668296AA3A319DFA212BAA95E`)
  passed the native startup gate and a real claimed write/read-back/release at
  `docs/managed-clanker-write-smoke.md`. Board task lifecycle, the 49-model
  Forge catalog, synchronous worker, durable asynchronous worker, and
  fail-closed unconfigured build also passed with no leaked board state.
- The worker catalog reported `codex-cli 0.144.2`, while earlier terminal and
  managed diagnostics reported `0.144.4`. Both live paths passed, but the
  client-specific PATH/version skew should be normalized or documented.
- After merging current `main`, candidate
  `forge-relay-subscription-codex-experimental-0.8.3-rc1.vsix` passed TypeScript,
  all 219 tests, the production build, and archive inspection. It contains the
  required runtime bundles and no source, tests, documentation, coordination
  state, maps, or credential files. It is installed as
  `efsoo.forge-relay@0.8.3`; SHA-256:
  `572DD52FE304167B9230799589538306A2BF0365992990B7C088AE9A14B07346`.
- After a VS Code reload, the exact 0.8.3 candidate passed the managed native
  create/update/read/delete startup gate, active Forge Relay MCP elicitation,
  board claim/release, 49-model Forge catalog, synchronous subscription-backed
  Codex worker with the expected 0.8.3 marker, durable asynchronous worker, and
  clean board-state checks. The managed app-server remained alive and handled
  different-agent board events while both workers completed.

### Corrected evidence still required before merge

- Record the returned subscription plan type explicitly; successful managed
  startup already proves the enforced `account.type == "chatgpt"` check passed.
- Second-workspace concurrency.
- STOP/restart isolation.
- Token refresh/soak with no invalidation.

### Next-session resume point

Start from installed 0.8.3-rc1 and its successful managed-write plus sync/async
worker evidence. Do not rework login, PID isolation, permission encoding,
executable discovery, or MCP elicitation unless new evidence regresses those
paths. Continue with second-workspace concurrency, STOP/restart isolation, then
token-refresh soak. Separately normalize or document the worker `0.144.2` versus
managed/terminal `0.144.4` resolution. Keep board mode off in a new session
unless the operator explicitly activates it there.
