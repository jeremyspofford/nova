// The import offer during setup (Amendment 2026-10-31-B Part 2; docs/plans/M10f.md §3): notes and
// files, a calendar, browser bookmarks, so memory isn't empty on day two. Consent first:
//   - finding a source lists folders and files by name only, and reads nothing (`findSources`);
//   - only what the person picks is read (`importSources`), and every file passes the ingest gate as
//     outside content of unknown provenance, as `self.importPack` does for a memory export. A block
//     holds that file back with the reason; everything else becomes a memory candidate, waiting in
//     Memory for the person's OK, out of every prompt. None of it is memory until they keep it.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SourceKind = 'notes' | 'calendar' | 'bookmarks';
export interface Source { id: string; kind: SourceKind; label: string; path: string; files: number; app: string | null }
export interface Imported { id: string; label: string; waiting: number; held: number; skipped: number; said: string }

const MAX_FILE = 256 * 1024;
const MAX_NOTES = 50;
// What setup reads at most of one source (review finding 10): a calendar file, a Chromium-family
// Bookmarks file, a Firefox places database.
export const MAX_ICS_BYTES = 1024 * 1024;
export const MAX_BOOKMARKS_BYTES = 8 * 1024 * 1024;
export const MAX_PLACES_BYTES = 64 * 1024 * 1024;

export class NotPlain extends Error {}
export class TooLarge extends Error {}

// Reads a file as it is now (review finding 10): not through a link, never blocking on a pipe or a
// device, a regular file only, and no more than `max` bytes. What was listed at discovery may have
// been swapped since.
export function readPlain(path: string, max: number): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new NotPlain('It isn’t a plain file now (a link, or gone).'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new NotPlain('It isn’t a plain file now.');
    if (st.size > max) throw new TooLarge('It is larger than Nova reads during setup.');
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) { const n = readSync(fd, buf, got, st.size - got, got); if (!n) break; got += n; }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}
const NOTE_EXT = new Set(['.md', '.markdown', '.txt']);

// "~/Notes" for a path in the person's home, so a screen never shows the full path.
export const tilde = (userHome: string, p: string) => (p === userHome ? '~' : p.startsWith(userHome + sep) ? `~/${relative(userHome, p).split(sep).join('/')}` : p);

const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { const s = lstatSync(p); return s.isFile() && s.size <= 64 * 1024 * 1024; } catch { return false; } };

function noteFiles(dir: string, depth = 0, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    if (out.length >= 500 || n.startsWith('.')) continue;
    const p = join(dir, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (depth < 2) noteFiles(p, depth + 1, out); continue; }
    if (st.isFile() && NOTE_EXT.has(extname(n).toLowerCase())) out.push(p);
  }
  return out;
}

// Where browsers keep bookmarks, per platform. Chromium-family browsers keep a JSON file; Firefox a
// SQLite database (read from a copy, since Firefox holds it open).
function bookmarkFiles(userHome: string, platform: string): { app: string; path: string; kind: 'chromium' | 'firefox' }[] {
  const out: { app: string; path: string; kind: 'chromium' | 'firefox' }[] = [];
  const chromium: [string, string][] = platform === 'darwin'
    ? [['Chrome', 'Library/Application Support/Google/Chrome'], ['Chromium', 'Library/Application Support/Chromium'], ['Brave', 'Library/Application Support/BraveSoftware/Brave-Browser'], ['Edge', 'Library/Application Support/Microsoft Edge']]
    : platform === 'win32'
      ? [['Chrome', 'AppData/Local/Google/Chrome/User Data'], ['Edge', 'AppData/Local/Microsoft/Edge/User Data'], ['Brave', 'AppData/Local/BraveSoftware/Brave-Browser/User Data']]
      : [['Chrome', '.config/google-chrome'], ['Chromium', '.config/chromium'], ['Brave', '.config/BraveSoftware/Brave-Browser'], ['Edge', '.config/microsoft-edge']];
  for (const [app, dir] of chromium) {
    const f = join(userHome, dir, 'Default', 'Bookmarks');
    if (isFile(f)) out.push({ app, path: f, kind: 'chromium' });
  }
  const ff = platform === 'darwin' ? join(userHome, 'Library/Application Support/Firefox/Profiles') : platform === 'win32' ? join(userHome, 'AppData/Roaming/Mozilla/Firefox/Profiles') : join(userHome, '.mozilla/firefox');
  if (isDir(ff)) for (const prof of (() => { try { return readdirSync(ff).sort(); } catch { return []; } })()) {
    const f = join(ff, prof, 'places.sqlite');
    if (isFile(f)) { out.push({ app: 'Firefox', path: f, kind: 'firefox' }); break; }
  }
  return out;
}

