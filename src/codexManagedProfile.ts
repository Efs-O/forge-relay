import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CodexManagedProfileOptions {
    globalStorageRoot: string;
    repoRoot: string;
    remoteAuthority?: string | null;
    userIdentity?: string | null;
    /** Override used only for the safety check; credentials are never read or copied. */
    defaultCodexHome?: string;
    mkdir?: typeof fs.mkdir;
    realpath?: typeof fs.realpath;
}

export interface CodexManagedProfile {
    profileId: string;
    root: string;
    home: string;
    sqliteHome: string;
    env: Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME: string }>;
}

export function codexManagedIsolationOverrides(profile: CodexManagedProfile): Readonly<{
    sqlite_home: string;
    cli_auth_credentials_store: 'file';
    forced_login_method: 'chatgpt';
}> {
    return Object.freeze({
        sqlite_home: profile.sqliteHome,
        cli_auth_credentials_store: 'file',
        forced_login_method: 'chatgpt',
    });
}

/** Build an isolated environment that cannot silently switch to token/key auth. */
export function managedCodexEnvironment(
    source: NodeJS.ProcessEnv,
    profile: CodexManagedProfile,
): NodeJS.ProcessEnv {
    const env = { ...source };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
    env.CODEX_HOME = profile.home;
    env.CODEX_SQLITE_HOME = profile.sqliteHome;
    return env;
}

/**
 * Resolve and create the stable, per-workspace local state owned by Forge Relay.
 * The fingerprint contains no reversible workspace or user information.
 */
export async function ensureCodexManagedProfile(
    options: CodexManagedProfileOptions,
): Promise<CodexManagedProfile> {
    const workspaceRoot = normalizeAbsolutePath(options.repoRoot, 'workspace root');
    const globalStorageRoot = normalizeAbsolutePath(options.globalStorageRoot, 'global storage root');
    const identity = [
        normalizeIdentityPath(workspaceRoot),
        normalizeText(options.remoteAuthority) || 'local',
        normalizeText(options.userIdentity) || normalizeText(os.userInfo().username) || 'unknown-user',
    ].join('\0');
    const fingerprint = createHash('sha256').update(identity, 'utf8').digest('hex');
    const profileRoot = path.join(globalStorageRoot, 'managed-codex', 'profiles', fingerprint);
    const codexHome = path.join(profileRoot, 'home');
    const codexSqliteHome = path.join(profileRoot, 'sqlite');
    const defaultCodexHome = normalizeAbsolutePath(
        options.defaultCodexHome?.trim() || path.join(os.homedir(), '.codex'),
        'default Codex home',
    );

    validateIsolation(profileRoot, workspaceRoot, defaultCodexHome);

    const mkdir = options.mkdir ?? fs.mkdir;
    await mkdir(codexHome, { recursive: true });
    await mkdir(codexSqliteHome, { recursive: true });

    // Resolve symlinks after creation so a redirected global-storage path cannot
    // silently place managed credentials in the repository or ordinary profile.
    const realpath = options.realpath ?? fs.realpath;
    const [realProfile, realHome, realSqlite] = await Promise.all([
        realpath(profileRoot), realpath(codexHome), realpath(codexSqliteHome),
    ]);
    validateIsolation(realProfile, await bestEffortRealpath(workspaceRoot, realpath),
        await bestEffortRealpath(defaultCodexHome, realpath));

    return {
        profileId: fingerprint,
        root: realProfile,
        home: realHome,
        sqliteHome: realSqlite,
        env: Object.freeze({ CODEX_HOME: realHome, CODEX_SQLITE_HOME: realSqlite }),
    };
}

function normalizeAbsolutePath(value: string, label: string): string {
    const trimmed = value?.trim();
    if (!trimmed) { throw new Error(`Managed Codex ${label} is required.`); }
    return path.resolve(trimmed);
}

function normalizeIdentityPath(value: string): string {
    const normalized = path.normalize(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normalizeText(value: string | null | undefined): string {
    return (value ?? '').trim().toLocaleLowerCase('en-US');
}

function validateIsolation(profileRoot: string, workspaceRoot: string, defaultCodexHome: string): void {
    if (pathsOverlap(profileRoot, workspaceRoot)) {
        throw new Error('Managed Codex profile must be outside the workspace repository.');
    }
    if (pathsOverlap(profileRoot, defaultCodexHome)) {
        throw new Error('Managed Codex profile must not use or contain the default Codex home.');
    }
}

function pathsOverlap(left: string, right: string): boolean {
    return isWithinOrEqual(left, right) || isWithinOrEqual(right, left);
}

function isWithinOrEqual(candidate: string, parent: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function bestEffortRealpath(value: string, realpath: typeof fs.realpath): Promise<string> {
    try { return await realpath(value); } catch { return value; }
}
