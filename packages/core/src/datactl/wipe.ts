// Delete-all (FR-105, ADR-097 D5; docs/12 §9 "delete everything"): every row of every table, every
// vault entry and the data folder's files, in that order. Only the owner's bare account, their
// owner row and the session that asked are kept, so the owner stays signed in and can import at
// once. The append-only audit log is emptied too; the caller then appends the deletion's own entry,
// which becomes the first entry of the new log. The database is compacted afterwards so deleted
// rows do not linger in free pages or the write-ahead log.
import { lstatSync, readdirSync, rmSync, truncateSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { quoteIdent, rebuildSearch, storedTables } from './codec.ts';
import { whenIdle } from './exporter.ts';
import { KEEP_ENTRIES, WIPE_ROOTS } from './files.ts';
import { clearTable } from './importer.ts';

export interface WipeOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  dataDir: string;
  ownerAccountId: string;
  /** The owner's session that asked (an `auth_token` id): kept so they stay signed in. */
  keepSessionId: string | null;
}

export interface WipeResult {
  tables: number;
  rows: number;
  files: number;
  secrets: number;
  /** Entries of the data folder delete-all does not know (left alone). */
  keptPaths: string[];
}

function readRow(
  db: NovaDatabase,
  sql: string,
  ...args: string[]
): Record<string, SQLInputValue> | undefined {
  const stmt = db.raw.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt.get(...args);
}

function insertRow(db: NovaDatabase, table: string, row: Record<string, SQLInputValue>): void {
  const cols = Object.keys(row);
  db.raw
    .prepare(
      `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`,
    )
    .run(...cols.map((c) => row[c] ?? null));
}

function countFiles(abs: string): number {
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return 1;
  let n = 0;
  for (const name of readdirSync(abs)) n += countFiles(join(abs, name));
  return n;
}

export async function wipeHub(opts: WipeOptions): Promise<WipeResult> {
  const { db } = opts;
  const counts = await db.transaction(() => {
    db.raw.exec('PRAGMA defer_foreign_keys = ON');
    const account = readRow(db, 'SELECT * FROM account WHERE id = ?', opts.ownerAccountId);
    const member = readRow(
      db,
      "SELECT * FROM team_member WHERE account_id = ? AND role = 'owner'",
      opts.ownerAccountId,
    );
    const session = opts.keepSessionId
      ? readRow(db, 'SELECT * FROM auth_token WHERE id = ?', opts.keepSessionId)
      : undefined;
    const { tables, virtual } = storedTables(db.raw);
    let rows = 0;
    let emptied = 0;
    for (const t of tables) {
      const n = clearTable(db.raw, t);
      rows += n;
      if (n) emptied++;
    }
    rebuildSearch(db.raw, virtual);
    // The owner's account, bare: no picture, username or address (their blobs are gone).
    if (account)
      insertRow(db, 'account', { ...account, avatar_path: null, username: null, email: null });
    if (member) insertRow(db, 'team_member', member);
    if (session) insertRow(db, 'auth_token', session);
    return { tables: emptied, rows };
  });

  let secrets = 0;
  for (const ref of await opts.secrets.list()) if (await opts.secrets.delete(ref)) secrets++;

  let files = 0;
  const keptPaths: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(opts.dataDir);
  } catch {
    entries = [];
  }
  for (const name of entries.sort()) {
    const abs = join(opts.dataDir, name);
    if (WIPE_ROOTS.includes(name)) {
      files += countFiles(abs);
      rmSync(abs, { recursive: true, force: true });
    } else if (name === 'logs') {
      // The logger holds its file open: empty the files rather than remove them.
      for (const f of readdirSync(abs)) {
        const p = join(abs, f);
        try {
          if (lstatSync(p).isFile()) {
            truncateSync(p, 0);
            files++;
          }
        } catch {
          // gone already
        }
      }
    } else if (!KEEP_ENTRIES.includes(name)) {
      keptPaths.push(name);
    }
  }

  // Compact: deleted rows must not survive in free pages or the write-ahead log.
  await whenIdle(db, () => {
    db.raw.exec('VACUUM');
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  });
  return { ...counts, files, secrets, keptPaths };
}
