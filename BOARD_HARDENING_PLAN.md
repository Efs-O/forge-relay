# Board hardening — impl plan (from md2html prodtest findings)

Three independent workstreams surfaced by the 2026-06-13 md2html production-line
test (see Forge `project_prodtest_md2html` memory). Small, low-risk, no schema
or API changes.

---

## A. Forge — strip ANSI from exec output (+ suppress color at source)

**Why:** worker `run_command` (vitest etc.) emits ANSI color codes that flow raw
to the board *and* into the worker's own context (token waste + unreadable). No
stripping exists anywhere today.

**Repo:** Forge. **Owner file:** `src/tools/execHelpers.ts` (155 LOC, fits).

**Changes:**
1. Add `stripAnsi(s: string): string` (standard CSI/OSC regex).
2. `formatOutput()` — strip stdout/stderr **before** the `MAX_OUTPUT_CHARS` slice
   (slicing mid-escape would leave garbage; stripping first also reclaims budget).
3. `spawnAndWait()` — pass `env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }`
   so most tools emit no codes in the first place. (Do **not** set `CI=true` — it
   changes some runners' semantics.) Stripping stays the guarantee for tools that
   ignore the env.

**Test:** add `stripAnsi` unit coverage (pure fn) in the Forge test suite.

**Acceptance:** `npx tsc --noEmit` clean; a `run_command` of `vitest run` posts
plain text (no `[36m`/`\x1b`).

---

## B. forge-relay — fix Ctrl+C selection copy on the board

**Why:** mouse-select + Ctrl+C does nothing (user-confirmed). The row-level
**Copy** button works; manual selection copy doesn't.

**Repo:** forge-relay. **Owner file:** `media/board.js`.

**Root cause:** the current handler intercepts `keydown` Ctrl/Cmd+C and reads
`window.getSelection()` — fragile in a webview (selection/focus race, key
swallowed). The canonical hook is the native **`copy`** event, which fires once
the browser has committed a copy and the selection is current.

**Change:** replace the `keydown` Ctrl+C handler (board.js ~548–567) with a
`document.addEventListener('copy', …)` that, when the target isn't editable and
the selection is non-empty, writes the selection to `event.clipboardData` and
`preventDefault()`s. Keep `isEditableTarget` guard. Row Copy button unchanged.

**Acceptance:** after reinstall, select text in the event feed + Ctrl+C →
"Selection copied" and clipboard holds the selection. (Webview-only behavior —
verify live; can't be unit-tested headless.)

---

## C. forge-relay — `BOARD_COORDINATOR.md` standing operating manual

**Why:** the coordinator currently improvises per-prompt. Move durable, project-
agnostic operating rules into one standing file it reads every run; per-project
`PLAN.md` shrinks to just the product contract.

**Repo:** forge-relay (the board lives here). **New file:** `BOARD_COORDINATOR.md`.

**Sections (all from prodtest findings + prior sessions):**
- Role & phased workflow (Phase 0 scaffold *yourself* → 1 dispatch → 2 integrate+verify).
- File discipline (isolated untracked build dir; claim before write; release on green; never write outside a claim).
- **Model selection** — pre-flight PONG+timing probe before Phase 1; roster policy
  local-reliable → paid-cloud-that-passes-probe → **never free**; reuse-resident
  clanker before swapping (single local VRAM slot); known-bad list.
- **Verification** — coordinator re-verifies each module with an *isolated full*
  run; never trust a worker's own `vitest run <file>` (concurrent "No test suite
  found" transient).
- Timeouts/monitoring — per-dispatch wall-clock budget (120 s), step-limit
  awareness, tok/s floor.
- Failure handling — re-dispatch once on cold-start empty; 2× empty/500 ⇒ mark
  model dead, pick next; local won't load ⇒ reuse resident; release leaked holds.
- Lock-storm check — board *writes* time out while reads work ⇒ duplicate relay
  MCP procs ⇒ kill dups.
- Termination — post final summary + **STOP** at Definition of Done; don't wait
  for a user message.

**Board prompt becomes:** "Read `BOARD_COORDINATOR.md` (how you operate) and
`PLAN.md` (this product). Execute."

**Acceptance:** file < 350 LOC; covers every rule above.

---

## Build / ship notes
- Forge change is TS → `npm run package` (esbuild) to bundle; reinstall VSIX.
- `media/board.js` is raw webview JS shipped as-is → reinstall the relay VSIX to
  pick it up.
- `BOARD_COORDINATOR.md` is a doc — effective immediately once referenced by the
  board prompt; no rebuild needed.
