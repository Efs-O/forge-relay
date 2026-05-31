# AgentWatch — Polish & Improvement Backlog

**Created:** 2026-05-31 (after full live E2E of P1–P6).
**Status:** All core phases done and live-verified (both orchestrators + local-model workers). These are follow-ups — quality, DX, and enhancements surfaced during real-environment testing or discussed along the way. README finalization is deferred until after these (drafts live in `docs/README_DRAFT_*.md`).

Priority key: **P0** = correctness/DX gap found in testing · **P1** = discussed enhancement · **P2** = nice-to-have / external.

---

## P0 — Found during testing

**Status: ✅ ALL DONE — implemented, typechecked, built, and smoke-tested 2026-05-31. Needs an extension reload/VSIX reinstall to run live.**

### 1. ✅ Worker `run_command` can't run shell builtins / `.cmd` on Windows
- **Surfaced:** Codex's RPS build — worker logged `run_command: spawn mkdir ENOENT` (×2).
- **Why:** Worker exec uses `spawn(..., { shell: false })` (a deliberate security choice — keeps the shell-operator ban meaningful). But `mkdir` is a shell builtin (not a `.exe`), and npm/npx/etc. are `.cmd` shims — none are directly spawnable without a shell on Windows.
- **Impact:** Low for file work (the worker self-recovered: `write_file` auto-creates parent dirs via `fs.mkdirSync`). Higher for any task needing a build step (`npm install`, `npm run build`) — workers currently can't run those on Windows.
- **Approach options:**
  - Curated allowlist that runs known-safe tools (`npm`, `npx`, `node`, `git`, `mkdir`, `python`) via `cmd /c` on Windows, while *keeping* the denylist + shell-operator ban applied to the full command.
  - Or intercept common builtins (`mkdir`, `rm` of a single file, etc.) and map to `fs` directly.
  - Or simplest: document "workers prefer `write_file` (creates dirs); no build tools on Windows" and leave exec for real binaries only.
- **Files:** `src/workerTools.ts` (`runCommandTool`), `src/workerDenyList.ts`.

### 2. ✅ Draft-mode `propose_diff` is truncated on the board
- **Surfaced:** review of board-post slicing while debugging worker output.
- **Why:** Worker tool-call posts are sliced (~160 chars) and the done-post to ~180–400 to keep the feed tidy. For **clanker** mode that's fine (files are on disk for the orchestrator to read). But in **draft** mode the *only* place the proposed diff exists is the board post — so a real multi-line diff gets cut off and the orchestrator can't see/apply it.
- **Approach:** Write the full proposed diff to `.coordination/proposals/<subagentId>.diff` and post a short reference line pointing the orchestrator at it (or attach via a `get_proposal` tool). Don't cap proposal content.
- **Files:** `src/subagentLoop.ts` (onToolCall posting), `src/workerTools.ts` (`proposeDiffTool`).

### 3. ✅ Unhelpful worker error messages
- **Surfaced:** worker posted `error: fetch failed` when `:8080` had no model loaded — opaque; took a port probe to realize the model server was down/mid-swap.
- **Why:** Node's `fetch` throws a bare `fetch failed` on connection refused.
- **Approach:** Wrap backend calls so the error includes the endpoint URL and a hint, e.g. `could not reach direct backend http://127.0.0.1:8080/v1 — is the model server running?`. Distinguish connection-refused from HTTP errors.
- **Files:** `src/subagent.ts` (`chatCompletion`, `chatCompletionRaw`).

---

## P1 — Discussed enhancements

