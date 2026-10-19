// Retention (FR-105, ADR-097 D5; docs/12 §9, docs/06 §5): per-item settings in days, swept daily.
// Nothing is pruned unless the owner set a number of days for the item, and pruning never removes
// a pinned item:
// - threads: chats untouched for that long are deleted (a pinned chat, or a chat with a pinned
//   branch, is kept); deleted chats, by retention or by the user, are purged 30 days later.
// - runs: Work runs that ended that long ago are purged with their threads, plan, steps,
//   sub-agents and goal (a run whose thread is pinned is kept).
// - audit: entries older than that, never fewer than 365 days; the chain stays verifiable from an
//   anchor and the prune is itself audited.
// - artifacts: artifacts unchanged that long (not live, not in a pinned chat), with their versions
//   and their files once nothing else refers to them.
// - traces: activity history (the stored event log, agent browser traces, network checks,
//   delivered notifications and pushes, trigger events).
// Each thread family, run, artifact and table goes in its own transaction: one that something
// still refers to is skipped and counted, never forced.
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  DELETED_RECOVERY_DAYS,
  RETENTION_ITEMS,
  RETENTION_SETTING_KEYS,
  uuidv7,
  type RetentionItem,
  type RetentionSweepView,
  type RetentionView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import { descendantThreads, purgeThreadRows, removeUnreferencedBlobs } from '../purge.ts';
import type { AuditSink } from '../tools/types.ts';
import { AUDIT_PRUNED_ACTION, pruneAuditBefore } from './anchor.ts';
import { quoteIdent } from './codec.ts';

const DAY_MS = 86_400_000;
/** A scheduled sweep runs when the last one is this old. */
export const SWEEP_INTERVAL_MS = DAY_MS;

/** Activity tables pruned as traces: [table, time column, extra condition]. */
export const TRACE_TABLES: readonly (readonly [string, string, string | null])[] = [
  ['event', 'ts', null],
  ['browser_action', 'created_at', null],
  ['network_endpoint_check', 'checked_at', null],
  ['network_transport_event', 'created_at', null],
  ['notification_delivery', 'created_at', 'sent_at IS NOT NULL'],
  ['push_delivery', 'created_at', null],
  ['trigger_event', 'received_at', null],
];

const ENDED_RUN = "('done', 'output_missing', 'failed', 'cancelled')";

export interface RetentionServiceOptions {
  db: NovaDatabase;
  dataDir: string;
  /** The item's setting after precedence: days, or null to keep everything. */
  days: (item: RetentionItem) => Promise<number | null>;
  /** The prune of the audit log is audited (as the owner). */
  audit?: AuditSink;
  ownerAccountId?: () => string | null;
  now?: () => Date;
  log?: Logger;
}

type Counts = Partial<Record<RetentionItem, number>>;

interface SweepRow {
  id: string;
  kind: 'schedule' | 'manual';
  started_at: string;
  finished_at: string | null;
  result_json: string | null;
  error: string | null;
}

function floorOf(item: RetentionItem): number {
  return item === 'audit' ? AUDIT_RETENTION_FLOOR_DAYS : 1;
}

export class RetentionService {
  readonly #db: NovaDatabase;
  readonly #dataDir: string;
  readonly #days: (item: RetentionItem) => Promise<number | null>;
  readonly #audit: AuditSink | null;
  readonly #owner: () => string | null;
  readonly #now: () => Date;
  readonly #log: Logger | null;
  #running: Promise<RetentionSweepView> | null = null;

  constructor(opts: RetentionServiceOptions) {
    this.#db = opts.db;
    this.#dataDir = opts.dataDir;
    this.#days = opts.days;
    this.#audit = opts.audit ?? null;
    this.#owner = opts.ownerAccountId ?? (() => null);
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? null;
  }

