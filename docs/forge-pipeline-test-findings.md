# Forge pipeline test findings and patch recommendations

**Date:** 2026-07-17

**Status:** Forge Relay remediation implemented; 219 automated tests and the
installed R3 live acceptance suite pass. The richer upstream Forge catalog
contract remains a cross-repository release gate. See
`docs/FORGE_RELAY_PIPELINE_REMEDIATION_PLAN_2026-07-17.md`.

Post-reload startup initially exposed two Codex 0.144.4 configuration parser
requirements: defining `[permissions]` without `default_permissions` is fatal,
and passing the complete `filesystem` table through one `-c` override parses it
as a string. Relay now sets the default selector and emits flattened
`:minimal`/`:root` keys plus a scoped `:workspace_roots` inline table. The exact
generated argument set keeps a real app-server alive in a direct binary smoke.

The next reload exposed that VS Code's extension-host `PATH` may omit the npm
shim directory even when Codex works in the integrated terminal. Relay now
falls back to the standard per-user `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`
entry and launches it directly through Node with `shell:false`. Explicit custom
executables still fail closed rather than silently switching installations.

Installed R3 acceptance then passed the managed native gate, user-authored board
delivery, claimed canonical write/exact read-back/release, task lifecycle,
Forge-first catalog (49 models), synchronous Codex worker, durable asynchronous
worker completion, and fail-closed build behavior. Final board status had no
claims, commands, or open tasks. One non-blocking diagnostic remains: the worker
route reported `codex-cli 0.144.2` while the terminal/managed path previously
reported `0.144.4`, indicating client-specific PATH resolution.

## Implementation status (2026-07-17)

The detailed sections below preserve the original pre-patch observations and
contract recommendations. This table is the current implementation record for
this repository.

| Finding | Relay status | Residual dependency |
|---|---|---|
| Catalog/backend drift | Patched: current selections, explicit routes, availability, and `/ensure` model/backend are validated. | Forge should emit a versioned canonical catalog descriptor. |
| Missing platform context | Patched: prompts include canonical repo root, platform, architecture, path style, and argv contract; command errors are typed. | Installed cross-platform smoke. |
| Incorrect terminal classification | Patched: succeeded, failed, aborted, and exhausted are distinct and drive board/tool output. | Installed lifecycle smoke. |
| Token-budget mismatch | Patched: per-round `max_tokens`, cumulative `max_total_tokens`, independent `max_steps`, and a validated deprecated `token_budget` compatibility field. | Agree the final Forge-side field name. |
| Missing loop detection | Patched in worker and coordinator tool loops with canonical call/result fingerprints. | Tune thresholds only if live workloads reveal false positives. |
| Ambiguous async contract | Patched: JSON receipt, durable run ID/state, and `get_subagent_run`. | Caller-provided cross-client idempotency remains optional follow-up. |
| Unsafe Git footer | Patched: blanket restore advice removed; recovery is worker-path scoped and review-first. | None. |
| Availability states | Patched: richer states/reasons/actions are parsed, displayed, and enforced with legacy normalization. | Forge must populate the richer fields for full fidelity. |

In addition, installed Clanker smokes exposed a Codex 0.144.4 Windows split-root
failure. Even after app-server echoed the canonical `runtimeWorkspaceRoots` and
the built-in `:workspace` profile, `apply_patch` rejected the repository as
outside the project and wrapped PowerShell was policy-blocked. The working CLI
path used the Windows `unelevated` sandbox without writable C: temp roots. Relay
now defines a `forge-relay-clanker` permission profile: global reads, writes only
under the canonical runtime workspace, `.git`/`.agents`/`.codex` protected as
read-only, network disabled, and `windows.sandbox=unelevated`. A native
create/update/read/delete command gate runs before Clanker is declared ready or
allowed to start a model turn. Draft remains `:read-only`.

Standalone Codex MCP now discovers Forge control through the per-user registry
when no environment override is present. `Configure Codex` also installs the
complete safe approval set (including `release` and lifecycle/query tools),
while refusing to overwrite a conflicting user policy. The new `Forge Relay:
Run Runtime Acceptance Matrix` command exercises these live contracts and keeps
all case failures in one report.

## 1. Scope and ownership

The test summary identified eight related weaknesses:

