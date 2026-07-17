# Forge Relay

**Running Claude Code and Codex on the same project? Forge Relay stops them from overwriting each other's work — and gives you one panel to watch every agent, with a STOP button that actually works.**

Agents claim files before editing, conflicting claims are blocked, every action lands in a live audit feed in VS Code, and the operator can STOP or PAUSE any agent at any time. It works with any MCP-capable agent (Claude Code, Codex CLI, Aider, …), with zero cloud dependencies — all state is plain JSON files in your workspace.

On top of the safety layer, orchestrators get a `dispatch_subagent` tool for delegating work orders to cheaper workers: the **Codex CLI** (frontier-quality, flat-rate on a ChatGPT subscription) or **local models** (free, via Forge/Ollama/llama.cpp) — with the worker's lifecycle, file claims, and results all visible on the same board.

---

## Screenshots

**The board** — agent status, task input, and a live feed of claims, posts, and worker activity:

![Forge Relay board with live event feed](media/screenshot-board.jpg)

**Start an agent session** — pick which orchestrators participate (Claude in the background or driven from your own chat, or Codex via its own MCP session):

![Start Agent Session dialog](media/screenshot-session.jpg)

**Claims and operator controls** — active claims, open commands, and manual STOP / PAUSE / claim / release actions:

![Active claims and operator STOP/PAUSE controls](media/screenshot-controls.jpg)

---

## Why Forge Relay

When two AI coding agents work on the same repo simultaneously, they will:

- overwrite each other's edits without warning
- produce conflicting changes in shared files
- have no way to coordinate scope or hand off work

Forge Relay solves this with a lightweight local control plane for software maintenance: a shared MCP server that agents connect to, and a VS Code panel where the maintainer can watch, coordinate, and intervene in real time.

There is no database, no cloud service, no API keys required beyond what the agents already use. All state is stored in plain JSON files in a `.coordination/` folder in your workspace.

This is intentionally not a Codex-only or Claude-only wrapper. Forge Relay is built to coordinate real multi-agent maintainer workflows honestly: Codex and Claude can orchestrate work on the same board, and optional local workers can take delegated subtasks when cost or throughput matters more than using a frontier model for every step.

---

## Features

- **Maintainer control plane** - one board for claims, handoffs, STOP/PAUSE, and audit trail
- **VS Code sidebar** - always-visible board panel in the Activity Bar
- **Tab panel** - larger view via `Forge Relay: Open Board (Tab)` command
- **MCP server** - starts automatically on port 7878 when VS Code opens
- **Manual setup guidance** - surfaces copy-ready MCP config snippets without mutating workspace or home config
- **File claims** - agents claim files or folders before editing; the board blocks conflicting claims
- **TTL expiry** - claims expire automatically after 120 minutes (configurable) so a crashed agent cannot block forever
- **Event feed** - append-only log of every claim, release, post, command, and acknowledgement
- **STOP / PAUSE** - operator commands with agent acknowledgement flow
- **Codex + Claude support** - designed for mixed-agent workflows, not a single-vendor path
- **Codex worker dispatch** - `dispatch_subagent` with model `codex` runs a sandboxed `codex exec` work order, with the full board lifecycle
- **Optional local worker offload** - route delegated tasks to Forge-managed or OpenAI-compatible local backends
- **Cross-tool** - works with any agent that supports MCP (Claude Code CLI, Codex CLI, Aider, etc.)

---

## Architecture

```
VS Code Extension
|- Sidebar panel (WebviewViewProvider) --- always visible
|- Tab panel (WebviewPanel) -------------- on demand, larger view
\- MCP server (Node.js HTTP/SSE, :7878)
    |
    |- Claude Code CLI ---- reads configured MCP settings, calls MCP tools
    |- Codex CLI ---------- reads configured MCP settings, calls MCP tools
    \- (any MCP agent)

State: .coordination/
|- claims.json      active file/folder claims with TTL
|- commands.json    STOP / PAUSE commands with ack tracking
|- events.ndjson    append-only event log
\- bridge.lock      file lock for safe concurrent writes
```

Both the sidebar and tab panel share the same MCP server and the same `.coordination/` state. Multiple VS Code windows on the same machine pointing to the same workspace will share state correctly via the file lock.

---

## Installation (Development)

Requirements: Node.js 18+, VS Code 1.100+

```powershell
git clone https://github.com/Efs-O/forge-relay
cd forge-relay
npm install
npm run build
```

Then press **F5** in VS Code to open the Extension Development Host, or run:

