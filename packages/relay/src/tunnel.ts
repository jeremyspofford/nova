// The API tunnel over a sealed Relay session (FR-137, docs/22 §3.1). A client opens one stream
// per request; the first message is the request (method, path, headers, body), the Hub answers on
// the same stream with `head`, any number of `body` chunks and `end` (or `error`), so a long-lived
// response such as the event stream (SSE) flows as it is produced. The request's own
// Authorization header carries the client's device session token: the Hub authenticates it
// exactly like a direct request, and the Relay's route token never authorizes anything there.
import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes.ts';

export type TunnelMessage =
  | {
      t: 'req';
      /** A random id the Hub echoes in `head` (and `error`), tying the answer to this request. */
      id?: string;
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
    }
  | { t: 'cancel' }
  | { t: 'head'; id?: string; status: number; headers: Record<string, string> }
  | { t: 'body'; data: string }
  | { t: 'end' }
  | { t: 'error'; id?: string; code: string; message: string }
  /** Hub → client on a Hub-opened stream: the owner approved the pairing. */
  | { t: 'paired'; requestId: string | null; deviceId: string | null }
  /**
   * Hub → client on a Hub-opened stream (M7): the owner denied the pairing, it expired, or the
   * Hub refused the claim (`denied`); the Hub then deletes the client's route at the Relay.
   */
  | { t: 'decided'; requestId: string | null; decision: 'denied' | 'expired' }
  /** Hub → client: a client stream id was at or below the Hub's floor (the client's clock went back). */
  | { t: 'stale'; stream: string; floor: number };

export const TUNNEL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** Response body chunks (before base64). */
export const TUNNEL_CHUNK_BYTES = 256 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `{id}` when `v` is a well-formed request id, `{}` when absent, null when malformed. */
function idField(v: unknown): { id?: string } | null {
  if (v === undefined) return {};
  return typeof v === 'string' && REQUEST_ID.test(v) ? { id: v } : null;
}

function headerMap(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string' || k.length > 256 || val.length > 16 * 1024) return null;
    if (++n > 100) return null;
    out[k.toLowerCase()] = val;
  }
  return out;
}

export function encodeTunnel(msg: TunnelMessage): Uint8Array {
  return utf8(JSON.stringify(msg));
}

/** Parse and check one tunnel message; null when malformed. */
export function decodeTunnel(bytes: Uint8Array): TunnelMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8(bytes));
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'req': {
      const headers = headerMap(v.headers ?? {});
      const id = idField(v.id);
      if (
        !id ||
        typeof v.method !== 'string' ||
        !(TUNNEL_METHODS as readonly string[]).includes(v.method) ||
        typeof v.path !== 'string' ||
        !v.path.startsWith('/') ||
        v.path.length > 8192 ||
        !headers ||
        (v.body !== undefined && typeof v.body !== 'string')
      )
        return null;
      return {
        t: 'req',
        ...id,
        method: v.method,
        path: v.path,
        headers,
        ...(typeof v.body === 'string' ? { body: v.body } : {}),
      };
    }
    case 'cancel':
      return { t: 'cancel' };
    case 'head': {
      const headers = headerMap(v.headers ?? {});
      const id = idField(v.id);
      if (
        !id ||
        typeof v.status !== 'number' ||
        !Number.isInteger(v.status) ||
        v.status < 100 ||
        v.status > 599 ||
        !headers
      )
        return null;
      return { t: 'head', ...id, status: v.status, headers };
    }
    case 'body':
      return typeof v.data === 'string' ? { t: 'body', data: v.data } : null;
    case 'end':
      return { t: 'end' };
    case 'error': {
      const id = idField(v.id);
      return id && typeof v.code === 'string' && typeof v.message === 'string'
        ? { t: 'error', ...id, code: v.code.slice(0, 64), message: v.message.slice(0, 500) }
        : null;
    }
    case 'paired':
      return (v.requestId === null || typeof v.requestId === 'string') &&
        (v.deviceId === null || typeof v.deviceId === 'string')
        ? { t: 'paired', requestId: v.requestId, deviceId: v.deviceId }
        : null;
    case 'decided':
      return (v.requestId === null || typeof v.requestId === 'string') &&
        (v.decision === 'denied' || v.decision === 'expired')
        ? { t: 'decided', requestId: v.requestId, decision: v.decision }
        : null;
    case 'stale':
      return typeof v.stream === 'string' &&
        typeof v.floor === 'number' &&
        Number.isSafeInteger(v.floor)
        ? { t: 'stale', stream: v.stream, floor: v.floor }
        : null;
    default:
      return null;
  }
}

// ---- the Hub's side ------------------------------------------------------------------------------

export interface TunnelRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  /** Chunks as they are produced (a stream), or all at once; null for no body. */
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
}

export type TunnelHandler = (req: TunnelRequest, signal: AbortSignal) => Promise<TunnelResponse>;

/** The part of a session a tunnel writes to. */
export interface TunnelSink {
  send(stream: string, data: Uint8Array): void;
  closeStream(stream: string): void;
  abortStream(stream: string): void;
  pending(stream: string): number;
}

