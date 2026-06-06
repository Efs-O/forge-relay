const fs = require('fs');
const path = require('path');
const os = require('os');

// Mirror of RuntimeManager.ensureClaudeMcpConfig (logic under test).
function ensure(repoRoot, mcpStdioPath, log) {
  const configPath = path.join(repoRoot, '.mcp.json');
  const stdioPath = mcpStdioPath.replace(/\\/g, '/');
  const rr = repoRoot.replace(/\\/g, '/');
  const desired = { command: 'node', args: [stdioPath, '--repoRoot', rr] };
  let config = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (raw) {
      try { config = JSON.parse(raw); }
      catch { fs.renameSync(configPath, configPath + '.bak'); log('backed up invalid'); config = {}; }
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  const existing = config.mcpServers.forgerelay;
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) { log('no-op (idempotent)'); return; }
  config.mcpServers.forgerelay = desired;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  log('wrote');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awmcp-'));
const ext = 'C:/ext/Efsoo.forge-relay-0.3.6/out/mcpStdio.js';
const cfg = path.join(dir, '.mcp.json');
const L = t => s => console.log(`[${t}] ${s}`);
let ok = true;
const assert = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) ok = false; };

// 1) fresh (no file)
ensure(dir, ext, L('fresh'));
let c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
assert(c.mcpServers.forgerelay.args[0] === ext, 'fresh write points at current build');

// 2) idempotent (run again -> should no-op)
const before = fs.readFileSync(cfg, 'utf8');
ensure(dir, ext, L('again'));
assert(fs.readFileSync(cfg, 'utf8') === before, 'second run is a no-op (no churn)');

// 3) preserves other servers + repairs a stale forgerelay path
fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {
  other: { command: 'node', args: ['x.js'] },
  forgerelay: { command: 'node', args: ['C:/ext/Efsoo.forge-relay-0.1.0/out/mcpStdio.js', '--repoRoot', dir] }
}}, null, 2));
ensure(dir, ext, L('stale'));
c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
assert(!!c.mcpServers.other, 'unrelated server preserved');
assert(c.mcpServers.forgerelay.args[0].includes('0.3.6'), 'stale 0.1.0 path repaired to current');

// 4) malformed -> backup + rewrite
fs.writeFileSync(cfg, '{ this is not json');
ensure(dir, ext, L('malformed'));
assert(fs.existsSync(cfg + '.bak'), 'malformed file backed up to .bak');
assert(!!JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers.forgerelay, 'rewrote valid config after backup');

fs.rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
