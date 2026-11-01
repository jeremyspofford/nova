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
  // Migration 0009: capture (M6a). Sources carry consent and each adapter's cursor; events carry
  // what was captured, and a delete of one is forgetting it (see `forgetting`).
  capture_source: ['id'], capture_event: ['id'], capture_tombstone: ['source_id', 'key'], capture_promotion: ['id'], capture_proposal: ['id'],
  // Migration 0011: the change pipeline's records (M7a), so a standby knows what is live and why.
  change_record: ['id'],
  // Migration 0023 (M10h): what each device is assigned to run; each capture batch as verified; and
  // forgets still waiting for a device's acknowledgement; and raw-to-event mappings needed to read
  // and forget fetched originals and their recovery copies. A hub that takes over keeps all four.
  device_workload: ['device_id', 'service'], capture_batch: ['id'], capture_device_tombstone: ['id'], capture_raw_fetch: ['id'],
};
// Columns a release added to a replicated table, by the schema version that added them (M10f review,
// finding 3: one mechanism for every such column). A standby a release behind doesn't have them:
//   - the hub leaves them out of what it serves, by the schema the standby says it is on when it
//     pulls (`batch({ peerSchema })`); a standby that says nothing (code from before this) is taken to
//     be on UNSTATED_SCHEMA;
//   - a standby that gets one anyway (a hub that didn't adapt) leaves it out and says once that it is
//     behind (`#put`).
// A migration that adds a column to a replicated table adds it here; tests/core/sync-skew.test.ts
// fails when one is missing. Its triggers carry the column always: the sender adapts, not the trigger.
export const ADDED_COLUMNS: Readonly<Record<number, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  19: { receipt: ['opt_in'] },
  20: { device: ['purposes'] },
  // Whether a problem stops Nova (the orb's red; DESIGN-SYSTEM §1). A standby without it shows every
  // problem amber, as before.
  21: { problem: ['stops'] },
  // Capture screening, job 1: each captured event's screening state and provenance.
  22: { capture_event: ['sensitivity', 'sensitivity_why', 'sensitivity_decision', 'sensitivity_detail', 'sensitivity_at', 'sensitivity_tries', 'sensitivity_next'] },
  // M10h: where a captured event came from and how it got here (the capture data path's provenance).
  // A standby without it keeps the event without its provenance until it catches up.
  23: { capture_event: ['provenance'] },
});
export const UNSTATED_SCHEMA = 19;

// The columns a peer on `schema` doesn't have, by table.
export function columnsAfter(schema: number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [v, tables] of Object.entries(ADDED_COLUMNS)) {
    if (Number(v) <= schema) continue;
    for (const [t, cols] of Object.entries(tables)) for (const c of cols) out.set(t, new Set([...(out.get(t) ?? []), c]));
  }
  return out;
}

export const FILE = 'file';
// The vault (vault.ts) is one entry: its ciphertext in the log like a row. Its key is added only
// when a batch is served, inside the batch sealed to the standby, so the log never holds it.
export const VAULT = 'vault';
export interface VaultSync { sealedFile(): string | null; keyForStandby(): string | null; adopt(file: string, key: string): void; clear(): void }

