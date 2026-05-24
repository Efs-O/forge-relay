const fs = require('fs');
const path = 'N:\\vs code apps\\Agentwatch\\.coordination\\events.ndjson';

let pos = 0;
try { pos = fs.existsSync(path) ? fs.statSync(path).size : 0; } catch {}

setInterval(() => {
    try {
        const stat = fs.statSync(path);
        if (stat.size <= pos) { return; }
        const buf = Buffer.alloc(stat.size - pos);
        const fd = fs.openSync(path, 'r');
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = stat.size;
        buf.toString('utf8').split('\n').forEach(l => {
            l = l.trim();
            if (l) { process.stdout.write(l + '\n'); }
        });
    } catch {}
}, 500);
