function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? String(value);
}

function fingerprint(name: string, args: Record<string, unknown>): string {
    return `${name}:${stable(args)}`;
}

/** Stops exact and alternating no-progress tool cycles before another call runs. */
export class ToolLoopGuard {
    private readonly calls: Array<{ call: string; result?: string }> = [];

    beforeCall(name: string, args: Record<string, unknown>): void {
        const next = fingerprint(name, args);
        const n = this.calls.length;
        if (name === 'dispatch_subagent' && n >= 1 && this.calls[n - 1].call === next
            && /"state":"(accepted|running)"/.test(this.calls[n - 1].result ?? '')) {
            throw new Error('tool loop detected: identical async subagent run is already live');
        }
        if (n >= 2 && this.calls[n - 1].call === next && this.calls[n - 2].call === next
            && this.calls[n - 1].result !== undefined && this.calls[n - 1].result === this.calls[n - 2].result) {
            throw new Error(`tool loop detected: ${name} repeated without progress`);
        }
        if (n >= 4 && this.calls[n - 4].call === next && this.calls[n - 3].call === this.calls[n - 1].call
            && this.calls[n - 2].call === next && this.calls[n - 4].result === this.calls[n - 2].result
            && this.calls[n - 3].result === this.calls[n - 1].result) {
            throw new Error(`tool loop detected: alternating cycle involving ${name}`);
        }
        this.calls.push({ call: next });
        if (this.calls.length > 12) this.calls.shift();
    }

    afterCall(result: string): void {
        const current = this.calls[this.calls.length - 1];
        if (current) current.result = result.replace(/\s+/g, ' ').trim().slice(0, 2_000);
    }
}
