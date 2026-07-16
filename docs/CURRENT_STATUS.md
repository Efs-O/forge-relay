# Forge Relay — Current Status

Last refreshed: 2026-07-17

## In development

The `feat/managed-codex-relay` branch is replacing the opt-in
managed-exclusive coordinator with a managed-isolated Codex runtime. MCP-only
remains the default. The isolated mode owns a standalone app-server, persistent
thread, workspace-specific `CODEX_HOME` and `CODEX_SQLITE_HOME`, and a profile
ownership lease. It uses separately provisioned OpenAI Platform API-key
authentication and does not read or copy the user's ordinary Codex credentials.

Existing Codex IDE, desktop, CLI, and other-workspace app-server processes are
allowed to remain active. Process discovery is diagnostic only; Forge Relay
neither blocks on nor terminates external Codex PIDs. The advanced
`forgeRelay.codexManagedProfileRoot` setting may relocate the profile root, but
Forge Relay still appends a deterministic workspace fingerprint.

The experiment targets version 0.7.0. Type checking, 181 automated tests,
production build, VSIX inspection, isolated protocol startup, and a live
Windows `1 -> 3 -> 1` app-server coexistence smoke pass. The 0.7.0 VSIX also
installs and activates successfully in a disposable VS Code 1.129 extension
host. It is not ready to merge to `main` until an operator reloads an installed
window and an operator-supplied Platform API key completes the board-event,
CLI/worker, multi-workspace, STOP/restart, and credential-leak acceptance checks.

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
