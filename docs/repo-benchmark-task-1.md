# Repo Benchmark Task 1

## Purpose

This benchmark is meant to test prompt formats on a realistic repository-oriented development task rather than a toy formatting task.

The target comparison is:
- normal natural language
- compact natural language
- compact schema/tags

Verbose XML is intentionally excluded from this benchmark because earlier tests on the Forge 12B setup showed it was consistently more expensive without a correctness advantage.

## Repo Context

Repository:
- `forge-relay`

Focus area:
- same-model Forge worker fan-out
- worker dispatch reliability
- safe fix planning

Relevant files:
- `src/subagentLoop.ts`
- `src/forgeHold.ts`
- `docs/TODO-forge-concurrency-hardening.md`

## Benchmark Task

Investigate why Forge Relay workers can fail during same-model parallel fan-out and produce a safe patch plan.

The model should read the listed files, identify the most likely root cause, and propose a practical implementation and validation approach.

## Expected Output

Return exactly 5 sections with these headings:

1. `ROOT_CAUSE`
2. `AFFECTED_PATHS`
3. `PATCH_PLAN`
4. `VALIDATION`
5. `RISKS`

## Scoring Criteria

Score each run on:

1. Root-cause accuracy
   The explanation should match evidence in the repo rather than generic concurrency guesses.

2. File/path relevance
   The answer should identify the actual code paths involved.

3. Patch quality
   The plan should be safe, concrete, and implementable.

4. Validation quality
   The answer should include realistic checks or tests, not vague statements.

5. Drift / hallucination control
   The answer should avoid inventing behavior not supported by the files.

6. Token cost
   Compare backend-reported prompt/completion/total tokens.

## Normal NL Prompt

```text
I want you to help me investigate a reliability problem in this repository.

Please read these files carefully:
- src/subagentLoop.ts
- src/forgeHold.ts
- docs/TODO-forge-concurrency-hardening.md

The issue I want you to investigate is why Forge Relay workers can fail during same-model parallel fan-out.

After reading the files, explain what you think the most likely root cause is, which code paths are involved, what patch approach should be taken, how that patch should be validated, and what the main risks are.

Please stay grounded in the repository evidence. Do not invent behavior that is not supported by the files. Focus only on same-model Forge dispatch problems, not unrelated worker issues.

Keep the answer concise but specific.

Return exactly 5 sections with these headings:
ROOT_CAUSE
AFFECTED_PATHS
PATCH_PLAN
VALIDATION
RISKS
```

## Compact NL Prompt

```text
Investigate a same-model worker fan-out failure in this repo.

Read:
- src/subagentLoop.ts
- src/forgeHold.ts
- docs/TODO-forge-concurrency-hardening.md

Goal:
Find the most likely cause of worker failures during same-model parallel dispatch and propose a safe fix plan.

Constraints:
- Do not invent code that is not supported by the files
- Prefer evidence from the repo over general guesses
- Focus on same-model Forge dispatch, not unrelated worker bugs
- Keep the answer concise but specific

Return exactly 5 sections with these headings:
ROOT_CAUSE
AFFECTED_PATHS
PATCH_PLAN
VALIDATION
RISKS
```

## Compact Schema Prompt

```text
TASK: investigate_same_model_fanout_failure
FILES: src/subagentLoop.ts | src/forgeHold.ts | docs/TODO-forge-concurrency-hardening.md
GOAL: identify most likely cause of worker failures during same-model parallel dispatch and propose safe fix plan
SCOPE: same-model Forge dispatch only
RULES: repo-evidence-only | no-invented-code | concise-but-specific | ignore-unrelated-worker-bugs
OUTPUT: exactly-5-sections
SECTIONS: ROOT_CAUSE | AFFECTED_PATHS | PATCH_PLAN | VALIDATION | RISKS
SUCCESS: root cause matches repo evidence | affected paths are concrete | plan is safe and testable
```

## Why This Task Is Useful

This task is closer to real development work because it requires:
- reading multiple files
- tracking a concrete subsystem
- identifying causality rather than just formatting output
- producing a fix plan instead of only extracting data

It is a better discriminator for practical worker usefulness than simple JSON extraction or CSV rendering tasks.

## Suggested Run Order

1. Run the normal NL prompt on the 12B model.
2. Run the compact NL prompt on the 12B model.
3. Run the compact schema prompt on the 12B model.
4. Compare correctness, specificity, context use, and token cost.
5. Repeat the same three runs on the 26B model.
6. Compare whether compactness or structure is the bigger advantage.

## Suggested Result Template

Use this when recording outcomes:

```text
Model:
Prompt format:

ROOT_CAUSE score:
AFFECTED_PATHS score:
PATCH_PLAN score:
VALIDATION score:
DRIFT score:

Prompt tokens:
Completion tokens:
Total tokens:

Notes:
```
