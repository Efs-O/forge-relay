# Codex Coordination Path: MCP vs Legacy PowerShell — Verification Report + TODOs

**Status:** CODE MIGRATION DONE (2026-06-04); LIVE END-TO-END RUN STILL PENDING.
**Date:** 2026-06-04.

## Implementation log (2026-06-04 — "restore codex" session)

- **TODO 1 DONE.** `src/mcpStdio.ts` now logs every tool call. Added `logToolCall()`
  (after the startup-banner block) and a call at the top of the
  `CallToolRequestSchema` handler — appends `tool=<name> agent=<agent> pid=<pid>`
  to `.coordination/mcpstdio.log`. Built into `out/mcpStdio.js` (the file the codex
  bridge spawns) via `npm run build`; `npm run typecheck` clean.
- **TODO 2 + 8 DONE (the actual fix for "codex 99% dysfunctional").** Rewrote
  `AGENTS.md` to instruct Codex to coordinate **only through the AgentWatch MCP
  tools** (board_check/get_status/claim/release/post/ack_command/resolve_command),
  matching Claude. The script path — whose prose↔verb mismatch made Codex emit the
  invalid `-Action recent` / `-Action claims` verbs — is removed from the agent's
  instructions and demoted to a documented human debugging CLI. Old script-path
  prompt backed up at `docs/AGENTS.scripts-path.bak.md`. `SHARED_AGENT_PROMPT.md`
  mirrored to MCP-only; `BOARD_INFO.md` / `AGENT_COORDINATION.md` got legacy
  banners; `README.md` already framed scripts as legacy/compat.
- **TODO 7 DONE (audit) — VERDICT: SAFE.** Both implementations take the **same**
  lock file `.coordination/bridge.lock` with create-exclusive semantics:
  TS `fs.openSync(lockPath,'wx')` (`bridge.ts` L379) vs PS
  `[System.IO.File]::Open($LockPath,"CreateNew","ReadWrite","None")`
  (`agent-bridge.ps1` L60). A script write and an MCP write are mutually exclusive,
  so cross-impl JSON corruption can't occur. (Minor: only the TS side clears a stale
  lock after 30s; the PS side just retries 10s then throws — contention, not
  corruption.)
- **§4 DONE.** The open operator STOP `192a49f3…` is already `status:"resolved"`
  (`commands.json`); the board is no longer blocked.
- **TODO 9 obviated.** The verb mismatch is moot now that scripts aren't the agent
  path, but the correct `history`/`status` verbs are documented in AGENTS.md's
  debugging-fallback section anyway.
- **STILL PENDING (need a live codex session): TODO 3, 4, 5, 6.** Start the managed
  Codex bridge, drive a board event, and confirm `mcpstdio.log` shows `tool=…` lines
  (proving the model calls MCP) and that the STOP/`BLOCKED` path round-trips. The
  instrumentation from TODO 1 is what makes this finally observable.

### Original investigation follows (unchanged)

**Status:** INVESTIGATION COMPLETE, IMPLEMENTATION PENDING (new session).
**Date:** 2026-06-04.
**Goal:** Decide whether Codex can coordinate on the AgentWatch board **entirely via the
MCP tools** so the legacy PowerShell coordination path can be retired — but **prove it
works first**. Do NOT delete the scripts until the verification TODOs below pass.

> This doc is self-contained: a fresh session can act on it without prior chat context.

---

## 1. The problem we found

There are **three** board-coordination mechanisms across two agents, and they are
inconsistent:

| Agent | Mechanism | Reaches board via |
|---|---|---|
| Claude (Mode A & B) | MCP tools | AgentWatch MCP server (TypeScript) |
| Codex — managed bridge | MCP tools (bridge injects `mcp_servers.agentwatch`) | AgentWatch MCP server |
| Codex — **AGENTS.md** | **PowerShell scripts** (`agent-watch.ps1` / `agent-bridge.ps1`) | `.coordination/*.json` files **directly** |

- **There is NO `CLAUDE.md`.** Claude is MCP-only (system prompt in
  `scripts/claude-auto-bridge.js`; Mode A `/loop` prompt in `media/board.js` ~L280).
- **`AGENTS.md`** (auto-loaded by the ChatGPT Codex extension) tells Codex to coordinate
  by **directly running** `scripts/agent-watch.ps1` and `scripts/agent-bridge.ps1`
  (`AGENTS.md` L46-110). This bypasses the MCP server and hits the JSON files through a
  *separate PowerShell implementation* of the same board semantics.

