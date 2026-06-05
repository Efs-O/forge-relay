# Board Info

> **Legacy reference (script internals only).** Agents coordinate through the
> Forge Relay **MCP tools** — see [AGENTS.md](AGENTS.md) / [SHARED_AGENT_PROMPT.md](SHARED_AGENT_PROMPT.md).
> The PowerShell scripts described below are retained as a human debugging CLI;
> some paths in this file point at an older repo location and are illustrative only.

This repo includes a small local coordination board for parallel human or agent work.

Primary files:

- [scripts/agent-board.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-board.ps1)
- [scripts/agent-board.html](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-board.html)
- [scripts/agent-bridge.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-bridge.ps1)
- [scripts/agent-watch.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-watch.ps1)
- [AGENT_COORDINATION.md](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/AGENT_COORDINATION.md)

## Purpose

The board is a lightweight local control plane for multi-agent collaboration in one repo.

It solves four practical problems:

- visible public coordination between `user`, `codex`, and `claude`
- collision avoidance through file or module claims
- operator interruption with `STOP`
- a persistent activity log that survives page refreshes

It is intentionally local-first and simple. There is no external service, no database, and no auth layer.

## What It Does

- serves a local web UI on `http://localhost:8765/`
- shows a shared conversation feed
- shows active file or folder claims
- lets participants post messages
- lets the user issue `STOP`-style commands
- lets agents acknowledge and resolve commands
- stores all state under `.coordination/`

## What It Does Not Do

- it does not directly control another AI session
- it does not auto-inject prompts into Claude or Codex
- it does not kill running processes by itself
- it does not prevent bad coordination if participants ignore the protocol

So the board is a shared medium, not an autonomous orchestrator.

## Runtime Model

The system has three layers.

### 1. Board Server

[scripts/agent-board.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-board.ps1) runs a small `HttpListener` server.

Responsibilities:

- serve the HTML UI
- expose JSON endpoints
- read current coordination state
- delegate mutations to `agent-bridge.ps1`

Default port:

- `8765`

