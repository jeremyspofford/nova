// Console and network capture of the agent browser (docs/11 §4 "Observation", FR-092, FR-103).
// Each session keeps two bounded buffers in memory (never stored): console messages and uncaught
// page errors, and the page's requests. Everything is redacted when it is recorded, before the
// agent or the owner can read it:
//   - untrusted text is clipped before it is redacted (to twice its cap), then redacted, then
//     clipped to the cap: redaction runs on the event loop (M7 review finding 1);
//   - names that look secret (`isSecretName`: header names, query keys, JSON keys, `key=value`
//     and `"key":"value"` pairs in text) have their values masked; cookie, authorization and
//     set-cookie values never show;
//   - URL-valued headers (Location, Referer, Refresh, Link, …) are redacted as URLs;
//   - request bodies are never kept (a form may carry what the user typed into the private
//     sign-in form, FR-086);
//   - a response body is kept only for text types under the size cap; JSON (also behind an
//     anti-hijacking prefix or a JSONP callback) is masked by key;
//   - URLs lose their credentials and fragment;
//   - the session's redactor also masks the secrets it filled and the Hub's own literals.
// What the agent sees of it is page content: labelled, and scanned for instructions (FR-103).
import type { Redactor } from '@nova/security';
import { REDACTED } from '@nova/security';
import type {
  BrowserBodyOmitted,
  BrowserConsoleEntryView,
  BrowserConsoleLevel,
  BrowserNetworkEntryView,
} from '@nova/shared';

export const CONSOLE_MAX_ENTRIES = 300;
export const NETWORK_MAX_ENTRIES = 300;
/** Characters of one console message. */
export const CONSOLE_TEXT_MAX = 2_000;
/** A response body larger than this is not captured (docs/11 §4: bodies under a size cap). */
export const CAPTURE_BODY_MAX_BYTES = 16 * 1024;
const URL_MAX = 2_000;
const HEADER_VALUE_MAX = 300;
const HEADER_NAME_MAX = 100;
const MAX_HEADERS = 40;
const SHORT_MAX = 200;

/** A console message or an uncaught error, as the driver reports it. */
export interface RawConsoleEvent {
  level: string;
  text: string;
  source: 'console' | 'pageerror';
  url?: string | null;
  line?: number | null;
}

/** Network activity of the page by request id, as the driver reports it. */
export type RawNetworkEvent =
  | {
      phase: 'request';
      id: string;
      method: string;
      url: string;
      resourceType: string;
      navigation: boolean;
      headers: Record<string, string>;
    }
  | {
      phase: 'response';
      id: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
    }
  | { phase: 'body'; id: string; body: Uint8Array | null; omitted?: BrowserBodyOmitted }
  | { phase: 'done'; id: string; failure: string | null };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Untrusted text as the capture keeps it: clipped to twice the cap before any redaction, masked,
 * then clipped to the cap (a page controls the length, and redaction is not free).
 */
function bounded(text: unknown, max: number, mask: (s: string) => string): string {
  return clip(mask(String(text).slice(0, max * 2)), max);
}

/** Parts of a normalised name (lower case, letters and digits only) that mean a secret. */
const SECRET_PARTS =
  /token|secret|passw|passc|passp|session|csrf|xsrf|credential|signature|jwt|bearer|cookie|apikey|accesskey|privatekey|secretkey|authoriz|authtoken|authkey|oauth|saml|verifier|nonce|ticket/;
/** Whole words of a name that mean a secret (too short or common to match inside words). */
const SECRET_WORDS = new Set([
  'sid',
  'otp',
  'totp',
  'mfa',
  'pin',
  'pw',
  'pwd',
  'pass',
  'code',
  'key',
  'sig',
  'auth',
  'state',
  'hash',
  'hmac',
  'salt',
  'magic',
  'reset',
  'refresh',
  'sso',
]);

/**
 * Whether a header name, query key or JSON key names a secret (M7 review finding 2): decoded,
 * then lower-cased with separators removed and searched for secret parts (`sessionToken`,
 * `X-CSRFToken`, `aws_secret_access_key`), and split into words (camelCase, `-`, `_`) for the
 * short ones (`otp`, `pin`, `code`, `RelayState`). Masking a harmless value is the cheap error.
 */
