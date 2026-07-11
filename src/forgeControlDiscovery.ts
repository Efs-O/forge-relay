import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ForgeControlRegistry {
    url?: string;
    endpoint?: string;
    pid: number;
    startedAt?: string;
    version?: string;
}

export interface ForgeControlResolution {
    url?: string;
    source: 'setting' | 'registry' | 'none';
    detail: string;
    registryPath: string;
}

interface DiscoveryOptions {
    registryPath?: string;
    isPidAlive?: (pid: number) => boolean;
    fetchFn?: typeof fetch;
}

export function forgeControlRegistryPath(): string {
    const base = process.env.LOCALAPPDATA
        || process.env.XDG_STATE_HOME
        || path.join(os.homedir(), '.local', 'state');
    return path.join(base, 'forge-llm', 'control-server.json');
}

function defaultPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function normalizeLocalUrl(raw: string): string | null {
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return null;
        if (!url.port) return null;
        url.pathname = url.pathname.replace(/\/$/, '');
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch { return null; }
}

export async function resolveForgeControlUrl(explicitSetting: string, options: DiscoveryOptions = {}): Promise<ForgeControlResolution> {
    const registryPath = options.registryPath ?? forgeControlRegistryPath();
    const explicit = explicitSetting.trim();
    if (explicit) {
        return { url: explicit.replace(/\/$/, ''), source: 'setting', detail: 'Using forgeRelay.subagentForgeControlUrl override.', registryPath };
    }

    let record: ForgeControlRegistry;
    try {
        record = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as ForgeControlRegistry;
    } catch (err) {
        const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'registry not found' : 'registry is unreadable';
        return { source: 'none', detail: `Forge control ${reason}: ${registryPath}`, registryPath };
    }

    const rawUrl = typeof record.url === 'string' ? record.url : typeof record.endpoint === 'string' ? record.endpoint : '';
    const url = normalizeLocalUrl(rawUrl);
    if (!url) return { source: 'none', detail: 'Forge control registry contains an invalid or non-local URL.', registryPath };
    const alive = (options.isPidAlive ?? defaultPidAlive)(record.pid);
    if (!alive) return { source: 'none', detail: `Forge control registry is stale (pid ${record.pid} is not alive).`, registryPath };

    try {
        const response = await (options.fetchFn ?? fetch)(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return { source: 'none', detail: `Forge control health check returned HTTP ${response.status}.`, registryPath };
        const body = await response.json().catch(() => ({})) as { ok?: boolean };
        if (body.ok !== true) return { source: 'none', detail: 'Forge control health check did not report ok.', registryPath };
    } catch (err) {
        return { source: 'none', detail: `Forge control health check failed: ${err instanceof Error ? err.message : String(err)}`, registryPath };
    }

    return { url, source: 'registry', detail: `Discovered Forge control from ${registryPath}.`, registryPath };
}