// Home files that are not the person's content, so they stay on their node: the database (sync
// carries it row by row), logs, backups, exports, extension leftovers, worker scratch, connector
// secrets (Era 2's plaintext ones; the vault travels as its own entry, above), the mesh identity,
// and git's history. Everything else in the home is journalled.
// Checkpoints (M7 amendment) stay on their node too: they hold its keys. So do a factory reset's
// marker and report (resilience/reset.ts): a standby that copied the marker would erase itself with
// the hub's plan.
export const NOT_JOURNALLED: ReadonlySet<string> = new Set(['.git', 'mesh', 'logs', 'backups', 'exports', 'kept', 'workers', 'connectors', 'vault', 'broker', 'checkpoints', 'factory-reset.json', 'reset-report.json', '.nova-home']);
const DB_FILE = /^nova\.db/;
const TMP = /\.nova-sync-\d+\.tmp$/;
// A bigger file isn't carried; it is reported once instead.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TOO_BIG = /^(.+) is larger than \d+ MB, so the standby doesn’t get a copy of it/;
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
  #timer: ReturnType<typeof setInterval> | null = null;
  #watcher: FSWatcher | null = null;
  #soon: ReturnType<typeof setTimeout> | null = null;
  #columns = new Map<string, Set<string>>();
  // Set by the core once the vault exists; without it, secrets simply don't replicate.
  vault: VaultSync | null = null;
  // Tables other than memory whose deletes are forgetting (capture_event, M6a): on a standby, the
  // deleted rows are handed here after the commit, so the rest of a forget (backups) happens here too.
  forgetting = new Map<string, (rows: Record<string, unknown>[]) => void>();

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

  // This node's schema version, which a standby tells the hub when it pulls (ADDED_COLUMNS).
  schema(): number {
    return this.#db.version();
  }

  head(): number {
    return this.#db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM sync_log')?.s ?? 0;
  }

  // ---- the hub serves the log ------------------------------------------------------------------

  // Entries after `after`, oldest first, up to `limit` entries or about `maxBytes`. `upto` is the
  // seq the reader may move its cursor to: the last entry sent, or the head when nothing is left.
  batch(after: number, o: { limit?: number; maxBytes?: number; peerSchema?: number | null } = {}): Batch {
    const drop = columnsAfter(Number.isInteger(o.peerSchema) ? o.peerSchema! : UNSTATED_SCHEMA);
    const fit = (r: LogRow): LogRow => {
      const cols = r.op === 'put' && r.row ? drop.get(r.tbl) : undefined;
      if (!cols) return r;
      const row = JSON.parse(r.row!) as Record<string, unknown>;
      for (const c of cols) delete row[c];
      return { ...r, row: JSON.stringify(row) };
    };
    const limit = o.limit ?? 500;
    const maxBytes = o.maxBytes ?? 4 * 1024 * 1024;
    const head = this.head();
    const rows: LogRow[] = [];
    let bytes = 0;
    for (const r of this.#db.raw.prepare('SELECT seq, tbl, pk, op, row, hlc FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?').iterate(after, limit + 1) as Iterable<LogRow>) {
      if (rows.length >= limit || (rows.length && bytes + (r.row?.length ?? 0) > maxBytes)) return { rows, upto: rows.at(-1)!.seq, more: true, head };
      rows.push(r.tbl === VAULT && r.op === 'put' ? { ...r, row: this.#withKey(r.row!) } : fit({ ...r }));
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
    this.#scanVault();
    const logged = this.#loggedFiles();
    const present = new Set<string>();
    // What the person was already told is too big to carry, from the open problems themselves, so a
    // restart doesn't tell them again; it closes once the file fits again or is gone.
    const told = new Map<string, number>();
    for (const p of this.#log.problems({ open: true })) {
      const m = p.source === 'sync' ? TOO_BIG.exec(p.message) : null;
      if (m) told.set(m[1]!, p.id);
    }
    const big = new Set<string>();
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
          big.add(r);
          if (!told.has(r)) {
            // A copy the standby already has would go stale: it is told to drop it (the file_delete
            // below, since the file isn't counted as present), so it never serves old content.
            const had = logged.has(r);
            told.set(r, this.#log.problem('sync', `${r} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, so the standby doesn’t get a copy of it${had ? '; its older copy there was removed, so it doesn’t keep stale content' : ''}. If the hub failed, it wouldn’t be on the new hub.`).id);
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
    for (const [path, id] of told) if (!big.has(path)) this.#log.resolve(id);
    for (const path of logged.keys()) if (!present.has(path)) writes.push({ path, data: null });
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

  // Called when the vault changes, so the standby has it now rather than at the next scan (file
  // watching skips vault/, as it skips every folder that isn't journalled).
  vaultChanged(): void {
    if (this.logging()) this.#scanVault();
  }

  // The vault's entry follows its file: a new one when the ciphertext changed, a delete when it went.
  #scanVault(): void {
    if (!this.vault) return;
    const text = this.vault.sealedFile();
    const had = this.#db.get<{ sha: string | null; op: string }>(`SELECT json_extract(row, '$.sha256') AS sha, op FROM sync_log WHERE tbl = ? AND pk = ?`, VAULT, VAULT);
    const sha = text === null ? null : sha256(Buffer.from(text, 'utf8'));
    if (sha === null ? !had || had.op === 'delete' : had?.sha === sha) return;
    this.#db.tx(() => {
      this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', VAULT, VAULT);
      this.#db.run('INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?)', VAULT, VAULT, sha ? 'put' : 'delete', sha ? JSON.stringify({ sha256: sha, file: text }) : null, this.#clock.tick());
    });
  }

  // Only while serving a batch: the key rides inside the sealed payload, never in the log.
  #withKey(row: string): string {
    const key = this.vault?.keyForStandby() ?? null;
    return key ? JSON.stringify({ ...(JSON.parse(row) as object), key }) : row;
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

  // On a standby whose hub went back to a checkpoint (M7 amendment §1): everything it copied goes,
  // the files the log put here included, and it reads the hub's log again from the start. Rows the
  // restore undid are rolled back here too, not forgotten: no backups are cleaned for them.
  fresh(): { rows: number; files: number } {
    let rows = 0;
    let files = 0;
    for (const r of this.#db.all<{ pk: string }>(`SELECT pk FROM sync_log WHERE tbl = ? AND op = 'file_put'`, FILE)) {
      const rel = journalPath(r.pk);
      if (rel) { rmSync(join(this.home, rel), { force: true }); files++; }
    }
    const hadVault = !!this.#db.get(`SELECT 1 FROM sync_log WHERE tbl = ? AND op = 'put'`, VAULT);
    this.#db.raw.exec('PRAGMA foreign_keys = OFF');
    try {
      this.#db.tx(() => {
        for (const t of Object.keys(REPLICATED)) {
          rows += this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}"`)?.n ?? 0;
          this.#db.run(`DELETE FROM "${t}"`);
        }
        this.#db.run('DELETE FROM sync_log');
        this.#db.run('UPDATE sync_state SET cursor = 0 WHERE id = 1');
      });
    } finally {
      this.#db.raw.exec('PRAGMA foreign_keys = ON');
    }
    if (hadVault) this.vault?.clear();
    this.#logged = null;
    this.#seen.clear();
    if (this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { rows, files };
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
    const others = new Map<string, Record<string, unknown>[]>();
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
          if (r.tbl === 'memory' || this.forgetting.has(r.tbl) || (r.tbl === FILE && (r.pk === 'MEMORY.md' || r.pk.startsWith('memory/')))) scrub = true;
          let stored = r.row;
          if (r.tbl === VAULT) stored = this.#applyVault(r);
          else if (r.op === 'put') this.#put(r.tbl, JSON.parse(r.row!) as Record<string, unknown>);
          else if (r.op === 'delete') {
            if (r.tbl === 'memory') {
              const rec = this.#db.get<Record<string, unknown>>('SELECT * FROM memory WHERE id = ?', r.pk);
              if (rec) gone.push(rec);
            } else if (this.forgetting.has(r.tbl)) {
              const keys = REPLICATED[r.tbl]!;
              const values = keys.length === 1 ? [r.pk] : (JSON.parse(r.pk) as (string | number)[]);
              const rec = this.#db.get<Record<string, unknown>>(`SELECT * FROM "${r.tbl}" WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')}`, ...values);
              if (rec) others.set(r.tbl, [...(others.get(r.tbl) ?? []), rec]);
            }
            this.#delete(r.tbl, r.pk);
          } else if (r.op === 'file_put') { this.#writeFile(JSON.parse(r.row!) as FileRow); files++; }
          else { this.#removeFile(r.pk); files++; }
          this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', r.tbl, r.pk);
          this.#db.run('INSERT INTO sync_log (seq, tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?, ?)', r.seq, r.tbl, r.pk, r.op, stored, r.hlc);
        }
        this.#db.run('UPDATE sync_state SET cursor = MAX(cursor, ?) WHERE id = 1', batch.upto);
      });
    } finally {
      this.#db.raw.exec('PRAGMA foreign_keys = ON');
    }
    if (scrub && this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (gone.length) forgotten(gone);
    for (const [tbl, recs] of others) {
      try { this.forgetting.get(tbl)!(recs); } catch (e) { this.#log.problem('sync', `Nova couldn’t finish forgetting what the hub deleted from ${tbl} here.`, { detail: (e as Error)?.stack ?? String(e) }); }
    }
    return { applied: rows.length, files };
  }

  // Refuses an entry that names a table, column, op or path this node doesn't replicate.
  #check(r: LogRow): void {
    const bad = (why: string) => { throw new CoreError('validation', `The hub sent a sync entry Nova can’t apply (${why}).`); };
    if (!r || typeof r !== 'object' || !Number.isInteger(r.seq) || r.seq < 1 || typeof r.pk !== 'string' || typeof r.hlc !== 'string') bad('malformed');
    if (!OPS.includes(r.op)) bad(`op ${String(r.op)}`);
    if (r.tbl === VAULT) {
      if (!this.vault || r.pk !== VAULT || (r.op !== 'put' && r.op !== 'delete')) bad('vault');
      if (r.op === 'put') {
        const v = JSON.parse(String(r.row)) as { sha256?: unknown; file?: unknown };
        if (typeof v.file !== 'string' || v.sha256 !== sha256(Buffer.from(v.file, 'utf8'))) bad('vault');
      }
      return;
    }
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
        // A column this node doesn't have yet (the hub is a release ahead) is left out when the row
        // is applied, and said once; the rest of the batch goes on. Its name must still be a name.
        if (!cols.has(k)) { if (!/^[a-z_][a-z0-9_]{0,63}$/.test(k)) bad(`column ${r.tbl}.${k}`); continue; }
        if (v !== null && typeof v !== 'string' && typeof v !== 'number') bad(`value of ${r.tbl}.${k}`);
      }
      // Only a row that is this table's row plus new columns (a newer release's) is taken that way:
      // one missing any of this node's columns is refused, as before.
      const extra = Object.keys(row).filter((k) => !cols.has(k));
      if (extra.length && [...cols].some((c) => !Object.hasOwn(row, c))) bad(`column ${r.tbl}.${extra[0]}`);
    }
  }

  // The hub's vault and its key: the key goes into this node's own key store (vault.ts), and the
  // entry is kept without it, so this node's log never holds the key either.
  #applyVault(r: LogRow): string | null {
    if (r.op === 'delete') { this.vault!.clear(); return null; }
    const { key, ...rest } = JSON.parse(r.row!) as { sha256: string; file: string; key?: string };
    if (typeof key === 'string') this.vault!.adopt(rest.file, key);
    else this.#log.problem('sync', 'The hub’s vault arrived without its key, so connections that need a secret wouldn’t sign in after a failover. Nova keeps trying with the next change.');
    return JSON.stringify(rest);
  }

  #cols(tbl: string): Set<string> {
    let c = this.#columns.get(tbl);
    if (!c) {
      c = new Set(this.#db.all<{ name: string }>(`PRAGMA table_info("${tbl}")`).map((x) => x.name));
      this.#columns.set(tbl, c);
    }
    return c;
  }

  #skipped = new Set<string>();

  #put(tbl: string, row: Record<string, unknown>): void {
    const known = this.#cols(tbl);
    const cols = Object.keys(row).filter((c) => known.has(c));
    for (const c of Object.keys(row)) {
      if (known.has(c) || this.#skipped.has(`${tbl}.${c}`)) continue;
      this.#skipped.add(`${tbl}.${c}`);
      // Recorded as a problem: the person should update this standby.
      this.#log.problem('sync', `The hub sent ${tbl}.${c}, which this standby doesn’t have yet: it is a release behind. That column is left out of its copy until it is updated.`);
    }
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