```powershell
code --extensionDevelopmentPath="/path/to/forge-relay" "/path/to/your/workspace"
```

---

## Agent Setup

Forge Relay does not write MCP config into your workspace or home directory during activation. (One scoped exception: starting a Claude **Mode A** orchestrator maintains the `forgerelay` entry in the workspace `.mcp.json`, so the orchestrator it spawns can find its tools.)

Use **Command Palette -> Forge Relay: Get Started** for one-shot onboarding: it configures Codex and Claude, then opens the verification report.
Or run the pieces individually:
**Forge Relay: Configure Codex** writes the Codex `config.toml` entry; **Forge Relay: Configure Claude** writes the Claude `settings.json` entry;
**Forge Relay: Show MCP Config** shows the exact snippets for this machine; **Forge Relay: Verify Setup** checks whether this machine is ready.
After installing a development build, **Forge Relay: Run Runtime Acceptance Matrix** runs the live board, Forge route, managed-write, and Codex worker checks and opens a single pass/fail report.

### First-time setup on a new machine

Forge Relay handles these automatically once the extension is installed:

- ships its own UI metadata such as icons and commands
- starts the local Forge Relay MCP server when VS Code opens the workspace

You still need to wire the agents once per machine — run **Forge Relay: Get Started** to do both at once, or:

- add the Forge Relay MCP block to Codex `config.toml` — or run **Forge Relay: Configure Codex** to write it for you
- add the Forge Relay MCP block to Claude `settings.json` — or run **Forge Relay: Configure Claude** to write it for you

Reason: Forge Relay intentionally does not silently edit user home config or workspace agent settings during activation. (The **Configure Codex** / **Configure Claude** / **Get Started** commands are explicit, user-invoked exceptions: they write the `forgerelay` entry on demand and never clobber an existing one.)

Codex typically uses `~/.codex/config.toml`. Run **Forge Relay: Configure Codex** to create this automatically, or add it by hand:

```toml
[mcp_servers.forgerelay]
command = "node"
args = ["/absolute/path/to/extension/out/mcpStdio.js"]
```

Use **Configure Codex** or **Show MCP Config** for the complete generated block.
It adds explicit `approval_mode = "approve"` sections for safe board and
lifecycle/query tools, including `release`; worker dispatch and build execution
are intentionally not auto-approved. Existing conflicting user approval policy
is reported and never overwritten.

Do **not** add a hardwired `--repoRoot` argument to this global entry — Codex
resolves the board from each workspace's working directory, and a fixed
`--repoRoot` would make every Codex workspace write to the same board.
`Forge Relay: Verify Setup` flags this misconfiguration. (For an installed
extension, the `out/mcpStdio.js` path lives in the extension folder, e.g.
`~/.vscode/extensions/efsoo.forge-relay-<version>/out/mcpStdio.js` — run
`Forge Relay: Show MCP Config` to get the exact path for your machine.)

Claude Code reads `settings.json` style config files. In this environment the observed locations are:

- `~/.claude/settings.json`
- `<workspace>/.claude/settings.json`
- `<workspace>/.claude/settings.local.json`

Add or merge this into the Claude settings file you want to use:

```json
{
  "mcpServers": {
    "forgerelay": {
      "type": "sse",
      "url": "http://127.0.0.1:7878/sse"
    }
  }
}
```

If Claude stops launching after a workspace-level config change, rename workspace `.claude/settings.json` first, then `.claude/settings.local.json` if needed. Prefer renaming over deleting so rollback is immediate.

### Codex as an orchestrator

Codex participates on the board through the `forgerelay` MCP entry in its own
`~/.codex/config.toml` (see the setup snippet above). This **MCP-only mode is the
default** and Forge Relay does not own the Codex process.

An experimental **managed-isolated** mode is available behind
`forgeRelay.experimentalManagedCodex`. It starts a Relay-owned standalone Codex
app-server with one persistent thread and a deterministic workspace profile.
Its `CODEX_HOME`, `CODEX_SQLITE_HOME`, stdio, sessions, and workspace MCP routing
are separate from the OpenAI sidebar and ordinary Codex CLI. Other Codex PIDs
remain running and are diagnostic information, not startup conflicts.
Relay also pins the managed process to file-backed credentials and its isolated
SQLite path, so project-level Codex configuration cannot redirect either into a
shared keyring or database.

