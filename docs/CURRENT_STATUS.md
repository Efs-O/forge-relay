# Forge Relay — Current Status

Last refreshed: 2026-07-16

## Published

`Efsoo.forge-relay` version 0.5.1 is published on the VS Code Marketplace.
The repository `main` branch includes the following completed roadmap work:

- FR-1: hierarchical file/folder claim conflicts
- FR-2: push-based board updates with a polling backstop
- FR-3: the configured `run_build` coordination wrapper
- FR-5: persistent task cards, lifecycle validation, and MCP task tools
- FR-6: Marketplace publication

The Marketplace remains on 0.5.1.

## Stable 0.5.2 candidate

`main` now contains the Gemma/llama.cpp worker reasoning-overflow fix and a
test-runner cleanup that prevents stale bundles surviving branch switches.
Commit `3019566` packages this as `forge-relay-0.5.2.vsix`; it passed
type-checking, the production build, all 129 tests on `main`, VSIX inspection,
and a live Gemma 4 26B completion with thinking disabled. Marketplace
publication is still pending.

## Managed Codex experiment

The exclusive managed-Codex prototype remains separate on
`feat/managed-codex-relay`. Commit `0a2f4b8` packages it as the local-only
`forge-relay-managed-codex-experimental-0.6.0.vsix`. It includes the 0.5.2
fixes and passed type-checking, production build, all 171 feature-branch tests,
and VSIX inspection. It is opt-in, fails closed around shared ownership, and is
not part of stable `main` or the Marketplace release.

## Deferred

- FR-4: Markdown session snapshots. This is intentionally out of scope until
  it is explicitly resumed.

## Separate Follow-ups

These are not blockers for the released FR roadmap:

- `docs/BOARD_UI_OBSERVATIONS_PLAN.md` contains optional UI polish items.
- `docs/TODO-forge-concurrency-hardening.md` records a Forge-route hardening
  follow-up.
- `FORGE_COORDINATOR_PLAN.md` retains manual-soak and review gates for the
  Forge coordinator experiment.

For the currently approved scope, implementation is complete.
