# AgentWatch — Audit, Auto-Trigger, and Local-Subagent Plan

**Date:** 2026-05-30
**Status:** IMPLEMENTED — P1–P6 all built, type-checked, and unit/mock-tested (2026-05-30). Pending real-environment end-to-end (needs live `codex` CLI, headless `claude`, and a local model server) before the README claims and Marketplace publish.
**Scope:** (1) Honest audit of the current build. (2) Real automated board→agent triggering with no per-message nudging. (3) Let Claude use Forge's local/cloud llama.cpp & Ollama models as subagents, in the same style as Claude's built-in Task subagents. (4) Fold in the audit bug fixes.

> **Implementation note (2026-05-30):** All six phases are complete. One locked decision was revised mid-build: **Decision #3** changed from "workers are readonly + draft" to **user-selectable autonomy** (`draft` vs `clanker`), mirroring Forge's Clanker Mode — workers can write/edit/run when Clanker is on, bounded by a denylist ported from Forge. See the revised Decision #3 and §3.4 below. Draft README additions for this repo and Forge live in `docs/README_DRAFT_agentwatch.md` and `docs/README_DRAFT_forge.md`; they merge into the real READMEs after live E2E.

---

## Part 0 — Read this first: the one misconception to clear up

You said you thought **Claude was the better-implemented side** because "Claude has better loop / MCP tools." Half true, and the half that's false is the whole reason nudging still exists. Let me be precise, because the plan depends on it.

**What is true:** Claude Code *does* have the better native primitives for self-paced work — `/loop` and the Monitor tool. Codex's `/goal` is weaker. So for a *human-started, self-running* loop, Claude wins.

**What is false:** That those primitives are wired into AgentWatch today, or that anything currently "wakes" Claude from a board post. They are not, and nothing does. Here's the evidence from the actual code:

