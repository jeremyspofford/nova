// The Screenpipe-compatible ingest adapter (M6 plan §1): it pulls a Screenpipe's REST API, so what
// an existing Screenpipe records (screen text by OCR, audio transcripts, the app and window it came
// from, accessibility text) flows into the Capture API unchanged.
//
//   GET /health                                    is it there at all
//   GET /search?content_type=ocr|audio|ui          items from start_time to end_time (both
//          &start_time=&end_time=&limit=&offset=   inclusive), newest first, with pagination.total
//
// Screenpipe answers newest first, so a backlog is read oldest first by windows of time: a window
// holding more than WINDOW_MAX items is narrowed until it doesn't, then read whole, page by page.
// Each content type keeps its own cursor: how far it has read (never past the end of the last
// window read whole) and the ids it took lately. Each pull asks again from a few minutes before
// that (the lookback), so an item Screenpipe reports late with an older time still arrives, and the
// ids keep anything from arriving twice. A backlog bigger than one pull carries on at the next.
//
// Screenpipe 0.4 can require an API key (its Settings > Privacy): with one set, every request carries
// it as "Authorization: Bearer <key>"; without, none does. A 401 or 403 is Screenpipe refusing Nova,
// a state of its own (KeyRefused), never "isn't answering". The key is never put in a message.
//
// A Screenpipe that is down is a status and a problem, never a crash: the cursor stays where it
// was, so what Screenpipe kept meanwhile arrives once it answers. What Screenpipe itself never kept
// (it wasn't running) can't arrive, and an item reported later than the lookback is missed.
import { instant, type Kind } from './rules.ts';

export const DEFAULT_URL = 'http://localhost:3030';
const TYPES = ['ocr', 'audio', 'ui'] as const;
type ContentType = (typeof TYPES)[number];
const KIND: Record<ContentType, Kind> = { ocr: 'screen', audio: 'audio', ui: 'screen' };
const PAGE = 100;
// Requests per content type per pull. A bigger backlog carries on at the next pull, from the end of
// the last window read whole.
const MAX_REQUESTS = 60;
// A window of time is read whole only when it holds at most this many items (ten pages).
const WINDOW_MAX = 1000;
// Narrower than this, a window is read whole however full it is: nothing else would get past it.
const MIN_SPAN_MS = 1000;
// How far back each pull asks again, for items Screenpipe reports late.
export const DEFAULT_LOOKBACK_MS = 5 * 60_000;
// One answer bigger than this is refused rather than read into memory (a page is 100 items).
const MAX_BYTES = 16 * 1024 * 1024;

// `seen`: [id, time] taken within the lookback. `ids` is the older shape (all at `after`).
export interface TypeCursor { after: string; seen?: [string, string][]; ids?: string[] }
export interface Cursor { [type: string]: TypeCursor }

// One captured item as an adapter hands it to the Capture API, before any rule has looked at it.
export interface RawEvent {
  external_id: string;
  kind: Kind;
  at: string;
  ended_at?: string | null;
  app?: string | null;
  window_title?: string | null;
  url?: string | null;
  text?: string | null;
  private?: boolean;
}

export class Unreachable extends Error {}
// Screenpipe answered but refused Nova: it wants an API key, or not the one Nova sent.
export class KeyRefused extends Error {
  readonly hadKey: boolean;
  constructor(hadKey: boolean) {
    super(hadKey
      ? 'Screenpipe answered but refused the API key Nova has; check it against the one in Screenpipe’s Settings > Privacy.'
      : 'Screenpipe answered but refused Nova; it needs the API key from Screenpipe’s Settings > Privacy.');
    this.hadKey = hadKey;
  }
}

type Fetch = typeof fetch;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
// Screenpipe keeps its times in UTC; one written without a zone is read as UTC, never as the
// server's local time.
const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const iso = (v: unknown): string | null => instant(v) ?? (typeof v === 'string' && NAIVE.test(v.trim()) ? instant(`${v.trim().replace(' ', 'T')}Z`) : null);