export function isSecretName(name: string): boolean {
  let n = name.slice(0, SHORT_MAX);
  try {
    n = decodeURIComponent(n.replace(/\+/g, ' '));
  } catch {
    // Not percent-encoded: as it is.
  }
  if (SECRET_PARTS.test(n.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true;
  return n
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => SECRET_WORDS.has(w));
}

/** `key=value`, `key: value` and `"key":"value"` pairs; starts only where a name can start. */
const PAIR =
  /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1(\s{0,8}[:=]\s{0,8})("(?:[^"\\\n]|\\.){0,4096}"|'(?:[^'\\\n]|\\.){0,4096}'|[^\s&"',;<>{}()[\]]{1,4096})/g;
/** `<meta name="csrf-token" content="…">`, `<input name="authenticity_token" value="…">`. */
const HTML_PAIR =
  /(\bname\s{0,4}=\s{0,4})(["'])([^"'<>]{1,100})\2([^<>]{0,300}?\b(?:content|value)\s{0,4}=\s{0,4})(["'])([^"'<>]{0,4096})\5/gi;

function maskedValue(value: string): string {
  if (value.startsWith('"')) return `"${REDACTED}"`;
  if (value.startsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

/**
 * Text with the values of secret-named pairs masked, then the redactor's patterns and literals
 * (bodies that are not JSON, console messages, JSON string values).
 */
export function maskText(text: string, redactor: Redactor): string {
  const pairs = text
    .replace(PAIR, (m, q: string, key: string, sep: string, value: string) =>
      isSecretName(key) ? `${q}${key}${q}${sep}${maskedValue(value)}` : m,
    )
    .replace(HTML_PAIR, (m, pre: string, q: string, name: string, mid: string, q2: string) =>
      isSecretName(name) ? `${pre}${q}${name}${q}${mid}${q2}${REDACTED}${q2}` : m,
    );
  return redactor.redactString(pairs);
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/**
 * A URL as the capture keeps it: clipped first, no credentials, no fragment, the values of
 * secret-named query parameters masked, and the secret patterns masked in the path and in each
 * value (one at a time, so a match never swallows the parameters after it). The original
 * encoding is kept. A relative reference (a Location header) stays relative.
 */
export function redactUrl(raw: string, redactor: Redactor): string {
  const text = String(raw).slice(0, URL_MAX * 2);
  let out: string;
  try {
    const absolute = /^[a-z][a-z0-9+.-]{0,31}:/i.test(text);
    // Anything else that is not a relative reference is plain text.
    if (!absolute && !/^(?:\/|\?|\.{1,2}\/)/.test(text)) throw new Error('not a URL');
    const u = new URL(text, 'http://relative.invalid');
    if (absolute && u.protocol !== 'http:' && u.protocol !== 'https:')
      return bounded(text, URL_MAX, (t) => redactor.redactString(t));
    const path = redactor.redactString(decoded(u.pathname));
    const query = u.search
      .slice(1)
      .split('&')
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        const key = eq < 0 ? part : part.slice(0, eq);
        if (eq < 0) return redactor.redactString(key);
        if (isSecretName(decoded(key))) return `${key}=${REDACTED}`;
        const value = part.slice(eq + 1);
        const masked = redactor.redactString(decoded(value));
        return `${key}=${masked === decoded(value) ? value : masked}`;
      });
    // The path is checked decoded (a token in it may be percent-encoded) and kept as sent
    // when nothing in it is masked.
    out = `${absolute ? u.origin : ''}${path === decoded(u.pathname) ? u.pathname : path}${query.length ? `?${query.join('&')}` : ''}`;
  } catch {
    out = redactor.redactString(text);
  }
  return clip(out, URL_MAX);
}

/** Headers whose value is (or holds) a URL: redacted as URLs. */
function urlHeader(key: string, value: string, redactor: Redactor): string | null {
  switch (key) {
    case 'location':
    case 'content-location':
    case 'referer':
    case 'origin':
      return redactUrl(value, redactor);
    case 'refresh': {
      const m = /^(\s{0,8}\d{0,10}\s{0,8};?\s{0,8}url\s{0,8}=\s{0,8})(.*)$/i.exec(value);
      return m ? `${m[1]}${redactUrl(m[2]!, redactor)}` : redactor.redactString(value);
    }
    case 'link':
      return redactor.redactString(
        value.replace(/<([^<>]{0,4000})>/g, (_m, u: string) => `<${redactUrl(u, redactor)}>`),
      );
    default:
      return null;
  }
}

/**
 * Headers as the capture keeps them: names lower-cased and clipped, values of secret-named
 * headers masked, URL-valued headers redacted as URLs, other values masked and clipped.
 */
export function redactHeaders(
  headers: Record<string, string>,
  redactor: Redactor,
): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (n >= MAX_HEADERS) break;
    const key = name.slice(0, HEADER_NAME_MAX).toLowerCase();
    if (key.startsWith(':')) continue;
    n++;
    const raw = String(value).slice(0, Math.max(HEADER_VALUE_MAX, URL_MAX) * 2);
    const asUrl = urlHeader(key, raw, redactor);
    if (asUrl !== null) out[key] = clip(asUrl, HEADER_VALUE_MAX);
    else if (isSecretName(key)) out[key] = REDACTED;
    else out[key] = bounded(raw, HEADER_VALUE_MAX, (t) => redactor.redactString(t));
  }
  return out;
}

/** The media type of a content-type value, lower-cased, without parameters. */
export function mimeOf(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = contentType.slice(0, SHORT_MAX).split(';')[0]?.trim().toLowerCase();
  return m || null;
}

/** Text types whose bodies may be captured (a stream never ends, so it is not one). */
export function isTextType(mime: string | null): boolean {
  if (!mime || mime === 'text/event-stream') return false;
  return (
    mime.startsWith('text/') ||
    /^application\/(?:json|xml|javascript|ecmascript|x-javascript|graphql|x-ndjson|x-www-form-urlencoded)$/.test(
      mime,
    ) ||
    /^application\/[\w.-]+\+(?:json|xml)$/.test(mime) ||
    mime === 'image/svg+xml'
  );
}

/**
 * Whether the driver should read a response body: only text types, only when the declared length
 * is under the cap, and never for responses without one (redirects, 204, 304). Without a
 * declared length the driver reads it only after the request finished and its received size is
 * under the cap (`declared: false`).
 */
export function bodyPolicy(
  status: number,
  headers: Record<string, string>,
  cap: number,
): { read: true; declared: boolean } | { read: false; omitted: BrowserBodyOmitted } {
  if (cap <= 0) return { read: false, omitted: 'unavailable' };
  if ((status >= 300 && status < 400) || status === 204 || status === 304 || status < 200)
    return { read: false, omitted: 'none' };
  const h = lower(headers);
  if (!isTextType(mimeOf(h['content-type']))) return { read: false, omitted: 'binary' };
  const length = h['content-length'];
  const declared = length !== undefined && /^\d{1,15}$/.test(length.trim()) ? Number(length) : null;
  if (declared !== null && declared > cap) return { read: false, omitted: 'too_large' };
  return { read: true, declared: declared !== null };
}

function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (++n > MAX_HEADERS * 4) break;
    out[k.slice(0, HEADER_NAME_MAX).toLowerCase()] = v;
  }
  return out;
}

