# Shared Agent Prompt

Read this before continuing work in this repository.

## Mission

You are one of two coding agents (`claude`, `codex`) working in parallel on this
repository. Coordinate through the **Forge Relay board** — do not collide on files
or tasks.

**Replace `<agent-name>` with your assigned identity (`codex` or `claude`) in every
tool call below.**

## Repo Boundary

Work only inside:

- `N:\vs code apps\forge-relay\`

## Coordination Channel — use the Forge Relay MCP tools

Coordinate **exclusively through the Forge Relay MCP tools**. They are injected into
your session as `forgerelay` MCP tools by the managed bridge. Do **not** run the
PowerShell scripts in `scripts/` for coordination — they are a legacy human
debugging CLI only (see "Debugging fallback" at the bottom). Both agents now speak
to the board the same way, through these tools:

| Tool | Use it to |
|---|---|
| `board_check` | **Pre-flight.** Returns blocking status + new events. Run before any substantial edit, build, or long task. |
| `get_status` | List all active claims and open operator commands. |
| `claim` | Claim file(s)/folder(s) before editing them. |
| `release` | Release a claim when that lane is done. |
| `post` | Post a progress update, blocker, or handoff note. |
| `ack_command` | Acknowledge an operator command (STOP / PAUSE). |
| `resolve_command` | Mark an operator command as resolved. |

Every tool takes an `agent` argument — always pass your assigned identity.

## Session Startup

1. `board_check` with `agent="<agent-name>"` — check blocking status and new events.
2. If it returns `BLOCKED`, **stop**: `ack_command` the blocking command id and do
   no further work until an operator resolves it.
3. `get_status` to see active claims and open commands.
4. `post` your intended starting scope.
5. `claim` your first target.
6. Begin work.

## Required Operating Rules

1. Do not edit an unclaimed file or folder.
2. Do not take work already claimed by the other agent.
3. Run `board_check` before substantial edits, builds, or long tasks.
4. Post progress and blockers back to the board with `post`.
5. Release claims with `release` when your lane is complete.
6. Treat any `STOP` or `PAUSE` returned by `board_check` as mandatory — `ack_command`
   it and halt.

## Blocking-command Rule

`board_check` returns `BLOCKED` when there is an open operator `STOP`/`PAUSE`
targeting you (or `all`). This is the hard halt — the MCP equivalent of the old
watcher's non-zero exit. When you see `BLOCKED`:

1. `ack_command` the listed command id.
2. Stop all work. Do not claim, edit, build, or dispatch.
3. Resume only after the command is resolved (board_check returns `CLEAR`).

## Claim Rule

Claim before editing, release when done:

```
claim   agent="<agent-name>" targets=["<repo-relative-path>"] note="<scope>"
release agent="<agent-name>" targets=["<repo-relative-path>"]
```

`claim` denies the request if the other agent already holds the path — read the
board (`get_status`), then decide.

## Reporting Rule

`post` when starting, changing scope, finding a blocker, or finishing a lane.

Format constraints for notes: plain ASCII only, one line only, no emojis, no bullets.

```
post agent="<agent-name>" note="your message here"
```

## Sync Wait Rule

When you need an explicit response from the other agent:

1. `post` the question or handoff on the board.
2. Poll with `board_check` / `get_status` for up to 100 seconds for a reply.
3. If no reply arrives, post a follow-up or proceed only if non-blocking.

## Conflict Avoidance

If another agent holds a claim on a nearby area and your fix may overlap:

1. Stop before editing.
2. `post` on the board.
3. Ask whether they want to keep the fix or hand it off.

## Debugging fallback (humans only — not the agent's path)

The PowerShell scripts under `scripts/` (`agent-bridge.ps1`, `agent-watch.ps1`)
write the same `.coordination/*.json` board files directly. They are retained as a
**manual operator/debugging CLI only**. Agents must coordinate through the MCP
tools above, not these scripts. If a human runs them, the exact verbs are:

```powershell
# recent events  -> -Action history   (NOT "recent")
# active claims   -> -Action status    (NOT "claims")
pwsh scripts/agent-bridge.ps1 -Action history -Agent <agent-name>
pwsh scripts/agent-bridge.ps1 -Action status  -Agent <agent-name>
```

## This protocol is not optional.

It is the current operating protocol for parallel work in this repo.
