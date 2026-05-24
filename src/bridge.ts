import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Claim, Command, BoardEvent, BoardState, Acknowledgement } from './types';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const EVENTS_MAX = 200;

export class Bridge {
    private readonly coordDir: string;
    private readonly claimsPath: string;
    private readonly eventsPath: string;
    private readonly commandsPath: string;
    private readonly lockPath: string;
    private readonly repoRoot: string;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
        this.coordDir = path.join(repoRoot, '.coordination');
        this.claimsPath = path.join(this.coordDir, 'claims.json');
        this.eventsPath = path.join(this.coordDir, 'events.ndjson');
        this.commandsPath = path.join(this.coordDir, 'commands.json');
        this.lockPath = path.join(this.coordDir, 'bridge.lock');
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
            cmd.status = cmd.target_agent === 'all' ? 'open' : 'acknowledged';
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

    clearExpired(): void {
        this.withLock(() => {
            const state = this.readClaims();
            this.pruneExpired(state);
            this.writeClaims(state);
        });
    }

    getState(): BoardState {
        this.clearExpired();
        const claims = this.readClaims().claims;
        const commands = this.readCommands().commands;
        const events = this.readEvents(EVENTS_MAX);
        return { generated_at: new Date().toISOString(), claims, commands, events };
    }

    getEventsPath(): string {
        return this.eventsPath;
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
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
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
        fs.writeFileSync(this.claimsPath, JSON.stringify(state, null, 2), 'utf8');
    }

    private readCommands(): { commands: Command[] } {
        try {
            const raw = fs.readFileSync(this.commandsPath, 'utf8').trim();
            return raw ? JSON.parse(raw) : { commands: [] };
        } catch { return { commands: [] }; }
    }

    private writeCommands(state: { commands: Command[] }): void {
        fs.writeFileSync(this.commandsPath, JSON.stringify(state, null, 2), 'utf8');
    }

    private appendEvent(event: Omit<BoardEvent, 'timestamp'>): void {
        const entry: BoardEvent = { timestamp: new Date().toISOString(), ...event };
        fs.appendFileSync(this.eventsPath, JSON.stringify(entry) + '\n', 'utf8');
    }

    private readEvents(limit: number): BoardEvent[] {
        try {
            const lines = fs.readFileSync(this.eventsPath, 'utf8')
                .split('\n')
                .filter(l => l.trim());
            return lines.slice(-limit).map(l => JSON.parse(l) as BoardEvent);
        } catch { return []; }
    }

    private pruneExpired(state: { claims: Claim[] }): void {
        const now = new Date();
        const expired = state.claims.filter(c => new Date(c.expires_at) <= now);
        state.claims = state.claims.filter(c => new Date(c.expires_at) > now);
        for (const c of expired) {
            this.appendEvent({ type: 'expired', agent: c.agent, paths: c.paths, message: c.note });
        }
    }
}

function arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
