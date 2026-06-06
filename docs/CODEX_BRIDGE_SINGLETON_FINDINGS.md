# Codex Runtime Bridge Duplication Findings

Date: 2026-06-03
Repo: `N:\vs code apps\Agentwatch`

## Summary

Observed behavior suggests managed-bridge token usage can spike even when the orchestrator appears mostly idle on the board.

The strongest local evidence points to repeated Codex runtime bridge startups and repeated Codex thread creation, not repeated orchestrator turns.

The likely bug is that AgentWatch does not enforce a single managed runtime bridge owner per repo/workspace coordination root. Multiple VS Code windows, extension-host reloads, or repeated activation can start additional managed bridges, each of which opens a fresh thread.

The same structural bug also applies to managed Claude Mode B, because Claude Mode B uses the same supervised runtime-bridge pattern. It does not apply to Claude Mode A, which is the user's own interactive Claude session rather than a managed headless bridge.

Important current-state note as of 2026-06-04: AgentWatch no longer auto-restores a managed Codex bridge by default. The extension now forces `codex: false` on restore and leaves Codex unmanaged unless the operator explicitly re-enables the managed Codex bridge in the session UI. That means the duplication described here is no longer the default Codex path, but the underlying singleton bug still exists in the managed bridge architecture and can still be triggered by manually enabling managed Codex or by using Claude Mode B.

## Evidence

### 1. Very few actual Codex turns

From `.coordination/codex-bridge.log`, only a small number of lines show real Codex event forwarding:

- `forwarding event to codex: 2026-06-02T08:03:28.681Z [post] user HELLO AGENTS ALL ONLINE ?`
- `forwarding event to codex: 2026-06-02T08:17:13.676Z [post] user HELLO AGENTS ALL ONLINE ?`
- `forwarding event to codex: 2026-06-02T08:19:22.936Z [post] user CODEX ARE YOU ONLINE ?`

There is not corresponding evidence of continuous orchestrator work during the worker/build periods.

### 2. Many Codex bridge startups and thread creations

The same log shows many bridge starts and thread creations:

- `2026-06-02T08:02:39` thread started
- `2026-06-02T08:14:44` thread started
- `2026-06-02T11:35:46` thread started
- `2026-06-02T17:24:14` thread started
- `2026-06-02T17:27:38` thread started
- `2026-06-02T17:28:38` thread started
- `2026-06-02T17:30:19` thread started
- `2026-06-03T07:48:36` thread started
- `2026-06-03T07:59:29` thread started
- `2026-06-03T09:28:31` thread started
- `2026-06-03T09:28:48` thread started

This is a much stronger signal than the number of actual turns. Multiple runtime starts can create multiple Codex sessions/threads even when little board work is being done.

### 3. No cross-process singleton protection for the runtime bridge

The repo has a board coordination lock in `src/bridge.ts` for board writes, but there is no similar ownership lock or lease for the Codex runtime bridge itself.

Relevant files:

- `src/runtimeBridge.ts`
- `src/runtimeManager.ts`
- `src/extension.ts`

Inside a single `RuntimeManager`, `ScriptRuntimeBridge.start()` avoids duplicate children only if `this.child` already exists. That does not protect against:

- a second VS Code window using the same repo
- extension-host restart/reload
- another activation restoring the saved roster and starting Codex again

### 4. Activation and session start can still spawn duplicate managed bridges without a lease

Historically, restore behavior could auto-start managed Codex on activation. Today, Codex restore is explicitly suppressed by default, but the managed bridge still has no cross-process ownership guard. If Codex is manually re-enabled in more than one window, or if Claude Mode B is active in more than one window, each window can still start its own managed bridge.

Relevant path:

- `src/extension.ts`
- `src/runtimeManager.ts`

So the missing lease is still the root architectural issue even though the default Codex restore path has been narrowed.

## Root Cause

AgentWatch currently supervises managed runtime bridges only in-process.

It does not implement "one managed runtime bridge per agent per repo root" across:

- multiple VS Code windows
- extension host reloads
- stale child recovery after crash/restart

As a result, the system can open multiple managed bridges and multiple fresh managed sessions for the same repo, which can inflate token usage independently of actual orchestrator work.

