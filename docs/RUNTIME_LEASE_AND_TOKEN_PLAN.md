# Runtime Lease + Bridge Logging + Cache Keep-Alive - Revised Plan

Date: 2026-06-03
Repo: `N:\vs code apps\Agentwatch`
Status: **IN PROGRESS - shared lease/follower implementation and Claude bridge logging landed; keep-alive verification remains.**

This revision keeps the original goals, but corrects three weak spots from the
first draft:

1. Lease ownership must track a *usable managed bridge*, not merely a live VS
   Code extension host.
2. Shutdown and takeover rules must avoid the "release early, overlap briefly"
   race that can recreate duplicate runtimes.
3. Keep-alive must fit the *current bridge architecture* instead of assuming a
   magical silent no-op turn that the current prompts do not support.

The target remains the same:

- stop duplicate managed Codex / Claude Mode B bridges across windows and reloads
- add Claude bridge disk logging
- keep long-lived Claude sessions cache-warm across slow worker gaps

---

## Scope of this PR

| Item | Agents | Why |
|---|---|---|
| **1. Per-repo, per-agent runtime lease** | Codex + Claude Mode B | Prevent duplicate managed bridges across windows / reloads |
| **2. Claude bridge file logging** | Claude Mode B | Make Claude bridge behavior auditable after the fact |
| **3. Cache keep-alive heartbeat** | Claude required, Codex optional | Avoid cold cache re-billing during long idle gaps |
| ~~4. Context trim~~ **Not in this PR** | - | Keep full coordinator context for now |

**Explicitly not in this PR:**

- Codex `thread/resume` continuity after owner crash/restart
- Claude resume/continue continuity after managed bridge restart
- context compaction / summarization

These remain follow-ups.

## Completed so far

- Shared runtime lease helper added in `src/runtimeLease.ts`
- Shared supervisor updated with lease ownership, heartbeat, follower status, and promotion retry in `src/runtimeBridge.ts`
- Runtime status surface updated to include `follower`
- Status-bar icon mapping updated for `follower`
- `Verify Setup` and MCP config guidance updated so Codex no longer recommends a
  globally hardwired `--repoRoot`
- Bridge lock diagnostics added so lock ownership and timeout context are logged
  in `.coordination/lock.log`
- Shared bridge log helper added in `scripts/bridgeLog.js`
- Claude bridge now mirrors startup and runtime output into
  `.coordination/claude-bridge.log`
- Claude bridge now has an opt-in debug keep-alive harness in
  `scripts/claude-auto-bridge.js`
- TypeScript typecheck and build both passed after these changes

## Remaining work

- Run the inert-turn verification for Claude keep-alive
- Run the cache-benefit verification for Claude keep-alive
- Decide whether Claude keep-alive is safe to ship or should remain deferred
- Validate the lease/follower behavior end-to-end across two VS Code windows

## Resume here

If resuming in a fresh session:

- the shared lease/follower implementation is already in the repo
- Claude bridge logging and the keep-alive verification harness are now in the repo
- do not treat Claude keep-alive as production-ready yet; the plan now requires
  inert-turn and cache-benefit verification first
- if board lock timeouts continue, inspect `.coordination/lock.log` after
  reloading the extension so the new lock-owner logging is active

---

## Item 1 - Per-repo, per-agent runtime lease

### Goal

At most one *usable* managed runtime bridge per agent per repo root at a time.
A second window becomes a follower and does not spawn a bridge child. If the
owner dies or becomes unhealthy, a follower can promote.

### Corrected design decision

The lease gate still belongs in `ScriptRuntimeBridge`, before `spawnChild()`,
because that is the shared spawn choke point for Codex and Claude Mode B.

However, the lease must represent **bridge ownership plus bridge health**, not
just "this extension-host PID exists".

That means:

- the lease record is created by the supervisor before spawn
- the supervisor remains the authority that may release or transfer the lease
- the lease heartbeat is only renewed while the managed bridge child is in a
  healthy owner state
- a supervisor that has no live bridge child, or has given up restarting, must
  stop renewing and release the lease

This keeps the convenience of a supervisor-side gate while avoiding a stuck
"live host, dead runtime" ownership state.

### New file: `src/runtimeLease.ts`

