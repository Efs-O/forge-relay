# Forge Coordinator Plan

## Goal

Let a Forge-served local model act as the Relay board coordinator — the role
`claude-auto-bridge.js` plays for Claude Code today — selected from the
Connect dialog, driven by board events, dispatching workers, and never
mutating the workspace.

This plan is the reviewed successor to the Codex assessment of 2026-07-11.
It keeps the two-phase split but cuts coordinator file mutation permanently
(not just from the MVP) and fixes the model-hold lifecycle.

## Boundary With Forge

The only contract between forge-relay and Forge is the control-server HTTP
API: `GET /models`, `/ensure`, `/chat`, `/release`. No shared npm package, no
cross-repo imports, no copied types — each side validates the JSON at its own
boundary. Forge's config remains the single source of truth for which local
models exist and are servable; Relay reads the catalog at connect time and
never mirrors or caches it beyond the live session.

Mutation lives only in Forge, where checkpoints, Keep/Undo, and the
permission resolver exist. The Relay coordinator coordinates: it reads the
board, claims work, dispatches workers, and posts results. It never receives
edit, write, or terminal tools — in any phase.

## Phase 0 (BLOCKER): Board-Keyed Bridge Singleton Lock

Fix before any coordinator work and before Forge's delegation Phase 2 —
this bug is actively doubling token spend today.

### Bug (observed live, 2026-07-11)

The auto-bridge singleton lock is effectively per-repo-root, so two VS Code
windows (forge-relay workspace, Forge workspace) each ran their own
`claude-auto-bridge.js` against the SAME board at `:7879`. Every board event
fired a full-context headless Claude turn in BOTH bridges — CacheWarden
showed two `[AW_TURN_TYPE: board-event]` sessions (68k and 37k cached input)
billing in parallel all day. Related symptoms: quadruplicate `[release]`
events within 5 ms; orphaned mixed-version `mcpStdio` processes (v0.4.1 +
dev build) surviving extension updates; matches the earlier prodtest
"orphan relay MCP dups thrash bridge.lock" finding.

### Fix

- Key the bridge lock to the BOARD ENDPOINT (host:port), not the repo root:
  one bridge per board, machine-wide. Lock file lives in a per-user location
  (e.g. `%LOCALAPPDATA%/forge-relay/bridge-<host>-<port>.lock`), holding
  `{ pid, startedAt, extensionVersion, repoRoot }`.
- Loser of the lock race exits loudly: log + one board post
  `bridge-duplicate-suppressed (pid X, window Y)` so silent double-billing
  can never recur.
- Stale-lock recovery: if the lock-holder pid is dead, take over and log it.
- On extension deactivate/window close, the owning bridge releases the lock
  and exits; on activation, kill any bridge process the lock says belongs to
  a PREVIOUS extension version before starting the current one (fixes the
  0.4.1/0.4.2 orphan mix).
- The future ForgeCoordinatorBridge inherits this same lock module — a
  coordinator and a Claude bridge on one board must also be mutually
  exclusive unless explicitly configured as distinct agent identities.

### Acceptance criteria

- Two windows opening the same board yield exactly one live bridge; the
  second posts the suppression notice and exits.
- Killing the winner lets a new bridge take over within one event poll.
- Extension update leaves zero orphaned bridge/mcpStdio processes from the
  old version.

## Phase 1: Coordinator MVP

### Scope

- New `src/forgeCoordinatorBridge.ts` — the only genuinely new module.
- Connect dialog gains a third coordinator choice:

```text
Coordinator
  Claude Code
  Forge model: [selector populated from Forge GET /models]
```

- Lifecycle: fetch catalog → user selects `model@profile` → `/ensure` →
  event loop → `/release` on disconnect, model change, failure, or extension
  shutdown.
- Coordinator toolset (MVP): `board_check`, `post`, `claim`, `release`,
  `ack_command`, `resolve_command`, `dispatch_subagent`, `list_models`,
  `get_status`. **These are the existing MCP server handlers called
  directly as functions — zero new tool implementations.**
- Persistent conversation history across board events, with a bounded
  history window (drop-oldest). No context compaction in the MVP.
