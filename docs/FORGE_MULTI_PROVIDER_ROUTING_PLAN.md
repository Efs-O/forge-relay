# Forge Multi-Provider Routing Plan + Board UI Observations

> Historical diagnosis and migration note. Do not use this file as the active
> implementation spec. Use
> [FORGE_ROUTING_CONSOLIDATED_PLAN.md](./FORGE_ROUTING_CONSOLIDATED_PLAN.md)
> for current-state routing decisions, shipped work, remaining gaps, and the
> implementation TODO.

**Status:** PLAN ONLY — no code written yet. Captured 2026-06-04 after the 8-worker
Forge Arcade run failed (all 8 workers timed out; see "How we got here").
Superseded in practice by the consolidated implementation doc above; the
"PLAN ONLY" wording below is no longer accurate because parts of this work have
since landed in code.

**Decision update:** approved in principle, but only with the constraints in
Section 4.5 and Section 6.4/6.5 below. The diagnosis is good; the route
resolution rules need tightening before implementation.

---

## 1. The goal (in one sentence)

AgentWatch must be able to **call every model from every location** — local GGUF,
Ollama, xAI/Grok, OpenRouter, and any future provider — by routing each model to the
**correct Forge port automatically**, so the orchestrator just names a model and it
works regardless of where that model physically runs.

---

## 2. How we got here (today's failure, short version)

- We dispatched 8 parallel local-Gemma workers, but they were routed with an explicit
  **`direct:` prefix** (equivalently, the default backend resolved to `direct`), so each
  one talked **straight to the raw llama-server on :8080**, bypassing Forge entirely.
  One bare llama-server cannot take 8 simultaneous requests; every worker hit
  `UND_ERR_HEADERS_TIMEOUT` and produced **zero files**. We killed the llama-server
  (PID was on :8080) to stop the wedged workers.
- Important: this was **not** an automatic "Forge looked down, so we fell back to
  direct" event — no such fallback exists in the code. `dispatch_subagent` only health-
  checks the Forge **control** port (8799) and, if that route is requested and
  unreachable, it **aborts with a clear "not dispatched" message** rather than rerouting
  (`subagentLoop.ts` ~L211). A `direct:8080` pile-up can only come from an explicit
  `direct:` prefix or `subagentDefaultBackend: 'direct'`. This is the same hand-picked-
  prefix misroute that §6.5 is meant to eliminate.
- Root cause was **routing/wiring, not the model** — the engine was healthy the whole
  time (token usage was streaming in its terminal).

---

## 3. Forge's two ports — confirmed architecture

Forge exposes **two different doors** with **different jobs** (verified in
`N:/vs code apps/Forge/.forge/config.yaml` and `N:/vs code apps/Forge/bridge.yaml`):

| Port | Forge role | Serves | Notes |
|------|-----------|--------|-------|
| **8799** | `control_server` (config.yaml) | **Local GGUF only** | Model-control API for external orchestrators. Loads a local model on demand, waits until healthy, hands back its engine endpoint. Cannot serve cloud models (nothing local to "load"). **Was UP the whole time.** |
| **9099** | bridge gateway (bridge.yaml `bind_port`) | **Everything** — local llama, Ollama, xAI/Grok, OpenRouter | Single OpenAI-compatible endpoint + single API key. The **only** door that reaches the cloud/API providers. **Was NOT running.** |

Supporting facts from `bridge.yaml` (718 lines):
- `api_key: "forge-local-change-me"`, `bind_host: 127.0.0.1`, `bind_port: 9099`.
- `llama_server.port: 8080` (spawns engines on 8080, 8081, …), `n_parallel: 8`,
  `max_simultaneous_models: 4`.
- Declared providers: **20 × `ollama`**, **6 × `openrouter`** (`https://openrouter.ai/api/v1`,
  key from VS Code SecretStorage), **5 × `xai`/Grok** (`https://api.x.ai`, key from
  SecretStorage), plus the local llama GGUFs (gemma4 family).

**They are complementary, not duplicates.** 8799 = "run my local GPU models with
lifecycle + parallel management." 9099 = "one socket to reach every model, local or cloud."

---

## 4. Target routing design

The orchestrator should name **any** model; AgentWatch resolves the provider and routes
to the correct port:

