# Shared Agent Prompt

Read this before continuing work in this repository.

## Mission

You are one of two coding agents (claude, codex) working in parallel on this repository.
Coordinate through the AgentWatch board — do not collide on files or tasks.

## Repo Boundary

Work only inside:

- `N:\vs code apps\Agentwatch\`

## Shared Coordination Channel

The AgentWatch MCP server runs at `http://127.0.0.1:7878/`.

Board scripts are at `N:\vs code apps\Agentwatch\scripts\`.

**Replace `<agent-name>` with your assigned identity before proceeding.**

Assigned identities:

- `codex`
- `claude`

Before starting new work:

1. Check board state (watcher or board_check MCP tool)
2. Check active claims
3. Check for blocking commands
4. Post your intended scope if it changed
5. Claim files or folders before editing

If you post a question or handoff that requires the other agent to respond,
wait for a board reply before proceeding on that dependency.
Use polling waits up to 100 seconds when synchronization is required.

## Required Tools

Board and coordination scripts:

```
N:\vs code apps\Agentwatch\scripts\agent-bridge.ps1
N:\vs code apps\Agentwatch\scripts\agent-watch.ps1
```

## Session Startup

1. Run the watcher once to check board state.
2. Read recent events.
3. Check active claims.
4. Post your intended starting scope.
5. Claim your first target.
6. Begin work.

## Sync Wait Rule

When you need an explicit response from the other agent:

1. Post the question or handoff on the board.
2. Poll the board for up to 100 seconds for a reply.
3. If no reply arrives, post a follow-up or proceed only if non-blocking.

## Loop Or Watch Rule

When you need to monitor for a reply or coordination event:

1. Use your available persistent loop or watch skill if the current runtime provides one.
2. If no persistent loop or watch skill is available, simulate it by polling the AgentWatch board at a fixed interval.
3. Use a bounded polling window of 60 seconds by default.
4. Extend the polling window up to 100 seconds only when the dependency is explicit and synchronization is required.
5. Use the board as the source of truth for waits and replies rather than inventing an ad hoc wait mechanism.

## Required Operating Rules

1. Do not edit an unclaimed file or folder.
2. Do not take work already claimed by the other agent.
3. Run the watcher before substantial edits, builds, or long tasks.
4. Post progress and blockers back to the board.
5. Release claims when your lane is complete.
6. Treat `STOP` or `PAUSE` on the board as mandatory.

## Watcher Rule

Run from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File "N:\vs code apps\Agentwatch\scripts\agent-watch.ps1" -Agent <agent-name>
```

Interpretation:

- exit `0`: continue
- exit `2`: stop or pause work

## Claim Rule

Claim before editing:

```powershell
powershell -ExecutionPolicy Bypass -File "N:\vs code apps\Agentwatch\scripts\agent-bridge.ps1" claim -Agent <agent-name> -Target "<repo-relative-path>" -Note "<scope>"
```

Release when done:

```powershell
powershell -ExecutionPolicy Bypass -File "N:\vs code apps\Agentwatch\scripts\agent-bridge.ps1" release -Agent <agent-name> -Target "<repo-relative-path>"
```

## Reporting Rule

Post when starting, changing scope, finding a blocker, or finishing a lane.

Format constraints: plain ASCII only, one line only, no emojis, no bullets.

```powershell
powershell -ExecutionPolicy Bypass -File "N:\vs code apps\Agentwatch\scripts\agent-bridge.ps1" post -Agent <agent-name> -Note "your message here"
```

## Conflict Avoidance

If another agent holds a claim on a nearby area and your fix may overlap:

1. Stop before editing.
2. Post on the board.
3. Ask whether they want to keep the fix or hand it off.

If a claim attempt fails because another agent holds it, read the board first, then decide.

## This protocol is not optional.

It is the current operating protocol for parallel work in this repo.
