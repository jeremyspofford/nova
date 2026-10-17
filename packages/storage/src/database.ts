// SQLite connection for the Hub (docs/06, ADR-002, ADR-083).
// One connection per process; writes are serialized through `transaction()` so that async
// callers can never interleave statements inside another caller's transaction.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.ts';

export type Orm = SqliteRemoteDatabase<typeof schema>;

export interface OpenOptions {
  /** File path, or ':memory:'. Parent directories are created. */
  path: string;
  readOnly?: boolean;
  /** Milliseconds to wait on a locked database (default 5000). */
  busyTimeoutMs?: number;
}

export class NovaDatabase {
  readonly path: string;
  readonly raw: DatabaseSync;
  readonly orm: Orm;
  #queue: Promise<unknown> = Promise.resolve();
  #inTx = false;

  constructor(opts: OpenOptions) {
    this.path = opts.path;
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.raw = new DatabaseSync(opts.path, { readOnly: opts.readOnly ?? false });
    this.raw.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
    if (!opts.readOnly) {
      if (opts.path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.orm = drizzle(
      (sql, params, method) =>
        Promise.resolve(this.#execute(sql, params as SQLInputValue[], method)),
      { schema },
    );
  }

  #execute(sql: string, params: SQLInputValue[], method: 'run' | 'all' | 'values' | 'get') {
    const stmt = this.raw.prepare(sql);
    if (method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    stmt.setReturnArrays(true);
    if (method === 'get') {
      const row = stmt.get(...params) as unknown[] | undefined;
      return { rows: row ?? [] };
    }
    return { rows: stmt.all(...params) as unknown as unknown[][] };
  }

  /**
   * Run `fn` inside `BEGIN IMMEDIATE … COMMIT`, serialized with every other transaction on this
   * connection. A throw rolls back and rethrows. Nested calls join the outer transaction.
   */
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.#inTx) return fn();
    const run = async (): Promise<T> => {
      this.raw.exec('BEGIN IMMEDIATE');
      this.#inTx = true;
      try {
        const out = await fn();
        this.raw.exec('COMMIT');
        return out;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      } finally {
        this.#inTx = false;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Consistent online copy of the database (`VACUUM INTO`). The target must not exist. */
  backupTo(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    this.raw.prepare('VACUUM INTO ?').run(target);
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}

export function openDatabase(opts: OpenOptions): NovaDatabase {
  return new NovaDatabase(opts);
}