| Model class | Route | Endpoint |
|-------------|-------|----------|
| Local GGUF (e.g. `gemma4-26b-a4b-it-iq3s`, `gemma4-e4b-it-ud-q4kxl`) | Forge **control** | `subagentForgeControlUrl` = `http://127.0.0.1:8799` → `/ensure` → talk to the engine it returns |
| Ollama (`provider: ollama`) | Forge **bridge** | `subagentBridgeUrl` = `http://127.0.0.1:9099/v1` |
| xAI / Grok (`provider: xai`) | Forge **bridge** | same 9099 |
| OpenRouter (`provider: openrouter`) | Forge **bridge** | same 9099 |
| any future remote provider | Forge **bridge** | same 9099 |

**Why split this way (per owner):** local models benefit from 8799's load-on-demand +
8-parallel orchestration; remote/cloud models have no local engine to manage, so they
*must* go through the 9099 gateway, which already knows how to forward to each provider.

### 4.1 Keep explicit prefixes as an override path

The current explicit prefixes still matter and should remain supported:

- `forge:<model>` = force Forge control routing
- `bridge:<model>` = force raw 9099 routing
- `ollama:<model>` = force raw 11434 routing
- `direct:<model>` = force raw 8080 routing

These are still needed for:

- debugging a routing bug
- bypassing auto-routing intentionally
- comparing Forge-routed vs raw-backend behavior

Auto-routing should be the default, not the only path.

### 4.2 Canonical internal identity vs. friendly display name

The orchestrator should be allowed to work with a friendly model label, but the
dispatcher must resolve that label to a **canonical internal target** before any
request is sent.

Examples:

- friendly display: `gemma4-e4b-it-ud-q4kxl`
- canonical target: `forge-control:gemma4-e4b-it-ud-q4kxl`
- friendly display: `grok-3-mini`
- canonical target: `forge-bridge:xai:grok-3-mini`

This avoids "bare name guessed the wrong provider" failures when different
providers expose similar or identical names.

### 4.3 Ambiguity rule

If two routes can legally serve the same visible model name, AgentWatch must **not**
guess.

Required behavior:

- if the model name resolves uniquely, dispatch normally
- if the name is ambiguous, fail with a clear message listing the valid canonical
  targets
- the orchestrator can then retry with the exact prefixed/canonical form

This is safer than trying to encode hidden heuristics into the model name alone.

### 4.4 Forge should be the source of provider metadata

The preferred source of truth is a Forge-served catalog that includes provider or
route metadata, not filename conventions and not a hardcoded AgentWatch-side map.

Priority order:

1. A live Forge endpoint that reports model plus provider/route metadata.
2. If Forge cannot provide that yet, a temporary parsed catalog from Forge config.
3. Naming convention heuristics only as a short-term fallback, never as the final design.

Reason: the whole point of this plan is to stop AgentWatch from guessing.

### 4.5 Scope boundary for concurrency rules

The concurrency rules in this plan apply differently by route:

- **Forge control / local GGUF path (8799):** enforce same-model slot caps and shared
  holds, because one local engine/load lifecycle is being managed.
- **Forge bridge path (9099):** do **not** automatically apply the same slot logic
  unless Forge explicitly exposes equivalent provider-aware capacity semantics for
  that route.

In other words, "8 workers on one local GGUF" and "8 requests through the cloud-capable
9099 bridge" are not the same scheduling problem and should not be treated as one.

---

## 5. Model selection policy (what "pick whatever you like" means)

After routing works, the orchestrator can name **any** model and it resolves correctly —
so the owner does **not** have to specify names. But a model still has to be *chosen* on
every dispatch, so "whatever they like" needs a **default-pick policy**, or it is
undefined (and risks burning paid credits / tripping cloud rate limits).

### 5.1 Who chooses
- The **orchestrator** (claude / codex) chooses by filling the `model` arg. A **worker**
  does not pick its own model — it *is* a model — unless it is explicitly given the
  dispatch tool plus this same policy (out of scope for v1).
- Modes:
  - **Named** — owner/orchestrator passes an exact model id → use it as-is (routed by §4).
  - **Auto** — owner says "you choose" / no id given → orchestrator applies the rules below.

### 5.2 Default-pick rules (Auto mode)
1. **Local-first.** Default to local GGUF models (e.g. `gemma4-*`) via the 8799 control
   route. They are free, unlimited, and private — correct for bulk/parallel work like the
   8-game fan-out.
2. **Cloud only on request.** Never auto-select a paid/cloud model. xAI/Grok and paid
   OpenRouter cost money per call; reach them only when the owner explicitly names one or
   says "use a cloud/Grok/OpenRouter model for this."
