#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// #9: find PIDs LISTENING on a TCP port (so we can reap a stale codex app-server
// that an abrupt extension-host crash left holding our ws port — the clean-stop
// tree-kill in ScriptRuntimeBridge only runs on a graceful stop).
function findListenerPids(port) {
    const pids = new Set();
    try {
        if (process.platform === 'win32') {
            const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
            for (const line of out.split('\n')) {
                if (!/LISTENING/i.test(line)) { continue; }
                const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
                if (m && Number(m[1]) === port) { pids.add(Number(m[2])); }
            }
        } else {
            const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
            for (const tok of out.split(/\s+/)) {
                if (tok.trim()) { pids.add(Number(tok.trim())); }
            }
        }
    } catch {
        // best effort — if the probe tool isn't available we just skip reaping
    }
    return [...pids].filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
}

function killPid(pid) {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch {
        // ignore — the holder may have already exited
    }
}

// Kill any stale process still LISTENING on our ws port before we spawn a fresh
// app-server, so a crash-orphaned codex can't make the new bridge bind-fail or
// attach to a degraded server.
function reapStalePort(port) {
    const pids = findListenerPids(port);
    for (const pid of pids) {
        process.stderr.write(`[agentwatch] reaping stale process ${pid} holding ws port ${port}\n`);
        killPid(pid);
    }
    return pids.length;
}

// Windows-safe CLI launcher. `codex`/`claude` are installed as .cmd shims, which
// Node's spawn cannot execute directly with shell:false. On win32 we go through
// the shell (cmd.exe resolves the .cmd via PATHEXT) with manual quoting; other
// platforms keep the safe no-shell array spawn.
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
        agent: 'codex',
        approvalPolicy: 'never',
        cooldownMs: 1000,
        eventPath: '',
        host: '127.0.0.1',
        idleMs: 500,
        mode: 'mentions',
        port: 8781,
        repoRoot: process.cwd(),
        sandbox: 'danger-full-access',
        turnTimeoutMs: 120000,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        const value = argv[i + 1];
        switch (key) {
            case '--agent':
                args.agent = value;
                i += 1;
                break;
            case '--approval-policy':
                args.approvalPolicy = value;
                i += 1;
                break;
            case '--cooldown-ms':
                args.cooldownMs = Number(value);
                i += 1;
                break;
            case '--event-path':
                args.eventPath = value;
                i += 1;
                break;
            case '--host':
                args.host = value;
                i += 1;
                break;
            case '--idle-ms':
                args.idleMs = Number(value);
                i += 1;
                break;
            case '--mode':
                args.mode = value;
                i += 1;
                break;
            case '--port':
                args.port = Number(value);
                i += 1;
                break;
            case '--repo-root':
                args.repoRoot = value;
                i += 1;
                break;
            case '--sandbox':
                args.sandbox = value;
                i += 1;
                break;
            default:
                throw new Error(`Unknown argument: ${key}`);
        }
    }

    args.repoRoot = path.resolve(args.repoRoot);
    args.eventPath = args.eventPath
        ? path.resolve(args.eventPath)
        : path.join(args.repoRoot, '.coordination', 'events.ndjson');
    return args;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Emit a machine-readable status line the AgentWatch supervisor parses to drive
// the per-agent status dot (see src/runtimeBridge.ts).
function emitStatus(token) {
    process.stdout.write(`[[AW_STATUS]] ${token}\n`);
}

function summarizeEvent(event) {
    const parts = [];
    if (event.timestamp) {
        parts.push(event.timestamp);
    }
    if (event.type) {
        parts.push(`[${event.type}]`);
    }
    if (event.agent) {
        parts.push(event.agent);
    }
    // AgentWatch BoardEvent stores the body in `message`; older/alt shapes used note/command.
    if (event.message) {
        parts.push(event.message);
    } else if (event.note) {
        parts.push(event.note);
    } else if (event.command) {
        parts.push(JSON.stringify(event.command));
    }
    return parts.join(' ').trim();
}

function shouldTrigger(event, agent, mode) {
    if (!event || typeof event !== 'object') {
        return false;
    }
    if (event.agent && String(event.agent).toLowerCase() === agent) {
        return false;
    }

    if (event.type === 'command') {
        // Real BoardEvent shape carries the target in meta.target_agent; keep the
        // legacy event.target fallback for safety.
        const target = String((event.meta && event.meta.target_agent) || event.target || '').toLowerCase();
        return target === 'all' || target === agent;
    }

    if (event.type !== 'post') {
        return false;
    }

    // Ignore session lifecycle markers — they are not work.
    if (/SESSION_(START|END)/.test(event.message || '')) {
        return false;
    }

    if (mode === 'all') {
        return true;
    }

    // Orchestrator default: react to the human operator and to any post that
    // mentions us by name. The operator can post under ANY name (the board lets
    // you set it — 'user', initials, etc.), so we identify them by exclusion:
    // anyone who is not another orchestrator (claude/codex) and not a worker is
    // treated as the operator. Peer orchestrator posts are ignored unless they
    // mention us, which avoids a Claude<->Codex ping-pong loop.
    const poster = String(event.agent || '').toLowerCase();
    const isOrchestrator = poster === 'claude' || poster === 'codex';
    const isWorker = poster.startsWith('worker:');
    if (!isOrchestrator && !isWorker) {
        return true;
    }
    const haystack = [event.message, event.note, event.text]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return haystack.includes(agent);
}

