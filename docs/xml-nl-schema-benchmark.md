# Forge 12B Prompt Format Benchmark

## Executive Summary

This report records a quick local benchmark of three prompt formats on a Forge-managed Gemma 4 12B worker:

- verbose XML
- compact natural language
- compact schema/tags

The original hypothesis was that XML-style structure would help a local worker model follow constraints more reliably than plain natural language. On this setup, that did not happen. Once reasoning was disabled at the llama.cpp layer and outputs became comparable, verbose XML was consistently more expensive in tokens and did not produce a correctness advantage.

The strongest result was not "natural language always wins." Instead, the pattern was:

- verbose XML performed worst
- compact natural language performed strongly
- compact schema/tags often matched or beat compact natural language

The most useful revision of the original idea is therefore:

- compact structured prompts may help
- verbose XML is probably the wrong structured format for this model

## Hypothesis

Initial hypothesis:

- a structured prompt format should reduce ambiguity and help a smaller local worker follow constraints more reliably than plain natural language

Original framing:

- `XML vs natural language`

Revised framing after the benchmark:

- `verbose XML vs compact natural language vs compact schema`

## Environment

Model under test:
- `gemma4-12b-it-ud-q4kxl`

Route:
- Forge control `http://127.0.0.1:8799`
- llama.cpp endpoint `http://127.0.0.1:8080/v1`

Serving settings used for the successful comparison runs:
- `num_ctx: 131072`
- `--reasoning off`
- `--reasoning-budget 0`

Generation settings:
- temperature `0.2`
- single-turn prompts
- system instruction constrained to "final answer only"

## Procedure

Each task was expressed in multiple prompt styles while keeping the requested output and the underlying task content as close as practical.

Prompt families:
- verbose XML
- compact natural language
- compact schema/tags

Task families:
1. Extract a few fields into JSON
2. Classify a bug report into a fixed 3-line output
3. Generate a tiny JavaScript helper function
4. Transform a denser ticket/spec into structured JSON
5. Emit a tiny CSV table
6. Rewrite a sentence into exactly 2 bullets with word limits
7. Produce a 4-step patch plan from a bug summary

Evaluation focus:
- whether the output followed the requested format
- whether the content was materially correct
- token cost, using the backend-reported totals

## Debug Chronology

The first runs were not trustworthy because the model was spending most of its budget in reasoning mode.

Observed early failure mode:
- output appeared in `message.reasoning_content`
- normal `message.content` was often empty
- the model frequently hit length limits before producing a final visible answer

The comparison only became meaningful after updating the runtime to:
- `--reasoning off`
- `--reasoning-budget 0`

That change moved outputs back into normal `content` and let the prompt formats be compared directly.

## Results

| Task | XML total tokens | NL total tokens | Schema total tokens | Best |
|---|---:|---:|---:|---|
| Extraction | 245 | 214 | 199 | Schema |
| Classification | 210 | 135 | 128 | Schema |
| Codegen | 210 | 150 | 147 | Schema |
| Structured JSON spec | 313 | 226 | 226 | NL / Schema tie |
| CSV formatting | 169 | 107 | 105 | Schema |
| Rewrite to 2 bullets | 125 | 115 | 123 | NL |
| 4-step patch plan | 215 | 198 | 214 | NL |

## Repo-Native Task 1

After the one-shot prompt tasks, a more realistic repo-native benchmark was run against Task 1 from [repo-benchmark-task-1.md](/n:/vs code apps/forge-relay/docs/repo-benchmark-task-1.md).

Task summary:
- inspect `src/subagentLoop.ts`
- inspect `src/forgeHold.ts`
- inspect `docs/TODO-forge-concurrency-hardening.md`
- identify root cause
- propose patch plan and validation plan

This test is important because it exercises:
- file reading
- tool use
- multi-step reasoning over repo evidence
- a development-style output rather than a formatting-only output

### Task 1 Results

#### First configuration: effective 16k per worker

Runtime shape:
- `num_ctx: 131072`
- `n_parallel: 8`
- effective per-worker window: about `16384`

Results:
- compact NL: success
  - `8 steps`
  - `7 tool calls`
  - `ctx ~15k`
  - `~62k tok`
- compact schema: failure
  - request exceeded available context
  - runtime error reported `n_ctx: 16384`

Interpretation:
- on this repo-native task, schema did not merely lose on token cost
- it failed outright under the smaller effective context window

#### Second configuration: effective 32k per worker

Runtime shape:
- `num_ctx: 131072`
- `n_parallel: 4`
- effective per-worker window: about `32768`

Results:
- normal NL: success
  - `4 steps`
  - `3 tool calls`
  - `ctx ~6k`
  - `~15k tok`
- compact NL: success
  - `8 steps`
  - `7 tool calls`
  - `ctx ~15k`
  - `~62k tok`
- compact schema: success
  - `11 steps`
  - `10 tool calls`
  - `ctx ~21k`
  - `~108k tok`

