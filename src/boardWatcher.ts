import * as fs from 'fs';
import { BoardEvent } from './types';
import { EventTail } from './eventTail';

// B4: the poll is the real source of truth — fs.watch on a single file is
// unreliable on Windows and network drives (N:). Keep fs.watch only as a
// low-latency hint and poll fast enough that the board feed stays responsive
// even when the watch never fires.
const POLL_INTERVAL_MS = 500;

export class BoardWatcher {
    private watcher: fs.FSWatcher | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private readonly tail: EventTail;

    constructor(
        private readonly eventsPath: string,
        private readonly onEvent: (event: BoardEvent) => void,
    ) {
        this.tail = new EventTail(eventsPath);
    }

    start(): void {
        this.stopped = false;
        this.tail.reset();
        this.armWatcher();
        this.armPoller();
    }

    stop(): void {
        this.stopped = true;
        this.watcher?.close();
        this.watcher = null;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private armWatcher(): void {
        if (this.stopped) { return; }
        try {
            const w = fs.watch(this.eventsPath, (type) => {
                if (type === 'change') { this.readNew(); }
            });
            w.on('error', () => this.reconnect());
            w.on('close', () => this.reconnect());
            this.watcher = w;
        } catch {
            // File may not exist yet — polling fallback will catch events until it appears
            this.watcher = null;
        }
    }

    private armPoller(): void {
        if (this.stopped) { return; }
        this.pollTimer = setInterval(() => {
            if (!fs.existsSync(this.eventsPath)) { return; }
            // Re-arm watcher if it fell over
            if (!this.watcher) { this.armWatcher(); }
            this.readNew();
        }, POLL_INTERVAL_MS);
    }

    private reconnect(): void {
        this.watcher = null;
        if (!this.stopped) { this.armWatcher(); }
    }

    private readNew(): void {
        // B5: all tail/truncation/partial-line handling lives in EventTail now.
        for (const event of this.tail.readNew()) {
            this.onEvent(event);
        }
    }
}
