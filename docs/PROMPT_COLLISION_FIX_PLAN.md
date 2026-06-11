# Forge Relay — Worker System-Prompt Collision Fix (Relay-side plan)

Status: PLAN ONLY — for user review. No code changes until approved.
Owner: claude (forge-relay repo). Companion plan: Forge repo (`app.py` caller-wins +
`bridge.yaml` refactor) owned by claude-code.
Date: 2026-06-08

---

## 1. Problem (shared context)

When Forge Relay dispatches a worker subagent to a local GGUF model, **two system
prompts collide**:

1. Relay sends its own worker system prompt (`src/subagentLoop.ts:48` →
   `systemPrompt()`, emitted as `messages[0]` at `src/subagentLoop.ts:76`).
2. The Forge Python bridge injects `system_prompt` from `bridge.yaml`
   (`app.py` `_merge_system_prompt_into_messages`, appends with a double newline).

The model receives both concatenated, blurring its role instructions.

### Route dependency (verified together on the board, 2026-06-08)

The collision is **route-dependent**:

- **Control / DirectBackend** → `/ensure` returns a raw `llama-server` baseUrl.
  Requests never pass through `app.py`, so **no injection, no collision**.
- **Python bridge** → requests traverse `app.py`, which injects the `bridge.yaml`
  prompt, so the **collision is real**.

**Verified against the on-disk config (claude, 2026-06-08):** the active
`Forge/.forge/config.yaml` has **no `bridge_mode` field** (active_model
`gemma4-26b-a4b-it-iq3s`, `control_server` port 8799). `schema.ts:146` is
`z.boolean().optional()` with no default → `config.bridge_mode` is falsy →
`extension.ts:144` takes the **ELSE** branch → `new BackendPool(config)` →
**DirectBackend**. So this user's **default local-gguf workers do NOT traverse the
Python bridge** — `app.py` never runs and `bridge.yaml` `system_prompt` is ignored
on that path. **There is no double-prompt for the default local-gguf worker path.**

An earlier claim that this user runs `bridge_mode: true` (→ collision) was **not**
borne out by the config and is retracted. Note also that even the `bridge_mode`
TRUE branch builds `BridgeBackend` at `llama_server.host:port` (default 8080), not
`:9099` (`extension.ts:147`), so the exact "`:9099` = `app.py`" mapping is a
Forge-side detail still to be pinned down.

**Where the collision actually applies:** only workers that genuinely traverse the
Python bridge — cloud / Ollama models, or an explicit `forge:bridge` route. The
fix is worth shipping for that path; it is a no-op for control-route local ggufs.

**Decisive runtime proof** (do this before relying on either reading): log
`resolved.baseUrl` at dispatch. Raw llama-server port → no collision; Python-bridge
endpoint → collision.

## 2. Confirmed facts on the Relay side

- `decideForgeRoute()` (`src/subagent.ts:476`) routes a plain Forge model name to
  `kind: 'forge-control'` when it matches the control catalog (`:510`); Relay then
  calls `forgeEnsure()` and dispatches straight to the returned `baseUrl`.
- The control branch carries **no** routing note; the bridge branch tags
  `' (via Forge bridge)'` (`src/subagent.ts:523`). Memory records live workers
  logging `"(via Forge)"`, i.e. the control route. With the active config
  (no `bridge_mode`), that control route resolves to DirectBackend / raw
  llama-server, so those workers never reach `app.py`.
- `runWorkerLoop()` **always** prepends a system message:
  `{ role: 'system', content: systemPrompt(ctx.autonomy) }` (`src/subagentLoop.ts:75-78`),
  and `systemPrompt()` always returns a non-empty string (`:48-58`).

## 3. Agreed fix (cross-repo)

**Primary fix is Forge-side, not Relay-side:** `app.py` adopts **caller-wins** —
inject the `bridge.yaml` prompt **only when the incoming request has no system
message**. This is route-agnostic, needs no per-model YAML, and handles dual-role
models (a model used both standalone and as a worker) with a single entry.

