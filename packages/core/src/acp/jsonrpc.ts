// JSON-RPC 2.0 over newline-delimited JSON (the Agent Client Protocol's stdio framing, FR-203).
// Both sides send requests: Nova asks the agent to start a session and prompt it; the agent asks
// Nova for permission, files and terminals. Everything from the agent is untrusted: lines that are
// not JSON are ignored, oversized lines are dropped, unknown methods answer -32601, a handler's
// failure answers an error, and the number of the agent's requests in flight is capped.
import type { Logger } from '@nova/telemetry';

/** A line-oriented byte stream to the agent process (its stdin and stdout). */
export interface LineTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** The process ended or the stream closed. */
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** An error a handler throws to answer with a specific code. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export interface JsonRpcPeerOptions {
  transport: LineTransport;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  /** Lines longer than this are dropped (default 4 MiB). */
  maxLineChars?: number;
  /** Requests from the other side handled at once (default 16). */
  maxInbound?: number;
  log?: Logger;
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class JsonRpcPeer {
  readonly #t: LineTransport;
  readonly #o: JsonRpcPeerOptions;
  readonly #waiting = new Map<number, Waiting>();
  #next = 1;
  #inbound = 0;
  #closed: string | null = null;
  /** Lines that were not JSON-RPC (stderr noise, a broken agent). */
  ignored = 0;

  constructor(opts: JsonRpcPeerOptions) {
    this.#o = opts;
    this.#t = opts.transport;
    this.#t.onLine((line) => this.#receive(line));
    this.#t.onClose((reason) => this.#fail(reason));
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Send a request and wait for its answer; rejects on an error answer, the timeout or close. */
  request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`the agent is gone (${this.#closed})`));
    const id = this.#next++;
    return new Promise<unknown>((resolve, reject) => {
      const w: Waiting = { resolve, reject, timer: undefined };
      if (opts.timeoutMs)
        w.timer = setTimeout(() => {
          this.#waiting.delete(id);
          reject(new Error(`the agent did not answer ${method} in time`));
        }, opts.timeoutMs);
      opts.signal?.addEventListener(
        'abort',
        () => {
          if (!this.#waiting.delete(id)) return;
          clearTimeout(w.timer);
          reject(new Error(`${method} was cancelled`));
        },
        { once: true },
      );
      this.#waiting.set(id, w);
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async close(reason = 'closed'): Promise<void> {
    this.#fail(reason);
    await this.#t.close().catch(() => undefined);
  }

  #write(msg: Record<string, unknown>): void {
    try {
      this.#t.send(JSON.stringify(msg));
    } catch (err) {
      this.#o.log?.warn('could not write to the agent', { err });
    }
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const [id, w] of this.#waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(`the agent is gone (${reason})`));
      this.#waiting.delete(id);
    }
  }

  #receive(line: string): void {
    const max = this.#o.maxLineChars ?? 4 * 1024 * 1024;
    const text = line.trim();
    if (!text) return;
    if (text.length > max || text[0] !== '{') {
      this.ignored++;
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      msg = v as Record<string, unknown>;
    } catch {
      this.ignored++;
      return;
    }
    if (msg.jsonrpc !== '2.0') {
      this.ignored++;
      return;
    }
    const id = msg.id;
    const validId = typeof id === 'number' || typeof id === 'string';
    if (typeof msg.method === 'string') {
      if (id === undefined || id === null) {
        try {
          this.#o.onNotification(msg.method, msg.params);
        } catch (err) {
          this.#o.log?.warn('agent notification failed', { err, method: msg.method });
        }
        return;
      }
      if (!validId) {
        this.ignored++;
        return;
      }
      void this.#answer(id, msg.method, msg.params);
      return;
    }
    // A response to one of ours.
    if (typeof id !== 'number') {
      this.ignored++;
      return;
    }
    const w = this.#waiting.get(id);
    if (!w) return;
    this.#waiting.delete(id);
    clearTimeout(w.timer);
    if (msg.error && typeof msg.error === 'object') {
      const e = msg.error as { code?: unknown; message?: unknown; data?: unknown };
      w.reject(
        new JsonRpcError(
          typeof e.code === 'number' ? e.code : JSONRPC_INTERNAL_ERROR,
          typeof e.message === 'string' ? e.message.slice(0, 2000) : 'the agent answered an error',
          e.data,
        ),
      );
    } else w.resolve(msg.result);
  }

  async #answer(id: string | number, method: string, params: unknown): Promise<void> {
    if (this.#inbound >= (this.#o.maxInbound ?? 16)) {
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code: JSONRPC_INTERNAL_ERROR, message: 'too many requests at once' },
      });
      return;
    }
    this.#inbound++;
    try {
      const result = await this.#o.onRequest(method, params);
      if (!this.#closed) this.#write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const e =
        err instanceof JsonRpcError
          ? err
          : new JsonRpcError(
              JSONRPC_INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err),
            );
      const error: Record<string, unknown> = { code: e.code, message: e.message };
      if (e.data !== undefined) error.data = e.data;
      if (!this.#closed) this.#write({ jsonrpc: '2.0', id, error });
    } finally {
      this.#inbound--;
    }
  }
}
