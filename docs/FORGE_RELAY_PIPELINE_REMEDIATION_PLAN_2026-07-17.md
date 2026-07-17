# Forge Relay pipeline remediation plan

**Date:** 2026-07-17

**Repository:** `forge-relay`

**Status:** Relay lane complete: 219 tests, build/package/install, and installed
R3 live acceptance pass. The richer Forge catalog descriptor remains
cross-repository work.

## 1. Scope

This plan addresses the eight findings in
`docs/forge-pipeline-test-findings.md` within Forge Relay only. It does not
change the sibling Forge repository or weaken the shared protection that keeps
`.coordination` out of VS Code installation directories.

Forge Relay can validate and safely consume richer catalog data, but Forge must
emit explicit route, backend, availability, reason, and action fields before the
full cross-repository contract is authoritative. Relay retains backward-compatible
normalization for the older `loaded` and `servable` fields.

## 2. Implemented work

| Finding | Forge Relay patch | Verification |
|---|---|---|
| Catalog/backend drift | Explicit catalog routes override boolean inference; stale or unavailable selections are rejected; `/ensure` must return the selected model/profile and compatible backend. | Routing and coordinator regression tests |
| Platform context | Worker prompts include repository root, OS, architecture, path style, and the shell-free executable-plus-argv contract. Command failures have structured kinds. | Prompt and worker-tool tests |
| Terminal states | Worker results use `succeeded`, `failed`, `aborted`, or `exhausted`; only success is reported as completed. | Step, token, STOP, and tool-result tests |
| Token budgets | `max_tokens` remains the per-round output cap; `max_total_tokens` is cumulative; `max_steps` is independent; deprecated `token_budget` is accepted only as the total-budget compatibility field and conflicts are rejected. | Multi-round budget tests and dispatch schema checks |
| Loop detection | Canonical tool-call/result fingerprints stop repeated and alternating no-progress cycles while allowing changing polls. The coordinator and worker both use the guard. | Exact-cycle, A/B-cycle, and changing-result tests |
| Async contract | Async dispatch returns a JSON receipt with a stable run ID. Lifecycle records persist under `.coordination/subagent-runs`, and `get_subagent_run` retrieves terminal state after reload. | Durable lifecycle and board-tool tests |
| Unsafe Git footer | Repository-wide recovery commands were removed. The footer tells operators to inspect the diff and restore only worker-owned paths. | Recovery-text regression test |
| Availability states | Relay recognizes ready, loadable, loading, busy, degraded, unavailable, and unknown states plus reason/action metadata. UI and routing block definite non-dispatchable states. | Catalog routing and UI/type checks |

Managed Codex now carries the canonical repository as `cwd` and
`runtimeWorkspaceRoots`, validates both the returned roots and active profile,
and uses a Relay-owned `forge-relay-clanker` permission profile. That profile
allows global reads but grants writes only to the workspace root, explicitly
protects `.git`, `.agents`, and `.codex`, disables network, and selects the
Windows `unelevated` sandbox. Unlike the built-in `:workspace` profile it does
not add writable temp roots on another drive. A deterministic native
create/update/read/delete probe is a startup and pre-turn readiness gate. Draft
turns remain read-only.

The standalone MCP server now auto-discovers Forge control when its environment
has no explicit route. Codex setup generates and verifies safe auto-approval
sections for all coordination lifecycle/query tools, including `release`, but
never auto-approves worker dispatch or builds. A command-palette runtime matrix
exercises board claim/release, Forge catalog routing, the managed native gate,
sync Codex command/read, and durable async completion in one report.

## 3. Implementation sequence

- [x] Remove unsafe repository-wide Git recovery advice.
- [x] Introduce exhaustive worker terminal states and structured tool errors.
- [x] Add durable async run receipts and a query tool.
- [x] Separate per-round, cumulative-token, and step budgets.
- [x] Add truthful platform and repository context before tool selection.
- [x] Add bounded no-progress loop detection to both tool loops.
- [x] Validate current catalog selection against route and `/ensure` results.
- [x] Add richer availability parsing, routing, diagnostics, and UI behavior.
- [x] Pin managed Codex `cwd`, workspace-write roots, and runtime project roots to the canonical repo.
- [x] Replace the built-in Windows workspace profile with a single-write-root Relay profile and native readiness gate.
- [x] Auto-discover Forge routing in standalone MCP and generate complete safe Codex approvals.
- [x] Add a live runtime acceptance matrix command that continues after case failures.
- [x] Run typecheck and the complete automated suite.
- [x] Run the equivalent live acceptance matrix against installed R3.
- [ ] Verify the richer catalog contract against a Forge build that emits all new fields.

## 4. Validation gates

Automated gates for this repository:

```text
npm run typecheck
npm test
npm run build
npx @vscode/vsce package --no-dependencies --out <temporary-vsix>
```

Installed acceptance must cover:

1. In Clanker mode, create, replace, and command-mediated edits inside the repo.
2. Confirm writes outside the canonical repo are refused.
3. Confirm draft mode remains read-only.
4. Exercise succeeded, failed, aborted, step-exhausted, and token-exhausted runs.
5. Dispatch asynchronously, reload the client, and recover the terminal record by run ID.
6. Select a loading, busy, unavailable, and stale Forge model and confirm dispatch is blocked.
7. Change the selected model's `/ensure` backend and confirm Relay detects drift.
8. Trigger exact and alternating tool loops and confirm no third repeated mutation executes.
9. Confirm generated recovery advice never recommends `git restore .`, hard reset, or clean.

## 5. Remaining cross-repository work

These items cannot be completed solely in Forge Relay:

- Forge should publish a versioned catalog revision and canonical model/profile ID.
- Every Forge catalog entry should emit explicit `route`, `backend`,
  `availability`, `reason`, and supported `action` values.
- Forge and Relay should share contract fixtures so a schema change fails CI on
  both sides.
- If duplicate async submission must be safe across independent callers, add a
  caller-provided idempotency key to both contracts. Relay currently prevents
  repeated live dispatches from its own detected tool loop and provides durable
  run IDs after acceptance.

## 6. Completion criteria

The Relay implementation lane is complete: automated build/package gates and
installed Clanker acceptance passed on 2026-07-17. The end-to-end Forge
contract lane is complete only after Forge emits and tests the richer catalog
descriptor; Relay's compatibility inference is a migration path, not a
replacement for that contract.
