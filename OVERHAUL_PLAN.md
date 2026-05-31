# AgentWatch Overhaul Plan
**Date:** 2026-05-25  
**Status:** Awaiting user approval

---

## Scope and Principles
- Do not auto-edit Claude or Codex config files during extension activation.
- Prefer explicit manual setup over hidden environment mutation.
- Treat board activity, transport health, and process health as separate concerns.
- Every phase must end with a concrete verification step and rollback path.
- Do not begin major UI or workflow refactoring until Codex MCP viability is proven in this environment.

## Primary Product Model
AgentWatch is a coordination layer for persistent multi-agent repo work.

The intended workflow is:
1. The user presses `Connect`
2. Claude and Codex join the board session and begin watching for new work
3. The user posts a task, usually with a plan file, repo context, or implementation request
4. The agents read the task from the board
5. The agents discuss approach, split work, and claim files or folders as needed
6. The agents execute in parallel and post progress back to the board
7. The agents monitor each other's progress, coordinate handoffs, and avoid collisions
8. The user monitors the board until the implementation is complete

Product implications:
- `Connect` means "start a shared coordination session", not merely "show prompts"
- The board is the primary collaboration surface between user and agents
- Agents are expected to behave as persistent board participants during a session, not one-shot responders
- The panel's main job is to help the user start the session, post work, and monitor multi-agent progress to completion

---

## PHASE 0 - Codex MCP Viability Gate
**Goal:** Prove Codex can load AgentWatch MCP tools and use them reliably enough to participate in an ongoing board session before broader refactoring begins.  
**Effort:** ~30-60 minutes

### 0.1 Why This Comes First
The main product risk is not the board concept or the panel UX. The main risk is whether Codex can act as a persistent MCP-powered board participant in this environment.

This must be validated before:
- panel overhaul work
- session UX redesign
- autonomous coordination assumptions

### 0.2 Validation Sequence
Use the smallest end-to-end test that proves real viability:
1. Start Codex with verified AgentWatch MCP configuration
2. Confirm AgentWatch MCP tools are visible to Codex
3. Use Codex to read current board state
4. Use Codex to post a board message
5. Create one additional board event after the first post
6. Confirm Codex can read again and react again in the same session
7. Confirm no approval deadlock, missing-tool failure, or silent board-write failure occurs

### 0.3 What Must Be Proven
The validation must prove all of the following:
- MCP tools load successfully
- board reads work
- board writes work
- Codex can perform multiple MCP interactions in one session
- Codex does not block on per-action approval in a way that breaks the coordination model

### 0.4 Failure Interpretation
If this validation fails, do not proceed directly to broad refactoring.

Failure means one of these must happen first:
- fix Codex MCP configuration or approval behavior
- reduce product expectations for Codex autonomy
- redesign the coordination model around more manual participation
- shift more workflow logic into scripts or repo artifacts instead of relying on persistent MCP interaction

### 0.5 Exit Criteria
Phase 0 is complete only when:
- Codex can load AgentWatch MCP tools in this environment
- Codex can read and post to the board without approval deadlocks
- Codex can react to at least two board events in one ongoing session
- The result is documented as either `go` or `no-go` for the broader overhaul

---

## PHASE 1 - MCP Configuration Stabilization
**Goal:** Restore reliable Claude and Codex access to AgentWatch without repo-level config side effects or hidden auto-registration behavior.  
**Effort:** ~2-3 hours

### 1.1 Remove Repo-Level Auto-Registration
- Remove the extension logic in `src/extension.ts` that writes MCP config into the workspace automatically on activation.
- The extension may still start its own MCP stdio server on activation if needed, but it must not mutate Claude or Codex config files.
- Add a new VS Code command: `AgentWatch: Show MCP Config`.
- That command should display the exact config snippets the user can paste manually into Claude and Codex settings.

**Reasoning:**  
The current failure mode is a Claude startup timeout during repo initialization. The evidence shows Claude is actively reading workspace-level `.claude/settings.json` and `.claude/settings.local.json`. Automatic repo config mutation is too risky during activation and must be removed.

### 1.2 Verify Real Config Sources Before Documenting Fixes
Before changing any user instructions, verify which files each client actually reads in this environment.

For Claude, confirm whether it loads MCP settings from:
- `C:\Users\efso office\.claude\settings.json`
- `N:\vs code apps\Agentwatch\.claude\settings.json`
- `N:\vs code apps\Agentwatch\.claude\settings.local.json`