/** JSON behind an anti-hijacking prefix or inside a JSONP callback, as plain JSON text. */
export function jsonCandidate(text: string): string | null {
  let t = text.trimStart();
  t = t.replace(/^(?:\)\]\}'?,?|while\s{0,4}\(1\);|for\s{0,4}\(;;\);|&&&|\{\}&&)\s*/, '');
  const jsonp = /^[A-Za-z_$][\w$.]{0,100}\s{0,4}\(([\s\S]*)\)\s*;?\s*$/.exec(t);
  if (jsonp) t = jsonp[1]!.trim();
  return t.startsWith('{') || t.startsWith('[') ? t : null;
}

/** A parsed JSON value with secret-named keys masked and every string masked as text. */
function maskJson(value: unknown, redactor: Redactor, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (typeof value === 'string') return maskText(value, redactor);
  if (Array.isArray(value)) return value.map((v) => maskJson(v, redactor, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] =
        isSecretName(k) && v !== null && v !== '' ? REDACTED : maskJson(v, redactor, depth + 1);
    return out;
  }
  return value;
}

/**
 * A captured body as text: decoded, then JSON masked by key (also behind an anti-hijacking prefix
 * or a JSONP callback, and when served as another text type), anything else masked as text.
 */
export function bodyText(
  bytes: Uint8Array,
  mime: string | null,
  redactor: Redactor,
  cap = CAPTURE_BODY_MAX_BYTES,
): { body: string | null; omitted: BrowserBodyOmitted | null } {
  if (bytes.length > cap) return { body: null, omitted: 'too_large' };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const json = jsonCandidate(text);
  if (json !== null) {
    try {
      return {
        body: JSON.stringify(maskJson(JSON.parse(json) as unknown, redactor)),
        omitted: null,
      };
    } catch {
      // Not JSON after all: masked as text below.
    }
  }
  return { body: maskText(text, redactor), omitted: null };
}

const LEVELS: Record<string, BrowserConsoleLevel> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  warn: 'warning',
  info: 'info',
  log: 'log',
  debug: 'debug',
  trace: 'debug',
  verbose: 'debug',
};

