const fs = require('node:fs');
const path = require('node:path');

function teeToLogFile(eventPath, logName, agentLabel) {
    try {
        const logPath = path.join(path.dirname(eventPath), logName);
        const stream = fs.createWriteStream(logPath, { flags: 'a' });
        stream.write(`\n==== ${agentLabel} bridge start ${new Date().toISOString()} (pid ${process.pid}) ====\n`);
        for (const name of ['stdout', 'stderr']) {
            const orig = process[name].write.bind(process[name]);
            let buf = '';
            process[name].write = (...args) => {
                try {
                    buf += String(args[0]);
                    let nl;
                    while ((nl = buf.indexOf('\n')) !== -1) {
                        stream.write(`[${new Date().toISOString()}] ${buf.slice(0, nl)}\n`);
                        buf = buf.slice(nl + 1);
                    }
                } catch {
                    // Never let best-effort logging break the bridge.
                }
                return orig(...args);
            };
        }
    } catch (err) {
        process.stderr.write(`failed to set up ${agentLabel} bridge file log: ${err && err.message}\n`);
    }
}

module.exports = { teeToLogFile };
