# Forge Routing Consolidated Plan

Date: 2026-06-05
Repo: `forge-relay`
Status: Consolidated implementation plan

## 1. Purpose

This document replaces the split between:

- `docs/FORGE_ONLY_ROUTING_PLAN.md`
- `docs/FORGE_MULTI_PROVIDER_ROUTING_PLAN.md`

Those two docs overlap heavily, and both are now partially stale relative to the
current codebase. This consolidated plan is the implementation reference going
forward.

It is intentionally grounded in:

- what is already implemented in this repo
- what still remains to ship
- what the normal product UX should become

Document roles:

- this file = active implementation spec and TODO
- `FORGE_ONLY_ROUTING_PLAN.md` = historical target-state context
- `FORGE_MULTI_PROVIDER_ROUTING_PLAN.md` = historical diagnosis/migration context

## 2. Product rule

Normal worker routing should be Forge-first.

That means:

- local GGUF models route through Forge control
- provider-backed models route through the Forge bridge
- raw backend routes remain available only as explicit override/debug paths
- Forge failures must surface clearly instead of being hidden by silent fallback

Short version:

- normal behavior -> route through Forge
- explicit debug override -> allow raw route
- no silent guessing between valid routes

### 2.1 Codex connection model

Codex should normally stay on the single-process MCP path, not the managed
runtime-bridge path.

That means:

- normal Codex usage -> the user's existing Codex sidebar/session calls the
  `forgerelay` MCP tools from `~/.codex/config.toml`
- normal Codex usage -> do not spawn a second managed `codex app-server` from
  the Forge Relay GUI
- GUI "Codex connected/disconnected" status refers to the managed Codex runtime
  bridge only, not to whether the current Codex session can already reach the
  board through MCP

Why this rule exists:

- earlier managed-Codex behavior could make the main Codex chat/session become
  unresponsive because a second `codex app-server` could compete with the
  primary sidebar session over the same login/session state
- the intended fix is architectural, not "use two accounts": keep one healthy
  Codex process and give that process direct Forge Relay MCP access

Short version:

- Codex is still meant to use the board
- Codex is not meant to be removed from Forge Relay
- what is removed from the normal path is the second managed Codex bridge

## 3. Current repo state

The repo is not starting from zero. Important pieces are already implemented.

### 3.1 Already implemented

- Forge control configuration exists:
  - `forgeRelay.subagentForgeControlUrl`
  - `forgeRelay.subagentBridgeUrl`
  - `forgeRelay.subagentBridgeApiKey`
  - `forgeRelay.subagentDefaultBackend`
- `dispatch_subagent` already supports an opt-in Forge control route.
- `forge:` model ids already force Forge control routing.
- Unprefixed model ids already route through Forge control when
  `forgeControlUrl` is set.
- Forge `/healthz`, `/ensure`, and `/release` are already implemented in the
  client path.
- Forge-routed dispatch already fails clearly when Forge is down, busy, or
  cannot load a model.
- Same-model Forge concurrency hardening is already implemented:
  - shared batch holds
  - ref-counted `/ensure` / `/release`
  - per-model slot limiting
- `list_models` already becomes Forge-first when `forgeControlUrl` is set.

### 3.2 Not implemented yet

- provider-aware routing for bare model names
- one merged Forge-backed catalog for normal `list_models`
- a normal UX that hides raw routes from primary discovery
- a canonical internal route identity for ambiguous model names
- prompt/tool/docs updates that make Forge-first routing the default mental model
- a debug-mode policy for raw routes, if we want stronger gating later

## 4. Main gap

The biggest missing behavior is this:

- local model -> Forge control (`8799`)
- provider-backed model -> Forge bridge (`9099`)

That split is the core of the remaining implementation.

Today, if `forgeControlUrl` is configured, unprefixed model names are treated as
"route through Forge control" without checking what kind of model they are.
That is good enough for local-only use, but not good enough for a true
multi-provider Forge-first routing model.

## 5. Routing policy

### 5.1 Normal path

Normal dispatch should follow this routing policy:

| Model class | Normal route |
|---|---|
| local GGUF exposed by Forge control | Forge control |
| Ollama model exposed through Forge bridge | Forge bridge |
| xAI / Grok exposed through Forge bridge | Forge bridge |
| OpenRouter exposed through Forge bridge | Forge bridge |
| future provider exposed through Forge bridge | Forge bridge |

### 5.2 Explicit override path

These should continue to work as deliberate operator/debug overrides:

- `forge:<model>`
- `bridge:<model>`
- `ollama:<model>`
- `direct:<model>`

Rules:

- explicit override wins
- normal unprefixed dispatch should not require prefixes
- raw overrides should not be the normal documented workflow

### 5.3 Failure policy

Required behavior:

- if Forge control is required and unavailable, fail clearly
- if Forge bridge is required and unavailable, fail clearly
- if a model cannot be resolved uniquely, fail clearly
- do not silently fall through to `direct`, raw `ollama`, or another guessed path

## 6. Source of truth

Forge should be the source of truth for model routing metadata.

Preferred order:

1. live Forge-served model metadata
2. temporary parsed Forge config if live metadata is not available yet
3. naming conventions only as a short-term fallback

Steady-state goal:

- Forge tells `forge-relay` what the model is
- Forge tells `forge-relay` which route family it belongs to
- `forge-relay` does not guess from prefixes or filename patterns in normal flow

