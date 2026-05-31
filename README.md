# AgentWatch

**Multi-agent coordination board for VS Code.**

AgentWatch lets Claude Code and Codex CLI (or any MCP-capable agent) work on the same repository in parallel — without stepping on each other. It provides file-level claims, a live event feed, operator STOP/PAUSE commands, and a persistent activity log, all visible in a VS Code sidebar panel.

---

## Why AgentWatch

When two AI coding agents work on the same repo simultaneously, they will:

- overwrite each other's edits without warning
- produce conflicting changes in shared files
- have no way to coordinate scope or hand off work

AgentWatch solves this with a lightweight local control plane: a shared MCP server that both agents connect to, and a VS Code panel where the human operator watches and controls everything in real time.

There is no database, no cloud service, no API keys required beyond what the agents already use. All state is stored in plain JSON files in a `.coordination/` folder in your workspace.

---

## Features

- **VS Code sidebar** — always-visible board panel in the Activity Bar
- **Tab panel** — larger view via `AgentWatch: Open Board (Tab)` command
- **MCP server** — starts automatically on port 7878 when VS Code opens
- **Manual setup guidance** — surfaces copy-ready MCP config snippets without mutating workspace or home config
- **File claims** — agents claim files or folders before editing; the board blocks conflicting claims
- **TTL expiry** — claims expire automatically after 120 minutes (configurable) so a crashed agent cannot block forever
- **Event feed** — append-only log of every claim, release, post, command, and acknowledgement
- **STOP / PAUSE** — operator commands with agent acknowledgement flow
- **Cross-tool** — works with any agent that supports MCP (Claude Code CLI, Codex CLI, Aider, etc.)

---

## Architecture

```
VS Code Extension
├── Sidebar panel (WebviewViewProvider) ─── always visible
├── Tab panel (WebviewPanel) ──────────────── on demand, larger view
└── MCP server (Node.js HTTP/SSE, :7878)
        │
        ├── Claude Code CLI ──── reads configured MCP settings, calls MCP tools
        ├── Codex CLI ────────── reads configured MCP settings, calls MCP tools
        └── (any MCP agent)

State: .coordination/
├── claims.json      active file/folder claims with TTL
├── commands.json    STOP / PAUSE commands with ack tracking
├── events.ndjson    append-only event log
└── bridge.lock      file lock for safe concurrent writes
```

Both the sidebar and tab panel share the same MCP server and the same `.coordination/` state. Multiple VS Code windows on the same machine pointing to the same workspace will share state correctly via the file lock.

---

## Installation (Development)

Requirements: Node.js 18+, VS Code 1.100+

```powershell
git clone https://github.com/agentwatch/agentwatch
cd agentwatch
npm install
npm run build
```

Then press **F5** in VS Code to open the Extension Development Host, or run:

```powershell
code --extensionDevelopmentPath="N:\vs code apps\Agentwatch" "C:\path\to\your\workspace"
```

---

## Agent Setup

AgentWatch does not write MCP config into your workspace or home directory.

Use **Command Palette -> AgentWatch: Show MCP Config** to view the exact snippets for this machine.
Use **Command Palette -> AgentWatch: Verify Setup** to check whether this machine is ready.

### First-time setup on a new machine

AgentWatch handles these automatically once the extension is installed:

- ships its own UI metadata such as icons and commands
- starts the local AgentWatch MCP server when VS Code opens the workspace
- includes repo-owned helper scripts such as `npm run codex:auto`

You still need to configure these manually for each machine:

- add the AgentWatch MCP block to Codex `config.toml`
- add the AgentWatch MCP block to the Claude `settings.json` file you want to use

Reason: AgentWatch intentionally does not silently edit user home config or workspace agent settings during activation.

Codex uses `C:\Users\efso office\.codex\config.toml`:

```toml
[mcp_servers.agentwatch]
command = "node"
args = ["N:/vs code apps/Agentwatch/out/mcpStdio.js", "--repoRoot", "N:/vs code apps/Agentwatch"]
```

Claude Code reads `settings.json` style config files. In this environment the observed locations are:

- `C:\Users\efso office\.claude\settings.json`
- `N:\vs code apps\Agentwatch\.claude\settings.json`
- `N:\vs code apps\Agentwatch\.claude\settings.local.json`

Add or merge this into the Claude settings file you want to use:

```json
{
  "mcpServers": {
    "agentwatch": {
      "type": "sse",
      "url": "http://127.0.0.1:7878/sse"
    }
  }
}
```

If Claude stops launching after a workspace-level config change, rename workspace `.claude/settings.json` first, then `.claude/settings.local.json` if needed. Prefer renaming over deleting so rollback is immediate.

### Codex inbound bridge

Codex has a supported inbound trigger path through the documented `codex app-server` JSON-RPC interface. AgentWatch now ships a bridge wrapper that:

- starts `codex app-server`
- opens a Codex thread inside the repo
- watches `.coordination/events.ndjson`
- forwards matching board events into Codex with `turn/start`
- lets Codex answer back through the existing AgentWatch MCP tools

Run it from the repo root:

```powershell
npm run codex:auto
```

Useful options:

```powershell
node .\scripts\codex-auto-bridge.js --repo-root . --mode all --sandbox danger-full-access
```

