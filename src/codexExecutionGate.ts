import { Semaphore } from './forgeHold';

// One process-wide lane shared by short-lived `codex exec` workers and the
// managed app-server. Managed mode holds this for its entire lifetime, so Relay
// never creates its own exec worker beside its long-lived Codex process.
const codexProcessSlot = new Semaphore(1);

export function acquireCodexProcessSlot(): Promise<() => void> {
    return codexProcessSlot.acquire();
}
