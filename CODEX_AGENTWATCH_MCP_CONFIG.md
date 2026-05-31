# AgentWatch Manual MCP Config

This note preserves the verified manual MCP setup used for AgentWatch in this environment.

AgentWatch no longer writes workspace `.mcp.json` automatically. Configure each client explicitly instead.

## Codex

Codex reads:

- `C:\Users\efso office\.codex\config.toml`

Add this block:

```toml
[mcp_servers.agentwatch]
command = "node"
args = ["N:\\vs code apps\\Agentwatch\\out\\mcpStdio.js", "--repoRoot", "N:\\vs code apps\\Agentwatch"]
```

## Claude Code

Claude Code reads `settings.json` style files. Observed paths in this environment:

- `C:\Users\efso office\.claude\settings.json`
- `N:\vs code apps\Agentwatch\.claude\settings.json`
- `N:\vs code apps\Agentwatch\.claude\settings.local.json`

Add or merge this:

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

## Recovery

If Claude stops launching after a workspace config change:

- rename `N:\vs code apps\Agentwatch\.claude\settings.json`
- then rename `N:\vs code apps\Agentwatch\.claude\settings.local.json` if needed
- if necessary, temporarily rename the whole workspace `.claude` folder

Prefer renaming before deleting so rollback is immediate.
