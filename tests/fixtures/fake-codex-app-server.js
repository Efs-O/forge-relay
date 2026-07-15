'use strict';

const readline = require('readline');

const holdTimer = process.env.FAKE_CODEX_HOLD_OPEN === '1'
    ? setInterval(() => {}, 1_000)
    : null;

function send(message, splitAt) {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
    if (splitAt && splitAt > 0 && splitAt < bytes.length) {
        process.stdout.write(bytes.subarray(0, splitAt));
        setTimeout(() => process.stdout.write(bytes.subarray(splitAt)), 5);
        return;
    }
    process.stdout.write(bytes);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (message.method === 'test/echo') {
        const delay = Number(message.params?.delayMs || 0);
        setTimeout(() => send({ id: message.id, result: message.params?.value }), delay);
        return;
    }
    if (message.method === 'test/partial') {
        const response = { id: message.id, result: { text: 'split 🚀 payload' } };
        const bytes = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
        const rocket = bytes.indexOf(Buffer.from('🚀'));
        send(response, rocket + 1);
        return;
    }
    if (message.method === 'test/notification') {
        send({ method: 'test/progress', params: { value: 7 } }, 8);
        setTimeout(() => send({ id: message.id, result: {} }), 10);
        return;
    }
    if (message.method === 'test/serverRequest') {
        send({ id: 'server-1', method: 'item/tool/requestUserInput', params: { unsafe: false } });
        send({ id: message.id, result: {} });
        return;
    }
    if (message.id === 'server-1') {
        send({ method: 'test/serverResponse', params: message });
        return;
    }
    if (message.method === 'test/error') {
        send({ id: message.id, error: { code: 451, message: 'synthetic failure', data: { safe: true } } });
        return;
    }
    if (message.method === 'test/malformed') {
        process.stdout.write('{not json}\n');
        send({ id: message.id, result: { recovered: true } });
        return;
    }
    if (message.method === 'test/oversized') {
        process.stdout.write(`${'x'.repeat(512)}\n`);
        send({ id: message.id, result: { recovered: true } });
        return;
    }
    if (message.method === 'test/stderr') {
        process.stderr.write('x'.repeat(Number(message.params?.bytes || 0)));
        send({ id: message.id, result: {} });
        return;
    }
    if (message.method === 'test/hang') {
        return;
    }
    if (message.method === 'test/exit') {
        setTimeout(() => process.exit(23), 5);
        return;
    }
    if (message.id !== undefined) {
        send({ id: message.id, result: {} });
    }
});

rl.on('close', () => {
    if (!holdTimer) { process.exit(0); }
});
