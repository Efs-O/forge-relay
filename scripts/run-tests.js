// Minimal dependency-free test runner: bundle the TypeScript tests under tests/
// with esbuild (already a devDependency), then run them with Node's built-in
// test runner (node --test). Keeps tests in TS without adding a Vitest/ts-node
// toolchain. Run via `npm test`.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'tests');
const outDir = path.join(root, 'out', 'tests');

const entries = fs.existsSync(testDir)
    ? fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts')).map(f => path.join(testDir, f))
    : [];

if (entries.length === 0) {
    console.error('No *.test.ts files found in tests/.');
    process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
esbuild.buildSync({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: 'inline',
});

const outFiles = fs.readdirSync(outDir).filter(f => f.endsWith('.test.js')).map(f => path.join(outDir, f));
const res = spawnSync(process.execPath, ['--test', ...outFiles], { stdio: 'inherit' });
process.exit(res.status ?? 1);