// One Screenpipe item → a raw event, or null for one this adapter can't read (skipped, not fatal).
export function normalize(type: ContentType, item: unknown): RawEvent | null {
  const c = (typeof item === 'object' && item !== null ? (item as Record<string, unknown>).content : null) as Record<string, unknown> | null;
  if (!c) return null;
  const at = iso(c.timestamp);
  const id = c.frame_id ?? c.chunk_id ?? c.id;
  if (!at || (typeof id !== 'number' && typeof id !== 'string')) return null;
  const text = type === 'audio' ? str(c.transcription) : str(c.text);
  return {
    external_id: `${type}:${id}`,
    kind: KIND[type],
    at,
    app: type === 'audio' ? null : str(c.app_name),
    window_title: type === 'audio' ? str(c.device_name) : str(c.window_name),
    url: str(c.browser_url),
    text,
    ...(c.private === true || c.incognito === true ? { private: true } : {}),
  };
}

interface Page { items: RawEvent[]; count: number; newest: string | null; total: number | null }

const latest = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);
const plus = (t: string, ms: number) => new Date(Date.parse(t) + ms).toISOString();

export class Screenpipe {
  readonly url: string;
  #fetch: Fetch;
  #timeoutMs: number;
  #lookbackMs: number;
  #maxBytes: number;
  #apiKey: string | null;

  constructor(o: { url: string; apiKey?: string | null; fetch?: Fetch; timeoutMs?: number; lookbackMs?: number; maxBytes?: number }) {
    this.url = o.url.replace(/\/+$/, '');
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 5000;
    this.#lookbackMs = o.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.#maxBytes = o.maxBytes ?? MAX_BYTES;
    this.#apiKey = o.apiKey || null;
  }

