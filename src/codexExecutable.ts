import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface CodexLaunchSpec {
    executable: string;
    argsPrefix: string[];
    shell: false;
}

export interface CodexExecutableOptions {
    configuredExecutable?: string;
    platform?: NodeJS.Platform;
    nodeExecutable?: string;
    /** Injectable equivalent of `where.exe <command>`. */
    where?: (command: string) => string[];
    existsSync?: (filePath: string) => boolean;
    /** Injectable Windows roaming-app-data root used for the npm global fallback. */
    appData?: string;
}

function defaultWhere(command: string): string[] {
    const result = spawnSync('where.exe', [command], {
        encoding: 'utf8', shell: false, windowsHide: true, timeout: 5_000,
    });
    if (result.error || result.status !== 0) { return []; }
    return String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/**
 * Resolve a Codex CLI launch without constructing or invoking a shell command.
 *
 * On Windows, npm's codex.cmd/codex.ps1 cannot be passed to spawn with
 * `shell:false`. Those shims are replaced with this process's Node executable
 * plus the installed @openai/codex JavaScript entry point. Native executables
 * stay direct. Unix commands are already safe to pass as argv arrays.
 */
export function resolveCodexExecutable(options: CodexExecutableOptions = {}): CodexLaunchSpec {
    const platform = options.platform ?? process.platform;
    const configured = options.configuredExecutable?.trim() || 'codex';
    if (platform !== 'win32') {
        return { executable: configured, argsPrefix: [], shell: false };
    }

    const exists = options.existsSync ?? fs.existsSync;
    const where = options.where ?? defaultWhere;
    const nodeExecutable = options.nodeExecutable ?? process.execPath;

    // Explicit JavaScript entry points are safe when launched through Node.
    if (/\.m?js$/i.test(configured)) {
        if (!exists(configured)) {
            throw new Error(`Configured Codex JavaScript entry point does not exist: ${configured}`);
        }
        return { executable: nodeExecutable, argsPrefix: [configured], shell: false };
    }

    // An explicit native Windows executable needs no command interpreter.
    if (/\.exe$/i.test(configured)) {
        return { executable: configured, argsPrefix: [], shell: false };
    }

    const candidates = isWindowsShim(configured) ? [configured] : safeWhere(where, configured);

    // Prefer a native executable if PATH exposes both native and npm shims.
    const native = candidates.find(candidate => /\.exe$/i.test(candidate));
    if (native) {
        return { executable: native, argsPrefix: [], shell: false };
    }

    for (const shim of candidates.filter(isWindowsShim)) {
        const script = findCodexJsBesideShim(shim, exists);
        if (script) {
            return { executable: nodeExecutable, argsPrefix: [script], shell: false };
        }
    }

    // VS Code extension hosts do not necessarily inherit the terminal's PATH.
    // npm's per-user package can therefore be installed and runnable in a
    // terminal while `where.exe codex` returns nothing here. Resolve the
    // standard user-global entry directly and still launch it through Node,
    // without invoking cmd.exe or PowerShell.
    if (configured.toLowerCase() === 'codex') {
        const appData = options.appData ?? process.env.APPDATA ?? '';
        const npmScript = appData
            ? path.win32.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
            : '';
        if (npmScript && exists(npmScript)) {
            return { executable: nodeExecutable, argsPrefix: [npmScript], shell: false };
        }
    }

    // A configured absolute/path-like non-shim may be a native launcher without
    // an extension. Keep it direct only when it demonstrably exists.
    if (isPathLike(configured) && exists(configured) && !isWindowsShim(configured)) {
        return { executable: configured, argsPrefix: [], shell: false };
    }

    const subject = isWindowsShim(configured) ? configured : `the '${configured}' command on PATH`;
    throw new Error(
        `Cannot launch Codex safely from ${subject}. `
        + 'Forge Relay found no native .exe and could not locate '
        + '@openai/codex/bin/codex.js beside the npm shim or in the user npm prefix. '
        + 'Reinstall @openai/codex or configure forgeRelay.codexExecutable to a native codex.exe.',
    );
}

function safeWhere(where: (command: string) => string[], command: string): string[] {
    try {
        return where(command).map(value => value.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function isWindowsShim(filePath: string): boolean {
    return /\.(?:cmd|bat|ps1)$/i.test(filePath);
}

function isPathLike(value: string): boolean {
    return path.win32.isAbsolute(value) || /[\\/]/.test(value);
}

function findCodexJsBesideShim(shimPath: string, exists: (filePath: string) => boolean): string | null {
    const shimDir = path.win32.dirname(path.win32.resolve(shimPath));
    const relative = path.win32.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');
    // npm global shims normally sit directly beside node_modules. The parent
    // candidate also covers bin-style prefix layouts without scanning broadly.
    const candidates = [path.win32.join(shimDir, relative), path.win32.join(path.win32.dirname(shimDir), relative)];
    return candidates.find(exists) ?? null;
}
