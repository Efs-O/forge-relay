const esbuild = require('esbuild');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    logLevel: 'info',
};

Promise.all([
    esbuild.context({
        ...shared,
        entryPoints: ['src/extension.ts'],
        outfile: 'out/extension.js',
        external: ['vscode'],
    }),
    esbuild.context({
        ...shared,
        entryPoints: ['src/mcpStdio.ts'],
        outfile: 'out/mcpStdio.js',
    }),
]).then(async ([extCtx, stdioCtx]) => {
    if (watch) {
        await extCtx.watch();
        await stdioCtx.watch();
        console.log('Watching for changes...');
    } else {
        await extCtx.rebuild();
        await extCtx.dispose();
        await stdioCtx.rebuild();
        await stdioCtx.dispose();
    }
});
