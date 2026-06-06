# Codex vs Claude: Auth, Concurrency, and Why AgentWatch Goes Single-Process for Codex

> Why two concurrent Codex processes on one ChatGPT subscription fight each other,
> why Claude does not, and what that means for how AgentWatch wires each agent.

## The accurate statement

Two concurrent codex processes sharing one ChatGPT subscription login can't both stay alive reliably. It's not a hard "the server refuses a second connection" rule — it's the auth mechanism:

When you sign into Codex with your ChatGPT subscription (OAuth login, which is what you're using), the login uses rotating refresh tokens.
Two separate codex app-server processes each try to manage/refresh that one shared credential. When one refreshes, it rotates the token out from under the other → the other's token is now "reused/revoked" (refresh_token_reused / token_revoked) → it goes silent.
So in practice: one stable codex process per ChatGPT login.

## The nuances that matter

Process ≠ thread/tab. Multiple chat threads inside the one codex process (your sidebar) are totally fine. The conflict is only between separate processes (e.g. sidebar codex plus AgentWatch spawning its own codex app-server). That's the whole reason we went single-process MCP.

Subscription (OAuth) vs. API key are different. The rotation/revocation trap is specific to the ChatGPT subscription OAuth sign-in. A raw OpenAI API key is a stateless bearer token — multiple processes can use the same API key concurrently without revoking each other; you'd only be bounded by rate limits/quota, not session-exclusivity. So "one key" and "one subscription" don't behave identically:

One ChatGPT subscription login → effectively one codex process. ✅ (your case)
One API key → concurrent processes generally OK, limited by quota/rate, not token revocation.

## So for your setup

You're on the subscription login, so the correct mental model is: one healthy codex per machine/login. That's exactly why the fix was "give your single sidebar codex the board tools" rather than "let AgentWatch run its own codex" — and why the singleton-lease findings doc still matters (to stop AgentWatch from ever spawning a second managed bridge that would re-trigger the token war).

## Why Claude is different

Claude doesn't hit this — not because it's "better," but because of four architectural differences:

### 1. Auth model — the big one
Claude Code's auth tolerates concurrent sessions on one login. You can run your interactive Claude, a headless AgentWatch Claude (Mode B), and more — all on the same credentials without any of them invalidating the others. There's no rotating-refresh-token trap where one process revokes another's token. So Claude has no "goes silent when mixed" failure mode the way Codex's ChatGPT-OAuth login does.

### 2. AgentWatch's Claude path doesn't duplicate the process
- **Claude Mode A** = literally a `/loop` paste into your *existing* Claude chat. Zero extra process.
- **Claude Mode B** = a headless `claude` that reuses your same Claude Code auth and coexists fine.
- **Codex** had no equivalent — the managed bridge *had* to launch a whole separate `codex app-server`. That second process is what fought the sidebar over the one ChatGPT login. Single-process MCP removes that second process entirely.

### 3. No mandatory remote "apps" enumeration gating startup
Codex's app-server eagerly calls a remote ChatGPT-hosted MCP (`chatgpt.com/backend-api/wham/apps`) for `tools/list` on startup. When that endpoint resets (`os error 10054`) or returns bad JSON, it stalls the whole "waiting for structured result" path and can wedge the session. Claude has no equivalent remote app-enumeration step blocking its session — your local MCP servers are the only ones, and they don't gate startup.

### 4. MCP failures degrade gracefully vs. wedge a pipe
- **Claude** talks to MCP servers and, if one dies, reports a tool error and keeps going.
- **Codex sidebar** is a thin webview driven by one `codex app-server` child over a single stdin/stdout pipe. When that pipe breaks ("stdin is destroyed"), the *entire* sidebar is dead and the extension loops on `getAuthStatus` instead of cleanly respawning. More fragile by design.

### Bottom line
The MCP tools were never the problem. Codex's instability came from (a) an auth model that can't tolerate a second process on one ChatGPT login, and (b) a startup that's hostage to a flaky remote apps service. Claude avoids both — concurrent-session-friendly auth, and AgentWatch reuses Claude's existing process instead of cloning it. That asymmetry is exactly why AgentWatch now gives Codex the board tools inside its one sidebar process (single-process MCP), while Claude can safely run as a managed bridge.

## Related docs
- [CODEX_BRIDGE_SINGLETON_FINDINGS.md](CODEX_BRIDGE_SINGLETON_FINDINGS.md) — why AgentWatch must never spawn a second managed bridge per agent/repo (the lease that prevents re-triggering the token war).
- [RUNTIME_LEASE_AND_TOKEN_PLAN.md](RUNTIME_LEASE_AND_TOKEN_PLAN.md) — planned per-agent runtime lease.
- [CODEX_MCP_VS_SCRIPTS_VERIFICATION.md](CODEX_MCP_VS_SCRIPTS_VERIFICATION.md) — codex on MCP (single process) instead of the legacy scripts.