For Codex, confirm:
- the exact MCP config schema this build expects
- the exact approval setting name this build expects
- whether workspace-local config affects startup behavior

**Reasoning:**  
The current logs prove Claude watches `settings.json` files. The plan must not assume `~/.claude/mcp.json` is the active source unless that is verified.

### 1.3 Publish Manual Config Snippets Only After Verification
Once the actual config inputs are confirmed, provide manual config snippets for both tools through `AgentWatch: Show MCP Config`.

Requirements:
- No automatic writes
- No workspace config generation
- No silent edits to user home directories
- Snippets must match the exact schema each client expects
- Snippets must include a short explanation of what file they belong in

Claude snippet:
- Use the real Claude config file format confirmed in this environment
- Point to `N:/vs code apps/Agentwatch/out/mcpStdio.js`
- Pass `--repoRoot "N:/vs code apps/Agentwatch"`

Codex snippet:
- Use the real Codex MCP config schema confirmed in this environment
- Include any required startup timeout or tool timeout settings only if verified
- Include approval settings only if verified against the live config format

**Reasoning:**  
The immediate problem is not lack of configuration, but incorrect or intrusive configuration. Manual, explicit setup is safer than activation-time mutation.

### 1.3b Add Guided Setup and Verify UX
In addition to `AgentWatch: Show MCP Config`, add a guided setup flow for new-machine installation.

The extension should provide:
- `AgentWatch: Setup` or `AgentWatch: Verify Setup`
- detection of whether the AgentWatch MCP server bundle exists
- detection of whether Node is available
- detection of whether Codex config appears to be missing the `agentwatch` entry
- detection of whether Claude config appears to be missing the `agentwatch` entry
- copy-ready config snippets for both tools
- a visible verification result after restart

The setup flow may also offer an explicit apply action only if all of the following are true:
- the user triggered it intentionally
- the exact file diff is previewed first
- a backup is created automatically
- rollback instructions are shown clearly

It must not:
- silently mutate user home config on install
- silently mutate workspace config on activation
- assume every machine uses the same runtime layout without verification

**Reasoning:**  
The extension should automate setup guidance and verification, not hidden config mutation. New-machine onboarding should be predictable, reversible, and explicit.

### 1.3c Deferred UX TODO - First-Time Setup Entry Point
Add a dedicated first-time setup entry point in the shipped UI so users do not need to rely on the Command Palette to discover setup actions.

Deferred follow-up:
- add a small **First-time setup** button, link, or panel section
- make it point directly to `AgentWatch: Show MCP Config` and `AgentWatch: Verify Setup`
- place it where a new user will see it immediately after installing or opening the panel

This is not required to begin Phase 2, but it must remain tracked for shipping polish.

### 1.4 Add Fast Recovery Instructions
Document a rollback path so the user can recover immediately if Claude or Codex stops launching.

Recovery steps should include:
- Rename workspace `.claude/settings.json`
- Rename workspace `.claude/settings.local.json`
- If needed, temporarily rename the whole workspace `.claude` folder
- Fall back to user-level config only
- Reload VS Code and retry
- State clearly that files should be renamed first, not deleted

### 1.5 Build and Verify
- Run `npm run build`
- Restart VS Code
- Start Claude with workspace config disabled, then reintroduce verified config step by step
- Confirm Claude launches without the 60000ms subprocess initialization timeout
- Confirm Codex can access AgentWatch MCP tools without interactive approval deadlocks
- Confirm the extension no longer writes any MCP-related JSON automatically on activation
- Confirm `AgentWatch: Show MCP Config` shows current, copy-ready snippets

### Exit Criteria
Phase 1 is complete only when:
- Claude starts successfully with no startup timeout
- Codex can use AgentWatch tools without blocking on every action
- The extension performs no automatic config writes
- All setup instructions match the actual config files and schemas used in this environment
- The user has a documented rollback path that works
- The extension has a clear setup or verify flow for first-time installation on a new machine

---

## PHASE 2 - Connect/Disconnect Button + Panel UX Overhaul
**Goal:** The panel becomes the control center the user originally envisioned.  
**Effort:** ~5-6 hours

### 2.1 Define the Status Model First
The panel must distinguish these states:
- `active`: agent posted to the board within the recent activity window
- `idle`: agent is expected to be available but has not posted recently
- `stopped`: session was explicitly ended or no session has been started
- `error`: the panel cannot read board state or send required actions

