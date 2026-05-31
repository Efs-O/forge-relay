# DRAFT — README addition for Forge

> **Status:** DRAFT. Destination: merge into Forge's `README.md` (`N:\vs code apps\Forge\README.md`)
> **after** the live end-to-end test of the AgentWatch ↔ Forge subagent path. Kept here in the AgentWatch
> repo until verified so the Forge repo stays untouched.
>
> Companion: AgentWatch's own additions live in [`README_DRAFT_agentwatch.md`](README_DRAFT_agentwatch.md).

---

## Using Forge models as AgentWatch subagents

[AgentWatch](https://github.com/agentwatch/agentwatch) — a multi-agent coordination board for VS Code — can
drive Forge's local models as **subagents**, the same way Claude Code uses its built-in Task subagents. When
Claude or Codex (orchestrating on the AgentWatch board) calls `dispatch_subagent`, AgentWatch routes the task
to one of Forge's OpenAI-compatible backends and the local model does the work.

This integration is **decoupled**: AgentWatch reads Forge's config only for the *model list* and calls the
model endpoint directly over HTTP. The Forge extension does **not** need to be running — only a model endpoint
needs to be up (the bridge, the Ollama daemon, or `llama-server`).

### Backends AgentWatch targets

| AgentWatch model prefix | Forge backend | Endpoint |
|---|---|---|
| `bridge:` (default) | continue-llamacpp-bridge | `http://127.0.0.1:9099/v1` |
| `ollama:` | Ollama (native daemon) | `http://127.0.0.1:11434/v1` |
| `direct:` | llama.cpp `llama-server` | `http://127.0.0.1:8080/v1` |

Example: an orchestrator dispatches `dispatch_subagent({ model: "bridge:gemma3-4b-it", task: "…", tools: "full" })`,
and Forge's bridge serves the GGUF selected by that model id — exactly as it does for Forge's own sidebar.

### Safety: the denylist is shared in spirit

Because the subagent loop runs *inside AgentWatch* (decoupled), Forge's own per-action guards are not in the
path. AgentWatch therefore **ports Forge's destructive-command denylist** (`src/tools/DenyList.ts`) and exec
guards (`src/tools/execHelpers.ts`) into its own worker tool layer, so the same protections apply:

- the destructive-command denylist (`rm -rf`, `git reset --hard`, force push, `format`,
  `Remove-Item -Recurse -Force`, `curl | sh`, `shutdown`, `iex`, `diskpart`, …);
- the shell-operator ban and `shell: false` spawning.

AgentWatch's **Clanker Mode** toggle deliberately mirrors Forge's `/clanker`: a user-selectable full-auto mode
with an always-on denylist floor. One difference: an AgentWatch worker is *unattended*, so where Forge would
prompt a human on a dangerous op, AgentWatch **hard-refuses** it (plus takes a git checkpoint for revert).

> If Forge's denylist changes, update the ported copy in AgentWatch
> (`src/workerDenyList.ts`) to keep them in sync.
