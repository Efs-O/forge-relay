#!/usr/bin/env node
//
// AgentWatch Claude Mode B bridge (plan Part 2.2 / Phase P4).
//
// Runs a *headless* Claude Code session in streaming-JSON mode, reusing the
// user's existing Claude Code auth (no separate API key — Decision #1). It tails
// the AgentWatch board and, when a triggering event appears, injects it as the
// next user turn on Claude's stdin. Claude responds using the AgentWatch MCP
// tools (post/claim/etc.), which are attached via --mcp-config. This is the true
// zero-nudge analog to the Codex app-server bridge.
//
// Status is reported to the supervising extension via `[[AW_STATUS]]` lines.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Windows-safe CLI launcher — `claude` is a .cmd shim that Node cannot spawn
// directly with shell:false. On win32 go through the shell (cmd.exe resolves the
// .cmd via PATHEXT) with manual quoting; elsewhere keep the no-shell array spawn.
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
            default: throw new Error(`Unknown argument: ${key}`);
        }
    }
    args.repoRoot = path.resolve(args.repoRoot);
    args.eventPath = args.eventPath
        ? path.resolve(args.eventPath)
        : path.join(args.repoRoot, '.coordination', 'events.ndjson');
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
    // Never react to our own posts (avoids self-loops).
    if (event.agent && String(event.agent).toLowerCase() === agent) { return false; }
    // Never react to session markers — they are lifecycle, not work.
    if (event.type === 'post' && /SESSION_(START|END)/.test(event.message || '')) {
        return false;
    }

    if (event.type === 'command') {
        const target = String((event.meta && event.meta.target_agent) || event.target || '').toLowerCase();
        return target === 'all' || target === agent;
    }
    if (event.type !== 'post') { return false; }
    if (mode === 'all') { return true; }

    // Orchestrator default: react to the human operator (identified by exclusion
    // — anyone who is not another orchestrator or a worker, since the board lets
    // them pick any name) and to posts that mention us. Peer orchestrator posts
    // are ignored unless they mention us, avoiding a Claude<->Codex ping-pong.
    const poster = String(event.agent || '').toLowerCase();
    const isOrchestrator = poster === 'claude' || poster === 'codex';
    const isWorker = poster.startsWith('worker:');
    if (!isOrchestrator && !isWorker) { return true; }
    const haystack = [event.message, event.note, event.text].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(agent);
}

function buildUserMessage(event, agent) {
    const text = [
        `A new AgentWatch board event may require action from ${agent}.`,
        'Review it and decide whether a board reply, claim, or command acknowledgement is needed.',
        'Use the AgentWatch MCP tools (post, claim, release, board_check, get_status, ack_command, resolve_command) to respond.',
        'If no action is needed, reply briefly that you are standing by. Claim files before editing.',
        '',
        `Event summary: ${summarizeEvent(event)}`,
        `Raw event JSON: ${JSON.stringify(event)}`,
    ].join('\n');
    return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

const SYSTEM_PROMPT = [
    "You are the 'claude' participant on the AgentWatch multi-agent coordination board.",
    'Each user message delivers one board event. Act only when action is genuinely needed.',
    'Always coordinate through the AgentWatch MCP tools: claim files before editing, post progress',
    'and handoffs, and acknowledge STOP/PAUSE commands. Keep board posts to one concise ASCII line.',
    'Continue handling events until you receive a SESSION_END post.',
].join(' ');

const ALLOWED_TOOLS = [
    'mcp__agentwatch__board_check',
    'mcp__agentwatch__get_status',
    'mcp__agentwatch__post',
    'mcp__agentwatch__claim',
    'mcp__agentwatch__release',
    'mcp__agentwatch__ack_command',
    'mcp__agentwatch__resolve_command',
    'mcp__agentwatch__dispatch_subagent',
    'mcp__agentwatch__list_models',
    'Read',
    'Edit',
    'Grep',
    'Glob',
].join(' ');

class ClaudeBridge {
    constructor(options) {
        this.options = options;
        this.child = null;
        this.queue = [];
        this.processing = false;
        this.lastSize = 0;
        this.lastTriggerAt = 0;
        this.linked = false;
    }

    start() {
        this.#spawnClaude();
        this.#primeCursor();
        this.#watchLoop();
    }

    #spawnClaude() {
        // Write the MCP config to a temp file rather than passing inline JSON —
        // inline JSON through a Windows shell is a quoting minefield; a file path
        // is robust on every platform. claude --mcp-config accepts a file path.
        const mcpConfig = JSON.stringify({
            mcpServers: { agentwatch: { type: 'sse', url: this.options.mcpUrl } },
        });
        const mcpConfigPath = path.join(os.tmpdir(), `agentwatch-mcp-${process.pid}.json`);
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
            // The first structured line means the session is up and initialized.
            this.linked = true;
            emitStatus('linked');
        }
        let msg;
        try { msg = JSON.parse(line); } catch { return; }

        if (msg.type === 'result') {
            // Turn finished — free the queue for the next event.
            if (typeof msg.result === 'string' && msg.result.trim()) {
                process.stdout.write(`claude result: ${msg.result.trim()}\n`);
            }
            this.processing = false;
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
        if (stat.size < this.lastSize) { this.lastSize = stat.size; return; } // rotated/truncated
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
                    this.queue.push(event);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    #flushQueue() {
        if (this.processing || this.queue.length === 0) { return; }
        if (Date.now() - this.lastTriggerAt < this.options.cooldownMs) { return; }
        if (!this.child || !this.child.stdin.writable) { return; }

        const event = this.queue.shift();
        this.processing = true;
        this.lastTriggerAt = Date.now();
        process.stdout.write(`forwarding event to claude: ${summarizeEvent(event)}\n`);
        try {
            this.child.stdin.write(JSON.stringify(buildUserMessage(event, this.options.agent)) + '\n');
        } catch (error) {
            process.stderr.write(`failed to send turn to claude: ${error.message}\n`);
            this.processing = false;
        }
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
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
    // Exported for unit tests.
    module.exports = { parseArgs, shouldTrigger, buildUserMessage, summarizeEvent };
}
