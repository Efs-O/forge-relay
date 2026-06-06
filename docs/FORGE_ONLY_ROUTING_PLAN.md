# Forge-Only Routing Plan for forge-relay

> Historical target-state note. Do not use this file as the active implementation
> spec. Use [FORGE_ROUTING_CONSOLIDATED_PLAN.md](./FORGE_ROUTING_CONSOLIDATED_PLAN.md)
> for current-state routing decisions, remaining work, and the implementation TODO.

Date: 2026-06-04
Repo: `forge-relay` (formerly `AgentWatch`)
Status: Historical target-state context

## 1. Goal

Make `forge-relay` a true companion to Forge by routing **all normal worker
dispatch through Forge**.

The product model becomes:

- **Forge** = model/runtime layer
- **forge-relay** = orchestration and coordination layer

`forge-relay` should stop acting like an independent multi-backend router.

## 2. Why this change

The current multi-path model adds too much complexity:

- too many ports to reason about
- too many route branches in code
- too many failure shapes
- too many user-facing concepts (`direct`, raw `ollama`, raw `bridge`, `forge`)
- too many ways for a dispatch to "work, but through the wrong path"

That complexity is the opposite of what a Forge companion should do.

If Forge already knows:

- what models exist
- which provider serves them
- how to load local models
- how to route cloud/provider models
- what capacity or readiness state exists

then `forge-relay` should consume that capability, not duplicate it.

## 3. Target product model

After this plan lands, normal behavior should be:

1. The orchestrator asks for a worker model.
2. `forge-relay` asks Forge for the model catalog and route metadata.
3. `forge-relay` dispatches through Forge.
4. If Forge cannot serve the request, the dispatch fails clearly and immediately.
5. The operator fixes Forge, not some hidden alternate path.

In plain words:

- no normal raw `:8080` dispatches
- no normal raw `:11434` dispatches
- no normal "guess a backend prefix" behavior
- one supported runtime path: Forge

## 4. Normal path vs fallback path

### 4.1 Normal supported path

All normal worker dispatch uses Forge only:

- local GGUF models -> Forge control-managed route
- Ollama-backed models -> Forge-managed route
- OpenAI-compatible cloud/provider models -> Forge-managed route
- future providers -> Forge-managed route

The orchestrator should think in terms of **models exposed by Forge**, not raw
backend ports.

### 4.2 Inactive-by-default fallback paths

The existing raw routes should not be deleted immediately, but they should become
**inactive by default**.

That means:

- not shown in normal `list_models`
- not suggested in bridge prompts
- not used by unprefixed dispatch
- not part of the primary README mental model

They may remain available only as:

- debug escape hatches
- migration-era recovery tools
- explicit operator-only overrides

Recommended label:

- `advanced/debug only`

### 4.3 Failure philosophy

If Forge is misconfigured, down, or missing a model, `forge-relay` should fail
fast and say so.

Do **not** silently reroute to:

- raw llama.cpp
- raw Ollama
- another guessed provider

The point is to discover Forge problems immediately instead of hiding them.

## 5. Routing model

### 5.1 Single supported route family

Internally, `forge-relay` should treat Forge as the one supported route family.

The only routing decision should be:

- Forge local-control path for local managed models
- Forge bridge/provider path for everything else Forge exposes

That distinction is internal. The orchestrator should not need to care.

### 5.2 Model discovery

`list_models` should become Forge-first and preferably Forge-only in normal mode.

Normal output should be:

- models Forge says are callable
- enough metadata to distinguish local vs provider-backed
- route notes only when useful for debugging

Normal output should **not** look like:

- separate raw `direct`
- separate raw `ollama`
- separate raw `bridge`
- operator having to choose a transport manually

### 5.3 Ambiguity rule

If Forge exposes two models whose visible labels are ambiguous, `forge-relay`
must fail loudly and ask for the exact Forge identity.

Still no guessing.

## 6. Code-shape changes

### 6.1 Dispatch

Change `dispatch_subagent` so that normal dispatch resolves through Forge.

Desired behavior:

- unprefixed model name -> resolve via Forge catalog -> dispatch via Forge
- if Forge cannot resolve it -> clear error
- if Forge is down -> clear error
- if the model is not ready/loadable -> clear error

### 6.2 Discovery

Change `list_models` to use Forge as the main source of truth.

Recommended staged behavior:

- Stage A: show Forge models only by default
- Stage B: optionally expose raw backends only behind a debug flag

### 6.3 Prompting

Update both orchestrator prompts so they stop teaching raw backend selection as
the normal workflow.

The orchestrators should learn:

- pick from Forge's model catalog
- dispatch by model identity
- trust Forge to route it

They should stop thinking:

- `direct:` for this
- `ollama:` for that
- `bridge:` for something else

### 6.4 Configuration

Move the product mental model toward Forge-centered settings.

Primary settings should be:

- Forge control URL
- Forge bridge/provider URL
- Forge API/auth values if required

Legacy raw backend settings should remain temporarily, but be marked as:

- deprecated for normal use
- debug only

## 7. Recommended staged implementation

### Phase 1 - Make Forge the default path

- Keep current raw backend code in place.
- Change unprefixed dispatch so it resolves through Forge first.
- Remove raw backend guidance from prompts and normal docs.
- Make `list_models` Forge-first.

Success looks like:

- ordinary use never requires `direct:` or `ollama:`
- operators start seeing Forge failures directly

### Phase 2 - Hide raw routes from normal UX

- Remove raw backend entries from normal `list_models`
- mark raw backend settings as advanced/debug
- move raw-route docs to troubleshooting/dev notes

Success looks like:

- normal users no longer think in ports
- only developers/debuggers know the escape hatches exist

### Phase 3 - Optional hardening

- require an explicit debug mode to enable raw routes
- reject raw-route dispatch unless debug mode is on

Success looks like:

- product behavior is unambiguous
- routing bugs cannot be masked by accidental raw fallback use

## 8. Immediate changes recommended before code

1. Treat the repo as `forge-relay` in new docs and naming.
2. Keep the existing `FORGE_MULTI_PROVIDER_ROUTING_PLAN.md` as the historical
   transition note.
3. Use this plan as the new target architecture.
4. When renaming the repo folder, follow up by updating any remaining path-based
   docs, scripts, packaging metadata, and config snippets that still mention
   `AgentWatch`.

## 9. Acceptance criteria

This plan is successful when all of the following are true:

1. Normal worker dispatch goes through Forge, not raw backend ports.
2. `list_models` presents Forge's catalog as the normal source of truth.
3. Raw `direct` / raw `ollama` / raw `bridge` are inactive in normal UX.
4. Forge problems surface immediately instead of being masked by fallback routing.
5. The orchestrator prompts teach Forge-first model selection.
6. The product is easier to explain:
   `Forge runs models; forge-relay coordinates work.`

## 10. Short version

The new rule is simple:

- if it is normal product behavior, route it through Forge
- if it bypasses Forge, it is debug-only

That keeps `forge-relay` aligned with its real job: coordination, not runtime sprawl.
