// HTTP and SSE plumbing shared by the HTTP adapters (docs/07 §9, §14): connect with a timeout,
// retry before the first byte only, read SSE data with an idle timeout, and build the
// normalized error shapes. Vendor wire formats live in each adapter.
import { NovaError, type ProviderErrorCode } from '@nova/shared';
import { SseParser } from './sse.ts';
import type { AgentErrorShape, StreamEvent } from './types.ts';

export type StopEvent = Extract<StreamEvent, { type: 'stop' }>;

export const MAX_ERROR_BODY = 8_192;

export interface SseRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetch: typeof fetch;
  /** Host name used in user-facing messages. */
  host: string;
  connectTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  /** A Retry-After longer than this is reported (as `retryAfterMs`) instead of waited out. */
  maxRetryAfterMs: number;
  random: () => number;
  /** Map a non-2xx response to an error shape. */
  mapError: (status: number, text: string) => AgentErrorShape;
}

export type SseConnection =
  { ok: true; res: Response; conn: AbortController } | { ok: false; stop: StopEvent };

type Attempt =
  | { ok: true; res: Response; conn: AbortController }
  | { ok: false; error: AgentErrorShape; retryAfterMs?: number };

/**
 * POST and wait for a streaming response, retrying retryable failures before the first byte
 * with exponential backoff and jitter, honouring Retry-After. Never throws.
 */
export async function connectSse(r: SseRequest): Promise<SseConnection> {
  for (let attempt = 0; ; attempt++) {
    const a = await attemptOnce(r);
    if (a.ok) return a;
    if (r.signal.aborted) return { ok: false, stop: { type: 'stop', reason: 'cancelled' } };
    const backoff = Math.round(r.retryBaseMs * 2 ** attempt + r.random() * r.retryBaseMs);
    const wait = Math.max(backoff, a.retryAfterMs ?? 0);
    if (!a.error.retryable || attempt >= r.maxRetries || wait > r.maxRetryAfterMs) {
      // Retry-After is surfaced so the router can decide whether to wait or move on.
      const error =
        a.retryAfterMs === undefined ? a.error : { ...a.error, retryAfterMs: a.retryAfterMs };
      return { ok: false, stop: { type: 'stop', reason: 'error', error } };
    }
    if (!(await sleep(wait, r.signal)))
      return { ok: false, stop: { type: 'stop', reason: 'cancelled' } };
  }
}

async function attemptOnce(r: SseRequest): Promise<Attempt> {
  const conn = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    conn.abort();
  }, r.connectTimeoutMs);
  try {
    let res: Response;
    try {
      res = await r.fetch(r.url, {
        method: 'POST',
        headers: r.headers,
        body: r.body,
        signal: AbortSignal.any([r.signal, conn.signal]),
      });
    } catch {
      if (r.signal.aborted) return { ok: false, error: err('cancelled', 'cancelled', false) };
      return {
        ok: false,
        error: timedOut
          ? err('timeout', `${r.host} did not answer within the connect timeout`, true)
          : err('network', `could not reach ${r.host}`, true),
      };
    }
    if (res.ok && res.body) return { ok: true, res, conn };
    const text = res.ok ? '' : await readCapped(res);
    const retryAfterMs = parseRetryAfter(res.headers);
    const error = res.ok
      ? err('provider_error', `${r.host} returned an empty response`, true)
      : r.mapError(res.status, text);
    return retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs };
  } finally {
    clearTimeout(timer);
  }
}

export type SseItem = { data: string } | { failure: AgentErrorShape };

/**
 * The `data` payloads of an SSE response, ending early with a `failure` when the connection
 * drops or stays silent past the idle timeout. Returns quietly on cancellation. Leaving the
 * loop early releases the connection.
 */
export async function* readSseData(
  res: Response,
  conn: AbortController,
  signal: AbortSignal,
  idleMs: number,
  host: string,
): AsyncGenerator<SseItem> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let idleFired = false;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleFired = true;
      conn.abort();
    }, idleMs);
  };
  armIdle();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal.aborted) return;
        yield {
          failure: idleFired
            ? err('timeout', `${host} stopped sending for ${Math.round(idleMs / 1000)} s`, true)
            : err('network', `the connection to ${host} was lost mid-response`, true),
        };
        return;
      }
      const datas = chunk.done
        ? parser.end()
        : parser.push(decoder.decode(chunk.value, { stream: true }));
      if (!chunk.done) armIdle();
      for (const data of datas) yield { data };
      if (chunk.done || signal.aborted) return;
    }
  } finally {
    clearTimeout(idle);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** GET a JSON document with a timeout, mapping failures to typed NovaError-like throws. */
export async function getJson(opts: {
  url: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  host: string;
  timeoutMs: number;
  mapError: (status: number, text: string) => AgentErrorShape;
  toError: (e: AgentErrorShape) => Error;
}): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await opts.fetch(opts.url, { headers: opts.headers, signal: ac.signal });
    } catch {
      throw opts.toError(
        ac.signal.aborted
          ? err('timeout', `${opts.host} did not answer in time`, true)
          : err('network', `could not reach ${opts.host}`, true),
      );
    }
    if (!res.ok) throw opts.toError(opts.mapError(res.status, await readCapped(res)));
    try {
      return await res.json();
    } catch {
      throw opts.toError(
        err('provider_error', `${opts.host} returned a response that is not JSON`, false),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Retry-After as milliseconds: `retry-after-ms`, seconds, or an HTTP date. */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const v = headers.get('retry-after');
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.max(0, Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Function names must match ^[a-zA-Z0-9_-]+$ on the wire; Nova names use dots (docs/07 §7). */
export class ToolNames {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();
  constructor(names: string[]) {
    for (const n of names) {
      let w = n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
      for (let i = 2; this.#fromWire.has(w); i++) w = `${w.slice(0, 60)}_${i}`;
      this.#toWire.set(n, w);
      this.#fromWire.set(w, n);
    }
  }
  wire(name: string): string {
    return this.#toWire.get(name) ?? name;
  }
  original(wire: string): string {
    return this.#fromWire.get(wire) ?? wire;
  }
}

/** Strip the credential from any text that came back from the server, and clip it. */
export function scrub(text: string, key: string | null): string {
  const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return key && key.length >= 4 ? clipped.split(key).join('[REDACTED]') : clipped;
}

export function err(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  action?: string,
): AgentErrorShape {
  const e: AgentErrorShape = { code, message: capitalize(message), retryable };
  if (action) e.action = action;
  return e;
}

export function stopError(code: ProviderErrorCode, message: string, retryable: boolean): StopEvent {
  return { type: 'stop', reason: 'error', error: err(code, message, retryable) };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function readCapped(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_ERROR_BODY);
  } catch {
    return '';
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolves true after `ms`, or false as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The key, resolved per request so a rotated key applies at once and the value is not held. */
export async function resolveKey(
  k: string | (() => Promise<string | null>) | undefined,
): Promise<string | null> {
  if (typeof k === 'function') return k();
  return k ?? null;
}

/** Normalize a base URL: http(s) only, no trailing slash, `/v1` appended when asked. */
export function normalizeBase(base: string, appendV1: boolean): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new NovaError('validation', 'the base URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new NovaError('validation', 'the base URL must use http or https');
  const trimmed = base.replace(/\/+$/, '');
  return appendV1 && !/\/v1$/.test(trimmed) ? `${trimmed}/v1` : trimmed;
}
