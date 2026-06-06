# Forge control-client — consumer implementation spec

**Goal:** route Forge Relay worker dispatch through Forge's localhost model-control
API so the **right model is loaded and warm before we dispatch**, instead of
POSTing blind to a fixed port. This kills the two failures seen in the RPS run:
`fetch failed` (server down / mid-swap) and "wrong model loaded" (the `direct`
backend serves whatever is loaded and ignores the requested id).

This work lives **entirely in this repo (Forge Relay)**. You only need the
contract below — there is no dependency on, and no path into, Forge's source.

---

## The contract (Forge already implements this)

Forge exposes a localhost HTTP API when `control_server.enabled: true` in its
config. Default base URL: **`http://127.0.0.1:8799`** (Forge's
`control_server.port`). Bound to `127.0.0.1` only.

| Method + path | Body | Response |
|---|---|---|
| `GET /healthz` | — | `{ "ok": true }` |
| `GET /models` | — | `{ "models": [{ "name", "backend", "loaded" }] }` |
| `POST /ensure` | `{ "model": "<name>" }` | `200 { "baseUrl", "model", "backend" }` |
| `POST /release` | `{ "model": "<name>" }` | `200 { "released": true }` |

`POST /ensure` semantics:
- Loads / hot-swaps to `model` if needed, **waits until it is healthy**, and
  returns `baseUrl` — an OpenAI-compatible base that **already ends in `/v1`**.
  Dispatch to `` `${baseUrl}/chat/completions` ``.
- `model` is the **Forge model name** (as listed by `GET /models`), **not**
  backend-prefixed.
- Error statuses to handle:
  - `404` — unknown model (not in Forge config).
  - `409` — busy: capacity is full and all loaded models are in use; Forge will
    not evict an in-use model. Surface as "model busy, retry later", not a crash.
  - `502` — the model failed to load (bad path, OOM, etc.); message included.

> **Ref-count discipline (critical):** every successful `/ensure` increments a
> hold count in Forge. You **must** call `/release` when the worker finishes
> (success *or* error), or Forge will believe the model is forever in use and
> refuse to swap. Wrap the worker run in `try/finally`.

---

## Tasks in this repo

### 1. Add the Forge route to backends (`src/subagent.ts`)
- [x] Add `forgeControlUrl?: string` to `SubagentBackends`
      (e.g. `http://127.0.0.1:8799`). Default from `DEFAULT_SUBAGENT_BACKENDS`
      can stay unset so the feature is opt-in.
- [x] Routing convention: treat a `forge:` model prefix (or: any dispatch when
      `forgeControlUrl` is set and the model is unprefixed) as "route via Forge".
      Strip the prefix to get the bare Forge model name for `/ensure`.
      (`forgeRoute()`; explicit `bridge:`/`ollama:`/`direct:` prefixes keep their
      direct routing so a deliberate backend choice is never overridden.)

### 2. Ensure-then-dispatch wrapper (`src/subagentLoop.ts` / dispatch path)
- [x] Before the chat loop, when routing via Forge:
      `POST {forgeControlUrl}/ensure { model }` → use the returned `baseUrl` as
      the `ResolvedModel.baseUrl` for this dispatch (overrides `directUrl`).
- [x] `try { run worker } finally { POST /release { model } }` — always release.
      (Release lives in `runWork`'s `finally` for Tier 2 — covering sync, async,
      error and abort — and in the Tier 1 `finally`; it runs at most once.)
- [x] Map `/ensure` non-200s to clear board posts:
      `409` → "worker model busy"; `404` → "unknown model"; `502` → load error.
      These already read better than the bare `fetch failed` you saw before.
- [x] When `forgeControlUrl` is unset, keep the existing
      `direct`/`ollama`/`bridge` routing unchanged (do not regress decoupling).

### 3. Discovery + preflight (reuse what exists)
- [x] `list_models` (`handleListModels`) — when `forgeControlUrl` is set, prefer
      Forge `GET /models` as the source of truth for worker model names.
      (Listed first; shares the `{models:[{name}]}` shape `fetchModels` parses.)
- [x] `validateBackend` — for the Forge route, a `GET /healthz` + `GET /models`
      replaces the per-endpoint probe (Forge guarantees readiness via `/ensure`).
      (Dispatch preflights `forgeHealthz` then lets `/ensure` gate readiness,
      instead of probing the worker endpoint directly.)

### 4. Config surface
- [x] Expose `forgeControlUrl` in Forge Relay settings (VS Code config and/or the
      MCP server's backend config), defaulting unset/off.
      (`forgeRelay.subagentForgeControlUrl` and `FORGERELAY_FORGE_CONTROL_URL`.)

---

## How to test (same-model fleet — the realistic case)

On a typical 16 GB-VRAM box, run **one shared model with parallel slots**, not
several different models.

1. **Forge config**:
   ```yaml
   llama_server:
     n_parallel: 4          # 4 concurrent slots on one load
     default_num_ctx: 32768 # TOTAL, split across slots → ~8192 each
   control_server:
     enabled: true
     port: 8799
   ```
2. **Forge Relay**: set `forgeControlUrl: http://127.0.0.1:8799`.
3. Dispatch 3-4 workers on the **same** model via the Forge route. Expected:
   - first `/ensure` loads it; the rest return the same `baseUrl` instantly;
   - all four share one VRAM load (fan across the `--parallel` slots);
   - each worker `/release`s when done.
4. Negative check: while those workers hold the model, `/ensure` a **different**
   model → expect `409` busy (Forge protects the in-use load), surfaced as a
   clean "model busy" board post rather than a fetch error.

---

## Acceptance

A coordinator dispatches a multi-file change to 3-4 same-model workers through
the Forge route with **zero** "fetch failed" / "wrong model" errors, every
`/ensure` paired with a `/release`, and a `409` cleanly reported when a second
model can't fit. Then measure token cost vs. all-SOTA — that number is the thesis.
