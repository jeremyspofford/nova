// The Hub's event stream (`GET /api/v1/events/stream`, contracts/hub-api.md §1, §5) as the shell
// reads it for OS notifications and live status (FR-013, FR-215): a Server-Sent Events parser and
// a loop that reconnects with backoff and resumes after the last event it saw (`Last-Event-ID`).

export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental SSE parsing (WHATWG HTML §9.2): feed text chunks, get whole messages back. */
export class SseParser {
  #buffer = '';
  #data: string[] = [];
  #event = '';
  #id: string | null = null;

  push(chunk: string): SseMessage[] {
    this.#buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const nl = this.#buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl);
      const width = this.#buffer.startsWith('\r\n', nl) ? 2 : 1;
      // A lone CR at the very end may be half of a CRLF: wait for the next chunk.
      if (width === 1 && this.#buffer[nl] === '\r' && nl === this.#buffer.length - 1) break;
      this.#buffer = this.#buffer.slice(nl + width);
      const msg = this.#line(line);
      if (msg) out.push(msg);
    }
    // A runaway line without an end (not an SSE server) must not grow without bound.
    if (this.#buffer.length > 1024 * 1024) this.#buffer = '';
    return out;
  }

  #line(line: string): SseMessage | null {
    if (line === '') {
      if (this.#data.length === 0) {
        this.#event = '';
        return null;
      }
      const msg = { id: this.#id, event: this.#event || 'message', data: this.#data.join('\n') };
      this.#data = [];
      this.#event = '';
      return msg;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    return null;
  }
}

/** One event as the Hub sends it (contracts/events.md envelope). */
export interface HubEvent {
  id: string;
  name: string;
  payload: Record<string, unknown>;
}

export function parseHubEvent(msg: SseMessage): HubEvent | null {
  try {
    const e = JSON.parse(msg.data) as Partial<HubEvent>;
    if (typeof e.name !== 'string' || typeof e.id !== 'string') return null;
    const payload =
      e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? e.payload : {};
    return { id: e.id, name: e.name, payload };
  } catch {
    return null;
  }
}

export interface EventLoopOptions {
  /** Opens the stream; `lastEventId` resumes after the last event seen. */
  open: (lastEventId: string | null, signal: AbortSignal) => Promise<Response>;
  onEvent: (e: HubEvent) => void;
  /** Connected (true) or lost (false); `signedOut` when the Hub answered 401. */
  onState?: (state: { connected: boolean; signedOut: boolean }) => void;
  signal: AbortSignal;
  /** Waits between attempts: 1 s doubling to 60 s, 60 s while signed out. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Read the stream until `signal` aborts, reconnecting after every failure. */
export async function runEventLoop(opts: EventLoopOptions): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastId: string | null = null;
  let delay = 1000;
  while (!opts.signal.aborted) {
    let signedOut = false;
    try {
      const res = await opts.open(lastId, opts.signal);
      if (res.status === 401) {
        signedOut = true;
        await res.body?.cancel().catch(() => undefined);
      } else if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
      } else {
        opts.onState?.({ connected: true, signedOut: false });
        delay = 1000;
        const parser = new SseParser();
        const decoder = new TextDecoder();
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          for (const msg of parser.push(decoder.decode(chunk, { stream: true }))) {
            if (msg.id) lastId = msg.id;
            const e = parseHubEvent(msg);
            if (e) opts.onEvent(e);
          }
        }
      }
    } catch {
      // lost the connection or aborted: try again below
    }
    if (opts.signal.aborted) break;
    opts.onState?.({ connected: false, signedOut });
    await sleep(signedOut ? 60_000 : delay, opts.signal);
    delay = Math.min(delay * 2, 60_000);
  }
}