Consensus refinements (from board):
- Keep injection **single-sourced**: caller-wins is the *only* gate. Any future
  explicit `role:` field in a model entry stays **documentary** — it must never be
  a second switch on injection, or it recreates the absence-of-field fragility.
- `app.py` must detect a system message **robustly**: a message with
  `role == "system"` **and** non-empty / non-whitespace content. A stray empty
  system message must not suppress injection.

## 4. What the Relay repo must do

The caller-wins fix depends on an **invariant that lives in this repo**: Relay must
*always* send a non-empty system message for every worker dispatch, or `app.py`
would (correctly) fall back to injecting the `bridge.yaml` prompt and the worker
would silently get the wrong instructions.

### 4.1 Guarantee the invariant (primary Relay work)

- Keep `runWorkerLoop()` always emitting `messages[0]` as a non-empty system
  message (already true at `src/subagentLoop.ts:75-78`).
- Add a small assertion/guard so a future refactor cannot drop or blank it
  (e.g. ensure `systemPrompt()` output is non-empty before building `messages`).

### 4.2 Regression test (primary Relay work)

Add a test asserting that, for both autonomy modes (`draft`, `clanker`):
- `messages[0].role === 'system'`
- `messages[0].content` is a non-empty, non-whitespace string

This locks the contract the Forge caller-wins fix relies on. Place alongside the
existing worker/bridge tests (`tests/workerBoardUi.test.ts`, `tests/*Bridge*`).

### 4.3 Guardrail-migration contingency (conditional)

Before the Forge side ships caller-wins, confirm (claude-code) whether the current
`bridge.yaml` worker/model prompts carry **must-always-apply** content (safety
rails, output-format constraints). caller-wins will **silently drop** those for
workers.

- If they carry nothing critical → no action here.
- If they do → fold that content into Relay's worker prompt
  (`src/subagentLoop.ts:48`, `systemPrompt()`) so nothing is lost. This is the only
  scenario that changes Relay *behaviour* rather than just adding a guard/test.

### 4.4 Documentation

Add a short note (here and/or near `systemPrompt()`) recording the cross-repo
contract: *"Relay always sends a non-empty system message; Forge `app.py` injects
its prompt only when none is present."* So neither side silently breaks the other.

## 5. Out of scope (Relay plan)

- `app.py` caller-wins change — **Forge repo** (claude-code).
- `bridge.yaml` restructure (`bridge/providers/runtime_defaults/runtimes/`
  `sampling_profiles/prompts/models`) — **Forge repo** (claude-code).
- Any change to Relay's routing logic — the routing is correct; only the prompt
  contract matters here.

## 6. Verification

1. (Forge) Apply caller-wins in `app.py`; unit-test "inject only when no system msg".
2. (Relay) Run the new regression test (4.2) — green.
3. Live: dispatch one worker in `bridge_mode`, capture the prompt the model
   actually receives (or `app.py` debug log) — confirm exactly **one** system
   prompt (Relay's), no double newline concatenation.
4. Regression: a *standalone* call to the same model (no system msg) still gets the
   `bridge.yaml` prompt injected.

## 7. Risks / edge cases

- **Empty/whitespace system msg** suppressing injection → covered by 3 (robust
  detection) + 4.2 (non-empty assertion).
- **Dual-role model** (standalone agent + worker, one entry) → caller-wins handles
  it natively; no duplicate entries needed.
- **Lost guardrails** → covered by 4.3 contingency.
- **Direct-mode users** → unaffected (no `app.py` in path); fix is a safe no-op for
  them.

---

## 8. Step summary (Relay repo, after approval)

1. Add non-empty-system-message guard in `runWorkerLoop()` / `systemPrompt()`.
2. Add regression test (both autonomy modes).
3. (Conditional) migrate any critical `bridge.yaml` guardrails into `systemPrompt()`.
4. Add cross-repo contract doc note.
5. `npm run` typecheck + build + tests green; coordinate ship with Forge-side change.
