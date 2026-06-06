#!/usr/bin/env node
//
// Forge Relay Claude Mode B bridge (plan Part 2.2 / Phase P4).
//
// Runs a headless Claude Code session in streaming-JSON mode, reusing the
// user's existing Claude Code auth. It tails the Forge Relay board and, when a
// triggering event appears, injects it as the next user turn on Claude's
// stdin. Claude responds using the Forge Relay MCP tools, which are attached via
// --mcp-config. This is the zero-nudge analog to the Codex app-server bridge.
//
// Status is reported to the supervising extension via `[[AW_STATUS]]` lines.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { teeToLogFile } = require('./bridgeLog');

// Windows-safe CLI launcher. `claude` is a .cmd shim that Node cannot spawn
// directly with shell:false. On win32 go through the shell; elsewhere keep the
// no-shell array spawn.
function winQuote(arg) {
    const s = String(arg);
    if (s === '') { return '""'; }
    if (!/[\s"&|<>^()%]/.test(s)) { return s; }
    return '"' + s.replace(/"/g, '""') + '"';
}
function spawnCli(bin, args, opts) {
    if (process.platform === 'win32') {
        const cmdline = [bin, ...args].map(winQuote).join(' ');
        return spawn(cmdline, { ...opts, shell: true });
    }
    return spawn(bin, args, { ...opts, shell: false });
}

function parseArgs(argv) {
    const args = {
        agent: 'claude',
        repoRoot: process.cwd(),
        eventPath: '',
        mcpUrl: 'http://127.0.0.1:7878/sse',
        mode: 'all',
        idleMs: 500,
        cooldownMs: 1000,
        permissionMode: 'acceptEdits',
        model: '',
        claudeBin: 'claude',
        debugKeepAliveMs: 0,
        debugKeepAliveLogPayloads: false,
        telemetryPath: '',
        telemetry: true,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        const value = argv[i + 1];
        switch (key) {
            case '--agent': args.agent = value; i += 1; break;
            case '--repo-root': args.repoRoot = value; i += 1; break;
            case '--event-path': args.eventPath = value; i += 1; break;
            case '--mcp-url': args.mcpUrl = value; i += 1; break;
            case '--mode': args.mode = value; i += 1; break;
            case '--idle-ms': args.idleMs = Number(value); i += 1; break;
            case '--cooldown-ms': args.cooldownMs = Number(value); i += 1; break;
            case '--permission-mode': args.permissionMode = value; i += 1; break;
            case '--model': args.model = value; i += 1; break;
            case '--claude-bin': args.claudeBin = value; i += 1; break;
            case '--debug-keep-alive-ms': args.debugKeepAliveMs = Number(value); i += 1; break;
            case '--debug-keep-alive-log-payloads': args.debugKeepAliveLogPayloads = value !== 'false'; i += 1; break;
            case '--telemetry-path': args.telemetryPath = value; i += 1; break;
            case '--telemetry': args.telemetry = value !== 'false'; i += 1; break;
            default: throw new Error(`Unknown argument: ${key}`);
        }
    }
    args.repoRoot = path.resolve(args.repoRoot);
    args.eventPath = args.eventPath
        ? path.resolve(args.eventPath)
        : path.join(args.repoRoot, '.coordination', 'events.ndjson');
    args.telemetryPath = args.telemetryPath
        ? path.resolve(args.telemetryPath)
        : path.join(args.repoRoot, '.coordination', 'claude-telemetry.ndjson');
    return args;
}

function emitStatus(token) {
    process.stdout.write(`[[AW_STATUS]] ${token}\n`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeEvent(event) {
    const parts = [];
    if (event.timestamp) { parts.push(event.timestamp); }
    if (event.type) { parts.push(`[${event.type}]`); }
    if (event.agent) { parts.push(event.agent); }
    if (event.message) { parts.push(event.message); }
    return parts.join(' ').trim();
}

function shouldTrigger(event, agent, mode) {
    if (!event || typeof event !== 'object') { return false; }
    if (event.agent && String(event.agent).toLowerCase() === agent) { return false; }
    if (event.type === 'post' && /SESSION_(START|END)/.test(event.message || '')) {
        return false;
    }

    if (event.type === 'command') {
        const target = String((event.meta && event.meta.target_agent) || event.target || '').toLowerCase();
        return target === 'all' || target === agent;
    }
    if (event.type !== 'post') { return false; }
    if (mode === 'all') { return true; }

    const poster = String(event.agent || '').toLowerCase();
    const isOrchestrator = poster === 'claude' || poster === 'codex';
    const isWorker = poster.startsWith('worker:');
    if (!isOrchestrator && !isWorker) { return true; }
    const haystack = [event.message, event.note, event.text].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(agent);
}

function buildUserMessage(event, agent) {
    const text = [
        '[AW_TURN_TYPE: board-event]',
        `A new Forge Relay board event may require action from ${agent}.`,
        'Review it and decide whether a board reply, claim, or command acknowledgement is needed.',
        'Use the Forge Relay MCP tools (post, claim, release, board_check, get_status, ack_command, resolve_command, dispatch_subagent, list_models) to respond.',
        'For worker routing, prefer a plain Forge-exposed model name in normal use; explicit forge:/bridge:/ollama:/direct: prefixes are override/debug paths.',
        'If no action is needed, reply briefly that you are standing by. Claim files before editing.',
        '',
        `Event summary: ${summarizeEvent(event)}`,
        `Raw event JSON: ${JSON.stringify(event)}`,
    ].join('\n');
    return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function buildKeepAliveMessage() {
    const text = [
        '[AW_TURN_TYPE: keep-alive]',
        'This is a cache keep-alive maintenance turn.',
        'Do not use tools.',
        'Do not post to the board.',
        'Do not inspect or edit files.',
        'Do not emit natural-language prose.',
        'If the CLI requires a reply, emit only the inert marker [AW_KEEPALIVE_OK].',
    ].join('\n');
    return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

const SYSTEM_PROMPT = [
    "You are the 'claude' participant on the Forge Relay multi-agent coordination board.",
    'Each user message is either a board-event turn or a keep-alive turn.',
    'For [AW_TURN_TYPE: board-event], act only when action is genuinely needed.',
    'For [AW_TURN_TYPE: keep-alive], do nothing: no tools, no board traffic, no file inspection, no prose, and only [AW_KEEPALIVE_OK] if the CLI requires output.',
    'Always coordinate through the Forge Relay MCP tools: claim files before editing, post progress',
    'and handoffs, and acknowledge STOP/PAUSE commands. Keep board posts to one concise ASCII line.',
    'When dispatching workers, prefer a plain Forge-exposed model name in normal use; local models resolve through Forge control and provider-backed models resolve through the Forge bridge.',
    'Use explicit forge:/bridge:/ollama:/direct: model prefixes only when you intentionally need an override or debugging path.',
    'Continue handling events until you receive a SESSION_END post.',
].join(' ');

const ALLOWED_TOOLS = [
    'mcp__forgerelay__board_check',
    'mcp__forgerelay__get_status',
    'mcp__forgerelay__post',
    'mcp__forgerelay__claim',
    'mcp__forgerelay__release',
    'mcp__forgerelay__ack_command',
    'mcp__forgerelay__resolve_command',
    'mcp__forgerelay__dispatch_subagent',
    'mcp__forgerelay__list_models',
    'Read',
    'Edit',
    'Grep',
    'Glob',
].join(' ');

function collectToolNames(value, out) {
    if (!value || typeof value !== 'object') { return; }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectToolNames(item, out);
        }
        return;
    }
    if (typeof value.name === 'string' && /tool/i.test(String(value.type || ''))) {
        out.push(value.name);
    }
    for (const child of Object.values(value)) {
        collectToolNames(child, out);
    }
}

// Flatten a Claude CLI stream-json `result` message into a telemetry row. The
// Claude Code headless runtime reports per-turn token + cost on the final
// `result` event; `cache_read_input_tokens` vs `cache_creation_input_tokens` is
// the exact observable the keep-alive cache-benefit check needs (warm cache =>
// high cache_read, near-zero cache_creation). Defensive: any field the runtime
// omits is recorded as null rather than crashing the bridge.
function extractTelemetry(msg, meta) {
    const usage = (msg && typeof msg.usage === 'object' && msg.usage) || {};
    const num = (v) => (typeof v === 'number' ? v : null);
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    return {
        ts: new Date().toISOString(),
        agent: (meta && meta.agent) || 'claude',
        turn: (meta && meta.turn) ?? null,
        kind: (meta && meta.kind) || 'board-event',
        trigger: (meta && meta.trigger) || '',
        subtype: (msg && msg.subtype) ?? null,
        is_error: (msg && msg.is_error) ?? null,
        num_turns: num(msg && msg.num_turns),
        duration_ms: num(msg && msg.duration_ms),
        duration_api_ms: num(msg && msg.duration_api_ms),
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        // Total context billed into this turn (fresh + cache-write + cache-read).
        billed_input_tokens: [input, cacheWrite, cacheRead].some((v) => v !== null)
            ? (input || 0) + (cacheWrite || 0) + (cacheRead || 0)
            : null,
        total_cost_usd: num(msg && msg.total_cost_usd),
        session_id: (msg && msg.session_id) ?? null,
    };
}

function appendTelemetry(filePath, record) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
        process.stderr.write(`telemetry write failed: ${error.message}\n`);
    }
}

class ClaudeBridge {
    constructor(options) {
        this.options = options;
        this.child = null;
        this.queue = [];
        this.processing = false;
        this.lastSize = 0;
        this.lastTriggerAt = 0;
        this.lastActivityAt = 0;
        this.hasSeenRealTurn = false;
        this.linked = false;
        this.currentTurn = null;
        this.turnCount = 0;
    }

    start() {
        this.lastActivityAt = Date.now();
        this.#spawnClaude();
        this.#primeCursor();
        this.#watchLoop();
    }

    #spawnClaude() {
        const mcpConfig = JSON.stringify({
            mcpServers: { forgerelay: { type: 'sse', url: this.options.mcpUrl } },
        });
        const mcpConfigPath = path.join(os.tmpdir(), `forgerelay-mcp-${process.pid}.json`);
        try { fs.writeFileSync(mcpConfigPath, mcpConfig, 'utf8'); } catch { /* fall back to inline below */ }
        const mcpArg = fs.existsSync(mcpConfigPath) ? mcpConfigPath : mcpConfig;

        const cliArgs = [
            '--print',
            '--verbose',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--mcp-config', mcpArg,
            '--permission-mode', this.options.permissionMode,
            '--allowedTools', ALLOWED_TOOLS,
            '--append-system-prompt', SYSTEM_PROMPT,
        ];
        if (this.options.model) {
            cliArgs.push('--model', this.options.model);
        }

        process.stdout.write(`starting headless claude (${this.options.claudeBin})\n`);
        this.child = spawnCli(this.options.claudeBin, cliArgs, {
            cwd: this.options.repoRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.child.on('error', (error) => {
            emitStatus('unsupported');
            process.stderr.write(`claude CLI could not be launched: ${error.message}\n`);
            process.exit(127);
        });
        this.child.on('exit', (code, signal) => {
            process.stderr.write(`claude exited code=${code} signal=${signal}\n`);
            process.exit(code || 1);
        });

        let buffer = '';
        this.child.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) { this.#handleClaudeLine(line); }
            }
        });
        this.child.stderr.on('data', (chunk) => process.stderr.write(`[claude] ${chunk}`));
    }

    #handleClaudeLine(line) {
        if (!this.linked) {
            this.linked = true;
            emitStatus('linked');
        }
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        this.#logKeepAlivePayload(msg);

        if (msg.type === 'result') {
            if (typeof msg.result === 'string' && msg.result.trim()) {
                process.stdout.write(`claude result: ${msg.result.trim()}\n`);
            }
            if (this.currentTurn && this.currentTurn.kind === 'keep-alive') {
                process.stdout.write(`claude keep-alive result payload: ${JSON.stringify(msg)}\n`);
            }
            this.#recordTelemetry(msg);
            this.processing = false;
            this.currentTurn = null;
            this.lastActivityAt = Date.now();
        }
    }

    #primeCursor() {
        try {
            if (fs.existsSync(this.options.eventPath)) {
                this.lastSize = fs.statSync(this.options.eventPath).size;
            }
        } catch (error) {
            process.stderr.write(`failed to prime event cursor: ${error.message}\n`);
        }
    }

    async #watchLoop() {
        for (;;) {
            try {
                this.#scanEvents();
                this.#maybeQueueDebugKeepAlive();
                this.#flushQueue();
            } catch (error) {
                process.stderr.write(`watch loop error: ${error.message}\n`);
            }
            await sleep(this.options.idleMs);
        }
    }

    #scanEvents() {
        if (!fs.existsSync(this.options.eventPath)) { return; }
        const stat = fs.statSync(this.options.eventPath);
        if (stat.size < this.lastSize) { this.lastSize = stat.size; return; }
        if (stat.size === this.lastSize) { return; }

        const fd = fs.openSync(this.options.eventPath, 'r');
        try {
            const length = stat.size - this.lastSize;
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, this.lastSize);
            this.lastSize = stat.size;
            for (const raw of buffer.toString('utf8').split('\n')) {
                const trimmed = raw.trim();
                if (!trimmed) { continue; }
                let event;
                try { event = JSON.parse(trimmed); } catch { continue; }
                if (shouldTrigger(event, this.options.agent, this.options.mode)) {
                    this.queue.push({ kind: 'board-event', event });
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    #maybeQueueDebugKeepAlive() {
        if (!this.options.debugKeepAliveMs || this.options.debugKeepAliveMs <= 0) { return; }
        if (!this.hasSeenRealTurn || this.processing) { return; }
        if (this.queue.some((item) => item.kind === 'keep-alive')) { return; }
        if (Date.now() - this.lastActivityAt < this.options.debugKeepAliveMs) { return; }
        this.queue.push({ kind: 'keep-alive', reason: 'debug-idle-threshold' });
        this.lastActivityAt = Date.now();
        process.stdout.write(`queued debug keep-alive after ${this.options.debugKeepAliveMs}ms idle\n`);
    }

    #flushQueue() {
        if (this.processing || this.queue.length === 0) { return; }
        if (Date.now() - this.lastTriggerAt < this.options.cooldownMs) { return; }
        if (!this.child || !this.child.stdin.writable) { return; }

        const turn = this.queue.shift();
        this.processing = true;
        this.lastTriggerAt = Date.now();
        this.currentTurn = turn;
        try {
            if (turn.kind === 'keep-alive') {
                process.stdout.write('forwarding debug keep-alive turn to claude\n');
                this.child.stdin.write(JSON.stringify(buildKeepAliveMessage()) + '\n');
            } else {
                this.hasSeenRealTurn = true;
                process.stdout.write(`forwarding event to claude: ${summarizeEvent(turn.event)}\n`);
                this.child.stdin.write(JSON.stringify(buildUserMessage(turn.event, this.options.agent)) + '\n');
            }
            this.lastActivityAt = Date.now();
        } catch (error) {
            process.stderr.write(`failed to send turn to claude: ${error.message}\n`);
            this.processing = false;
            this.currentTurn = null;
        }
    }

    #logKeepAlivePayload(msg) {
        if (!this.currentTurn || this.currentTurn.kind !== 'keep-alive' || !this.options.debugKeepAliveLogPayloads) {
            return;
        }
        const tools = [];
        collectToolNames(msg, tools);
        if (tools.length > 0) {
            process.stdout.write(`claude keep-alive tool activity: ${tools.join(', ')}\n`);
        }
        process.stdout.write(`claude keep-alive stream payload: ${JSON.stringify(msg)}\n`);
    }

    #recordTelemetry(msg) {
        if (!this.options.telemetry) { return; }
        this.turnCount += 1;
        const turn = this.currentTurn;
        const meta = {
            agent: this.options.agent,
            turn: this.turnCount,
            kind: (turn && turn.kind) || 'board-event',
            trigger: turn
                ? (turn.kind === 'keep-alive' ? (turn.reason || 'keep-alive') : summarizeEvent(turn.event))
                : '',
        };
        const record = extractTelemetry(msg, meta);
        appendTelemetry(this.options.telemetryPath, record);
        // Compact human-readable line lands in claude-bridge.log too.
        const cost = record.total_cost_usd !== null ? `$${record.total_cost_usd.toFixed(4)}` : 'n/a';
        process.stdout.write(
            `claude telemetry [#${record.turn} ${record.kind}]: ` +
            `in=${record.input_tokens ?? '?'} out=${record.output_tokens ?? '?'} ` +
            `cache_read=${record.cache_read_input_tokens ?? '?'} cache_write=${record.cache_creation_input_tokens ?? '?'} ` +
            `billed_in=${record.billed_input_tokens ?? '?'} cost=${cost}\n`,
        );
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    teeToLogFile(options.eventPath, 'claude-bridge.log', 'claude');
    emitStatus('waiting');
    const bridge = new ClaudeBridge(options);

    const stop = () => { try { bridge.child && bridge.child.kill(); } catch { /* ignore */ } };
    process.on('SIGINT', () => { stop(); process.exit(130); });
    process.on('SIGTERM', () => { stop(); process.exit(143); });

    bridge.start();
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exit(1);
    });
} else {
    module.exports = { parseArgs, shouldTrigger, buildUserMessage, buildKeepAliveMessage, summarizeEvent, collectToolNames, extractTelemetry };
}
