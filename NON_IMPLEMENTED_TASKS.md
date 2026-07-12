# Forge Relay — Non-Implemented Tasks

This document consolidates the work that is still unimplemented from the three
most recently modified Markdown files reviewed on 2026-07-12:

- `CHANGELOG.md`
- `README.md`
- `resources/AGENTS.template.md`

All `CHANGELOG.md` Unreleased items and the `AGENTS.template.md` installation
flow are already implemented. The remaining work comes from the README roadmap
and one related documentation/behavior gap around folder claims.

## Review Summary

| ID | Task | Current state | Suggested priority |
|---|---|---|---|
| FR-1 | Parent/child folder claim conflict detection | **Done** (`pathsOverlap()` in `src/bridge.ts`) | High |
| FR-2 | Push instead of two-second UI polling | **Done** (per-view `BoardWatcher` + 10s backstop) | Medium |
| FR-3 | Build hook wrappers | **Done** (`run_build` MCP tool, `src/buildWrapper.ts`) | Medium |
| FR-4 | Session snapshots as Markdown | Not implemented | Low |
| FR-5 | Task cards with blockers and severity | **Done** (`Task` type + `src/bridge.ts` lifecycle + 9 MCP tools + webview UI) | Medium/large |
| FR-6 | VS Code Marketplace publication | Preparing `Efsoo.forge-relay v0.5.1`, which includes FR-5 | Release task |

## FR-1 — Parent/Child Folder Claim Conflict Detection

### Goal

Make claims conflict when their paths overlap hierarchically, rather than only
when their normalized paths are identical.

Examples that should conflict:

- Existing claim: `src`; requested claim: `src/bridge.ts`
- Existing claim: `src/auth`; requested claim: `src`
- Existing claim: `src/auth`; requested claim: `src/auth/login.ts`

Paths with similar prefixes must not conflict accidentally:

- `src/auth` and `src/authentication`
- `app` and `apple`

### Current Evidence

`src/bridge.ts` currently detects conflicts using exact membership:

```ts
c.paths.filter(p => normalised.includes(p))
```

The README describes file/folder claims, but its roadmap correctly notes that
parent/child overlap protection is still missing.

### Acceptance Criteria

- Normalize separators, case, `.` segments, and trailing separators before
  comparing paths.
- Treat two paths as overlapping when they are identical or one is a true path
  ancestor of the other.
- Apply the same rules consistently on Windows and POSIX-style input.
- Preserve the current behavior that claims belonging to the same agent do not
  block that agent.
- Return a useful denial message identifying the conflicting held path and
  agent.
- Add tests for exact, parent, child, sibling, prefix-only, mixed-separator, and
  case-normalization cases.
- Ensure claimed paths cannot escape the coordinated repository.

## FR-2 — Push-Based Board Updates Instead of Two-Second Polling

### Goal

Push board updates to the sidebar and editor-tab webviews as state changes,
reducing update latency and eliminating continuous two-second UI polling.

### Current Evidence

- `src/boardPanel.ts` calls `setInterval(push, 2000)`.
- `src/boardView.ts` calls `setInterval(push, 2000)`.
- Other internal polling, such as board-file watching and coordinator STOP
  checks, serves different reliability/lifecycle purposes and should not be
  removed as part of this task without separate analysis.

### Acceptance Criteria

- Sidebar and tab views receive state changes without a two-second refresh
  interval.
- Initial state is sent immediately when a view opens.
- Reconnection or webview restoration recovers current state without losing
  events.
- Multiple open views receive the same updates.
- View disposal cleans up listeners/connections.
- Updates remain local to the extension/workspace and do not expose a new
  unauthenticated network surface unnecessarily.
- Tests cover initial delivery, update delivery, multiple subscribers, and
  disposal/reconnection.
- If a lightweight extension-host event subscription is sufficient, prefer it
  over introducing an actual network WebSocket solely to communicate with VS
  Code webviews; update the README wording accordingly.

## FR-3 — Build Hook Wrappers

### Goal

Provide wrappers that coordinate common builds by performing a pre-flight board
check, acquiring an appropriate claim, running the build, and posting the
result.

The README example is automatic coordination around commands such as
`dotnet build`.

### Decisions Needed Before Implementation

- Which build tools are in the first supported set: npm, dotnet, cargo, Maven,
  Gradle, or a generic configured command?
- Whether wrappers are VS Code commands/tasks, shell executables, agent MCP
  tools, or a combination.
- What target should be claimed for a build, since builds often write generated
  output without changing source files.
- Whether claims are released after failed builds as well as successful builds
  (recommended: always release in a `finally` path).

### Acceptance Criteria