3. **Free OpenRouter = single, shared, rate-limited.** Treat `:free` OpenRouter slugs as a
   scarce resource: at most **one** in flight at a time (account-wide ~20 req/min + daily
   cap). Never fan 8 workers onto a free cloud model.
4. **Match model to task size.** Prefer a smaller/faster local model (e.g. `e4b`) for many
   small parallel jobs; reserve the larger local model (e.g. `26b-a4b`) or a cloud model
   for a single hard task.
5. **Capability gates.** If a task needs tool-calling or vision, pick only models that
   support it (bridge.yaml flags some Grok variants as "chat only / no tool_call").

### 5.3 Concurrency guardrails (ties into §7.3)
- Honor Forge's limits: `n_parallel: 8` per spawned engine, `max_simultaneous_models: 4`.
- Cap **same-model** fan-out at the engine's parallel slots; queue the remainder rather
  than dumping all at once (today's pileup was 8 → 1 raw engine with no cap).
- Spreading work across **different** local models is fine up to `max_simultaneous_models`.

### 5.4 Fallback behavior
- If the preferred route is unavailable (e.g. 9099 down, or a cloud key missing), **do not
  silently fall through to a worse route** (that is exactly how today's `direct:` misroute
  happened). Surface the unavailability and either pick another *allowed* model per the
  rules or stop and report.

### 5.5 Owner decisions still open
- Should Auto mode ever be allowed to choose a **paid** model without asking, given a
  budget cap? (Default proposed: **no** — always ask.)
- A named **allowlist** of "auto-eligible" models, vs. "all local + nothing cloud"?

---

## 6. Required patches / action items (NOT yet applied)

### 6.1 API key mismatch — **MUST FIX** (blocking for 9099)
- Forge `bridge.yaml` expects `api_key: "forge-local-change-me"`.
- AgentWatch is set to `agentwatch.subagentBridgeApiKey: "continue-local-change-me"`.
- These **must be identical** or 9099 rejects AgentWatch (401). Until then, no Ollama /
  Grok / OpenRouter model is reachable.
- **Fix:** set `agentwatch.subagentBridgeApiKey` = `forge-local-change-me` (in
  `.vscode/settings.json` and/or global user settings). One-line config change.
  **APPLIED 2026-06-04** in workspace `.vscode/settings.json`. (Verify global user
  settings too if AgentWatch is run from other workspaces.)

### 6.2 Bridge URL config
- `agentwatch.subagentBridgeUrl` is **not set**, so it uses the default
  `http://127.0.0.1:9099/v1`. That default is correct — keep it, but make it explicit in
  settings to avoid future confusion.

### 6.3 Start the 9099 bridge (operational, not code)
- The bridge gateway process must actually be running for any 9099 route to work. Today
  it was down. Need a reliable way to ensure it's up (Forge command / startup) before
  AgentWatch routes cloud models.

### 6.4 Unify model discovery (`list_models`)
- Current `listModels()` probes `bridge(9099) / ollama(11434) / direct(8080)` and — when
  `forgeControlUrl` is set — **also** the Forge control port (8799), listed first
  (`subagent.ts` L286-302). So local GGUFs stay visible via 8799 even with 9099 down;
  what disappears when 9099 is down is the **cloud/Ollama-behind-9099 catalog** (Ollama,
  Grok, OpenRouter).
- Open tension to resolve: the raw `ollama(11434)` and `direct(8080)` probes are a
  *different* path than Forge's own Ollama provider reached via 9099. The "one merged
  catalog" target must decide whether those raw probes stay or are dropped in favor of
  the unified 9099 list, or `list_models` will show duplicate/competing entries.
- Target: `list_models` should present **one merged catalog** of every callable model
  with its resolved route, sourced from Forge (9099 `/v1/models` for the full list; local
  GGUFs flagged for the 8799 control route).
- Important compatibility rule: this must be shipped together with updated
  `dispatch_subagent` help text and bridge prompts. Today the tool contract teaches
  orchestrators to pass `"<backend>:<model>"`, so changing discovery without changing
  the prompts would create mixed routing behavior.
- Recommended output shape:
  - user-facing display label
  - canonical internal route target
  - provider/backend metadata
  - route note such as `via forge control` or `via forge bridge`
- The orchestrator should never have to guess a backend prefix, but the explicit
  prefixed forms should remain valid as an override/debug path.

### 6.5 Auto-routing by model identity
- AgentWatch needs a **model → provider/port map** so a bare model name auto-resolves to
  8799 (local) vs 9099 (everything else), instead of the orchestrator hand-picking
  `direct:` / `bridge:` prefixes (which is what caused today's misroute).
- **Function to change: `forgeRoute()` in `src/subagent.ts` (L94-104).** Today it sends
  *every* unprefixed id to the 8799 control route whenever `forgeControlUrl` is set — so
  an unprefixed **cloud** model name hits 8799 `/ensure` and 404s (8799 only knows local
  GGUFs). The fix is to consult the provider map: local GGUF → 8799, everything else →
  9099, before defaulting.
- Source of truth options (decide in design): (a) read Forge `bridge.yaml` `provider:`
  fields, (b) a Forge endpoint that returns provider per model, or (c) convention
  (local GGUF ids vs. everything from 9099).
- Recommended decision: prefer **live Forge metadata** over AgentWatch-side convention.
- Required safety rule: if the provider map is stale, missing, or ambiguous, dispatch
  must fail loudly instead of silently picking a route.

### 6.6 Ship the contract change as one bundle

If this plan lands, these pieces should change together in one implementation pass:

- `list_models` output and wording
- `dispatch_subagent` description/help text
- Claude bridge prompt/tool guidance
- Codex bridge prompt/tool guidance
- any README/operator instructions that still teach explicit backend-prefixed selection

Reason: routing and discovery are one contract. Partial rollout would leave the
orchestrators speaking the old language to a new resolver.

---

## 7. Open questions (decide before coding)

1. **Local models:** route via 8799 control only, or allow 9099 as a fallback when the
   control route is busy/unavailable?
2. **Model map source:** parse `bridge.yaml`, or query a Forge endpoint live? (Live query
   avoids drift if the YAML changes.)
3. **Concurrency caps:** with `n_parallel: 8` and `max_simultaneous_models: 4`, how many
   AgentWatch workers may target one model / one engine before we throttle? (Today's
   pileup says we need a cap.)
4. **Secrets:** Grok/OpenRouter keys live in Forge's VS Code SecretStorage, not in
   AgentWatch — confirm 9099 injects them so AgentWatch never handles cloud keys directly.
5. **Ambiguous names:** what exact error/UX do we show when two providers expose the same
   visible model label?
6. **Catalog contract:** what canonical route format do we want AgentWatch to store
   internally once `list_models` stops being just `"<backend>:<model>"` lines?

## 7.1 Recommended decisions

If we want the shortest safe path, the recommended choices are:

1. **No silent 9099 fallback for local models.** If Forge control is required and unavailable,
   fail clearly instead of rerouting.
2. **Use live Forge metadata if possible.** Parsing YAML is an acceptable temporary bridge,
   not the desired steady state.
3. **Keep explicit prefixes forever.** Auto-routing becomes the default UX, not a mandatory one.
4. **Fail on ambiguity.** Never guess between two valid provider matches.
5. **Bundle the contract changes.** Discovery, prompts, and dispatch help text ship together.

---

## 8. Board UI observations (separate backlog — DO NOT act yet)

Raised by the owner while monitoring the 8-worker run. Recorded for later; **no changes
until explicitly approved.**

1. **Post truncation.** Worker context/output printed to the board is sometimes truncated
   (or shows as `0`). Consider increasing the size written per board post.
2. **Worker numbering.** All parallel workers of the same model post under one identity
   (`worker:<model>`), so they're indistinguishable. Add a number next to "worker"
   (e.g. `worker-3:<model>`). Acute when dispatching N copies of one model — which is
   exactly the Forge Arcade pattern.
3. **Non-copyable posts.** Board post contents can't be selected/copied in the UI.

---

## 9. Quick reference — current AgentWatch settings (as found 2026-06-04)

```
agentwatch.subagentBridgeApiKey   = "forge-local-change-me"      # FIXED 2026-06-04 (was "continue-local-change-me")
agentwatch.subagentDirectUrl      = "http://127.0.0.1:8080/v1"   # raw llama-server (bypasses Forge)
agentwatch.subagentOllamaUrl      = "http://127.0.0.1:11434/v1"  # raw ollama (bypasses Forge)
agentwatch.subagentForgeControlUrl= "http://127.0.0.1:8799"      # Forge control (local GGUF) — global settings
agentwatch.subagentBridgeUrl      = (unset → default http://127.0.0.1:9099/v1)  # Forge bridge (all providers)
agentwatch.subagentDefaultBackend = (unset → default 'bridge')
```

Relevant code: `src/extension.ts:35-40` (backend wiring), `src/subagent.ts` (resolve +
`listModels` + Forge control comment at L20-23), `src/forgeHold.ts` (batch `/ensure`).