function buildTurnInput(event, agent) {
    return [
        {
            type: 'text',
            text: [
                `A new AgentWatch board event may require action from ${agent}.`,
                'Review the event, then decide whether a board reply or command acknowledgement is required.',
                'Use the AgentWatch MCP tools directly if you need to respond.',
                'Do not reply if no action is needed.',
                '',
                `Event summary: ${summarizeEvent(event)}`,
                `Raw event JSON: ${JSON.stringify(event)}`,
            ].join('\n'),
        },
    ];
}

class JsonRpcSocket {
    constructor(url) {
        this.url = url;
        this.pending = new Map();
        this.nextId = 1;
        this.onNotification = null;
        this.onClose = null;
        this.ws = null;
    }

    async connect() {
        const WebSocketCtor = globalThis.WebSocket;
        if (!WebSocketCtor) {
            throw new Error('WebSocket is not available in this Node runtime.');
        }

        await new Promise((resolve, reject) => {
            const ws = new WebSocketCtor(this.url);
            this.ws = ws;
            ws.onopen = () => resolve();
            ws.onerror = (event) => reject(event.error || new Error('WebSocket connection failed.'));
            ws.onmessage = (event) => this.#handleMessage(event.data.toString());
            ws.onclose = () => {
                for (const pending of this.pending.values()) {
                    pending.reject(new Error('WebSocket closed.'));
                }
                this.pending.clear();
                if (this.onClose) { this.onClose(); }
            };
        });
    }

    close() {
        if (this.ws && this.ws.readyState < 2) {
            this.ws.close();
        }
    }

    send(method, params) {
        const id = this.nextId;
        this.nextId += 1;
        const payload = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify(payload));
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    #handleMessage(raw) {
        const message = JSON.parse(raw);

        if (typeof message.id !== 'undefined' && this.pending.has(message.id)) {
            const entry = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) {
                entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
            } else {
                entry.resolve(message.result);
            }
            return;
        }

        if (typeof message.method === 'string' && this.onNotification) {
            this.onNotification(message);
        }
    }
}

class CodexBridge {
    constructor(options) {
        this.options = options;
        this.queue = [];
        this.processing = false;
        this.lastSize = 0;
        this.lastTriggerAt = 0;
        this.threadId = null;
        this.server = null;
        this.rpc = null;
        this.activeTurn = null;
        this.shuttingDown = false;
    }

    async start() {
        // Prime the event cursor BEFORE the (slow) app-server startup so posts
        // made during the few seconds it takes to come up are not skipped — they
        // get picked up by the watch loop once the thread is ready.
        this.#primeCursor();
        await this.#startServer();
        await this.#connectRpc();
        await this.#startThread();
        this.#watchLoop();
    }

    async #startServer() {
        const { host, port } = this.options;
        // #9: reap a crash-orphaned app-server still holding our port, then give
        // the OS a moment to release it before we bind a fresh one.
        if (reapStalePort(port) > 0) {
            await sleep(500);
        }
        process.stdout.write(`starting codex app-server on ws://${host}:${port}\n`);
        this.server = spawnCli('codex', ['app-server', '--listen', `ws://${host}:${port}`], {
            cwd: this.options.repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.server.stdout.on('data', (chunk) => process.stdout.write(`[codex-app] ${chunk}`));
        this.server.stderr.on('data', (chunk) => process.stderr.write(`[codex-app] ${chunk}`));
        this.server.on('error', (error) => {
            // Most commonly ENOENT — the `codex` CLI is not on PATH. Signal the
            // supervisor that this runtime is unsupported instead of crash-looping.
            emitStatus('unsupported');
            process.stderr.write(`codex CLI could not be launched: ${error.message}\n`);
            process.exit(127);
        });
        this.server.on('exit', (code, signal) => {
            process.stderr.write(`codex app-server exited code=${code} signal=${signal}\n`);
            process.exitCode = code || 1;
        });

        await sleep(1000);
    }

    async #connectRpc() {
        this.rpc = new JsonRpcSocket(`ws://${this.options.host}:${this.options.port}`);
        this.rpc.onNotification = (message) => this.#handleNotification(message);
        this.rpc.onClose = () => {
            // If the app-server connection drops unexpectedly, exit so the
            // supervisor restarts a fresh bridge + app-server instead of leaving
            // a zombie that reports "linked" but can no longer send turns.
            if (!this.shuttingDown) {
                process.stderr.write('codex app-server connection closed; exiting for supervisor restart\n');
                process.exit(1);
            }
        };
        let lastError = null;
        for (let attempt = 1; attempt <= 10; attempt += 1) {
            try {
                process.stdout.write(`connecting to codex app-server (attempt ${attempt}/10)\n`);
                await this.rpc.connect();
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                await sleep(500);
            }
        }
        if (lastError) {
            throw lastError;
        }
        await this.rpc.send('initialize', {
            clientInfo: { name: 'agentwatch-codex-bridge', version: '0.1.0' },
        });
        process.stdout.write('codex app-server initialized\n');
    }

