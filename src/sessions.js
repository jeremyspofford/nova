// Session logs: one JSONL file per conversation in home/sessions/.
// Append-only; the file is the record, and the view is derived from it.
import { appendFileSync, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { readdir, open, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Dated ids for conversations, plus the one main conversation.
const ID = /^(\d{4}-\d{2}-\d{2}-[a-z0-9]{6}|main)$/;
export const validId = (id) => ID.test(String(id));

export class SessionStore {
  constructor(home, timezone) {
    this.dir = join(home, 'sessions');
    this.timezone = timezone;
    this.index = null;
    this.dirty = new Set();
    this.logs = new Map();
    this.watcher = null;
    this.generation = 0;
  }

  path(id) {
    if (!validId(id)) throw new Error('bad session id');
    return join(this.dir, `${id}.jsonl`);
  }

  exists(id) { return validId(id) && existsSync(this.path(id)); }

  newId(now = new Date()) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const tail = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 6);
    return `${day}-${tail}`;
  }

  append(id, ev) {
    const line = { ts: new Date().toISOString(), ...ev };
    const file = this.path(id);
    const cached = this.logs.get(id);
    const before = cached && existsSync(file) ? statSync(file) : null;
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    if (cached && before && cached.signature === signature(before) && cached.complete) {
      cached.events.push(JSON.parse(JSON.stringify(line)));
      cached.signature = signature(statSync(file));
    } else this.logs.delete(id);
    this.dirty.add(`${id}.jsonl`);
    this.generation++;
    return line;
  }

  read(id) {
    const file = this.path(id);
    const sig = signature(statSync(file));
    let cached = this.logs.get(id);
    if (!cached || cached.signature !== sig) {
      const text = readFileSync(file, 'utf8');
      const events = [];
      for (const l of text.split('\n')) {
        if (!l.trim()) continue;
        try { events.push(JSON.parse(l)); } catch { /* torn last line */ }
      }
      cached = { events, signature: sig, complete: text.endsWith('\n') };
    }
    // Keep only the active conversation: repeated snapshots avoid reparsing its
    // whole history, without retaining every conversation ever opened.
    this.logs.clear();
    this.logs.set(id, cached);
    return structuredClone(cached.events);
  }

  close() { this.watcher?.close(); this.watcher = null; this.logs.clear(); this.index = null; this.dirty.clear(); }

  observe() {
    if (this.watcher || !existsSync(this.dir)) return;
    this.watcher = watch(this.dir, { persistent: false }, (_, name) => {
      if (name) this.dirty.add(String(name)); else this.index = null;
      this.generation++;
    });
    this.watcher.on('error', () => { this.index = null; this.watcher?.close(); this.watcher = null; });
  }

  // Diagnostics counts persisted logs, including main/runs/helpers, without opening content.
  countLogs() {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl') && validId(f.name.slice(0, -6))).length;
  }

  // The conversations the person started. The main conversation and the
  // logs of scheduled runs and helpers are kept here too, but not listed.
  list() {
    if (!existsSync(this.dir)) return [];
    this.observe();
    const stamp = signature(statSync(this.dir));
    if (!this.index || this.dirStamp !== stamp) {
      this.index = new Map(readdirSync(this.dir).filter(isLog).map((f) => [f, metadata(f, firstLine(join(this.dir, f)), statSync(join(this.dir, f)))]));
      this.dirStamp = stamp;
    } else {
      for (const f of this.dirty) {
        if (!isLog(f)) continue;
        try { this.index.set(f, metadata(f, firstLine(join(this.dir, f)), statSync(join(this.dir, f)))); }
        catch (e) { if (e.code === 'ENOENT') this.index.delete(f); else throw e; }
      }
    }
    this.dirty.clear();
    return listed(this.index);
  }

  // The HTTP path builds a cold index without blocking other requests. Warm
  // requests touch only changed logs. Generation checks avoid overwriting an
  // append that happened while the asynchronous scan was in flight.
  listAsync() {
    this.loading ??= this.loadIndex().finally(() => { this.loading = null; });
    return this.loading;
  }

  async loadIndex() {
    if (!existsSync(this.dir)) return [];
    this.observe();
    const stamp = signature(await stat(this.dir));
    if (this.index && this.dirStamp === stamp) return this.list();
    const generation = this.generation;
    const entries = new Map();
    for (const f of (await readdir(this.dir)).filter(isLog)) {
      try {
        const handle = await open(join(this.dir, f), 'r');
        try {
          const bytes = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          entries.set(f, metadata(f, bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0], await handle.stat()));
        } finally { await handle.close(); }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (this.generation !== generation) return this.loadIndex();
    this.index = entries;
    this.dirStamp = stamp;
    this.dirty.clear();
    return listed(entries);
  }

}

function firstLine(p) {
  const fd = openSync(p, 'r');
  try {
    const b = Buffer.alloc(4096);
    const n = readSync(fd, b, 0, b.length, 0);
    return b.subarray(0, n).toString('utf8').split('\n')[0];
  } finally { closeSync(fd); }
}

const signature = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const isLog = (f) => f.endsWith('.jsonl') && validId(f.slice(0, -6)) && f !== 'main.jsonl';
function metadata(f, head, st) {
  let meta = {};
  try { meta = JSON.parse(head); } catch { /* incomplete metadata */ }
  return { id: f.slice(0, -6), title: meta.title || 'Untitled', created: meta.ts ?? null, updated: st.mtime.toISOString(), kind: meta.kind };
}
const listed = (index) => [...index.values()].filter(s => s.kind !== 'run' && s.kind !== 'helper').map(({ kind, ...s }) => s).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || b.id.localeCompare(a.id));
