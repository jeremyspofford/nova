// Fold a normalized stream into a final message. Used by tests, non-streaming callers and the
// persistence layer, so partial output on cancel or error is kept and marked (FR-018).
import type { AgentErrorShape, StopReason, StreamEvent } from './types.ts';

export interface CollectedToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Collected {
  messageId: string | null;
  model: string | null;
  text: string;
  reasoning: string;
  toolCalls: CollectedToolCall[];
  citations: { url: string; title?: string; snippet?: string }[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
  stop: StopReason | null;
  error: AgentErrorShape | null;
  /** True when the stream ended for any reason other than a normal end or a tool-call turn. */
  incomplete: boolean;
}

export async function collect(stream: AsyncIterable<StreamEvent>): Promise<Collected> {
  const out: Collected = {
    messageId: null,
    model: null,
    text: '',
    reasoning: '',
    toolCalls: [],
    citations: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    stop: null,
    error: null,
    incomplete: true,
  };
  const pending = new Map<number, { id: string; name: string; args: string }>();
  for await (const e of stream) {
    switch (e.type) {
      case 'start':
        out.messageId = e.messageId;
        out.model = e.model;
        break;
      case 'text_delta':
        out.text += e.text;
        break;
      case 'reasoning_delta':
        out.reasoning += e.text;
        break;
      case 'tool_call_start':
        pending.set(e.index, { id: e.id, name: e.name, args: '' });
        break;
      case 'tool_call_delta': {
        const p = pending.get(e.index);
        if (p) p.args += e.argsDelta;
        break;
      }
      case 'tool_call_end': {
        const p = pending.get(e.index);
        if (p) out.toolCalls.push({ id: p.id, name: p.name, args: e.args });
        pending.delete(e.index);
        break;
      }
      case 'citation': {
        const c: Collected['citations'][number] = { url: e.url };
        if (e.title !== undefined) c.title = e.title;
        if (e.snippet !== undefined) c.snippet = e.snippet;
        out.citations.push(c);
        break;
      }
      case 'usage':
        out.usage.inputTokens += e.inputTokens ?? 0;
        out.usage.outputTokens += e.outputTokens ?? 0;
        out.usage.cachedTokens += e.cachedTokens ?? 0;
        out.usage.costUsd += e.costUsd ?? 0;
        break;
      case 'stop':
        out.stop = e.reason;
        out.error = e.error ?? null;
        break;
    }
  }
  out.incomplete = out.stop !== 'end' && out.stop !== 'tool_calls';
  return out;
}
