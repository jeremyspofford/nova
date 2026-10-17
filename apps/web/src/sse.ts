// Typed Server-Sent Events helper (contracts/hub-api.md §5). The Hub writes one event envelope
// per SSE event with `event: <name>` and `id: <event id>`. While the connection is open, the
// browser reconnects by itself and sends Last-Event-ID; if the connection closes for good (an
// HTTP error), we reopen it with `?after=<last id>` and a capped backoff so nothing is missed.
import type { EventEnvelope } from '@nova/shared';

/** The subset of EventSource we use, so tests can inject a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const browserEventSource: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

const CLOSED = 2;

export interface StreamHandlers {
  onEvent: (event: EventEnvelope) => void;
  onOpen?: () => void;
  /** Called with `true` while reconnecting, `false` once connected again. */
  onReconnecting?: (reconnecting: boolean) => void;
}

export interface StreamOptions {
  /** Event names to listen for (SSE named events are not delivered to `onmessage`). */
  names: readonly string[];
  factory?: EventSourceFactory;
  /** Backoff before reopening a closed stream; grows to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface StreamHandle {
  close: () => void;
  /** Id of the last event delivered, used as the resume cursor. */
  lastEventId: () => string | null;
}

export function openStream(
  url: string,
  handlers: StreamHandlers,
  { names, factory = browserEventSource, baseDelayMs = 1000, maxDelayMs = 15_000 }: StreamOptions,
): StreamHandle {
  let source: EventSourceLike | null = null;
  let lastId: string | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const seen = new Set<string>();

  const deliver = (ev: MessageEvent<string>) => {
    let env: EventEnvelope;
    try {
      env = JSON.parse(ev.data) as EventEnvelope;
    } catch {
      return; // a malformed frame is dropped, never fatal
    }
    if (!env || typeof env.name !== 'string') return;
    // A replay after reconnecting can repeat events we already handled.
    if (env.id) {
      if (seen.has(env.id)) return;
      seen.add(env.id);
      if (seen.size > 2000) seen.delete(seen.values().next().value as string);
    }
    lastId = ev.lastEventId || env.id || lastId;
    handlers.onEvent(env);
  };

  const connect = () => {
    if (closed) return;
    const target = lastId
      ? `${url}${url.includes('?') ? '&' : '?'}after=${encodeURIComponent(lastId)}`
      : url;
    const es = factory(target);
    source = es;
    es.onopen = () => {
      if (attempt > 0) handlers.onReconnecting?.(false);
      attempt = 0;
      handlers.onOpen?.();
    };
    es.onerror = () => {
      if (closed) return;
      if (es.readyState !== CLOSED) {
        // The browser is retrying with Last-Event-ID; just report it.
        handlers.onReconnecting?.(true);
        return;
      }
      es.close();
      handlers.onReconnecting?.(true);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      attempt++;
      timer = setTimeout(connect, delay);
    };
    for (const name of names) es.addEventListener(name, deliver);
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    },
    lastEventId: () => lastId,
  };
}

/** Event names a chat thread view listens for (contracts/events.md "chat & turns"). */
export const THREAD_EVENTS = [
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'chat.message.created',
  'chat.delta',
  'chat.message.completed',
  'chat.message.updated',
  'chat.message.deleted',
  'chat.branch.created',
  'chat.followup.queued',
  'chat.followup.started',
  'thread.status.changed',
] as const;
