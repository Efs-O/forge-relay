// Destructive-command denylist + exec guards for Forge Relay subagent workers.
// Ported from Forge (N:\vs code apps\Forge\src\tools\DenyList.ts + execHelpers.ts)
// so the guards apply in Forge Relay's *decoupled* worker loop — Forge's own
// guards only run inside Forge's webview and are not in our path (plan Decision
// #3 revised, #4). Keep this in sync if Forge's denylist changes.

export interface DenyListEntry {
    pattern: RegExp;
    description: string;
}

/** Built-in denylist covering common destructive commands (platform-aware). */
export function getBuiltinDenyList(): DenyListEntry[] {
    return [
        // Unix / cross-platform
        { pattern: /\brm\b.*-[rR].*-?[fF]|\brm\b.*-[fF].*-?[rR]/, description: 'rm -rf (recursive force delete)' },
        { pattern: /git\s+reset\s+--(hard|mixed|soft)/, description: 'git reset (hard/mixed/soft)' },
        { pattern: /git\s+clean\s+-[fFdDxX]/, description: 'git clean -f' },
        { pattern: /git\s+push\s+--(force|force-with-lease)/, description: 'force push' },
        { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, description: 'SQL DROP' },
        { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, description: 'system power command' },
        { pattern: /curl\s+.+\|\s*(ba)?sh/, description: 'curl pipe to shell' },
        { pattern: /wget\s+.+-O\s*-.*\|/, description: 'wget pipe' },
        // Windows
        { pattern: /del\s+\/[fFsS]/i, description: 'del /f /s' },
        { pattern: /rd\s+\/[sS]/i, description: 'rd /s' },
        { pattern: /rmdir\s+\/[sS]/i, description: 'rmdir /s' },
        { pattern: /format\s+[a-zA-Z]:/, description: 'disk format' },
        { pattern: /Remove-Item.*-Recurse.*-Force/i, description: 'PowerShell recursive force delete' },
        { pattern: /Remove-Item.*-Force.*-Recurse/i, description: 'PowerShell recursive force delete' },
        { pattern: /Invoke-Expression|^\s*iex\s/i, description: 'PowerShell eval' },
        { pattern: /-EncodedCommand|-enc\s/i, description: 'PowerShell base64 eval' },
        { pattern: /diskpart\b/i, description: 'diskpart' },
    ];
}

/** Returns the first matching denylist entry for command+args, or null. */
export function checkDenyList(command: string, args: string[], entries = getBuiltinDenyList()): DenyListEntry | null {
    const full = [command, ...args].join(' ');
    for (const entry of entries) {
        if (entry.pattern.test(full)) {
            return entry;
        }
    }
    return null;
}

// Shell metacharacters are banned in args so a single tool call can't chain,
// redirect, or substitute its way around the denylist.
const SHELL_OPERATORS = ['&&', '||', ';', '|', '`', '$(', '>', '<'];

export function findShellOperator(args: string[]): string | null {
    for (const arg of args) {
        for (const op of SHELL_OPERATORS) {
            if (arg.includes(op)) {
                return op;
            }
        }
    }
    return null;
}

const PS_DANGEROUS_FLAGS = ['-command', '-encodedcommand', '-enc'];

function violatesPowerShellBan(command: string, args: string[]): boolean {
    const cmd = command.toLowerCase();
    if (cmd === 'powershell.exe' || cmd === 'powershell' || cmd === 'pwsh') {
        return args.some(a => PS_DANGEROUS_FLAGS.includes(a.toLowerCase()));
    }
    return false;
}

// Base commands that on Windows are shell builtins (mkdir) or .cmd/.bat shims
// (npm, npx, tsc, …) and therefore can't be launched with spawn(shell:false).
// We run *these* through cmd.exe /c so workers can scaffold/build on Windows.
// Safety is unchanged: the shell-operator ban + denylist are still applied to
// the full command before we ever reach this routing (see guardWorkerCommand).
const WINDOWS_SHELL_TOOLS = new Set([
    'mkdir', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc',
    'python', 'python3', 'pip', 'pip3', 'deno', 'bun',
    'cargo', 'go', 'dotnet', 'echo', 'where',
]);

/** True when `command` should be routed through cmd.exe /c on Windows. */
export function needsWindowsShell(command: string): boolean {
    const base = command.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    const name = base.split(/[\\/]/).pop() ?? base;
    return WINDOWS_SHELL_TOOLS.has(name);
}

export interface GuardResult {
    ok: boolean;
    reason?: string;
}

/**
 * Full guard for a worker command. Unlike Forge (which would *prompt* a human on
 * a dangerous op), workers are unattended, so a denylist/operator hit is a hard
 * REFUSAL — nothing destructive ever runs without a person in the loop.
 */
export function guardWorkerCommand(command: string, args: string[]): GuardResult {
    const op = findShellOperator(args);
    if (op) {
        return { ok: false, reason: `shell operator "${op}" is not allowed in args — split into separate calls` };
    }
    if (violatesPowerShellBan(command, args)) {
        return { ok: false, reason: 'PowerShell -Command/-EncodedCommand is banned' };
    }
    const denied = checkDenyList(command, args);
    if (denied) {
        return { ok: false, reason: `blocked destructive command — ${denied.description}` };
    }
    return { ok: true };
}
