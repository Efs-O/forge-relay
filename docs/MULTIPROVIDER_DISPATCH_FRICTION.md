# Multi-Provider Dispatch Friction — Relay-side findings (2026-06-11)

Source: live 4-model "koi pond" dispatch test run from this repo's board
(`:7878`, streamable HTTP). The run itself was fast and clean once routed —
spec from `gemma4:31b-cloud`, three parallel builders (qwen3-coder:480b-cloud
2 steps/1 write; both local 12Bs 2 steps/1 write, ~3 min, zero rewrite churn),
correct worker numbering, one board. **The cost was all in the on-ramp:** name
resolution, dead catalog entries, dead daemons, split config. The user stopped
the test before the review phase because starting it burned ~20-30k tokens.

Forge-side findings (provider `/ensure` gap, entitlement 403s, ollama daemon
supervision) live in the Forge repo: `RELAY_DISPATCH_FINDINGS.md`.

---

## 1. Colon-id routing bug (BUG — fix first)

`gemma4:31b-cloud` dispatched **unprefixed** gets split at the first colon, so
Relay searched the catalog for `31b-cloud` and failed:

> model "31b-cloud" was not found in the Forge control or Forge bridge catalogs.

Every Ollama model has a colon in its name, so the **entire ollama/cloud
family** only works with the explicit `forge:` prefix workaround
(`forge:gemma4:31b-cloud` routes correctly because the `forge:` branch keeps
the remainder intact).

Cause: `modelName()` / `modelPrefix()` in `src/subagent.ts` strip an arbitrary
first `<segment>:` regardless of whether it is a route prefix. They must only
strip the **four known prefixes** (`forge:` / `bridge:` / `ollama:` /
`direct:`); any other first segment is part of the model name. Touch points:
`modelName`, `modelPrefix`, `decideForgeRoute`, and `resolveModel`'s prefix
check (already correct — it tests for the known three; mirror that logic).

Add tests: unprefixed `gemma4:31b-cloud` must match a catalog entry of that
exact name; `forge:gemma4:31b-cloud` keeps working; `ollama:gemma4:31b-cloud`
resolves to the ollama backend with the full name.

## 2. Config split between Relay's two MCP servers (TRAP — fix second)

Relay runs two MCP servers with **different config sources**:

| Server | Transport | Config source |
|---|---|---|
| Extension server (`mcpServer.ts`, :7878) | SSE + streamable HTTP | VS Code settings (`forgeRelay.*`) |
| Stdio server (`mcpStdio.js`) | stdio (what Claude's `.mcp.json` spawns) | **env vars only** (`FORGERELAY_*`) |

Live consequence: the Claude session had the `forgerelay` tools loaded (via
stdio), but that server had **no Forge route** (`FORGERELAY_FORGE_CONTROL_URL`
unset), while the :7878 server had the full Forge-first catalog. The
coordinator was forced to hand-roll raw streamable-HTTP sessions with curl —
that plumbing was most of the token burn.

Fix: make `ensureClaudeMcpConfig()` (`src/runtimeManager.ts`) inject an `env`
block into the managed `.mcp.json` entry, populated from the same workspace
settings the extension server reads — at minimum `FORGERELAY_FORGE_CONTROL_URL`,
ideally also `FORGERELAY_OLLAMA_URL` / `FORGERELAY_DIRECT_URL` /
`FORGERELAY_DEFAULT_BACKEND` / `FORGERELAY_DEFAULT_MODE`. One config source,
both servers agree, dispatch becomes a single tool call.

## Fix order (agreed with operator)

1. Colon-id routing (small, unblocks every ollama model by real name).
2. Config unification via `.mcp.json` env injection.
3. (Forge repo) `/ensure` honesty — see `Forge/RELAY_DISPATCH_FINDINGS.md`.
4. Optional QoL: daemon health-check/auto-start (ollama, Forge backend) —
   previously deferred, same family.

## Test artifacts

`relay-playground/koi-pond/` (untracked): `index.html` (operator prep),
`fish.js` + `ripples.js` (local 12B workers), `pond.js`
(qwen3-coder:480b-cloud). Review phase never ran (reviewer models 403-gated).
Safe to delete.
