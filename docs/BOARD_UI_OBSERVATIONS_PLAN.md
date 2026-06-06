# Board UI Observations - Plan

**Status:** IN PROGRESS - worker numbering, manual selection copy, and longer worker-post handling are implemented; the separate "shows as 0" issue still needs reproduction. Updated 2026-06-04.
**Scope:** Three board-UI issues raised by the owner while monitoring the 8-worker Forge Arcade run. These are **independent of** the Forge multi-provider routing work (`docs/FORGE_MULTI_PROVIDER_ROUTING_PLAN.md`) and should ship as their own small UI PR.

**Implementation status now:**

- Landed: worker identities now include a per-dispatch number (`worker-N:<model>`).
- Landed: manual selection plus `Ctrl+C` / `Cmd+C` is handled in the board webview.
- Landed: worker posts are no longer source-truncated to 300 chars; they now store a much larger bounded payload and the UI clamps long text with a `Show more` / `Show less` affordance.
- Still open: reproduce and diagnose the separate "shows as 0" report before making any code change for it.
- Operational note: a VS Code window reload is required before the updated extension/webview code is active in the UI.

---

## 0. Key finding from grounding the observations in code

Two of the three observations are **mostly caused by one root issue**: worker posts were **truncated at the source** before they were written to the board event log. Everything downstream, including the rendered feed and the Copy button, could only ever see that shortened text. So the webview was not the culprit for truncation, and "can't copy the full text" was a consequence of the same source-side slice, not a separate UI gap.

Verified facts from the original investigation:

- Worker posts were sliced to 300 chars at the source in `src/subagent.ts`.
- `bridge.post()` did not truncate; it stored `message` as-is in the board event log.
- The feed did not truncate on render; it emitted the full escaped message already present in the event.
- Text was already selectable in CSS.
- A per-event Copy button already existed in the feed.
- Worker identity had no number, so parallel workers of one model collapsed into a single board identity.

What changed in the implementation:

- Worker identities now come from `workerAgentName(model, ordinal)` and render as `worker-N:<model>`.
- Worker board posts now go through a shared formatter with an 8 KB upper bound instead of `.slice(0, 300)`.
- The board webview clamps long event text for display and lets the operator expand it.

---

## 1. Observation: post truncation / "shows as 0"

These are **two distinct problems** and should not be conflated.

### 1a. Truncation (real, source-side)

- **Cause:** the old `.slice(0, 300)` on worker lifecycle posts meant the full model output never reached the board, so neither display nor Copy could recover it.
- **Status:** implemented.
- **Chosen fix:** keep a generous source-side upper bound and let the UI decide how much to show at once.
- **Implemented shape:** worker posts are now stored up to 8 KB, while the webview shows a shortened preview until expanded with `Show more`.
- **Why this matches the plan:** the board now keeps substantially fuller worker output, and both the existing Copy button and manual selection copy can reach the full displayed content after expansion.
- **Remaining risk:** larger messages inflate `events.ndjson` and board reads, so the 8 KB cap should still be watched in real usage.

### 1b. "Shows as 0" (needs reproduction)

- **Cause:** still unknown and unconfirmed. It is not explained by truncation alone.
- **Status:** still open; not changed in the implementation.
- **Next step:** reproduce first and capture the raw `events.ndjson` line that renders as `0` before attempting any fix.

---

## 2. Observation: worker numbering (`worker-N:<model>`)

- **Cause:** `workerAgentName()` was hardcoded to `worker:<bare-model>`, so dispatching many copies of one model produced indistinguishable board identities.
- **Status:** implemented.
- **Chosen fix:** add a per-dispatch numeric prefix so workers post as `worker-N:<model>`.
- **Implemented choice:** process-wide monotonic counter for now.
- **Tradeoff:** this solves the monitoring problem immediately, though numbering can drift across separate batches instead of resetting to `worker-1..worker-N` per fan-out.
- **Follow-up possibility:** later switch to a true per-batch counter if cleaner batch-local numbering becomes important.

---

## 3. Observation: non-copyable posts (manual select + Ctrl+C does nothing)

**Owner clarification (2026-06-04):** selecting post text with the cursor and pressing `Ctrl+C` copied nothing. This is separate from the per-event Copy button.

- **Status:** implemented.
- **Diagnosis:** most likely VS Code webview command routing prevented the default browser selection-copy path from firing reliably.
- **Chosen fix:** add a document-level key handler in `media/board.js` that detects `Ctrl+C` / `Cmd+C`, reads `window.getSelection()`, and writes the selected text to the clipboard when the selection is non-empty.
- **Guard:** the handler does nothing when focus is in a textarea or input, so normal input editing copy behavior remains untouched.
- **Interaction with 1a:** manual selection can only copy what is displayed, so long-post expansion remains the path to copying the full visible message.

---

## 4. Recommended ordering

1. **Section 2 worker numbering** - implemented.
2. **Section 3 manual Ctrl+C** - implemented.
3. **Section 1a truncation** - implemented with source-side 8 KB cap plus UI clamp/expand.
4. **Section 1b "shows as 0"** - still pending reproduction.

---

## 5. Files touched

Files originally expected:

- `src/subagent.ts`
- `src/subagentLoop.ts`
- `media/board.js`
- `media/board.css`
- Possibly `src/bridge.ts` only if a separate storage cap was introduced

Files actually touched in the landed patch:

- `src/subagent.ts`
- `src/subagentLoop.ts`
- `media/board.js`
- `media/board.css`
- `tests/workerBoardUi.test.ts`

---

## 6. Open questions

1. Can the "shows as 0" report be reproduced, and is it an empty-result bug or a render edge case?
2. Should worker numbering later move from the current process-wide monotonic counter to a true per-fan-out batch counter?
3. After reloading the VS Code window, does the operator-observed UX match the intended patch behavior for long-post expansion and manual selection copy?
