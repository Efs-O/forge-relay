import * as fs from 'fs';
import { BoardEvent } from './types';

export class BoardWatcher {
    private watcher: fs.FSWatcher | null = null;
    private lastSize = 0;

    constructor(
        private readonly eventsPath: string,
        private readonly onEvent: (event: BoardEvent) => void,
    ) {}

    start(): void {
        // Baseline — don't replay history on startup
        try { this.lastSize = fs.statSync(this.eventsPath).size; } catch { this.lastSize = 0; }

        try {
            this.watcher = fs.watch(this.eventsPath, (type) => {
                if (type === 'change') { this.readNew(); }
            });
        } catch {
            // File may not exist yet — poll until it appears
            const timer = setInterval(() => {
                if (fs.existsSync(this.eventsPath)) {
                    clearInterval(timer);
                    this.start();
                }
            }, 1000);
        }
    }

    stop(): void {
        this.watcher?.close();
        this.watcher = null;
    }

    private readNew(): void {
        try {
            const size = fs.statSync(this.eventsPath).size;
            if (size <= this.lastSize) { return; }

            const fd = fs.openSync(this.eventsPath, 'r');
            const buf = Buffer.alloc(size - this.lastSize);
            fs.readSync(fd, buf, 0, buf.length, this.lastSize);
            fs.closeSync(fd);
            this.lastSize = size;

            for (const line of buf.toString('utf8').split('\n')) {
                if (!line.trim()) { continue; }
                try { this.onEvent(JSON.parse(line) as BoardEvent); }
                catch { /* skip malformed line */ }
            }
        } catch { /* file locked or not ready */ }
    }
}