1. catalog/backend drift;
2. missing platform context for command tools;
3. incorrect terminal-state classification;
4. token-budget API mismatch;
5. missing loop detection;
6. an ambiguous asynchronous dispatch contract;
7. an unsafe Git recovery footer; and
8. insufficient model-availability states.

The initial report called these "Forge-only" findings because they appeared
while exercising the Forge-backed pipeline. Local inspection shows that the
remediation boundary is shared:

- Forge owns the authoritative model catalog, backend selection, provider
  availability, and any native pipeline/goal budget contract.
- Forge Relay owns worker prompting, command-tool presentation, worker lifecycle
  classification, board-facing async dispatch semantics, loop protection in its
  coordinator/worker loops, and the Git checkpoint text it emits.
- Both sides need a versioned contract so Relay does not infer runtime behavior
  from loosely related catalog booleans.

No recommendation below should weaken the coordination-directory VS Code-install
guard. This work is unrelated to profile or coordination-root resolution.

## 2. Executive risk summary

| Finding | Primary risk | Severity | Likely owner |
|---|---|---:|---|
| Catalog/backend drift | A listed model routes to a different or unusable backend | High | Forge contract, Relay validation |
| Missing platform context | The model chooses commands for the wrong OS or shell | High | Relay prompt/tool context |
| Incorrect terminal classification | Partial or failed work is reported as complete | Critical | Relay lifecycle model |
| Token-budget mismatch | A caller's limit is ignored or rejected | High | Forge/Relay API contract |
| Missing loop detection | Repeated tool calls waste tokens and mutate repeatedly | High | Both agent loops |
| Ambiguous async contract | The caller treats acceptance as completion | High | Relay tool contract |
| Unsafe Git footer | Recovery advice destroys unrelated local edits | Critical | Relay reporting |
| Availability states too weak | UI and routing cannot distinguish busy, loading, or broken | High | Forge catalog contract |

## 3. Detailed findings

### 3.1 Catalog/backend drift

#### Problem

Model discovery, coordinator selection, and execution do not share one strongly
validated routing record. A catalog entry can be stale or incomplete while the
backend selected by `/ensure` or `/chat` has changed. That makes a successful
catalog listing weaker than an execution-readiness guarantee.

Relay currently consumes a small, permissive shape from Forge: `name`,
`provider`, `backend`, `loaded`, `servable`, and `profiles`. The coordinator
decides whether to use `/ensure` or `/chat` from `servable !== false`. If the
selected entry is missing from a refreshed catalog, that expression defaults to
the local `/ensure` path instead of rejecting an unknown selection. For local
models, Relay later accepts the backend and model returned by `/ensure` without
checking them against the entry the operator selected.

Relevant code:

- `src/forgeCoordinatorBridge.ts`: `listModels()` and `start()` infer execution
  mode from the catalog's `servable` boolean.
- `src/subagent.ts`: `fetchModelCatalog()` accepts optional backend and
  availability metadata, while `forgeEnsure()` accepts the returned backend with
  a generic `forge` fallback.
- `media/board.js`: the coordinator dropdown renders every returned entry and
  only distinguishes `servable === false` as a provider label.

#### Failure modes

- A renamed or removed catalog entry remains selectable long enough to produce a
  misleading load failure.
- A provider model is sent to `/ensure`, or a local model is sent to `/chat`,
  because `servable` was omitted or stale.
- Backend migration changes execution behavior without changing the model name.
- Profiles are expanded client-side even when some model/profile combinations
  are not actually runnable.

#### Recommended patch

Forge should return a versioned execution descriptor for each selectable model,
for example:

```json
{
  "catalogVersion": "opaque-revision",
  "models": [{
    "id": "model@profile",
    "baseModel": "model",
    "profile": "main",
    "route": "ensure" | "chat",
    "backend": "llamacpp" | "ollama" | "cerebras" | "xai",
    "availability": "ready" | "loadable" | "loading" | "busy" | "degraded" | "unavailable" | "unknown",
    "reason": "bounded human-readable detail"
  }]
}
```

Relay should reject a selected ID that is absent from the latest catalog,
dispatch using the explicit `route`, and validate that `/ensure` resolves the
same canonical model/profile and a compatible backend. If the catalog changes
between selection and execution, refresh once and require the operator or
orchestrator to retry rather than silently switching route families.

