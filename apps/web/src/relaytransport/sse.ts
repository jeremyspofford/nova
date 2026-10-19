// The Hub's event streams (contracts/hub-api.md §5) read with `fetch` instead of the browser's
// EventSource, for the paths EventSource cannot take: the Relay tunnel (`RelayClient.fetch`), and a
// direct request that needs an Authorization header (a browser paired through the Relay holds a
// device session token, not the session cookie). It follows the SSE format (WHATWG HTML §9.2):
// `event:`, `data:` (joined with newlines), `id:` and comment lines, an event per blank line. A
// stream that ends or fails is reported as closed for good (`readyState` 2 and `onerror`); the
// caller (src/sse.ts) then reopens it with `?after=<last id>`, so nothing is missed.
import type { EventSourceLike } from '../sse.ts';

export type StreamFetch = (path: string, init: RequestInit) => Promise<Response>;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

type Listener = (ev: MessageEvent<string>) => void;

/** One SSE block (the lines up to a blank line) as event name, data and id. */
export interface SseBlock {
  event: string;
  data: string;
  id: string | null;
}

/** Split complete blocks off `buffer`; returns them and the incomplete rest. */
export function parseSse(buffer: string): { blocks: SseBlock[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, '\n');
  const parts = text.split('\n\n');
  const rest = parts.pop() ?? '';
  const blocks: SseBlock[] = [];
  for (const part of parts) {
    let event = 'message';
    let id: string | null = null;
    const data: string[] = [];
    let any = false;
    for (const line of part.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value || 'message';
      else if (field === 'data') {
        data.push(value);
        any = true;
      } else if (field === 'id' && !value.includes('\0')) id = value;
    }
    if (any) blocks.push({ event, data: data.join('\n'), id });
  }
  return { blocks, rest };
}

/** An EventSource over `fetch`: same events, same callbacks, closed for good on any end. */
export class FetchEventSource implements EventSourceLike {
  readyState = CONNECTING;
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null = null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #ctl = new AbortController();
  #lastId = '';

  constructor(fetchImpl: StreamFetch, url: string, headers: Record<string, string> = {}) {
    void this.#run(fetchImpl, url, headers);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.readyState = CLOSED;
    this.#ctl.abort();
  }

  #fail(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onerror?.call(this, new Event('error'));
  }

  #dispatch(block: SseBlock): void {
    if (block.id !== null) this.#lastId = block.id;
    const ev = new MessageEvent<string>(block.event, {
      data: block.data,
      lastEventId: this.#lastId,
    });
    for (const fn of [...(this.#listeners.get(block.event) ?? [])]) fn(ev);
  }

  async #run(fetchImpl: StreamFetch, url: string, headers: Record<string, string>) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...headers },
        cache: 'no-store',
        signal: this.#ctl.signal,
      });
    } catch {
      this.#fail();
      return;
    }
    if (this.readyState === CLOSED) {
      void res.body?.cancel().catch(() => undefined);
      return;
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      this.#fail();
      return;
    }
    this.readyState = OPEN;
    this.onopen?.call(this, new Event('open'));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.readyState === CLOSED) break;
        buffer += decoder.decode(value, { stream: true });
        const { blocks, rest } = parseSse(buffer);
        buffer = rest;
        for (const b of blocks) {
          if (this.readyState === CLOSED) break;
          this.#dispatch(b);
        }
      }
    } catch {
      // the stream broke: reported below
    } finally {
      reader.releaseLock();
    }
    if (this.readyState !== CLOSED) {
      void res.body.cancel().catch(() => undefined);
      this.#fail();
    }
  }
}