  async #get(path: string): Promise<unknown> {
    let res: Response;
    try {
      // A redirect could take the pull somewhere the address didn't say: refused.
      const headers: Record<string, string> = { accept: 'application/json', ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}) };
      res = await this.#fetch(`${this.url}${path}`, { redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs), headers });
    } catch (e) {
      throw new Unreachable(`Screenpipe at ${this.url} isn’t answering (${(e as Error)?.cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}).`);
    }
    if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); throw new KeyRefused(this.#apiKey !== null); }
    if (!res.ok) throw new Unreachable(`Screenpipe at ${this.url} answered ${res.status}.`);
    const tooMuch = () => new Unreachable(`Screenpipe at ${this.url} answered with too much at once (over ${Math.round(this.#maxBytes / 1024 / 1024)} MB), so Nova didn’t read it.`);
    if (Number(res.headers.get('content-length')) > this.#maxBytes) { await res.body?.cancel().catch(() => {}); throw tooMuch(); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = res.body?.getReader();
      for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
        size += r.value.byteLength;
        if (size > this.#maxBytes) { await reader!.cancel().catch(() => {}); throw tooMuch(); }
        chunks.push(r.value);
      }
    } catch (e) {
      if (e instanceof Unreachable) throw e;
      throw new Unreachable(`Screenpipe at ${this.url} stopped answering partway (${(e as Error).message}).`);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Unreachable(`Something answered at ${this.url}, but not like Screenpipe does.`); }
  }

  async health(): Promise<{ status: string }> {
    const h = (await this.#get('/health')) as Record<string, unknown> | null;
    return { status: typeof h?.status === 'string' ? h.status : 'unknown' };
  }

  async #search(type: ContentType, start: string, end: string | null, offset: number): Promise<Page> {
    const q = new URLSearchParams({ content_type: type, start_time: start, limit: String(PAGE), offset: String(offset) });
    if (end) q.set('end_time', end);
    const r = (await this.#get(`/search?${q}`)) as { data?: unknown[]; pagination?: { total?: number } } | null;
    const data = Array.isArray(r?.data) ? r.data : [];
    const items = data.map((item) => normalize(type, item)).filter((e): e is RawEvent => e !== null);
    return { items, count: data.length, newest: items.reduce<string | null>((m, e) => latest(m, e.at), null), total: typeof r?.pagination?.total === 'number' ? r.pagination.total : null };
  }

  // Everything since the cursor, oldest first, and the cursor to keep once it is stored.
  async pull(cursor: Cursor, since: string): Promise<{ events: RawEvent[]; cursor: Cursor }> {
    await this.health();
    const events: RawEvent[] = [];
    const next: Cursor = { ...cursor };
    for (const type of TYPES) {
      const r = await this.#pullType(type, cursor[type] ?? { after: since }, since);
      next[type] = r.cursor;
      events.push(...r.events);
    }
    return { events: events.sort((a, b) => a.at.localeCompare(b.at)), cursor: next };
  }

  async #pullType(type: ContentType, from: TypeCursor, since: string): Promise<{ events: RawEvent[]; cursor: TypeCursor }> {
    const seen = new Map<string, string>(Array.isArray(from.seen) ? from.seen : []);
    for (const id of from.ids ?? []) if (!seen.has(id)) seen.set(id, from.after);
    const got: RawEvent[] = [];
    const take = (items: RawEvent[]) => { for (const e of items) { if (seen.has(e.external_id)) continue; seen.set(e.external_id, e.at); got.push(e); } };
    // Ask again from a little before where the last pull reached, but never from before consent.
    let lo = latest(since, plus(from.after, -this.#lookbackMs))!;
    // Everything up to here has been read: the cursor never moves past it.
    let reached = from.after;
    let span: number | null = null;
    let newestKnown: string | null = null;
    let requests = 0;
    let progressed = false;
    while (requests < MAX_REQUESTS) {
      // The last window is open-ended: it runs to whatever Screenpipe has now.
      let hi = span === null ? null : plus(lo, span);
      if (hi !== null && newestKnown !== null && hi >= newestKnown) hi = null;
      const first = await this.#search(type, lo, hi, 0);
      requests++;
      const fits = first.total !== null ? first.total <= WINDOW_MAX : first.count < PAGE;
      if (hi === null) newestKnown = latest(newestKnown, first.newest);
      const width = hi === null ? Date.parse(newestKnown ?? lo) - Date.parse(lo) : span!;
      if (!fits && width > MIN_SPAN_MS) {
        // Too full: narrow it to about half a window's worth, at most half as wide.
        const share = Math.floor((width * (WINDOW_MAX / 2)) / (first.total ?? WINDOW_MAX * 2));
        span = Math.max(MIN_SPAN_MS, Math.min(Math.floor(width / 2), share));
        continue;
      }
      // Read it whole, or leave it for the next pull when what's left of this one can't.
      const pages = first.total !== null ? Math.ceil(first.total / PAGE) : 1;
      if (progressed && pages - 1 > MAX_REQUESTS - requests) break;
      take(first.items);
      let newest = first.newest;
      // Paged until a short page, not by the first total: items arriving meanwhile push older ones
      // to later pages, and those must still be read (any read twice are skipped by id).
      for (let offset = PAGE, count = first.count; count === PAGE && requests < MAX_REQUESTS * 2; offset += PAGE) {
        const page = await this.#search(type, lo, hi, offset);
        requests++;
        take(page.items);
        newest = latest(newest, page.newest);
        count = page.count;
      }
      progressed = true;
      if (hi === null) { reached = latest(reached, newest)!; break; }
      reached = latest(reached, hi)!;
      lo = hi;
      // A sparse stretch: wider windows from here.
      if ((first.total ?? WINDOW_MAX) < WINDOW_MAX / 4) span = span! * 2;
    }
    // Only the ids the next pull can see again are kept.
    const keepFrom = plus(reached, -this.#lookbackMs);
    return { events: got, cursor: { after: reached, seen: [...seen].filter(([, at]) => at >= keepFrom) } };
  }
}