#### Acceptance tests

- Catalog removal between dropdown load and Connect fails as stale selection.
- A changed backend or route is detected before the first completion.
- Only declared model/profile pairs are selectable.
- A catalog revision change forces revalidation.
- The same canonical record drives dropdown labels, dispatch, and diagnostics.

### 3.2 Missing platform context for command tools

#### Problem

The agentic worker prompt tells the model that it may run commands but does not
identify the host platform, path style, shell availability, repository root, or
the fact that `run_command` is an argv-style, shell-free interface. The tool
description says commands are cross-platform and forbids shell operators, but
that is not enough for a model choosing between PowerShell, `cmd`, POSIX shell,
and platform-specific executables.

Relevant code:

- `src/subagentLoop.ts`: `systemPrompt()` contains role and autonomy only.
- `src/workerTools.ts`: `run_command` accepts `command`, `args`, optional `cwd`,
  and `timeout_ms`; platform adaptation happens after the model has chosen the
  command.

#### Failure modes

- Unix commands are proposed on Windows or PowerShell syntax is sent as argv.
- Backslashes, drive letters, quoting, and executable suffixes are mishandled.
- The model attempts pipes, redirects, `&&`, or shell built-ins despite the
  shell-free contract.
- A command fails repeatedly because the agent cannot distinguish a missing
  executable from bad syntax.

#### Recommended patch

Add a bounded, non-secret execution-context object to the system prompt or tool
metadata:

```text
platform=win32
arch=x64
path_style=windows
command_contract=executable-plus-argv; no shell operators
repo_root=<workspace root or a stable placeholder>
available_shells=[powershell]   # only if actually probed
```

Prefer capabilities over assumptions. If shell commands are intentionally not
supported, say so explicitly and provide examples of valid argv calls for the
current platform. Return structured command errors containing `kind`, `program`,
and `exitCode` so the agent can correct a command without guessing.

#### Acceptance tests

- Windows and POSIX prompts expose the correct path and command contract.
- The model-facing schema contains one valid platform-specific example.
- Shell built-ins/operators are rejected with an actionable structured result.
- Missing executable, timeout, non-zero exit, and policy refusal are distinct.

### 3.3 Incorrect terminal-state classification

#### Problem

Not every normal return from the worker loop represents successful completion.
The current loop returns a normal `WorkerLoopResult` when it reaches its step
limit. The caller then posts `done` and, in synchronous mode, labels it
`COMPLETED` unless the result has an `aborted` field. Tool executors also return
errors as ordinary text, so a model can stop after a failed tool call and still
be classified as successful.

Relevant code:

- `src/subagentLoop.ts`: `runWorkerLoop()` returns `Reached step limit ...`
  without a failure state.
- `src/subagentLoop.ts`: `runWork()` posts `done` for every returned result;
  synchronous formatting checks only `result.aborted` before choosing
  `COMPLETED`.
- `src/workerTools.ts`: execution failures are converted to `ERROR (...)` text
  rather than a typed tool outcome.

#### Recommended patch

Make termination explicit and exhaustive:

```ts
type WorkerTerminalState =
  | { state: 'succeeded'; summary: string }
  | { state: 'failed'; error: string; retryable: boolean }
  | { state: 'aborted'; reason: string }
  | { state: 'exhausted'; limit: 'steps' | 'tokens' | 'time' }
  | { state: 'dispatched'; runId: string };
```

Only `succeeded` may generate `done`/`COMPLETED`. Step or token exhaustion should
generate `exhausted`, tool failure without recovery should generate `failed`, and
STOP/PAUSE should generate `aborted`. Board posts and synchronous return values
must derive from the same terminal record.

#### Acceptance tests

- Step-limit exhaustion is never labeled done or completed.
- Empty output at token length is `exhausted(tokens)`.
- A terminal tool error is `failed`; a recovered tool error may still succeed.
- STOP is `aborted`, not failed or succeeded.
- Board lifecycle text and the tool return cannot disagree.

### 3.4 Token-budget API mismatch

#### Problem

The pipeline uses more than one name and semantic level for token limits. Forge
pipeline/goal calls were reported using a `token_budget` contract, while Relay's
worker dispatch exposes `max_tokens`. Relay interprets `max_tokens` as a
per-completion output cap and applies it to every round, not as a cumulative run
budget. Treating these as aliases would silently change meaning.