Interpretation:
- with enough per-worker context, all three styles can succeed
- but they are not equivalent in efficiency
- normal NL was dramatically lighter than compact NL
- compact NL was dramatically lighter than schema

### Task 1 Takeaway

This repo-native run changed the interpretation of the earlier prompt-format results.

For the 12B worker on a real repository task:
- normal natural language was best
- compact natural language was worse
- compact schema was worst

This suggests that for file-aware tool-using work, extra prompt compaction or pseudo-structure may actually push the worker into:
- more tool use
- more decomposition
- more context consumption

That is the opposite of the original hypothesis.

## Findings

High-level pattern:
- correctness was mostly tied once reasoning was disabled
- token efficiency differed clearly by format
- verbose XML never produced a clear win in this benchmark

Format-level read:
- verbose XML was consistently the most expensive or tied for most expensive
- compact natural language was a strong and reliable baseline
- compact schema/tags was often the most efficient format and never catastrophically worse

This means the main differentiator in the current benchmark was not output quality, but prompt overhead.

Repo-native read:
- once tools and repo context entered the picture, the ranking changed further
- normal NL became the strongest performer on Task 1
- compacting the prompt did not help this worker
- schema became highly context-sensitive

## Per-Task Findings

### Extraction

All three formats produced the correct JSON structure. XML added overhead without improving correctness. Compact schema was cheapest.

### Classification

All three formats followed the exact 3-line output rule. XML again cost much more. Schema slightly beat NL on token cost.

### Codegen

All three formats returned a correct `clamp()` implementation. Schema was marginally cheaper than NL. XML remained clearly heavier.

### Structured JSON spec

This was the densest extraction case and one of the better opportunities for structure to help. XML still lost badly on prompt cost. Schema and NL tied.

### CSV formatting

All three formats produced correct CSV. Schema narrowly beat NL. XML was much more expensive.

### Rewrite

This was one of the few tasks where NL stayed clearly best. Both XML and schema were acceptable, but neither improved quality and both lost some brevity advantage.

### Patch plan

All three formats produced usable 4-step plans. NL remained cheapest. Schema did not beat NL here, suggesting that not every planning task benefits from added structure.

## Discussion

The benchmark does not support the strong claim that XML improves small-model performance in this setup. At least for this Gemma 4 12B worker, verbose XML appears to add structure cost without delivering better compliance.

That does not fully kill the original intuition. It suggests a narrower and more useful version of it:

- compact structure may help
- verbosity may hurt
- XML may be too heavy a carrier for the actual benefit

The compact schema results are the strongest evidence in favor of the revised idea. In several tasks, schema either beat NL or tied it closely while remaining far cheaper than XML.

However, the repo-native Task 1 result weakens that conclusion substantially for real development work. On the 12B tool-using worker, the best-performing prompt was not schema or compact NL, but ordinary natural language.

## Limitations

- This was a small exploratory benchmark, not a statistically rigorous evaluation.
- The tasks were mostly one-shot prompts, so they do not test cumulative correction cost.
- The model was only evaluated after disabling reasoning, which was necessary for clean outputs but may change how structure interacts with the model.
- The XML prompts used a fairly verbose style; a different XML schema might perform differently, though the compact schema results suggest verbosity is the bigger issue.
- The tasks were solvable in a single pass; XML may still show value on more ambiguous workflows or stricter multi-step execution tasks.
- The repo-native comparison currently covers one development-style benchmark task, not a full task suite.
- The repo-native result is sensitive to effective per-worker context, so prompt-format conclusions are partly entangled with runtime parallelism settings.

## Working Conclusion

For this Forge 12B configuration, the evidence so far suggests:

- `verbose XML` is not the right structured format
- for one-shot tasks, `compact NL` is strong
- for repo-native tool tasks, `normal NL` currently looks strongest
- `compact schema` may help on some small one-shot tasks, but it is fragile and expensive on real repo work

So the core idea may still survive in a revised form:

- not `XML beats natural language`
- but perhaps `ordinary clear natural language` is already the best default for worker tasks
- and any structured alternative must prove itself against that stronger baseline, not just against XML

## Next Experiments

The most useful follow-up experiments are:

1. Run the same 3-way comparison on weaker local models.
2. Use harder tasks with more constraints and more ways to fail.
3. Measure multi-turn correction cost, not just first-pass token cost.
4. Test coordinator-to-worker task packets rather than direct one-shot prompts.
5. Compare compact schema variants to find the best structure density.
6. Replicate Task 1 on the 26B under the same `32k` per-worker context budget.
7. Add 1-2 more repo-native tasks before drawing broader conclusions.

If the goal is to salvage the original research direction, the next test should emphasize:

- longer workflows
- correction rounds
- weaker workers
- normal NL as the true baseline
- compact structure only if it can beat normal NL on real repo tasks
