// SQLite for structured state (ADR-4), through Node's built-in driver: no dependency.
// Migrations are forward-only and checksummed; a file database is backed up before any upgrade,
// and "rolling back" means restoring that backup, never running down-SQL. Ported from Era 1's
// storage package (6e2cf142, packages/storage/src/migrations.ts) without its ORM.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError } from './errors.ts';

export interface Migration { version: number; name: string; sql: string; checksum: string }
export interface MigrateResult { from: number; to: number; applied: number[]; backup: string | null }

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = FILE.exec(file);
    if (!m) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    out.push({ version: Number(m[1]), name: m[2] ?? file, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new CoreError('conflict', `Migrations must be numbered 0001 upward without gaps (gap at ${i + 1}).`);
  });
  return out;
}

export class Db {
  readonly path: string;
  readonly raw: DatabaseSync;
  #inTx = false;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
  }

  // Synchronous on purpose: every statement in the core is synchronous, so a transaction can
  // never interleave with another caller's. Nested calls join the outer transaction.
  tx<T>(fn: () => T): T {
    if (this.#inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.#inTx = true;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.#inTx = false;
    }
  }

  all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: (string | number | null)[]): void {
    this.raw.prepare(sql).run(...params);
  }

  version(): number {
    this.#ensureLedger();
    return this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  }

  migrate(opts: { migrations?: Migration[]; backupDir?: string; now?: () => Date } = {}): MigrateResult {
    const migrations = opts.migrations ?? loadMigrations();
    const now = opts.now ?? (() => new Date());
    this.#ensureLedger();
    const applied = this.all<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of applied) {
      const m = known.get(row.version);
      if (!m) throw new CoreError('conflict', `The database is at migration ${row.version}, newer than this version of Nova knows. Refusing to run.`);
      if (m.checksum !== row.checksum) throw new CoreError('conflict', `Migration ${row.version} (${row.name}) was edited after it was applied.`);
    }
    const from = applied.at(-1)?.version ?? 0;
    const pending = migrations.filter((m) => m.version > from);
    if (!pending.length) return { from, to: from, applied: [], backup: null };

    let backup: string | null = null;
    if (this.path !== ':memory:' && from > 0) {
      if (!opts.backupDir) throw new CoreError('validation', 'A backup folder is required to upgrade a database file.');
      mkdirSync(opts.backupDir, { recursive: true });
      backup = join(opts.backupDir, `nova-${now().toISOString().replace(/[:.]/g, '-')}-v${from}.db`);
      this.raw.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    for (const m of pending) {
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', m.version, m.name, m.checksum, now().toISOString());
      });
    }
    return { from, to: pending.at(-1)?.version ?? from, applied: pending.map((m) => m.version), backup };
  }

  close(): void {
    this.raw.close();
  }

  #ensureLedger(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  }
}

// Replace a closed database file with a backup. WAL side files go, so the restore is self-contained.
export function restoreBackup(dbPath: string, backup: string): void {
  if (!existsSync(backup)) throw new CoreError('not_found', `No backup at ${backup}.`);
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  copyFileSync(backup, dbPath);
}
