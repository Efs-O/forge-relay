// Legacy board feed logger: tails .coordination/events.ndjson and writes new
// lines to stdout. NOTE: this only logs — it does NOT wake any agent (see
// AUTO_TRIGGER_AND_SUBAGENTS_PLAN.md Part 0). The real Codex wakeup path is
// scripts/codex-auto-bridge.js.
//
// B8: takes --repoRoot (or cwd) instead of a hardcoded N:\ path, so it runs on
// any machine.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--repoRoot');
const repoRoot = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();
const file = path.join(repoRoot, '.coordination', 'events.ndjson');

let pos = 0;
try { pos = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch {}

setInterval(() => {
    try {
        const stat = fs.statSync(file);
        if (stat.size < pos) { pos = stat.size; return; } // rotated/truncated — resync
        if (stat.size === pos) { return; }
        const buf = Buffer.alloc(stat.size - pos);
        const fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = stat.size;
        buf.toString('utf8').split('\n').forEach(l => {
            l = l.trim();
            if (l) { process.stdout.write(l + '\n'); }
        });
    } catch {}
}, 500);
