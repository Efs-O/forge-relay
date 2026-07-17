import { ForgeControlResolution, resolveForgeControlUrl } from './forgeControlDiscovery';
import { DEFAULT_SUBAGENT_BACKENDS, SubagentBackends } from './subagent';

type ForgeResolver = (explicit: string) => Promise<ForgeControlResolution>;

/** Resolve standalone MCP routing without depending on VS Code settings. */
export async function resolveStdioSubagentBackends(
    env: NodeJS.ProcessEnv,
    resolveForge: ForgeResolver = explicit => resolveForgeControlUrl(explicit),
): Promise<{ backends: SubagentBackends; forge: ForgeControlResolution }> {
    const forge = await resolveForge(env.FORGERELAY_FORGE_CONTROL_URL ?? '');
    return {
        forge,
        backends: {
            bridgeUrl: env.FORGERELAY_BRIDGE_URL || DEFAULT_SUBAGENT_BACKENDS.bridgeUrl,
            ollamaUrl: env.FORGERELAY_OLLAMA_URL || DEFAULT_SUBAGENT_BACKENDS.ollamaUrl,
            directUrl: env.FORGERELAY_DIRECT_URL || DEFAULT_SUBAGENT_BACKENDS.directUrl,
            bridgeApiKey: env.FORGERELAY_BRIDGE_API_KEY || undefined,
            defaultBackend: (env.FORGERELAY_DEFAULT_BACKEND as SubagentBackends['defaultBackend']) || DEFAULT_SUBAGENT_BACKENDS.defaultBackend,
            forgeControlUrl: forge.url,
            defaultRunMode: (env.FORGERELAY_DEFAULT_MODE as SubagentBackends['defaultRunMode']) || DEFAULT_SUBAGENT_BACKENDS.defaultRunMode,
            ollamaAutoStart: env.FORGERELAY_OLLAMA_AUTO_START === '1',
            ollamaExecutable: env.FORGERELAY_OLLAMA_EXECUTABLE || undefined,
            codexExecutable: env.FORGERELAY_CODEX_EXECUTABLE || undefined,
            codexTimeoutMs: Number(env.FORGERELAY_CODEX_TIMEOUT_MS) || undefined,
            buildCommand: env.FORGERELAY_BUILD_COMMAND || undefined,
            buildClaimTargets: env.FORGERELAY_BUILD_CLAIM_TARGETS
                ? env.FORGERELAY_BUILD_CLAIM_TARGETS.split(',').map(t => t.trim()).filter(Boolean)
                : undefined,
            buildTimeoutMs: Number(env.FORGERELAY_BUILD_TIMEOUT_MS) || undefined,
        },
    };
}
