# Isolated managed Codex runtime plan

**Date:** 2026-07-17

**Branch:** `feat/managed-codex-relay`
**Status:** Approved for experimental implementation on this branch; do not merge to `main` until the acceptance gates pass.

## 1. Decision

Replace the current machine-wide **managed-exclusive** Codex policy with a
Relay-owned **managed-isolated** runtime.

The product will support two distinct Codex paths:

1. **Existing Codex session / MCP:** Forge Relay does not own or wake Codex. The
   user's IDE or CLI session can call the Forge Relay MCP tools.
2. **Isolated managed Codex:** Forge Relay owns a standalone
   `codex app-server --listen stdio://` process, one persistent thread, and an
   isolated local state profile for the current workspace.

Other Codex IDE, desktop, CLI, or Relay-managed processes are not startup
conflicts merely because they exist. Forge Relay never kills an external Codex
process. It prevents only duplicate Relay ownership of the same isolated
managed profile.

## 2. Product outcome

The intended simultaneous topology is:

```text
VS Code workspace A
|- OpenAI Codex sidebar PID (OpenAI-owned state/auth)
`- Forge Relay managed Codex PID A
   |- dedicated CODEX_HOME A
   |- dedicated CODEX_SQLITE_HOME A
   `- workspace-A Forge Relay MCP binding

VS Code workspace B
|- optional OpenAI Codex sidebar PID
`- Forge Relay managed Codex PID B
   |- dedicated CODEX_HOME B
   |- dedicated CODEX_SQLITE_HOME B
   `- workspace-B Forge Relay MCP binding

Terminal
`- independent codex CLI task
```

With API-key authentication, these processes may share the same OpenAI API key.
They share billing, quota, and rate limits, but not local app-server ownership,
stdio, threads, SQLite state, session history, or workspace routing.

Process isolation does not prevent two agents from editing the same worktree.
Agents working in one repository must still use Forge Relay claims or separate
Git worktrees.

## 3. Authentication contract

### 3.1 Supported conflict-free path

The first supported managed-isolated authentication path is an OpenAI API key
provisioned by the Codex CLI into the isolated profile:

```text
CODEX_HOME=<isolated-home> codex login --with-api-key
```

Forge Relay will provide an explicit setup command. It may accept the API key
through a password input and pipe it once to `codex login --with-api-key`.

Rules:

- Never place an API key in `config.yaml`, `settings.json`, repository files,
  command-line arguments, output channels, status text, errors, or telemetry.
- Do not copy or read the user's normal `~/.codex/auth.json`.
- Do not mutate the user's normal Codex configuration.
- Do not retain the plaintext key after the login subprocess completes.
- Let Codex own its credential persistence and credential-store policy inside
  the isolated profile.
- API-key requests are billed through the OpenAI Platform account and share its
  rate-limit pool.

### 3.2 Deferred authentication paths

- Enterprise Codex access-token provisioning.
- Consumer ChatGPT login in the isolated profile.
- Shared default `CODEX_HOME` or copied credentials.

Consumer ChatGPT coexistence remains experimental until a run spans an actual
token refresh without `refresh_token_reused`, invalidation, or recovery loops.
It is not required for the API-key architecture to pass.

## 4. Isolated profile layout

Forge Relay derives an upgrade-stable workspace fingerprint from:

- normalized workspace/repository root;
- local versus remote authority;
- platform user identity where available.

Default layout under the extension's stable global storage:

```text
<globalStorage>/managed-codex/profiles/<workspace-fingerprint>/
|- home/
`- sqlite/
```

The managed child receives:

```text
CODEX_HOME=<profile>/home
CODEX_SQLITE_HOME=<profile>/sqlite
```

The app-server and login commands must additionally override `sqlite_home` and
`cli_auth_credentials_store` on their direct argument arrays. Command-line
configuration takes precedence over project `.codex/config.toml`, preventing a
repository from redirecting managed SQLite state or credentials into shared
storage.

Requirements:

- Both directories are outside the repository and VS Code installation.
- Neither path may resolve to the user's normal Codex home.
- The directories are created and validated before login or app-server spawn.
- Different workspaces resolve to different profiles by default.
- The same workspace resolves to the same profile across reloads/upgrades.
- No credentials are copied between profiles.

## 5. Runtime ownership and coexistence

### 5.1 Relay lease

Retain the atomic machine-local runtime lease, but key and describe it as a
Relay-managed **profile ownership** lease rather than a credential-wide Codex
lease.

