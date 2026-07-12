# Forge Relay — Current Status

Last refreshed: 2026-07-13

## Released

`Efsoo.forge-relay` version 0.5.1 is published on the VS Code Marketplace.
The repository `main` branch includes the following completed roadmap work:

- FR-1: hierarchical file/folder claim conflicts
- FR-2: push-based board updates with a polling backstop
- FR-3: the configured `run_build` coordination wrapper
- FR-5: persistent task cards, lifecycle validation, and MCP task tools
- FR-6: Marketplace publication

The 0.5.1 release passed TypeScript type-checking, all 132 automated tests,
and VSIX packaging.

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
