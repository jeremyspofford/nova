// Tables and rows of a data export (FR-105, ADR-097 D5). Every table travels except bookkeeping
// (`schema_migrations`, SQLite's own tables) and what the database derives from other tables (the
// full-text indexes and their shadow tables, and `message_search`, which triggers fill from
// `message_part`): an import rebuilds those as it writes the base rows.
//
// A row is one JSON object per line, columns in table order. Values keep their SQLite type
// exactly: an integer is a JSON number (or `{"$i": "<digits>"}` past 2^53), a real with a
// fraction is a JSON number and a whole real is `{"$r": n}`, text is a string, a blob is
// `{"$b": "<base64>"}`. So a table written back and exported again hashes the same.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { NovaError } from '@nova/shared';

/** A `secret://` reference inside any text (the vault's own reference grammar). */
export const SECRET_REF_PATTERN = /secret:\/\/[a-z0-9][a-z0-9_.-]*(?:\/[A-Za-z0-9_.:-]+)+/g;

/**
 * Logs: what they say is history, never resolved or followed (secret references and paths in
 * them are left alone), and the audit log is append-only and hash-chained.
 */
export const LOG_TABLES: readonly string[] = ['audit_event', 'event'];

/** Tables the database fills itself (triggers) from rows that do travel. */
export const DERIVED_TABLES: readonly string[] = ['message_search'];
const META_TABLES = new Set(['schema_migrations']);

export interface TableInfo {
  name: string;
  columns: string[];
  /** `rowid`, or the primary key columns of a WITHOUT ROWID table: the order rows travel in. */
  orderBy: string;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export { quote as quoteIdent };

/** The tables an export carries, in name order. */
export function dataTables(db: DatabaseSync): TableInfo[] {
  const all = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string; sql: string | null }[];
  const virtual = all
    .filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? ''))
    .map((t) => t.name);
  const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
  const out: TableInfo[] = [];
  for (const t of all) {
    if (t.name.startsWith('sqlite_') || META_TABLES.has(t.name)) continue;
    if (virtual.includes(t.name) || shadow(t.name) || DERIVED_TABLES.includes(t.name)) continue;
    const cols = db.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as {
      name: string;
      pk: number;
    }[];
    const wr = db
      .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
      .get(t.name) as { wr: number } | undefined;
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quote(c.name));
    out.push({
      name: t.name,
      columns: cols.map((c) => c.name),
      orderBy: wr?.wr === 1 && pk.length ? pk.join(', ') : 'rowid',
    });
  }
  return out;
}

/**
 * The tables delete-all and import empty: every table that is not bookkeeping, derived ones
 * included, and the full-text indexes (`virtual`), which are rebuilt rather than deleted from.
 */
export function storedTables(db: DatabaseSync): { tables: string[]; virtual: string[] } {
  const all = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string; sql: string | null }[];
  const virtual = all
    .filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? ''))
    .map((t) => t.name);
  const tables = all
    .filter(
      (t) =>
        !t.name.startsWith('sqlite_') &&
        !META_TABLES.has(t.name) &&
        !virtual.includes(t.name) &&
        !virtual.some((v) => t.name.startsWith(`${v}_`)),
    )
    .map((t) => t.name);
  return { tables, virtual };
}

/** Rebuild every full-text index from its content (after rows were deleted or written). */
export function rebuildSearch(db: DatabaseSync, virtual: readonly string[]): void {
  for (const v of virtual) {
    const q = quote(v);
    db.prepare(`INSERT INTO ${q}(${q}) VALUES ('rebuild')`).run();
  }
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** One SQLite value as JSON (read with `setReadBigInts(true)`, so integers are bigints). */
export function encodeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : { $i: String(v) };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { $r: String(v) };
    return Number.isInteger(v) ? { $r: v } : v;
  }
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return { $b: Buffer.from(v).toString('base64') };
  throw new TypeError(`unexpected SQLite value ${typeof v}`);
}

const bad = (table: string, why: string) =>
  new NovaError('validation', `the archive's ${table} rows are malformed: ${why}`, {
    details: { reason: 'archive_damaged', table },
  });

/** A JSON value back to what SQLite stores (integers bind as bigints, reals as numbers). */
export function decodeCell(v: unknown, table: string): SQLInputValue {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw bad(table, 'a number is out of range');
    return Number.isInteger(v) ? BigInt(v) : v;
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      if (typeof o.$i === 'string' && /^-?\d{1,20}$/.test(o.$i)) return BigInt(o.$i);
      if (typeof o.$r === 'number' && Number.isFinite(o.$r)) return o.$r;
      if (o.$r === 'Infinity' || o.$r === '-Infinity') return Number(o.$r);
      if (typeof o.$b === 'string') return Buffer.from(o.$b, 'base64');
    }
  }
  throw bad(table, 'a value has an unknown form');
}

/** One row as its JSON line (with the newline). */
export function encodeRow(row: Record<string, unknown>, columns: readonly string[]): string {
  const o: Record<string, unknown> = {};
  for (const c of columns) o[c] = encodeCell(row[c]);
  return `${JSON.stringify(o)}\n`;
}

/** Iterate a table's rows in travel order, as JSON lines. */
export function* tableLines(db: DatabaseSync, t: TableInfo): Generator<string> {
  const stmt = db.prepare(`SELECT * FROM ${quote(t.name)} ORDER BY ${t.orderBy}`);
  stmt.setReadBigInts(true);
  for (const row of stmt.iterate()) yield encodeRow(row, t.columns);
}

/** Parse one line back into column values for `columns` (unknown columns are refused). */
export function decodeLine(
  line: string,
  table: string,
  columns: ReadonlySet<string>,
): Map<string, SQLInputValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw bad(table, 'a line is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw bad(table, 'a line is not an object');
  const out = new Map<string, SQLInputValue>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!columns.has(k)) throw bad(table, `unknown column ${k}`);
    out.set(k, decodeCell(v, table));
  }
  return out;
}
