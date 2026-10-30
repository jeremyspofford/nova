// A small Chrome DevTools Protocol client (M5 plan §3). Nova drives Chromium itself, with no
// Playwright or Puppeteer at run time: commands go out as JSON with an id, answers come back
// with the same id, and everything else is an event. The transport is Chromium's
// --remote-debugging-pipe (NUL-separated JSON on fds 3 and 4), so no port is ever opened and
// nothing on this machine can attach to the browser Nova drives.
import { EventEmitter } from 'node:events';

export interface Transport {
  send(message: string): void;
  // Raw chunks as they arrive; a message may be split across chunks or share one with others.
  onData(fn: (chunk: Buffer | string) => void): void;
  onClose(fn: (why: string) => void): void;
  close(): void;
}

export class CdpError extends Error {
  readonly code: number | null;
  readonly method: string;
  constructor(method: string, message: string, code: number | null = null) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

interface Pending { method: string; ok: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }

// Events are emitted twice: as `<method>` with (params, sessionId), and as `event` with
// ({method, params, sessionId}), so a listener can follow one target or all of them.
export class Cdp extends EventEmitter {
  #t: Transport;
  #next = 1;
  #pending = new Map<number, Pending>();
  #buffer = '';
  #closed: string | null = null;
  #timeoutMs: number;

  constructor(t: Transport, o: { timeoutMs?: number } = {}) {
    super();
    this.setMaxListeners(100);
    this.#t = t;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    t.onData((chunk) => this.#take(String(chunk)));
    t.onClose((why) => this.#shut(why));
  }

  get closed(): boolean { return this.#closed !== null; }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, o: { timeoutMs?: number } = {}): Promise<T> {
    if (this.#closed !== null) return Promise.reject(new CdpError(method, `the browser connection is closed (${this.#closed})`));
    const id = this.#next++;
    return new Promise<T>((ok, fail) => {
      const limit = o.timeoutMs ?? this.#timeoutMs;
      const timer = limit > 0 ? setTimeout(() => {
        this.#pending.delete(id);
        fail(new CdpError(method, `no answer within ${Math.round(limit / 1000)} s`));
      }, limit) : null;
      timer?.unref?.();
      this.#pending.set(id, { method, ok: ok as (v: unknown) => void, fail, timer });
      try {
        this.#t.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        fail(new CdpError(method, (e as Error).message));
      }
    });
  }

  close(): void {
    this.#t.close();
    this.#shut('closed by Nova');
  }

  #take(text: string): void {
    this.#buffer += text;
    let at: number;
    while ((at = this.#buffer.indexOf('\0')) >= 0) {
      const raw = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (raw.trim()) this.#dispatch(raw);
    }
  }

  #dispatch(raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string }; sessionId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.fail(new CdpError(p.method, msg.error.message ?? 'failed', msg.error.code ?? null));
      else p.ok(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      const params = msg.params ?? {};
      this.emit(msg.method, params, msg.sessionId);
      this.emit('event', { method: msg.method, params, sessionId: msg.sessionId });
    }
  }

  #shut(why: string): void {
    if (this.#closed !== null) return;
    this.#closed = why;
    for (const [id, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.fail(new CdpError(p.method, `the browser connection closed (${why})`));
      this.#pending.delete(id);
    }
    this.emit('close', why);
  }
}

// The pipe transport over a child process's fds 3 (to Chromium) and 4 (from it).
export function pipeTransport(write: NodeJS.WritableStream, read: NodeJS.ReadableStream): Transport {
  let closed = false;
  const closers: ((why: string) => void)[] = [];
  const shut = (why: string) => {
    if (closed) return;
    closed = true;
    for (const fn of closers) fn(why);
  };
  read.on('end', () => shut('the browser closed its end'));
  read.on('error', (e: Error) => shut(e.message));
  write.on('error', (e: Error) => shut(e.message));
  return {
    send: (m) => { write.write(`${m}\0`); },
    onData: (fn) => { read.on('data', fn); },
    onClose: (fn) => { closers.push(fn); },
    close: () => { shut('closed by Nova'); try { write.end(); } catch { /* already gone */ } },
  };
}
