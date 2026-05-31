import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Claim, Command, BoardEvent, BoardState, SessionState, AgentPresence, SessionSummary } from './types';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const EVENTS_MAX = 200;
// B2: rotate the live events file once it grows past this size so it stays
// bounded on disk. Older lines are archived to events.ndjson.1.
const EVENTS_ROTATE_BYTES = 1_000_000;
// B6: which agents an "all" command waits on before it counts as acknowledged.
const EXPECTED_ALL_AGENTS = ['claude', 'codex'];

export class Bridge {
    private readonly coordDir: string;
    private readonly claimsPath: string;
    private readonly eventsPath: string;
    private readonly eventsArchivePath: string;
    private readonly commandsPath: string;
    private readonly autonomyPath: string;
    private readonly lockPath: string;
    private readonly sessionsDir: string;
    private readonly sessionsIndexPath: string;
    private readonly repoRoot: string;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
        this.coordDir = path.join(repoRoot, '.coordination');
        this.claimsPath = path.join(this.coordDir, 'claims.json');
        this.eventsPath = path.join(this.coordDir, 'events.ndjson');
        this.eventsArchivePath = path.join(this.coordDir, 'events.ndjson.1');
        this.commandsPath = path.join(this.coordDir, 'commands.json');
        this.autonomyPath = path.join(this.coordDir, 'autonomy.json');
        this.lockPath = path.join(this.coordDir, 'bridge.lock');
        this.sessionsDir = path.join(this.coordDir, 'sessions');
        this.sessionsIndexPath = path.join(this.sessionsDir, 'index.json');
        this.ensureStore();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    claim(agent: string, targets: string[], ttlMinutes: number, note: string): void {
        this.withLock(() => {
            const state = this.readClaims();
            this.pruneExpired(state);
            const normalised = targets.map(t => this.normalisePath(t));

            const conflicts = state.claims.flatMap(c =>
                c.agent !== agent
                    ? c.paths.filter(p => normalised.includes(p)).map(p => ({ path: p, agent: c.agent }))
                    : []
            );
            if (conflicts.length > 0) {
                throw new Error(`CLAIM DENIED — held by: ${conflicts.map(c => `${c.path} (${c.agent})`).join(', ')}`);
            }

            // remove existing claim by same agent for same paths
            state.claims = state.claims.filter(c =>
                !(c.agent === agent && arraysEqual(c.paths.slice().sort(), normalised.slice().sort()))
            );

            const now = new Date();
            state.claims.push({
                agent,
                paths: normalised,
                claimed_at: now.toISOString(),
                expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
                note,
            });
            this.writeClaims(state);
            this.appendEvent({ type: 'claim', agent, paths: normalised, message: note });
        });
    }

    release(agent: string, targets: string[], note: string): void {
        this.withLock(() => {
            const state = this.readClaims();
            const normalised = targets.map(t => this.normalisePath(t));
            const before = state.claims.length;
            state.claims = state.claims.filter(c =>
                !(c.agent === agent && arraysEqual(c.paths.slice().sort(), normalised.slice().sort()))
            );
            const releasedCount = before - state.claims.length;
            if (releasedCount === 0) {
                throw new Error('No matching claim found to release.');
            }
            this.writeClaims(state);
            this.appendEvent({ type: 'release', agent, paths: normalised, message: note });
        });
    }

    post(agent: string, note: string): void {
        this.withLock(() => {
            this.appendEvent({ type: 'post', agent, paths: [], message: note });
        });
    }

    postCommand(agent: string, note: string, targetAgent: string): string {
        const id = crypto.randomUUID();
        this.withLock(() => {
            const state = this.readCommands();
            state.commands.push({
                id,
                created_at: new Date().toISOString(),
                created_by: agent,
                target_agent: targetAgent,
                text: note,
                status: 'open',
                acknowledgements: [],
            });
            this.writeCommands(state);
            this.appendEvent({ type: 'command', agent, paths: [], message: note, meta: { command_id: id, target_agent: targetAgent } });
        });
        return id;
    }

