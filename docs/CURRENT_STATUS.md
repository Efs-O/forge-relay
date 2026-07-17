# Forge Relay — Current Status

Last refreshed: 2026-07-17

## In development

The `feat/managed-codex-relay` branch is replacing the opt-in
managed-exclusive coordinator with a managed-isolated Codex runtime. MCP-only
remains the default. The isolated mode owns a standalone app-server, persistent
thread, workspace-specific `CODEX_HOME` and `CODEX_SQLITE_HOME`, and a profile
ownership lease. The corrected 0.8.x design uses Codex app-server's official
ChatGPT browser OAuth flow and subscription limits. It forces ChatGPT/file
authentication, strips inherited API/access-token credentials, and does not
read or copy the user's ordinary Codex credentials.

Existing Codex IDE, desktop, CLI, and other-workspace app-server processes are
allowed to remain active. Process discovery is diagnostic only; Forge Relay
neither blocks on nor terminates external Codex PIDs. The advanced
`forgeRelay.codexManagedProfileRoot` setting may relocate the profile root, but
Forge Relay still appends a deterministic workspace fingerprint.

The 0.7.0 prototype's process/SQLite/lease isolation passed 181 tests, package
inspection, disposable VS Code activation, and a live Windows `1 -> 3 -> 1`
app-server coexistence smoke. Its Platform API-key authentication is rejected
as the final product because subscription usage is required. The corrected
0.8.0 package passes typecheck, all 184 tests, production build, VSIX inspection,
installation, and a live unauthenticated ChatGPT login-start/cancel smoke against
`codex-cli 0.144.4` without disturbing two existing app-servers. It is not ready
to merge until browser subscription sign-in and the installed board-event,
CLI/worker, multi-workspace, STOP/restart, and token refresh/soak acceptance pass.

Version 0.8.1 improved the startup UI, but its first authenticated board turn
exposed an unhandled Codex 0.144.4 `mcpServer/elicitation/request`. Version
0.8.2 now accepts only the exact active-thread/active-turn Forge Relay MCP tool
elicitation and continues to deny broader command, file, stale-turn, malformed,
and unrelated app-server requests. TypeScript, all 191 tests, the production
build, VSIX inspection, and installation passed. Commit `19f8695` contains the
fix; installed artifact SHA-256 is
`5fc03484e06c4123308f3dca9d8b1a00d3aa1ca7abd27c255060b6f7db6e6320`.

Live acceptance now confirms that the isolated ChatGPT-authenticated 0.8.2
runtime starts, receives a user board event, and posts a Codex reply while the
operator's existing Codex session remains active. A later `codex`-authored
connectivity post correctly produced no managed reply because self-authored
events are intentionally filtered to prevent feedback loops. Basic managed
subscription coordination is therefore working. R3 subsequently proved an
independent subscription-backed Codex worker can run while the managed runtime
remains connected. Merge remains gated on second-workspace concurrency,
STOP/restart isolation, and token-refresh/soak checks described in the
isolated-runtime plan.

The Forge-only pipeline findings were remediated in this repository on
2026-07-17. Managed Codex now validates canonical runtime workspace roots and
uses a Relay-owned Clanker profile with global reads, workspace-only writes,
protected repository metadata, no network, and the Windows `unelevated`
sandbox. A deterministic native create/update/read/delete gate runs before the
runtime is declared ready or a Clanker turn begins. Standalone Codex MCP
auto-discovers Forge control, and explicit Codex setup installs the full safe
tool approval set including `release`. The batch-fix VSIX is installed at
`forge-relay-subscription-codex-experimental-0.8.2-batch-fixes-r3.vsix` (SHA-256
`9DBDECD30315334F01E75EBAD8757EAA07BED71668296AA3A319DFA212BAA95E`). R2 fixed
Codex 0.144.4's required `default_permissions` selector and flattened CLI
encoding for special filesystem keys; the exact generated arguments pass a
real app-server startup smoke. R3 adds shell-free discovery of the standard
per-user npm Codex entry when VS Code's extension-host `PATH` omits npm shims.
Installed R3 live acceptance passed on 2026-07-17: native readiness gate,
user-to-managed board event, claimed canonical workspace write and exact
read-back, claim release, complete task lifecycle, 49-model Forge catalog,
synchronous Codex worker, durable asynchronous Codex worker, and fail-closed
unconfigured build. No claims, commands, or open tasks leaked. The worker route
reported `codex-cli 0.144.2` while terminal/managed diagnostics had reported
`0.144.4`; this non-blocking PATH/version skew remains a follow-up.
Worker execution now has
explicit platform context, mutation-time claim authorization, exhaustive
terminal states, cumulative budgets, loop detection, durable async receipts,
safe Git guidance, and richer Forge routing/availability validation. TypeScript
and all 219 automated tests pass. The repo-only implementation and remaining
installed/upstream gates are recorded in
`docs/FORGE_RELAY_PIPELINE_REMEDIATION_PLAN_2026-07-17.md`.