The lease must:

- reject a second Forge Relay owner of the same managed profile;
- allow different workspace profiles concurrently;
- recover a stale owner without killing unrelated processes;
- record only operational metadata and non-secret fingerprints;
- release only after the owned child is stopped;
- never take over or terminate a live owner.

### 5.2 External process diagnostics

Retain Codex app-server discovery only as diagnostics:

- report detected PIDs without full command lines;
- distinguish `found`, `clear`, and `unknown` inspection outcomes;
- never make discovery success, failure, or unknown status a startup gate;
- never offer automatic bulk termination.

### 5.3 Worker concurrency

Keep `codex exec` worker serialization between Relay-dispatched workers for now.
Remove the managed runtime's lifetime acquisition of that semaphore. An
API-key-authenticated isolated app-server must be able to coexist with an
independent serialized `codex exec` worker lane.

## 6. Components to retain

- `src/codexAppServerClient.ts`: private stdio JSON-RPC transport, framing,
  correlation, timeouts, protocol diagnostics, and owned-child shutdown.
- `src/codexExecutable.ts`: standalone CLI resolution and Windows-safe npm-shim
  handling.
- The core of `src/codexManagedBridge.ts`: persistent thread, event ordering,
  `turn/start`, notification correlation, STOP/PAUSE interruption, approval
  denial, bounded recovery, and fallback posting.
- Launch-time workspace-specific `mcp_servers.forgerelay` injection.
- Existing-session MCP configuration and UI path.
- `codexWorker.ts` and serialized short-lived worker behavior.
- The coordination-directory VS Code installation guard at both existing call
  sites.

## 7. Components to replace or remove

### Replace

- `managed-exclusive` mode with `managed-isolated`.
- Default/fallback managed home resolution with deterministic isolated profile
  resolution.
- Credential-home lease wording and identity with managed-profile ownership.
- The exclusive warning modal with an isolation, API billing, and setup notice.
- Verify Setup's exclusive-process check with profile/auth/process diagnostics.

### Remove from production startup

- External app-server process blocking.
- Unknown process-probe fail-closed behavior.
- Instructions to close the OpenAI IDE/desktop Codex session.
- Managed runtime ownership of `codexExecutionGate`.
- Any fallback to `process.env.CODEX_HOME` or `~/.codex` for managed mode.

### Persisted-state migration

- Normalize saved `managed-exclusive` mode to `managed-isolated`.
- A failed managed start must not persist or auto-retry a rejected roster.
- MCP mode remains the default for missing/unknown saved values.

## 8. Settings and commands

Keep:

- `forgeRelay.experimentalManagedCodex`
- `forgeRelay.codexExecutable`
- `forgeRelay.codexManagedModel`
- `forgeRelay.codexManagedTurnTimeoutMs`

Remove or replace:

- `forgeRelay.codexManagedHome` as an arbitrary full home override. An arbitrary
  path can silently defeat isolation.

Add:

- `Forge Relay: Configure Isolated Managed Codex` command.
- Optional advanced profile-root setting only if it remains a root under which
  Forge Relay always appends the workspace fingerprint.

The setup command must:

1. Resolve/create the isolated profile.
2. Resolve the standalone Codex executable.
3. Accept the API key without displaying or logging it.
4. run `codex login --with-api-key` with the isolated environment;
5. close stdin and clear the in-memory key reference;
6. report only success/failure and profile path;
7. never touch the ordinary Codex profile.

## 9. UI behavior

Codex choices:

- **Use my existing Codex session:** current MCP path.
- **Run isolated managed Codex (experimental):** automatic board participant,
  separate app-server/profile, Platform API billing.

The managed confirmation explains:

- another Codex PID will be created;
- existing IDE/CLI Codex sessions remain running;
- local state is isolated;
- API usage is separately billed and shares account rate limits;
- setup must be completed for this workspace profile.

Errors must offer the setup command when the isolated profile is unauthenticated.

## 10. Implementation phases

### Phase 1 - Profile and authentication foundation

- Add deterministic profile resolver and tests.
- Add API-key login runner and command with dependency-injected tests.
- Pass both isolated environment variables to the app-server child.
- Remove normal-home fallback.

Gate: no secret persistence/logging; same/different workspace identity tests
pass; login subprocess receives the key only through stdin.

### Phase 2 - Runtime coexistence policy

