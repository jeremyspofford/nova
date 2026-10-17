// Event envelope (contracts/events.md, contracts/schemas/event-envelope.json) and an in-process,
// typed event bus. The Hub persists envelopes; the bus only delivers them.
import { z } from 'zod';
import { uuidv7 } from './ids.ts';

export const EVENT_NAME = /^[a-z0-9]+(\.[a-z0-9_]+)+$/i;
export const ACTOR = /^(user|system|agent:.+)$/;

export const correlationSchema = z
  .object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    callId: z.string().optional(),
  })
  .strict();
export type Correlation = z.infer<typeof correlationSchema>;

export const eventEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().regex(EVENT_NAME),
    schemaVersion: z.number().int().min(1),
    ts: z.iso.datetime({ offset: false }),
    accountId: z.string().optional(),
    actor: z.string().regex(ACTOR),
    correlation: correlationSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EventEnvelope<P extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'payload'
> & { payload: P };

export interface NewEvent<P extends Record<string, unknown>> {
  name: string;
  payload: P;
  actor?: string;
  accountId?: string;
  correlation?: Correlation;
  schemaVersion?: number;
}

export function makeEvent<P extends Record<string, unknown>>(
  e: NewEvent<P>,
  now: () => Date = () => new Date(),
): EventEnvelope<P> {
  const env: EventEnvelope<P> = {
    id: uuidv7(),
    name: e.name,
    schemaVersion: e.schemaVersion ?? 1,
    ts: now().toISOString(),
    actor: e.actor ?? 'system',
    payload: e.payload,
  };
  if (e.accountId !== undefined) env.accountId = e.accountId;
  if (e.correlation !== undefined) env.correlation = e.correlation;
  return eventEnvelopeSchema.parse(env) as EventEnvelope<P>;
}

export type EventHandler = (event: EventEnvelope) => void;

/**
 * In-process pub/sub. Patterns: an exact name (`run.completed`), a prefix ending in `.*`
 * (`run.*`), or `*` for everything. A throwing handler never stops delivery to the others.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #onError: (err: unknown, event: EventEnvelope) => void;

  constructor(onError?: (err: unknown, event: EventEnvelope) => void) {
    this.#onError = onError ?? ((err) => console.error('event handler failed', err));
  }

  subscribe(pattern: string, handler: EventHandler): () => void {
    let set = this.#handlers.get(pattern);
    if (!set) {
      set = new Set();
      this.#handlers.set(pattern, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#handlers.delete(pattern);
    };
  }

  publish(event: EventEnvelope): void {
    for (const [pattern, handlers] of this.#handlers) {
      if (!matches(pattern, event.name)) continue;
      for (const h of handlers) {
        try {
          h(event);
        } catch (err) {
          this.#onError(err, event);
        }
      }
    }
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.#handlers.values()) n += s.size;
    return n;
  }
}

export function matches(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}