```ts
class RuntimeLease {
  constructor(coordDir: string, agent: string, repoRoot: string, ownerPid: number)

  tryAcquire(): 'acquired' | 'held-by-live-other'
  markBridgeStarted(bridgePid: number): void
  renewHealthy(): void
  releaseIfOwned(): void
  readCurrent(): LeaseRecord | null
}
```

Suggested lease path:

- `<coordDir>/runtime-codex.json`
- `<coordDir>/runtime-claude.json`

Suggested lease record:

```json
{
  "agent": "codex",
  "owner_pid": 12345,
  "bridge_pid": 23456,
  "repo_root": "N:\\vs code apps\\Agentwatch",
  "started_at": "2026-06-03T10:00:00.000Z",
  "heartbeat_at": "2026-06-03T10:00:05.000Z",
  "status": "starting"
}
```

Where `status` is one of:

- `starting`
- `linked`
- `restarting`
- `stopped`

### Ownership and liveness rules

`tryAcquire()` uses atomic create (`openSync(..., 'wx')` or equivalent).

On `EEXIST`, read and evaluate the current lease:

- If `owner_pid` is dead: reap and retry once.
- If `bridge_pid` exists and is alive, and `heartbeat_at` is fresh: treat as
  `held-by-live-other`.
- If `bridge_pid` is missing because the owner is still in `starting` or
  `restarting`, allow a short grace window only.
- If the record is stale past the grace window, or malformed and stale, reap and
  retry once.
- If the file looks half-written and very recent, do not reap immediately; back
  off and retry later.

Recommended timing:

- healthy heartbeat interval: 5s
- follower retry interval: 10s
- startup / restart grace window: 20s
- stale lease threshold: 20s since last healthy heartbeat

### Critical correction: what counts as "healthy"

The supervisor may renew the lease only while all of the following hold:

- `wantRunning === true`
- the managed bridge child exists
- the bridge is in `waiting`, `linked`, or a bounded restart grace period
- the supervisor has not exhausted restart attempts

The supervisor must **not** renew the lease when:

- there is no child
- the bridge is in terminal `stopped`
- the bridge has been manually disconnected
- the child has exited and restart is no longer scheduled

This prevents a live extension host from pinning ownership while the bridge is
actually unusable.

### Corrected shutdown and takeover rule

Do **not** release the lease before killing the managed child tree.

Correct order:

1. mark local state as stopping
2. clear retry / heartbeat timers
3. kill the managed bridge child tree
4. wait for or observe child exit
5. release the lease if still owned
6. set local status to `inactive`

Why:

- releasing first allows a follower to acquire and spawn while the old child
  tree is still alive
- on Windows, `taskkill /T` is asynchronous enough that this overlap is real

### Changes to `src/runtimeBridge.ts`

- Add `follower` to `RuntimeStatus`.
- Add fields for:
  - `lease`
  - `ownsLease`
  - `leaseHeartbeatTimer`
  - `leaseRetryTimer`
  - `stopping`
- Change `start()`:
  - set `wantRunning = true`
  - attempt lease acquisition before `spawnChild()`
  - on acquire:
    - set `ownsLease = true`
    - write lease status `starting`
    - spawn child
  - on live other:
    - set status `follower`
    - start retry timer
- In `spawnChild()`:
  - after child spawn, record `bridge_pid`
  - while in `waiting` / `linked`, run 5s healthy renewals
- In child exit handling:
  - if `wantRunning` and restart is still allowed:
    - keep lease owned
    - mark lease `restarting`
    - do not let followers take over during bounded restart grace
  - if restart budget is exhausted:
    - mark `stopped`
    - release lease
- In `stop()`:
  - kill child first
  - release lease after child exit / teardown path

### Follower behavior

Follower windows do not spawn bridge children.

They:

- set runtime status to `follower`
- retry acquisition every 10s
- promote automatically once the owner lease is stale or released

Promotion means:

- acquire lease
- spawn child
- become normal owner

### `RuntimeManager` and `extension.ts` impact

`runtimeManager.ts` remains structurally the same, but not literally "no logic
change".

Minimal required behavior updates:

- `RuntimeStatus` now includes `follower`
- status bar icon mapping must handle `follower`
- Codex toggle behavior in a follower window must be defined intentionally

Recommended toggle rule:

- clicking the Codex toggle in a follower window should disconnect *this
  window's intent* but should not kill the owner in another window

