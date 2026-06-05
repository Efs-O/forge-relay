# Shared Agent Prompt

Read this before continuing work in this repository.

> This is the canonical coordination prompt; [AGENTS.md](AGENTS.md) (auto-loaded by
> the Codex extension) is kept in sync with it. Both agents coordinate through the
> **Forge Relay MCP tools**, not the PowerShell scripts.

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

Coordinate **exclusively through the Forge Relay MCP tools**, injected into your
session as `forgerelay` MCP tools by the managed bridge. Do **not** run the
PowerShell scripts in `scripts/` for coordination — they are a legacy human
debugging CLI only.

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

1. `board_check` with `agent="<agent-name>"`.
2. If it returns `BLOCKED`, stop: `ack_command` the blocking id and do no further
   work until an operator resolves it.
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

## Claim / Reporting

```
claim   agent="<agent-name>" targets=["<repo-relative-path>"] note="<scope>"
release agent="<agent-name>" targets=["<repo-relative-path>"]
post    agent="<agent-name>" note="your message here"
```

Note format: plain ASCII only, one line only, no emojis, no bullets.

## Sync Wait Rule

When you need an explicit response from the other agent:

1. `post` the question or handoff.
2. Poll with `board_check` / `get_status` for up to 100 seconds.
3. If no reply, post a follow-up or proceed only if non-blocking.

## Debugging fallback (humans only)

The `scripts/*.ps1` files write the same `.coordination/*.json` board files
directly and are retained as a manual operator/debugging CLI only. The real verbs
are `-Action history` (recent events) and `-Action status` (active claims) — not
`recent`/`claims`.

## This protocol is not optional.

It is the current operating protocol for parallel work in this repo.