- STOP/PAUSE preflight before every action and before every long call;
  STOP aborts an in-flight completion.
- Self-trigger suppression: the coordinator never reacts to its own posts.
- Provider-backed (`servable: false`) models route through Forge's `/chat`
  proxy exactly as workers already do.

### Reuse (anti-duplication)

| Need | Owner — reuse, do not rebuild |
| --- | --- |
| Tool execution round | extract the inner "one completion + execute tool calls" round from `subagentLoop.ts`; worker keeps its bounded 12-step wrapper, coordinator wraps the same round with persistent history |
| Board event filtering / trigger policy | extract from `claude-auto-bridge.js` (~lines 103–280) into a module both bridges import; the Claude CLI transport stays where it is |
| Tool handlers | the MCP server's existing handler functions |
| Model invocation, sampling, provider routing | Forge `/chat` proxy — Relay grows no sampling or normalization logic |
| Runtime plumbing | generalize `RuntimeManager` from Claude-only to bridge-agnostic; roster/session types in `types.ts` lose their Claude/Codex hardcoding |

### Model-hold lifecycle (differs from the Codex proposal)

Do **not** pin the model for the whole connected session. A session-long
`/ensure` hold collides with interactive Forge use and single-slot VRAM
reality (base@profile double-hold; observed co-load failures). Instead:

- `/ensure` on connect to validate the selection, then release;
- re-`/ensure` lazily on each board-event burst;
- idle-release timer (configurable, default ~5 min) drops the hold between
  bursts;
- if re-ensure fails mid-session (evicted, OOM, Forge restarted), post a
  visible board notice and retry with backoff — never fail silently.

### Acceptance criteria

- Coordinator runs a multi-hour session on a real board without
  self-triggering, without leaking a model hold, and with STOP honored
  mid-completion.
- Claude Mode B behavior is unchanged.
- Killing Forge mid-session produces a visible error and clean recovery
  after Forge returns.
- No new tool handler implementations exist — verified by review.

## Phase Gate

Phase 2 is not scheduled until the MVP has run for at least a week of real
use. The MVP is an experiment: prodtest proved local models are reliable
bounded workers (39/39), not that they can coordinate. If the coordinator
spams the board, triggers on itself, or loses the thread across events,
that evidence decides Phase 2's shape — or cancels it.

## Phase 2 (gated): Full Coordinator

- Context compaction for long sessions (summarize-and-truncate).
- Larger/configurable step budget per event burst.
- Recovery polish: Forge model swaps, endpoint failures, extension reload.
- Richer runtime status in the board UI.
- Coordinator profiles (system-prompt variants per model).

### Explicitly cut — permanently, not deferred

- Coordinator file editing, writing, or terminal execution. If coordinated
  work needs mutations, the coordinator dispatches a task and a human (or
  Forge's own gated agent) applies changes inside Forge's safety rails.
- A Relay-side permission framework: the coordinator's capability set is its
  tool list, nothing more.
- Mirroring Forge's model catalog into Relay state.
- Recursive coordination (a coordinator dispatching another coordinator).

## Tests

- Connect-dialog model selection with a live and an unreachable Forge.
- Ensure/idle-release/re-ensure cycle, including failure mid-session.
- STOP during streaming; PAUSE preflight skipping actions.
- Self-trigger suppression on the coordinator's own posts.
- Bounded history window behavior over many events.
- Shared event-filter module: identical decisions for Claude bridge and
  Forge coordinator given the same board input.
- `dispatch_subagent` from the coordinator reaching a worker and the result
  landing on the board.

## Quality Gates

Existing repo checks (type-check, lint, tests, package) plus a manual smoke:

1. Forge model coordinating with one worker dispatch end-to-end.
2. STOP mid-completion.
3. Forge killed and restarted mid-session.
4. Claude Mode B regression check.

## Definition of Done (MVP)

- A user can pick a Forge model as coordinator from the Connect dialog.
- The coordinator handles board events with persistent history, honors
  STOP/PAUSE, dispatches workers, and never mutates the workspace.
- Model holds are released on idle, disconnect, and shutdown.
- All failures (capacity, OOM, endpoint, template) are visible on the board.
- No duplicated tool handlers, event filtering, or sampling logic.