In other words, follower is an active local state, not equivalent to inactive.

### Honest scope boundary

This lease design prevents duplicate managed bridges caused by:

- multiple VS Code windows
- extension-host reloads
- roster auto-restore

It does **not** preserve the Codex thread or Claude conversation across an
owner bridge restart. Restarted owners still cold-start their managed session
unless a later resume feature is added.

---

## Item 2 - Claude bridge file logging

### Problem

Codex already mirrors bridge output into
`<repoRoot>/.coordination/codex-bridge.log`. Claude does not currently write a
disk log, so postmortem analysis depends on board archaeology.

### Plan

Factor the Codex tee helper into a shared script helper:

- new: `scripts/bridgeLog.js`
- exported helper: `teeToLogFile(eventPath, logName, agentLabel)`

Use it from both bridges:

- Codex -> `codex-bridge.log`
- Claude -> `claude-bridge.log`

Claude should call it at process startup, before spawning the Claude CLI child,
so startup failures are captured too.

### Acceptance check

After the lease lands, normal operation should show:

- one stable launch banner per actual bridge owner lifecycle
- no repeated duplicate banners from follower windows

---

## Item 3 - Cache keep-alive heartbeat

### Root cause

The current Claude bridge holds one long-lived Claude session and appends every
triggering board event as the next user message on stdin. That conversation
prefix grows continuously. If the Anthropic prompt cache goes cold during a long
worker gap, the next real turn re-reads the large prefix at full uncached cost.

This part of the original diagnosis still stands.

### Corrected constraint

The current bridge architecture does **not** support an implicit "silent no-op"
for free.

Today:

- Claude keep-alive would be sent through the same stdin turn channel as a real
  board event
- the current prompts tell the model to decide whether to reply and even to
  stand by when no action is needed
- therefore a naive ping would still create assistant output and grow context

So the keep-alive must be an explicit protocol feature, not just "send a fake
event and hope the model stays quiet".

### Revised keep-alive protocol

Add a dedicated synthetic turn type that the bridge can generate internally when
the session has been idle for too long.

Conceptually:

- real board events remain normal user turns
- keep-alive turns are tagged maintenance turns

For Claude, the keep-alive input should say exactly this in effect:

- this is a cache keep-alive maintenance turn
- do not use tools
- do not post to the board
- do not inspect files
- do not emit a natural-language reply
- acknowledge only with the smallest possible inert completion if the CLI
  requires output

### Required prompt changes

The Claude bridge prompt must explicitly distinguish:

- `board-event` turn: normal orchestration rules
- `keep-alive` turn: perform no action, no tools, no board traffic, no prose

The current prompt text is insufficient for this and must be revised as part of
the plan.

### Bridge behavior

Keep-alive should be timer-driven from the existing idle tracking:

- if no real turn has been forwarded in ~4 minutes, enqueue one keep-alive turn
- do not enqueue keep-alive while another turn is in progress
- reset the keep-alive timer after any real turn or keep-alive turn
- coalesce missed intervals: at most one pending keep-alive

Important:

- keep-alive is only for the **owner** bridge
- followers never emit keep-alives
- keep-alive must not touch the AgentWatch board at all

### Verification gate before implementation

Keep-alive should not be merged on design confidence alone. Verify it first as an
instrumented bridge experiment with explicit pass/fail checks.

Behavior verification:

- add a temporary debug-only keep-alive path in `scripts/claude-auto-bridge.js`
- inject one synthetic keep-alive turn through the same `stdin.write(...)` path
  used for normal Claude board events
- log the full Claude `result` payload and any MCP/tool activity during that turn
- current harness switches:
  - `--debug-keep-alive-ms <ms>`
  - `--debug-keep-alive-log-payloads true`
- pass only if:
  - no AgentWatch MCP calls occur
  - no board event is written
  - no file-inspection/edit tool is used
  - the completion is empty or an explicitly allowed inert marker
  - the bridge remains healthy and accepts the next real board event normally

Cache-effect verification:

- run a baseline session without keep-alive
- send one real turn, wait past the suspected cache-cold window, then send a
  second real turn
- record whatever Claude runtime output actually exposes about token/cache usage
  for that second real turn
- repeat with the same idle gap but insert keep-alive turns during the gap
- pass only if the post-idle real turn shows measurably better cache reuse or
  lower effective input-cost behavior than baseline

