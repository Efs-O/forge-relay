# Note — Codex dispatch concurrency guard

**Status:** active for `codex exec` workers only; managed-runtime use removed in 0.7.0
**Added:** 2026-07-12
**Files touched:** `src/codexExecutionGate.ts`, `src/subagentLoop.ts`, `src/runtimeManager.ts`

## What changed

`dispatch_subagent` calls to a `codex` / `codex:<model>` worker used to spawn an
independent, untracked `codex exec` subprocess with **no queue** — every overlapping
dispatch got its own process racing the others. Added a process-wide `Semaphore(1)`
(`codexProcessSlot`, reusing the `Semaphore` class already in `src/forgeHold.ts`) so Codex
dispatches now run **one at a time**; extra dispatches wait in line instead of
launching concurrently.

The 0.6.x managed-exclusive runtime also held this slot for its full lifetime.
The 0.7.0 managed-isolated architecture removes that acquisition: its standalone
app-server uses a workspace-specific local profile and separately provisioned
OpenAI Platform API-key authentication, so it may coexist with the serialized
worker lane. Worker-to-worker serialization remains unchanged.

## Why

`src/codexWorker.ts` documents the historical risk directly: overlapping
short-lived `codex exec` processes sharing ChatGPT OAuth may race token refresh.
Serializing Relay-dispatched workers keeps that risk bounded without imposing a
machine-wide rule on unrelated Codex processes.
Before this change, nothing in Relay actually enforced that — it only held as long as
dispatches happened to be sequential in practice. We saw evidence of the gap: several
simultaneous test dispatches (`echo hello-sandbox-test`, `npm --version`, etc.) each
showed up as their own untracked Codex session.

Judgment call at the time: we did **not** have confirmation this had already triggered
a `token_revoked` — it was a latent race, not a caught failure. Went ahead on the bet
that serializing is strictly safer and costs little (Codex dispatches are already
usually run one at a time by the orchestrator; the guard only matters when two land
close together).

## Scope and removal

If worker serialization turns out to be unwanted (for example, a future Relay
version gives workers isolated authentication and session pooling):

1. Remove the `acquireCodexProcessSlot()` acquisition and release from
   `runCodex` in `src/subagentLoop.ts`.
2. Delete `src/codexExecutionGate.ts` and this note.

Do not restore the managed runtime's lifetime acquisition. Managed-isolated mode
is designed and tested to coexist with independently authenticated processes;
external Codex PID discovery is informational, not part of this guard.
