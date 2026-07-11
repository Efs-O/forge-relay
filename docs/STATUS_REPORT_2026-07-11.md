# Forge Relay — Status Report & Next-Session Plan

**Date:** 2026-07-11 · **Marketplace:** `Efsoo.forge-relay` **0.4.2** (live) · **Repo:** `Efs-O/forge-relay` @ `0953049`, CI green, 92/92 tests · **Local install:** 0.4.2

## Where we are

Verdict from the 2026-07-11 review session: **engineering is ship-quality; adoption is the whole problem now.**

Proof of the first claim — all of this ran live, first-try, in one session:

- Codex worker live test passed all 5 steps (list_models detection, draft read-only dispatch, clanker edit + git checkpoint, async STOP abort in **1.98s**, `codex:<model>` override).
- Two bugs the test surfaced were fixed, regression-tested, and published same-day (0.4.1).
- A three-backend orchestration built a working game: gemma-4-31b (Cerebras via Forge, seconds) wrote the spec → codex worker (gpt-5.6-sol, ~3 min) built `relay-playground/arcade/neon-orbit/index.html` → gemma reviewed it (verdict SHIP, one genuine finding). Interactive Claude orchestrated via the board throughout.

Proof of the second claim: ~1 install, no ratings, no demo media on the listing since 0.3.26.

## Priority list for the next session

### P1 — Demo GIF for the Marketplace listing (highest leverage, do first)

The listing asks visitors to *believe* the README; a GIF lets them *see* it. Best subject: re-run the
two-agent Neon Orbit build while screen-recording (board posts scrolling: gemma spec post → codex
worker started/done with model names → game window opens). Cut to ~20s. Claude can re-orchestrate
the build on cue; the game already exists at `relay-playground/arcade/neon-orbit/` as a dry-run target.
Recording + editing is user-side; wiring it into README/gallery is Claude-side.

### P2 — First-run failure polish (silent failure modes = uninstalls)

- **Auto-detect the codex path** when the extension-host PATH probe fails: before giving up, try
  `%APPDATA%\npm\codex.cmd` (and the npm global prefix) and suggest/set `forgeRelay.codexExecutable`.
  Today the error tells the user the setting name but makes them find the path themselves.
- Review the other known first-run traps with the same lens: Forge backend needs a manual
  `Forge: Start Backend`; ollama daemon quirks. Verify Setup covers detection — the gap is
  *actionable remediation* in the error messages themselves.

### P3 — Board UI observations plan (approved-pending since 2026-06-04)

`docs/BOARD_UI_OBSERVATIONS_PLAN.md` — still unimplemented: source-side 300-char post truncation
(`.slice(0,300)`), hardcoded worker numbering, webview swallowing Ctrl+C. Small items, all UX.
Model names on worker posts (0.4.1) partially overlaps — re-read the plan before starting.

### P4 — Watchlist (no action yet, keep eyes on)

- **Mode B keep-alive economics**: pings are capped now, but need real-world soak time before
  calling the idle-cost story settled. 0.4.2 made Mode B the default, so exposure went up.
- **2-tier dispatch wall**: workers never get `dispatch_subagent` (deliberate). First architectural
  ceiling a power user hits; Run D's Opus-mediated relay is the workaround. Revisit only if a
  concrete orchestration needs it.
- **Multi-provider friction #5**: deepseek 403 on uncatalogued model — open, minor/cosmetic.

## Durable gotchas (do not "fix" these — they are load-bearing)

- `codex exec` **hangs forever on an open piped stdin** — the backend passes the prompt via stdin
  and calls `stdin.end()` (explicit EOF). Any refactor must keep that.
- Windows codex spawn: npm `.cmd` shim → `shell:true` + manual quoting + `taskkill /pid <pid> /T /F`.
  The DEP0190 deprecation warning is cosmetic. Don't "clean up" this combination.
- ONE codex process per ChatGPT OAuth login for *long-lived* servers (two → token_revoked).
  Short-lived `codex exec` coexists fine with an interactive Codex session (E2E-verified).
- Codex default model comes from the user's `~/.codex/config.toml` (`gpt-5.6-sol`); Relay never
  picks it. `codex:<model>` is the only override path.
- `withLock` must let `fn()` errors propagate (fixed 0.4.1 — retrying a throwing fn burned the
  timeout and misreported as a lock failure). `resolve_command`/`ack_command` accept ≥6-char
  unique id prefixes because the board displays truncated ids.

## Session log (what shipped 2026-07-11)

| Version | Contents | Status |
|---|---|---|
| 0.4.1 | withLock error propagation; command-id prefix accept; model names on codex worker posts; `tests/bridgeCommands.test.ts` | Published (commit `e1c9790`) |
| 0.4.2 | Session-start dialog: headless bridge (Mode B) is the checked default, plain-language labels replace Mode A/B jargon; board detail line reworded | Published (commit `0953049`) |

Also committed: `relay-playground/arcade/neon-orbit/index.html` (two-agent demo artifact, excluded
from the VSIX). Known minor issue in it: line-obstacle hitbox length scales with velocity while the
visual doesn't (gemma's review finding) — fine for a demo, fix only if it becomes the GIF star.