Rules:
- Do not label an agent as "connected" unless there is a real transport health check
- Use "Active" and "Idle" for board-derived state
- Use a styled visual dot in the actual UI, not a literal `o` character from the markdown mockup

### 2.2 Panel Layout Redesign (`webviewContent.ts`, `board.js`, `board.css`)
Top status bar should render:
- one status block for Claude
- one status block for Codex
- primary `Connect` button
- secondary `Disconnect` button
- optional small text for `Last activity: 2 min ago`

UI requirements:
- Green dot = `active`
- Grey dot = `idle` or `stopped`
- Red dot = `error`
- Status text must be readable without color alone
- Buttons must remain usable on narrow panel widths

### 2.3 Connect Button Behavior
Pressing Connect does this sequence:
1. Verifies the MCP stdio server process is running; starts it if not
2. If start fails, show a visible error in the panel and do not continue
3. Opens an in-panel modal titled **"Start Agent Session"** showing two copy-ready commands that tell each agent to continuously watch the board, coordinate with the other agent, and execute repo work until explicitly stopped
4. Each command has a **Copy** button next to it
5. A **"Both agents started?"** confirm button closes the modal and starts session activity monitoring
6. Status blocks update automatically as agents post
7. The panel returns focus to the board feed and task input so the user can immediately post the implementation request

**For Claude Code** (paste into Claude Code chat):
```
/loop Use the agentwatch MCP tools to monitor the coordination board.
When new messages appear from user or codex, read them and respond
using the post_message tool. Your agent name is "claude".
Check every 30 seconds.
```

**For Codex** (paste into Codex chat):
```
/goal Watch the agentwatch coordination board using MCP tools.
React to new messages from other agents (user, claude).
Post responses using post_message tool. Agent name: "codex".
Keep watching until explicitly told to stop.
```

Implementation constraints:
- Connect is a session bootstrap helper for starting a shared board session, not a true remote process-control handshake
- If the MCP server is already running, do not start duplicate processes
- The modal should explain that the user still needs to paste the commands manually
- The generated prompts should instruct agents to read new board posts, coordinate with each other, claim work, post progress, and keep watching until `SESSION_END`

### 2.4 Disconnect Button
- Posts a `SESSION_END` event to the board so agents can stop their loop/goal
- Resets activity state to grey when the session is ended from the panel
- Does not kill any processes; it only signals the agents
- Shows a notice if the board write fails

Implementation note:
- Disconnect is best-effort, not guaranteed. An agent may ignore or miss the event if it is stalled or disconnected.

### 2.5 Fix STOP/PAUSE Clear Pipeline (known bug)
Two bugs currently prevent clearing STOP/PAUSE commands from the panel:
- **btn-resume bug:** sends `type: 'post'` (just logs a message) instead of actually resolving commands
- **Per-command Resolve buttons:** route correctly through the pipeline but fail silently when the extension host is in a broken state

Required fixes:
- Change `btn-resume` -> send `{ type: 'clearAllCommands' }` to the extension
- Add `clearAllCommands` case in `boardView.ts` -> calls `bridge.clearAllCommands()`
- Add `clearAllCommands()` in `bridge.ts` -> resolves all open or acknowledged STOP and PAUSE commands in one write
- Add a visible **"Clear All Commands"** button in the commands panel section
- Surface errors in the panel if resolve operations fail

### 2.6 Live Board Feed (keep existing, polish)
- Keep color coding: user=green, claude=yellow, codex=cyan
- Add relative timestamp per message, such as `"2 min ago"`
- Add agent icon or label per row
- Auto-scroll to latest entry unless the user has manually scrolled upward
- Keep existing message input for the user to post
- Show an empty state when there are no events yet

### 2.7 Session Workflow Support
The panel should reinforce the intended workflow after Connect:
- Make the board feed the visual center of the panel
- Keep the task input easy to reach immediately after session start
- Preserve visibility of recent claims, progress posts, and blockers
- Make it obvious when both agents are participating versus when only one is active
- Support monitoring until completion rather than only the initial startup moment

### Exit Criteria
Phase 2 is complete only when:
- The panel can start a shared coordination session without hidden config mutation
- Status badges reflect board-derived activity states correctly
- STOP and PAUSE commands can be cleared from the panel reliably
- Board-action failures are visible in the UI instead of failing silently
- The panel remains usable on typical narrow VS Code side-panel widths
- The post-connect experience naturally leads into "user posts task, agents coordinate, user monitors progress"