- Remove process probe from bridge startup.
- Convert probe to diagnostics-only discovery.
- Re-key/reword lease as managed-profile ownership.
- Remove managed lifetime execution-gate acquisition.

Gate: external fake app-server does not block; different profiles run
concurrently; same profile rejects duplicate Relay ownership.

### Phase 3 - Mode, UI, persistence, and verification

- Rename mode and migrate saved state.
- Update Connect UI, confirmation, status, Verify Setup, README, changelog, and
  current-status documentation.
- Ensure failure does not persist the requested roster.

Gate: MCP behavior remains unchanged; old saved values migrate; isolated mode
is explicit and accurately described.

### Phase 4 - Automated validation

Required:

```powershell
npm run typecheck
npm test
npm run build
npm exec -- vsce package --no-dependencies --out <experimental-vsix>
```

Inspect the VSIX as a ZIP and verify:

- expected version/display name/preview flag;
- managed feature remains opt-in;
- new command/settings are present;
- `out/extension.js` and `out/mcpStdio.js` are included;
- no source tests, fixture servers, credentials, or generated secret files ship.

### Phase 5 - Live Windows acceptance

With an externally supplied API key:

1. Keep the OpenAI Codex sidebar/app-server active.
2. Configure the isolated workspace profile.
3. Start managed Codex and complete a real board-event turn/MCP post.
4. Run an independent terminal Codex task concurrently.
5. Start a second isolated workspace profile concurrently.
6. Confirm all existing external PIDs remain alive.
7. Confirm each managed process uses its own home/SQLite paths and correct board.
8. STOP/PAUSE one managed runtime and confirm unrelated Codex processes survive.
9. Reload/crash/restart and confirm no orphan or stale lease.
10. Inspect logs for SQLite locks, auth invalidation, cross-workspace routing,
    protocol mismatch, or leaked secrets.

An API-key run does not require a ChatGPT token-refresh soak. Consumer ChatGPT
mode, if later added, does.

## 11. Automated test requirements

- Stable and distinct managed profile resolution.
- Paths remain outside repo and VS Code installation roots.
- No normal-home fallback or credential copying.
- Login key enters only child stdin and is absent from args/env/logs/errors.
- App-server spawn uses `shell: false`, private stdio, correct cwd, both isolated
  environment paths, and workspace-specific MCP arguments.
- External PID discovery is informational and redacted.
- Unknown discovery does not block startup.
- Two fake app-servers with different profiles run concurrently.
- Same-profile lease rejects a duplicate Relay owner.
- Mode switching stops only the owned child and releases its lease.
- Managed app-server and serialized worker lane can overlap.
- Event ordering, truncation, partial lines, STOP, approval denial, recovery,
  timeout, fallback post, and protocol tests remain green.
- Saved `managed-exclusive` state migrates to `managed-isolated`.
- No secret appears in status snapshots, setup reports, or packaged output.

## 12. Merge decision

Do not merge to `main` merely because unit tests pass.

Merge readiness requires:

- all automated gates and package inspection pass;
- credentialed live API-key acceptance passes with the sidebar active;
- at least two workspace profiles coexist without routing/state conflict;
- no external Codex process is killed or blocked;
- rollback remains disabling the experimental feature/removing the experimental
  VSIX, leaving stable MCP behavior unchanged;
- the operator reviews the evidence and explicitly approves the merge.

## 13. Validation evidence (2026-07-17)

Completed on Windows against `codex-cli 0.144.4`:

- `npm run typecheck`: pass.
- `npm test`: 181/181 pass.
- production build and VSIX packaging: pass.
- packaged contents: runtime bundles present; source/tests and generated test
  output absent.
- isolated stdio protocol smoke: `initialize` and `account/read` pass with no
  inherited credential variables and with forced isolated SQLite/file auth.
- coexistence smoke: one pre-existing Codex app-server plus two disposable
  isolated app-servers were observed concurrently (`1 -> 3 -> 1`); both
  isolated clients exited cleanly and the pre-existing process remained.
- experimental VSIX: `forge-relay-isolated-codex-experimental-0.7.0.vsix`.
  SHA-256: `8BDF788271F1255F83C226DD63140C63213B34E3F36FA2E0C48B8F9B80DA3A46`.

Still required before merging: install the VSIX, provision the isolated profile
with an operator-supplied Platform API key, and complete the credentialed
multi-workspace/board-event/STOP acceptance steps in Phase 5. No API key was
available to the build process, so those steps have not been claimed as passed.
