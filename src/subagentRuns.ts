import * as fs from 'fs';
import * as path from 'path';

export type SubagentRunState = 'accepted' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'exhausted';

export interface SubagentRunRecord {
    runId: string;
    worker: string;
    model: string;
    state: SubagentRunState;
    createdAt: string;
    updatedAt: string;
    detail?: string;
}

function runPath(repoRoot: string, runId: string): string {
    if (!/^sa_[a-z0-9_]+$/i.test(runId)) throw new Error('invalid subagent run id');
    return path.join(repoRoot, '.coordination', 'subagent-runs', `${runId}.json`);
}

function write(repoRoot: string, record: SubagentRunRecord): void {
    const target = runPath(repoRoot, record.runId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
}

export function createSubagentRun(repoRoot: string, input: Pick<SubagentRunRecord, 'runId' | 'worker' | 'model'>): SubagentRunRecord {
    const now = new Date().toISOString();
    const record: SubagentRunRecord = { ...input, state: 'accepted', createdAt: now, updatedAt: now };
    write(repoRoot, record);
    return record;
}

export function updateSubagentRun(repoRoot: string, runId: string, state: SubagentRunState, detail?: string): SubagentRunRecord {
    const current = readSubagentRun(repoRoot, runId);
    if (!current) throw new Error(`unknown subagent run: ${runId}`);
    const record: SubagentRunRecord = { ...current, state, updatedAt: new Date().toISOString(), ...(detail ? { detail } : {}) };
    write(repoRoot, record);
    return record;
}

export function readSubagentRun(repoRoot: string, runId: string): SubagentRunRecord | null {
    const target = runPath(repoRoot, runId);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8')) as SubagentRunRecord;
}

export function asyncDispatchReceipt(record: SubagentRunRecord): string {
    return JSON.stringify({
        state: record.state,
        runId: record.runId,
        worker: record.worker,
        model: record.model,
        resultChannel: 'board',
        terminalStates: ['succeeded', 'failed', 'aborted', 'exhausted'],
    });
}
