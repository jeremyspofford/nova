// Sync between the Hub and device replicas (FR-109, FR-129, FR-112; docs/13 §2, ADR-010, ADR-036,
// ADR-095 decision 1). The Hub is canonical. Every synced field has one row in the change feed
// (`sync_field`) with its value, its hybrid logical clock and the cursor of its last change, so a
// replica pulls exactly what changed after its cursor. Hub-side writes reach the feed through the
// event bus (`onEvent` marks the entity, a flush diffs it against the feed) and a periodic sweep
// that catches writes made without an event. Pushed ops merge per field, last writer wins by HLC;
// the value that loses (or that a newer op overwrote without having seen it) goes to the merge log,
// from which the owner can restore it as a new change. Deletes are tombstones.
import {
  NovaError,
  SYNC_CREATABLE,
  SYNC_DELETABLE,
  SYNC_KINDS,
  SYNC_TOMBSTONE,
  isNovaError,
  uuidv7,
  type SyncChangeView,
  type SyncChangesView,
  type SyncEntityView,
  type SyncFieldView,
  type SyncKind,
  type SyncMergeEntryView,
  type SyncMergeReason,
  type SyncOp,
  type SyncOpResult,
  type SyncPushResult,
  type SyncReplicaStatus,
  type SyncReplicaView,
  type SyncSnapshotView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { hubOwnerId } from '../team/owner.ts';
import type { AuditSink } from '../tools/types.ts';
import {
  SYNC_FIELD_SCHEMAS,
  knownField,
  messagesChangedAfter,
  syncReaders,
  syncableSetting,
  tombstoneSchema,
  writableFields,
  type SyncEntity,
  type SyncReader,
} from './entities.ts';
import { HybridClock, compareHlc, formatHlc, hlcProblem, parseHlc } from './hlc.ts';
import type { SyncWriteContext, SyncWriters } from './writers.ts';

/** Default limit on how far ahead of the Hub a pushed clock may run (`sync.maxSkewSeconds`). */
export const SYNC_MAX_SKEW_S = 300;
export const SYNC_SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_CHUNK = 200;
const MESSAGE_CHUNK = 500;
/** The message sweep re-reads this far behind its watermark (a clock step, a late commit). */
const MESSAGE_LOOKBACK_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyncSettings {
  /** `sync.maxSkewSeconds`. */
  maxSkewSeconds?: () => Promise<number>;
  /** `sync.mergeLogDays`. */
  mergeLogDays?: () => Promise<number>;
  /** `sync.offlineAfterMinutes`. */
  offlineAfterMinutes?: () => Promise<number>;
}

export interface SyncServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  writers?: SyncWriters;
  settings?: SyncSettings;
  /** The account that holds the Hub's global settings (default: the local owner account). */
  ownerAccount?: () => string | null;
  sweepIntervalMs?: number;
}

/** Who restores or resets (the audit's actor; the device of a device session). */
export interface SyncActor {
  actor: string;
  deviceId: string | null;
}

interface StoredField {
  field: string;
  valueJson: string;
  hlc: string;
  deviceId: string | null;
  accountId: string;
}

interface Side {
  valueJson: string;
  hlc: string;
  deviceId: string | null;
}

interface PendingEntry {
  reason: SyncMergeReason;
  field: string;
  lost: Side;
  winner: Side;
  /** The op whose result names the entry. */
  index: number;
  /** Only kept when the push's write succeeds (the op won). */
  needsApply: boolean;
}

interface Conflict {
  accountId: string;
  entryId: string;
  kind: SyncKind;
  id: string;
  field: string;
}

interface GroupOp {
  op: SyncOp;
  index: number;
  value: unknown;
}

interface ReplicaRow {
  device_id: string;
  account_id: string;
  cursor: number;
  last_pull_at: string | null;
  last_push_at: string | null;
  last_error: string | null;
  reset_at: string | null;
  revoked_at: string | null;
}

interface MergeRow {
  id: string;
  account_id: string;
  kind: SyncKind;
  entity_id: string;
  field: string;
  reason: SyncMergeReason;
  lost_value_json: string;
  lost_hlc: string;
  lost_device_id: string | null;
  winner_value_json: string;
  winner_hlc: string;
  winner_device_id: string | null;
  status: 'open' | 'restored';
  restored_at: string | null;
  created_at: string;
  lost_name?: string | null;
  winner_name?: string | null;
}

const enc = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
const dec = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

/** Why a write the services refused failed, for the op's result. */
function reasonOf(err: unknown): string {
  if (isNovaError(err)) {
    if (err.code === 'validation') return 'invalid_value';
    const r = err.details?.reason;
    if (typeof r === 'string') return r;
    if (err.code === 'not_found') return 'not_found';
    if (err.code === 'conflict') return 'conflict';
    if (err.code === 'policy_denied') return 'policy_denied';
  }
  return 'apply_failed';
}

function encodeSnapshotCursor(kind: SyncKind, after: string): string {
  return Buffer.from(JSON.stringify({ k: kind, a: after }), 'utf8').toString('base64url');
}

function decodeSnapshotCursor(cursor: string): { kind: SyncKind; after: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      k?: unknown;
      a?: unknown;
    };
    if (
      typeof v.k === 'string' &&
      (SYNC_KINDS as readonly string[]).includes(v.k) &&
      typeof v.a === 'string'
    )
      return { kind: v.k as SyncKind, after: v.a };
  } catch {
    // fall through
  }
  throw new NovaError('validation', 'invalid snapshot cursor', { details: { field: 'cursor' } });
}

