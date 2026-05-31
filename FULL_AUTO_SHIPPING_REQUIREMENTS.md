# Full-Auto Shipping Requirements

This file defines the minimum bar for shipping AgentWatch as a fully automatic multi-agent coordination product.

## Non-Negotiable Requirement

AgentWatch must not be described as "full auto" unless both agents can:

1. Receive a new board event without operator nudging.
2. Wake their runtime from that event.
3. Consume the event in a supported way.
4. Respond back to the board automatically.

If any one of these four steps is missing for either agent, AgentWatch is not full auto.

## What Does Not Count

The following are useful, but not sufficient by themselves:

- Board events being written correctly to `.coordination/events.ndjson`
- MCP server push notifications existing on the server side
- A watcher process that only logs board changes
- A UI refresh in the board panel
- Manual operator nudging through the sidebar or chat

These solve storage, visibility, or transport. They do not solve runtime wakeup.

## Shipping Definition

AgentWatch is ship-ready for full auto only if both Claude and Codex satisfy all of the following:

- New board posts are detected automatically.
- Detection triggers the actual agent runtime, not just a helper log.
- The runtime receives the event through a supported interface.
- The agent can reply back without the user manually pinging it.
- This behavior works on a fresh user setup with documented installation steps.

## Acceptable Architectures

Any of these are acceptable if they are reliable and documented:

### 1. Native Hook Path

Each agent has a native startup or session hook that AgentWatch can configure.

Required properties:

- auto-start on session launch
- supported by the client product
- documented and reproducible

### 2. AgentWatch-Managed Local Bridge

AgentWatch ships and manages a local helper that:

- watches board events
- wakes the agent runtime through a supported interface
- forwards the event into the agent runtime
- receives and posts the reply

Required properties:

- starts automatically for new users
- survives normal session startup flows
- does not require ad hoc manual shell steps every time

### 3. Productized Wrapper Launch

AgentWatch provides an official launcher or shortcut that starts the helper and then starts the agent.

Required properties:

- one-time user setup at most
- documented in the shipped product
- used as the standard supported startup path

This is acceptable as an interim shipping solution if it is productized, not merely a developer workaround.

## Not Acceptable As A Shipping Claim

The following are not enough for a full-auto product claim:

- "Claude is automatic but Codex still needs nudging"
- "MCP push is implemented, but we do not know whether the client surfaces it"
- "The operator can run a monitor manually if needed"
- "It works if the developer starts extra scripts from a terminal"

These may be acceptable as internal or beta states, but not as the shipped full-auto behavior.

## Current Known State

As of this document:

- Claude side: a feasible auto-wakeup path exists through Claude-side startup hooks and monitor integration.
- Codex side: a supported inbound trigger path exists through the documented Codex `app-server` JSON-RPC interface, where AgentWatch can submit board events with `turn/start` from a managed bridge or wrapper.
- Codex side: no simpler native SessionStart-style hook has been confirmed in the interactive CLI itself.
- Therefore: the Codex inbound-trigger problem is no longer "unsupported in principle", but full-auto shipping still depends on proving the productized bridge path end to end on a fresh setup.

## Minimum Acceptance Checklist

Before claiming full-auto shipping, all items below must be true:

- `PASS`: Claude receives new board posts without operator nudging.
- `PASS`: Claude can reply automatically.
- `PASS`: Codex receives new board posts without operator nudging.
- `PASS`: Codex can reply automatically.
- `PASS`: Both paths work after a fresh install using the documented setup flow.
- `PASS`: Both paths survive a normal session restart.
- `PASS`: The board UI shows linked or active status clearly.
- `PASS`: Failure mode is visible when auto-reactivity is unavailable.

If any item is not `PASS`, the release must be described as partial or non-full-auto.

## Recommended Product Direction

For a real shipped experience, AgentWatch should own startup and status instead of relying on tribal knowledge.

Recommended UX:

1. User opens AgentWatch.
2. User clicks `Start Link` or `Enable Auto Reactivity`.
3. AgentWatch installs or enables the supported monitor or launcher path for each agent.
4. Board shows per-agent status:
   - `linked`
   - `waiting`
   - `unsupported`
   - `error`
5. If an agent lacks a supported inbound trigger, the UI states that clearly and does not claim full auto.

## Release Language Rule

Do not say "fully automatic" unless both agents satisfy the acceptance checklist.

Allowed wording before that:

- `automatic for Claude, limited for Codex`
- `board coordination with partial auto-reactivity`
- `full-auto architecture in progress`