    ack(agent: string, commandId: string, note: string): void {
        this.withLock(() => {
            const state = this.readCommands();
            const cmd = state.commands.find(c => c.id === commandId);
            if (!cmd) { throw new Error(`Unknown command id: ${commandId}`); }
            if (!cmd.acknowledgements.find(a => a.agent === agent)) {
                cmd.acknowledgements.push({ agent, acknowledged_at: new Date().toISOString(), note });
            }
            if (cmd.target_agent === 'all') {
                // B6: a broadcast command stays 'open' until every expected agent
                // has acked; only then does it flip to 'acknowledged' (it still
                // blocks until explicitly resolved). Previously it stayed 'open'
                // forever even after all agents acked.
                const acked = new Set(cmd.acknowledgements.map(a => a.agent));
                cmd.status = EXPECTED_ALL_AGENTS.every(a => acked.has(a)) ? 'acknowledged' : 'open';
            } else {
                cmd.status = 'acknowledged';
            }
            this.writeCommands(state);
            this.appendEvent({ type: 'ack', agent, paths: [], message: note, meta: { command_id: commandId } });
        });
    }

    resolve(agent: string, commandId: string, note: string): void {
        this.withLock(() => {
            const state = this.readCommands();
            const cmd = state.commands.find(c => c.id === commandId);
            if (!cmd) { throw new Error(`Unknown command id: ${commandId}`); }
            cmd.status = 'resolved';
            (cmd as Command & { resolved_at: string; resolved_by: string; resolution_note: string }).resolved_at = new Date().toISOString();
            (cmd as Command & { resolved_by: string }).resolved_by = agent;
            (cmd as Command & { resolution_note: string }).resolution_note = note;
            this.writeCommands(state);
            this.appendEvent({ type: 'resolve', agent, paths: [], message: note, meta: { command_id: commandId } });
        });
    }

    clearAllCommands(agent: string, note: string): number {
        let resolved = 0;
        this.withLock(() => {
            const state = this.readCommands();
            const now = new Date().toISOString();
            for (const cmd of state.commands) {
                if (cmd.status === 'resolved') {
                    continue;
                }
                if (!/\b(STOP|PAUSE)\b/i.test(cmd.text)) {
                    continue;
                }
                cmd.status = 'resolved';
                cmd.resolved_at = now;
                cmd.resolved_by = agent;
                cmd.resolution_note = note;
                resolved += 1;
                this.appendEvent({ type: 'resolve', agent, paths: [], message: `${note}: ${cmd.text}`, meta: { command_id: cmd.id } });
            }
            this.writeCommands(state);
        });
        return resolved;
    }

    endSession(agent: string): void {
        this.post(agent, 'SESSION_END');
    }

    startSession(agent: string, meta?: Record<string, unknown>): void {
        // P3: carry the selected roster in meta so the board (and any worker)
        // knows who is participating in this session.
        this.withLock(() => {
            this.appendEvent({ type: 'post', agent, paths: [], message: 'SESSION_START', meta });
        });
    }

    /**
     * Archive the current live feed to its own session file, then start a fresh
     * feed. Non-destructive: nothing is deleted — the cleared history is saved
     * under .coordination/sessions/ and remains browsable. If a session is
     * currently active, a fresh SESSION_START (carrying the same roster meta) is
     * re-seeded so the connected orchestrators stay linked across the reset.
     * Returns the summary of the archived span, or null if the feed was empty.
     */
    archiveAndReset(label?: string): SessionSummary | null {
        let summary: SessionSummary | null = null;
        this.withLock(() => {
            const lines = this.readEventLines();
            const events = lines
                .map(l => { try { return JSON.parse(l) as BoardEvent; } catch { return null; } })
                .filter((e): e is BoardEvent => e !== null);

            // Detect an active session before we wipe the live file, so we can
            // re-seed its SESSION_START and keep agents linked.
            const lastStart = [...events].reverse().find(e => e.type === 'post' && e.message.includes('SESSION_START')) ?? null;
            const lastEnd = [...events].reverse().find(e => e.type === 'post' && e.message.includes('SESSION_END')) ?? null;
            const sessionActive = lastStart !== null
                && (!lastEnd || new Date(lastStart.timestamp) > new Date(lastEnd.timestamp));

            if (lines.length > 0) {
                summary = this.writeSessionArchive(lines, events, label);
            }

            if (sessionActive && lastStart) {
                const reseed: BoardEvent = {
                    timestamp: new Date().toISOString(),
                    type: 'post',
                    agent: lastStart.agent,
                    paths: [],
                    message: 'SESSION_START',
                    meta: lastStart.meta,
                };
                this.writeFileAtomic(this.eventsPath, JSON.stringify(reseed) + '\n');
            } else {
                this.writeFileAtomic(this.eventsPath, '');
            }
        });
        return summary;
    }

