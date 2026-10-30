// Database backups (the copies taken before every upgrade, db.ts) and the rule that keeps them
// honest: anything the person has Nova forget is forgotten in every backup too. Each backup is
// cleaned in place, so it stays restorable and can never bring a forgotten memory back.
// Retention: backups are kept until the person removes them, except that a backup Nova can't
// clean is destroyed (and that is reported), never kept with the forgotten content in it.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Log } from './log.ts';

export interface Backup { path: string; bytes: number; at: string }

const TABLE = /^[a-z_]+$/;

export class Backups {
  readonly dir: string;
  #log: Log;

  constructor(o: { dir: string; log: Log }) {
    this.dir = o.dir;
    this.#log = o.log;
  }

  list(): Backup[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.db')).sort().map((f) => {
      const path = join(this.dir, f);
      const s = statSync(path);
      return { path, bytes: s.size, at: s.mtime.toISOString() };
    });
  }

  // Delete rows by id from one table in every backup, overwriting the freed pages and rebuilding
  // the file. A backup without that table (older than the feature) has nothing to clean. A backup
  // with a sync log (M4c) loses the log's entries for those rows too, and, for memory, any entry of
  // memory's or of the files that show it (MEMORY.md, the day notes) that still carries `words`.
  forget(table: string, ids: string[], words: string[] = []): { cleaned: string[]; destroyed: string[] } {
    if (!TABLE.test(table)) throw new Error(`Not a table name: ${table}`);
    const cleaned: string[] = [];
    const destroyed: string[] = [];
    if (!ids.length) return { cleaned, destroyed };
    for (const { path } of this.list()) {
      try {
        const db = new DatabaseSync(path);
        try {
          db.exec('PRAGMA secure_delete = ON');
          const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
          if (has) {
            // The whole chain goes at once, so records that point at each other (a correction and
            // what it corrected) can't block one another.
            db.exec('PRAGMA foreign_keys = OFF');
            db.exec('BEGIN');
            const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
            for (const id of ids) del.run(id);
            if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_log'`).get()) {
              const entry = db.prepare('DELETE FROM sync_log WHERE tbl = ? AND pk = ?');
              for (const id of ids) entry.run(table, id);
              if (table === 'memory') {
                const carrying = db.prepare(`DELETE FROM sync_log WHERE (tbl = 'memory' OR (tbl = 'file' AND (pk = 'MEMORY.md' OR pk LIKE 'memory/%'))) AND instr(row, ?) > 0`);
                for (const w of words) for (const v of new Set([w.trim(), w.trim().replace(/\s+/g, ' ')])) if (v) carrying.run(JSON.stringify(v).slice(1, -1));
              }
            }
            db.exec('COMMIT');
            db.exec('VACUUM');
          }
        } finally {
          db.close();
        }
        cleaned.push(path);
      } catch (e) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
        destroyed.push(path);
        this.#log.problem('backups', 'A backup couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that backup rather than keep it.', { detail: `${path}: ${(e as Error).message}` });
      }
    }
    return { cleaned, destroyed };
  }
}