Relevant code:

- `src/subagent.ts`: `dispatch_subagent` exposes only `max_tokens`.
- `src/subagentLoop.ts`: the value is passed to every completion round while
  cumulative usage is merely observed.

#### Failure modes

- `token_budget` is rejected or ignored by a Relay dispatch.
- A run intended to consume at most N tokens consumes N output tokens on each of
  several rounds.
- Provider-specific reasoning tokens make the observed budget diverge further.
- A caller assumes budget exhaustion is terminal, while the worker reports
  completion or generic failure.

#### Recommended patch

Do not alias the fields without defining semantics. Adopt separate names:

- `max_output_tokens_per_round`: provider completion cap;
- `max_total_tokens`: cumulative prompt plus completion budget for the run;
- optionally `max_steps` and `timeout_ms` as independent limits.

If Forge must retain `token_budget`, define it as one of those concepts in the
published schema and translate explicitly at the integration boundary. Reject
unknown budget fields and invalid combinations. Return consumed and remaining
budget in structured lifecycle data, and classify exhaustion as
`exhausted(tokens)`.

#### Acceptance tests

- Contract tests pin the accepted field names on both sides.
- A multi-round run cannot exceed `max_total_tokens` beyond one in-flight round's
  documented accounting tolerance.
- Per-round and total limits can be used independently.
- Unsupported budget fields fail loudly rather than being dropped.

### 3.5 Missing loop detection

#### Problem

The worker and coordinator have hard step caps, but neither detects a repeated
tool-call cycle before reaching the cap. A fixed limit bounds the damage; it does
not distinguish legitimate multi-step work from repeatedly issuing the same
failed read, command, post, dispatch, or status call.

Relevant code:

- `src/subagentLoop.ts`: the worker stops at a configurable/default 12 steps.
- `src/forgeCoordinatorBridge.ts`: the coordinator stops after 12 tool rounds.
- `src/toolCompletionRound.ts`: tool calls are executed in order with no
  fingerprint, progress, or repeated-error tracking.

#### Recommended patch

Track a normalized fingerprint of each tool name plus canonicalized arguments
and a bounded fingerprint of its result. Detect at least:

- the same call and same result repeated three times;
- an alternating A/B cycle repeated three times;
- repeated errors with no intervening successful or state-changing result;
- repeated dispatch of the same task/model while an earlier async run is live.

On detection, stop with `failed(loop_detected)` or ask for a materially different
plan once. Do not retry mutating tools automatically unless idempotency is known.
Board posts should include a short safe fingerprint, never full sensitive tool
arguments.

#### Acceptance tests

- Exact and A/B cycles stop before the generic step cap.
- Legitimate repeated pagination or polling with changing results is allowed.
- Repeated mutating calls are not executed after the loop threshold.
- Loop detection survives harmless JSON key-order differences.

### 3.6 Ambiguous asynchronous contract

#### Problem

`dispatch_subagent(mode="async")` returns a prose ticket immediately while the
real result exists only in later board posts. There is no structured run handle,
query operation, durable state machine, or formal definition of whether the tool
call means accepted, queued, started, or completed. Background errors are
intentionally swallowed after being posted to the board.

Relevant code:

- `src/subagent.ts`: the tool description says it "returns the worker result"
  and separately describes async behavior.
- `src/subagentLoop.ts`: async mode starts an unawaited promise and returns a
  `DISPATCHED (async)` string; background rejection is consumed because the error
  was posted.

#### Recommended patch

Return a structured acknowledgement:

```json
{
  "state": "accepted" | "queued" | "running",
  "runId": "stable-id",
  "worker": "worker-1:model",
  "resultChannel": "board",
  "terminalStates": ["succeeded", "failed", "aborted", "exhausted"]
}
```

Add a `get_subagent_run` operation or make the run a persistent task card whose
state can be queried. Every terminal board event should carry `runId` and a
machine-readable state in metadata. The orchestrator must not mark parent work
complete merely because dispatch was accepted.

#### Acceptance tests

- Acceptance, queueing, start, and terminal completion are distinguishable.
- A caller can recover terminal state after reload or missed board events.
- Async failures remain queryable and are not represented only by prose.
- Duplicate submission with the same idempotency key returns the existing run.