    /** Backwards-compatible alias — "Clear History" now archives instead of wiping. */
    clearHistory(): SessionSummary | null {
        return this.archiveAndReset();
    }

    /** Saved history spans, newest first. */
    listSessions(): SessionSummary[] {
        try {
            const raw = fs.readFileSync(this.sessionsIndexPath, 'utf8').trim();
            const parsed = raw ? JSON.parse(raw) : { sessions: [] };
            const sessions: SessionSummary[] = Array.isArray(parsed.sessions) ? parsed.sessions : [];
            return [...sessions].sort((a, b) => b.archived_at.localeCompare(a.archived_at));
        } catch {
            return [];
        }
    }

    /** Read back an archived session's events (capped, read-only viewing). */
    readSessionEvents(id: string, limit = EVENTS_MAX): BoardEvent[] {
        const file = path.join(this.sessionsDir, `${path.basename(id)}.ndjson`);
        try {
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
            return lines.slice(-limit)
                .map(l => { try { return JSON.parse(l) as BoardEvent; } catch { return null; } })
                .filter((e): e is BoardEvent => e !== null);
        } catch {
            return [];
        }
    }

    clearExpired(): void {
        this.withLock(() => {
            const state = this.readClaims();
            this.pruneExpired(state);
            this.writeClaims(state);
        });
    }

    getState(): BoardState {
        // B3: read-only. Sidebars/watchers poll this every ~0.5–2s; taking the
        // write lock here (via clearExpired) caused constant lock churn. Expired
        // claims are filtered out lazily on read and only physically pruned (with
        // an 'expired' event logged) the next time an agent claims/releases.
        const now = new Date();
        const claims = this.readClaims().claims.filter(c => new Date(c.expires_at) > now);
        const commands = this.readCommands().commands;
        const events = this.readEvents(EVENTS_MAX);
        return { generated_at: now.toISOString(), claims, commands, events };
    }

    getSessionState(): SessionState {
        const state = this.getState();
        const lastSessionStart = [...state.events]
            .reverse()
            .find(event => event.type === 'post' && event.message.includes('SESSION_START'))
            ?.timestamp ?? null;
        const lastSessionEnd = [...state.events]
            .reverse()
            .find(event => event.type === 'post' && event.message.includes('SESSION_END'))
            ?.timestamp ?? null;
        const isSessionActive = lastSessionStart !== null
            && (!lastSessionEnd || new Date(lastSessionStart) > new Date(lastSessionEnd));
        const claude = this.buildAgentPresence('claude', state.events, lastSessionStart, lastSessionEnd, isSessionActive);
        const codex = this.buildAgentPresence('codex', state.events, lastSessionStart, lastSessionEnd, isSessionActive);
        const lastActivity = [claude.last_event_at, codex.last_event_at, isSessionActive ? lastSessionStart : null]
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? null;
        return {
            claude,
            codex,
            last_activity_at: lastActivity,
            session_started_at: lastSessionStart,
            is_session_active: isSessionActive,
            has_session_end: Boolean(lastSessionEnd),
        };
    }

    getEventsPath(): string {
        return this.eventsPath;
    }

    getRepoRoot(): string {
        return this.repoRoot;
    }

    // ── Worker autonomy (Clanker-style, cross-process via .coordination) ──────
    // 'draft'   = workers are readonly + propose_diff (default, safe)
    // 'clanker' = workers may write/edit/run, bounded by the denylist
    getAutonomyMode(): 'draft' | 'clanker' {
        try {
            const raw = fs.readFileSync(this.autonomyPath, 'utf8').trim();
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed.mode === 'clanker' ? 'clanker' : 'draft';
        } catch {
            return 'draft';
        }
    }

    setAutonomyMode(mode: 'draft' | 'clanker'): void {
        this.writeFileAtomic(this.autonomyPath, JSON.stringify({ mode }));
    }