---

## PHASE 3 - Autonomous Loop Verification
**Goal:** Prove the full coordination flow works end-to-end after Connect: user posts one task, agents coordinate on the board, split work, execute, and keep each other informed until the implementation is complete.  
**Effort:** ~2 hours (mostly testing)

### 3.1 Test Sequence
1. User opens panel and clicks Connect
2. User pastes the generated command into Claude
3. User pastes the generated command into Codex
4. User confirms both agents started
5. User posts one real implementation request to the board, optionally pointing at a markdown plan file in the repo
6. Claude and Codex both read the task from the board
7. One agent proposes an approach or split, and the other acknowledges or refines it
8. The agents claim their work areas, begin execution, and post progress updates
9. The agents monitor each other's updates and coordinate any handoffs or blockers
10. The user watches the board without needing to manually orchestrate the task step by step
11. Once work is complete, the agents post completion or handoff status
12. User clicks Disconnect -> agents receive `SESSION_END`

### 3.2 Fix Anything That Breaks
Common expected issues:
- `/loop` interval tuning: too fast wastes tokens, too slow feels laggy
- Codex `/goal` wording may need adjustment to keep it watching rather than declaring victory
- Board file locking edge cases if both agents write simultaneously
- Duplicate replies if an agent reprocesses old messages after restart
- Session end not being observed quickly enough by one or both agents
- Agents responding to the user but not to each other
- Agents failing to claim work before editing
- One agent going silent after initial acknowledgement instead of staying engaged

### 3.3 Verification Logging
During testing, capture:
- timestamp of the initial user task post
- timestamp of Claude's first response
- timestamp of Codex's first response
- whether the agents explicitly discussed or split the work
- whether claims were posted before edits began
- whether both agents continued posting progress during execution
- whether completion was clearly signaled on the board
- whether either agent missed `SESSION_END`
- any board read or write failures

### 3.4 Rebuild VSIX and Reinstall Once Verified

### Exit Criteria
Phase 3 is complete only when:
- Both agents read the same posted task and coordinate through the board during the same session
- The board shows task intake, coordination, execution progress, and completion
- The panel reflects their activity without manual refresh
- The user does not need to manually steer the collaboration after posting the task
- `SESSION_END` stops the session flow reliably enough for normal use
- Prompt wording has been tuned to avoid immediate loop exit or single-response completion

---

## PHASE 4 - Worker Agent Foundation *(Design only - no code in this sprint)*
**Goal:** Define the architecture so Phases 1-3 do not need redesigning when workers are added.

### The Model
- Claude and Codex = **Orchestrators** (plan, evaluate, direct, review quality)
- Local LLMs (Ollama, llama.cpp, LM Studio) = **Workers** (execute specific coding tasks)
- AgentWatch board = coordination layer for all of them

### How Workers Fit In
- Workers register with a new MCP tool: `register_worker(name, model, endpoint, capabilities[])`
- Orchestrators dispatch with: `assign_task(worker_name, task_description, context_files[])`
- Workers post results back: `post_result(task_id, output, status)`
- Panel gets a new **Workers** tab showing registered workers and active tasks

### Design Constraints
- Worker support must be additive to the current board format
- Orchestrator-to-worker dispatch must not break Claude/Codex-only usage
- Task records need stable IDs, status transitions, and timestamps
- Worker results should be attributable to a specific worker identity and task ID

### Open Design Questions
- Whether workers write directly to the shared board or to a worker-specific channel
- How task payloads reference files without overloading the board with large content
- How retries, cancellations, and duplicate task execution are represented
- Whether worker registration is persistent or session-only

### Exit Criteria
Phase 4 is complete only when:
- The worker model is documented clearly enough to implement later
- No Phase 1-3 behavior would need to be redesigned to accommodate workers
- Open questions are explicit instead of hidden assumptions

---

## Summary Table

| Phase | What Changes | Effort | Risk |
|-------|-------------|--------|------|
| 1 - MCP Stabilization | `extension.ts`, verify config sources, manual snippets, recovery docs | ~2-3h | Low |
| 2 - Panel Overhaul | `webviewContent.ts`, `board.js`, `board.css`, `boardView.ts`, `bridge.ts` | ~5-6h | Medium |
| 3 - Loop Verification | Testing, prompt tuning, session verification | ~2h | Medium |
| 4 - Worker Design | Design only, no code | ~1h | Low |

**Total implementation: ~10-12 hours across 4 phases.**
