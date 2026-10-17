// The network change log behind one-click rollback (docs/22 §6 step 8, §9.5; FR-136, FR-139).
// Every network change is recorded with a serializable undo descriptor; the area that made the
// change registers an undo handler for its kind (the network panel's settings, a setup step, a
// trust mode change). Rolling back runs the handler and marks the change; a failed undo leaves the
// change applied with its error, so the owner can retry. Descriptors never hold secrets, only
// `secret://` references (docs/12 §5). Rows live in `network_change` (migration 0029).
import { NovaError, uuidv7, type NetworkChangeView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';

/** A JSON-serializable description of how to undo a change. */
export type NetworkUndo = Record<string, unknown>;

export interface NetworkChangeInput {
  /** Which undo handler reverts it, e.g. `network.settings`, `setup.step`, `trust.mode`. */
  kind: string;
  /** One line for the panel and the audit log. */
  summary: string;
  undo: NetworkUndo;
  accountId?: string | null;
  /** `user`, `system` or `agent:<id>` (default `user`). */
  actor?: string;
}

export type NetworkUndoHandler = (undo: NetworkUndo, change: NetworkChangeView) => Promise<void>;

export type NetworkChangeListener = (change: NetworkChangeView) => void;

interface ChangeRow {
  id: string;
  account_id: string | null;
  actor: string;
  kind: string;
  summary: string;
  undo_json: string;
  status: 'applied' | 'rolled_back';
  error: string | null;
  created_at: string;
  rolled_back_at: string | null;
}

function view(r: ChangeRow): NetworkChangeView {
  return {
    id: r.id,
    kind: r.kind,
    summary: r.summary,
    actor: r.actor,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    rolledBackAt: r.rolled_back_at,
  };
}

export interface NetworkChangeLogOptions {
  db: NovaDatabase;
  now?: () => Date;
}

export class NetworkChangeLog {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #handlers = new Map<string, NetworkUndoHandler>();
  readonly #listeners = new Set<NetworkChangeListener>();
  /** One rollback at a time: two concurrent undos could fight over the same settings. */
  #rollingBack = false;

  constructor(opts: NetworkChangeLogOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
  }

  /** The handler that reverts changes of `kind`; returns its removal. */
  registerUndo(kind: string, handler: NetworkUndoHandler): () => void {
    this.#handlers.set(kind, handler);
    return () => {
      if (this.#handlers.get(kind) === handler) this.#handlers.delete(kind);
    };
  }

  /** Called after every record and rollback (the area emits `network.changed`). */
  onChange(listener: NetworkChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async record(input: NetworkChangeInput): Promise<NetworkChangeView> {
    if (!input.kind || input.kind.length > 100) throw new NovaError('validation', 'a change kind');
    const undoJson = JSON.stringify(input.undo);
    if (undoJson.length > 64 * 1024)
      throw new NovaError('validation', 'the undo descriptor is too large');
    const row: ChangeRow = {
      id: uuidv7(),
      account_id: input.accountId ?? null,
      actor: input.actor ?? 'user',
      kind: input.kind,
      summary: input.summary.slice(0, 500),
      undo_json: undoJson,
      status: 'applied',
      error: null,
      created_at: this.#now().toISOString(),
      rolled_back_at: null,
    };
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO network_change (id, account_id, actor, kind, summary, undo_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'applied', ?)`,
        )
        .run(
          row.id,
          row.account_id,
          row.actor,
          row.kind,
          row.summary,
          row.undo_json,
          row.created_at,
        );
    });
    const out = view(row);
    this.#notify(out);
    return out;
  }

  get(id: string): Promise<NetworkChangeView | null> {
    const r = this.#row(id);
    return Promise.resolve(r ? view(r) : null);
  }

  /** The newest change still applied: what one-click rollback reverts. */
  last(): Promise<NetworkChangeView | null> {
    const r = this.#db.raw
      .prepare(
        `SELECT * FROM network_change WHERE status = 'applied'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get() as ChangeRow | undefined;
    return Promise.resolve(r ? view(r) : null);
  }

  /** Newest first. */
  list(limit = 50): Promise<NetworkChangeView[]> {
    const rows = this.#db.raw
      .prepare('SELECT * FROM network_change ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as unknown as ChangeRow[];
    return Promise.resolve(rows.map(view));
  }

  /**
   * Revert one applied change with its kind's handler. `not_found` for an unknown id, `conflict`
   * when it was already rolled back or another rollback is running (`rollback_in_progress`),
   * `capability_missing` when nothing can undo its kind; a failing handler leaves the change
   * applied, keeps the error and rethrows.
   */
  async rollback(id: string): Promise<NetworkChangeView> {
    if (this.#rollingBack)
      throw new NovaError('conflict', 'another rollback is in progress', {
        details: { reason: 'rollback_in_progress' },
      });
    this.#rollingBack = true;
    try {
      return await this.#rollback(id);
    } finally {
      this.#rollingBack = false;
    }
  }

  async #rollback(id: string): Promise<NetworkChangeView> {
    const r = this.#row(id);
    if (!r) throw new NovaError('not_found', 'network change not found');
    if (r.status !== 'applied')
      throw new NovaError('conflict', 'this change was already rolled back', {
        details: { reason: 'rolled_back' },
      });
    const handler = this.#handlers.get(r.kind);
    if (!handler)
      throw new NovaError('capability_missing', `nothing can undo a ${r.kind} change`, {
        details: { reason: 'no_undo_handler', kind: r.kind },
      });
    let undo: NetworkUndo;
    try {
      undo = JSON.parse(r.undo_json) as NetworkUndo;
    } catch {
      undo = {};
    }
    try {
      await handler(undo, view(r));
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'undo failed';
      await this.#db.transaction(() => {
        this.#db.raw.prepare('UPDATE network_change SET error = ? WHERE id = ?').run(message, id);
      });
      throw err;
    }
    const at = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          "UPDATE network_change SET status = 'rolled_back', rolled_back_at = ?, error = NULL WHERE id = ?",
        )
        .run(at, id);
    });
    const out = view({ ...r, status: 'rolled_back', rolled_back_at: at, error: null });
    this.#notify(out);
    return out;
  }

  #row(id: string): ChangeRow | undefined {
    return this.#db.raw.prepare('SELECT * FROM network_change WHERE id = ?').get(id) as
      ChangeRow | undefined;
  }

  #notify(change: NetworkChangeView): void {
    for (const l of this.#listeners) {
      try {
        l(change);
      } catch {
        // a listener never breaks the change itself
      }
    }
  }
}
