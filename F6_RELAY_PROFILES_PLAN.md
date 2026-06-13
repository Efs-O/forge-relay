# F6 (Relay side) — `model@profile` dispatch + daemon health-check/auto-start

Status: PLAN (awaiting sign-off). Pairs with Forge `F6_PROFILES_PLAN.md`.
Owner files: `src/subagent.ts` (routing), `src/subagentLoop.ts` (probe/dispatch),
`src/runtimeManager.ts` (daemon supervision). Findings:
`docs/MULTIPROVIDER_DISPATCH_FRICTION.md` §4 + Forge `RELAY_SMOKE_FINDINGS.md` §F6.

Two pieces, same config/runtime family (user directive 2026-06-13: fold
friction-#4 into the F6 plan).

---

## Part A — `model@profile` dispatch

Forge's catalog will expose base models once, each with a list of available
**profiles** (`main` / `subcoordinator` / `worker` / …). Relay must let a
dispatch name a `model@profile` pair and forward it to Forge unchanged.

Current routing (grounded):
- `ROUTE_PREFIXES = {forge,bridge,ollama,direct}` and `modelName()` /
  `modelPrefix()` (`subagent.ts:135–147`) split a *leading* `prefix:`.
- `decideForgeRoute()` (`subagent.ts:516`) matches the bare name against the
  catalog; `servable:false` ⇒ `backend:'forge-chat'`, baseUrl=controlUrl
  (`:561`), and `postChat` swaps the path to `/chat` (`:184`).

The `@profile` suffix is **orthogonal to the `prefix:` routing** and to the
colon inside ollama ids. Minimal change:
- Add `splitProfile(model) → { base, profile? }` that strips a trailing
  `@<profile>` (last `@`, validated as `[A-Za-z0-9_-]+`). Leaves `prefix:` and
  internal colons intact (`forge:gemma4:31b@worker` → prefix `forge`,
  base `gemma4:31b`, profile `worker`).
- Route on `base` (existing logic, unchanged). Carry `profile` through to
  `postChat`/`/ensure` body as `model: "<base>@<profile>"` so **Forge** does the
  profile resolution (single source of truth — Relay stays dumb about profiles).
- Catalog match uses `base`; a `model@profile` where base is `servable:false`
  still routes `forge-chat` and Forge applies the profile in `/chat`.
- Default profile when `@` omitted: leave as bare name (Forge applies its
  configured default profile). Cloud workers still default to tools `'full'`.

Touch points: `modelName`/`modelPrefix` (compose with `splitProfile`),
`decideForgeRoute` (match on base, pass full `model@profile` in resolved.model),
`postChat` body, `validateBackend` (probe base, not the pair).

Tests (`tests/`): `splitProfile` cases (bare, `@worker`, `forge:…@worker`,
`gemma4:31b-cloud@worker` keeps colon, invalid `@` rejected); `decideForgeRoute`
matches base of a `model@profile`; forge-chat routing preserved for a
`servable:false` pair.

## Part B — daemon health-check / auto-start (friction-#4)

Today `forgeHealthz()` (`subagent.ts:706`) only **probes** `GET /healthz`; if
Forge's control server or the ollama daemon is down, dispatch fails with a raw
connection error and the operator restarts by hand (the on-ramp token burn the
friction doc complained about). Add **opt-in** supervision — never force-start
silently (CLAUDE.md: explicit over hidden).

Scope (smallest useful):
- `ollamaHealthz(ollamaUrl)` — `GET {ollamaUrl}/tags` (or `/api/tags`), mirrors
  `forgeHealthz`, never throws.
- In `subagentLoop.ts` pre-dispatch probe (`:223–280`): when the chosen backend
  is down, if auto-start is enabled, attempt one bounded start then re-probe
  (single retry, ~10 s budget, `AbortController`); otherwise return the existing
  clear "backend DOWN — start X" message (no behavior change when disabled).
- Auto-start commands come from settings/env (no hardcoded paths):
  - ollama: `forgeRelay.ollamaAutoStart` (bool) + `forgeRelay.ollamaExecutable`
    (default `ollama`), spawn `ollama serve` detached.
  - Forge control: **not** auto-startable by Relay (it's a VS Code extension
    host) — only probe + a clear actionable message. Document this asymmetry.
- New `src/daemonSupervisor.ts` (keeps `subagent.ts` under cap): `ensureDaemon`
  helpers, all opt-in, all bounded, all surfacing errors to the board.

Tests: `ollamaHealthz` up/down (mocked fetch); supervisor disabled ⇒ no spawn,
returns probe message; enabled + still-down-after-start ⇒ surfaces error.

## Out of scope

- Forge-side schema/resolver — Forge `F6_PROFILES_PLAN.md`.
- Auto-starting the Forge extension host (not possible from Relay).
- The async-dispatch "return immediately" fix (separate Minor item).
- Removing the explicit `forge:<cloud-model>` → 422 quirk (left as-is, minor).

## Gates

`npx tsc --noEmit`, `npx vitest run` (relay suite), `npm run build`.
Repos stay decoupled — Relay talks to Forge only over localhost control HTTP.