- [scripts/board-monitor.js](scripts/board-monitor.js) only does `process.stdout.write(...)` of new board lines. A `SessionStart` hook's stdout is **not fed back into Claude as a turn.** It logs; it does not wake. This is exactly the "watcher that only logs board changes" case your own [FULL_AUTO_SHIPPING_REQUIREMENTS.md](FULL_AUTO_SHIPPING_REQUIREMENTS.md) lists under "What Does Not Count."
- That hook is also **currently disabled** — [.claude/settings.json](.claude/settings.json) is `{}`, and the real hook is parked in `.claude.disabled/settings.json.disabled`. So even the logger isn't running.
- [src/mcpStdio.ts](src/mcpStdio.ts#L156-L178) pushes `notifications/message` (MCP *logging* notifications) when the board changes. Claude Code surfaces these as log lines, **not** as new prompts. MCP push ≠ runtime wakeup.
- The only component in the whole repo that performs a *real* runtime wakeup is on the **Codex** side: [scripts/codex-auto-bridge.js](scripts/codex-auto-bridge.js) runs `codex app-server`, opens a thread, watches `events.ndjson`, and calls `turn/start` with the event as input. That genuinely injects a turn into Codex's reasoning loop.

**So the real situation is the inverse of the memory note:** Codex has a working wakeup path (just not productized — it's a manual `npm run codex:auto`), and Claude has *no* wakeup path at all yet, only a disabled logger. The good news: Claude's native `/loop` + Monitor and the Claude Agent SDK give us *two* clean ways to fix the Claude side properly. This plan uses them.

---

## Decisions locked (2026-05-30)

These are settled; the rest of the doc is updated to match.

1. **Claude wakeup uses the existing SDK auth path** — the headless `ClaudeRuntimeBridge` reuses your existing Claude Code credentials, not a separate API key. (Cost is bounded instead by the orchestrator-selection model in #5.)
2. **Build both Claude Mode A *and* Mode B.** Mode A (`/loop` paste) ships first to prove the flow; Mode B (headless SDK) follows as the zero-touch upgrade.
3. **Workers behave like Claude's Task subagents — full read/write/edit/run — bounded only by a destructive-command denylist (REVISED 2026-05-30, supersedes the original readonly+draft rule).** Tier-2 local subagents may write/edit files and run commands directly, exactly like Claude's built-in subagents. The only hard limit is a denylist ported from Forge ([DenyList.ts](N:\vs code apps\Forge\src\tools\DenyList.ts): `rm -rf`, `git reset --hard`, force push, `format`, `Remove-Item -Recurse -Force`, `curl|sh`, `shutdown`, `iex`, `diskpart`, …) plus a shell-operator ban and `shell:false` spawning ([execHelpers.ts](N:\vs code apps\Forge\src\tools\execHelpers.ts)). These guards are *copied into AgentWatch* so they apply in the decoupled worker loop (Forge's own guards are not in the path — Decision #4). Every worker action is claim-gated and posted to the board, and a **git checkpoint** is taken at worker start so any change is revertible. `propose_diff` remains available for explicit draft/async dispatch. NOTE: unlike Forge's `run_terminal` (which pastes and waits for a human Enter), AgentWatch workers **auto-execute** — the denylist + git checkpoint are the safety net, by design, so workers are genuinely unattended.
4. **Subagents = Tier 2a (decoupled).** AgentWatch runs its own minimal claim-gated worker loop against the model endpoint. Because workers are readonly+draft, the toolset is tiny (`read_file`, `list`, `search`, `propose_diff`), so reusing Forge's heavy tool layer (2b) isn't worth the coupling. AgentWatch reads Forge's config for the *model list* but does not depend on the Forge extension being alive at runtime — it just needs a model endpoint up (Ollama daemon, Forge backend, or the bridge). **Both** the Bridge `:9099` and Ollama `:11434` backends are supported targets (llama.cpp `:8080` too).
5. **Orchestrator selection at Connect.** The user picks **Claude only / Codex only / Both** when starting a session. Only the selected orchestrator(s) get a runtime bridge; the unselected one stays inactive (greyed dot, no reactions). This is also the cost-control lever. Workers remain available to whichever orchestrator is active.

---

## Part 1 — Audit findings

### 1.1 Architecture (as built)

```
VS Code extension (extension.ts)
  ├─ Bridge (bridge.ts)            file-locked state in .coordination/
  ├─ McpServer (mcpServer.ts)      HTTP SSE + StreamableHTTP on :7878  ← Claude connects here
  ├─ BoardWatcher (boardWatcher.ts) fs.watch + 2s poll → VS Code toasts
  └─ BoardViewProvider (boardView.ts) sidebar webview, 2s polling

mcpStdio.ts                        stdio MCP server (Codex connects here), fs.watchFile push
scripts/codex-auto-bridge.js       Codex app-server wakeup bridge (the only real auto path)
scripts/board-monitor.js           logger only (does not wake anything)
```

Core board mechanics (claims, TTL, commands, ack/resolve, atomic writes, lock) are **solid and well-written.** The gap is entirely in *runtime wakeup* and *productization*, not in the data layer.

### 1.2 Correctness / robustness bugs (will fold these in — you approved)

| # | Severity | Where | Problem | Fix |
|---|----------|-------|---------|-----|
| B1 | High | [bridge.ts appendEvent](src/bridge.ts#L295-L299) | Reads the **entire** `events.ndjson` into memory and rewrites it on **every** post. O(n) per write; with two agents looping every few seconds the file is read+rewritten constantly. | Append with `fs.appendFileSync` (still inside the lock). Rotate on size. |
| B2 | High | [bridge.ts](src/bridge.ts) (whole file) | `events.ndjson` is **unbounded on disk**. `readEvents` caps at 200 for display, but the file grows forever, making B1 worse over time. | Rotate to `events.ndjson.1` past N lines / size; keep a bounded live file. |
| B3 | Med | [bridge.ts withLock](src/bridge.ts#L248-L261) + [boardView.ts](src/boardView.ts#L58-L69) | Sidebar calls `getState()` every 2s, which calls `clearExpired()` → takes the **write lock** every 2s even when nothing changed. Two webviews + watchers = lock churn and busy-wait (`sleepSync`). | Make `getState()` read-only; prune expired lazily (filter on read) and only *write* pruning when something is actually claimed/released. |
| B4 | Med | [boardWatcher.ts](src/boardWatcher.ts#L37-L46) | `fs.watch` on a single file on Windows/network drives (N:) is unreliable; the 2s poll is the real workhorse but adds latency. | Keep poll as source of truth; drop watch latency target to ~500ms for the board feed; document N:-drive caveat. |
| B5 | Med | [mcpStdio.ts](src/mcpStdio.ts#L156-L178) & [board-monitor.js](scripts/board-monitor.js) | Three separate file-tailers (mcpStdio `watchFile`, boardWatcher, board-monitor) each re-implement "read new bytes since offset," each with subtly different truncation handling. | Extract one `EventTail` helper; reuse everywhere. Removes drift + B1-style bugs. |
| B6 | Low | [bridge.ts ack](src/bridge.ts#L114) | For `target_agent === 'all'`, status stays `'open'` forever even after every agent acks — `clearAllCommands` is the only escape. | Track acks vs. expected agents; auto-resolve when all targets ack, or document that "all" is operator-cleared by design. |
| B7 | Low | [extension.ts](src/extension.ts#L42) | Watcher uses `repoRoot` but `coordinationPath` config can repoint state; the MCP stdio server (separate process) computes its own path from `--repoRoot`. Easy to get them out of sync. | Single source of truth for the coordination dir; surface it in `Verify Setup`. |
| B8 | Low | [board-monitor.js](scripts/board-monitor.js#L2) | Hardcoded absolute path `N:\vs code apps\Agentwatch\...`. Breaks on any other machine — contradicts the "works on fresh setup" shipping bar. | Take `--repoRoot`/cwd like the other scripts. (Or delete it — see Part 2, it's superseded.) |

### 1.3 Product-bar gaps (from your own requirements docs)

- **Full-auto bar not met for either agent today** (Claude: no wakeup; Codex: wakeup exists but manual). Per [FULL_AUTO_SHIPPING_REQUIREMENTS.md](FULL_AUTO_SHIPPING_REQUIREMENTS.md), the release must currently be described as *"board coordination with partial auto-reactivity,"* not full-auto. This plan's Part 2 is what earns the full-auto claim.
- **Connect button is a bootstrap helper, not a connection.** [OVERHAUL_PLAN.md](OVERHAUL_PLAN.md) Phase 2 already acknowledges this. Part 2 below upgrades it into a real process-managing Connect.

---

## Part 2 — Real automated board→agent triggering (no nudging)

### 2.1 The core principle

A board post must do three things, automatically, for each agent (your four-step bar collapses to these three):

1. **Detect** the new event (solved — file tail).
2. **Wake** the agent's reasoning runtime through a *supported* interface (this is the missing piece).
3. **Reply** back to the board via MCP tools (solved — the tools exist).

"Wake" is the whole game. There is **no supported way to inject a turn into an already-open interactive chat** (a Claude Code panel or Codex CLI you're typing in) from an outside file watcher. That's a hard platform limitation and the reason nudging exists. So we stop trying to poke the interactive session and instead use the two interfaces that *are* designed to be driven programmatically.

### 2.2 The unifying abstraction: `AgentRuntimeBridge`

One interface, two (then three) implementations. AgentWatch owns and supervises these processes; the sidebar becomes a monitor/control surface, not a place you paste reminders.

```
interface AgentRuntimeBridge {
  start(): Promise<void>          // launch/attach the agent runtime
  wake(event: BoardEvent): void   // inject the event as a real turn
  status(): 'linked'|'waiting'|'unsupported'|'error'
  stop(): void
}
```

- **CodexRuntimeBridge** — already 90% built in [codex-auto-bridge.js](scripts/codex-auto-bridge.js). Promote it from a manual npm script into a supervised child process the extension spawns on Connect. `wake()` = `turn/start`. This is the proven path.
- **ClaudeRuntimeBridge** — new. Spawns a **headless Claude Agent SDK** session (`claude -p` / streaming `query()`), with the AgentWatch MCP server attached and a system prompt that says "you are the `claude` board participant." `wake()` = push the board event as the next user message on the streaming input. This is the true Claude analog to Codex app-server and the *robust* answer to "no nudging."

Because both are headless and AgentWatch-managed, a user board post fans out to both runtimes with zero chat interaction. This is the architecture that meets your shipping bar.

### 2.3 Two Claude modes — pick per session (this is where your `/loop` instinct is right)

Your belief that Claude's loop tooling is strong is correct; it just belongs in **Mode A**, the lightweight path:

- **Mode A — Interactive `/loop` (lightweight, your existing chat):**
  Connect shows you one command to paste **once** into your open Claude session:
  > `/loop` watch the AgentWatch board via the MCP `board_check`/`get_status` tools; when a new post from `user` or `codex` appears, act on it and reply with `post`. Self-pace; keep going until `SESSION_END`.

  Pros: uses the chat you already have open, full model power, you can interject. Cons: occupies that session; one manual paste per session; pacing burns some tokens. This is genuinely good and is the fastest thing to ship — but it is *Model B* (wake the interactive session via self-poll), so it's "one paste then autonomous," not "literally zero touches."

- **Mode B — Headless SDK bridge (true zero-nudge, productized):**
  AgentWatch spawns the Claude Agent SDK process itself. No paste, ever. Survives restarts (Connect re-spawns). This is the one that lets the product honestly say "fully automatic." Bigger build (auth, lifecycle, cost controls).

**Recommendation:** ship **Mode A first** (fast, leverages the loop tooling you like, proves the end-to-end flow), then add **Mode B** as the "Enable Auto-Reactivity" upgrade once the flow is verified. Codex gets the productized app-server bridge (its Mode-B equivalent) in the same step as Claude Mode B, since it already exists.

### 2.4 Connect/Disconnect, redefined (with orchestrator selection)

`Connect` opens a small chooser first: **Claude only / Codex only / Both**, and per chosen agent, **Mode A (paste `/loop`)** or **Mode B (headless)**. Then:
1. Ensure MCP server up (already done).
2. For **each selected** orchestrator, start its chosen bridge (Mode A → show one-time paste; Mode B → spawn process). Unselected orchestrators are left inactive — no bridge, greyed dot, they never react.
3. Show per-agent status dot: `linked / waiting / unsupported / error / inactive` (matches FULL_AUTO doc's recommended UX, plus an explicit `inactive` for the unselected agent).
4. Post `SESSION_START` with the selected roster in `meta` so the board (and any worker) knows who is participating.

`Disconnect`: post `SESSION_END`, stop Mode-B child processes, grey the dots. Mode-A agents see `SESSION_END` and exit their loop. An `inactive` agent needs no teardown.

**Why selection matters:** it bounds cost (run one orchestrator at a time), avoids two agents racing on small tasks, and directly answers "if we pick Codex, Claude stays inactive, and vice versa." Switching mid-session = Disconnect, then Connect with a different roster.

### 2.5 Why this finally satisfies the four-step bar

| Step | Claude (Mode B) | Codex (productized bridge) |
|------|------------------|----------------------------|
| Receive event w/o nudging | bridge tails board | bridge tails board |
| Wake runtime | SDK streaming input turn | `turn/start` |
| Consume in supported way | Agent SDK message | app-server thread |
| Reply to board | MCP `post` | MCP `post` |

All four ✓ for both → the release can be called full-auto.

---

## Part 3 — Local & cloud models as Claude subagents (Forge / Ollama / llama.cpp)

### 3.1 What you asked for

> "Claude should use the local or cloud agents of ollama or llama.cpp the same way and style as it does with the existing subagents."

So: Claude, mid-reasoning, dispatches a self-contained task to a local model, that model works autonomously (with its own tools, in its own context), and returns a report — exactly like Claude's built-in `Task`/subagent tool. Fire-and-(optionally)-forget, result comes back, Claude integrates it and posts to the board.

### 3.2 Forge's integration surface (confirmed from its source)

Forge LLM (`forge-llm` v0.12.1, [N:\vs code apps\Forge](N:\vs code apps\Forge)) already exposes everything we need:

- **OpenAI-compatible inference** — Forge talks to `llama-server` via `/v1/chat/completions` ([src/llm/OpenAIClient.ts](N:\vs code apps\Forge\src\llm\OpenAIClient.ts)). Three backend modes:
  - **Direct** — llama.cpp `llama-server` on `127.0.0.1:8080`.
  - **Bridge** — `continue-llamacpp-bridge` on `127.0.0.1:9099/v1`, **API-keyed, up to 4 models simultaneously**, model id selects the GGUF (see [bridge.yaml](N:\vs code apps\Forge\bridge.yaml)). This is the richest target: one endpoint, many local models.
  - **Ollama** — native on `127.0.0.1:11434` ([src/llm/OllamaNativeClient.ts](N:\vs code apps\Forge\src\llm\OllamaNativeClient.ts)).
- **A full local agent loop with tools** — [src/sidebar/AgentLoop.ts](N:\vs code apps\Forge\src\sidebar\AgentLoop.ts) + [src/tools/registerAllTools.ts](N:\vs code apps\Forge\src\tools\registerAllTools.ts): `read_file, write_file, replace_in_file, list_directory, search_code, run_terminal, git_status, git_diff`, etc. **But this loop is only reachable from Forge's own webview — it is not exposed over HTTP.**

**Design consequence:** to mirror Claude's subagent (a *tool-using* agent, not just a chat completion), we have two layers, and we want both eventually:

- **Tier 1 — raw model brain:** call the OpenAI-compatible endpoint (Bridge :9099 preferred; Direct :8080 or Ollama :11434 as fallbacks). Gets you a local LLM for delegated reasoning/drafting/summarizing. No file tools. Trivial, zero changes to Forge.
- **Tier 2 — real local subagent:** the dispatched model runs an autonomous ReAct loop with file/exec/search tools and actually does work on the repo. To "use Forge the same way Claude uses subagents," this is the real target.

**Decided (see Decisions #3, #4): Tier 2a, readonly + draft.** AgentWatch runs its own minimal ReAct loop against the OpenAI-compatible endpoint with a tiny, safe toolset — `read_file`, `list_directory`, `search_code`, and `propose_diff` (no direct writes, no `run_terminal`). The worker never mutates the repo; it returns a proposed diff that the active orchestrator reviews and applies. This is self-contained, works identically for llama.cpp `:8080`, the Bridge `:9099`, and Ollama `:11434`, and has no runtime dependency on the Forge extension (it only needs a model endpoint up). Tier 2b (exposing Forge's full `AgentLoop` over HTTP) is rejected for now — with readonly+draft workers the toolset is too small to justify coupling the two extensions.

### 3.3 The subagent tool (the "same style as Claude's subagents" part)

Add a new MCP tool on the AgentWatch server so **Claude calls it natively**, just like `Task`:

```
dispatch_subagent({
  model:     "gemma4-e4b-it" | "ollama:qwen2.5-coder" | ...   // which local/cloud worker
  task:      "Summarize every TODO in src/ and propose owners",// the subagent's instruction
  context:   ["src/**/*.ts"] | inline text,                    // optional scoping
  tools:     "none" | "readonly" | "full",                     // Tier 1 vs Tier 2 capability
  mode:      "sync" | "async"                                   // wait for result, or get a ticket
})
→ returns: { subagent_id, status, result | summary }
```

Behavior:
- AgentWatch resolves `model` → backend endpoint (Bridge `:9099` / Direct `:8080` / Ollama `:11434`), reading Forge's config for the model list so it stays in one place. Both Bridge and Ollama are first-class targets (Decision #4).
- `tools:"none"` → Tier 1 single completion (summaries/drafts, no file access). `tools:"readonly"` → ReAct loop with read/search tools ending in a `propose_diff` (the explicit review-gate mode). `tools:"full"` → ReAct loop with the full read/write/edit/search/run toolset, denylist-guarded, like a Claude Task subagent (Decision #3 revised). Default for a tool-using dispatch is `"full"`.
- The subagent's lifecycle is posted to the board as a first-class participant (e.g. agent name `worker:gemma4-e4b`), so you *see* it working in the sidebar — claims, progress, proposed diff — exactly like Claude/Codex. Reuses the existing event model (the Phase-4 "Workers" design in [OVERHAUL_PLAN.md](OVERHAUL_PLAN.md#L367) already pointed here).
- `async` mode returns a `subagent_id` immediately and posts the draft to the board when done — true "fire-and-forget subagent" feel, and it composes with Part 2 (the result event wakes the active orchestrator to review/apply).

This gives you: Claude (orchestrator) → `dispatch_subagent` → local Gemma/Qwen/etc. (worker) does the grunt work for free on your hardware → result flows back through the board. Same mental model as Claude's Task tool, but the workers are your local models.

### 3.4 Safety (workers act like Claude subagents, denylist-bounded — Decision #3, revised)

- Workers **may read, write, edit, and run commands**, like Claude's Task subagents. The hard limit is the **ported denylist + shell-operator ban + `shell:false`** on the `run_command` tool — destructive commands (`rm -rf`, `git reset --hard`, force push, `format`, `Remove-Item -Recurse -Force`, `curl|sh`, `shutdown`, `iex`, `diskpart`, …) are refused before execution.
- A **git checkpoint** is taken when a worker session starts (and the pre-state recorded on the board), so the entire worker's output is revertible with one `git restore`/checkout if it goes wrong.
- A worker `claim`s the paths it works on (advisory) so the sidebar shows what it's doing and two workers don't collide.
- Honor board `STOP`/`PAUSE` — the worker loop checks `board_check` between steps, same as the orchestrators, and aborts mid-run on STOP.
- All worker actions (claims, edits, commands, results) post to the board as `worker:<model>` → full visibility.
- `propose_diff` is still offered for explicit *draft/async* dispatch, when you want a review gate rather than direct application.
- Confirmed 2026-05-30: Forge's denylist/guards exist and are the source we port from; they are NOT automatically in AgentWatch's decoupled path, hence the copy.

---

## Part 4 — Phased delivery

| Phase | Deliverable | Depends on | Effort | Risk |
|-------|-------------|-----------|--------|------|
| **P1 — Foundation fixes** | Fold in audit bugs B1–B8: `appendFileSync` + rotation, read-only `getState`, single `EventTail` helper, de-hardcode/retire `board-monitor.js`. | — | ~3–4h | Low |
| **P2 — Productize Codex bridge** | Extension spawns/supervises `codex-auto-bridge.js` on Connect; status dot; survives restart. (Real wakeup #1.) | P1 | ~3h | Med |
| **P3 — Orchestrator selection + Claude Mode A** | Connect chooser (Claude/Codex/Both + Mode A/B); only selected agents start; one-time `/loop` paste; `SESSION_START`/`SESSION_END` honored; verify end-to-end. | P2 | ~3h | Med |
| **P4 — Claude Mode B (SDK bridge, existing auth)** | Headless Claude Agent SDK `ClaudeRuntimeBridge` reusing existing Claude Code auth; "Enable Auto-Reactivity" toggle; full-auto bar met for selected agents. | P3 | ~6–8h | High |
| **P5 — Subagents Tier 1** | `dispatch_subagent` MCP tool, raw-model via Bridge `:9099` + Ollama `:11434` (+ Direct `:8080`); workers visible on board. | P1 | ~4h | Med |
| **P6 — Subagents Tier 2a (readonly + draft)** | Minimal claim-gated ReAct loop ending in `propose_diff`; async draft→board; orchestrator reviews/applies. | P5, P2 | ~6h | Med |

Each phase ends with a concrete verification (post a real task, watch both agents + a worker coordinate on the board unattended) and a rollback path (rename config / kill bridge child / disable the new MCP tool).

---

## Part 5 — Open questions: resolved (2026-05-30)

All four are now settled — see **Decisions locked** at the top:

1. ~~Claude Agent SDK auth~~ → **existing Claude Code auth** (Decision #1).
2. ~~Default worker backend~~ → **both Bridge :9099 and Ollama :11434** (Decision #4).
3. ~~Worker write access~~ → **readonly + draft; orchestrator applies** (Decision #3).
4. ~~Forge coupling~~ → **Tier 2a, decoupled** (Decision #4).

Remaining minor items (do not block any phase):
- Exact `/loop` cadence wording for Mode A (tune during P3 verification).
- Whether `SESSION_START` roster should auto-grey the unselected agent's last-known activity or hide it entirely (UI polish in P3).

---

## TL;DR

- Your data layer is good. The "Claude is auto" belief is the thing to drop: today nothing wakes Claude, and only Codex has a (manual) real wakeup path.
- Real auto-trigger = an **AgentWatch-managed runtime bridge per selected agent** (Codex app-server, Claude Agent SDK via existing auth), with a lightweight `/loop` mode as the fast first step. That, not file-watching, is what kills nudging.
- **You choose the roster at Connect** — Claude only / Codex only / Both. Unselected stays inactive.
- Local subagents = a `dispatch_subagent` MCP tool Claude calls like `Task`, routing to Forge's Bridge `:9099` + Ollama `:11434` (+ llama.cpp `:8080`), workers shown on the board. Tier 1 (raw) now, Tier 2a (readonly + **draft**, orchestrator applies) next — fully decoupled from Forge's runtime.
- Bugs B1–B8 fold into Phase 1.