export interface TunnelServerOptions {
  sink: TunnelSink;
  handler: TunnelHandler;
  /** Pause reading a response body while this much is unacked (default 4 MiB). */
  highWaterBytes?: number;
  /** Give up on a response whose reader stopped acking with this much pending (default 16 MiB). */
  maxPendingBytes?: number;
  onError?(stream: string, err: unknown): void;
}

interface Exchange {
  /** The request's id, echoed in `head` and `error`. */
  id: string | undefined;
  abort: AbortController;
  drained: (() => void) | null;
}

/** Serves tunneled requests from one client's session. */
export class TunnelServer {
  readonly #o: TunnelServerOptions;
  readonly #open = new Map<string, Exchange>();
  #closed = false;

  constructor(opts: TunnelServerOptions) {
    this.#o = opts;
  }

  get active(): number {
    return this.#open.size;
  }

  /** A message on a client-opened stream. */
  onMessage(stream: string, data: Uint8Array): void {
    const msg = decodeTunnel(data);
    const ex = this.#open.get(stream);
    if (msg?.t === 'cancel') {
      ex?.abort.abort();
      this.onDrain(stream);
      return;
    }
    if (ex || this.#closed) return;
    if (msg?.t !== 'req') {
      this.#send(stream, { t: 'error', code: 'validation', message: 'expected a request' });
      this.#o.sink.closeStream(stream);
      return;
    }
    let body: Uint8Array | null = null;
    if (msg.body !== undefined) {
      try {
        body = fromBase64(msg.body);
      } catch {
        this.#send(stream, {
          t: 'error',
          ...(msg.id ? { id: msg.id } : {}),
          code: 'validation',
          message: 'the body is not base64',
        });
        this.#o.sink.closeStream(stream);
        return;
      }
    }
    const exchange: Exchange = { id: msg.id, abort: new AbortController(), drained: null };
    this.#open.set(stream, exchange);
    void this.#serve(stream, exchange, {
      method: msg.method,
      path: msg.path,
      headers: msg.headers,
      body,
    });
  }

  /** Everything sent on the stream was acked: resume a paused body. */
  onDrain(stream: string): void {
    const ex = this.#open.get(stream);
    const fn = ex?.drained;
    if (ex && fn) {
      ex.drained = null;
      fn();
    }
  }

  /** The session gave up on the stream (no acks): stop producing. */
  onStreamFailed(stream: string): void {
    const ex = this.#open.get(stream);
    if (!ex) return;
    ex.abort.abort();
    this.onDrain(stream);
  }

  close(): void {
    this.#closed = true;
    for (const [stream, ex] of this.#open) {
      ex.abort.abort();
      this.onDrain(stream);
    }
  }

  #send(stream: string, msg: TunnelMessage): void {
    this.#o.sink.send(stream, encodeTunnel(msg));
  }

  async #serve(stream: string, ex: Exchange, req: TunnelRequest): Promise<void> {
    const sink = this.#o.sink;
    const high = this.#o.highWaterBytes ?? 4 * 1024 * 1024;
    const max = this.#o.maxPendingBytes ?? 16 * 1024 * 1024;
    try {
      const res = await this.#o.handler(req, ex.abort.signal);
      if (ex.abort.signal.aborted) throw new Error('cancelled');
      this.#send(stream, {
        t: 'head',
        ...(ex.id ? { id: ex.id } : {}),
        status: res.status,
        headers: res.headers,
      });
      if (res.body) {
        for await (const chunk of res.body) {
          if (ex.abort.signal.aborted) break;
          for (let o = 0; o < chunk.length; o += TUNNEL_CHUNK_BYTES) {
            this.#send(stream, {
              t: 'body',
              data: toBase64(chunk.subarray(o, o + TUNNEL_CHUNK_BYTES)),
            });
          }
          const pending = sink.pending(stream);
          if (pending > max) {
            // The client stopped acking: drop the stream rather than buffer without bound.
            ex.abort.abort();
            break;
          }
          if (pending > high) await new Promise<void>((resolve) => (ex.drained = resolve));
        }
      }
      if (ex.abort.signal.aborted) {
        sink.abortStream(stream);
      } else {
        this.#send(stream, { t: 'end' });
        sink.closeStream(stream);
      }
    } catch (err) {
      if (ex.abort.signal.aborted) {
        // Cancelled by the client or the session: nobody is listening.
        sink.abortStream(stream);
        return;
      }
      ex.abort.abort();
      this.#o.onError?.(stream, err);
      try {
        // Never the internal message: the Hub's log has it (onError).
        this.#send(stream, {
          t: 'error',
          ...(ex.id ? { id: ex.id } : {}),
          code: 'server_error',
          message: 'the Hub could not serve this request',
        });
        sink.closeStream(stream);
      } catch {
        sink.abortStream(stream);
      }
    } finally {
      this.#open.delete(stream);
    }
  }
}