### 3.7 Unsafe Git recovery footer

#### Problem

The clanker checkpoint footer currently recommends:

```text
revert worker edits with: git restore .
```

That command restores every tracked path in the working tree, including edits
that existed before the worker started and unrelated edits made concurrently by
the operator or another agent. The checkpoint records only HEAD and the count of
dirty entries, so it cannot identify which changes belong to the worker.

Relevant code: `src/subagentLoop.ts`, `gitCheckpoint()`.

#### Recommended patch

Remove the blanket recovery command immediately. Replace it with a warning and
an evidence record:

- capture the baseline commit;
- capture the baseline set of dirty paths without modifying them;
- record the worker's actually mutated paths;
- optionally save a patch for only the worker-owned delta;
- prefer a dedicated Git worktree for unattended mutating workers.

Any suggested recovery must be path-scoped and must first check whether each
path changed after the worker finished. If safe automatic separation is not
possible, say "review the diff and restore selected paths" rather than emitting
a destructive one-liner. Never use `reset --hard`, `clean`, or repository-wide
restore as generated recovery advice.

#### Acceptance tests

- A pre-existing dirty file is never included in automatic recovery advice.
- Concurrent changes after worker completion prevent automatic restore.
- Worker-created untracked files and worker-modified tracked files are reported
  separately.
- Draft mode emits no misleading Git recovery command.

### 3.8 Insufficient model-availability states

#### Problem

The catalog exposes optional `loaded` and `servable` booleans. Those fields do
not represent the states an operator and dispatcher need: ready now, loadable,
currently loading, capacity-busy, provider-degraded, misconfigured, unsupported
on this platform, temporarily unreachable, or unknown because discovery failed.

The current dropdown renders all models and labels only provider-backed entries.
The worker catalog displays loaded/not-loaded metadata but cannot tell whether a
not-loaded model can be loaded successfully. `/ensure` errors later collapse
several readiness problems into HTTP status and prose.

#### Recommended patch

Use an explicit availability state plus a stable reason code:

```ts
type ModelAvailability =
  | 'ready'
  | 'loadable'
  | 'loading'
  | 'busy'
  | 'degraded'
  | 'unavailable'
  | 'unknown';
```

Suggested reason codes include `capacity_full`, `backend_down`,
`credentials_missing`, `platform_unsupported`, `model_missing`,
`profile_invalid`, and `catalog_stale`. The catalog should also state the
supported action: `dispatch`, `ensure`, `wait`, `configure`, or `none`.

Relay should disable definitely unavailable selections, display loading/busy as
temporary states, allow `loadable` models through `/ensure`, and treat `unknown`
as a diagnostic state requiring a fresh probe rather than as ready.

#### Acceptance tests

- Every catalog entry has one availability state and an execution action.
- Busy/loading states can transition to ready without changing model identity.
- Missing credentials and unsupported platform are not shown as generic down.
- UI, `list_models`, and dispatch errors use the same state/reason vocabulary.

## 4. Recommended implementation order

1. Remove the unsafe `git restore .` footer.
2. Introduce the exhaustive worker terminal-state type and correct board labels.
3. Formalize async run IDs and durable/queryable lifecycle state.
4. Define token-limit names and semantics with cross-component contract tests.
5. Add platform/command context to worker prompts and structured command errors.
6. Add repeated-call and no-progress loop detection.
7. Version the Forge catalog execution descriptor and validate routing drift.
8. Expand model availability and update the dropdown and `list_models` output.

Items 1-6 can be hardened in Relay without waiting for a new Forge catalog.
Items 7-8 require an agreed Forge API revision and should be released behind
backward-compatible parsing or a negotiated contract version.

## 5. Definition of done

This findings lane is complete only when:

- every issue has a regression test reproducing its original failure mode;
- terminal lifecycle is machine-readable and consistent across sync, async, and
  board events;
- token limits have one documented meaning per field;
- command tools receive truthful platform context;
- repeated no-progress calls stop safely before the generic step cap;
- no generated recovery instruction can erase unrelated working-tree changes;
- catalog entries state both routing and availability explicitly; and
- an installed pipeline smoke covers local, provider-backed, unavailable, async,
  exhausted, failed, and STOP-aborted runs.