When **Start Session** finds that the isolated profile is not authenticated, it
offers **Sign in with ChatGPT**, opens Codex app-server's official browser OAuth
flow, and retries the session automatically after successful login. The same
flow is also available manually through **Forge Relay: Sign In Isolated Codex
with ChatGPT**. Codex owns token storage and refresh; Forge Relay never copies or
reads the normal profile's credentials. Managed requests use the ChatGPT Codex
subscription and its limits—no OpenAI Platform API key is required or accepted
by this path.

This remains experimental because historical Codex builds occasionally reported
OAuth refresh-token invalidation when multiple long-lived clients were active.
Current Codex provides server-side mitigation, but Forge Relay will not claim
merge readiness until the sidebar and isolated runtime survive live concurrent
turns and a refresh/soak gate.

The **Codex worker backend** is different: each `dispatch_subagent` with model
`"codex"` runs one short-lived `codex exec` work order that exits when the task
finishes. Relay continues to serialize worker dispatches with one another, but
the isolated subscription-managed app-server may coexist with that worker lane.

Codex log noise such as `codex_apps` / `chatgpt.com/backend-api/wham/apps`
timeouts comes from Codex's own ChatGPT connectors/apps feature, not Forge
Relay. For stable sessions, disable Codex's connectors/apps/plugins.

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

### Codex as a worker

`dispatch_subagent` can hand a work order to the **Codex CLI** — no local model
required:

- model `"codex"` runs the task via `codex exec` in the coordinated repo with
  your Codex CLI default model; `"codex:<model>"` picks a specific one
- the worker is sandboxed by board autonomy: **draft** → `--sandbox read-only`
  (investigate and report), **clanker** → `--sandbox workspace-write` (edit and
  run inside the workspace); Relay never bypasses Codex's sandbox
- lifecycle lands on the board like any worker (`worker-N:codex` started/done
  posts), board STOP/PAUSE kills the run, and `mode:"async"` fan-out works
- requires the Codex CLI (`npm i -g @openai/codex`) and an existing Codex
  login; each dispatch is a short-lived `codex exec` process (see the OAuth
  note below), capped by `forgeRelay.codexWorkerTimeoutMs` (default 15 min)

### Worker routing contract

Forge Relay treats Forge as the normal routing surface for local worker models.

- pass a plain Forge-exposed model name to `dispatch_subagent` in normal use
- local Forge-managed GGUF models route through Forge control
- provider-backed Forge-exposed models (xAI, OpenRouter, etc.) route through Forge's in-host `POST /chat` proxy, so their API keys never leave the Forge extension host
- a trailing `@profile` (e.g. `gemma4:31b@long-ctx`) is carried through to Forge for request-time profile resolution; the base model is what gets pooled
- explicit `forge:` / `bridge:` / `ollama:` / `direct:` prefixes are still valid, but they are override/debug paths rather than the normal workflow
- use `list_models` to inspect the merged Forge-first catalog before dispatching unfamiliar models

In short:

- normal use = plain model name
- debugging or forced transport choice = explicit prefix

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

## Recommended Agent Protocol (`AGENTS.md`)

Configuring the MCP servers gives your agents the board **tools**; an
`AGENTS.md` file in your repo root gives them the **protocol** — when to check
the board, claim files, post progress, and honor STOP/PAUSE. Codex reads
`AGENTS.md` automatically at session start (it is Codex's equivalent of
`CLAUDE.md`).

Forge Relay ships a ready-made template (`resources/AGENTS.template.md` in the
extension). The **Get Started** command offers to copy it into your workspace
if no `AGENTS.md` exists yet.

The template makes board usage **opt-in, off by default**: agents work
normally — no board calls, no token overhead — until you say something like
*"start using the board"* in the session. From that point they follow the full
protocol (pre-flight `board_check`, `claim` before editing, `post` progress,
`release` when done, and mandatory STOP/PAUSE handling) until you say *"stop
using the board"*. This keeps solo sessions cheap while making parallel
sessions safe.

If you prefer a minimal always-on protocol instead, add this to your agent's
system prompt or `AGENTS.md`:

```
Before starting any substantial edit or build:
1. Call board_check - if BLOCKED, call ack_command and stop.
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
| `forgeRelay.port` | `7878` | MCP server port. Change if 7878 is already in use. |
| `forgeRelay.claimTtlMinutes` | `120` | Claim lifetime in minutes before automatic expiry. |
| `forgeRelay.subagentForgeControlUrl` | `""` | Optional Forge control URL. When set, plain worker model names resolve through Forge-first routing. |
| `forgeRelay.subagentBridgeUrl` | *(empty — route off)* | Optional generic OpenAI-compatible endpoint for `bridge:`-prefixed worker models. The legacy Forge Python bridge (`:9099`) was removed from Forge; prefer `forge:` routing via the control API. |
| `forgeRelay.subagentBridgeApiKey` | `""` | API key for the Forge bridge, if required. |
| `forgeRelay.subagentOllamaUrl` | `http://127.0.0.1:11434/v1` | Raw Ollama override endpoint. Use mainly for debugging or forced routing. |
| `forgeRelay.subagentDirectUrl` | `http://127.0.0.1:8080/v1` | Raw llama.cpp override endpoint. Use mainly for debugging or forced routing. |
| `forgeRelay.codexExecutable` | `""` (= `codex` on PATH) | Codex CLI executable for the `codex` worker backend of `dispatch_subagent`. |
| `forgeRelay.codexWorkerTimeoutMs` | `900000` | Wall-clock cap for one `codex exec` worker run (15 min); the process is killed past it. |
| `forgeRelay.experimentalManagedCodex` | `false` | Expose the experimental isolated managed Codex session option. |
| `forgeRelay.codexManagedProfileRoot` | `""` | Advanced profile root override. Forge Relay always appends a workspace fingerprint; empty uses extension global storage. |
| `forgeRelay.codexManagedModel` | `""` | Optional model override for isolated managed Codex. |
| `forgeRelay.codexManagedTurnTimeoutMs` | `900000` | Wall-clock cap for one isolated managed board-event turn. |

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
| `Forge Relay: Open Board (Tab)` | Open the board as a full editor tab for a larger view |
| `Forge Relay: STOP All Agents` | Post an immediate STOP command targeting all agents |
| `Forge Relay: Get Started` | One-shot onboarding: configure Codex + Claude, then open the verification report |
| `Forge Relay: Configure Codex` | Write the `[mcp_servers.forgerelay]` entry into `~/.codex/config.toml` automatically (zero-touch Codex setup; never clobbers an existing entry) |
| `Forge Relay: Sign In Isolated Codex with ChatGPT` | Authenticate this workspace's isolated managed profile through Codex's browser OAuth flow without changing the ordinary Codex profile |
| `Forge Relay: Configure Claude` | Write the `forgerelay` MCP entry into `~/.claude/settings.json` (merges into existing JSON; never clobbers an existing entry) |
| `Forge Relay: Show MCP Config` | Display copy-ready Codex and Claude MCP config snippets plus recovery notes |
| `Forge Relay: Verify Setup` | Check whether Codex and Claude MCP config are correctly wired on this machine |
| `Forge Relay: Run Runtime Acceptance Matrix` | Exercise live board, Forge routing, managed native writes, and sync/async Codex workers; open one report |
| `Forge Relay: Toggle Clanker Mode` | Switch workers between read-only draft mode and write/edit/run (Clanker) mode |

---

## PowerShell Scripts (Legacy)

The original PowerShell scripts remain available in the [GitHub repository](https://github.com/Efs-O/forge-relay) under `scripts/` for debugging and for agents that cannot connect via MCP (they are not bundled into the installed extension):

| Script | Usage |
|---|---|
| `scripts/agent-bridge.ps1` | Direct state mutations (claim, release, post, history...) |
| `scripts/agent-watch.ps1` | Pre-flight check - exit 0 clear, exit 2 blocked |
| `scripts/agent-board.ps1` | Standalone HTTP board server on port 8765 (without VS Code) |

These write to the same `.coordination/` state files so they are fully compatible with the MCP server.

---

## License

Licensed under Apache-2.0. See [LICENSE](LICENSE) for details.

---

## Contact

Maintained by [Efs-O](https://github.com/Efs-O) — amandoulou@yahoo.gr

---

## Roadmap

- [x] Push board updates to webviews from intra-process board events (with a slow polling backstop)
- [x] Folder-level claim conflict detection (parent/child path overlap)
- [x] Build hook wrapper (`run_build`: pre-flight, configured claims, result post, and cleanup)
- [x] Task cards with blocker state and severity tags
- [x] VS Code Marketplace publish ([Efsoo.forge-relay](https://marketplace.visualstudio.com/items?itemName=Efsoo.forge-relay), v0.5.1)
- [x] Stable v0.5.2 VSIX built and validated locally (Marketplace publication pending)
- [ ] Session snapshots - Markdown export of the current split and open blockers (FR-4; explicitly deferred)