### Why this is a hazard
1. **Two implementations of board logic** (TS MCP server + PowerShell scripts) must stay
   in lockstep. They already drift (see the verb mismatch below).
2. **Cross-implementation locking.** `agent-bridge.ps1` takes its own lock file
   (`agent-bridge.ps1` L68); the TS bridge uses `withLock`. A Codex-script write racing a
   Claude-MCP write must share the same lock discipline or `claims.json`/`commands.json`
   can corrupt. **UNVERIFIED — audit this.**
3. **Legacy holdover.** The PowerShell scripts were the original *manual* coordination;
   the MCP server + managed bridges came later (P2–P6). AGENTS.md was never migrated.

### Symptoms observed in the Codex log (2026-06-04)
- `agent-bridge.ps1 -Action recent` and `-Action claims` → **rejected** (not in the
  script's `ValidateSet`). Codex translated AGENTS.md prose ("Read recent events",
  "Check active claims" — `AGENTS.md` L53-54) into invalid verbs. The real verbs are
  **`history`** (recent events) and **`status`** (active claims). Prose↔command mismatch.
- `agent-watch.ps1` printed `BLOCKING COMMAND [192a49f3…]` and exited non-zero — Codex
  correctly halted on an **open operator STOP** (see §4).

---

## 2. The open question we CANNOT currently answer

**Does Codex actually do board operations through MCP end-to-end, or only via the scripts?**

- ✅ The managed Codex bridge **wires MCP correctly**: `codex-auto-bridge.js` L370-377
  injects `mcp_servers.agentwatch.command="node"` /
  `mcp_servers.agentwatch.args=[<mcpStdio.js>,"--repoRoot",<repoRoot>]` into the codex
  app-server config, and the bridge system prompt (L230, L470) tells Codex to use the MCP
  tools.
- ✅ Codex **spawns** the MCP server: `.coordination/mcpstdio.log` has dozens of
  `mcpStdio start` lines with `--repoRoot arg=…Agentwatch`.
- ❌ **We cannot tell if Codex's model ever CALLED a tool.** The tool handler
  (`src/mcpStdio.ts` L124-182) **logs nothing** — the only write to `mcpstdio.log` is the
  startup banner (`src/mcpStdio.ts` L31-32). So "no tool calls in the log" is **not**
  evidence of failure; it's a logging gap.
- The Codex log shows it using the **`.ps1` path** — but that only proves the scripts are
  used (AGENTS.md mandates them regardless of the bridge), not that MCP is broken.

**Conclusion:** the user's hypothesis ("maybe MCP didn't work, so we fell back to
scripts") is currently *unfalsifiable*. That is sufficient reason **not** to delete the
scripts yet. We must instrument and run a controlled test.

---

## 3. TODOs (do these in order, in the new session)

### TODO 1 — Instrument the MCP server so tool calls are observable *(prereq for everything)*
- [ ] In `src/mcpStdio.ts`, at the top of the `CallToolRequestSchema` handler (L124-127),
      append a line to `mcpstdio.log`: timestamp + `tool=<request.params.name>` +
      `agent=<args.agent>`. Reuse the existing `appendFileSync` pattern (L31-32).
- [ ] Rebuild (`npm run compile` / package) so the running extension uses it.
- **Risk:** none (additive logging). **Why first:** without it we stay blind.

### TODO 2 — Make the test honest (remove the silent fallback)
- [ ] Temporarily edit `AGENTS.md` to instruct Codex to use the **AgentWatch MCP tools**
      and to **NOT** run `agent-watch.ps1` / `agent-bridge.ps1`. (Keep a copy of the
      current AGENTS.md so it can be restored if MCP fails the test.)
- **Why:** otherwise Codex keeps using scripts and we never learn if it *can* use MCP.

### TODO 3 — Run the managed Codex bridge and confirm MCP registration
- [ ] Start the Codex bridge (AgentWatch panel → connect Codex), confirm in
      `.coordination/codex-bridge.log` that the app-server launched with the
      `mcp_servers.agentwatch` config and Codex **discovered** the agentwatch tools
      (codex logs tool discovery).

