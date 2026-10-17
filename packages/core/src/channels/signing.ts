// Request authentication for the public channel, trigger and MCP event endpoints (docs/13 §4,
// docs/09 §7, FR-201): HMAC-SHA256 signatures compared in constant time, bearer tokens, and a
// five-minute replay window on signed timestamps. Every check fails closed.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { NovaError } from '@nova/shared';

/** Signed requests older or newer than this are refused (replay window). */
export const REPLAY_WINDOW_MS = 5 * 60_000;

export type Headers = Record<string, string | string[] | undefined>;

/** A header value by case-insensitive name (the first one when repeated). */
export function headerOf(headers: Headers, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function hmacHex(secret: string, data: string | Uint8Array): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time string comparison (different lengths compare unequal). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Whether a timestamp in Unix seconds (or ISO-8601) lies within the replay window of `now`.
 * Anything unparseable is stale.
 */
export function freshTimestamp(
  value: string | undefined,
  now: number,
  windowMs = REPLAY_WINDOW_MS,
) {
  if (!value) return false;
  const t = /^\d{1,12}$/.test(value) ? Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(t) && Math.abs(now - t) <= windowMs;
}

export function concat(...parts: (string | Uint8Array)[]): Buffer {
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p)));
}

/**
 * `sha256=<hex>` over `<timestamp>.<body>`, the scheme of Nova's outbound webhooks; with an event
 * id, over `<timestamp>.<event id>.<body>` (webhook triggers that send `x-nova-event-id`).
 */
export function signBody(
  secret: string,
  timestamp: string,
  body: string | Uint8Array,
  eventId?: string | null,
): string {
  // An event id used for dedupe is signed too, so a replay cannot pass as a new event.
  const head = eventId ? `${timestamp}.${eventId}` : timestamp;
  return `sha256=${hmacHex(secret, concat(head, '.', body))}`;
}

/** The bearer token of an Authorization header, or null. */
export function bearerOf(headers: Headers): string | null {
  const h = headerOf(headers, 'authorization');
  if (!h?.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t || null;
}

/** 401: the request did not prove who sent it. The reason is for the log, not a secret. */
export function unauthorized(reason: string): NovaError {
  return new NovaError('token_required', `the request is not authenticated: ${reason}`, {
    details: { reason },
  });
}