- Run `board_check` before the build and refuse to start when blocked.
- Acquire the configured claim before executing the command.
- Do not run the build if the claim is denied.
- Post a concise start and completion/failure event.
- Release the claim on success, failure, timeout, or cancellation.
- Preserve the child process exit code and useful diagnostics.
- Quote command arguments safely on supported platforms.
- Add tests for success, non-zero exit, denied claim, STOP/PAUSE, timeout, and
  cleanup.

## FR-4 — Session Snapshot Markdown Export

### Goal

Export a readable Markdown snapshot of the current coordination session,
including active work allocation and unresolved blockers.

### Decisions Needed Before Implementation

- Manual export only or periodic automatic snapshots.
- Snapshot location and retention policy.
- Whether generated snapshots should be git-ignored.
- Whether event history is summarized or copied verbatim.

### Acceptance Criteria

- Include generation time, session identifier, active claims, open commands,
  agent status, and current blockers.
- Produce deterministic, valid Markdown.
- Write atomically so readers never see a partial snapshot.
- Avoid leaking secrets or dumping unbounded worker/tool output.
- Clearly distinguish current state from historical events.
- Add tests for empty, active, blocked, and multi-agent sessions.

## FR-5 — Task Cards With Blocker State and Severity Tags

### Goal

Add persistent task-level coordination above the existing event feed and file
claims.

### Decisions Needed Before Implementation

- Task schema and lifecycle states.
- Severity vocabulary and ordering.
- Assignment model: one owner, multiple assignees, or unassigned.
- Relationship between task blockers, STOP/PAUSE commands, and file claims.
- Whether task mutations are exposed through new MCP tools.
- Migration/versioning strategy for existing `.coordination` state.

### Suggested Minimum Schema

- Stable task ID
- Title and optional description
- State: `open`, `in_progress`, `blocked`, `done`, `cancelled`
- Severity: `low`, `medium`, `high`, `critical`
- Owner/assignee
- Blocking reason and optional dependency task IDs
- Created/updated timestamps

### Acceptance Criteria

- Create, update, assign, block/unblock, complete, and cancel task cards.
- Persist task state safely under `.coordination` with the existing locking
  discipline.
- Show cards in both sidebar and tab views.
- Record task mutations in the audit feed.
- Validate state transitions and reject malformed severity/state values.
- Keep task blocker state semantically distinct from operator STOP/PAUSE.
- Add protocol, MCP, persistence, concurrency, and webview tests.

## FR-6 — VS Code Marketplace Publication

### Goal

Complete the release work needed to publish Forge Relay to the VS Code
Marketplace.

### Pre-Publication Checklist

- Confirm publisher ownership and Marketplace access.
- Confirm extension identifier, version, license, repository, icon, categories,
  and public-facing metadata.
- Run type checking, tests, production build, and VSIX packaging.
- Install and smoke-test the produced VSIX in a clean VS Code profile.
- Verify packaged contents include runtime scripts and
  `resources/AGENTS.template.md` while excluding development-only files.
- Verify onboarding, Configure Codex, Configure Claude, Verify Setup, sidebar,
  tab panel, STOP/PAUSE, and MCP stdio/HTTP flows.
- Re-test the VS Code installation-directory safety guard for both extension
  and stdio entry points; publication work must not weaken this invariant.
- Prepare release notes and remove or explicitly accept the `preview` flag.
- Publish using the chosen CI or authenticated manual release process.
- Verify the public listing and clean installation from the Marketplace.

### Acceptance Criteria

- The intended version is publicly available from the Marketplace.
- A clean installation activates successfully and passes the onboarding smoke
  test.
- The published package matches the locally validated VSIX.
- Repository documentation links to the Marketplace listing.

## Recommended Implementation Order

1. **FR-1:** Folder claim overlaps — closes a core collision-safety gap.
2. **FR-2:** Push-based UI updates — contained architectural improvement.
3. **FR-3:** Build wrappers — define the command/claim contract first.
4. **FR-5:** Task cards — larger protocol and persistence feature.
5. **FR-4:** Session snapshots — design after task-card state is settled so
   snapshots can include tasks without an immediate format revision.
6. **FR-6:** Marketplace publication — perform after the intended release scope
   is finalized and tested.

## Review Checklist

- [x] Approve or revise the scope of FR-1. (Approved 2026-07-12, implementation started.)
- [x] Decide whether FR-2 requires network WebSockets or extension-host push. (Extension-host event subscription, no network WebSocket; implementation started 2026-07-12.)
- [ ] Select the first build tools and integration surface for FR-3.
- [ ] Decide snapshot trigger, location, and retention for FR-4.
- [ ] Approve the task lifecycle and severity vocabulary for FR-5.
- [ ] Decide which feature set must ship before FR-6.