export class SyncService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  #audit: AuditSink | undefined;
  readonly #log: Logger;
  readonly #now: () => Date;
  #writers: SyncWriters;
  readonly #settings: SyncSettings;
  readonly #readers: Record<SyncKind, SyncReader>;
  readonly #clock: HybridClock;
  readonly #sweepIntervalMs: number;
  #cursor: number;
  #queue: Promise<unknown> = Promise.resolve();
  /** Marked entities; `spacePages` stands for every page of a space. */
  readonly #dirty = new Map<string, { kind: SyncKind | 'spacePages'; id: string }>();
  #flushScheduled = false;
  readonly #touched = new Set<string>();
  readonly #conflicts: Conflict[] = [];
  #ready: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(opts: SyncServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#audit = opts.audit;
    this.#log = opts.log ?? new Logger({ module: 'core.sync', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#writers = opts.writers ?? {};
    this.#settings = opts.settings ?? {};
    this.#sweepIntervalMs = opts.sweepIntervalMs ?? SYNC_SWEEP_INTERVAL_MS;
    // The recorded owner (M7): members and team agents' identities are never taken for it.
    const owner = opts.ownerAccount ?? (() => hubOwnerId(this.#db));
    this.#readers = syncReaders(this.#db, owner);
    const meta = this.#meta();
    // The clock and the cursor continue from what was persisted: they never go back (ADR-010).
    this.#clock = new HybridClock({
      node: 'hub',
      now: () => this.#now().getTime(),
      initial: meta.get('hlc') ?? null,
    });
    const maxRow = this.#db.raw.prepare('SELECT max(cursor) AS c FROM sync_field').get() as
      { c: number | null } | undefined;
    this.#cursor = Math.max(Number(meta.get('cursor') ?? 0) || 0, maxRow?.c ?? 0);
  }

  /** Late-bound writers (the Hub builds some services after this one). */
  useWriters(writers: SyncWriters): void {
    this.#writers = { ...this.#writers, ...writers };
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  /** The Hub's clock now (without moving it). */
  clock(): string {
    return this.#clock.last();
  }

  /** The newest change-feed cursor. */
  cursor(): number {
    return this.#cursor;
  }

  /** Seed the feed from what exists, then sweep periodically. */
  start(): void {
    this.#ready = this.sweep().then(
      () => undefined,
      (err: unknown) => this.#log.warn('initial sync sweep failed', { err }),
    );
    this.#timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.#log.warn('sync sweep failed', { err }));
    }, this.#sweepIntervalMs);
    this.#timer.unref();
  }

  /** Resolves once the initial sweep is done. */
  ready(): Promise<void> {
    return this.#ready;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#queue.catch(() => undefined);
  }

  // ---- Hub-side changes ---------------------------------------------------------------------

  /**
   * An event from the Hub's bus: mark what it names so the next flush records the change. The
   * services' events are the hooks; writes without one are found by the sweep.
   */
  onEvent(e: { name: string; payload: Record<string, unknown> }): void {
    if (this.#closed || e.name.startsWith('sync.')) return;
    const p = e.payload;
    const id = (k: string): string | null => (typeof p[k] === 'string' ? p[k] : null);
    const mark = (kind: SyncKind, key: string) => {
      const v = id(key);
      if (v) this.hint(kind, v);
    };
    const n = e.name;
    if (n.startsWith('thread.') && n !== 'thread.status.changed') mark('thread', 'threadId');
    else if (n === 'chat.branch.created') mark('thread', 'threadId');
    else if (
      n === 'chat.message.created' ||
      n === 'chat.message.completed' ||
      n === 'chat.message.updated' ||
      n === 'chat.message.deleted'
    ) {
      mark('message', 'messageId');
      // The first message names a new chat.
      mark('thread', 'threadId');
    } else if (n === 'project.created' || n === 'project.updated' || n === 'project.deleted')
      mark('project', 'projectId');
    else if (n.startsWith('memory.item.')) mark('memory', 'itemId');
    else if (n === 'memory.consolidated') this.#sweepLater('memory');
    else if (n.startsWith('space.page.')) mark('page', 'pageId');
    else if (n === 'space.created' || n === 'space.updated' || n === 'space.deleted') {
      const s = id('spaceId');
      if (s) {
        this.#mark('space', s);
        // A deleted space takes its pages with it.
        if (n === 'space.deleted') this.#mark('spacePages', s);
      }
    } else if (n === 'schedule.created' || n === 'schedule.changed' || n === 'schedule.cancelled')
      mark('schedule', 'scheduleId');
    else if (n === 'settings.changed' && p.scope === 'global') mark('setting', 'key');
  }

  /** Record the current state of one entity soon. */
  hint(kind: SyncKind, id: string): void {
    this.#mark(kind, id);
  }

  /** Record every marked entity now. */
  flush(): Promise<void> {
    return this.#exclusive(() => this.#flushNow());
  }

  /**
   * Diff everything against the feed: every kind in full except messages, which are read from a
   * watermark on `updated_at`. Catches writes that sent no event, and seeds the feed at first start.
   */
  async sweep(): Promise<number> {
    let n = 0;
    for (const kind of [
      'thread',
      'project',
      'memory',
      'space',
      'page',
      'schedule',
      'setting',
    ] as const)
      n += await this.#sweepKind(kind);
    n += await this.#sweepMessages();
    await this.#sweepMergeLog();
    return n;
  }

  // ---- replica reads ------------------------------------------------------------------------

  /** A page of the initial load: live entities of one kind, in id order (tombstones left out). */
  async snapshot(
    accountId: string,
    deviceId: string,
    q: { kind?: SyncKind | undefined; cursor?: string | undefined; limit: number },
  ): Promise<SyncSnapshotView> {
    await this.#ready;
    return this.#exclusive(async () => {
      await this.#flushNow();
      const c = q.cursor ? decodeSnapshotCursor(q.cursor) : null;
      if (c && q.kind && c.kind !== q.kind)
        throw new NovaError('validation', 'the cursor is for another kind', {
          details: { field: 'cursor' },
        });
      const kind = c?.kind ?? q.kind ?? SYNC_KINDS[0];
      const after = c?.after ?? '';
      const ids = (
        this.#db.raw
          .prepare(
            `SELECT entity_id AS id FROM sync_field
             WHERE kind = ? AND entity_id > ? AND account_id = ?
             GROUP BY entity_id HAVING sum(field = '${SYNC_TOMBSTONE}') = 0
             ORDER BY entity_id LIMIT ?`,
          )
          .all(kind, after, accountId, q.limit) as { id: string }[]
      ).map((r) => r.id);
      const items: SyncEntityView[] = ids.map((id) => ({ kind, id, fields: {} }));
      const byId = new Map(items.map((i) => [i.id, i]));
      if (ids.length) {
        const rows = this.#db.raw
          .prepare(
            `SELECT entity_id, field, value_json, hlc, device_id FROM sync_field
             WHERE kind = ? AND entity_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(kind, ...ids) as {
          entity_id: string;
          field: string;
          value_json: string;
          hlc: string;
          device_id: string | null;
        }[];
        for (const r of rows) {
          const item = byId.get(r.entity_id);
          if (item)
            item.fields[r.field] = {
              value: dec(r.value_json),
              hlc: r.hlc,
              deviceId: r.device_id,
            } satisfies SyncFieldView;
        }
      }
      let nextCursor: string | null = null;
      const last = ids.at(-1);
      if (ids.length === q.limit && last) nextCursor = encodeSnapshotCursor(kind, last);
      else if (!q.kind) {
        const next = SYNC_KINDS[SYNC_KINDS.indexOf(kind) + 1];
        if (next) nextCursor = encodeSnapshotCursor(next, '');
      }
      const nowIso = this.#now().toISOString();
      await this.#db.transaction(() => {
        this.#replica(deviceId, accountId);
        // The first page of a snapshot answers a reset: the replica is loading again.
        this.#db.raw
          .prepare(
            `UPDATE sync_replica SET last_pull_at = ?, updated_at = ?,
               reset_at = CASE WHEN ? THEN NULL ELSE reset_at END
             WHERE device_id = ?`,
          )
          .run(nowIso, nowIso, q.cursor ? 0 : 1, deviceId);
      });
      return { kind, items, nextCursor, feedCursor: this.#cursor };
    });
  }

  /** What changed after `since`, oldest first. */
  async changes(
    accountId: string,
    deviceId: string,
    since: number,
    limit: number,
  ): Promise<SyncChangesView> {
    await this.#ready;
    return this.#exclusive(async () => {
      await this.#flushNow();
      const rep = await this.#db.transaction(() => this.#replica(deviceId, accountId));
      if (rep.reset_at && since > 0)
        throw new NovaError('conflict', 'this replica was reset: load a snapshot first', {
          details: { reason: 'replica_reset' },
        });
      if (since > this.#cursor)
        throw new NovaError('conflict', 'the cursor is ahead of the Hub: load a snapshot again', {
          details: { reason: 'cursor_ahead', cursor: this.#cursor },
        });
      const rows = this.#db.raw
        .prepare(
          `SELECT cursor, kind, entity_id, field, value_json, hlc, device_id FROM sync_field
           WHERE account_id = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        )
        .all(accountId, since, limit + 1) as {
        cursor: number;
        kind: SyncKind;
        entity_id: string;
        field: string;
        value_json: string;
        hlc: string;
        device_id: string | null;
      }[];
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      const changes: SyncChangeView[] = page.map((r) => ({
        cursor: r.cursor,
        kind: r.kind,
        id: r.entity_id,
        field: r.field,
        value: dec(r.value_json),
        hlc: r.hlc,
        deviceId: r.device_id,
      }));
      const cursor = page.at(-1)?.cursor ?? since;
      const nowIso = this.#now().toISOString();
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            'UPDATE sync_replica SET cursor = ?, last_pull_at = ?, updated_at = ? WHERE device_id = ?',
          )
          .run(cursor, nowIso, nowIso, deviceId);
      });
      return { changes, cursor, more };
    });
  }

  // ---- replica writes -----------------------------------------------------------------------

  /**
   * Merge pushed ops in order, per field, last writer wins by HLC. Each op is answered
   * `accepted` (it is the value now), `overwritten` (a newer value won; the op's value is in the
   * merge log when it differed) or `rejected` (with a reason; nothing changed).
   */
  async push(
    accountId: string,
    deviceId: string,
    ops: readonly SyncOp[],
    opts: { localRuntime?: boolean } = {},
  ): Promise<SyncPushResult> {
    await this.#ready;
    const maxSkewMs = ((await this.#settings.maxSkewSeconds?.()) ?? SYNC_MAX_SKEW_S) * 1000;
    return this.#exclusive(async () => {
      await this.#flushNow();
      const nowMs = this.#now().getTime();
      const results: (SyncOpResult | undefined)[] = new Array<SyncOpResult | undefined>(ops.length);
      const groups = new Map<string, { kind: SyncKind; id: string; ops: GroupOp[] }>();
      ops.forEach((op, index) => {
        const checked = this.#check(op, deviceId, nowMs, maxSkewMs, opts.localRuntime === true);
        if (!checked.ok) {
          results[index] = rejected(op, index, checked.reason);
          return;
        }
        const key = `${op.kind}\u0000${op.id}`;
        let g = groups.get(key);
        if (!g) {
          g = { kind: op.kind, id: op.id, ops: [] };
          groups.set(key, g);
        }
        g.ops.push({ op, index, value: checked.value });
      });
      const conflicts: Conflict[] = [];
      for (const g of groups.values()) {
        try {
          await this.#applyGroup(accountId, deviceId, g, results, conflicts);
        } catch (err) {
          this.#log.warn('sync push group failed', { err, kind: g.kind });
          for (const o of g.ops) results[o.index] ??= rejected(o.op, o.index, 'apply_failed');
        }
      }
      const out = results.map((r, i) => r ?? rejected(ops[i]!, i, 'apply_failed'));
      const refused = out.filter((r) => r.status === 'rejected');
      const nowIso = this.#now().toISOString();
      await this.#db.transaction(() => {
        this.#replica(deviceId, accountId);
        const reasons = [...new Set(refused.map((r) => r.reason ?? 'rejected'))].join(', ');
        this.#db.raw
          .prepare(
            `UPDATE sync_replica SET last_push_at = ?, last_error = ?,
               last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END, updated_at = ?
             WHERE device_id = ?`,
          )
          .run(
            nowIso,
            refused.length ? `${refused.length} change(s) refused: ${reasons}` : null,
            refused.length ? nowIso : null,
            nowIso,
            nowIso,
            deviceId,
          );
        this.#saveMeta();
      });
      this.#conflicts.push(...conflicts);
      return { results: out, cursor: this.#cursor, hlc: this.#clock.last() };
    });
  }

  // ---- merge log ----------------------------------------------------------------------------

  async mergeLog(
    accountId: string,
    q: { status: 'open' | 'restored' | 'all'; limit: number; before?: string | undefined },
  ): Promise<SyncMergeEntryView[]> {
    const where = ['e.account_id = ?'];
    const args: (string | number)[] = [accountId];
    if (q.status !== 'all') {
      where.push('e.status = ?');
      args.push(q.status);
    }
    if (q.before) {
      where.push('e.id < ?');
      args.push(q.before);
    }
    const rows = this.#db.raw
      .prepare(
        `SELECT e.*, ld.name AS lost_name, wd.name AS winner_name FROM sync_merge_entry e
         LEFT JOIN device ld ON ld.id = e.lost_device_id
         LEFT JOIN device wd ON wd.id = e.winner_device_id
         WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...args, q.limit) as unknown as MergeRow[];
    return Promise.resolve(rows.map(mergeView));
  }

  /**
   * Write an entry's lost value back as a new change (a fresh Hub clock, so every replica takes
   * it). The value it replaces goes to the merge log in turn. The owner may restore from any
   * session; `by.deviceId` names the device of a device session.
   */
  async restore(accountId: string, entryId: string, by: SyncActor): Promise<SyncMergeEntryView> {
    await this.#ready;
    const view = await this.#exclusive(async () => {
      await this.#flushNow();
      const row = this.#entry(accountId, entryId);
      if (!row) throw new NovaError('not_found', 'merge log entry not found');
      if (row.status === 'restored')
        throw new NovaError('conflict', 'this entry was restored already', {
          details: { reason: 'already_restored' },
        });
      const { kind, entity_id: id, field } = row;
      const reader = this.#readers[kind];
      const { entity, stored } = await this.#db.transaction(() => {
        const e = reader.read(id);
        this.#observeEntity(kind, id, e);
        this.#saveMeta();
        return { entity: e, stored: this.#stored(kind, id) };
      });
      if (!entity || stored.has(SYNC_TOMBSTONE))
        throw new NovaError('conflict', 'the entity was deleted', {
          details: { reason: 'deleted' },
        });
      const writer = this.#writers[kind];
      const nowMs = this.#now().getTime();
      const ctx: SyncWriteContext = { deviceId: by.deviceId, atMs: nowMs, receivedMs: nowMs };
      const lost = dec(row.lost_value_json);
      if (field === SYNC_TOMBSTONE) {
        if (!writer?.remove)
          throw new NovaError('conflict', 'this cannot be deleted here', {
            details: { reason: 'not_supported' },
          });
        await writer.remove(accountId, id, ctx);
        // The tombstone takes the entity's merge-log entries with it, this one included.
        await this.#db.transaction(() => {
          this.#tombstone(kind, id, accountId, this.#clock.tick(), by.deviceId);
          this.#saveMeta();
        });
        return mergeView({ ...row, status: 'restored', restored_at: this.#now().toISOString() });
      } else {
        const schema = SYNC_FIELD_SCHEMAS[kind][field];
        if (!writer || !schema || !writableFields(kind).includes(field))
          throw new NovaError('conflict', 'this value cannot be restored', {
            details: { reason: 'not_supported' },
          });
        const parsed = schema.safeParse(lost);
        if (!parsed.success)
          throw new NovaError('validation', 'the lost value is no longer valid', {
            details: { reason: 'invalid_value' },
          });
        await writer.update(accountId, id, { [field]: parsed.data }, ctx);
        await this.#db.transaction(() => {
          const hlc = this.#clock.tick();
          const after = reader.read(id);
          const before = stored.get(field);
          if (after) {
            const json = enc(after.fields[field]);
            if (before && before.valueJson !== json) {
              this.#insertEntry(accountId, kind, id, {
                reason: 'restore',
                field,
                lost: before,
                winner: { valueJson: json, hlc, deviceId: by.deviceId },
                index: -1,
                needsApply: false,
              });
            }
            this.#recordFields(after, new Map([[field, { hlc, deviceId: by.deviceId }]]));
          } else {
            this.#observeEntity(kind, id, null);
          }
          this.#markRestored(entryId, hlc);
          this.#saveMeta();
        });
      }
      const fresh = this.#entry(accountId, entryId);
      if (!fresh) throw new NovaError('not_found', 'merge log entry not found');
      return mergeView(fresh);
    });
    await this.#auditAppend(
      accountId,
      by.actor,
      'sync.restore',
      `sync:${view.kind}:${view.entityId}`,
      {
        entryId,
        kind: view.kind,
        entityId: view.entityId,
        field: view.field,
        deviceId: by.deviceId,
      },
    );
    return view;
  }

  // ---- replicas -----------------------------------------------------------------------------

  /** Devices with a replica or the scope to keep one, with their sync status. */
  async replicas(accountId: string): Promise<SyncReplicaView[]> {
    const offlineMs = ((await this.#settings.offlineAfterMinutes?.()) ?? 10) * 60_000;
    const rows = this.#db.raw
      .prepare(
        `SELECT d.id, d.name, d.platform, d.scopes, d.status, d.offline_replica,
           r.cursor, r.last_pull_at, r.last_push_at, r.last_error, r.reset_at, r.revoked_at,
           (SELECT count(*) FROM sync_field f WHERE f.account_id = d.account_id
              AND f.cursor > coalesce(r.cursor, 0)) AS behind
         FROM device d LEFT JOIN sync_replica r ON r.device_id = d.id
         WHERE d.account_id = ? AND (r.device_id IS NOT NULL OR d.offline_replica = 1)
         ORDER BY d.created_at, d.id`,
      )
      .all(accountId) as {
      id: string;
      name: string;
      platform: string | null;
      scopes: string | null;
      status: string;
      offline_replica: number;
      cursor: number | null;
      last_pull_at: string | null;
      last_push_at: string | null;
      last_error: string | null;
      reset_at: string | null;
      revoked_at: string | null;
      behind: number;
    }[];
    const now = this.#now().getTime();
    return rows.map((r) => {
      const revoked = r.status === 'revoked';
      const granted = !revoked && scopesOf(r.scopes).includes('offline-replica');
      const seen = [r.last_pull_at, r.last_push_at]
        .filter((v): v is string => v !== null)
        .map((v) => Date.parse(v));
      const lastSeen = seen.length ? Math.max(...seen) : null;
      let status: SyncReplicaStatus;
      if (revoked || !granted || lastSeen === null || now - lastSeen > offlineMs)
        status = 'offline';
      else if (r.last_error) status = 'error';
      else if (r.behind > 0) status = 'pending';
      else status = 'synced';
      return {
        deviceId: r.id,
        name: r.name,
        platform: r.platform,
        granted,
        revoked,
        status,
        cursor: r.cursor ?? 0,
        behind: r.behind,
        lastPullAt: r.last_pull_at,
        lastPushAt: r.last_push_at,
        lastError: r.last_error,
        resetAt: r.reset_at,
      };
    });
  }

  /** The owner makes a replica load a snapshot again (its next `changes` is refused until then). */
  async resetReplica(accountId: string, deviceId: string, by: SyncActor): Promise<SyncReplicaView> {
    const d = this.#db.raw
      .prepare('SELECT id FROM device WHERE id = ? AND account_id = ?')
      .get(deviceId, accountId);
    if (!d) throw new NovaError('not_found', 'device not found');
    const nowIso = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#replica(deviceId, accountId);
      this.#db.raw
        .prepare(
          `UPDATE sync_replica SET cursor = 0, reset_at = ?, last_error = NULL, updated_at = ?
           WHERE device_id = ?`,
        )
        .run(nowIso, nowIso, deviceId);
    });
    await this.#auditAppend(accountId, by.actor, 'sync.replica.reset', `device:${deviceId}`, {
      deviceId,
    });
    await this.#events.emit({
      name: 'sync.replica.reset',
      actor: by.actor === 'user' ? 'user' : 'system',
      accountId,
      payload: { deviceId },
    });
    const view = (await this.replicas(accountId)).find((r) => r.deviceId === deviceId);
    if (!view) throw new NovaError('not_found', 'device not found');
    return view;
  }

  /**
   * A device lost its replica (revoked, or its `offline-replica` scope removed): it is told with
   * `sync.replica.revoked` and must wipe its local copy. Its sync calls fail from now on (a revoked
   * device's sessions are gone: 401; a device without the scope: 403).
   */
  async replicaRevoked(
    accountId: string,
    deviceId: string,
    reason: 'revoked' | 'scope_removed',
  ): Promise<boolean> {
    const row = this.#db.raw
      .prepare(
        `SELECT d.offline_replica, d.scopes, r.device_id AS replica, r.revoked_at
         FROM device d LEFT JOIN sync_replica r ON r.device_id = d.id
         WHERE d.id = ? AND d.account_id = ?`,
      )
      .get(deviceId, accountId) as
      | {
          offline_replica: number;
          scopes: string | null;
          replica: string | null;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) return false;
    const had =
      row.replica !== null ||
      row.offline_replica === 1 ||
      scopesOf(row.scopes).includes('offline-replica');
    if (!had || row.revoked_at) return false;
    if (row.replica) {
      const nowIso = this.#now().toISOString();
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('UPDATE sync_replica SET revoked_at = ?, updated_at = ? WHERE device_id = ?')
          .run(nowIso, nowIso, deviceId);
      });
    }
    await this.#events.emit({
      name: 'sync.replica.revoked',
      actor: 'system',
      accountId,
      payload: { deviceId, reason },
    });
    return true;
  }

  // ---- internals: jobs ----------------------------------------------------------------------

  /** One job at a time: flushes, sweeps, pushes and restores never interleave. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        this.#afterJob();
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Online replicas pull when told (`sync.changed`); conflicts are announced once committed. */
  #afterJob(): void {
    const accounts = [...this.#touched];
    this.#touched.clear();
    for (const accountId of accounts) {
      this.#events.emitEphemeral({
        name: 'sync.changed',
        accountId,
        payload: { cursor: this.#cursor },
      });
    }
    for (const c of this.#conflicts.splice(0)) {
      this.#events
        .emit({
          name: 'sync.conflict',
          actor: 'system',
          accountId: c.accountId,
          payload: { entryId: c.entryId, kind: c.kind, id: c.id, field: c.field },
        })
        .catch((err: unknown) => this.#log.warn('sync.conflict not emitted', { err }));
    }
  }

  #mark(kind: SyncKind | 'spacePages', id: string): void {
    if (this.#closed) return;
    this.#dirty.set(`${kind}\u0000${id}`, { kind, id });
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setImmediate(() => {
      this.#flushScheduled = false;
      this.flush().catch((err: unknown) => this.#log.warn('sync flush failed', { err }));
    });
  }

  #sweepLater(kind: SyncKind): void {
    setImmediate(() => {
      if (this.#closed) return;
      this.#sweepKind(kind).catch((err: unknown) => this.#log.warn('sync sweep failed', { err }));
    });
  }

  async #flushNow(): Promise<void> {
    while (this.#dirty.size) {
      const batch = [...this.#dirty.entries()].slice(0, SWEEP_CHUNK);
      for (const [k] of batch) this.#dirty.delete(k);
      await this.#db.transaction(() => {
        for (const [, b] of batch) {
          try {
            if (b.kind === 'spacePages') {
              for (const pageId of this.#pagesOfSpace(b.id)) this.#observe('page', pageId);
            } else this.#observe(b.kind, b.id);
          } catch (err) {
            this.#log.warn('sync could not record a change', { err, kind: b.kind });
          }
        }
        this.#saveMeta();
      });
    }
  }

  async #sweepKind(kind: SyncKind): Promise<number> {
    const reader = this.#readers[kind];
    const seen = new Set<string>();
    let after = '';
    let n = 0;
    for (;;) {
      const done = await this.#exclusive(() =>
        this.#db.transaction(() => {
          const page = reader.page(after, SWEEP_CHUNK);
          for (const e of page) {
            seen.add(e.id);
            n += this.#observeEntity(kind, e.id, e);
          }
          after = page.at(-1)?.id ?? after;
          this.#saveMeta();
          return page.length < SWEEP_CHUNK;
        }),
      );
      if (done) break;
    }
    // What the feed holds that the sweep did not see is gone (or, for a setting, back to default).
    const held = (
      this.#db.raw
        .prepare(
          `SELECT DISTINCT entity_id AS id FROM sync_field WHERE kind = ? AND field <> '${SYNC_TOMBSTONE}'`,
        )
        .all(kind) as { id: string }[]
    )
      .map((r) => r.id)
      .filter((id) => !seen.has(id));
    for (let i = 0; i < held.length; i += SWEEP_CHUNK) {
      const chunk = held.slice(i, i + SWEEP_CHUNK);
      n += await this.#exclusive(() =>
        this.#db.transaction(() => {
          let c = 0;
          for (const id of chunk) c += this.#observe(kind, id);
          this.#saveMeta();
          return c;
        }),
      );
    }
    return n;
  }

  async #sweepMessages(): Promise<number> {
    const meta = this.#meta();
    const mark = dec(meta.get('message_watermark') ?? 'null') as {
      updatedAt?: unknown;
      id?: unknown;
    } | null;
    const from = typeof mark?.updatedAt === 'string' ? Date.parse(mark.updatedAt) : NaN;
    let after = {
      updatedAt: Number.isFinite(from) ? new Date(from - MESSAGE_LOOKBACK_MS).toISOString() : '',
      id: '',
    };
    let n = 0;
    for (;;) {
      const done = await this.#exclusive(() =>
        this.#db.transaction(() => {
          const rows = messagesChangedAfter(this.#db, after, MESSAGE_CHUNK);
          for (const r of rows) n += this.#observe('message', r.id);
          const last = rows.at(-1);
          if (last) {
            after = { updatedAt: last.updatedAt, id: last.id };
            this.#setMeta('message_watermark', JSON.stringify(after));
          }
          this.#saveMeta();
          return rows.length < MESSAGE_CHUNK;
        }),
      );
      if (done) break;
    }
    return n;
  }

  async #sweepMergeLog(): Promise<void> {
    const days = (await this.#settings.mergeLogDays?.()) ?? 90;
    const before = new Date(this.#now().getTime() - days * 86_400_000).toISOString();
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM sync_merge_entry WHERE created_at < ?').run(before);
    });
  }

  // ---- internals: the feed (synchronous; callers hold a transaction) ------------------------

  #observe(kind: SyncKind, id: string): number {
    return this.#observeEntity(kind, id, this.#readers[kind].read(id));
  }

  /** Record what differs between an entity as it is and the feed; a gone one becomes a tombstone. */
  #observeEntity(kind: SyncKind, id: string, entity: SyncEntity | null): number {
    const stored = this.#stored(kind, id);
    if (!entity) {
      const first = stored.values().next().value;
      if (!first || stored.has(SYNC_TOMBSTONE)) return 0;
      this.#tombstone(kind, id, first.accountId, this.#clock.tick(), null);
      return 1;
    }
    if (stored.has(SYNC_TOMBSTONE)) {
      // It came back (a row restored by hand): its fields start over.
      this.#db.raw.prepare('DELETE FROM sync_field WHERE kind = ? AND entity_id = ?').run(kind, id);
      stored.clear();
    }
    return this.#recordFields(entity, new Map(), stored);
  }

  /**
   * Record an entity's fields that differ from the feed. `clocks` gives the clock and device of
   * fields set by an op (recorded even when the value did not change, so the op's clock wins);
   * every other changed field gets a fresh Hub clock.
   */
  #recordFields(
    entity: SyncEntity,
    clocks: Map<string, { hlc: string; deviceId: string | null }>,
    stored = this.#stored(entity.kind, entity.id),
  ): number {
    let n = 0;
    for (const [field, value] of Object.entries(entity.fields)) {
      const json = enc(value);
      const cur = stored.get(field);
      const set = clocks.get(field);
      const same = cur && cur.valueJson === json && cur.accountId === entity.accountId;
      if (set ? same && cur.hlc === set.hlc : same) continue;
      this.#record({
        kind: entity.kind,
        id: entity.id,
        field,
        accountId: entity.accountId,
        parentId: entity.parentId,
        valueJson: json,
        hlc: set?.hlc ?? (cur ? this.#clock.tick() : this.#firstSeen(entity.writtenAt)),
        deviceId: set ? set.deviceId : null,
      });
      n++;
    }
    return n;
  }

  /**
   * The clock of a value the feed sees for the first time: when its row was written (never later
   * than the Hub's clock), so an edit a device made after it still wins.
   */
  #firstSeen(writtenAt: number | null): string {
    const now = parseHlc(this.#clock.last())?.pt ?? 0;
    if (writtenAt === null || writtenAt >= now) return this.#clock.tick();
    return formatHlc({ pt: Math.max(0, writtenAt), c: 0, node: 'hub' });
  }

  #record(r: {
    kind: SyncKind;
    id: string;
    field: string;
    accountId: string;
    parentId: string | null;
    valueJson: string;
    hlc: string;
    deviceId: string | null;
  }): void {
    this.#cursor += 1;
    this.#db.raw
      .prepare(
        `INSERT INTO sync_field (kind, entity_id, field, account_id, parent_id, value_json, hlc,
           device_id, cursor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, entity_id, field) DO UPDATE SET account_id = excluded.account_id,
           parent_id = excluded.parent_id, value_json = excluded.value_json, hlc = excluded.hlc,
           device_id = excluded.device_id, cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(
        r.kind,
        r.id,
        r.field,
        r.accountId,
        r.parentId,
        r.valueJson,
        r.hlc,
        r.deviceId,
        this.#cursor,
        this.#now().toISOString(),
      );
    this.#touched.add(r.accountId);
  }

  /**
   * A deleted entity keeps only its tombstone. A thread's messages go with it (replicas drop them
   * with the thread); a project's threads lose it. Its merge-log entries go too: what was deleted
   * (a forgotten memory item) must not live on there.
   */
  #tombstone(
    kind: SyncKind,
    id: string,
    accountId: string,
    hlc: string,
    deviceId: string | null,
  ): void {
    const raw = this.#db.raw;
    raw.prepare('DELETE FROM sync_field WHERE kind = ? AND entity_id = ?').run(kind, id);
    this.#record({
      kind,
      id,
      field: SYNC_TOMBSTONE,
      accountId,
      parentId: null,
      valueJson: 'true',
      hlc,
      deviceId,
    });
    raw.prepare('DELETE FROM sync_merge_entry WHERE kind = ? AND entity_id = ?').run(kind, id);
    if (kind === 'thread') {
      raw.prepare("DELETE FROM sync_field WHERE kind = 'message' AND parent_id = ?").run(id);
    }
    if (kind === 'project') {
      const threads = raw
        .prepare(
          "SELECT entity_id AS id FROM sync_field WHERE kind = 'thread' AND field = 'project' AND value_json = ?",
        )
        .all(enc(id)) as { id: string }[];
      for (const t of threads) this.#observe('thread', t.id);
    }
  }

  #stored(kind: SyncKind, id: string): Map<string, StoredField> {
    const rows = this.#db.raw
      .prepare(
        'SELECT field, value_json, hlc, device_id, account_id FROM sync_field WHERE kind = ? AND entity_id = ?',
      )
      .all(kind, id) as {
      field: string;
      value_json: string;
      hlc: string;
      device_id: string | null;
      account_id: string;
    }[];
    return new Map(
      rows.map((r) => [
        r.field,
        {
          field: r.field,
          valueJson: r.value_json,
          hlc: r.hlc,
          deviceId: r.device_id,
          accountId: r.account_id,
        },
      ]),
    );
  }

  #pagesOfSpace(spaceId: string): string[] {
    const held = this.#db.raw
      .prepare(
        "SELECT entity_id AS id FROM sync_field WHERE kind = 'page' AND field = 'space' AND value_json = ?",
      )
      .all(enc(spaceId)) as { id: string }[];
    const live = this.#db.raw
      .prepare('SELECT id FROM space_page WHERE space_id = ?')
      .all(spaceId) as { id: string }[];
    return [...new Set([...held, ...live].map((r) => r.id))];
  }

  #meta(): Map<string, string> {
    const rows = this.#db.raw.prepare('SELECT key, value FROM sync_meta').all() as {
      key: string;
      value: string;
    }[];
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  #setMeta(key: string, value: string): void {
    this.#db.raw
      .prepare(
        'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** The clock and cursor, persisted with the changes that used them. */
  #saveMeta(): void {
    this.#setMeta('hlc', this.#clock.last());
    this.#setMeta('cursor', String(this.#cursor));
  }

  /** The replica row of a device (created on first use; a re-granted replica starts over). */
  #replica(deviceId: string, accountId: string): ReplicaRow {
    const nowIso = this.#now().toISOString();
    const get = () =>
      this.#db.raw.prepare('SELECT * FROM sync_replica WHERE device_id = ?').get(deviceId) as
        ReplicaRow | undefined;
    const row = get();
    if (!row) {
      this.#db.raw
        .prepare(
          `INSERT INTO sync_replica (device_id, account_id, cursor, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?)`,
        )
        .run(deviceId, accountId, nowIso, nowIso);
    } else if (row.revoked_at) {
      // The scope came back after it was removed: the device wiped its copy and loads again.
      this.#db.raw
        .prepare(
          `UPDATE sync_replica SET cursor = 0, reset_at = ?, revoked_at = NULL, last_error = NULL,
             updated_at = ? WHERE device_id = ?`,
        )
        .run(nowIso, nowIso, deviceId);
    } else return row;
    return get()!;
  }

  #entry(accountId: string, entryId: string): MergeRow | undefined {
    return this.#db.raw
      .prepare(
        `SELECT e.*, ld.name AS lost_name, wd.name AS winner_name FROM sync_merge_entry e
         LEFT JOIN device ld ON ld.id = e.lost_device_id
         LEFT JOIN device wd ON wd.id = e.winner_device_id
         WHERE e.id = ? AND e.account_id = ?`,
      )
      .get(entryId, accountId) as MergeRow | undefined;
  }

  #insertEntry(accountId: string, kind: SyncKind, id: string, e: PendingEntry): string {
    const entryId = uuidv7();
    this.#db.raw
      .prepare(
        `INSERT INTO sync_merge_entry (id, account_id, kind, entity_id, field, reason,
           lost_value_json, lost_hlc, lost_device_id, winner_value_json, winner_hlc,
           winner_device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        accountId,
        kind,
        id,
        e.field,
        e.reason,
        e.lost.valueJson,
        e.lost.hlc,
        e.lost.deviceId,
        e.winner.valueJson,
        e.winner.hlc,
        e.winner.deviceId,
        this.#now().toISOString(),
      );
    return entryId;
  }

  #markRestored(entryId: string, hlc: string): void {
    this.#db.raw
      .prepare(
        "UPDATE sync_merge_entry SET status = 'restored', restored_at = ?, restored_hlc = ? WHERE id = ?",
      )
      .run(this.#now().toISOString(), hlc, entryId);
  }

  async #auditAppend(
    accountId: string,
    actor: string,
    action: string,
    resource: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor,
        kind: 'device',
        action,
        resource,
        result: 'ok',
        detail,
      });
    } catch (err) {
      this.#log.warn('sync audit not written', { err, action });
    }
  }

  // ---- internals: merging a push ------------------------------------------------------------

  /** Shape checks that need no state: field, value, clock, setting key, local answers. */
  #check(
    op: SyncOp,
    deviceId: string,
    nowMs: number,
    maxSkewMs: number,
    localRuntime: boolean,
  ): { ok: true; value: unknown } | { ok: false; reason: string } {
    if (!knownField(op.kind, op.field)) return { ok: false, reason: 'unknown_field' };
    let value: unknown = op.value;
    if (op.field === SYNC_TOMBSTONE) {
      if (!SYNC_DELETABLE.includes(op.kind)) return { ok: false, reason: 'not_deletable' };
      if (!tombstoneSchema.safeParse(op.value).success)
        return { ok: false, reason: 'invalid_value' };
    } else {
      if (!writableFields(op.kind).includes(op.field))
        return { ok: false, reason: 'read_only_field' };
      const parsed = SYNC_FIELD_SCHEMAS[op.kind][op.field]?.safeParse(op.value);
      if (!parsed?.success) return { ok: false, reason: 'invalid_value' };
      value = parsed.data;
    }
    if (op.kind === 'setting' && !syncableSetting(op.id))
      return { ok: false, reason: 'not_syncable' };
    // Only a device the Hub let run a local model may bring back its answers (FR-128).
    if (
      op.kind === 'message' &&
      (value as { role?: unknown }).role === 'assistant' &&
      !localRuntime
    )
      return { ok: false, reason: 'local_runtime_not_granted' };
    const clock = hlcProblem(op.hlc, { node: deviceId, nowMs, maxSkewMs });
    if (clock) return { ok: false, reason: clock };
    return { ok: true, value };
  }

  async #applyGroup(
    accountId: string,
    deviceId: string,
    g: { kind: SyncKind; id: string; ops: GroupOp[] },
    results: (SyncOpResult | undefined)[],
    conflicts: Conflict[],
  ): Promise<void> {
    const { kind, id } = g;
    const reader = this.#readers[kind];
    const all = (status: SyncOpResult['status'], reason?: string, hlc?: string) => {
      for (const o of g.ops) results[o.index] = result(o.op, o.index, status, reason, hlc);
    };
    // The Hub's own unrecorded change to this entity gets its clock before the merge, and before
    // the push's clocks move the Hub's on.
    const { entity, stored } = await this.#db.transaction(() => {
      const e = reader.read(id);
      this.#observeEntity(kind, id, e);
      this.#saveMeta();
      return { entity: e, stored: this.#stored(kind, id) };
    });
    // Whatever this push carries, the Hub's next clock is later than it.
    for (const o of g.ops) this.#clock.receive(o.op.hlc);
    const owner = entity?.accountId ?? stored.values().next().value?.accountId ?? null;
    if (owner !== null && owner !== accountId) return all('rejected', 'not_found');
    const tomb = stored.get(SYNC_TOMBSTONE);
    if (tomb) return all('rejected', 'deleted', tomb.hlc);
    if (!entity) {
      if (stored.size === 0 && SYNC_CREATABLE.includes(kind))
        return this.#create(accountId, deviceId, g, results);
      return all('rejected', 'not_found');
    }
    if (kind === 'message') {
      // Append-only: an accepted message pushed again is a repeat, anything else is refused.
      const body = stored.get('body');
      for (const o of g.ops) {
        results[o.index] =
          body && body.hlc === o.op.hlc
            ? result(o.op, o.index, 'accepted', undefined, body.hlc)
            : result(o.op, o.index, 'rejected', 'append_only', body?.hlc);
      }
      return;
    }
    const writer = this.#writers[kind];
    const ctx = (ops: GroupOp[]): SyncWriteContext => ({
      deviceId,
      atMs: Math.max(...ops.map((o) => parseHlc(o.op.hlc)?.pt ?? 0)),
      receivedMs: this.#now().getTime(),
    });
    const pending: PendingEntry[] = [];

    // A delete is a write to the whole entity: it wins over every field older than it.
    const deletes = g.ops
      .filter((o) => o.op.field === SYNC_TOMBSTONE)
      .sort((a, b) => compareHlc(b.op.hlc, a.op.hlc));
    const del = deletes[0];
    if (del) {
      let newest: StoredField | null = null;
      for (const f of stored.values()) if (!newest || compareHlc(f.hlc, newest.hlc) > 0) newest = f;
      if (!newest || compareHlc(del.op.hlc, newest.hlc) > 0) {
        try {
          if (!writer?.remove)
            throw new NovaError('validation', 'not supported', {
              details: { reason: 'not_supported' },
            });
          await writer.remove(accountId, id, ctx([del]));
        } catch (err) {
          return all('rejected', reasonOf(err));
        }
        await this.#db.transaction(() => {
          this.#tombstone(kind, id, accountId, del.op.hlc, deviceId);
          this.#saveMeta();
        });
        for (const o of g.ops)
          results[o.index] =
            o.op.field === SYNC_TOMBSTONE
              ? result(o.op, o.index, 'accepted', undefined, del.op.hlc)
              : result(o.op, o.index, 'rejected', 'deleted', del.op.hlc);
        return;
      }
      // A newer edit keeps the entity; the delete is in the merge log (restoring it deletes).
      for (const o of deletes) {
        results[o.index] = result(o.op, o.index, 'overwritten', 'stale', newest.hlc, false);
        if (o === del && newest.deviceId !== deviceId)
          pending.push({
            reason: 'stale',
            field: SYNC_TOMBSTONE,
            lost: { valueJson: 'true', hlc: del.op.hlc, deviceId },
            winner: { valueJson: 'false', hlc: newest.hlc, deviceId: newest.deviceId },
            index: o.index,
            needsApply: false,
          });
      }
    }

    // Field ops, oldest first per field, each against the value as it stands.
    const state = new Map<string, Side>(
      [...stored.values()].map((f) => [
        f.field,
        { valueJson: f.valueJson, hlc: f.hlc, deviceId: f.deviceId },
      ]),
    );
    const winners = new Map<string, GroupOp>();
    const won = new Set<number>();
    const fieldOps = g.ops
      .filter((o) => o.op.field !== SYNC_TOMBSTONE)
      .sort((a, b) => compareHlc(a.op.hlc, b.op.hlc));
    for (const o of fieldOps) {
      const field = o.op.field;
      const cur = state.get(field);
      const valueJson = enc(o.value);
      if (cur && cur.hlc === o.op.hlc) {
        results[o.index] = result(o.op, o.index, 'accepted', undefined, cur.hlc);
        continue;
      }
      if (!cur || compareHlc(o.op.hlc, cur.hlc) > 0) {
        // The value it replaces is lost unless the device saw it (`base`) or wrote it itself.
        if (
          cur &&
          cur.valueJson !== valueJson &&
          o.op.base !== cur.hlc &&
          cur.deviceId !== deviceId
        )
          pending.push({
            reason: 'concurrent',
            field,
            lost: cur,
            winner: { valueJson, hlc: o.op.hlc, deviceId },
            index: o.index,
            needsApply: true,
          });
        state.set(field, { valueJson, hlc: o.op.hlc, deviceId });
        winners.set(field, o);
        won.add(o.index);
        results[o.index] = result(o.op, o.index, 'accepted', undefined, o.op.hlc);
      } else {
        // An older op: the newer value stays, and the op's value is kept if it differed.
        if (cur.valueJson !== valueJson && cur.deviceId !== deviceId)
          pending.push({
            reason: 'stale',
            field,
            lost: { valueJson, hlc: o.op.hlc, deviceId },
            winner: cur,
            index: o.index,
            needsApply: false,
          });
        results[o.index] = result(
          o.op,
          o.index,
          'overwritten',
          'stale',
          cur.hlc,
          true,
          dec(cur.valueJson),
        );
      }
    }
    let applied = winners.size > 0;
    if (applied) {
      const fields = Object.fromEntries([...winners].map(([f, o]) => [f, o.value]));
      try {
        if (!writer)
          throw new NovaError('validation', 'not supported', {
            details: { reason: 'not_supported' },
          });
        await writer.update(accountId, id, fields, ctx([...winners.values()]));
      } catch (err) {
        const reason = reasonOf(err);
        for (const o of fieldOps)
          if (won.has(o.index))
            results[o.index] = result(
              o.op,
              o.index,
              'rejected',
              reason,
              stored.get(o.op.field)?.hlc,
            );
        applied = false;
        winners.clear();
      }
    }
    await this.#db.transaction(() => {
      if (applied) {
        const after = reader.read(id);
        if (after) {
          const clocks = new Map(
            [...winners].map(([f, o]) => [f, { hlc: o.op.hlc, deviceId }] as const),
          );
          this.#recordFields(after, clocks);
        } else this.#observeEntity(kind, id, null);
      }
      for (const e of pending) {
        if (e.needsApply && !applied) continue;
        const entryId = this.#insertEntry(accountId, kind, id, e);
        const r = results[e.index];
        if (r) r.entryId = entryId;
        conflicts.push({ accountId, entryId, kind, id, field: e.field });
      }
      this.#saveMeta();
    });
  }

  /** A new thread or message from a replica, with the id it chose. */
  async #create(
    accountId: string,
    deviceId: string,
    g: { kind: SyncKind; id: string; ops: GroupOp[] },
    results: (SyncOpResult | undefined)[],
  ): Promise<void> {
    const { kind, id } = g;
    const writer = this.#writers[kind];
    const reject = (reason: string) => {
      for (const o of g.ops) results[o.index] ??= result(o.op, o.index, 'rejected', reason);
    };
    if (!UUID.test(id)) return reject('invalid_id');
    if (!writer?.create) return reject('not_supported');
    const winners = new Map<string, GroupOp>();
    for (const o of g.ops) {
      if (o.op.field === SYNC_TOMBSTONE) {
        results[o.index] = result(o.op, o.index, 'rejected', 'not_found');
        continue;
      }
      const prev = winners.get(o.op.field);
      if (!prev || compareHlc(o.op.hlc, prev.op.hlc) > 0) {
        if (prev)
          results[prev.index] = result(prev.op, prev.index, 'overwritten', 'stale', o.op.hlc);
        winners.set(o.op.field, o);
      } else results[o.index] = result(o.op, o.index, 'overwritten', 'stale', prev.op.hlc);
    }
    if (!winners.size) return;
    if (kind === 'message' && !winners.has('body')) return reject('invalid_value');
    const fields = Object.fromEntries([...winners].map(([f, o]) => [f, o.value]));
    const atMs = Math.min(...[...winners.values()].map((o) => parseHlc(o.op.hlc)?.pt ?? 0));
    try {
      await writer.create(accountId, id, fields, {
        deviceId,
        atMs,
        receivedMs: this.#now().getTime(),
      });
    } catch (err) {
      const reason = reasonOf(err);
      for (const o of winners.values())
        results[o.index] = result(o.op, o.index, 'rejected', reason);
      return;
    }
    await this.#db.transaction(() => {
      const after = this.#readers[kind].read(id);
      if (after)
        this.#recordFields(
          after,
          new Map([...winners].map(([f, o]) => [f, { hlc: o.op.hlc, deviceId }] as const)),
        );
      this.#saveMeta();
    });
    for (const o of winners.values())
      results[o.index] = result(o.op, o.index, 'accepted', undefined, o.op.hlc);
  }
}

function result(
  op: SyncOp,
  index: number,
  status: SyncOpResult['status'],
  reason?: string,
  hlc?: string,
  withValue = false,
  value?: unknown,
): SyncOpResult {
  const r: SyncOpResult = { index, kind: op.kind, id: op.id, field: op.field, status };
  if (reason) r.reason = reason;
  if (hlc) r.hlc = hlc;
  if (withValue) r.value = value;
  return r;
}

function rejected(op: SyncOp, index: number, reason: string): SyncOpResult {
  return result(op, index, 'rejected', reason);
}

function scopesOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function mergeView(r: MergeRow): SyncMergeEntryView {
  return {
    id: r.id,
    kind: r.kind,
    entityId: r.entity_id,
    field: r.field,
    reason: r.reason,
    lost: {
      value: dec(r.lost_value_json),
      hlc: r.lost_hlc,
      deviceId: r.lost_device_id,
      deviceName: r.lost_name ?? null,
    },
    winner: {
      value: dec(r.winner_value_json),
      hlc: r.winner_hlc,
      deviceId: r.winner_device_id,
      deviceName: r.winner_name ?? null,
    },
    status: r.status,
    createdAt: r.created_at,
    restoredAt: r.restored_at,
  };
}