export interface CaptureOptions {
  now: () => Date;
  /** The session's redactor (default rules plus the secrets it filled). */
  redactor: Redactor;
  max?: number;
}

/** The console of a session: a bounded buffer, newest last. */
export class ConsoleLog {
  readonly #o: CaptureOptions;
  readonly #max: number;
  #items: BrowserConsoleEntryView[] = [];
  #seq = 0;
  #dropped = 0;

  constructor(opts: CaptureOptions) {
    this.#o = opts;
    this.#max = opts.max ?? CONSOLE_MAX_ENTRIES;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get size(): number {
    return this.#items.length;
  }

  push(raw: RawConsoleEvent, pageUrl: string | null): void {
    const r = this.#o.redactor;
    this.#items.push({
      seq: ++this.#seq,
      at: this.#o.now().toISOString(),
      level: LEVELS[String(raw.level).slice(0, 20).toLowerCase()] ?? 'log',
      source: raw.source,
      text: bounded(raw.text, CONSOLE_TEXT_MAX, (t) => maskText(t, r)),
      url: raw.url ? redactUrl(raw.url, r) : null,
      line: typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : null,
      pageUrl: pageUrl && /^https?:/i.test(pageUrl) ? redactUrl(pageUrl, r) : null,
    });
    while (this.#items.length > this.#max) {
      this.#items.shift();
      this.#dropped++;
    }
  }

  /** The newest `limit` entries (oldest of them first), of some levels, after a number. */
  entries(q: { levels?: readonly BrowserConsoleLevel[]; limit?: number; after?: number } = {}) {
    const items = this.#items.filter(
      (e) =>
        (!q.levels?.length || q.levels.includes(e.level)) &&
        (q.after === undefined || e.seq > q.after),
    );
    const limit = q.limit ?? this.#max;
    return { items: items.slice(-limit), total: items.length, dropped: this.#dropped };
  }

  clear(): void {
    this.#items = [];
  }
}

/** The network activity of a session: a bounded buffer of requests by id, newest last. */
export class NetworkLog {
  readonly #o: CaptureOptions;
  readonly #max: number;
  /** Insertion order is request order. */
  readonly #items = new Map<string, BrowserNetworkEntryView & { startedMs: number }>();
  #seq = 0;
  #dropped = 0;

  constructor(opts: CaptureOptions) {
    this.#o = opts;
    this.#max = opts.max ?? NETWORK_MAX_ENTRIES;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get size(): number {
    return this.#items.size;
  }