    /** Seed the autonomy mode from config only if it has never been set. */
    ensureAutonomyDefault(mode: 'draft' | 'clanker'): void {
        if (!fs.existsSync(this.autonomyPath)) {
            this.setAutonomyMode(mode);
        }
    }

    getBlockingCommands(agent: string): Command[] {
        const state = this.readCommands();
        return state.commands.filter(c =>
            (c.status === 'open' || c.status === 'acknowledged') &&
            (c.target_agent === 'all' || c.target_agent === agent) &&
            /\b(STOP|PAUSE)\b/i.test(c.text)
        );
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private ensureStore(): void {
        fs.mkdirSync(this.coordDir, { recursive: true });
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        if (!fs.existsSync(this.claimsPath)) { fs.writeFileSync(this.claimsPath, '{"claims":[]}', 'utf8'); }
        if (!fs.existsSync(this.eventsPath)) { fs.writeFileSync(this.eventsPath, '', 'utf8'); }
        if (!fs.existsSync(this.commandsPath)) { fs.writeFileSync(this.commandsPath, '{"commands":[]}', 'utf8'); }
        this.removeStaleLock();
    }

    private removeStaleLock(): void {
        try {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                fs.unlinkSync(this.lockPath);
            }
        } catch { /* no lock file */ }
    }

