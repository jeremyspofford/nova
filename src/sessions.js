// Session logs: one JSONL file per conversation in home/sessions/.
// Append-only; the file is the record, and the view is derived from it.
import { appendFileSync, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Dated ids for conversations, plus the one main conversation.
const ID = /^(\d{4}-\d{2}-\d{2}-[a-z0-9]{6}|main)$/;
export const validId = (id) => ID.test(String(id));

export class SessionStore {
  constructor(home, timezone) {
    this.dir = join(home, 'sessions');
    this.timezone = timezone;
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
    appendFileSync(this.path(id), `${JSON.stringify(line)}\n`);
    return line;
  }

  read(id) {
    const out = [];
    for (const l of readFileSync(this.path(id), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* a torn last line from a crash: skip it */ }
    }
    return out;
  }

  // The conversations the person started. The main conversation and the
  // logs of scheduled runs and helpers are kept here too, but not listed.
  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl') && validId(f.slice(0, -6)) && f !== 'main.jsonl')
      .map((f) => {
        const p = join(this.dir, f);
        const head = firstLine(p);
        let meta = {};
        try { meta = JSON.parse(head); } catch {}
        return { id: f.slice(0, -6), title: meta.title || 'Untitled', created: meta.ts ?? null, updated: statSync(p).mtime.toISOString(), kind: meta.kind };
      })
      .filter((s) => s.kind !== 'run' && s.kind !== 'helper')
      .map(({ kind, ...s }) => s)
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
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