  apply(ev: RawNetworkEvent): void {
    const r = this.#o.redactor;
    if (ev.phase === 'request') {
      if (!/^https?:/i.test(String(ev.url).slice(0, 8))) return;
      const at = this.#o.now();
      this.#items.set(ev.id, {
        seq: ++this.#seq,
        at: at.toISOString(),
        startedMs: at.getTime(),
        method: clip(String(ev.method).slice(0, 20).toUpperCase(), 10),
        url: redactUrl(ev.url, r),
        resourceType: clip(String(ev.resourceType || 'other').slice(0, 60), 30),
        navigation: ev.navigation,
        status: null,
        statusText: null,
        mimeType: null,
        size: null,
        durationMs: null,
        failure: null,
        blocked: false,
        requestHeaders: redactHeaders(ev.headers, r),
        responseHeaders: {},
        body: null,
        bodyOmitted: null,
      });
      while (this.#items.size > this.#max) {
        const first = this.#items.keys().next().value;
        if (first === undefined) break;
        this.#items.delete(first);
        this.#dropped++;
      }
      return;
    }
    const e = this.#items.get(ev.id);
    if (!e) return;
    switch (ev.phase) {
      case 'response': {
        e.status = Number.isInteger(ev.status) ? ev.status : null;
        e.statusText = bounded(ev.statusText ?? '', 100, (t) => r.redactString(t)) || null;
        e.responseHeaders = redactHeaders(ev.headers, r);
        e.mimeType = mimeOf(e.responseHeaders['content-type']);
        const declared = Number(e.responseHeaders['content-length']);
        if (Number.isFinite(declared) && declared >= 0) e.size = declared;
        return;
      }
      case 'body': {
        if (!ev.body) {
          e.bodyOmitted = ev.omitted ?? 'unavailable';
          return;
        }
        // A body of a type that is not text is never kept, whatever the driver sent.
        if (!isTextType(e.mimeType)) {
          e.bodyOmitted = 'binary';
          return;
        }
        const t = bodyText(ev.body, e.mimeType, r);
        e.body = t.body;
        e.bodyOmitted = t.omitted;
        e.size = ev.body.length;
        return;
      }
      case 'done': {
        e.durationMs = Math.max(0, this.#o.now().getTime() - e.startedMs);
        if (ev.failure) {
          e.failure = bounded(ev.failure, 200, (t) => r.redactString(t));
          e.blocked = /BLOCKED_BY_CLIENT|blockedbyclient/i.test(ev.failure.slice(0, 400));
        }
        return;
      }
    }
  }

  /** The newest `limit` requests (oldest of them first), filtered. */
  entries(q: { contains?: string; failedOnly?: boolean; limit?: number; after?: number } = {}) {
    let items = [...this.#items.values()].map(({ startedMs: _s, ...v }) => v);
    if (q.after !== undefined) items = items.filter((e) => e.seq > q.after!);
    if (q.contains) {
      const needle = q.contains.toLowerCase();
      items = items.filter((e) => e.url.toLowerCase().includes(needle));
    }
    if (q.failedOnly)
      items = items.filter((e) => e.failure !== null || (e.status !== null && e.status >= 400));
    const limit = q.limit ?? this.#max;
    return { items: items.slice(-limit), total: items.length, dropped: this.#dropped };
  }

  clear(): void {
    this.#items.clear();
  }
}

/** A short size: 900 B, 1.2 KB, 3.4 MB. */
function size(n: number | null): string | null {
  if (n === null) return null;
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** The console entries as the agent reads them. */
export function formatConsole(
  r: { items: BrowserConsoleEntryView[]; total: number; dropped: number },
  maxChars: number,
): string {
  const head = `Console (${r.items.length} of ${r.total} message${r.total === 1 ? '' : 's'}, oldest first${r.dropped ? `; ${r.dropped} older ones were dropped` : ''}):`;
  if (!r.items.length) return `${head}\n(none)`;
  const lines: string[] = [head];
  let used = head.length;
  for (const e of r.items) {
    const where = e.url ? ` (${e.url}${e.line !== null ? `:${e.line}` : ''})` : '';
    const line = `#${e.seq} [${e.at}] ${e.level}${e.source === 'pageerror' ? ' (uncaught)' : ''}: ${e.text}${where}`;
    if (used + line.length > maxChars) {
      lines.push('… (more messages did not fit)');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function headerLine(h: Record<string, string>): string {
  const parts = Object.entries(h).map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join('; ') : '(none)';
}

/** The network entries as the agent reads them; `details` adds headers and bodies. */
export function formatNetwork(
  r: { items: BrowserNetworkEntryView[]; total: number; dropped: number },
  opts: { details: boolean; maxChars: number },
): string {
  const head = `Network (${r.items.length} of ${r.total} request${r.total === 1 ? '' : 's'}, oldest first${r.dropped ? `; ${r.dropped} older ones were dropped` : ''}):`;
  if (!r.items.length) return `${head}\n(none)`;
  const lines: string[] = [head];
  let used = head.length;
  for (const e of r.items) {
    const outcome = e.blocked
      ? 'blocked (not on the allow list)'
      : e.failure
        ? `failed: ${e.failure}`
        : e.status !== null
          ? `${e.status}${e.statusText ? ` ${e.statusText}` : ''}`
          : 'pending';
    const facts = [
      e.resourceType,
      e.mimeType,
      size(e.size),
      e.durationMs !== null ? `${e.durationMs} ms` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const block = [`#${e.seq} ${e.method} ${e.url} -> ${outcome}${facts ? ` (${facts})` : ''}`];
    if (opts.details) {
      block.push(`  request headers: ${headerLine(e.requestHeaders)}`);
      if (e.status !== null) block.push(`  response headers: ${headerLine(e.responseHeaders)}`);
      if (e.body !== null)
        block.push(`  body: ${e.body.length > 4_000 ? `${e.body.slice(0, 3_999)}…` : e.body}`);
      else if (e.bodyOmitted && e.bodyOmitted !== 'none')
        block.push(
          `  body: not captured (${e.bodyOmitted === 'too_large' ? `larger than ${CAPTURE_BODY_MAX_BYTES / 1024} KB` : e.bodyOmitted === 'binary' ? 'not a text type' : 'not available'})`,
        );
    }
    const text = block.join('\n');
    if (used + text.length > opts.maxChars) {
      lines.push('… (more requests did not fit)');
      break;
    }
    lines.push(text);
    used += text.length + 1;
  }
  return lines.join('\n');
}
