// Nova's memory: MEMORY.md (curated, always in context) and dated notes
// (memory/YYYY-MM-DD.md, day-level detail found by search).
//
// Both are plain markdown lists a person can read and edit by hand. Each
// entry Nova writes carries a small trailing comment with its id and where it
// came from:
//
//   - Takes coffee black. <!-- id=m3f9a1c2 from=2026-10-21-k2j9xq/7b1e0c44 at=2026-10-21T16:42:00Z -->
//
// The id is what the Memory view, corrections and forgetting point at. A
// bullet written by hand has no comment; it gets an id derived from its text.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
  'just me my no not of on or our so that the their them then there these they this to was we were what when where ' +
  'which who why will with would you your about after again all also am any because been before being both each few ' +
  'more most other over same should some such than too very nova please tell know want need like get got make').split(' '));

export function terms(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])]
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => !STOP.has(w));
}

export const KINDS = { fact: 'Facts', preference: 'Preferences', decision: 'Decisions', commitment: 'Commitments' };
const SECTIONS = Object.values(KINDS);
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
const META = /\s*<!--\s*((?:[\w-]+=\S*\s*)+)-->\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const TIME = /^(\d{1,2}:\d{2})\s+·\s+/;

const newId = (prefix) => prefix + randomBytes(4).toString('hex');
const handId = (text) => `h${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim();

function parseMeta(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)=(\S*)/g)) out[m[1]] = m[2];
  return out;
}
function formatMeta(meta) {
  const pairs = Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  return pairs.length ? ` <!-- ${pairs.join(' ')} -->` : '';
}

// A memory file as lines, with its list entries located. Indented lines after
// a bullet belong to it.
function parse(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h) { section = h[1].length === 2 ? h[2] : section; if (h[1].length === 1) section = null; continue; }
    const b = lines[i].match(BULLET);
    if (!b) continue;
    let end = i + 1;
    while (end < lines.length && /^\s{2,}\S/.test(lines[end])) end++;
    let body = [b[1], ...lines.slice(i + 1, end).map((l) => l.trim())].join(' ');
    let meta = {};
    const m = body.match(META);
    if (m) { meta = parseMeta(m[1]); body = body.slice(0, m.index); }
    let time = null;
    const t = body.match(TIME);
    if (t) { time = t[1]; body = body.slice(t[0].length); }
    body = body.trim();
    if (!body) continue;
    entries.push({ id: meta.id || handId(body), text: body, meta, time, section, start: i, end });
    i = end - 1;
  }
  return { lines, entries };
}

const serialize = (lines) => `${lines.join('\n').replace(/\n+$/, '')}\n`;

function entryLine({ text, meta, time }) {
  return `- ${time ? `${time} · ` : ''}${oneLine(text)}${formatMeta(meta)}`;
}

// Insert a line as the nth entry of a section (or of the file when section is
// null), creating the section if needed.
function insertEntry(doc, section, line, index = Infinity) {
  const { lines, entries } = doc;
  const mine = entries.filter((e) => (section ? e.section?.toLowerCase() === section.toLowerCase() : true));
  if (mine.length) {
    const at = index < mine.length ? mine[Math.max(0, index)].start : mine.at(-1).end;
    lines.splice(at, 0, line);
    return;
  }
  let h = section ? lines.findIndex((l) => new RegExp(`^##\\s+${section}\\s*$`, 'i').test(l)) : lines.findIndex((l) => /^#\s/.test(l));
  if (h < 0 && section) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push('', `## ${section}`);
    h = lines.length - 1;
  }
  if (h < 0) { lines.push(line); return; }
  if (lines[h + 1] !== '') lines.splice(h + 1, 0, '');
  lines.splice(h + 2, 0, line);
  if (h + 3 < lines.length && lines[h + 3].trim()) lines.splice(h + 3, 0, '');
}

export class Memory {
  constructor(home, timezone = 'UTC') {
    this.home = home;
    this.timezone = timezone;
    this.file = join(home, 'MEMORY.md');
    this.dir = join(home, 'memory');
  }

