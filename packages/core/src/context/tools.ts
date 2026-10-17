// `context.remaining` and `context.fresh` (FR-183, docs/08 §1.1): the model checks how much of
// its context window is left, or asks for a compaction now, carrying a handoff note it writes.
// Both are read-only built-ins; they work only inside a running turn of the loop.
import { argsOf, builtinDescriptor, fail, ok, str, type BuiltinTool } from '../tools/builtin.ts';
import type { TurnContextTracker } from './tracker.ts';

/** Characters of a handoff note carried into the summary. */
export const MAX_HANDOFF_NOTE = 8_000;

export function contextTools(tracker: TurnContextTracker): BuiltinTool[] {
  const outside = () =>
    fail('no_turn', 'Context tools work only inside a running turn of a conversation.');
  return [
    {
      descriptor: builtinDescriptor({
        name: 'context.remaining',
        title: 'Check the context left',
        description:
          'Report the tokens used and left in the context window, and when the conversation is compacted automatically.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: null,
      handler: (_args, ctx) => {
        const r = tracker.remaining(ctx.turnId, ctx.threadId);
        if (!r) return Promise.resolve(outside());
        const text =
          `About ${r.tokens} of ${r.limit} tokens are in use; ${r.tokensLeft} (${r.percentLeft}%) are left. ` +
          `Older turns are compacted into a summary before a turn whose context passes ${r.compactAt} tokens ` +
          `(${Math.round(r.threshold * 100)}%), or now with context.fresh.`;
        return Promise.resolve(ok(text, { ...r }));
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'context.fresh',
        title: 'Start a fresh context',
        description:
          'Compact the conversation now and continue in a fresh context: older turns and earlier results of this turn are replaced by a summary. Write a handoff note with what you need to remember to continue.',
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string', minLength: 1, maxLength: MAX_HANDOFF_NOTE } },
          required: ['note'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: null,
      handler: (args, ctx) => {
        const note = (str(argsOf(args).note) ?? '').trim().slice(0, MAX_HANDOFF_NOTE);
        if (!tracker.requestFresh(ctx.turnId, ctx.threadId, note))
          return Promise.resolve(outside());
        return Promise.resolve(
          ok(
            'The context will be compacted before your next step; your handoff note is carried into the summary.',
          ),
        );
      },
    },
  ];
}
