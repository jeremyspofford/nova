// The device's offline queue (M4 plan §2): events, task requests, memory notes and config changes
// made on this computer, kept in <device home>/state/queue.db until the hub has answered each one.
// Every item has an idempotency key, so sending it again (the reply was lost, the agent restarted)
// can't make it happen twice: the hub takes each key in exactly once. Items go out in the order
// they were made. Part of the runtime agent; the boot agent's `queue` command writes here too.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const QUEUE_KINDS = ['event', 'task_request', 'memory_note', 'config_change'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export interface QueueItem { seq: number; key: string; kind: QueueKind; body: Record<string, unknown>; created_at: string }
export interface QueueResult { key: string; status: 'accepted' | 'refused' | 'rejected'; duplicate?: boolean; reason?: string; ref?: string }
export interface SettledItem { seq: number; key: string; kind: QueueKind; created_at: string; delivered_at: string; status: string; reason: string | null; ref: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  status TEXT,
  reason TEXT,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS item_pending ON item (seq) WHERE delivered_at IS NULL;`;

export class Queue {
  readonly file: string;
  #db: DatabaseSync;

  constructor(file: string) {
    this.file = file;
    this.#db = new DatabaseSync(file);
    // Two writers share this file (the runtime, and the boot agent's queue command), so each waits
    // for the other rather than failing.
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(SCHEMA);
  }

  // Keeps an item to send. A key the caller gives makes adding it again a no-op.
  add(kind: QueueKind, body: Record<string, unknown>, key: string = `q-${randomUUID()}`): { key: string; seq: number; added: boolean } {
    if (!QUEUE_KINDS.includes(kind)) throw new Error(`kind must be one of ${QUEUE_KINDS.join(', ')}.`);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('body must be an object.');
    if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw new Error('key must be 8–100 letters, digits or ._:-');
    const r = this.#db.prepare('INSERT OR IGNORE INTO item (key, kind, body, created_at) VALUES (?, ?, ?, ?)').run(key, kind, JSON.stringify(body), new Date().toISOString());
    const row = this.#db.prepare('SELECT seq FROM item WHERE key = ?').get(key) as { seq: number };
    return { key, seq: row.seq, added: r.changes > 0 };
  }

  // The oldest items not yet answered, in the order they were made.
  pending(limit = 50): QueueItem[] {
    const rows = this.#db.prepare('SELECT seq, key, kind, body, created_at FROM item WHERE delivered_at IS NULL ORDER BY seq LIMIT ?').all(limit) as Array<Omit<QueueItem, 'body'> & { body: string }>;
    return rows.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> }));
  }

  // The hub answered: the item is done, however it was answered. Its body is dropped, so words
  // the hub may later be asked to forget don't linger here; the key and the answer stay.
  settle(results: QueueResult[]): void {
    const at = new Date().toISOString();
    const st = this.#db.prepare('UPDATE item SET delivered_at = ?, status = ?, reason = ?, ref = ?, body = NULL WHERE key = ? AND delivered_at IS NULL');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of results) st.run(at, r.status, r.reason ?? null, r.ref ?? null, r.key);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  settled(limit = 50): SettledItem[] {
    return this.#db.prepare('SELECT seq, key, kind, created_at, delivered_at, status, reason, ref FROM item WHERE delivered_at IS NOT NULL ORDER BY seq DESC LIMIT ?').all(limit) as unknown as SettledItem[];
  }

  counts(): { pending: number; delivered: number; refused: number } {
    const r = this.#db.prepare(`SELECT
      SUM(delivered_at IS NULL) AS pending,
      SUM(delivered_at IS NOT NULL) AS delivered,
      SUM(status IN ('refused', 'rejected')) AS refused FROM item`).get() as { pending: number | null; delivered: number | null; refused: number | null };
    return { pending: r.pending ?? 0, delivered: r.delivered ?? 0, refused: r.refused ?? 0 };
  }

  close(): void {
    this.#db.close();
  }
}
