# Note — Codex dispatch concurrency guard

**Status:** active
**Added:** 2026-07-12
**File touched:** `src/subagentLoop.ts`

## What changed

`dispatch_subagent` calls to a `codex` / `codex:<model>` worker used to spawn an
independent, untracked `codex exec` subprocess with **no queue** — every overlapping
dispatch got its own process racing the others. Added a process-wide `Semaphore(1)`
(`codexSlot`, reusing the `Semaphore` class already in `src/forgeHold.ts`) so Codex
dispatches now run **one at a time**; extra dispatches wait in line instead of
launching concurrently.

## Why

`src/codexWorker.ts` documents the risk directly: a `codex exec` process is a second
Codex login, and running it concurrently with another Codex process under the same
ChatGPT OAuth subscription has historically risked `refresh_token_reused` /
`token_revoked`, which can kill **both** sessions. `runtimeManager.ts` says the same
thing at the top level ("Codex: NEVER spawned by Relay [as a pooled/supervised
process] ... two codex app-servers on one ChatGPT OAuth login trip token_revoked").
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

1. In `src/subagentLoop.ts`, remove the `codexSlot` `Semaphore(1)` definition (near
   `MAX_STEPS_DEFAULT`).
2. Remove the `const releaseSlot = await codexSlot.acquire();` line and the
   `releaseSlot();` call in `runCodex`'s `finally` block.
3. Drop `Semaphore` from the `import { forgeHolds, forgeSlots, Semaphore } from
   './forgeHold';` line (back to `forgeHolds, forgeSlots`).
4. Delete this file.

No other files depend on `codexSlot`; the revert is fully self-contained to
`subagentLoop.ts`.
