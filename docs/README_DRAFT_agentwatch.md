# DRAFT — README additions for AgentWatch

> **Status:** DRAFT. Destination: merge into [`../README.md`](../README.md) **after** the live end-to-end test
> (real `codex` CLI, headless `claude`, and a local model server). Until then these sections describe
> implemented-and-unit-tested behavior that has not yet been verified against the real external tools.
>
> Implemented 2026-05-30 across plan phases P1–P6 (see [`../AUTO_TRIGGER_AND_SUBAGENTS_PLAN.md`](../AUTO_TRIGGER_AND_SUBAGENTS_PLAN.md)).

---

## New: Automatic agent reactivity (runtime bridges)

Earlier, the board could *display* activity but nothing *woke* an agent from a board post — you had to nudge
each agent by hand. AgentWatch now manages a **runtime bridge** per orchestrator that turns a board post into a
real turn in the agent's reasoning loop, with no manual relay.

You pick the roster when you press **Connect**:

| Choice | What starts |
|---|---|
| **Codex** | A supervised `codex app-server` bridge — board events are forwarded with `turn/start`. |
| **Claude — Mode A** | You paste a one-time `/loop` prompt into your **existing** Claude chat. Full model power, you can interject. |
| **Claude — Mode B** | A **headless** `claude` session AgentWatch spawns and supervises — zero paste, reuses your existing Claude Code login. Each board event is injected as the next turn. |
| **Both** | Any combination. Unselected orchestrators stay **inactive** (greyed dot). |

Each bridge is supervised: it shows a live status dot (`waiting → linked`, `error`, `unsupported`, `inactive`),
restarts with backoff if it crashes, and reconnects automatically after a VS Code window reload. A status-bar
item mirrors the Codex bridge state.

> **Auth:** Mode B uses your existing Claude Code credentials — **no separate API key**. If the `codex` or
> `claude` CLI is not installed, the corresponding bridge reports `unsupported` instead of crash-looping.

### Status bar & commands

| Command | Description |
|---|---|
| `AgentWatch: Connect/Disconnect Codex Runtime Bridge` | Toggle just the Codex bridge. |
| `AgentWatch: Toggle Clanker Mode (worker write/edit/run)` | Flip subagent autonomy (see below). |

---

## New: Local-model subagents (`dispatch_subagent`)

Claude and Codex can now offload self-contained work to **local models** — exactly like Claude's built-in
Task subagents, but the workers are your own GGUF/Ollama models. A new MCP tool, `dispatch_subagent`, is
available to both orchestrators.

```jsonc
// dispatch_subagent
{
  "agent": "claude",                     // who is delegating
  "model": "ollama:qwen2.5-coder",       // backend-prefixed: ollama:/bridge:/direct:  (or unprefixed -> default backend)
  "task":  "Summarize every TODO in src/ and propose owners",
  "context": "src/**/*.ts",              // optional
  "tools": "none" | "readonly" | "full", // capability tier
  "mode":  "sync"                         // sync waits for the result
}
```

Workers appear on the board as `worker:<model>` — you see them claim, edit, and report exactly like
Claude/Codex. Backends are OpenAI-compatible and resolved by prefix:

| Prefix | Backend | Default URL |
|---|---|---|
| `bridge:` (default) | continue-llamacpp-bridge | `http://127.0.0.1:9099/v1` |
| `ollama:` | Ollama daemon | `http://127.0.0.1:11434/v1` |
| `direct:` | llama.cpp `llama-server` | `http://127.0.0.1:8080/v1` |

AgentWatch reads Forge's config only for the *model list*; at runtime it just needs one of these endpoints up
(it does **not** require the Forge extension to be running).

### Capability tiers

- **`tools: "none"`** — a single reasoning-only completion (summaries, drafts). No file access.
- **`tools: "readonly"`** — an agentic loop with `read_file` / `list_directory` / `search_code` that ends in a
  `propose_diff` for the orchestrator to review and apply.
- **`tools: "full"`** — a full agentic loop with `read/write/edit/search/run`, governed by **Clanker Mode**.

---

## New: Clanker Mode (worker autonomy) 💥

Mirroring Forge's Clanker Mode, AgentWatch makes worker autonomy a **user-selectable toggle** with a permanent
safety floor. Flip it from the **💥 pill** on the board, the `Toggle Clanker Mode` command, or the
`agentwatch.defaultAutonomy` setting. The choice persists in `.coordination/autonomy.json`.

| Mode | Worker capability |
|---|---|
| **Draft** (default) | Read-only. Workers propose diffs (`propose_diff`); the orchestrator reviews and applies. |
| **💥 Clanker** | Workers may `write_file` / `replace_in_file` / `run_command` directly. |

**The safety floor is always on, even in Clanker Mode:**

- A **destructive-command denylist** (ported from Forge) refuses `rm -rf`, `git reset --hard`, force push,
  `format`, `Remove-Item -Recurse -Force`, `curl | sh`, `shutdown`, `iex`, `diskpart`, … before anything runs.
- Shell operators (`&&  ||  ;  |  > <  $(  \``) are banned in command args, and commands run with `shell: false`.
- Worker file access is **sandboxed to the repo** — paths outside the workspace are refused.
- A **git checkpoint** is recorded when a Clanker worker starts, so its entire output is revertible with
  `git restore .`.
- Workers honor board **STOP/PAUSE** — the loop aborts between steps.

> Because a worker is unattended, the genuinely dangerous tier (recursive delete, denylisted commands) is
> **hard-refused**, not "ask the human" — there is no silent destructive action.

---

## New configuration

| Setting | Default | Description |
|---|---|---|
| `agentwatch.nodePath` | `""` | Node binary used to run the runtime bridges. Empty = `node` on PATH. |
| `agentwatch.claudePermissionMode` | `acceptEdits` | Permission mode for the headless Claude (Mode B) bridge. |
| `agentwatch.claudeModel` | `""` | Optional model override for the headless Claude bridge. |
| `agentwatch.subagentBridgeUrl` | `http://127.0.0.1:9099/v1` | continue-llamacpp-bridge endpoint for subagents. |
| `agentwatch.subagentOllamaUrl` | `http://127.0.0.1:11434/v1` | Ollama endpoint (`ollama:` prefix). |
| `agentwatch.subagentDirectUrl` | `http://127.0.0.1:8080/v1` | llama.cpp endpoint (`direct:` prefix). |
| `agentwatch.subagentBridgeApiKey` | `""` | API key for the bridge backend, if required. |
| `agentwatch.subagentDefaultBackend` | `bridge` | Backend for an unprefixed model id. |
| `agentwatch.defaultAutonomy` | `draft` | Initial worker autonomy (`draft` or `clanker`). |

---

## State files (additions)

| File | Purpose |
|---|---|
| `.coordination/events.ndjson.1` | Rotated event archive (the live log stays bounded). |
| `.coordination/autonomy.json` | Current worker autonomy mode (`draft` / `clanker`), shared across processes. |
