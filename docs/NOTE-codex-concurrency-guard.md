# Note — Codex dispatch concurrency guard

**Status:** active
**Added:** 2026-07-12
**Files touched:** `src/codexExecutionGate.ts`, `src/subagentLoop.ts`, `src/runtimeManager.ts`

## What changed

`dispatch_subagent` calls to a `codex` / `codex:<model>` worker used to spawn an
independent, untracked `codex exec` subprocess with **no queue** — every overlapping
dispatch got its own process racing the others. Added a process-wide `Semaphore(1)`
(`codexProcessSlot`, reusing the `Semaphore` class already in `src/forgeHold.ts`) so Codex
dispatches now run **one at a time**; extra dispatches wait in line instead of
launching concurrently. Experimental managed-exclusive mode acquires that same
slot before starting and holds it for the app-server's full lifetime. Therefore
Relay cannot start one of its own `codex exec` workers beside its managed process.

## Why

`src/codexWorker.ts` documents the risk directly: a `codex exec` process is a second
Codex login, and running it concurrently with another Codex process under the same
ChatGPT OAuth subscription has historically risked `refresh_token_reused` /
`token_revoked`, which can kill **both** sessions. Managed Codex is now available
only as an explicit exclusive mode; its lease and process probe fail closed rather
than treating shared-login concurrency as safe.
Before this change, nothing in Relay actually enforced that — it only held as long as
dispatches happened to be sequential in practice. We saw evidence of the gap: several
simultaneous test dispatches (`echo hello-sandbox-test`, `npm --version`, etc.) each
showed up as their own untracked Codex session.

Judgment call at the time: we did **not** have confirmation this had already triggered
a `token_revoked` — it was a latent race, not a caught failure. Went ahead on the bet
that serializing is strictly safer and costs little (Codex dispatches are already
usually run one at a time by the orchestrator; the guard only matters when two land
close together).

## How to revert

If this turns out to be unwanted (e.g. it's serializing dispatches that used to run
fine in parallel, or a future Relay version adds its own Codex session pooling that
conflicts with this):

1. Remove the `acquireCodexProcessSlot()` acquisition and release from
   `runCodex` in `src/subagentLoop.ts`.
2. Remove the managed-runtime acquisition and release in `src/runtimeManager.ts`.
3. Delete `src/codexExecutionGate.ts` and this note.

Do not remove only one caller: that would reintroduce Relay-owned overlap between
managed mode and worker dispatches.
