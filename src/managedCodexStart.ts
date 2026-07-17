import { CodexMode } from './types';

export interface ManagedCodexStartActions {
    start(): Promise<void>;
    promptSignIn(): Promise<boolean>;
    signIn(): Promise<boolean>;
}

/** Keep the login recovery path narrow so unrelated startup failures remain visible. */
export function isManagedCodexAuthenticationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unauthenticated codex account|chatgpt subscription login required|not authenticated with chatgpt subscription/i.test(message);
}

/**
 * Start the requested runtime and recover once through the explicit ChatGPT
 * browser-login command when the isolated profile is not authenticated.
 */
export async function startWithManagedCodexSignIn(
    codexMode: CodexMode,
    actions: ManagedCodexStartActions,
): Promise<boolean> {
    try {
        await actions.start();
        return true;
    } catch (error) {
        if (codexMode !== 'managed-isolated' || !isManagedCodexAuthenticationError(error)) throw error;
        if (!await actions.promptSignIn()) return false;
        if (!await actions.signIn()) return false;
        await actions.start();
        return true;
    }
}
