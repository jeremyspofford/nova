// The sync log (M4 plan §3): what the hub has, in an order a standby can follow. The database
// triggers of migration 0006 record every write to a replicated table; this module adds the home's
// files (the journal), serves the log in batches, applies a batch on a standby, and keeps the
// standing order that a forgotten memory is gone everywhere, this log included.
//
// The log holds one entry per row or file, the newest: the triggers drop the older entry when they
// add one. A standby that is behind therefore never misses a change (the newer entry has a higher
// seq), and one that starts from nothing reads the whole state once.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import { HybridClock } from './wire.ts';

// Replicated tables and their keys, as in migrations 0006 and 0007. Everything else stays on its own node.
export const REPLICATED: Readonly<Record<string, readonly string[]>> = {
  profile: ['section', 'key'], task: ['id'], task_event: ['seq'], memory: ['id'], memory_event: ['id'],
  decision_template: ['template_id', 'version'], decision_template_event: ['seq'], trigger_rule: ['id'], trigger_rule_event: ['seq'],
  trigger: ['trigger_id'], message: ['id'], extension: ['id'], device: ['id'], problem: ['id'], receipt: ['id'],
  // Migration 0007: a device's queued items, taken in exactly once, on whichever node is hub.
  device_inbox: ['device_id', 'key'],
};
export const FILE = 'file';

// Home files that are not the person's content, so they stay on their node: the database (sync
// carries it row by row), logs, backups, exports, extension leftovers, worker scratch, connector
// secrets, the mesh identity, and git's history. Everything else in the home is journalled.
export const NOT_JOURNALLED: ReadonlySet<string> = new Set(['.git', 'mesh', 'logs', 'backups', 'exports', 'kept', 'workers', 'connectors']);
const DB_FILE = /^nova\.db/;
const TMP = /\.nova-sync-\d+\.tmp$/;
// A bigger file isn't carried; it is reported once instead.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
// A standby this far behind the oldest entry it hasn't acknowledged is "behind".
export const BEHIND_AFTER_S = 60;

export type Op = 'put' | 'delete' | 'file_put' | 'file_delete';
export interface LogRow { seq: number; tbl: string; pk: string; op: Op; row: string | null; hlc: string }
export interface FileRow { path: string; sha256: string; size: number; text?: string; b64?: string }
export interface Batch { rows: LogRow[]; upto: number; more: boolean; head: number }
export interface Lag { head: number; acked_seq: number; acked_at: string | null; rows: number; seconds: number; behind: boolean }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const OPS: readonly Op[] = ['put', 'delete', 'file_put', 'file_delete'];

// A relative home path that a file entry may name: inside the home, not in a place that stays local.
export function journalPath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('\\')) return null;
  const n = normalize(rel).split(sep).join('/');
  if (n !== rel || n === '.' || n.split('/').some((p) => p === '..' || p === '' || p === '.')) return null;
  const top = n.split('/')[0]!;
  if (NOT_JOURNALLED.has(top) || (!n.includes('/') && DB_FILE.test(n)) || TMP.test(n)) return null;
  return n;
}

export class SyncLog {
  readonly home: string;
  #db: Db;
  #log: Log;
  #clock: HybridClock;
  #now: () => Date;
  // The journal: what each file was when last looked at, and what the log says it is.
  #seen = new Map<string, { mtimeMs: number; size: number; sha: string }>();
  #logged: Map<string, string> | null = null;
  #tooBig = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #watcher: FSWatcher | null = null;
  #soon: ReturnType<typeof setTimeout> | null = null;
  #columns = new Map<string, Set<string>>();

  constructor(o: { db: Db; log: Log; home: string; node: string; now: () => Date }) {
    this.#db = o.db;
    this.#log = o.log;
    this.home = o.home;
    this.#now = o.now;
    this.#clock = new HybridClock({ node: o.node, now: () => o.now().getTime() });
  }

  // ---- this node's side ------------------------------------------------------------------------

  logging(): boolean {
    return this.#db.get<{ logging: number }>('SELECT logging FROM sync_state WHERE id = 1')?.logging === 1;
  }

  // On for a hub, off for a standby (which copies the hub's entries instead of making its own).
  setLogging(on: boolean): void {
    this.#db.run('UPDATE sync_state SET logging = ? WHERE id = 1', on ? 1 : 0);
  }

  head(): number {
    return this.#db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM sync_log')?.s ?? 0;
  }

  // ---- the hub serves the log ------------------------------------------------------------------

