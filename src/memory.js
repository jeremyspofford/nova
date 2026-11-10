// Nova's memory: MEMORY.md (curated, always in context) and dated notes
// (memory/YYYY-MM-DD.md, day-level detail found by search).
//
// The curated memory lives in the core's memory records (src/core/memory.ts),
// passed in as `records`. MEMORY.md is a view of them, rendered after every
// change, so the model and the person read the same plain markdown list they
// always have. Each entry carries a small trailing comment with its id and
// where it came from:
//
//   - Takes coffee black. <!-- id=m3f9a1c2 from=2026-10-21-k2j9xq/7b1e0c44 at=2026-10-21T16:42:00Z -->
//
// The id is the record's, and it is what the Memory view, corrections and
// forgetting point at. The file can still be edited by hand: when it no longer
// matches the last render, the edits are taken in as the person's (sync).
//
// Day notes are still files of their own; they become timeline records later.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, terms } from './core/index.ts';

export { terms };

export const KINDS = { fact: 'Facts', preference: 'Preferences', decision: 'Decisions', commitment: 'Commitments' };
// Records of the core's entity kind get a section of their own when there are any; timeline
// records are day notes, which stay in memory/ for now.
const SHOWN = { ...KINDS, entity: 'People, places and things' };
const PREAMBLE = '# MEMORY.md\n\n<!-- Your curated long-term memory: durable facts, preferences, decisions and commitments. Keep it tight: promote what lasts here, and leave day-to-day detail in your dated notes (memory/YYYY-MM-DD.md). -->';
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

