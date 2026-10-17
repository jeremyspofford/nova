// Forward-only migrations with a backup before every upgrade (docs/06 §5, docs/15 §4).
// "Rolling back" a migration means restoring the pre-upgrade backup, never running down-SQL.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NovaError } from '@nova/shared';
import type { NovaDatabase } from './database.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
  backupPath: string | null;
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = FILE.exec(file);
    if (!m) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    out.push({
      version: Number(m[1]),
      name: m[2] ?? file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i]?.version !== i + 1) {
      throw new NovaError(
        'conflict',
        `migrations must be numbered 0001.. without gaps (at ${i + 1})`,
      );
    }
  }
  return out;
}

function ensureLedger(db: NovaDatabase): void {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

export function currentVersion(db: NovaDatabase): number {
  ensureLedger(db);
  const row = db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}

export interface MigrateOptions {
  migrations?: Migration[];
  /** Directory for pre-upgrade backups. Required for file databases. */
  backupDir?: string;
  now?: () => Date;
}

export async function migrate(db: NovaDatabase, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = opts.migrations ?? loadMigrations();
  const now = opts.now ?? (() => new Date());
  ensureLedger(db);
  const applied = db.raw
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string }[];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    const known = byVersion.get(row.version);
    if (!known) {
      throw new NovaError(
        'conflict',
        `database is at migration ${row.version}, newer than this build knows; refusing to run`,
      );
    }
    if (known.checksum !== row.checksum) {
      throw new NovaError(
        'conflict',
        `migration ${row.version} (${row.name}) was edited after it was applied`,
      );
    }
  }
  const from = applied.at(-1)?.version ?? 0;
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, applied: [], backupPath: null };

  let backupPath: string | null = null;
  if (db.path !== ':memory:' && from > 0) {
    if (!opts.backupDir)
      throw new NovaError('validation', 'backupDir is required to upgrade a file database');
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    backupPath = join(opts.backupDir, `nova-${stamp}-v${from}.db`);
    db.backupTo(backupPath);
  }

  for (const m of pending) {
    await db.transaction(() => {
      db.raw.exec(m.sql);
      db.raw
        .prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(m.version, m.name, m.checksum, now().toISOString());
    });
  }
  return {
    from,
    to: pending.at(-1)?.version ?? from,
    applied: pending.map((m) => m.version),
    backupPath,
  };
}

/**
 * Replace a database file with a backup. The database must be closed. WAL and SHM side files
 * are removed so the restored file is self-contained.
 */
export function restoreBackup(dbPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) throw new NovaError('not_found', `backup not found: ${backupPath}`);
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  copyFileSync(backupPath, dbPath);
}