Implementation rule:

- if the synthetic turn emits prose, touches tools, writes to the board, or shows
  no measurable cache benefit, defer keep-alive and ship the lease/follower work
  first

### Codex treatment

Codex keep-alive is optional and should not be bundled into the required fix
unless there is a verified comparable caching win.

Reason:

- the observed runaway cost is Claude-side
- Codex uses a different backend path
- adding Codex keep-alive increases scope without the same evidence base

So this PR should define:

- Claude keep-alive: required
- Codex keep-alive: explicitly deferred unless later evidence justifies it

### Global Codex config fix

To avoid cross-workspace board collisions, the user's global Codex MCP entry
must not hardwire AgentWatch's repo root.

Broken example:

```toml
[mcp_servers.agentwatch]
command = "node"
args = ["n:/vs code apps/Agentwatch/out/mcpStdio.js", "--repoRoot", "n:/vs code apps/Agentwatch"]
```

Corrected example:

```toml
[mcp_servers.agentwatch]
command = "node"
args = ["n:/vs code apps/Agentwatch/out/mcpStdio.js"]
```

Why:

- the global hardwired `--repoRoot` forces every Codex workspace to post into
  the same AgentWatch board
- omitting `--repoRoot` lets `mcpStdio` resolve the board from the current
  workspace `cwd` unless a managed bridge explicitly overrides it with
  `AGENTWATCH_REPO_ROOT`

### Why no context trim in this PR

We still want full board context available to the coordinator. The immediate
problem is not that long context exists; it is that a long context becomes
expensive when the cache goes cold.

This PR fixes the cache-cold problem first.

If warm-cache reads later become material at very large context sizes, context
compaction can be evaluated separately.

---

## Decisions

1. Lease ownership stays supervisor-gated, but renewal is tied to actual bridge
   health, not merely host liveness.
2. Shutdown releases the lease only after child-tree teardown, never before.
3. Follower windows do not spawn bridge children; they poll and auto-promote.
4. Claude logging is added through a shared `bridgeLog.js` helper.
5. Claude keep-alive is implemented as an explicit maintenance-turn protocol,
   not as an ordinary fake board event.
6. Codex keep-alive is out of scope for this PR unless new evidence changes the
   priority.
7. Context trim remains out of scope.
8. Claude keep-alive implementation is gated on an instrumented inert-turn and
   cache-benefit verification pass first.

---

## Files touched

- **New:** `src/runtimeLease.ts`
- **Edit:** `src/runtimeBridge.ts`
- **Edit:** `src/types.ts`
- **Edit:** `src/extension.ts`
- **Edit:** `src/bridge.ts`
- **Edit:** `src/mcpStdio.ts`
- **Planned next:** `scripts/bridgeLog.js`
- **Planned next:** `scripts/claude-auto-bridge.js`

---

## Acceptance criteria

1. Opening a second VS Code window on the same repo does not spawn a second
   managed bridge for the same agent.
2. A follower window shows `follower` and never starts its own bridge child.
3. Reloading the extension host does not accumulate extra live bridges.
4. At most one owner bridge per agent per repo root exists at a time.
5. If the owner dies, a follower can promote within about 10s.
6. If the owner enters a terminal stopped state, it releases the lease instead
   of pinning ownership indefinitely.
7. Normal shutdown does not produce temporary overlap between the old owner and
   the promoted follower.
8. `codex-bridge.log` and `claude-bridge.log` capture stable owner lifecycles.
9. Claude keep-alive does not post to the board, claim files, inspect files, or
   emit normal prose responses.
10. Claude cache behavior across >5 minute worker gaps shows cache reads instead
    of repeated cold full-prefix re-billing, using whatever token telemetry the
    Claude CLI/runtime actually exposes during validation.

---

## Validation notes

Because the current repo does not obviously persist Claude token telemetry, the
implementation task should define the exact observable used for acceptance before
coding begins. The plan should not assume a specific counter name until that is
verified in the actual Claude runtime output.

---

## Summary

The original direction was correct, but the implementation plan needed stricter
lease semantics and a keep-alive design that matches the real bridge flow.

This revised plan keeps the single-owner runtime lease, adds Claude logging, and
defines keep-alive as an explicit maintenance-turn protocol instead of a vague
"silent ping".
