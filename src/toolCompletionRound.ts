export interface ToolCall {
    id?: string;
    function?: { name?: string; arguments?: string };
}

export interface ToolMessage {
    role: string;
    content?: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface CompletionResponse {
    choices?: Array<{ message?: ToolMessage; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
}

export interface ToolCompletionRoundOptions {
    messages: Array<Record<string, unknown>>;
    complete: () => Promise<CompletionResponse>;
    executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
    beforeTool?: (name: string, args: Record<string, unknown>) => void | Promise<void>;
    onResponse?: (response: CompletionResponse) => void;
    onToolCall?: (name: string, args: Record<string, unknown>, result: string) => void;
    maxToolResultChars?: number;
    missingMessageError?: string;
    missingMessageText?: string;
    emptyLengthError: string;
}

export interface ToolCompletionRoundResult {
    finished: boolean;
    finalText: string;
    toolCalls: number;
}

/** One transport-agnostic model completion plus execution of its tool calls. */
export async function runToolCompletionRound(opts: ToolCompletionRoundOptions): Promise<ToolCompletionRoundResult> {
    const response = await opts.complete();
    opts.onResponse?.(response);
    const choice = response.choices?.[0];
    const message = choice?.message;
    if (!message) {
        if (opts.missingMessageError) throw new Error(opts.missingMessageError);
        return { finished: true, finalText: opts.missingMessageText ?? '', toolCalls: 0 };
    }

    const calls = message.tool_calls ?? [];
    if (!calls.length) {
        const text = (message.content ?? '').trim();
        if (!text && choice?.finish_reason === 'length') throw new Error(opts.emptyLengthError);
        return { finished: true, finalText: text, toolCalls: 0 };
    }

    opts.messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls });
    for (const call of calls) {
        const name = call.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* executor returns the useful error */ }
        await opts.beforeTool?.(name, args);
        const result = await opts.executeTool(name, args);
        opts.onToolCall?.(name, args, result);
        opts.messages.push({
            role: 'tool',
            tool_call_id: call.id ?? name,
            content: result.slice(0, opts.maxToolResultChars ?? 8_000),
        });
    }
    return { finished: false, finalText: '', toolCalls: calls.length };
}
