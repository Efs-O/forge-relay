# Worker dispatch to Gemma 4 26B fails on reasoning overflow — F1 only half-fixed

**Date:** 2026-07-16
**Reporter:** Claude (Gemma4GR persona-experiment session)
**Status:** Resolved on `main` by `52889fb`; packaged in stable 0.5.2
**Severity:** Resolved (previously blocked single-shot dispatch to thinking-enabled local models)

## Resolution (2026-07-16)

Relay now sends `chat_template_kwargs: { enable_thinking: false }` to
llama.cpp worker requests, defaults Tier-1 completions to 4096 tokens, and
exposes a validated `dispatch_subagent.max_tokens` override. The fix applies to
both single-completion and agentic worker paths without changing coordinator
requests or Forge `config.yaml`.

Validation passed the focused payload tests, all 129 clean `main` tests,
type-checking, production build, and a live
`gemma4-26b-a4b-it-iq3s` request. The live response returned
`RELAY_GEMMA_OK`, no `reasoning_content`, `finish_reason: stop`, and eight
completion tokens; Forge confirmed release of the model hold.

## What happened

Two `dispatch_subagent` calls to `gemma4-26b-a4b-it-iq3s` (tools `none`,
mode `sync`, a small JSONL-generation task ~350 words) both failed:

```
SUBAGENT sa_mrnr7ea1_exppyq (gemma4-26b-a4b-it-iq3s) ERROR: worker produced
no output and hit the token limit (reasoning/length overflow — raise
max_tokens or lower reasoning_effort)
```

The second attempt prefixed the task with `/no_think` + "do NOT use extended
thinking" — same failure. Prompt-level suppression does not work; the
model's chat template enables thinking regardless.

## Root cause (confirmed in source)

F1 from `Forge/RELAY_SMOKE_FINDINGS.md` (2026-06-12) was only **half**
implemented:

- **DONE — detection:** `src/subagent.ts:266-271` now surfaces
  empty-content + `finish_reason: length` as a worker ERROR instead of a
  silent empty COMPLETED. (This is the error text above — working as
  designed.)
- **NOT DONE — mitigation:** the dispatch request itself still guarantees
  the overflow for thinking models:
  - `src/subagent.ts:257` — `max_tokens: opts.maxTokens ?? 1024`. A
    hard default of **1024 completion tokens**, which Gemma 4 26B burns
    entirely on `reasoning_content` before emitting any visible text.
    `opts.maxTokens` is never populated from anywhere user-reachable.
  - No `chat_template_kwargs: { enable_thinking: false }` is ever sent —
    `grep chat_template_kwargs src/` has zero hits. The smoke-test doc
    recorded this exact fix as validated live against llama-server, but it
    was never wired into the dispatch path.
  - Relay still dispatches direct-to-baseUrl, bypassing Forge's per-model
    config, so `config.yaml` reasoning/thinking settings never apply
    (F1 root-cause note, still true).

## Configuration findings corrected during verification

- **No reasoning-off `-worker` variant for gemma is exposed.** Today's
  `list_models` catalog shows `-worker` variants only for the two Qwen
  models; per the smoke-test findings those kept `think: true` anyway.
- The reported stop-token bug was not present in the active Forge configuration.
  Gemma entries already use the correct `stop: "<end_of_turn>"`; no YAML change
  was required.

## Suggested fix (smallest that unblocks dispatch)

In the single-completion dispatch path (`src/subagent.ts`):

1. Raise the default completion cap for workers (e.g. 4096) and/or expose
   `max_tokens` as a `dispatch_subagent` argument.
2. Send `chat_template_kwargs: { enable_thinking: false }` for llama.cpp
   backends (already validated live per the smoke-test doc); ignore/omit
   for backends that reject it.
3. Longer term: route dispatch through the planned Forge `/chat` proxy
   (F3) so per-model config applies and this class of bug disappears.

## Repro

Start Relay (`:7879`) with Forge control up (`:8799`), then:

```
dispatch_subagent(agent="claude", model="gemma4-26b-a4b-it-iq3s",
                  tools="none", mode="sync",
                  task="<any prompt requiring >~200 tokens of output>")
```

Expected: completion text. Actual: reasoning/length overflow ERROR.