### TODO 4 — Drive a real board event and capture proof
- [ ] Post a task / @mention codex on the board.
- [ ] Confirm `mcpstdio.log` now shows `tool=board_check`, `tool=post`, … (from TODO 1).
- [ ] Confirm the Codex extension log shows `mcp__agentwatch__*` calls **instead of**
      `agent-bridge.ps1` via the shell router.

### TODO 5 — Exercise every tool the scripts cover (full parity in practice)
- [ ] `board_check`, `post`, `claim`, `release`, `get_status`, `ack_command`,
      `resolve_command` — each must round-trip (board files update; Codex sees results).
- [ ] **STOP/blocking path (most important):** with an open command, confirm
      `board_check` returns `BLOCKED` (`src/mcpStdio.ts` L133-135) and Codex honors it.
      This is the MCP equivalent of `agent-watch.ps1`'s exit-non-zero halt — it MUST work
      before the scripts can be retired.

### TODO 6 — Feature-parity audit (capabilities, not just round-trips)
- [ ] Compare script actions vs MCP tools and confirm nothing Codex relies on is lost:
  - Scripts (`agent-bridge.ps1` ValidateSet): `claim, release, status, post, history,
    clear-expired, command, ack, commands, resolve` + `agent-watch.ps1` (check/loop).
  - MCP tools: `board_check, get_status, post, claim, release, ack_command,
    resolve_command, dispatch_subagent, list_models`.
  - **Known gaps to decide on:** MCP has no `command` (create a STOP), no `clear-expired`,
    no explicit `history`/`commands` list (overlapped by `board_check`/`get_status`).
    These are operator/maintenance actions a *worker* agent shouldn't need — confirm, and
    document the decision.

### TODO 7 — Audit cross-implementation locking
- [ ] Verify `agent-bridge.ps1`'s lock (`agent-bridge.ps1` L68) and the TS bridge's
      `withLock` (`src/bridge.ts`) cannot corrupt the JSON when a script write races an
      MCP write. If they use different lock files/mechanisms, this is a real bug
      independent of the migration.

### TODO 8 — Decide & execute the migration (only if TODOs 4-7 pass)
- [ ] **Target (recommended): MCP-only for both agents.** Rewrite `AGENTS.md` so Codex
      uses the MCP tools (matching Claude). **Demote, do not delete** the scripts: keep
      them as a documented *human debugging CLI*, not the agent's instructed path.
- [ ] Also fix the legacy README/`SHARED_AGENT_PROMPT.md`/`BOARD_INFO.md`/
      `AGENT_COORDINATION.md` references (grep: 6 files reference the scripts) so docs are
      consistent.

### TODO 9 — Fallback fix (do this regardless, if migration is deferred)
- [ ] If we keep the script path for now, at minimum fix the prose↔verb mismatch in
      `AGENTS.md`: show the exact `history` (recent events) and `status` (active claims)
      commands so Codex stops erroring on `-Action recent` / `-Action claims`.

---

## 4. Unrelated-but-active issue surfaced during this investigation

- There is an **OPEN operator STOP** command blocking all agents:
  `commands.json` → id `192a49f3-4937-465d-a27f-1573801cf3f7`, created
  2026-06-04T08:04:31Z, `status: "open"`. Until resolved, Codex (via the scripts) and
  any MCP `board_check` will report BLOCKED.
- [ ] Resolve it when ready: AgentWatch panel, or
      `pwsh scripts/agent-bridge.ps1 -Action resolve -CommandId 192a49f3-4937-465d-a27f-1573801cf3f7 -Agent user`.
  (This is independent of the migration; it just un-sticks the board.)

---

## 5. Key files (quick reference)

- `AGENTS.md` — Codex's instructions; the script-path source (L46-110).
- `scripts/agent-bridge.ps1` — legacy write CLI; `ValidateSet` at L3, lock at L68.
- `scripts/agent-watch.ps1` — legacy board watcher; blocking-command exit at L150-158.
- `scripts/codex-auto-bridge.js` — managed bridge; MCP injection at L370-377, prompt L230/L470.
- `src/mcpStdio.ts` — MCP server; tool handler L124-182 (NO logging yet), `BLOCKED` L133-135.
- `src/bridge.ts` — TS board implementation (`post` L94, locking via `withLock`).
- `scripts/claude-auto-bridge.js` — Claude bridge; MCP-tools system prompt.
