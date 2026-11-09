// The integrity scrub's database check (docs/plans/integrity-scrub.md), in a worker thread so the
// scrub can stop it at its time bound: SQLite can't be interrupted part-way from Node's driver.
// Read-only: `immutable` when Nova isn't holding the database (no WAL file), so SQLite creates no
// side files; a plain read-only connection otherwise, which reads the WAL alongside Nova's writer.
// It answers counts and fixed words only, never SQLite's message text (it can name tables and
// indexes, and in some versions quote values).
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export interface DbCheckInput { path: string; full: boolean }
export type FindingKind = 'page' | 'btree' | 'index' | 'freelist' | 'other';
export interface DbCheckResult {
  state: 'ok' | 'problem' | 'unavailable';
  // 'corrupt': SQLite's check found damage; 'unreadable': the file isn't a database it can open.
  why: 'corrupt' | 'unreadable' | 'missing' | 'error' | null;
  findings: number;
  kinds: Partial<Record<FindingKind, number>>;
}

const LIMIT = 100;

function kindOf(line: string): FindingKind {
  if (/index/i.test(line)) return 'index';
  if (/freelist/i.test(line)) return 'freelist';
  if (/btree|tree \d+ page|cell|overflow/i.test(line)) return 'btree';
  if (/^page \d+/i.test(line)) return 'page';
  return 'other';
}

export function checkDatabase(input: DbCheckInput, phase: (p: 'opening' | 'checking') => void = () => {}): DbCheckResult {
  if (!existsSync(input.path)) return { state: 'unavailable', why: 'missing', findings: 0, kinds: {} };
  let db: DatabaseSync | null = null;
  phase('opening');
  try {
    if (existsSync(`${input.path}-wal`)) db = new DatabaseSync(input.path, { readOnly: true });
    else {
      const url = pathToFileURL(input.path);
      url.searchParams.set('immutable', '1');
      db = new DatabaseSync(url, { readOnly: true });
    }
    db.exec('PRAGMA busy_timeout = 2000');
    phase('checking');
    const rows = db.prepare(`PRAGMA ${input.full ? 'integrity_check' : 'quick_check'}(${LIMIT})`).all() as Record<string, unknown>[];
    const lines = rows.flatMap((r) => String(Object.values(r)[0] ?? '').split('\n')).map((l) => l.trim()).filter((l) => l && !/^\*\*\* in database/.test(l));
    if (lines.length === 1 && lines[0] === 'ok') return { state: 'ok', why: null, findings: 0, kinds: {} };
    const kinds: Partial<Record<FindingKind, number>> = {};
    for (const l of lines) { const k = kindOf(l); kinds[k] = (kinds[k] ?? 0) + 1; }
    return { state: 'problem', why: 'corrupt', findings: lines.length, kinds };
  } catch (e) {
    const err = e as { message?: string; errcode?: number };
    const code = (err.errcode ?? 0) & 0xff;
    // SQLITE_CORRUPT (11) and SQLITE_NOTADB (26): the file is damaged. Anything else (busy, I/O,
    // permissions) is not evidence of damage, so it is reported as unavailable.
    if (code === 11 || code === 26 || /malformed|not a database|corrupt/i.test(err.message ?? '')) return { state: 'problem', why: 'unreadable', findings: 1, kinds: { other: 1 } };
    return { state: 'unavailable', why: 'error', findings: 0, kinds: {} };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

if (parentPort && workerData && typeof (workerData as DbCheckInput).path === 'string') {
  const port = parentPort;
  port.postMessage(checkDatabase(workerData as DbCheckInput, (p) => port.postMessage({ phase: p })));
}
