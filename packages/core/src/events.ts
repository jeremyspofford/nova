// Where core services publish events (contracts/events.md). The Hub's EventStore satisfies this
// structurally, so core never imports the Hub.
import type { NewEvent } from '@nova/shared';

export interface EventSink {
  /** Persist, then publish. */
  emit<P extends Record<string, unknown>>(e: NewEvent<P>): Promise<unknown>;
  /** Publish only (token deltas). */
  emitEphemeral<P extends Record<string, unknown>>(e: NewEvent<P>): unknown;
}

/** Collects events in memory (tests, headless use). */
export class MemoryEventSink implements EventSink {
  readonly events: {
    name: string;
    payload: Record<string, unknown>;
    ephemeral: boolean;
    correlation?: NewEvent<Record<string, unknown>>['correlation'];
  }[] = [];
  readonly #listeners = new Set<(e: MemoryEventSink['events'][number]) => void>();

  emit<P extends Record<string, unknown>>(e: NewEvent<P>): Promise<unknown> {
    this.#push(e, false);
    return Promise.resolve();
  }

  emitEphemeral<P extends Record<string, unknown>>(e: NewEvent<P>): unknown {
    this.#push(e, true);
    return undefined;
  }

  on(fn: (e: MemoryEventSink['events'][number]) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  names(): string[] {
    return this.events.map((e) => e.name);
  }

  #push<P extends Record<string, unknown>>(e: NewEvent<P>, ephemeral: boolean): void {
    const rec: MemoryEventSink['events'][number] = { name: e.name, payload: e.payload, ephemeral };
    if (e.correlation) rec.correlation = e.correlation;
    this.events.push(rec);
    for (const fn of this.#listeners) fn(rec);
  }
}
