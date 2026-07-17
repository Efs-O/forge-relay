import { Semaphore } from './forgeHold';

// One process-wide lane shared by short-lived `codex exec` workers. The
// isolated managed app-server has its own ChatGPT-managed profile and does not
// acquire this worker lane.
const codexProcessSlot = new Semaphore(1);

export function acquireCodexProcessSlot(): Promise<() => void> {
    return codexProcessSlot.acquire();
}