  /** An item's days after the floor (a lower stored value is raised to the floor, never used). */
  async #effectiveDays(item: RetentionItem): Promise<number | null> {
    const d = await this.#days(item);
    if (d === null || !Number.isFinite(d)) return null;
    return Math.max(floorOf(item), Math.floor(d));
  }

  #cutoff(days: number): string {
    return new Date(this.#now().getTime() - days * DAY_MS).toISOString();
  }

  async view(): Promise<RetentionView> {
    const items = [];
    for (const item of RETENTION_ITEMS) {
      const days = await this.#effectiveDays(item);
      const cutoff = days === null ? null : this.#cutoff(days);
      items.push({
        item,
        setting: RETENTION_SETTING_KEYS[item],
        days,
        floorDays: floorOf(item),
        cutoff,
        due: cutoff === null ? 0 : this.#count(item, cutoff),
      });
    }
    const last = this.lastSweep();
    const lastScheduled = this.#lastScheduledAt();
    const next = lastScheduled
      ? new Date(Date.parse(lastScheduled) + SWEEP_INTERVAL_MS)
      : this.#now();
    return { items, lastSweep: last, nextSweepAt: next.toISOString() };
  }

  lastSweep(): RetentionSweepView | null {
    const row = this.#db.raw
      .prepare('SELECT * FROM retention_sweep ORDER BY started_at DESC, id DESC LIMIT 1')
      .get() as SweepRow | undefined;
    return row ? toView(row) : null;
  }

  #lastScheduledAt(): string | null {
    const row = this.#db.raw
      .prepare(
        "SELECT started_at FROM retention_sweep WHERE kind = 'schedule' ORDER BY started_at DESC LIMIT 1",
      )
      .get() as { started_at: string } | undefined;
    return row?.started_at ?? null;
  }

  /** Whether the daily sweep is due (never ran, or ran a day ago). */
  isDue(): boolean {
    const last = this.#lastScheduledAt();
    return !last || this.#now().getTime() - Date.parse(last) >= SWEEP_INTERVAL_MS;
  }

  /** Run a sweep (one at a time; a second caller gets the running one). */
  sweep(kind: 'schedule' | 'manual'): Promise<RetentionSweepView> {
    this.#running ??= this.#sweep(kind).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #sweep(kind: 'schedule' | 'manual'): Promise<RetentionSweepView> {
    const id = uuidv7();
    const startedAt = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare('INSERT INTO retention_sweep (id, kind, started_at) VALUES (?, ?, ?)')
        .run(id, kind, startedAt),
    );
    const removed: Counts = {};
    const skipped: Counts = {};
    let error: string | null = null;
    try {
      for (const item of RETENTION_ITEMS) {
        const days = await this.#effectiveDays(item);
        // Threads also purge chats the user deleted over 30 days ago only when retention is on.
        if (days === null) continue;
        const r = await this.#prune(item, this.#cutoff(days));
        removed[item] = r.removed;
        if (r.skipped) skipped[item] = r.skipped;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.#log?.warn('retention sweep failed', { err });
    }
    const finishedAt = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          'UPDATE retention_sweep SET finished_at = ?, result_json = ?, error = ? WHERE id = ?',
        )
        .run(finishedAt, JSON.stringify({ removed, skipped }), error, id),
    );
    return { id, trigger: kind, startedAt, finishedAt, removed, skipped, error };
  }

  /** How many items the next sweep would remove now. */
  #count(item: RetentionItem, cutoff: string): number {
    const raw = this.#db.raw;
    switch (item) {
      case 'threads':
        return this.#staleFamilies(cutoff).length + this.#purgeableFamilies().length;
      case 'runs':
        return this.#dueRuns(cutoff).length;
      case 'audit':
        return Number(
          (
            raw
              .prepare('SELECT count(*) AS n FROM audit_event WHERE created_at < ?')
              .get(cutoff) as {
              n: number;
            }
          ).n,
        );
      case 'artifacts':
        return this.#dueArtifacts(cutoff).length;
      case 'traces': {
        let n = 0;
        for (const [table, col, extra] of TRACE_TABLES) {
          if (!this.#hasColumn(table, col)) continue;
          n += Number(
            (
              raw
                .prepare(
                  `SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} < ?${extra ? ` AND ${extra}` : ''}`,
                )
                .get(cutoff) as { n: number }
            ).n,
          );
        }
        return n;
      }
    }
  }

  async #prune(item: RetentionItem, cutoff: string): Promise<{ removed: number; skipped: number }> {
    switch (item) {
      case 'threads':
        return this.#pruneThreads(cutoff);
      case 'runs':
        return this.#pruneRuns(cutoff);
      case 'audit':
        return this.#pruneAudit(cutoff);
      case 'artifacts':
        return this.#pruneArtifacts(cutoff);
      case 'traces':
        return this.#pruneTraces(cutoff);
    }
  }

  // ---- threads ------------------------------------------------------------------------------

  /** Root chats whose whole family is untouched since `cutoff` and has nothing pinned. */
  #staleFamilies(cutoff: string): string[][] {
    const roots = this.#db.raw
      .prepare(
        `SELECT id FROM thread WHERE mode = 'chat' AND parent_thread_id IS NULL AND temporary = 0
           AND deleted_at IS NULL AND pinned = 0 AND updated_at < ? ORDER BY id`,
      )
      .all(cutoff) as { id: string }[];
    const out: string[][] = [];
    for (const r of roots) {
      const family = [r.id, ...descendantThreads(this.#db, r.id)];
      const marks = family.map(() => '?').join(',');
      const row = this.#db.raw
        .prepare(
          `SELECT max(updated_at) AS at, max(pinned) AS pinned FROM thread WHERE id IN (${marks})`,
        )
        .get(...family) as { at: string; pinned: number };
      if (row.at < cutoff && !Number(row.pinned)) out.push(family);
    }
    return out;
  }

  /** Root chats deleted more than 30 days ago (their recovery window is over). */
  #purgeableFamilies(): string[][] {
    const before = new Date(this.#now().getTime() - DELETED_RECOVERY_DAYS * DAY_MS).toISOString();
    const roots = this.#db.raw
      .prepare(
        `SELECT t.id FROM thread t LEFT JOIN thread p ON p.id = t.parent_thread_id
         WHERE t.mode = 'chat' AND t.deleted_at IS NOT NULL AND t.deleted_at < ?
           AND (p.id IS NULL OR p.deleted_at IS NULL) ORDER BY t.id`,
      )
      .all(before) as { id: string }[];
    return roots.map((r) => [r.id, ...descendantThreads(this.#db, r.id)]);
  }

  async #pruneThreads(cutoff: string): Promise<{ removed: number; skipped: number }> {
    let removed = 0;
    let skipped = 0;
    const now = this.#now().toISOString();
    for (const family of this.#staleFamilies(cutoff)) {
      const marks = family.map(() => '?').join(',');
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(`UPDATE thread SET deleted_at = ?, updated_at = ? WHERE id IN (${marks})`)
          .run(now, now, ...family);
        this.#db.raw
          .prepare(
            `UPDATE message SET deleted_at = ? WHERE thread_id IN (${marks}) AND deleted_at IS NULL`,
          )
          .run(now, ...family);
      });
      removed++;
    }
    for (const family of this.#purgeableFamilies()) {
      try {
        const blobs = await this.#db.transaction(() => purgeThreadRows(this.#db, family));
        removeUnreferencedBlobs(this.#db, this.#dataDir, blobs);
        removed++;
      } catch (err) {
        skipped++;
        this.#log?.info('a deleted chat is still referred to; kept', { err });
      }
    }
    return { removed, skipped };
  }

  // ---- runs ---------------------------------------------------------------------------------

  #dueRuns(cutoff: string): string[] {
    return (
      this.#db.raw
        .prepare(
          `SELECT r.id FROM run r JOIN thread t ON t.id = r.thread_id
           WHERE r.parent_run_id IS NULL AND r.status IN ${ENDED_RUN}
             AND coalesce(r.ended_at, r.updated_at) < ? AND t.pinned = 0 ORDER BY r.id`,
        )
        .all(cutoff) as { id: string }[]
    ).map((r) => r.id);
  }

  async #pruneRuns(cutoff: string): Promise<{ removed: number; skipped: number }> {
    let removed = 0;
    let skipped = 0;
    const raw = this.#db.raw;
    for (const root of this.#dueRuns(cutoff)) {
      try {
        const blobs = await this.#db.transaction(() => {
          // The run and its sub-runs, deepest last; every one must have ended.
          const tree = raw
            .prepare(
              `WITH RECURSIVE d(id, depth) AS (
                   SELECT id, 0 FROM run WHERE id = ?
                   UNION SELECT r.id, d.depth + 1 FROM run r JOIN d ON r.parent_run_id = d.id
                   WHERE d.depth < 100)
                 SELECT d.id AS id, r.status AS status, r.thread_id AS threadId
                 FROM d JOIN run r ON r.id = d.id ORDER BY d.depth`,
            )
            .all(root) as { id: string; status: string; threadId: string }[];
          if (tree.some((r) => !ENDED_RUN.includes(`'${r.status}'`)))
            throw new Error('a sub-run is still active');
          const ids = tree.map((r) => r.id);
          const marks = ids.map(() => '?').join(',');
          const threads = new Set(tree.map((r) => r.threadId));
          for (const s of raw
            .prepare(
              `SELECT thread_id AS t FROM subagent WHERE run_id IN (${marks}) AND thread_id IS NOT NULL`,
            )
            .all(...ids) as { t: string }[])
            threads.add(s.t);
          raw.prepare(`DELETE FROM run_step WHERE run_id IN (${marks})`).run(...ids);
          raw.prepare(`DELETE FROM subagent WHERE run_id IN (${marks})`).run(...ids);
          raw.prepare(`DELETE FROM goal WHERE run_id IN (${marks})`).run(...ids);
          for (const id of [...ids].reverse()) raw.prepare('DELETE FROM run WHERE id = ?').run(id);
          const all = new Set<string>();
          for (const t of threads) {
            all.add(t);
            for (const d of descendantThreads(this.#db, t)) all.add(d);
          }
          return purgeThreadRows(this.#db, [...all]);
        });
        removeUnreferencedBlobs(this.#db, this.#dataDir, blobs);
        removed++;
      } catch (err) {
        skipped++;
        this.#log?.info('an ended run is still referred to; kept', { err });
      }
    }
    return { removed, skipped };
  }

  // ---- audit --------------------------------------------------------------------------------

  async #pruneAudit(cutoff: string): Promise<{ removed: number; skipped: number }> {
    const now = this.#now().toISOString();
    const owner = this.#owner();
    const audit = this.#audit;
    // The prune is audited in the same transaction, with the anchor's seq and hash: verification
    // accepts an anchor only with its entry (anchor.ts). Without an audit sink nothing is pruned.
    if (!owner || !audit) return { removed: 0, skipped: 1 };
    const r = await this.#db.transaction(async () => {
      const pruned = pruneAuditBefore(this.#db.raw, cutoff, now);
      if (pruned.removed && pruned.anchor)
        await audit.append({
          accountId: owner,
          actor: 'system',
          kind: 'settings',
          action: AUDIT_PRUNED_ACTION,
          resource: 'audit_event',
          inputHash: pruned.anchor.hash,
          result: 'ok',
          detail: { removed: pruned.removed, cutoff, anchorSeq: pruned.anchor.seq },
        });
      return pruned;
    });
    return { removed: r.removed, skipped: 0 };
  }

  // ---- artifacts ----------------------------------------------------------------------------

  #dueArtifacts(cutoff: string): string[] {
    return (
      this.#db.raw
        .prepare(
          `SELECT a.id FROM artifact a LEFT JOIN thread t ON t.id = a.thread_id
           WHERE a.updated_at < ? AND a.live = 0 AND coalesce(t.pinned, 0) = 0 ORDER BY a.id`,
        )
        .all(cutoff) as { id: string }[]
    ).map((r) => r.id);
  }

  async #pruneArtifacts(cutoff: string): Promise<{ removed: number; skipped: number }> {
    let removed = 0;
    let skipped = 0;
    const raw = this.#db.raw;
    for (const id of this.#dueArtifacts(cutoff)) {
      try {
        const blobs = await this.#db.transaction(() => {
          const paths = (
            raw
              .prepare(
                `SELECT blob_path AS p FROM artifact_version WHERE artifact_id = ? AND blob_path IS NOT NULL
                 UNION SELECT blob_path FROM artifact WHERE id = ? AND blob_path IS NOT NULL`,
              )
              .all(id, id) as { p: string }[]
          ).map((r) => r.p);
          raw.prepare('DELETE FROM artifact_version WHERE artifact_id = ?').run(id);
          raw.prepare('DELETE FROM artifact WHERE id = ?').run(id);
          return paths;
        });
        removeUnreferencedBlobs(this.#db, this.#dataDir, blobs);
        removed++;
      } catch (err) {
        skipped++;
        this.#log?.info('an artifact is still referred to; kept', { err });
      }
    }
    return { removed, skipped };
  }

  // ---- traces -------------------------------------------------------------------------------

  #hasColumn(table: string, column: string): boolean {
    const cols = this.#db.raw.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as {
      name: string;
    }[];
    return cols.some((c) => c.name === column);
  }

  async #pruneTraces(cutoff: string): Promise<{ removed: number; skipped: number }> {
    let removed = 0;
    let skipped = 0;
    for (const [table, col, extra] of TRACE_TABLES) {
      if (!this.#hasColumn(table, col)) continue;
      try {
        removed += await this.#db.transaction(() =>
          Number(
            this.#db.raw
              .prepare(
                `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} < ?${extra ? ` AND ${extra}` : ''}`,
              )
              .run(cutoff).changes,
          ),
        );
      } catch (err) {
        skipped++;
        this.#log?.info('trace rows are still referred to; kept', { table, err });
      }
    }
    return { removed, skipped };
  }
}

function toView(r: SweepRow): RetentionSweepView {
  let parsed: { removed?: Counts; skipped?: Counts } = {};
  try {
    parsed = r.result_json ? (JSON.parse(r.result_json) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  return {
    id: r.id,
    trigger: r.kind,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    removed: parsed.removed ?? {},
    skipped: parsed.skipped ?? {},
    error: r.error,
  };
}