  // Entries after `after`, oldest first, up to `limit` entries or about `maxBytes`. `upto` is the
  // seq the reader may move its cursor to: the last entry sent, or the head when nothing is left.
  batch(after: number, o: { limit?: number; maxBytes?: number } = {}): Batch {
    const limit = o.limit ?? 500;
    const maxBytes = o.maxBytes ?? 4 * 1024 * 1024;
    const head = this.head();
    const rows: LogRow[] = [];
    let bytes = 0;
    for (const r of this.#db.raw.prepare('SELECT seq, tbl, pk, op, row, hlc FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?').iterate(after, limit + 1) as Iterable<LogRow>) {
      if (rows.length >= limit || (rows.length && bytes + (r.row?.length ?? 0) > maxBytes)) return { rows, upto: rows.at(-1)!.seq, more: true, head };
      rows.push({ ...r });
      bytes += r.row?.length ?? 0;
    }
    return { rows, upto: Math.max(after, head), more: false, head };
  }

  // The standby said it has everything up to `seq`.
  ack(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) throw new CoreError('validation', 'seq must be a whole number.');
    this.#db.run('UPDATE sync_state SET acked_seq = MAX(acked_seq, ?), acked_at = ? WHERE id = 1', Math.min(seq, this.head()), this.#now().toISOString());
  }

  // How far the standby is behind: entries it hasn't acknowledged, and for how long it hasn't
  // acknowledged anything while there was something to take (counted from `notBefore`, when it was
  // approved, at the earliest). A standby that keeps acknowledging is catching up, not behind.
  lag(notBefore = 0): Lag {
    const s = this.#db.get<{ acked_seq: number; acked_at: string | null }>('SELECT acked_seq, acked_at FROM sync_state WHERE id = 1')!;
    const head = this.head();
    const rows = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_log WHERE seq > ?', s.acked_seq)!.n;
    const base = Math.max(s.acked_at ? Date.parse(s.acked_at) : 0, notBefore);
    const seconds = rows ? Math.max(0, Math.round((this.#now().getTime() - base) / 1000)) : 0;
    return { head, acked_seq: s.acked_seq, acked_at: s.acked_at, rows, seconds, behind: rows > 0 && seconds > BEHIND_AFTER_S };
  }

  // A new standby starts from nothing: what an earlier one acknowledged says nothing about it.
  resetAck(): void {
    this.#db.run('UPDATE sync_state SET acked_seq = 0, acked_at = NULL, behind_since = NULL WHERE id = 1');
  }

  // ---- the journal: the home's files -----------------------------------------------------------

  // Looks at the home now and records what changed since the last look. Only a node that is
  // logging (the hub) journals.
  scan(): { put: string[]; deleted: string[] } {
    const put: string[] = [];
    const deleted: string[] = [];
    if (!this.logging()) return { put, deleted };
    const logged = this.#loggedFiles();
    const present = new Set<string>();
    const writes: { path: string; data: Buffer | null }[] = [];
    const walk = (rel: string) => {
      let entries;
      try { entries = readdirSync(rel ? join(this.home, rel) : this.home, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!rel && NOT_JOURNALLED.has(e.name)) continue;
          walk(r);
          continue;
        }
        if (!e.isFile() || !journalPath(r)) continue;
        let st;
        try { st = lstatSync(join(this.home, r)); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) {
          if (!this.#tooBig.has(r)) {
            this.#tooBig.add(r);
            this.#log.problem('sync', `${r} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, so the standby doesn’t get a copy of it.`);
          }
          continue;
        }
        present.add(r);
        const known = this.#seen.get(r);
        if (known && known.mtimeMs === st.mtimeMs && known.size === st.size && logged.get(r) === known.sha) continue;
        let data: Buffer;
        try { data = readFileSync(join(this.home, r)); } catch { present.delete(r); continue; }
        const sha = sha256(data);
        this.#seen.set(r, { mtimeMs: st.mtimeMs, size: st.size, sha });
        if (logged.get(r) !== sha) writes.push({ path: r, data });
      }
    };
    walk('');
    for (const path of logged.keys()) if (!present.has(path) && !this.#tooBig.has(path)) writes.push({ path, data: null });
    if (!writes.length) return { put, deleted };
    this.#db.tx(() => {
      for (const w of writes) {
        this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', FILE, w.path);
        if (w.data) {
          const text = w.data.toString('utf8');
          const row: FileRow = { path: w.path, sha256: sha256(w.data), size: w.data.length, ...(Buffer.from(text, 'utf8').equals(w.data) ? { text } : { b64: w.data.toString('base64') }) };
          this.#db.run('INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?)', FILE, w.path, 'file_put', JSON.stringify(row), this.#clock.tick());
          logged.set(w.path, row.sha256);
          put.push(w.path);
        } else {
          this.#db.run('INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES (?, ?, ?, NULL, ?)', FILE, w.path, 'file_delete', this.#clock.tick());
          logged.delete(w.path);
          this.#seen.delete(w.path);
          deleted.push(w.path);
        }
      }
    });
    return { put, deleted };
  }

  // Scans every few seconds, and soon after anything in the home changes.
  startJournal(everyMs = 3000): void {
    if (this.#timer) return;
    const run = () => {
      try { this.scan(); } catch (e) { this.#log.problem('sync', 'Nova couldn’t record changes to its files for the standby.', { detail: (e as Error)?.stack ?? String(e) }); }
    };
    this.#timer = setInterval(run, everyMs);
    this.#timer.unref();
    try {
      this.#watcher = watch(this.home, { recursive: true }, (_, name) => {
        const top = String(name ?? '').split(/[\\/]/)[0] ?? '';
        if (NOT_JOURNALLED.has(top) || DB_FILE.test(top)) return;
        this.#soon ??= setTimeout(() => { this.#soon = null; run(); }, 250);
      });
      this.#watcher.on('error', () => { this.#watcher?.close(); this.#watcher = null; });
    } catch { /* no file watching here: the interval still runs */ }
    run();
  }

  stopJournal(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#soon) clearTimeout(this.#soon);
    this.#watcher?.close();
    this.#timer = null;
    this.#soon = null;
    this.#watcher = null;
  }

  #loggedFiles(): Map<string, string> {
    if (!this.#logged) {
      this.#logged = new Map();
      for (const r of this.#db.all<{ pk: string; sha: string | null }>(`SELECT pk, json_extract(row, '$.sha256') AS sha FROM sync_log WHERE tbl = ? AND op = 'file_put'`, FILE)) {
        if (r.sha) this.#logged.set(r.pk, r.sha);
      }
    }
    return this.#logged;
  }

  // ---- forgetting (standing order 4) -----------------------------------------------------------

  // A memory was forgotten. Its own entries are already gone (the delete replaced them), and the
  // files that showed it (MEMORY.md, the day notes) were written again by now, so a scan replaces
  // their entries too. Anything still carrying the words in memory's own entries or those files is
  // then removed outright. Returns how many entries were removed that way.
  forgotten(contents: string[]): number {
    this.scan();
    const needles = new Set<string>();
    for (const c of contents) {
      const t = String(c ?? '').trim();
      if (!t) continue;
      for (const v of [t, t.replace(/\s+/g, ' ')]) needles.add(JSON.stringify(v).slice(1, -1));
    }
    let removed = 0;
    try {
      this.#purge(needles, (n) => { removed += n; });
    } finally {
      // The replaced entries' old pages leave the write-ahead log now.
      if (this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    return removed;
  }

  #purge(needles: Set<string>, count: (n: number) => void): void {
    for (const n of needles) {
      const hit = this.#db.all<{ seq: number; tbl: string; pk: string }>(
        `SELECT seq, tbl, pk FROM sync_log WHERE (tbl = 'memory' OR (tbl = ? AND (pk = 'MEMORY.md' OR pk LIKE 'memory/%'))) AND instr(row, ?) > 0`, FILE, n,
      );
      for (const h of hit) {
        this.#db.run('DELETE FROM sync_log WHERE seq = ?', h.seq);
        if (h.tbl === FILE) { this.#logged?.delete(h.pk); this.#seen.delete(h.pk); }
        count(1);
      }
    }
  }

  // ---- the standby applies -----------------------------------------------------------------------

  cursor(): number {
    return this.#db.get<{ cursor: number }>('SELECT cursor FROM sync_state WHERE id = 1')!.cursor;
  }

  // Applies the hub's entries in one transaction and keeps them, with the hub's seq, in this node's
  // own log, so that after a promotion this node can serve a new standby the same way. Files are
  // written as they come (writing one again is harmless), so a crash part-way repeats, never skips.
  // A memory the hub deleted was forgotten there: `forgotten` gets the records, after the commit,
  // to forget them here the same way (backups included).
  apply(batch: { rows: LogRow[]; upto: number }, forgotten: (records: Record<string, unknown>[]) => void): { applied: number; files: number } {
    const rows = batch.rows;
    for (const r of rows) this.#check(r);
    const gone: Record<string, unknown>[] = [];
    let files = 0;
    // Entries that may have carried a forgotten memory's words: once replaced, the old pages are
    // folded out of the write-ahead log at once, not whenever SQLite would.
    let scrub = false;
    // The hub's order already satisfies its own foreign keys; entries arrive newest-per-row, so a
    // child can come before the row it points at. Checks are off only while applying.
    this.#db.raw.exec('PRAGMA foreign_keys = OFF');
    try {
      this.#db.tx(() => {
        for (const r of rows) {
          if (r.tbl === 'memory' || (r.tbl === FILE && (r.pk === 'MEMORY.md' || r.pk.startsWith('memory/')))) scrub = true;
          if (r.op === 'put') this.#put(r.tbl, JSON.parse(r.row!) as Record<string, unknown>);
          else if (r.op === 'delete') {
            if (r.tbl === 'memory') {
              const rec = this.#db.get<Record<string, unknown>>('SELECT * FROM memory WHERE id = ?', r.pk);
              if (rec) gone.push(rec);
            }
            this.#delete(r.tbl, r.pk);
          } else if (r.op === 'file_put') { this.#writeFile(JSON.parse(r.row!) as FileRow); files++; }
          else { this.#removeFile(r.pk); files++; }
          this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', r.tbl, r.pk);
          this.#db.run('INSERT INTO sync_log (seq, tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?, ?)', r.seq, r.tbl, r.pk, r.op, r.row, r.hlc);
        }
        this.#db.run('UPDATE sync_state SET cursor = MAX(cursor, ?) WHERE id = 1', batch.upto);
      });
    } finally {
      this.#db.raw.exec('PRAGMA foreign_keys = ON');
    }
    if (scrub && this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (gone.length) forgotten(gone);
    return { applied: rows.length, files };
  }

  // Refuses an entry that names a table, column, op or path this node doesn't replicate.
  #check(r: LogRow): void {
    const bad = (why: string) => { throw new CoreError('validation', `The hub sent a sync entry Nova can’t apply (${why}).`); };
    if (!r || typeof r !== 'object' || !Number.isInteger(r.seq) || r.seq < 1 || typeof r.pk !== 'string' || typeof r.hlc !== 'string') bad('malformed');
    if (!OPS.includes(r.op)) bad(`op ${String(r.op)}`);
    if (r.op === 'file_put' || r.op === 'file_delete') {
      if (r.tbl !== FILE || !journalPath(r.pk)) bad(`file ${r.pk}`);
      if (r.op === 'file_put') {
        const f = JSON.parse(String(r.row)) as FileRow;
        if (f.path !== r.pk || typeof f.sha256 !== 'string' || (typeof f.text !== 'string' && typeof f.b64 !== 'string')) bad(`file ${r.pk}`);
      }
      return;
    }
    if (!Object.hasOwn(REPLICATED, r.tbl)) bad(`table ${r.tbl}`);
    if (r.op === 'put') {
      const row = JSON.parse(String(r.row)) as Record<string, unknown>;
      const cols = this.#cols(r.tbl);
      for (const [k, v] of Object.entries(row)) {
        if (!cols.has(k)) bad(`column ${r.tbl}.${k}`);
        if (v !== null && typeof v !== 'string' && typeof v !== 'number') bad(`value of ${r.tbl}.${k}`);
      }
    }
  }

  #cols(tbl: string): Set<string> {
    let c = this.#columns.get(tbl);
    if (!c) {
      c = new Set(this.#db.all<{ name: string }>(`PRAGMA table_info("${tbl}")`).map((x) => x.name));
      this.#columns.set(tbl, c);
    }
    return c;
  }

  #put(tbl: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    this.#db.run(
      `INSERT OR REPLACE INTO "${tbl}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => row[c] as string | number | null),
    );
  }

  #delete(tbl: string, pk: string): void {
    const keys = REPLICATED[tbl]!;
    const values = keys.length === 1 ? [pk] : (JSON.parse(pk) as (string | number)[]);
    this.#db.run(`DELETE FROM "${tbl}" WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')}`, ...values);
  }

  #writeFile(f: FileRow): void {
    const data = typeof f.text === 'string' ? Buffer.from(f.text, 'utf8') : Buffer.from(String(f.b64), 'base64');
    if (sha256(data) !== f.sha256) throw new CoreError('validation', `The hub sent ${f.path}, but it arrived damaged.`);
    const abs = join(this.home, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.nova-sync-${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, abs);
  }

  #removeFile(path: string): void {
    rmSync(join(this.home, path), { force: true });
  }
}