// Insert a line as the nth entry of a day file, after its heading.
function insertEntry(doc, line, index = Infinity) {
  const { lines, entries } = doc;
  if (entries.length) {
    lines.splice(index < entries.length ? entries[Math.max(0, index)].start : entries.at(-1).end, 0, line);
    return;
  }
  const h = lines.findIndex((l) => /^#\s/.test(l));
  if (h < 0) { lines.push(line); return; }
  if (lines[h + 1] !== '') lines.splice(h + 1, 0, '');
  lines.splice(h + 2, 0, line);
  if (h + 3 < lines.length && lines[h + 3].trim()) lines.splice(h + 3, 0, '');
}

const has = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
const kindOf = (title) => Object.keys(SHOWN).find((k) => SHOWN[k].toLowerCase() === String(title ?? '').toLowerCase()) ?? null;
const when = (v) => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const RECORD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/; // what the core accepts as an imported id

// What the person wrote above the first section, without any entries in it.
function preamble(text) {
  if (text == null) return PREAMBLE;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cut = lines.findIndex((l) => /^##\s/.test(l));
  const head = [];
  for (let i = 0; i < (cut < 0 ? lines.length : cut); i++) {
    if (!BULLET.test(lines[i])) { head.push(lines[i]); continue; }
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) i++;
  }
  return head.join('\n').replace(/\n{3,}/g, '\n\n').trim() || PREAMBLE;
}

export class Memory {
  // records: the core's memory (core.memory), where MEMORY.md's entries live. Day notes,
  // search and forContext work without it.
  // onNoteForget(notes, by): day notes were forgotten ([{ id, text }]); the server sends them to the
  // core (core.memory.forgetNotes), so the forget reaches every backup and checkpoint and a restore
  // can't bring them back. onNoteRestore(notes, by): undo put forgotten ones back.
  constructor(home, timezone = 'UTC', { records = null, onNoteForget = null, onNoteRestore = null } = {}) {
    this.home = home;
    this.timezone = timezone;
    this.records = records;
    this.onNoteForget = onNoteForget;
    this.onNoteRestore = onNoteRestore;
    this.file = join(home, 'MEMORY.md');
    this.dir = join(home, 'memory');
    this.rendered = join(this.dir, '.rendered.json'); // the last render's hash and ids
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

  findNote(id) {
    for (const f of this.dayFiles()) {
      const path = join(this.dir, f);
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

  // ---- MEMORY.md as a view of the core's records -------------------------

  store() {
    if (!this.records) throw new Error('MEMORY.md is kept in the core\'s memory, and this Memory was made without it.');
    return this.records;
  }

  record(id) {
    try {
      return this.store().get(String(id));
    } catch (e) {
      if (e?.code === 'not_found') return null;
      throw e;
    }
  }

  latest(id) {
    return this.store().history(id).at(-1);
  }

  // A record with the first of its chain, which says when and where it was first noted.
  view(r) {
    return { r, root: r.supersedes ? this.store().history(r.id)[0] : r };
  }

  // The records MEMORY.md shows, oldest first. A correction keeps its original's place.
  shown() {
    return this.store().active().reverse().filter((r) => has(SHOWN, r.kind)).map((r) => this.view(r))
      .sort((a, b) => (a.root.observed_at < b.root.observed_at ? -1 : a.root.observed_at > b.root.observed_at ? 1 : 0));
  }

  same(text) {
    const t = oneLine(text).toLowerCase();
    return this.store().active().find((r) => has(SHOWN, r.kind) && oneLine(r.content).toLowerCase() === t) ?? null;
  }

  render(current = this.text()) {
    const shown = this.shown();
    const sections = Object.entries(SHOWN)
      .filter(([kind]) => has(KINDS, kind) || shown.some((x) => x.r.kind === kind))
      .map(([kind, title]) => {
        const lines = shown.filter((x) => x.r.kind === kind).map(recordLine);
        return lines.length ? `## ${title}\n\n${lines.join('\n')}` : `## ${title}`;
      });
    return { text: `${[preamble(current), ...sections].join('\n\n')}\n`, ids: shown.map((x) => x.r.id) };
  }

  text() {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
  }

  lastRender() {
    try {
      const s = JSON.parse(readFileSync(this.rendered, 'utf8'));
      return typeof s?.hash === 'string' && Array.isArray(s.ids) ? s : null;
    } catch {
      return null;
    }
  }

  // Writes MEMORY.md from the records, and remembers the render's hash, so a later hand edit
  // can be told apart from Nova's own writing.
  publish(current = this.text(), last = this.lastRender()) {
    const { text, ids } = this.render(current);
    if (text !== current) writeFileSync(this.file, text);
    const next = { hash: sha256(text), ids };
    if (last?.hash !== next.hash || last.ids.join(' ') !== ids.join(' ')) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.rendered, `${JSON.stringify(next)}\n`);
    }
  }

  // Brings MEMORY.md and the records together, before the file is read for context and when
  // the Memory view loads. The first time, the file's entries are imported, keeping their ids;
  // after that, a file that differs from the last render was edited by hand, and the edits are
  // taken in as the person's. Then the file is rendered again.
  sync() {
    // On a standby MEMORY.md is a copy of the hub's; it is never taken in as edits here.
    if (this.readOnly?.()) return { imported: 0, edits: 0 };
    const current = this.text();
    const last = this.lastRender();
    let imported = 0;
    let edits = 0;
    if (!last) imported = current ? this.importFile(current) : 0;
    else if (current !== null && sha256(current) !== last.hash) edits = this.takeEdits(current, last.ids);
    this.publish(current, last);
    return { imported, edits };
  }

  // Era 2's entries: Nova wrote the ones with a comment, the person the ones without (or edited
  // them, by=you). Importing again skips ids the core already has, or has forgotten.
  importFile(text) {
    let n = 0;
    for (const e of parse(text).entries) {
      const at = when(e.meta.at);
      const { imported } = this.store().importRecord({
        id: RECORD_ID.test(e.id) ? e.id : handId(e.text),
        kind: kindOf(e.section) ?? 'fact',
        content: oneLine(e.text),
        recorded_by: !e.meta.id || e.meta.by === 'you' ? 'person' : 'nova',
        ...(e.meta.from ? { source: e.meta.from } : {}),
        ...(at ? { observed_at: at } : {}),
      });
      if (imported) n++;
    }
    return n;
  }

  // A bullet whose words changed is corrected, a bullet without an id is new, and a bullet that
  // was rendered last time and is gone now is forgotten. All by the person.
  takeEdits(text, lastIds) {
    const store = this.store();
    const seen = new Set();
    let n = 0;
    for (const e of parse(text).entries) {
      const id = e.meta.id;
      const rec = id && !seen.has(id) ? this.record(id) : null;
      if (id) seen.add(id);
      if (rec) {
        const latest = this.latest(rec.id);
        if (oneLine(rec.content) === e.text || oneLine(latest.content) === e.text) continue;
        store.correct(latest.id, e.text, 'person');
        n++;
        continue;
      }
      // Rendered last time and gone from the core since: forgotten elsewhere, so it stays gone.
      if (id && lastIds.includes(id)) continue;
      if (this.same(e.text)) continue;
      store.remember({ kind: kindOf(e.section) ?? 'fact', content: oneLine(e.text), recorded_by: 'person' });
      n++;
    }
    for (const id of lastIds) {
      if (seen.has(id) || !this.record(id)) continue;
      store.forget(id, 'person');
      n++;
    }
    return n;
  }

  // ---- what the person sees -----------------------------------------------

  read() {
    this.sync();
    const shown = this.shown();
    const sections = Object.entries(SHOWN)
      .filter(([kind]) => has(KINDS, kind) || shown.some((x) => x.r.kind === kind))
      .map(([kind, title]) => ({ title, entries: shown.filter((x) => x.r.kind === kind).map(recordEntry) }));
    const days = this.dayFiles().map((f) => ({ day: f.slice(0, 10), entries: this.load(join(this.dir, f)).entries.map(publicEntry) }))
      .filter((d) => d.entries.length);
    return { sections, days };
  }

  // MEMORY.md as the model reads it: ids it can point at, without the noise.
  forContext(text) {
    return text.replace(/^([-*][ \t]+.*?)[ \t]*<!--[ \t]*((?:[\w-]+=\S*[ \t]*)+)-->[ \t]*$/gm, (_, line, meta) => {
      const m = parseMeta(meta);
      return `${line} [id:${m.id ?? handId(line.replace(BULLET, '$1').replace(TIME, '').trim())}${m.confidence ? '; low confidence' : ''}]`;
    })
      .replace(/^([-*][ \t]+(?:(?!\[id:).)*)$/gm, (line) => `${line} [id:${handId(line.replace(BULLET, '$1').replace(TIME, '').trim())}]`);
  }

  // ---- writes from the conversation --------------------------------------

  remember({ kind = 'fact', text, replaces, from }, now = new Date()) {
    const clean = oneLine(text);
    if (!clean) return { op: 'remember', ok: false, error: 'empty' };
    const store = this.store();
    this.sync();
    const old = replaces ? this.record(replaces) : null;
    if (old && has(SHOWN, old.kind)) {
      const latest = this.latest(old.id);
      const next = oneLine(latest.content) === clean ? latest : store.correct(latest.id, clean, 'nova', from ? { source: from } : {});
      this.publish();
      return { op: 'remember', ok: true, id: next.id, kind: next.kind, replaced: true };
    }
    const same = this.same(clean);
    if (same) return { op: 'remember', ok: true, id: same.id, kind: same.kind, existing: true };
    const r = store.remember({ kind: has(KINDS, kind) ? kind : 'fact', content: clean, recorded_by: 'nova', observed_at: now.toISOString(), ...(from ? { source: from } : {}) });
    this.publish();
    return { op: 'remember', ok: true, id: r.id, kind: r.kind };
  }

  note({ text, from }, now = new Date()) {
    const clean = oneLine(text);
    if (!clean) return { op: 'note', ok: false, error: 'empty' };
    const day = this.today(now);
    const path = join(this.dir, `${day}.md`);
    const doc = existsSync(path) ? this.load(path) : parse(`# ${longDay(day)}\n`);
    const id = newId('n');
    insertEntry(doc, entryLine({ text: clean, time: this.clock(now), meta: { id, from, at: now.toISOString() } }));
    this.write(path, doc);
    return { op: 'note', ok: true, id, day };
  }

  // ---- steering from the Memory view --------------------------------------

  // Editing a MEMORY.md entry is a correction by the person: a new record, with a new id, that
  // supersedes the old one.
  edit(id, text, now = new Date()) {
    const clean = oneLine(text);
    if (this.records) {
      this.sync();
      const rec = this.record(id);
      if (rec && has(SHOWN, rec.kind)) {
        if (!clean) throw new Error('An entry needs some words. To remove it, forget it instead.');
        const latest = this.latest(rec.id);
        // An edit of an older wording would silently replace a newer correction (another device's).
        if (latest.id !== rec.id && oneLine(latest.content) !== clean) throw Object.assign(new Error('This memory was changed since you opened it. Reload to see the newest wording, then edit that.'), { status: 409 });
        const next = oneLine(latest.content) === clean ? latest : this.store().correct(latest.id, clean, 'person');
        this.publish();
        return recordEntry(this.view(next));
      }
    }
    const hit = this.findNote(id);
    if (!hit) return null;
    if (!clean) throw new Error('An entry needs some words. To remove it, forget it instead.');
    const meta = { ...hit.entry.meta, id: hit.entry.id, by: 'you', updated: now.toISOString() };
    hit.doc.lines.splice(hit.entry.start, hit.entry.end - hit.entry.start, entryLine({ text: clean, time: hit.entry.time, meta }));
    this.write(hit.path, hit.doc);
    return publicEntry({ ...hit.entry, text: clean, meta });
  }

  // Forgets an entry. Forgetting a long-term memory deletes its record and every correction of
  // it, and also forgets the day notes that say the same thing, so it can't come back through
  // search. Returns what was removed, with enough to put it back (undo).
  forget(id, { by = 'person' } = {}) {
    const rec = this.records ? (this.sync(), this.record(id)) : null;
    if (!rec || !has(SHOWN, rec.kind)) {
      const hit = this.findNote(id);
      if (!hit) return [];
      const removed = [this.removeEntry(hit)];
      this.notesForgotten(removed, by);
      return removed;
    }
    const x = this.view(this.latest(rec.id));
    const e = recordEntry(x);
    const index = this.shown().filter((y) => y.r.kind === x.r.kind).findIndex((y) => y.r.id === x.r.id);
    // This path handles the files itself (it keeps what it removed, for undo), so the core's
    // after-forget hook stands aside while it runs.
    this.forgetting = true;
    try {
      this.store().forget(rec.id, by);
    } finally {
      this.forgetting = false;
    }
    this.publish();
    const removed = [{ id: e.id, file: 'MEMORY.md', section: SHOWN[x.r.kind], index, line: recordLine(x), text: e.text, hand: e.by === 'hand', kind: x.r.kind, from: e.from, at: e.at, by: x.r.recorded_by }];
    return [...removed, ...this.forgetTwins(e.text, e.from, by)];
  }

  // A memory forgotten some other way (the core's API): its words leave MEMORY.md and the day
  // notes too, so search can't send them to the model again.
  forgotten(records) {
    if (this.forgetting) return;
    this.publish();
    for (const r of records) this.forgetTwins(r.content, r.source);
  }

  // Day notes taken out of the files by a forget: the core carries the forget into every backup and
  // checkpoint (in their words, which may differ from the memory's) and keeps a content-free note
  // of it, so a restore can't bring them back.
  // On a standby the database is the hub's copy, so nothing is recorded here: the hub's own note of
  // the forget arrives by sync.
  notesForgotten(removed, by = 'person') {
    if (this.readOnly?.()) return;
    const notes = removed.filter((r) => r.file !== 'MEMORY.md').map((r) => ({ id: r.id, text: r.text }));
    if (notes.length && this.onNoteForget) this.onNoteForget(notes, by);
  }

  // The day notes that say the same thing as a forgotten memory.
  forgetTwins(text, from, by = 'person') {
    const removed = [];
    const stem = (w) => w.slice(0, 5); // "allergy" and "allergic" are the same thing here
    const want = [...new Set(terms(text).map(stem))];
    if (!want.length) return removed;
    for (const f of this.dayFiles()) {
      const path = join(this.dir, f);
      for (;;) {
        const doc = this.load(path);
        const twin = doc.entries.find((n) => {
          const have = new Set(terms(n.text).map(stem));
          const shared = want.filter((w) => have.has(w)).length;
          const sameTurn = from && n.meta.from === from;
          return sameTurn ? shared >= 1 : shared >= 2 && shared / want.length >= 0.6;
        });
        if (!twin) break;
        removed.push(this.removeEntry({ path, doc, entry: twin }));
      }
    }
    this.notesForgotten(removed, by);
    return removed;
  }

  removeEntry({ path, doc, entry }) {
    const index = doc.entries.indexOf(entry);
    doc.lines.splice(entry.start, entry.end - entry.start);
    // Drop a blank line left doubled by the removal.
    if (doc.lines[entry.start - 1] === '' && doc.lines[entry.start] === '') doc.lines.splice(entry.start, 1);
    this.write(path, doc);
    return { id: entry.id, file: `memory/${path.slice(-13)}`, section: entry.section, index, line: entryLine(entry), text: entry.text, hand: !entry.meta.id };
  }

  restore(items) {
    const back = [];
    for (const it of [...items].reverse()) {
      if (!it || typeof it !== 'object') continue;
      if (it.file === 'MEMORY.md') { this.restoreRecord(it); continue; }
      if (!/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(it.file) || typeof it.line !== 'string' || !BULLET.test(it.line)) continue;
      const path = join(this.home, it.file);
      if (this.findNote(it.id)) continue;
      const doc = existsSync(path) ? this.load(path) : parse(`# ${longDay(it.file.slice(7, 17))}\n`);
      const line = it.line.replace(/\n/g, ' ');
      insertEntry(doc, line, it.index ?? Infinity);
      this.write(path, doc);
      const e = parse(line).entries[0];
      if (e) back.push({ id: e.id, text: e.text });
    }
    // Put back by the person: a restore from an older backup leaves them, as it does any note.
    if (back.length && this.onNoteRestore && !this.readOnly?.()) this.onNoteRestore(back, 'person');
  }

  // Forgetting deleted the record for real, so undo can only make it again from what the Memory
  // view still holds: the same words, kind, source and time, under a new id.
  restoreRecord(it) {
    if (!this.records) return;
    const text = oneLine(typeof it.text === 'string' ? it.text : typeof it.line === 'string' ? parse(it.line).entries[0]?.text : '');
    if (!text) return;
    this.sync();
    if (this.same(text)) return;
    const at = when(it.at);
    const from = typeof it.from === 'string' && it.from.trim() ? it.from : null;
    this.store().remember({
      kind: has(SHOWN, it.kind) ? it.kind : kindOf(it.section) ?? 'fact', content: text, recorded_by: it.by === 'person' ? 'person' : 'nova',
      ...(from ? { source: from } : {}), ...(at ? { observed_at: at } : {}),
    });
    this.publish();
  }

  // ---- search over dated notes ------------------------------------------------

  // The notes a turn recalled, as they are now (A-023): one forgotten since is gone, one edited since
  // reads as it does now. A run checks before every model call, so a note forgotten mid-conversation
  // never reaches the next prompt. A hand-written note without an id is matched by its words.
  current(recall) {
    const out = [];
    for (const n of recall) {
      const file = typeof n.source === 'string' && n.source.startsWith('memory/') ? join(this.dir, n.source.slice('memory/'.length)) : null;
      if (!file || !existsSync(file)) continue;
      const entries = this.load(file).entries;
      const e = n.id ? entries.find((x) => x.id === n.id) : entries.find((x) => (x.text.length > 400 ? `${x.text.slice(0, 400)}…` : x.text) === n.text);
      if (e) out.push({ ...n, text: e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text });
    }
    return out;
  }

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

// A record as the Memory view shows it. "hand" is the person's own words, written into the file
// or the core directly; "you" an edit of theirs, or something they said in a conversation.
function recordEntry({ r, root }) {
  const own = r.source && r.source !== 'correction' ? r.source : null;
  return {
    id: r.id, text: oneLine(r.content), time: null, from: own ?? root.source ?? null, at: root.observed_at,
    updated: r.supersedes ? r.created_at : null,
    by: r.recorded_by !== 'person' ? 'nova' : r.supersedes || r.source ? 'you' : 'hand',
    // F-038: whether the person has checked it (the store's user_state), and the device that wrote
    // it when one did (a note a device sent is recorded_by "device:<id>").
    state: r.user_state ?? null,
    device: typeof r.recorded_by === 'string' && r.recorded_by.startsWith('device:') ? r.recorded_by.slice(7) : null,
    root: root.id,
  };
}

// F-038: what the Memory view needs to say where its records came from, read from the stores Nova
// already keeps: each device's name from the device registry, and for a memory made from captured
// items, how many and on which devices, from its promotion rows (never from the text of its
// source, which is a copy). `deviceName(id)` is null for a device no longer on the registry;
// `promotions(memoryId)` is capture's rows for one memory (src/core/capture/capture.ts).
export function originsOf(read, { deviceName, promotions }) {
  const devices = {};
  const captured = {};
  const name = (id) => {
    if (!id || id in devices) return;
    const n = deviceName(id);
    if (n) devices[id] = n;
  };
  for (const s of read.sections ?? []) {
    for (const e of s.entries) {
      if (e.device) name(e.device);
      if (typeof e.from === 'string' && e.from.startsWith('device:')) name(e.from.slice(7));
      if (typeof e.from === 'string' && e.from.startsWith('capture:')) {
        let rows = [];
        try { rows = promotions(e.root ?? e.id) ?? []; } catch { rows = []; }
        const on = [...new Set(rows.map((r) => r.device_id).filter(Boolean))];
        for (const d of on) name(d);
        captured[e.id] = { count: rows.length, devices: on };
      }
    }
  }
  for (const d of read.days ?? []) for (const e of d.entries) if (typeof e.from === 'string' && e.from.startsWith('device:')) name(e.from.slice(7));
  return { devices, captured };
}

// A record as a MEMORY.md line. Low confidence is said, so it isn't taken as fact.
function recordLine(x) {
  const e = recordEntry(x);
  const from = e.from && /^[^\s<>]+$/.test(e.from) && !e.from.includes('--') ? e.from : null;
  return entryLine({ text: e.text, meta: { id: e.id, from, at: e.at, by: x.r.recorded_by === 'person' ? 'you' : null, updated: e.updated, confidence: x.r.low_confidence ? String(x.r.confidence) : null } });
}

function publicEntry(e) {
  return { id: e.id, text: e.text, time: e.time, from: e.meta.from ?? null, at: e.meta.at ?? null, updated: e.meta.updated ?? null, by: e.meta.by ?? (e.meta.id ? 'nova' : 'hand') };
}

function longDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