    private withLock(fn: () => void): void {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const fd = fs.openSync(this.lockPath, 'wx');
                fs.closeSync(fd);
                try { fn(); } finally { try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ } }
                return;
            } catch {
                this.sleepSync(LOCK_RETRY_MS);
            }
        }
        throw new Error('Could not acquire coordination lock — timed out.');
    }

    private normalisePath(input: string): string {
        const absolute = path.isAbsolute(input) ? input : path.join(this.repoRoot, input);
        const full = path.resolve(absolute);
        const repoFull = path.resolve(this.repoRoot);
        if (!full.toLowerCase().startsWith(repoFull.toLowerCase())) {
            throw new Error(`Target is outside repo root: ${input}`);
        }
        return full.substring(repoFull.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
    }

    private readClaims(): { claims: Claim[] } {
        try {
            const raw = fs.readFileSync(this.claimsPath, 'utf8').trim();
            return raw ? JSON.parse(raw) : { claims: [] };
        } catch { return { claims: [] }; }
    }

    private writeClaims(state: { claims: Claim[] }): void {
        this.writeFileAtomic(this.claimsPath, JSON.stringify(state, null, 2));
    }

    private readCommands(): { commands: Command[] } {
        try {
            const raw = fs.readFileSync(this.commandsPath, 'utf8').trim();
            return raw ? JSON.parse(raw) : { commands: [] };
        } catch { return { commands: [] }; }
    }

    private writeCommands(state: { commands: Command[] }): void {
        this.writeFileAtomic(this.commandsPath, JSON.stringify(state, null, 2));
    }

    private appendEvent(event: Omit<BoardEvent, 'timestamp'>): void {
        // B1: append a single line instead of reading + rewriting the whole file
        // on every post. Always called inside withLock, so the append is safe.
        const entry: BoardEvent = { timestamp: new Date().toISOString(), ...event };
        fs.appendFileSync(this.eventsPath, JSON.stringify(entry) + '\n', 'utf8');
        this.rotateEventsIfNeeded();
    }

    private rotateEventsIfNeeded(): void {
        // B2: keep the live events file bounded. Once it passes the size
        // threshold, move the older lines into events.ndjson.1 (archive) and
        // re-seed the live file with the most recent EVENTS_MAX lines so the
        // board feed keeps its recent history. Only reads the whole file at the
        // rare rotation boundary, never on a normal append.
        let size: number;
        try {
            size = fs.statSync(this.eventsPath).size;
        } catch {
            return;
        }
        if (size < EVENTS_ROTATE_BYTES) {
            return;
        }
        try {
            const lines = fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter(l => l.trim());
            const tail = lines.slice(-EVENTS_MAX);
            const head = lines.slice(0, -EVENTS_MAX);
            if (head.length > 0) {
                fs.appendFileSync(this.eventsArchivePath, head.join('\n') + '\n', 'utf8');
            }
            this.writeFileAtomic(this.eventsPath, tail.length > 0 ? tail.join('\n') + '\n' : '');
        } catch {
            /* rotation is best-effort; a failure just defers it to the next append */
        }
    }

    private readEvents(limit: number): BoardEvent[] {
        try {
            const lines = fs.readFileSync(this.eventsPath, 'utf8')
                .split('\n')
                .filter(l => l.trim());
            return lines.slice(-limit).map(l => JSON.parse(l) as BoardEvent);
        } catch { return []; }
    }

    /** Raw (unparsed) non-empty lines of the live feed. */
    private readEventLines(): string[] {
        try {
            return fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter(l => l.trim());
        } catch { return []; }
    }

    /** Persist the given live-feed lines as a new session file + index entry. */
    private writeSessionArchive(lines: string[], events: BoardEvent[], label?: string): SessionSummary {
        const now = new Date();
        const stamp = now.toISOString().replace(/[:.]/g, '-');
        const id = `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
        const started = events[0]?.timestamp ?? null;
        const ended = events[events.length - 1]?.timestamp ?? null;
        const summary: SessionSummary = {
            id,
            label: (label && label.trim()) || this.defaultSessionLabel(now, events),
            started_at: started,
            ended_at: ended,
            archived_at: now.toISOString(),
            event_count: events.length,
        };
        this.writeFileAtomic(path.join(this.sessionsDir, `${id}.ndjson`), lines.join('\n') + '\n');
        const index = this.listSessions();
        index.push(summary);
        this.writeFileAtomic(this.sessionsIndexPath, JSON.stringify({ sessions: index }, null, 2));
        return summary;
    }

    private defaultSessionLabel(when: Date, events: BoardEvent[]): string {
        // Prefer the session's own start time if it carried one; else now.
        const start = events.find(e => e.type === 'post' && e.message.includes('SESSION_START'));
        const at = start ? new Date(start.timestamp) : when;
        return `Session ${at.toLocaleString()}`;
    }

    private pruneExpired(state: { claims: Claim[] }): void {
        const now = new Date();
        const expired = state.claims.filter(c => new Date(c.expires_at) <= now);
        state.claims = state.claims.filter(c => new Date(c.expires_at) > now);
        for (const c of expired) {
            this.appendEvent({ type: 'expired', agent: c.agent, paths: c.paths, message: c.note });
        }
    }

    private buildAgentPresence(
        agent: 'claude' | 'codex',
        events: BoardEvent[],
        lastSessionStart: string | null,
        lastSessionEnd: string | null,
        isSessionActive: boolean,
    ): AgentPresence {
        const latest = [...events].reverse().find(event => event.agent === agent);
        const latestInSession = isSessionActive && lastSessionStart
            ? [...events].reverse().find(event => event.agent === agent && new Date(event.timestamp) >= new Date(lastSessionStart))
            : null;

        if (isSessionActive) {
            if (!latestInSession) {
                return { agent, status: 'idle', last_event_at: null, last_event_type: null };
            }

            const ageMs = Date.now() - new Date(latestInSession.timestamp).getTime();
            return {
                agent,
                status: ageMs <= 120_000 ? 'active' : 'idle',
                last_event_at: latestInSession.timestamp,
                last_event_type: latestInSession.type,
            };
        }

        if (!latest) {
            return { agent, status: 'stopped', last_event_at: null, last_event_type: null };
        }

        if (lastSessionEnd && new Date(latest.timestamp) <= new Date(lastSessionEnd)) {
            return {
                agent,
                status: 'stopped',
                last_event_at: latest.timestamp,
                last_event_type: latest.type,
            };
        }

        const ageMs = Date.now() - new Date(latest.timestamp).getTime();
        const status = ageMs <= 120_000 ? 'active' : 'idle';
        return {
            agent,
            status,
            last_event_at: latest.timestamp,
            last_event_type: latest.type,
        };
    }

    private writeFileAtomic(targetPath: string, content: string): void {
        const tempPath = path.join(
            path.dirname(targetPath),
            `${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
        );
        fs.writeFileSync(tempPath, content, 'utf8');
        fs.renameSync(tempPath, targetPath);
    }

    private sleepSync(ms: number): void {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
            return;
        } catch {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                // Busy-wait fallback for environments where Atomics.wait is unavailable.
            }
        }
    }
}

function arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
