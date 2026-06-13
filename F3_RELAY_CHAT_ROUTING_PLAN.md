# F3 (Relay side) — cloud-provider workers as full agentic workers via `/chat`

**Goal:** let Relay dispatch OpenRouter/xAI (cloud-provider) models as **full
tool-using workers**, the same as local models. Their API key lives only in
VS Code SecretStorage, so they must go through Forge's in-host `POST /chat`
proxy (Forge commit dfc658f) rather than `/ensure` (which 422s cloud models).

**Decision recorded (2026-06-13, user):** drop the Tier 1 / Tier 2 split for
cloud workers. That split exists to ration **local VRAM** — a constraint that
does not apply to cloud models (they run on the provider's hardware). Cloud
workers run the **full agentic loop with full tools by default**. The
**write-safety gates stay** (board autonomy draft/clanker + the destructive
-command denylist + per-action confirmation) — those are about write safety,
not VRAM, and are orthogonal to tiers.

---

## Key architectural insight (makes this much smaller than first thought)

Relay's worker loop is **already non-streaming**. Every completion — Tier 1 and
the agentic tool loop — funnels through one function:

`subagent.ts: postChat(resolved, body)` → `POST {resolved.baseUrl}/chat/completions`
with `stream: false`, returning the raw OpenAI response (incl.
`choices[0].message.tool_calls`). `chatCompletion` and `chatCompletionRaw` (the
tool-loop call) both go through it.

So we do **not** need streaming, a new worker loop, or a new dispatch branch.
We need two things:
1. Forge `/chat` to speak the **OpenAI response shape** and accept `tools`.
2. Relay to point a cloud worker's completion at `{controlUrl}/chat` and reuse
   the entire existing loop (tools, autonomy, denylist, checkpoints) unchanged.

---

## Forge side (amend the F3 proxy — repo: Forge)

`src/llm/ControlChatProxy.ts` + `src/backend/controlHttp.ts`:

1. **Accept `tools`.** Add optional `tools?: ToolDefinition[]` to
   `ChatProxyRequest` / `parseChatRequest`, pass through into the request built
   for `streamModelChatCompletion` (it already accepts `tools`).
2. **Buffer tool calls.** Add `onToolCalls` to the proxy's stream handlers;
   capture `tool_calls` into the result.
3. **Return OpenAI-compatible shape.** Change `handleChat`'s 200 body from the
   flat `{ content, finish_reason }` to:
   ```jsonc
   { "choices": [ { "index": 0,
       "message": { "role": "assistant", "content": "...",
                    "reasoning": "...", "tool_calls": [...] },
       "finish_reason": "stop" } ],
     "model": "grok-4.3" }
   ```
   `/chat` is brand-new and has no released consumer, so changing the shape now
   (before anyone depends on the flat one) is free and lets Relay reuse
   `postChat` verbatim. Update the 3 Forge `/chat` route tests + 5 proxy unit
   tests to the new shape (still assert `finish_reason` + buffered content).
4. Keep the existing guards: local model → 422, unknown → 404, no proxy → 501,
   missing key → 422.

Est: ~30 LOC in ControlChatProxy, ~10 in controlHttp, test updates. Watch the
350-LOC cap on both files (currently 121 / 124).

## Relay side (repo: forge-relay)

1. **Catalog servability.** `fetchModelCatalog` reads Forge `GET /models`;
   surface `servable` (and confirm `provider`) on `CatalogModelEntry`.
   `~subagent.ts`.
2. **Route cloud → forge-chat ResolvedModel.** In `decideForgeRoute`, when the
   single control match has `servable === false`, return
   `{ kind: 'resolved', resolved: { backend: 'forge-chat', model: name,
   baseUrl: controlUrl } }` (NOT `forge-control`, so it skips
   `/ensure`/hold/slot). It then flows through the existing `kind: 'resolved'`
   dispatch path in `subagentLoop.ts` — no new branch.
3. **`postChat` path switch.** When `resolved.backend === 'forge-chat'`, POST to
   `{baseUrl}/chat` instead of `{baseUrl}/chat/completions`. One line; the body
   (`{ model, messages, tools, stream:false }`) is unchanged and Forge ignores
   `stream`. `~subagent.ts`.
4. **`validateBackend` for forge-chat.** The pre-dispatch probe hits
   `{baseUrl}/models`; for forge-chat that's the control server's `/models`
   (works). Confirm it doesn't require the model to be "loaded" (cloud models
   are never loaded) — relax the reachability check to "control healthz ok" for
   forge-chat if needed. `~subagent.ts / subagentLoop.ts`.
5. **Default cloud workers to full tools.** When the dispatched model resolves
   to `forge-chat` and `tools` was unspecified, default to `'full'` (local
   default unchanged). Confirm where `requestedTools` defaults in
   `subagentLoop.ts`.

## F1 fix (rides this change — repo: forge-relay)

Now that `/chat` returns `finish_reason`, in the worker completion handling:
empty/whitespace assistant `content` **and** no `tool_calls` **and**
`finish_reason === 'length'` ⇒ surface a worker **ERROR**
("reasoning/length overflow — raise max_tokens or lower reasoning_effort"),
never a `COMPLETED:` with empty body. Apply at the single parse point after
`postChat` so it covers local + cloud. `~subagent.ts`.

---

## Test plan

Forge (vitest):
- `/chat` with `tools` → response carries `choices[0].message.tool_calls`.
- shape change: `choices[0].message.content` + `finish_reason` present.

Relay (vitest):
- `decideForgeRoute`: `servable:false` match → `forge-chat` resolved (baseUrl =
  controlUrl); `servable:true` → `forge-control`.
- `postChat` builds `/chat` for `forge-chat`, `/chat/completions` otherwise.
- F1: a completion with empty content + `finish_reason:'length'` → ERROR.

Manual (real key in Forge, board dispatch):
- Tier-`full` worker to a cloud model writes a file end-to-end (clanker mode);
  verify no `/ensure` call, tool calls execute, checkpoint created.
- Confirm autonomy gate still blocks writes in draft mode for a cloud worker.

## Out of scope
- **F2** (worker-N board identity collision) — independent small change, do
  separately.
- Streaming token display for cloud workers (workers don't need it; the loop is
  buffered by design).

## File/owner map (quick reference for impl session)
- Forge: `src/llm/ControlChatProxy.ts`, `src/backend/controlHttp.ts`,
  `test/unit/ControlChatProxy.test.ts`, `test/unit/ControlServer.test.ts`.
- Relay: `src/subagent.ts` (postChat, decideForgeRoute, catalog, F1),
  `src/subagentLoop.ts` (resolved-path dispatch already exists; tools default),
  `tests/…`.
- Gates: Forge `npx tsc --noEmit && npx vitest run && npm run package`;
  Relay equivalent (`npm run` scripts in forge-relay/package.json).