    async #startThread() {
        const result = await this.rpc.send('thread/start', {
            approvalPolicy: this.options.approvalPolicy,
            cwd: this.options.repoRoot,
            developerInstructions: [
                'You are running inside the AgentWatch Codex auto bridge.',
                'When an AgentWatch board event arrives, inspect it and decide whether action is required.',
                'Use the AgentWatch MCP tools directly for any reply, acknowledgement, claim, or status check.',
                'Do not post duplicate replies. If no action is needed, stay silent.',
            ].join(' '),
            sandbox: this.options.sandbox,
        });

        this.threadId = result.thread.id;
        process.stdout.write(`codex thread started: ${this.threadId}\n`);
        // The runtime is now fully wired (app-server up, thread open, tailing the
        // board). Tell the supervisor to flip the status dot to "linked".
        emitStatus('linked');
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
                await this.#flushQueue();
            } catch (error) {
                process.stderr.write(`watch loop error: ${error.message}\n`);
            }
            await sleep(this.options.idleMs);
        }
    }

    #scanEvents() {
        if (!fs.existsSync(this.options.eventPath)) {
            return;
        }

        const stat = fs.statSync(this.options.eventPath);
        if (stat.size <= this.lastSize) {
            return;
        }

        const fd = fs.openSync(this.options.eventPath, 'r');
        try {
            const length = stat.size - this.lastSize;
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, this.lastSize);
            this.lastSize = stat.size;

            for (const line of buffer.toString('utf8').split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                let event;
                try {
                    event = JSON.parse(trimmed);
                } catch (error) {
                    process.stderr.write(`skipping invalid event JSON: ${error.message}\n`);
                    continue;
                }
                if (shouldTrigger(event, this.options.agent, this.options.mode)) {
                    this.queue.push(event);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    async #flushQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        if (Date.now() - this.lastTriggerAt < this.options.cooldownMs) {
            return;
        }

        const event = this.queue.shift();
        this.processing = true;
        this.lastTriggerAt = Date.now();
        this.activeTurn = {
            event,
            finalText: '',
            resolve: null,
            reject: null,
        };

        const completion = new Promise((resolve, reject) => {
            this.activeTurn.resolve = resolve;
            this.activeTurn.reject = reject;
        });

        process.stdout.write(`forwarding event to codex: ${summarizeEvent(event)}\n`);

        try {
            await this.rpc.send('turn/start', {
                threadId: this.threadId,
                input: buildTurnInput(event, this.options.agent),
            });
            // Race the turn completion against a timeout so a stalled turn (no
            // turn/completed or turn/failed) can never wedge the bridge forever.
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`turn timed out after ${this.options.turnTimeoutMs}ms`)), this.options.turnTimeoutMs);
            });
            try {
                await Promise.race([completion, timeout]);
            } finally {
                clearTimeout(timer);
            }
        } catch (error) {
            process.stderr.write(`turn start failed: ${error.message}\n`);
        } finally {
            this.activeTurn = null;
            this.processing = false;
        }
    }

    #handleNotification(message) {
        if (!this.activeTurn) {
            return;
        }

        if (message.method === 'item/agentMessage/delta') {
            this.activeTurn.finalText += message.params.delta;
            return;
        }

        if (message.method === 'turn/completed') {
            const finalText = this.activeTurn.finalText.trim();
            if (finalText) {
                process.stdout.write(`codex final answer:\n${finalText}\n`);
            } else {
                process.stdout.write('codex completed turn without final answer text\n');
            }
            this.activeTurn.resolve();
            return;
        }

        if (message.method === 'turn/failed') {
            this.activeTurn.reject(new Error(JSON.stringify(message.params)));
        }
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    emitStatus('waiting');
    const bridge = new CodexBridge(options);

    const stop = () => {
        bridge.shuttingDown = true;
        bridge.rpc?.close();
        bridge.server?.kill();
    };

    process.on('SIGINT', () => {
        stop();
        process.exit(130);
    });
    process.on('SIGTERM', () => {
        stop();
        process.exit(143);
    });

    await bridge.start();
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
});
