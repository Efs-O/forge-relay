# Agent Coordination

> **Legacy reference.** Agents now coordinate through the Forge Relay **MCP tools**
> (see [AGENTS.md](AGENTS.md)). The PowerShell commands below are a human debugging
> CLI; paths here point at an older Desktop repo and are illustrative only.

Use this when two coding agents are working in the same Desktop repo at the same time.

## Rule Set

1. Both agents work only inside `C:\Users\efso office\Desktop\DWS Software (tm)\`.
2. No agent edits a file until it has claimed that file or folder.
3. Claims expire automatically after 120 minutes unless renewed by reclaiming.
4. Broad directory claims are allowed, but should be avoided unless the work really spans a module.
5. The live install at `C:\DWS Software (tm)\...` stays untouched until regression passes.

## Bridge Script

Script: [scripts/agent-bridge.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-bridge.ps1)

State files are local-only under `.coordination/` and are git-ignored.

## Live Board

Start the localhost board server:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-board.ps1
```

Then open:

```text
http://localhost:8765/
```

The board shows:

- active claims
- a live event/message feed
- claim and release controls
- manual progress posts from both agents
- operator commands like `STOP`, `PAUSE`, `RESUME`
- acknowledgement of the active command by each agent

## Important Limitation

The board can broadcast commands in real time, but it cannot hard-stop an independent agent process by itself.

What it can do:

- show the command immediately to the user
- make the command visible to both agents
- let each agent acknowledge it visibly
- let both agents use the same stop/pause/resume control plane

What it cannot do on its own:

- forcibly interrupt a different AI session unless that session is also checking the board and obeying commands

So for a reliable `STOP` workflow, both agents must agree to:

1. check the board before starting any substantial edit or long-running command
2. acknowledge operator commands when seen
3. stop or pause work after seeing a targeted `STOP` command

## Minimal Watcher

Script: [scripts/agent-watch.ps1](C:/Users/efso%20office/Desktop/DWS%20Software%20(tm)/scripts/agent-watch.ps1)

One-shot check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-watch.ps1 -Agent codex
```

Watch mode:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-watch.ps1 -Agent codex -Mode watch
```

Behavior:

- exit `0`: no blocking command
- exit `2`: an open `STOP` or `PAUSE` command exists for that agent or for `all`

Incremental read behavior:

- the watcher also tracks new board entries per agent
- cursor files are stored under `.coordination\state\`
- on first run, the watcher establishes the cursor without dumping the full board history
- later runs print only entries newer than the agent's last read timestamp

Use it as a pre-flight check before edits, builds, or long-running scripts.

Incremental history example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 history -Since (Get-Date).AddMinutes(-10)
```

## Recommended Workflow

1. Check current claims:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 status
```

2. Claim the exact file before editing:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 claim `
  -Agent codex `
  -Target 'Decompiled\DWS.LIB.Erp.Shopping.v.9\DWS.LIB.Erp.Shopping\XF_Shopping_Invoice.cs' `
  -Note 'Fixing Purchases crash guard'
```

3. Post progress notes when the scope changes:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 post `
  -Agent codex `
  -Note 'Moving from Shopping to Core.Settings after build passes'
```

4. Release the claim when done:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 release `
  -Agent codex `
  -Target 'Decompiled\DWS.LIB.Erp.Shopping.v.9\DWS.LIB.Erp.Shopping\XF_Shopping_Invoice.cs'
```

5. Review event history if needed:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-bridge.ps1 history
```

## Practical Split Strategy

- One agent takes build-system and shared infra files:
  - `Decompiled\Directory.Build.props`
  - `.csproj` normalization
  - shared `Core.*` dependencies
- The other agent takes module files:
  - `Decompiled\DWS.LIB.Erp.*`
  - `Decompiled\DWS.LIB.Tools.*`
  - specific crash or GPU fixes

Avoid concurrent edits to:

- `Decompiled\Directory.Build.props`
- any shared `.csproj`
- any single large `XF_*` file

## Stronger Option

If both agents need heavy edit throughput, combine the bridge with separate git branches or separate worktrees. The bridge prevents accidental overlap; separate branches make conflict resolution explicit.
