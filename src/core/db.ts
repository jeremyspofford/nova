// SQLite for structured state (ADR-4), through Node's built-in driver: no dependency.
// Migrations are forward-only and checksummed; a file database is backed up before any upgrade,
// and "rolling back" means restoring that backup, never running down-SQL. Ported from Era 1's
// storage package (6e2cf142, packages/storage/src/migrations.ts) without its ORM.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError } from './errors.ts';
import { sha256 } from './workspace.ts';

export interface Migration { version: number; name: string; sql: string; checksum: string }
export interface MigrateResult { from: number; to: number; applied: number[]; backup: string | null }

// JSON columns, read three ways: null for a non-string; the fallback for an empty or unreadable
// value; null for an empty one (unreadable JSON throws).
export const fromJson = <T>(s: unknown): T => (typeof s === 'string' ? JSON.parse(s) : null) as T;
export const jsonOr = <T>(s: string | null, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };
export const jsonOrNull = <T>(s: string | null): T | null => (s ? JSON.parse(s) as T : null);

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = FILE.exec(file);
    if (!m) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    out.push({ version: Number(m[1]), name: m[2] ?? file, sql, checksum: sha256(sql) });
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
  #depth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
  }

  // Synchronous on purpose: every statement in the core is synchronous, so a transaction can
  // never interleave with another caller's. A nested call is a savepoint inside the outer
  // transaction: it commits with the outer one, and if it throws, only its own writes are undone,
  // so a caller that catches the error never keeps half of what failed.
  tx<T>(fn: () => T): T {
    if (this.#inTx) {
      const sp = `nova_sp_${++this.#depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      try {
        const out = fn();
        this.raw.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.#depth--;
      }
    }
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

  // `before(from, to)`: called once an upgrade is certain and before anything changes (the core takes
  // an automatic checkpoint there); if it throws, nothing is upgraded.
  //
  // A failed upgrade (F-020) leaves the database exactly as it was: every pending migration runs in
  // one transaction, so a step that fails undoes the steps before it too. It throws an UpgradeError
  // in plain words, naming the copy from before. What failed is written down beside that copy
  // (UPGRADE_FAILED); a later start that tries the same upgrade on the same, unchanged database uses
  // that copy again and takes no new checkpoint, so failed starts don't pile up copies.
  migrate(opts: { migrations?: Migration[]; backupDir?: string; now?: () => Date; before?: (from: number, to: number) => void } = {}): MigrateResult {
    const migrations = opts.migrations ?? loadMigrations();
    const now = opts.now ?? (() => new Date());
    this.#ensureLedger();
    const applied = this.all<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of applied) {
      const m = known.get(row.version);
      if (!m) throw new UpgradeError(`The database is at migration ${row.version}, newer than this version of Nova knows. Refusing to run. Start the newer version of Nova that upgraded it.`);
      if (m.checksum !== row.checksum) throw new UpgradeError(`Migration ${row.version} (${row.name}) was edited after it was applied.`);
    }
    const from = applied.at(-1)?.version ?? 0;
    const pending = migrations.filter((m) => m.version > from);
    if (!pending.length) return { from, to: from, applied: [], backup: null };
    const to = pending.at(-1)!.version;

    const file = this.path !== ':memory:' && from > 0;
    let backup: string | null = null;
    let tried: FailedUpgrade | null = null;
    let fingerprint: string | null = null;
    if (file) {
      if (!opts.backupDir) throw new CoreError('validation', 'A backup folder is required to upgrade a database file.');
      tried = readFailed(opts.backupDir);
      if (tried) fingerprint = this.#fingerprint();
      // The same upgrade failed on this same database before: its copy is still the one from before.
      if (tried && tried.from === from && tried.to === to && tried.db === fingerprint && existsSync(tried.backup)) {
        backup = tried.backup;
        const t = now();
        utimesSync(backup, t, t);
      } else {
        opts.before?.(from, to);
        mkdirSync(opts.backupDir, { recursive: true });
        backup = join(opts.backupDir, `nova-${now().toISOString().replace(/[:.]/g, '-')}-v${from}.db`);
        this.raw.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      }
    }
    let at: Migration | null = null;
    try {
      this.tx(() => {
        for (const m of pending) {
          at = m;
          this.raw.exec(m.sql);
          this.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', m.version, m.name, m.checksum, now().toISOString());
        }
      });
    } catch (e) {
      const step = at as Migration | null;
      const why = `migration ${step?.version ?? '?'} (${step?.name ?? 'unknown'}) failed: ${(e as Error).message}`;
      if (!file || !backup || !opts.backupDir) throw new UpgradeError(`Nova couldn’t upgrade its database from version ${from} to ${to}: ${why}. Nothing was changed.`);
      writeFailed(opts.backupDir, { from, to, at: now().toISOString(), backup, error: why, db: fingerprint ?? this.#fingerprint() });
      throw new UpgradeError(`Nova couldn’t upgrade its database from version ${from} to ${to}: ${why}. Nothing was changed: your data is as it was before the upgrade, and a copy of it is at ${backup}. Run the version of Nova you had before, or report this; starting this version again tries once more without making another copy.`);
    }
    if (opts.backupDir) rmSync(join(opts.backupDir, UPGRADE_FAILED), { force: true });
    return { from, to, applied: pending.map((m) => m.version), backup };
  }

  // What the database holds, as a hash of its file with everything written folded in.
  #fingerprint(): string {
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const h = createHash('sha256');
    const fd = openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      for (let pos = 0, n = 0; (n = readSync(fd, buf, 0, buf.length, pos)) > 0; pos += n) h.update(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
    return h.digest('hex');
  }

  close(): void {
    this.raw.close();
  }

  #ensureLedger(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  }
}

// A database upgrade that couldn't finish, said in plain words: the start line prints it as it is.
export class UpgradeError extends CoreError {
  constructor(message: string) { super('conflict', message); }
}

// The record of a failed upgrade, beside the pre-upgrade copies (never in a backup or checkpoint).
export const UPGRADE_FAILED = 'upgrade-failed.json';
interface FailedUpgrade { from: number; to: number; at: string; backup: string; error: string; db: string }
function readFailed(dir: string): FailedUpgrade | null {
  try { return JSON.parse(readFileSync(join(dir, UPGRADE_FAILED), 'utf8')) as FailedUpgrade; } catch { return null; }
}
function writeFailed(dir: string, f: FailedUpgrade): void {
  try { writeFileSync(join(dir, UPGRADE_FAILED), `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 }); } catch { /* a full disk: the next start makes a copy again */ }
}

// Replace a closed database file with a backup. WAL side files go, so the restore is self-contained.
export function restoreBackup(dbPath: string, backup: string): void {
  if (!existsSync(backup)) throw new CoreError('not_found', `No backup at ${backup}.`);
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  copyFileSync(backup, dbPath);
}
