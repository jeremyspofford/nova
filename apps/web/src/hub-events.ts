// One shared connection to the Hub's global event stream (contracts/hub-api.md §5) for every view
// that follows it: the bell, Work, agents, channels, computers, spaces and the rest. Browsers
// allow six HTTP/1.1 connections per host, so a stream per view would leave requests waiting.
// The stream opens with the first listener, learns each listener's event names as it joins, and
// closes with the last; each listener gets only the names it asked for.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { useServices } from './services.tsx';
import { openStream, type EventSourceFactory, type StreamHandle } from './sse.ts';

/** The Hub's global event stream for the signed-in account. */
export const EVENTS_STREAM_URL = '/api/v1/events/stream';

export interface HubListener {
  onEvent: (env: EventEnvelope) => void;
  /** The stream (re)connected: anything emitted while it was closed is fetched again. */
  onOpen?: () => void;
}

interface Entry {
  names: ReadonlySet<string>;
  listener: HubListener;
}

interface Shared {
  handle: StreamHandle;
  entries: Set<Entry>;
}

const shared = new WeakMap<EventSourceFactory, Shared>();

export function subscribeHubEvents(
  factory: EventSourceFactory,
  names: readonly string[],
  listener: HubListener,
): () => void {
  let s = shared.get(factory);
  if (!s) {
    const entries = new Set<Entry>();
    const handle = openStream(
      EVENTS_STREAM_URL,
      {
        onEvent: (env) => {
          for (const e of [...entries]) if (e.names.has(env.name)) e.listener.onEvent(env);
        },
        onOpen: () => {
          for (const e of [...entries]) e.listener.onOpen?.();
        },
      },
      { names, factory },
    );
    s = { handle, entries };
    shared.set(factory, s);
  } else {
    s.handle.listen(names);
  }
  const mine = s;
  const entry: Entry = { names: new Set(names), listener };
  mine.entries.add(entry);
  return () => {
    mine.entries.delete(entry);
    if (mine.entries.size > 0) return;
    mine.handle.close();
    if (shared.get(factory) === mine) shared.delete(factory);
  };
}

/** Follow these events while mounted; the latest callbacks are always the ones called. */
export function useHubStream(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
  onOpen?: () => void,
): void {
  const { eventSource } = useServices();
  const ref = useRef({ onEvent, onOpen });
  useLayoutEffect(() => {
    ref.current = { onEvent, onOpen };
  });
  const key = names.join(',');
  useEffect(
    () =>
      subscribeHubEvents(eventSource, key.split(','), {
        onEvent: (env) => ref.current.onEvent(env),
        onOpen: () => ref.current.onOpen?.(),
      }),
    [eventSource, key],
  );
}
