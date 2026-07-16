import { spawn, SpawnOptionsWithoutStdio } from 'node:child_process';
import { CodexExecutableOptions, CodexLaunchSpec, resolveCodexExecutable } from './codexExecutable';
import { CodexManagedProfile, codexManagedIsolationOverrides } from './codexManagedProfile';

interface WritableInput { end(data?: string): void }
interface ReadableOutput { on(event: 'data', listener: (chunk: unknown) => void): void }
export interface ManagedAuthChild {
    stdin: WritableInput;
    stdout?: ReadableOutput | null;
    stderr?: ReadableOutput | null;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'close', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this;
    kill(signal?: NodeJS.Signals): boolean;
}

export type ManagedAuthSpawn = (
    executable: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & { shell: false; stdio: ['pipe', 'pipe', 'pipe'] },
) => ManagedAuthChild;

export interface ConfigureManagedCodexAuthOptions {
    profile: CodexManagedProfile;
    apiKey: string;
    /** Pre-resolved shell-free launch shape; useful when the caller already resolved the CLI. */
    launchSpec?: CodexLaunchSpec;
    configuredExecutable?: string;
    cwd?: string;
    timeoutMs?: number;
    baseEnv?: NodeJS.ProcessEnv;
    resolveExecutable?: (options: CodexExecutableOptions) => CodexLaunchSpec;
    spawn?: ManagedAuthSpawn;
}

export interface ManagedCodexAuthResult {
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
    message: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

/** Provision an API key through Codex's own login flow without retaining or reporting it. */
export async function configureManagedCodexApiKey(
    options: ConfigureManagedCodexAuthOptions,
): Promise<ManagedCodexAuthResult> {
    let key: string | undefined = options.apiKey;
    if (!key.trim()) { return failure('An OpenAI API key is required.'); }

    try {
        const resolver = options.resolveExecutable ?? resolveCodexExecutable;
        const launch = options.launchSpec ?? resolver({ configuredExecutable: options.configuredExecutable });
        const isolation = codexManagedIsolationOverrides(options.profile);
        const args = [
            ...launch.argsPrefix,
            'login',
            '-c', `sqlite_home=${JSON.stringify(isolation.sqlite_home)}`,
            '-c', `cli_auth_credentials_store=${JSON.stringify(isolation.cli_auth_credentials_store)}`,
            '--with-api-key',
        ];
        const env = secretFreeEnvironment(options.baseEnv ?? process.env, key, options.profile);
        const spawnChild = options.spawn ?? defaultSpawn;
        const child = spawnChild(launch.executable, args, {
            cwd: options.cwd,
            env,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Drain output without retaining it: Codex output is not needed and can
        // never become a channel through which the supplied key is reported.
        child.stdout?.on('data', () => undefined);
        child.stderr?.on('data', () => undefined);
        const timeoutMs = boundedTimeout(options.timeoutMs);
        const result = await new Promise<ManagedCodexAuthResult>(resolve => {
            let settled = false;
            const finish = (value: ManagedCodexAuthResult): void => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                finish({ ok: false, exitCode: null, timedOut: true,
                    message: 'Codex login timed out. No credential details were retained.' });
            }, timeoutMs);
            child.once('error', () => finish(failure('Codex login could not be started.')));
            child.once('close', code => finish(code === 0
                ? { ok: true, exitCode: 0, timedOut: false, message: 'Isolated managed Codex authentication configured.' }
                : { ok: false, exitCode: code, timedOut: false, message: 'Codex login failed. Check the API key and try again.' }));
            child.stdin.end(`${key}\n`);
        });
        return result;
    } catch {
        return failure('Codex login could not be started.');
    } finally {
        // JavaScript strings cannot be zeroed, but release this function's
        // plaintext reference immediately after the subprocess completes.
        key = undefined;
    }
}

function secretFreeEnvironment(
    source: NodeJS.ProcessEnv,
    key: string,
    profile: CodexManagedProfile,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(source)) {
        if (value !== key && name.toLocaleUpperCase('en-US') !== 'OPENAI_API_KEY') { env[name] = value; }
    }
    env.CODEX_HOME = profile.home;
    env.CODEX_SQLITE_HOME = profile.sqliteHome;
    return env;
}

function boundedTimeout(value: number | undefined): number {
    if (!Number.isFinite(value)) { return DEFAULT_TIMEOUT_MS; }
    return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(value!)));
}

function failure(message: string): ManagedCodexAuthResult {
    return { ok: false, exitCode: null, timedOut: false, message };
}

const defaultSpawn: ManagedAuthSpawn = (executable, args, options) =>
    spawn(executable, [...args], options) as unknown as ManagedAuthChild;
