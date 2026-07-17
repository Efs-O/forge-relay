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

export const MANAGED_CLANKER_PERMISSION_PROFILE = 'forge-relay-clanker';

type ManagedConfigValue = string | number | boolean | readonly ManagedConfigValue[]
    | { readonly [key: string]: ManagedConfigValue };

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

/**
 * Runtime-only policy for the isolated app-server.
 *
 * The built-in `:workspace` profile grants writable temp roots. On native
 * Windows that commonly produces a split-root set (for example repo on N: and
 * temp on C:) which the unelevated sandbox refuses for apply_patch. Relay's
 * profile deliberately grants write access only to the runtime workspace roots
 * while keeping protected metadata directories read-only.
 */
export function codexManagedRuntimeOverrides(
    profile: CodexManagedProfile,
    platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, ManagedConfigValue>> {
    const id = MANAGED_CLANKER_PERMISSION_PROFILE;
    return Object.freeze({
        ...codexManagedIsolationOverrides(profile),
        // Codex refuses startup when any custom permissions table exists but
        // no default selector is configured. Turns still explicitly request
        // :read-only (draft) or this profile (Clanker).
        default_permissions: id,
        // Codex 0.144.x CLI overrides parse a complete filesystem inline table
        // as a string. Flatten the two scalar rules and keep only the scoped
        // workspace map as an inline table, matching the documented TOML shape.
        [`permissions.${id}.filesystem.:minimal`]: 'read',
        [`permissions.${id}.filesystem.:root`]: 'read',
        [`permissions.${id}.filesystem.:workspace_roots`]: {
            '.': 'write',
            '.git': 'read',
            '.agents': 'read',
            '.codex': 'read',
        },
        [`permissions.${id}.network.enabled`]: false,
        ...(platform === 'win32' ? { 'windows.sandbox': 'unelevated' } : {}),
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
