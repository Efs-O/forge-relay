import * as fs from 'fs';
import { BoardEvent } from './types';

/**
 * Single source of truth for "read board events appended since last call."
 *
 * Replaces the three near-identical file-tailers that used to live in
 * boardWatcher.ts, mcpStdio.ts and board-monitor.js (audit bug B5). It tracks a
 * byte offset, only emits *complete* lines (a partial trailing line is kept for
 * the next read), and treats a shrink in file size as a rotation/truncation:
 * it resumes from the new end instead of replaying historical events, so a
 * rotation (bridge.ts) or clearHistory() never spams already-seen events.
 */
export class EventTail {
    private offset = 0;

    constructor(private readonly filePath: string) {
        this.reset();
    }

    /** Resync the offset to the current end of file (skips existing content). */
    reset(): void {
        try {
            this.offset = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
        } catch {
            this.offset = 0;
        }
    }

    /** Return new, complete board events appended since the previous read. */
    readNew(): BoardEvent[] {
        let size: number;
        try {
            size = fs.statSync(this.filePath).size;
        } catch {
            return [];
        }

        if (size < this.offset) {
            // Rotated or truncated — resume from the new end, do not replay history.
            this.offset = size;
            return [];
        }
        if (size === this.offset) {
            return [];
        }

        let chunk: string;
        try {
            const fd = fs.openSync(this.filePath, 'r');
            try {
                const buf = Buffer.alloc(size - this.offset);
                fs.readSync(fd, buf, 0, buf.length, this.offset);
                chunk = buf.toString('utf8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // File locked or not ready — caller will retry on the next poll.
            return [];
        }

        // Only advance past complete lines; hold any partial trailing line back.
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl === -1) {
            return [];
        }
        const complete = chunk.slice(0, lastNl + 1);
        this.offset += Buffer.byteLength(complete, 'utf8');

        const events: BoardEvent[] = [];
        for (const line of complete.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                events.push(JSON.parse(trimmed) as BoardEvent);
            } catch {
                /* skip malformed line */
            }
        }
        return events;
    }
}