// What could be brought in, by place and count, with nothing read.
export function findSources(userHome: string, platform: string = process.platform): Source[] {
  const out: Source[] = [];
  for (const rel of ['Notes', 'notes', 'Documents/Notes', 'Documents/notes', 'Obsidian', 'Documents/Obsidian']) {
    const dir = join(userHome, rel);
    if (!isDir(dir) || out.some((s) => s.path === dir)) continue;
    const files = noteFiles(dir).length;
    if (files) out.push({ id: `notes:${rel}`, kind: 'notes', label: `notes in ${tilde(userHome, dir)}`, path: dir, files, app: null });
  }
  for (const rel of ['', 'Documents', 'Downloads', 'Calendar']) {
    const dir = join(userHome, rel);
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.ics')).sort(); } catch { continue; }
    for (const n of names.slice(0, 3)) {
      const f = join(dir, n);
      if (isFile(f)) out.push({ id: `calendar:${tilde(userHome, f)}`, kind: 'calendar', label: `a calendar file, ${tilde(userHome, f)}`, path: f, files: 1, app: null });
    }
  }
  for (const b of bookmarkFiles(userHome, platform)) out.push({ id: `bookmarks:${b.app.toLowerCase()}`, kind: 'bookmarks', label: `bookmarks from ${b.app}`, path: b.path, files: 1, app: b.app });
  return out.slice(0, 12);
}

// ---- reading what was picked -------------------------------------------------------------------

const plain = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