Start it with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-board.ps1
```

### 2. Bridge Layer

[scripts/agent-bridge.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-bridge.ps1) is the authoritative mutation layer.

Responsibilities:

- normalize target paths
- guard against out-of-repo paths
- lock state updates with a file lock
- append events
- manage claims
- manage commands and acknowledgements
- prune expired claims

Supported actions:

- `claim`
- `release`
- `status`
- `post`
- `history`
- `clear-expired`
- `command`
- `ack`
- `commands`
- `resolve`

Bridge read filtering:

- `history` also supports `-Since <datetime>`
- this allows incremental reads from `events.ndjson` without reprinting the full board history

### 3. Watcher

[scripts/agent-watch.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-watch.ps1) is a minimal pre-flight gate.

Responsibilities:

- read command state
- detect open `STOP` / `PAUSE` commands targeted at an agent or `all`
- track the agent's last-read timestamp locally
- print only new board entries since the last read
- return exit code `2` when work should not continue

Use it before edits, builds, or long tasks.

## State Storage

All board state lives in `.coordination/` and is git-ignored.

Files:

- `.coordination/claims.json`
- `.coordination/commands.json`
- `.coordination/events.ndjson`
- `.coordination/state/<agent>-last-read.txt`
- `.coordination/bridge.lock`

Reason for this design:

- easy to inspect manually
- no setup cost
- survives browser refreshes and server restarts
- supports simple append-only history for events

## Current UI Model

[scripts/agent-board.html](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-board.html) is a polling UI.

Current visible sections:

- shared conversation
- active claims
- live status
- active stop banner
- claim/release controls

Current polling style:

- the page refreshes board state every 2 seconds

Current participants:

- `user`
- `codex`
- `claude`

The board does not enforce those names, but using stable names is important for clarity.

## API Endpoints

The board server currently exposes these routes:

- `GET /`
- `GET /api/state`
- `POST /api/post`
- `POST /api/command`
- `POST /api/ack`
- `POST /api/resolve`
- `POST /api/claim`
- `POST /api/release`

High-level behavior:

- `state` returns the current claims, commands, and recent events
- `post` appends a conversation event
- `command` creates an operator command
- `ack` records that an agent saw a command
- `resolve` clears a command
- `claim` and `release` update ownership

## Command Model

Commands are intentionally simple. The board treats certain open commands as blocking.

Currently meaningful command words:

- `STOP`
- `PAUSE`

The watcher checks command text, target, and status.

Current statuses:

- `open`
- `acknowledged`
- `resolved`

Current targeting model:

- target one agent
- target `all`

## Claim Model

Claims are repo-relative paths with TTL.

Current rules:

- claims must stay inside the repo root
- identical paths cannot be claimed by two agents at once
- claims expire automatically after TTL unless renewed
- claims are best used on exact files or tightly scoped module folders

This protects against accidental overlap, especially in shared decompiled code.

## Operating Protocol

The board works best with a simple protocol.

Recommended loop:

1. `user` posts objective or constraint
2. `codex` and `claude` discuss split in the board
3. each agent claims files or modules
4. each agent works in their lane
5. each agent reports progress or blockers back to the board
6. `user` monitors and issues `STOP` if needed

This keeps the board readable and makes parallel work auditable.

## Why The Board Matters In This Repo

This codebase has several risk factors:

- large decompiled surface area
- many related `.csproj` files
- repeated decompiler artifacts
- frequent pattern-based fixes across modules
- multiple parallel workers

The board helps keep those risks manageable by making scope and movement visible.

## Known Limitations

Current technical limitations:

- polling, not push
- local machine only
- no authentication
- no session identity beyond the typed speaker name
- no automatic branch/worktree management
- no automatic merge/conflict analysis
- no hard process interruption

Current watcher behavior:

- first run creates the per-agent cursor without dumping the entire backlog
- later runs print only new entries
- blocking commands still take precedence and return exit code `2`

Current human/protocol limitations:

- participants still have to obey the board
- board messages do not auto-trigger another independent AI session
- if an agent ignores claims, the board cannot physically block file edits

## Good Uses Beyond The Current Task

This board can be reused for:

- code review coordination
- migration work split across subsystems
- build triage across many projects
- live regression test tracking
- release-room style coordination on one machine
- a local operator dashboard for semi-automated agent workflows

## Strong Extension Paths

If you want to exploit the board more, these are the highest-value next steps.

### 1. Stronger Agent Runtime Integration

Goal:

- reduce manual relaying between chat UIs and the board

Possible path:

- a small poller that reads board messages and prepares agent-facing prompts
- a thin adapter for each tool/UI if an API becomes available

This is the most important missing piece if you want near-autonomous collaboration.

### 2. Better Conflict Detection

Goal:

- catch folder-level overlap, not just exact path collisions

Possible path:

- detect parent/child path conflicts
- warn when one claim sits inside another agent's claimed module

### 3. Better Live Transport

Goal:

- reduce polling delay and improve "monitoring wall" behavior

Possible path:

- Server-Sent Events
- WebSockets

### 4. Richer Task Tracking

Goal:

- turn the board into a real lightweight ops console

Possible path:

- explicit task cards
- blocker state
- severity tags
- "needs help" flag

### 5. Build/Task Hooks

Goal:

- make the board reflect actual work, not just manual posts

Possible path:

- wrapper commands that post before and after `dotnet build`
- wrapper commands that auto-claim and auto-release known targets
- auto-post failure summaries

### 6. Persistent Session Snapshots

Goal:

- easier handoff and recovery after restarts

Possible path:

- periodic markdown export
- "current split" snapshot
- "open blockers" snapshot

## Minimal Commands

Check claims:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 status
```

Post a message:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 post -Agent codex -Note "Starting Tier 2 Network lane"
```

Claim a target:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 claim -Agent codex -Target "Decompiled\DWS.LIB.Network.NetSettings.v.9" -Note "Tier 2"
```

Release a target:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 release -Agent codex -Target "Decompiled\DWS.LIB.Network.NetSettings.v.9"
```

Check for blocking stop/pause:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-watch.ps1 -Agent codex
```

Read only newer history:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 history -Since (Get-Date).AddMinutes(-15)
```

## Suggested Positioning

Treat this board as a small local orchestration primitive.

Not a chatbot.
Not a task database.
Not a full agent framework.

It is a practical coordination layer that sits between:

- the user
- multiple active coding agents
- the shared working tree

That is why it is useful, and also why it is worth extending carefully rather than overcomplicating it too early.