  today(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  clock(now = new Date()) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  }

  dayFiles() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => DAY_FILE.test(f)).sort().reverse();
  }

  load(path) {
    return parse(existsSync(path) ? readFileSync(path, 'utf8') : '');
  }

  // Every file that can hold entries: MEMORY.md first, then days, newest first.
  files() {
    return [this.file, ...this.dayFiles().map((f) => join(this.dir, f))];
  }

  find(id) {
    for (const path of this.files()) {
      const doc = this.load(path);
      const entry = doc.entries.find((e) => e.id === id);
      if (entry) return { path, doc, entry };
    }
    return null;
  }

  write(path, doc) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, serialize(doc.lines));
  }

  // ---- what the person sees -----------------------------------------------

  read() {
    const doc = this.load(this.file);
    const sections = [...SECTIONS, ...new Set(doc.entries.map((e) => e.section).filter((s) => s && !SECTIONS.includes(s)))]
      .map((title) => ({ title, entries: doc.entries.filter((e) => e.section === title).map(publicEntry) }));
    const days = this.dayFiles().map((f) => ({ day: f.slice(0, 10), entries: this.load(join(this.dir, f)).entries.map(publicEntry) }))
      .filter((d) => d.entries.length);
    return { sections, days };
  }

  // MEMORY.md as the model reads it: ids it can point at, without the noise.
  forContext(text) {
    return text.replace(/^([-*][ \t]+.*?)[ \t]*<!--[ \t]*((?:[\w-]+=\S*[ \t]*)+)-->[ \t]*$/gm, (_, line, meta) => `${line} [id:${parseMeta(meta).id ?? handId(line.replace(BULLET, '$1').replace(TIME, '').trim())}]`)
      .replace(/^([-*][ \t]+(?:(?!\[id:).)*)$/gm, (line) => `${line} [id:${handId(line.replace(BULLET, '$1').replace(TIME, '').trim())}]`);
  }

  // ---- writes from the conversation --------------------------------------

  remember({ kind = 'fact', text, replaces, from }, now = new Date()) {
    const clean = oneLine(text);
    if (!clean) return { op: 'remember', ok: false, error: 'empty' };
    if (replaces) {
      const hit = this.find(replaces);
      if (hit && hit.path === this.file) {
        const meta = { ...hit.entry.meta, id: hit.entry.id, from, at: hit.entry.meta.at, updated: now.toISOString(), by: undefined };
        if (!hit.entry.meta.id) meta.at = now.toISOString();
        hit.doc.lines.splice(hit.entry.start, hit.entry.end - hit.entry.start, entryLine({ text: clean, meta }));
        this.write(this.file, hit.doc);
        return { op: 'remember', ok: true, id: hit.entry.id, kind: sectionKind(hit.entry.section), replaced: true };
      }
    }
    const doc = this.load(this.file);
    const same = doc.entries.find((e) => e.text.toLowerCase() === clean.toLowerCase());
    if (same) return { op: 'remember', ok: true, id: same.id, kind: sectionKind(same.section), existing: true };
    const id = newId('m');
    insertEntry(doc, KINDS[kind] ?? KINDS.fact, entryLine({ text: clean, meta: { id, from, at: now.toISOString() } }));
    this.write(this.file, doc);
    return { op: 'remember', ok: true, id, kind: KINDS[kind] ? kind : 'fact' };
  }

  note({ text, from }, now = new Date()) {
    const clean = oneLine(text);
    if (!clean) return { op: 'note', ok: false, error: 'empty' };
    const day = this.today(now);
    const path = join(this.dir, `${day}.md`);
    const doc = existsSync(path) ? this.load(path) : parse(`# ${longDay(day)}\n`);
    const id = newId('n');
    insertEntry(doc, null, entryLine({ text: clean, time: this.clock(now), meta: { id, from, at: now.toISOString() } }));
    this.write(path, doc);
    return { op: 'note', ok: true, id, day };
  }

  // ---- steering from the Memory view --------------------------------------

  edit(id, text, now = new Date()) {
    const clean = oneLine(text);
    const hit = this.find(id);
    if (!hit) return null;
    if (!clean) throw new Error('An entry needs some words. To remove it, forget it instead.');
    const meta = { ...hit.entry.meta, id: hit.entry.id, by: 'you', updated: now.toISOString() };
    hit.doc.lines.splice(hit.entry.start, hit.entry.end - hit.entry.start, entryLine({ text: clean, time: hit.entry.time, meta }));
    this.write(hit.path, hit.doc);
    return publicEntry({ ...hit.entry, text: clean, meta });
  }

  // Forgets an entry. Forgetting a long-term memory also forgets the day notes
  // that say the same thing, so it can't come back through search. Returns
  // what was removed, with enough to put it back (undo).
  forget(id) {
    const hit = this.find(id);
    if (!hit) return [];
    const removed = [this.removeEntry(hit)];
    if (hit.path === this.file) {
      const stem = (w) => w.slice(0, 5); // "allergy" and "allergic" are the same thing here
      const want = [...new Set(terms(hit.entry.text).map(stem))];
      for (const f of this.dayFiles()) {
        const path = join(this.dir, f);
        for (;;) {
          const doc = this.load(path);
          const twin = doc.entries.find((e) => {
            const have = new Set(terms(e.text).map(stem));
            const shared = want.filter((w) => have.has(w)).length;
            const sameTurn = hit.entry.meta.from && e.meta.from === hit.entry.meta.from;
            return sameTurn ? shared >= 1 : shared >= 2 && shared / want.length >= 0.6;
          });
          if (!twin) break;
          removed.push(this.removeEntry({ path, doc, entry: twin }));
        }
      }
    }
    return removed;
  }

  removeEntry({ path, doc, entry }) {
    const index = doc.entries.filter((e) => e.section === entry.section).indexOf(entry);
    doc.lines.splice(entry.start, entry.end - entry.start);
    // Drop a blank line left doubled by the removal.
    if (doc.lines[entry.start - 1] === '' && doc.lines[entry.start] === '') doc.lines.splice(entry.start, 1);
    this.write(path, doc);
    const file = path === this.file ? 'MEMORY.md' : `memory/${path.slice(-13)}`;
    return { id: entry.id, file, section: entry.section, index, line: entryLine(entry), text: entry.text, hand: !entry.meta.id };
  }

  restore(items) {
    for (const it of [...items].reverse()) {
      if (!/^(MEMORY\.md|memory\/\d{4}-\d{2}-\d{2}\.md)$/.test(it.file) || typeof it.line !== 'string' || !BULLET.test(it.line)) continue;
      const path = join(this.home, it.file);
      if (this.find(it.id)) continue;
      const doc = existsSync(path) ? this.load(path) : parse(`# ${longDay(it.file.slice(7, 17))}\n`);
      insertEntry(doc, it.file === 'MEMORY.md' ? it.section : null, it.line.replace(/\n/g, ' '), it.index ?? Infinity);
      this.write(path, doc);
    }
  }

  // ---- search over dated notes ------------------------------------------------

  search(query, { limit = 3 } = {}) {
    const q = terms(query);
    if (!q.length) return [];
    const need = q.length <= 2 ? 1 : 2;
    const hits = [];
    for (const f of this.dayFiles()) {
      for (const e of this.load(join(this.dir, f)).entries) {
        const have = new Set(terms(e.text));
        const score = q.filter((w) => have.has(w)).length;
        if (score >= need) hits.push({ id: e.id, source: `memory/${f}`, text: e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ id, source, text }) => ({ id, source, text }));
  }
}

const sectionKind = (title) => Object.keys(KINDS).find((k) => KINDS[k] === title) ?? null;

function publicEntry(e) {
  return { id: e.id, text: e.text, time: e.time, from: e.meta.from ?? null, at: e.meta.at ?? null, updated: e.meta.updated ?? null, by: e.meta.by ?? (e.meta.id ? 'nova' : 'hand') };
}

function longDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export const searchMemory = (home, query, opts) => new Memory(home).search(query, opts);