For Codex specifically, this is now a latent or opt-in failure mode rather than the default startup behavior, because managed Codex is no longer auto-restored by default. For Claude Mode B, it remains a live default risk whenever more than one window enables the managed Claude bridge.

The same reasoning also applies to the managed Claude Mode B bridge:

- Codex: yes
- Claude Mode B: yes
- Claude Mode A: no, not through this specific runtime-bridge bug

Why:

- Claude Mode B uses the same `ScriptRuntimeBridge` supervision model as Codex in `src/runtimeManager.ts`
- the same missing cross-process singleton/lease exists in `src/runtimeBridge.ts`
- therefore multiple windows or repeated activations can also start multiple managed Claude bridges

The difference is that Claude Mode A is the user's own interactive Claude session and AgentWatch does not supervise a headless Claude bridge for it.

## Suggested Patch

Implement a per-repo, per-agent runtime lease for the managed bridges. Codex is the immediate observed failure, but the fix should be generalized so the same protection covers Claude Mode B too.

### Goal

Guarantee that only one live managed runtime bridge per agent may own a given coordination root at a time.

### Recommended design

Add a runtime lease file under `.coordination`, separate from the existing board lock. Examples:

- `.coordination/runtime-codex.json`
- `.coordination/runtime-claude.json`

Suggested lease contents:

```json
{
  "agent": "codex",
  "owner_pid": 12345,
  "started_at": "2026-06-03T10:00:00.000Z",
  "heartbeat_at": "2026-06-03T10:00:05.000Z",
  "repo_root": "N:\\vs code apps\\Agentwatch"
}
```

### Required behavior

1. Before spawning the managed bridge, attempt to acquire the runtime lease for that agent.
2. If the lease exists:
   - check whether the owning PID is still alive
   - if alive, do not spawn another bridge for that agent
   - mark this window as follower/attached, not owner
3. If the lease exists but the PID is dead or stale:
   - reap the stale lease
   - become the new owner
4. While the owner bridge is running:
   - refresh `heartbeat_at` periodically
5. On clean shutdown:
   - remove the lease only if the current process still owns it

### Minimum implementation points

Likely files:

- `src/runtimeBridge.ts`
- optionally a new helper such as `src/runtimeLease.ts`

Recommended changes:

1. Add a small runtime lease helper that can:
   - acquire lease
   - renew heartbeat
   - validate owner PID
   - release lease safely

2. In `ScriptRuntimeBridge.start()`:
   - acquire the lease before `spawnChild()`
   - if lease acquisition says another live owner exists, do not spawn a child
   - set status text to something like `linked (follower)` or `inactive (owned by another window)`

3. In `ScriptRuntimeBridge.stop()`:
   - release the lease only if this process owns it

4. In the bridge child exit path:
   - ensure lease cleanup happens for the owning process

5. Add stale-owner recovery:
   - if owner PID is gone, allow takeover on the next start

## Optional UX improvement

Expose ownership state in the runtime status:

- `linked` for the owner bridge
- `follower` or `shared` when another window already owns the runtime

This is optional, but it would make duplicate-start behavior obvious to the operator.

## Why this patch matters

The orchestrator-worker model only saves tokens if the orchestrator runtime remains stable.

If multiple Codex runtime bridges or repeated Codex threads are created for the same repo, token savings from worker offloading can be reduced or fully negated.

This singleton-lease fix should be treated as higher priority than prompt tuning if the goal is real token savings and stable unattended orchestration.

Because the same runtime supervision model is used for Claude Mode B, the lease should be agent-scoped and reused there too, instead of shipping a Codex-only special case.

## Acceptance Criteria

After the patch:

1. Opening a second VS Code window on the same repo must not spawn a second managed bridge for the same agent.
2. Reloading the extension host must not accumulate extra live managed bridges.
3. At most one owning managed runtime bridge per agent may exist per repo root at any time.
4. Stale owners must be recoverable automatically after crash or forced close.
5. `.coordination/codex-bridge.log` should show one stable Codex bridge lifecycle, not repeated bridge/thread creation during normal use.
6. The same ownership protection should apply to Claude Mode B, while leaving Claude Mode A unchanged.
