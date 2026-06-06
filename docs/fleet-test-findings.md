# Fleet-test findings — Forge-route run (2026-06-02)

Action items for AgentWatch from the first real fleet run: a SOTA coordinator
(claude) decomposed a 12-module build and dispatched it to local workers
(`gemma4-26b-a4b-it-iq3s`) through the Forge control route, in an external
sandbox (`fleet-test`, outside this repo).

## Outcome — it worked
- **12/12 modules built, 73/73 pytest passing.** Local fleet produced correct,
  tested code.
- **Forge route held:** worker dispatches went through `/ensure → run → /release`,
  **zero `fetch failed`**, Forge model `/release` fired ~12×, and **one clean
  `409 busy`** handled correctly (no crash). The model-control bridge is solid.

So the bridge + worker tier are validated for this task class. The items below
are **AgentWatch-side** gaps, not Forge.

---

## P1 — Board claim release discipline (do before two-coordinator runs)
After workers completed, **8 board claims were left active** (`hex_color`,
`date_diff`, `base64_codec`, `prime_sieve`, `levenshtein`, `json_flatten`,
`units_convert`, `csv_parse`) — work done, files written, but the board still
shows them claimed.

- **Why it matters:** in a two-coordinator run (claude + codex), stale claims
  **block** the other coordinator from those paths. The whole point of claims is
  collision-prevention; leaking them defeats it at the moment Tier 2 needs them.
- **Likely cause:** the coordinator releases the *Forge* model hold (`/release`)
  but does not reliably release the *board claim* after a worker finishes.
- **Fix:** pair every claim with a release in the dispatch lifecycle — release the
  board claim in the same place the worker result is reviewed/finalized, on both
  success and error paths (mirror the Forge `/release` `finally` that already
  works). Consider an auto-release when a claimed worker's subagent completes.

## P2 — `run_command` Windows portability (`spawn ls/mkdir ENOENT`)
Workers repeatedly hit `run_command : spawn error: spawn ls ENOENT` and
`mkdir -p` / `-p already exists` errors. On Windows, `ls` doesn't exist and
`mkdir`/`-p` are shell builtins, not spawnable executables — so bare
`spawn('ls'|'mkdir', ...)` fails and the worker wastes steps fighting the shell.

- This is the **same class** as a bug already fixed elsewhere (bare `spawn('rg')`
  failing where the exe isn't a real PATH binary).
- **Fix options:** run `run_command` through a shell on Windows
  (`cmd /c <cmd>` or `powershell -NoProfile -Command <cmd>`), and/or map common
  POSIX builtins, and/or steer workers to use `write_file` for file/dir creation
  instead of shelling out. The workers recovered via `write_file`, so this is
  efficiency + reliability, not a blocker.

## P3 — Observation: backend `ECONNRESET` under 4-way load (not AgentWatch's fix)
Twice mid-run: `could not reach llama.cpp backend at :8080 … (ECONNRESET)`. The
model server dropped a connection under 4 concurrent slots and recovered; the
build completed. **Note** AgentWatch surfaced this with a clear, actionable
message (good — that's the improved error path working). The underlying cause is
backend-side (likely VRAM/parallel pressure at 128k ctx on a 26B); if it recurs,
it's a Forge/llama-server tuning matter (`n_parallel` / `num_ctx`), not AgentWatch.
Worth logging the subagent id + timestamp so retries are traceable.

---

## What's confirmed working — don't "fix" these
- Forge route resolution (`forge:` / unprefixed → control API).
- `/ensure → dispatch → /release` lifecycle and the `finally` release for the
  Forge model hold.
- `409 busy` handling (clean board post, no crash).
- Clear backend error messages (`ECONNRESET` surfaced, not a bare `fetch failed`).

## Suggested order
1. **P1** (claim release) — required before the two-coordinator Tier 2.
2. **P2** (`run_command` on Windows) — removes wasted worker steps.
3. **P3** — just log/trace; escalate to Forge config only if it recurs.

Also pending (not AgentWatch code): fill `fleet-test/MEASUREMENTS.md` with the
token totals (worker vs coordinator) — that's the cost-ratio number the whole
exercise is for.
