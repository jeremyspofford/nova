// The Screenpipe-compatible ingest adapter (M6 plan §1): it pulls a Screenpipe's REST API, so what
// an existing Screenpipe records (screen text by OCR, audio transcripts, the app and window it came
// from, accessibility text) flows into the Capture API unchanged.
//
//   GET /health                                    is it there at all
//   GET /search?content_type=ocr|audio|ui          items since start_time, newest first, paged by
//          &start_time=<ISO>&limit=&offset=        limit/offset, with pagination.total
//
// Its own cursor per content type: the newest timestamp taken and the ids taken at exactly that
// time (start_time is inclusive, so the boundary is read again and those are skipped). A Screenpipe
// that is down is a status and a problem, never a crash: the cursor stays where it was and the next
// pull carries on from it, so an outage loses nothing Screenpipe kept.
import type { Kind } from './rules.ts';

export const DEFAULT_URL = 'http://localhost:3030';
const TYPES = ['ocr', 'audio', 'ui'] as const;
type ContentType = (typeof TYPES)[number];
const KIND: Record<ContentType, Kind> = { ocr: 'screen', audio: 'audio', ui: 'screen' };
const PAGE = 100;
// At most this many pages per type per pull; more than this waits for the next pull.
const MAX_PAGES = 50;

export interface Cursor { [type: string]: { after: string; ids: string[] } }

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

type Fetch = typeof fetch;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

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

export class Screenpipe {
  readonly url: string;
  #fetch: Fetch;
  #timeoutMs: number;

  constructor(o: { url: string; fetch?: Fetch; timeoutMs?: number }) {
    this.url = o.url.replace(/\/+$/, '');
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 5000;
  }

  async #get(path: string): Promise<unknown> {
    let res: Response;
    try {
      // A redirect could take the pull somewhere the address didn't say: refused.
      res = await this.#fetch(`${this.url}${path}`, { redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
      throw new Unreachable(`Screenpipe at ${this.url} isn’t answering (${(e as Error)?.cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}).`);
    }
    if (!res.ok) throw new Unreachable(`Screenpipe at ${this.url} answered ${res.status}.`);
    try { return await res.json(); } catch { throw new Unreachable(`Something answered at ${this.url}, but not like Screenpipe does.`); }
  }

  async health(): Promise<{ status: string }> {
    const h = (await this.#get('/health')) as Record<string, unknown> | null;
    return { status: typeof h?.status === 'string' ? h.status : 'unknown' };
  }

  // Everything since the cursor, oldest first, and the cursor to keep once it is stored.
  async pull(cursor: Cursor, since: string): Promise<{ events: RawEvent[]; cursor: Cursor }> {
    await this.health();
    const events: RawEvent[] = [];
    const next: Cursor = { ...cursor };
    for (const type of TYPES) {
      const from = cursor[type] ?? { after: since, ids: [] };
      const seen = new Set(from.ids);
      const got: RawEvent[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ content_type: type, start_time: from.after, limit: String(PAGE), offset: String(page * PAGE) });
        const r = (await this.#get(`/search?${q}`)) as { data?: unknown[]; pagination?: { total?: number } } | null;
        const data = Array.isArray(r?.data) ? r.data : [];
        for (const item of data) {
          const e = normalize(type, item);
          if (e && !seen.has(e.external_id) && e.at >= from.after) got.push(e);
        }
        const total = typeof r?.pagination?.total === 'number' ? r.pagination.total : null;
        if (data.length < PAGE || (total !== null && (page + 1) * PAGE >= total)) break;
      }
      // New items arrive at the front while paging, so one can come twice: once is enough.
      const unique = [...new Map(got.map((e) => [e.external_id, e])).values()].sort((a, b) => a.at.localeCompare(b.at));
      if (unique.length) {
        const last = unique.at(-1)!.at;
        const atLast = unique.filter((e) => e.at === last).map((e) => e.external_id);
        next[type] = { after: last, ids: last === from.after ? [...seen, ...atLast] : atLast };
      } else if (!cursor[type]) next[type] = from;
      events.push(...unique);
    }
    return { events: events.sort((a, b) => a.at.localeCompare(b.at)), cursor: next };
  }
}
