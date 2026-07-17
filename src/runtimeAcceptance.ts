export interface RuntimeAcceptanceCase {
    name: string;
    run(): Promise<string> | string;
}

export interface RuntimeAcceptanceResult {
    name: string;
    ok: boolean;
    detail: string;
    durationMs: number;
}

/** Run every case even after a failure so one invocation produces a patch-ready matrix. */
export async function runRuntimeAcceptanceMatrix(cases: readonly RuntimeAcceptanceCase[]): Promise<RuntimeAcceptanceResult[]> {
    const results: RuntimeAcceptanceResult[] = [];
    for (const entry of cases) {
        const started = Date.now();
        try {
            const detail = await entry.run();
            results.push({ name: entry.name, ok: true, detail: detail || 'passed', durationMs: Date.now() - started });
        } catch (error) {
            results.push({
                name: entry.name,
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - started,
            });
        }
    }
    return results;
}

export function formatRuntimeAcceptanceReport(results: readonly RuntimeAcceptanceResult[]): string {
    const passed = results.filter(result => result.ok).length;
    const rows = results.map(result =>
        `| ${result.ok ? 'PASS' : 'FAIL'} | ${escapeCell(result.name)} | ${escapeCell(result.detail)} | ${result.durationMs} ms |`,
    );
    return [
        '# Forge Relay Runtime Acceptance',
        '',
        `Result: ${passed}/${results.length} passed.`,
        '',
        '| Status | Case | Detail | Duration |',
        '| --- | --- | --- | ---: |',
        ...rows,
        '',
    ].join('\n');
}

function escapeCell(value: string): string {
    return value.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}
