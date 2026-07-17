import { CodexAppServerClient, CodexRpcNotification } from './codexAppServerClient';
import { resolveCodexExecutable } from './codexExecutable';
import {
    CodexManagedProfile,
    codexManagedIsolationOverrides,
    managedCodexEnvironment,
} from './codexManagedProfile';

export interface ManagedLoginTransport {
    start(): Promise<void>;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): Promise<void> | void;
    onNotification(listener: (notification: CodexRpcNotification) => void): () => void;
    close(): Promise<void> | void;
}

export interface ConfigureManagedCodexSubscriptionOptions {
    profile: CodexManagedProfile;
    configuredExecutable?: string;
    nodeExecutable?: string;
    cwd: string;
    timeoutMs?: number;
    baseEnv?: NodeJS.ProcessEnv;
    openExternal: (url: string) => boolean | Promise<boolean>;
    transportFactory?: () => ManagedLoginTransport;
    onState?: (message: string) => void;
    onLog?: (message: string) => void;
}

export interface ManagedCodexSubscriptionResult {
    ok: boolean;
    planType?: string;
    message: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/**
 * Authenticate the isolated managed profile through Codex app-server's
 * ChatGPT-managed OAuth flow. Forge Relay never receives or stores tokens.
 */
export async function configureManagedCodexSubscription(
    options: ConfigureManagedCodexSubscriptionOptions,
): Promise<ManagedCodexSubscriptionResult> {
    const transport = options.transportFactory?.() ?? createLoginTransport(options);
    const completions: Array<Record<string, unknown>> = [];
    const unsubscribe = transport.onNotification(notification => {
        if (notification.method !== 'account/login/completed') return;
        completions.push(record(notification.params));
    });
    let loginId: string | undefined;
    try {
        options.onState?.('Starting isolated Codex subscription login...');
        await transport.start();
        await transport.request('initialize', {
            clientInfo: { name: 'forge-relay-managed-codex-login', title: 'Forge Relay', version: '1' },
            capabilities: { experimentalApi: false },
        });
        await transport.notify('initialized', {});

        const existing = await transport.request<Record<string, unknown>>('account/read', { refreshToken: false });
        const existingAccount = record(existing.account);
        if (existingAccount.type === 'chatgpt') {
            return success(existingAccount.planType, 'Isolated managed Codex is already signed in with ChatGPT.');
        }

        const started = await transport.request<Record<string, unknown>>('account/login/start', {
            type: 'chatgpt',
            useHostedLoginSuccessPage: true,
            appBrand: 'codex',
        });
        loginId = text(started.loginId);
        const authUrl = text(started.authUrl);
        if (started.type !== 'chatgpt' || !loginId || !authUrl || !isAllowedAuthUrl(authUrl)) {
            if (loginId) await cancelLogin(transport, loginId);
            return failure('Codex returned an invalid ChatGPT login response.');
        }

        options.onState?.('Complete the ChatGPT sign-in in your browser...');
        if (!await options.openExternal(authUrl)) {
            await cancelLogin(transport, loginId);
            return failure('The ChatGPT sign-in page could not be opened.');
        }

        const completed = await waitForCompletion(completions, loginId, boundedTimeout(options.timeoutMs));
        if (completed.success !== true) {
            return failure('ChatGPT sign-in did not complete successfully.');
        }

        const accountResult = await transport.request<Record<string, unknown>>('account/read', { refreshToken: false });
        const account = record(accountResult.account);
        if (account.type !== 'chatgpt') {
            return failure('Codex did not activate ChatGPT subscription authentication.');
        }
        return success(account.planType, 'Isolated managed Codex is signed in with ChatGPT subscription access.');
    } catch (error) {
        if (loginId) await cancelLogin(transport, loginId);
        options.onLog?.(`Managed Codex subscription login failed: ${safeErrorKind(error)}`);
        return failure(error instanceof LoginTimeoutError
            ? 'ChatGPT sign-in timed out. Run the configuration command to try again.'
            : 'ChatGPT subscription login failed. Run the configuration command to try again.');
    } finally {
        unsubscribe();
        try { await transport.close(); } catch { /* best-effort temporary transport cleanup */ }
    }
}

function createLoginTransport(options: ConfigureManagedCodexSubscriptionOptions): ManagedLoginTransport {
    const launch = resolveCodexExecutable({
        configuredExecutable: options.configuredExecutable,
        nodeExecutable: options.nodeExecutable,
    });
    const listeners = new Set<(notification: CodexRpcNotification) => void>();
    const client = new CodexAppServerClient({
        executable: launch.executable,
        executableArgsPrefix: launch.argsPrefix,
        shell: false,
        cwd: options.cwd,
        env: managedCodexEnvironment(options.baseEnv ?? process.env, options.profile),
        requestTimeoutMs: 30_000,
        configOverrides: codexManagedIsolationOverrides(options.profile),
        onNotification: notification => {
            for (const listener of listeners) listener(notification);
        },
    });
    return {
        start: () => client.start(),
        request: <T = unknown>(method: string, params?: unknown) => client.request<T>(method, params),
        notify: (method, params) => client.notify(method, params),
        onNotification: listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => client.close(),
    };
}

async function waitForCompletion(
    completions: Array<Record<string, unknown>>,
    loginId: string,
    timeoutMs: number,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const match = completions.find(value => value.loginId === loginId);
        if (match) return match;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new LoginTimeoutError();
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
}

async function cancelLogin(transport: ManagedLoginTransport, loginId: string): Promise<void> {
    try { await transport.request('account/login/cancel', { loginId }); } catch { /* best effort */ }
}

function isAllowedAuthUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const host = url.hostname.toLocaleLowerCase('en-US');
        return url.protocol === 'https:' && (
            host === 'chatgpt.com' || host.endsWith('.chatgpt.com')
            || host === 'openai.com' || host.endsWith('.openai.com')
        );
    } catch {
        return false;
    }
}

function boundedTimeout(value: number | undefined): number {
    if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
    return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(value!)));
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function success(planType: unknown, message: string): ManagedCodexSubscriptionResult {
    return { ok: true, planType: text(planType), message };
}

function failure(message: string): ManagedCodexSubscriptionResult {
    return { ok: false, message };
}

function safeErrorKind(error: unknown): string {
    return error instanceof LoginTimeoutError ? 'timeout'
        : error instanceof Error ? error.name || 'Error' : 'unknown';
}

class LoginTimeoutError extends Error {
    constructor() { super('ChatGPT login timed out.'); this.name = 'LoginTimeoutError'; }
}