Candidate 0.8.3-rc1 was built after merging the latest `main` into the feature
branch. The merged tree passes TypeScript, all 219 tests, the production build,
and VSIX inspection. The archive is installed as `efsoo.forge-relay@0.8.3` and
has SHA-256
`572DD52FE304167B9230799589538306A2BF0365992990B7C088AE9A14B07346`.
After reloading, exact-artifact acceptance confirmed the Relay-owned managed
app-server, canonical native create/update/read/delete startup gate, active MCP
tool elicitation path, board claim/release, 49-model Forge catalog, synchronous
Codex worker with the expected 0.8.3 marker, durable asynchronous worker, and a
clean final board. The managed runtime remained alive while both workers ran
and processed different-agent board events. A second authenticated 0.8.3
managed runtime then started concurrently for Gemma4GR with a distinct profile,
SQLite store, and process chain. Its `GEMMA4GR_ROUTE_PASSED` response appeared
only on that workspace board. An operator STOP targeting all was acknowledged
and resolved without killing either managed chain or leaking board state, and
forge-relay resumed a fresh different-agent MCP turn afterward. Remaining merge
gates are a post-concurrency reload/crash recovery check, explicit plan-type
record, and token-refresh soak.

## Published

`Efsoo.forge-relay` version 0.5.1 is published on the VS Code Marketplace.
The repository `main` branch includes the following completed roadmap work:

- FR-1: hierarchical file/folder claim conflicts
- FR-2: push-based board updates with a polling backstop
- FR-3: the configured `run_build` coordination wrapper
- FR-5: persistent task cards, lifecycle validation, and MCP task tools
- FR-6: Marketplace publication

The Marketplace remains on 0.5.1.

## Stable 0.5.2 candidate

`main` now contains the Gemma/llama.cpp worker reasoning-overflow fix and a
test-runner cleanup that prevents stale bundles surviving branch switches.
Commit `3019566` packages this as `forge-relay-0.5.2.vsix`; it passed
type-checking, the production build, all 129 tests on `main`, VSIX inspection,
and a live Gemma 4 26B completion with thinking disabled. Marketplace
publication is still pending.

## Managed Codex experiment

The exclusive managed-Codex prototype remains separate on
`feat/managed-codex-relay`. Commit `0a2f4b8` packages it as the local-only
`forge-relay-managed-codex-experimental-0.6.0.vsix`. It includes the 0.5.2
fixes and passed type-checking, production build, all 171 feature-branch tests,
and VSIX inspection. It is opt-in, fails closed around shared ownership, and is
not part of stable `main` or the Marketplace release.

## Deferred

- FR-4: Markdown session snapshots. This is intentionally out of scope until
  it is explicitly resumed.

## Separate Follow-ups

These are not blockers for the released FR roadmap:

- `docs/BOARD_UI_OBSERVATIONS_PLAN.md` contains optional UI polish items.
- `docs/TODO-forge-concurrency-hardening.md` records a Forge-route hardening
  follow-up.
- `FORGE_COORDINATOR_PLAN.md` retains manual-soak and review gates for the
  Forge coordinator experiment.

For the currently approved scope, implementation is complete.
