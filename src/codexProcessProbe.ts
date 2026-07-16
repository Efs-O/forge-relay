import { spawnSync } from 'child_process';

export type CodexProcessProbeStatus = 'clear' | 'found' | 'unknown';

export interface CodexProcessProbeResult {
    status: CodexProcessProbeStatus;
    detail: string;
    pids?: number[];
}

export interface ProcessCommandResult {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
}

export type ProcessCommandRunner = (command: string, args: string[], timeoutMs: number) => ProcessCommandResult;

export interface CodexProcessProbeOptions {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    ownedChildPid?: number;
    runner?: ProcessCommandRunner;
}

interface ProcessRow { pid: number; commandLine: string; }

const APP_SERVER_PATTERN = /\bcodex\b[^\r\n]*\bapp-server\b|\bapp-server\b[^\r\n]*\bcodex\b/i;

const defaultRunner: ProcessCommandRunner = (command, args, timeoutMs) => {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
        maxBuffer: 4 * 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error,
    };
};

/** Discover Codex app-servers for diagnostics without returning command lines. */
export function probeCodexAppServers(options: CodexProcessProbeOptions = {}): CodexProcessProbeResult {
    const platform = options.platform ?? process.platform;
    const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 5_000, 15_000));
    const runner = options.runner ?? defaultRunner;

    let result: ProcessCommandResult;
    try {
        result = platform === 'win32'
            ? runner('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match '(?i)codex.*app-server|app-server.*codex' } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; commandLine=[string]$_.CommandLine } }); ConvertTo-Json -Compress -InputObject $rows",
            ], timeoutMs)
            : runner('ps', ['-eo', 'pid=,args='], timeoutMs);
    } catch {
        return unknown('Process inspection could not be started.');
    }

    if (result.error) {
        const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
        return unknown(timedOut ? 'Process inspection timed out.' : 'Process inspection failed.');
    }
    if (result.status !== 0) { return unknown('Process inspection was unavailable.'); }

    const parsed = platform === 'win32'
        ? parseWindowsRows(result.stdout ?? '')
        : parseUnixRows(result.stdout ?? '');
    if (!parsed) { return unknown('Process inspection returned an unreadable result.'); }

    const pids = parsed
        .filter(row => row.pid !== options.ownedChildPid && APP_SERVER_PATTERN.test(row.commandLine))
        .map(row => row.pid)
        .filter((pid, index, all) => all.indexOf(pid) === index)
        .sort((a, b) => a - b);
    if (pids.length) {
        const shown = pids.slice(0, 4).join(', ');
        const suffix = pids.length > 4 ? ` and ${pids.length - 4} more` : '';
        return { status: 'found', detail: `Codex app-server process detected (PID ${shown}${suffix}).`, pids };
    }
    return { status: 'clear', detail: 'No Codex app-server process was detected.' };
}

export function parseWindowsRows(stdout: string): ProcessRow[] | null {
    const raw = stdout.trim();
    if (!raw) { return []; }
    try {
        const decoded = JSON.parse(raw) as unknown;
        const rows = Array.isArray(decoded) ? decoded : [decoded];
        const parsed: ProcessRow[] = [];
        for (const item of rows) {
            if (!item || typeof item !== 'object') { return null; }
            const row = item as Record<string, unknown>;
            const pid = Number(row.pid ?? row.ProcessId);
            const commandLine = row.commandLine ?? row.CommandLine;
            if (!Number.isInteger(pid) || pid <= 0 || typeof commandLine !== 'string') { return null; }
            parsed.push({ pid, commandLine });
        }
        return parsed;
    } catch { return null; }
}

export function parseUnixRows(stdout: string): ProcessRow[] | null {
    const parsed: ProcessRow[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) { continue; }
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) { return null; }
        const pid = Number(match[1]);
        if (!Number.isInteger(pid) || pid <= 0) { return null; }
        parsed.push({ pid, commandLine: match[2] });
    }
    return parsed;
}

function unknown(detail: string): CodexProcessProbeResult {
    return { status: 'unknown', detail: detail.slice(0, 200) };
}
