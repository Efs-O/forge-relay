'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const timeoutMs = 15_000;
const holdMs = Math.max(0, Math.min(10_000, Number(process.env.FORGERELAY_SMOKE_HOLD_MS) || 0));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-relay-codex-smoke-'));
const codexHome = path.join(tempRoot, 'home');
const sqliteHome = path.join(tempRoot, 'sqlite');
fs.mkdirSync(codexHome);
fs.mkdirSync(sqliteHome);

const env = { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
delete env.CODEX_ACCESS_TOKEN;

function executable() {
    if (process.platform !== 'win32') return 'codex';
    const candidates = execFileSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!candidates.length) throw new Error('No shell-free codex.exe was found on PATH.');
    return candidates[0];
}

const child = spawn(executable(), [
    'app-server', '--listen', 'stdio://',
    '-c', `sqlite_home=${JSON.stringify(sqliteHome)}`,
    '-c', 'cli_auth_credentials_store="file"',
], {
    cwd: process.cwd(), env, shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 1;
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4_096); });
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) {
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(`Protocol error ${message.error.code ?? 'unknown'}.`)) : waiter.resolve(message.result);
    }
});

function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} timed out.`));
        }, timeoutMs);
        pending.set(id, {
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
}

async function main() {
    try {
        const initialized = await request('initialize', {
            clientInfo: { name: 'forge-relay-isolation-smoke', version: '1' },
            capabilities: { experimentalApi: false },
        });
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        const account = await request('account/read', { refreshToken: false });
        if (holdMs) await new Promise(resolve => setTimeout(resolve, holdMs));
        process.stdout.write(`${JSON.stringify({
            ok: true,
            initializeResponded: initialized !== undefined,
            accountReadResponded: account !== undefined,
            requiresOpenAIAuth: account?.requiresOpenaiAuth === true,
            isolatedAccountPresent: Boolean(account?.account),
            isolatedHomePopulated: fs.readdirSync(codexHome).length > 0,
            isolatedSqlitePopulated: fs.readdirSync(sqliteHome).length > 0,
        }, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`Managed Codex live smoke failed: ${error.message}\n`);
        if (stderr) process.stderr.write('The isolated app-server wrote diagnostics to stderr.\n');
        process.exitCode = 1;
    } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGTERM'), 2_000);
        await new Promise(resolve => child.once('close', resolve));
        clearTimeout(timer);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

void main();