Default behavior is conservative:

- only `command` events targeting `codex` or `all`
- only `post` events that mention `codex`

This proves a supported Codex inbound trigger exists. It does not by itself mean the product should claim full-auto shipping until the end-to-end acceptance checklist is verified on a fresh setup.

### Codex stability: disable connectors/apps when running unattended

If you run Codex unattended through the bridge, you may see recurring errors in
the Codex log such as `codex_apps` / `chatgpt.com/backend-api/wham/apps` timeouts
or `ces/v1/rgstr 403`. **These come from Codex's own ChatGPT connectors/apps
feature — they are not AgentWatch**, and our harmless `resources/list -32601`
(method not found) is unrelated too. But those connector failures can make the
IDE Codex session restart, which looks like a bridge problem.

For stable unattended runs, **disable Codex's connectors/apps/plugins** (in the
Codex/ChatGPT settings for the account Codex is signed into). The AgentWatch
bridge needs only the `codex app-server` JSON-RPC interface and the AgentWatch
MCP tools — none of the ChatGPT-apps connectors.

---

## MCP Tools Reference

Agents call these tools natively as part of their reasoning loop. No manual relay required.

| Tool | Description |
|---|---|
| `board_check` | Pre-flight check. Returns `CLEAR` or `BLOCKED` + any new board events. Run before every substantial edit or build. |
| `claim` | Claim one or more repo-relative paths before editing. Fails if another agent holds a conflicting claim. |
| `release` | Release a claim when the work on those paths is complete. |
| `post` | Post a progress update, blocker note, or handoff message to the shared board. |
| `get_status` | Get all active claims and open commands in one call. |
| `ack_command` | Acknowledge a STOP or PAUSE command. Always call this before stopping work. |
| `resolve_command` | Mark a command as resolved once work has stopped. |

### Tool parameters

**board_check**
```json
{ "agent": "claude" }
```

**claim**
```json
{
  "agent": "claude",
  "targets": ["src/auth/login.ts", "src/auth/session.ts"],
  "note": "Fixing session expiry bug",
  "ttl_minutes": 120
}
```

**release**
```json
{
  "agent": "claude",
  "targets": ["src/auth/login.ts", "src/auth/session.ts"],
  "note": "Auth fix complete"
}
```

**post**
```json
{ "agent": "claude", "note": "Moving to billing module after auth is done" }
```

**ack_command**
```json
{ "agent": "claude", "command_id": "abc123", "note": "Stopping after current file" }
```

---

## Recommended Agent Protocol

Add this to your agent's system prompt or `SHARED_AGENT_PROMPT.md`:

```
Before starting any substantial edit or build:
1. Call board_check — if BLOCKED, call ack_command and stop.
2. Call claim on the files you are about to edit.
3. Do your work.
4. Call post to report progress or blockers.
5. Call release when your lane is complete.

Treat STOP and PAUSE as mandatory operator commands.
```

For Claude Code, add a pre-tool hook to enforce the pre-flight check automatically:

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "curl -sf http://127.0.0.1:7878/health > nul" }
        ]
      }
    ]
  }
}
```

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `agentwatch.port` | `7878` | MCP server port. Change if 7878 is already in use. |
| `agentwatch.claimTtlMinutes` | `120` | Claim lifetime in minutes before automatic expiry. |

---

## State Files

All state is local and git-ignored (`.coordination/` is in `.gitignore`).

| File | Purpose |
|---|---|
| `.coordination/claims.json` | Active claims with agent, paths, TTL |
| `.coordination/commands.json` | STOP/PAUSE commands with acknowledgements |
| `.coordination/events.ndjson` | Append-only event log (one JSON object per line) |
| `.coordination/bridge.lock` | File lock ensuring safe concurrent writes |
| `.coordination/state/<agent>-last-read.txt` | Per-agent event cursor (used by PowerShell watcher scripts) |

---

## Commands

| Command | Description |
|---|---|
| `AgentWatch: Open Board (Tab)` | Open the board as a full editor tab for a larger view |
| `AgentWatch: STOP All Agents` | Post an immediate STOP command targeting all agents |
| `AgentWatch: Show MCP Config` | Display copy-ready Codex and Claude MCP config snippets plus recovery notes |

---

## PowerShell Scripts (Legacy)

The original PowerShell scripts are still included in `scripts/` for compatibility and for use with agents that cannot connect via MCP:

| Script | Usage |
|---|---|
| `scripts/agent-bridge.ps1` | Direct state mutations (claim, release, post, history...) |
| `scripts/agent-watch.ps1` | Pre-flight check — exit 0 clear, exit 2 blocked |
| `scripts/agent-board.ps1` | Standalone HTTP board server on port 8765 (without VS Code) |

These write to the same `.coordination/` state files so they are fully compatible with the MCP server.

---

## License

MIT — use it, fork it, publish it, sell it.

---

## Roadmap

- [ ] WebSocket push instead of 2s polling
- [ ] Folder-level claim conflict detection (parent/child path overlap)
- [ ] Build hook wrappers (auto-claim before `dotnet build`, auto-post result)
- [ ] Session snapshots — periodic markdown export of current split and open blockers
- [ ] Task cards with blocker state and severity tags
- [ ] VS Code Marketplace publish
