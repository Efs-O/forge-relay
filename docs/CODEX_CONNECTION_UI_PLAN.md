# Codex Connection UI Plan

Date: 2026-06-06
Status: implemented

## Goal

Make the Forge Relay UI distinguish between:

- Codex participating in a session through its own MCP-configured sidebar
- Forge Relay launching a second managed Codex bridge for debug use

The main UX problem was that the old UI made `Codex connected/disconnected`
sound like all Codex board access depended on the managed bridge, which is not
the intended single-process setup.

## TODOs

- [x] Split "Codex participates in this session" from "launch managed Codex bridge"
- [x] Keep Codex selectable as an orchestrator without auto-starting the managed bridge
- [x] Move managed Codex launch into an explicit debug-only option in the connect modal
- [x] Rewrite Codex modal copy to make the MCP path the default mental model
- [x] Relabel runtime/bridge wording so the UI says `managed bridge` where appropriate
- [x] Preserve session roster state while forcing managed Codex bridge restore to stay off
- [x] Update the command title/tooltip so the status bar action reads as a debug bridge toggle
- [x] Run typecheck after the refactor

## Implementation notes

- Session roster and managed Codex bridge state are now separate values.
- A session can include Codex while the managed bridge remains off.
- The connect modal keeps Codex in the orchestrator roster, but the actual
  bridge launch is now a separate debug checkbox.
- Restore behavior still follows the single-process safety rule: Codex may stay
  selected in the session, but the managed bridge does not auto-start on reload.

## Follow-up ideas

- Add explicit UI telemetry or a handshake-based signal for `Codex MCP detected`
  versus `not detected`, instead of only describing the intended path in copy.
- Consider hiding the managed Codex bridge command entirely unless a debug mode
  setting is enabled.
