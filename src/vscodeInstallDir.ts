import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * True when `dir` looks like a VS Code installation root (portable or system).
 * Detected by the Code launcher plus the bundled product.json, so callers never
 * drop a .coordination board where the auto-updater needs to delete files —
 * which otherwise fails with "Access is denied (os error 5)" because the MCP
 * server keeps mcpstdio.log open inside that folder.
 */
export function isVsCodeInstallDir(dir: string): boolean {
    if (!dir) {
        return false;
    }
    const launchers = ['Code.exe', 'code', 'Code - Insiders.exe', 'code-insiders'];
    const hasLauncher = launchers.some(name => fs.existsSync(path.join(dir, name)));
    const hasAppProduct = fs.existsSync(path.join(dir, 'resources', 'app', 'product.json'));
    return hasLauncher && hasAppProduct;
}

/**
 * Safe fallback board location for headless contexts (the stdio MCP server)
 * that cannot prompt the user. Used when the resolved repoRoot would otherwise
 * be a VS Code install dir.
 */
export function fallbackCoordinationRoot(): string {
    return path.join(os.homedir(), '.forge-relay', 'orphan-board');
}
