// The context window of each running turn, shared by the loop and the context tools (FR-183,
// docs/08 §1.1): the loop records how large the context it is about to send is; the model
// reads it with `context.remaining` and asks for a compaction with `context.fresh`.
import type { ContentPart, NormalizedMessage, ToolSchema } from '@nova/providers';
import { CHARS_PER_TOKEN } from '../tools/text.ts';

/** Tokens an image counts for when estimating (no tokenizer at hand). */
const IMAGE_TOKENS = 1_500;

/** An estimate of the tokens a request takes: ~4 characters per token (docs/08 §1.4). */
export function estimateRequestTokens(
  messages: readonly NormalizedMessage[],
  tools?: readonly ToolSchema[],
): number {
  let chars = 0;
  let images = 0;
  const count = (p: ContentPart): void => {
    if (p.type === 'text') chars += p.text.length;
    else if (p.type === 'image') images++;
    else if (p.type === 'tool_call') chars += p.name.length + (JSON.stringify(p.args) ?? '').length;
    else for (const c of p.content) count(c);
  };
  for (const m of messages) for (const p of m.content) count(p);
  for (const t of tools ?? [])
    chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

export interface ContextMeasure {
  /** Estimated tokens of the context the latest step sent. */
  tokens: number;
  /** The model's context window. */
  limit: number;
  /** `context.compactThreshold`: compaction runs above this share of the limit. */
  threshold: number;
}

export interface ContextRemaining extends ContextMeasure {
  tokensLeft: number;
  /** 0-100, rounded down. */
  percentLeft: number;
  /** Tokens at which a turn compacts before its first step. */
  compactAt: number;
}

interface Entry extends ContextMeasure {
  threadId: string;
  fresh: string | null;
}

export class TurnContextTracker {
  readonly #turns = new Map<string, Entry>();

  /** The loop measured the context of a step it is about to send. */
  update(turnId: string, threadId: string, m: ContextMeasure): void {
    const prev = this.#turns.get(turnId);
    this.#turns.set(turnId, { ...m, threadId, fresh: prev?.fresh ?? null });
  }

  /** The turn ended. */
  end(turnId: string): void {
    this.#turns.delete(turnId);
  }

  /** What `context.remaining` reports; null for a call outside a running turn. */
  remaining(turnId: string, threadId: string): ContextRemaining | null {
    const e = this.#turns.get(turnId);
    if (e?.threadId !== threadId) return null;
    const tokensLeft = Math.max(0, e.limit - e.tokens);
    return {
      tokens: e.tokens,
      limit: e.limit,
      threshold: e.threshold,
      tokensLeft,
      percentLeft: e.limit > 0 ? Math.floor((tokensLeft / e.limit) * 100) : 0,
      compactAt: Math.floor(e.limit * e.threshold),
    };
  }

  /** `context.fresh`: compact before the turn's next step, carrying `note`. */
  requestFresh(turnId: string, threadId: string, note: string): boolean {
    const e = this.#turns.get(turnId);
    if (e?.threadId !== threadId) return false;
    e.fresh = note;
    return true;
  }

  /** The note of a pending `context.fresh`, once; null when none was asked for. */
  takeFresh(turnId: string): string | null {
    const e = this.#turns.get(turnId);
    if (!e || e.fresh === null) return null;
    const note = e.fresh;
    e.fresh = null;
    return note;
  }
}