**Status: ✅ ALL DONE (#4–#7) 2026-05-31 (typecheck+build+smoke-test green). Needs an extension reload/VSIX reinstall to run live.**

### 4. ✅ Worker context / token usage display ("ctx: 12k/98k")
- **Discussed:** user asked whether we can see worker context usage like Forge's sidebar.
- **Why:** Each dispatch is a fresh context (no carryover), but a long single task accumulates messages and could approach the model window; today the only guard is `maxSteps: 12`.
- **Approach:** Capture the `usage` block (`prompt_tokens` / `total_tokens`) from each `/v1/chat/completions` response, track cumulative per dispatch, post a `ctx: Nk/Mk` line to the board, warn near the model's `num_ctx`, and optionally add a token budget + auto-summarize old tool results so a runaway worker self-compacts instead of erroring.
- **Files:** `src/subagent.ts`, `src/subagentLoop.ts`.

### 5. ✅ `list_models` MCP tool (autonomous model routing)
- **Discussed:** user wants "use model X for these files, Y for those" — currently the operator must name the model id in the board post.
- **Why:** Orchestrators can't discover what's available, so they can't route multi-model jobs on their own.
- **Approach:** New MCP tool that queries each backend's `/v1/models` (bridge `:9099` returns all its GGUFs, Ollama all pulled/cloud tags, llama-server the loaded one) and returns the menu so Claude/Codex can pick per subtask.
- **Files:** `src/subagent.ts` (tool def + handler), register in `src/mcpServer.ts` + `src/mcpStdio.ts`.

### 6. ✅ Worker self-claims its touched paths
- **Why:** Workers post lifecycle but don't `claim` the files they write, so the board's Active Claims doesn't show worker ownership and two workers could draft the same file.
- **Approach:** Have the worker loop `claim` `touched` paths (advisory) on first write and `release` on done.
- **Files:** `src/subagentLoop.ts`.

### 7. ✅ Validate model/endpoint before dispatch
- **Surfaced:** the `fetch failed` (model unloaded) and the gemma/qwen id mismatch (llama-server ignores the model field, so it silently served Qwen).
- **Approach:** Before running the loop, hit the backend's `/v1/models` (or `/health`); if the server is down, fail fast with a clear message; if the requested model id isn't served (bridge backend), warn. For `direct:` note that the id is advisory.
- **Files:** `src/subagentLoop.ts`, `src/subagent.ts`.

---

---

## P1 — UX & history (user-requested 2026-05-31)

**Status: ✅ ALL DONE — implemented, typechecked, built, and smoke-tested 2026-05-31. Needs an extension reload/VSIX reinstall to run live.**

### 13. ✅ Multiline Post Task box (paste + see bigger context)
- **Asked:** user wants to paste larger task/handoff text and actually see it, not a one-line field.
- **Why:** Post Task is currently a single-line `<input type="text">` — long pastes scroll out of view and are hard to review before posting.
- **Approach:** Replace the input with a `<textarea>` (e.g. 4–6 rows, vertically resizable, monospace-ish, max-height with scroll). Keep the same `ctrl-note` id / post wiring so the message contract is unchanged.
- **Files:** `src/webviewContent.ts` (Post Task row, [webviewContent.ts:99-102](src/webviewContent.ts#L99-L102)), `media/board.css` (textarea sizing), `media/board.js` (`ctrlNote` is typed as `HTMLInputElement` at [board.js:16](media/board.js#L16) — retype to `HTMLTextAreaElement`).

### 14. ✅ Enter key posts the task (Shift+Enter = newline)
- **Asked:** pressing Enter should act as the Post button.
- **Decision:** **Enter posts, Shift+Enter inserts a newline** (standard chat UX). Works alongside #13 — paste still fills multiple lines; Shift+Enter composes them by hand.
- **Approach:** `keydown` handler on the textarea: if `key === 'Enter' && !shiftKey` → `preventDefault()` + trigger the same post path as `btn-post-task` ([board.js:302](media/board.js#L302)). Ignore when IME composing (`isComposing`). Don't post on empty/whitespace-only.
- **Files:** `media/board.js`.

### 15. ✅ Don't delete history — save per-session (like Claude sessions) + in-app picker
- **Asked / confirmed:** today **Clear History permanently wipes the log** — `clearHistory()` overwrites `events.ndjson` with `''` ([bridge.ts:188-192](src/bridge.ts#L188-L192)); nothing is archived (the `events.ndjson.1` file is only 1 MB size-rotation, not a clear-time backup). User wants all history kept, saved as separate sessions, browsable like the Claude sidebar's conversation list.
- **Decided model (user, 2026-05-31):**
  - **Sessions are the unit of history.** A session = a timestamped (optionally named) span of board events, persisted to its own file, e.g. `.coordination/sessions/<ISO-timestamp>[-<label>].ndjson` + a small `sessions/index.json` for the picker.
  - **Boundaries:** primary = a manual **"New Session"** button (mirrors Claude's "new chat"). Safety nets so nothing is ever an unbounded blob or lost: (a) **auto-open a session on Connect** (reuse the existing `SESSION_START` marker / `bridge.startSession`); (b) **Clear History and New Session share one `archiveAndReset()` op** — archive the current live feed to its session file, then start a fresh empty live feed. Clear History is therefore no longer destructive.
  - **Access:** a **session picker in the board UI** (dropdown/list) to load a past session **read-only** into the feed, like switching Claude conversations; "live" is the current session.
- **Approach / pieces:**
  - `bridge.ts`: replace destructive `clearHistory()` with `archiveAndReset(label?)` (archive live → new session); add `startNewSession(label?)`, `listSessions()`, `readSession(id)`; write session files + `index.json` under the coord dir; ensure `EventTail`’s shrink-as-truncation logic still treats the live-feed reset cleanly ([eventTail.ts:40](src/eventTail.ts#L40)).
  - `types.ts`: messages for `newSession`, `loadSession`, `listSessions`; extend the webview→host contract (currently `clearHistory` at [types.ts:104](src/types.ts#L104)).
  - `webviewContent.ts` / `board.js` / `board.css`: add **New Session** button + session picker; "Clear History" stays but routes to `archiveAndReset`; loading a past session renders it read-only (badge + disable posting into history).
  - `boardView.ts` + `boardPanel.ts`: handle the new messages (both currently call `bridge.clearHistory()` at [boardView.ts:124](src/boardView.ts#L124) / [boardPanel.ts:107](src/boardPanel.ts#L107)).
- **Note:** `.coordination/sessions/` should be git-ignored and excluded from the VSIX (same treatment as the rest of `.coordination/`).

### 16. ✅ Worker model name on the board — distinct color + clean label (pairs with auto-routing)
- **Asked:** user wants the worker's model name visible when a worker posts (now that auto worker-selection / multi-model routing is coming).
- **Already there:** workers post under agent name `worker:<model>` ([subagent.ts:139-142](src/subagent.ts#L139-L142)) and the started line includes `(backend:model)`. So the model IS shown — no new data needed. But it renders poorly: the full GGUF filename, uppercased/bold, **truncated at 60 chars** ([subagent.ts:142](src/subagent.ts#L142)), and with **no color** (only user/claude/codex have CSS rules at [board.css:276-286](media/board.css#L276-L286); `worker:*` falls to default foreground).
- **Why it matters more now:** with auto-routing (#5 `list_models`), several different models can post concurrently — they need to be visually distinguishable.
- **Approach:**
  - Add a distinct **worker color** CSS rule (`.event-agent-worker*` or a `worker:`-prefix check in render). Same for the Active Claims agent label once workers self-claim (#6).
  - Show a **short label** (badge `worker · <short-model>` — strip backend prefix + `.gguf`, collapse long ids) with the **full id in a `title=` tooltip** so nothing is lost. Note `agentSlug()` ([board.js:449-454](media/board.js#L449-L454)) already lowercases/slugs the agent for the CSS class — a long worker slug just won't match a color rule today.
  - **Optional:** per-model tint — hash the model name → a stable color so `worker:gemma` vs `worker:qwen` differ at a glance.
- **Files:** `media/board.js` (renderEvents label + slug→worker check), `media/board.css` (worker color), optionally `src/subagent.ts` (`workerAgentName` short form).

---

## P2 — Nice-to-have / external

**Status: #9, #11, #12 ✅ DONE 2026-05-31. #8 and #10 deferred (low-value: weak-model fallback — current models tool-call fine; configurable post cap — cosmetic).**

### 8. Tool-call fallback for weak local models
- If a model returns code in a text blob instead of `tool_calls`, the worker "finishes" without writing. (Gemma & Qwen tool-called fine, so low priority.) Could parse fenced code blocks + file headers and offer to write.

### 9. ✅ Bridge: reap a stale app-server on our port at startup
- Belt-and-suspenders beyond the 0.2.5 tree-kill: if the extension host crashes abruptly, `taskkill` on stop never runs and an orphan could remain. On bridge start, if our ws port is already held, kill the holder (or pick a free port) before spawning.
- **Files:** `scripts/codex-auto-bridge.js`, `src/runtimeBridge.ts`.

### 10. Configurable board-post length cap
- The done/tool-call slicing is hardcoded. Expose a setting for users who want fuller summaries on the board (ties into #2).

### 11. ✅ Document: disable Codex's connectors/apps for IDE stability
- The recurring `codex_apps` / `chatgpt.com/backend-api/wham/apps` timeouts and `ces/v1/rgstr 403` are Codex's own ChatGPT-apps feature failing — unrelated to AgentWatch, but they can make the IDE Codex restart. Add a setup note recommending users disable Codex connectors/apps/plugins when running unattended.

### 12. ✅ P3 UI polish — unselected-agent greying (decided: grey but keep visible)
- Decide whether `SESSION_START` roster should auto-grey the unselected orchestrator's last-known activity or hide it (left open in the plan §5).

---

## Done (for reference — fixed during testing)
- **P2 #9/#11/#12 (2026-05-31):** (#9) codex-auto-bridge.js reaps a crash-orphaned app-server still LISTENING on our ws port before spawning a fresh one — `findListenerPids` (win32 `netstat -ano` parse / unix `lsof -ti`, excludes own pid), `killPid` (taskkill /T /F or SIGKILL), called at top of `#startServer` + 500ms settle; netstat parse validated on win32. (#11) README "Codex stability" note — the codex_apps/wham timeouts + ces 403 are Codex's own connectors, not AgentWatch; recommend disabling Codex connectors/apps for unattended runs. (#12) decided **grey-but-keep-visible**: renderAgentCard toggles `.card-inactive` on the whole `.status-card` (opacity 0.5 + grayscale) for an orchestrator not in the active roster. typecheck+build clean. **#8 (weak-model tool-call fallback) and #10 (configurable post cap) intentionally deferred — low value.**
- **P1 #4 (2026-05-31):** worker loop captures the OpenAI `usage` block each turn (subagentLoop.ts) — tracks latest `prompt_tokens` (context fullness) + cumulative `total_tokens`; `runWorkerLoop` exposes `onUsage` + returns `promptTokens`/`totalTokens`. The board done post + sync return now carry a `ctx ~Nk, ~Mk tok` suffix (`usageSuffix`/`ktok`), and a one-time `⚠ ctx ~Nk` warning posts when prompt tokens cross a heuristic soft ceiling (`SOFT_CTX_WARN` = 24k; num_ctx isn't exposed over the API). Auto-summarize/compaction deferred. Smoke-tested green.
- **P1 #5/#6/#7 (2026-05-31):** (#5) new `list_models` MCP tool — `subagent.ts` `fetchModels()`/`listModels()`/`handleListModels()` GET each backend's `/v1/models` (4s AbortSignal.timeout) and return a backend-prefixed menu, reporting DOWN backends; registered in mcpServer.ts + mcpStdio.ts + claude-auto-bridge ALLOWED_TOOLS. (#7) `validateBackend()` + `modelRoutingNote()`; `handleDispatchSubagent` now probes the resolved backend before dispatch — fail-fast `SUBAGENT not dispatched — could not reach …` if down, and a routing note in the started post (direct ignores the model id; bridge/ollama warn if the id isn't served). Connection errors fail; HTTP errors (e.g. /models unsupported) still proceed. (#6) clanker workers advisory-`claim` each file they actually write (once per path) and `release` on finish (finally, even on error/abort), so Active Claims shows worker ownership. Also de-staled the dispatch_subagent tool description (readonly/full are live). typecheck+build clean; mock-server smoke test green.
- **P0 #1–3 (2026-05-31):** (#1) win32 `run_command` routes an allowlist of dev tools/builtins (mkdir, npm, npx, node, git, python, tsc, …) through `cmd.exe /d /s /c` via `needsWindowsShell()` in workerDenyList.ts — denylist + shell-operator ban still applied first; timeouts now tree-kill (`taskkill /T /F`) so a stalled npm doesn't orphan node. (#2) `propose_diff` writes the FULL diff to `.coordination/proposals/<path>-<ts>.diff` (git-ignored) and the board posts a short `→ saved to <path>` ref instead of a 160-char slice; `onToolCall` callback now passes the whole `WorkerToolResult`. (#3) `subagent.ts` shared `postChat()` + `describeFetchError()` turn bare `fetch failed` into `could not reach <backend> backend at <url> — is the model server running? (connection refused/…)`. typecheck+build clean; all three smoke-tested green.
- **P1-UX #13–16 (2026-05-31):** multiline Post Task `<textarea>` (Enter posts, Shift+Enter newline, IME-safe); worker board labels = purple WORKER chip + per-model-tinted short model chip with full id on hover (`agentBadge`/`shortenModel`/`modelTint` in board.js); **non-destructive history** — Clear + new "New Session" button call `bridge.archiveAndReset()` (saves `.coordination/sessions/<id>.ndjson` + `index.json`, re-seeds SESSION_START if a session is active so agents stay linked), session picker loads any saved session read-only (live polling frozen via `viewingSessionId`). Types: `SessionSummary` + `sessionList`/`sessionEvents`/`newSession`/`listSessions`/`loadSession` messages. Wired in boardView.ts + boardPanel.ts (`refreshFeed`). typecheck+build clean; bridge archive/reseed/list/read smoke-tested green. Sessions dir covered by existing `.coordination/` git+vsix ignore.
- Orphan/zombie codex bridge (Windows `shell:true` kill only reaped `cmd.exe`) → **0.2.5** tree-kill (`taskkill /T /F`) + auto-exit on app-server drop.
- Codex missed posts made during its app-server startup window → **0.2.3** prime cursor before startup.
- Operator posts under any name (not just `user`) weren't waking agents → **0.2.2** identify operator by exclusion.
- Ambient peer-reactivity (token waste / ping-pong) → settled on operator + @mention handoffs.
- Long worker builds blocking/timeoutting a sync tool call → **0.2.4** async dispatch + wake-on-done (@mention).
- Test game folders packaged into the VSIX → excluded `tictactoe/`, `rps/` in `.vscodeignore`.