// A note as a memory: its title and its opening words.
export function noteMemory(file: string, text: string): string {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const heading = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, '');
  const title = plain(heading ?? basename(file, extname(file)));
  const body = plain(lines.filter((l) => l !== `# ${heading}` && !/^#/.test(l)).join(' '));
  const words = body.length > 400 ? `${body.slice(0, 400).replace(/\s+\S*$/, '')}…` : body;
  return words ? `Note “${title}”: ${words}` : `Note “${title}”.`;
}

export interface Bookmark { title: string; url: string; folder: string }

export function chromiumBookmarks(json: string): Bookmark[] {
  const out: Bookmark[] = [];
  const walk = (node: unknown, folder: string) => {
    if (!node || typeof node !== 'object' || out.length >= 2000) return;
    const n = node as { type?: string; name?: string; url?: string; children?: unknown[] };
    if (n.type === 'url' && typeof n.url === 'string') out.push({ title: plain(String(n.name ?? '')) || n.url, url: n.url, folder });
    if (Array.isArray(n.children)) for (const c of n.children) walk(c, n.type === 'folder' && n.name ? plain(n.name) : folder);
  };
  const j = JSON.parse(json) as { roots?: Record<string, unknown> };
  for (const [k, root] of Object.entries(j.roots ?? {})) walk(root, k === 'bookmark_bar' ? 'Bookmarks bar' : k === 'other' ? 'Other bookmarks' : k);
  return out;
}

export function firefoxBookmarks(file: string): Bookmark[] {
  const dir = mkdtempSync(join(tmpdir(), 'nova-places-'));
  try {
    const copy = join(dir, 'places.sqlite');
    writeFileSync(copy, readPlain(file, MAX_PLACES_BYTES), { mode: 0o600 });
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT b.title AS title, p.url AS url, f.title AS folder FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk LEFT JOIN moz_bookmarks f ON f.id = b.parent WHERE b.type = 1 AND p.url NOT LIKE 'place:%' LIMIT 2000`).all() as { title: string | null; url: string; folder: string | null }[];
      return rows.map((r) => ({ title: plain(r.title ?? '') || r.url, url: r.url, folder: plain(r.folder ?? '') || 'Bookmarks' }));
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u.slice(0, 40); } };

// Bookmarks as memories: one per folder, naming what is in it.
export function bookmarkMemories(list: Bookmark[], app: string): string[] {
  const folders = new Map<string, Bookmark[]>();
  for (const b of list) if (/^https?:/i.test(b.url)) folders.set(b.folder, [...(folders.get(b.folder) ?? []), b]);
  return [...folders].slice(0, 20).map(([folder, items]) => {
    const shown = items.slice(0, 12).map((b) => `${b.title.slice(0, 60)} (${host(b.url)})`).join('; ');
    return `Has ${items.length} ${app} bookmark${items.length === 1 ? '' : 's'} in “${folder}”: ${shown}${items.length > 12 ? '; and more' : ''}.`;
  });
}

export interface CalEvent { summary: string; start: string; location: string | null }

// VEVENTs from an iCalendar file: summary, start date and place (folded lines unfolded).
export function icsEvents(text: string): CalEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: CalEvent[] = [];
  let cur: Partial<CalEvent> | null = null;
  const unescape = (v: string) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { if (cur?.summary && cur.start) out.push({ summary: cur.summary, start: cur.start, location: cur.location ?? null }); cur = null; }
    else if (cur) {
      const m = /^([A-Z-]+)(;[^:]*)?:(.*)$/.exec(l);
      if (!m) continue;
      if (m[1] === 'SUMMARY') cur.summary = plain(unescape(m[3]!)).slice(0, 120);
      if (m[1] === 'LOCATION') cur.location = plain(unescape(m[3]!)).slice(0, 80) || null;
      if (m[1] === 'DTSTART') { const d = /^(\d{4})(\d{2})(\d{2})/.exec(m[3]!); if (d) cur.start = `${d[1]}-${d[2]}-${d[3]}`; }
    }
    if (out.length >= 500) break;
  }
  return out;
}

// Upcoming events first, then the most recent: the ones worth remembering.
export function calendarMemories(events: CalEvent[], now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const next = events.filter((e) => e.start >= today).sort((a, b) => a.start.localeCompare(b.start));
  const past = events.filter((e) => e.start < today).sort((a, b) => b.start.localeCompare(a.start));
  return [...next.slice(0, 20), ...past.slice(0, 10)].map((e) => `${e.start >= today ? 'Has' : 'Had'} “${e.summary}” on ${e.start}${e.location ? ` at ${e.location}` : ''}.`);
}

export interface Gate {
  // The ingest gate's screen of one file's text, as outside content of unknown provenance.
  screen(text: string, origin: string): Promise<{ verdict: 'pass' | 'quarantine' | 'block'; taint: unknown }>;
  // Nova's own checks on each record, as importPack does: a block holds that record back; a flagged
  // one waits flagged, with its own screen in its taint.
  screenNow(text: string, origin: string): { verdict: 'pass' | 'quarantine' | 'block'; taint: unknown; flagged: boolean };
  // A memory waiting for the person's OK.
  candidate(c: { kind: string; content: string; source: string; taint: unknown[] }): void;
  // What is kept already or already waiting, by its words, lower case.
  kept(): Set<string>;
}

// Reads only what was picked, screens each file, and leaves each memory waiting for the person.
export async function importSources(picked: readonly Source[], gate: Gate, o: { userHome: string; now: Date }): Promise<Imported[]> {
  const out: Imported[] = [];
  const have = gate.kept();
  const offer = (r: Imported, kind: string, items: string[], source: string, origin: string, taint: unknown) => {
    for (const content of items) {
      const key = content.toLowerCase();
      if (!content || have.has(key)) { r.skipped++; continue; }
      const own = gate.screenNow(content, origin);
      if (own.verdict === 'block') { r.held++; continue; }
      have.add(key);
      gate.candidate({ kind, content, source, taint: own.flagged ? [taint, own.taint] : [taint] });
      r.waiting++;
    }
  };
  for (const s of picked) {
    const r: Imported = { id: s.id, label: s.label, waiting: 0, held: 0, skipped: 0, said: '' };
    try {
      if (s.kind === 'notes') {
        const files = noteFiles(s.path);
        r.skipped += Math.max(0, files.length - MAX_NOTES);
        for (const f of files.slice(0, MAX_NOTES)) {
          let text: string;
          try { text = readPlain(f, MAX_FILE).toString('utf8'); } catch (e) { if (e instanceof NotPlain || e instanceof TooLarge) { r.skipped++; continue; } throw e; }
          const where = tilde(o.userHome, f);
          const screened = await gate.screen(text, where);
          if (screened.verdict === 'block') { r.held++; continue; }
          offer(r, 'fact', [noteMemory(f, text)], `imported from ${where}`, where, screened.taint);
        }
      } else if (s.kind === 'calendar') {
        const text = readPlain(s.path, MAX_ICS_BYTES).toString('utf8');
        const where = tilde(o.userHome, s.path);
        const screened = await gate.screen(text, where);
        if (screened.verdict === 'block') r.held++;
        else offer(r, 'timeline', calendarMemories(icsEvents(text), o.now), `imported from ${where}`, where, screened.taint);
      } else {
        const list = s.path.endsWith('.sqlite') ? firefoxBookmarks(s.path) : chromiumBookmarks(readPlain(s.path, MAX_BOOKMARKS_BYTES).toString('utf8'));
        const memories = bookmarkMemories(list, s.app ?? 'browser');
        const origin = `${s.app ?? 'browser'} bookmarks`;
        const screened = await gate.screen(memories.join('\n'), origin);
        if (screened.verdict === 'block') r.held++;
        else offer(r, 'fact', memories, `imported from ${origin}`, origin, screened.taint);
      }
    } catch (e) {
      r.said = e instanceof NotPlain || e instanceof TooLarge ? `Nova didn’t read it: ${e.message}` : `Nova couldn’t read it: ${(e as Error).message.slice(0, 120)}`;
    }
    if (!r.said) r.said = `${r.waiting} waiting for your OK${r.held ? `, ${r.held} held back because ${r.held === 1 ? 'it' : 'they'} looked like ${r.held === 1 ? 'it was' : 'they were'} trying to give instructions` : ''}${r.skipped ? `, ${r.skipped} skipped (already kept, empty or too large)` : ''}.`;
    out.push(r);
  }
  return out;
}

export const sourceExists = (s: Source) => existsSync(s.path);