## 7. Model identity rules

We need two distinct identities:

- display label
- canonical internal route target

Examples:

- display: `gemma4-e4b-it-ud-q4kxl`
- canonical: `forge-control:gemma4-e4b-it-ud-q4kxl`

- display: `grok-3-mini`
- canonical: `forge-bridge:xai:grok-3-mini`

Rules:

- if a display label maps to exactly one route target, dispatch normally
- if it maps to multiple route targets, fail and list the valid canonical targets
- never guess between ambiguous matches

## 8. `list_models` target behavior

`list_models` should stop teaching raw transport choice as the normal workflow.

### 8.1 Normal output

Normal output should present one merged Forge-first catalog that includes:

- display label
- canonical route target
- provider/backend metadata
- route note only when helpful

### 8.2 What should disappear from normal UX

Normal output should not primarily read like:

- `bridge:model-a`
- `ollama:model-b`
- `direct:model-c`

Those forms can still exist as debug overrides, but they should not be the main
thing users are taught to copy.

### 8.3 Staged shipping

Stage 1:

- keep existing raw probes in code
- present Forge-backed entries first
- introduce canonical identities

Stage 2:

- hide raw backend entries from normal `list_models`
- optionally expose them only in debug mode or explicit troubleshooting output

## 9. `dispatch_subagent` target behavior

### 9.1 Required changes

- unprefixed model ids should resolve through Forge-backed model metadata
- local models should dispatch via Forge control
- provider-backed models should dispatch via Forge bridge
- explicit raw prefixes should still bypass that resolver intentionally

### 9.2 Important compatibility rule

`list_models`, `dispatch_subagent`, tool descriptions, and orchestrator prompts
must change together.

Reason:

- discovery and dispatch are one contract
- partial rollout would leave the orchestrators speaking the old
  `"<backend>:<model>"` language to a new resolver

## 10. Prompt and docs changes

Once routing is updated, the prompts and docs must stop teaching backend
selection as the normal workflow.

The new normal mental model should be:

- pick a Forge-exposed model
- dispatch by model identity
- let Forge decide the actual runtime path

The old normal mental model to retire is:

- `direct:` for one case
- `ollama:` for another
- `bridge:` for another

## 11. Implementation plan

### Phase 1 - Finish the route resolver

Goal:

- make unprefixed model names resolve to the correct Forge route family

Tasks:

- add provider/route-aware resolution for bare model names
- use Forge metadata as the resolver input
- fail loudly on missing or ambiguous route metadata
- preserve explicit raw prefixes as overrides

Done when:

- unprefixed local GGUF names route to Forge control
- unprefixed provider-backed names route to Forge bridge
- no silent fallback exists

### Phase 2 - Unify discovery

Goal:

- make `list_models` describe the new routing contract

Tasks:

- return one merged Forge-first catalog
- add canonical route targets
- label ambiguity clearly
- stop making raw prefix choice the main UX

Done when:

- a normal user can choose a model without thinking in ports

### Phase 3 - Update prompts and docs

Goal:

- align orchestration behavior with the new routing model

Tasks:

- update `dispatch_subagent` tool description
- update `list_models` tool description/output wording
- update Codex orchestrator guidance
- update Claude orchestrator guidance
- update README and operator docs

Done when:

- the orchestrators naturally use Forge-first dispatch without hand-picking raw
  backend prefixes in normal use

### Phase 4 - Optional hardening

Goal:

- reduce accidental raw-route usage even further

Tasks:

- decide whether raw routes should be hidden entirely in normal discovery
- optionally require debug mode for raw-route visibility or dispatch

Done when:

- raw routes are clearly advanced/debug behavior

## 12. Acceptance criteria

This effort is complete when all of the following are true:

1. Unprefixed dispatch uses Forge metadata to choose the right route family.
2. Local Forge-managed models route through Forge control.
3. Provider-backed Forge-exposed models route through Forge bridge.
4. `list_models` presents a merged Forge-first catalog as the normal source of truth.
5. Raw `direct` / `ollama` / `bridge` remain available only as explicit overrides.
6. Ambiguous model names fail clearly instead of being guessed.
7. Forge failures surface immediately instead of being masked by raw fallback.
8. Prompts and docs teach Forge-first selection as the normal workflow.

## 13. Immediate TODO

This is the practical implementation checklist to work from next.

- Build a Forge-backed model metadata source for route resolution.
- Change unprefixed dispatch to use that metadata instead of "Forge control if configured".
- Define and expose canonical route identities for ambiguous names.
- Redesign `list_models` around one merged Forge-first catalog.
- Update `dispatch_subagent` and `list_models` descriptions to match the new contract.
- Update orchestrator prompts so backend-prefixed selection is no longer the default guidance.
- Refresh README and operator docs to use `forgeRelay.*` setting names and Forge-first language.
- Decide whether raw routes stay visible in standard discovery or move behind a debug view.

## 14. Status of older docs

After this document is reviewed:

- keep `FORGE_ONLY_ROUTING_PLAN.md` as historical target-state context, or fold its
  unique language into this file and retire it
- keep `FORGE_MULTI_PROVIDER_ROUTING_PLAN.md` only as historical diagnosis/migration
  notes, not as the active implementation spec

This file should be the implementation TODO/spec going forward.
