// The fake Hub's M7 sync part (apps/hub/src/sync.ts, packages/core/src/sync/service.ts) and the
// pieces the offline layer needs in tests: an in-memory key-value store in place of IndexedDB (it
// keeps what would be written to disk, so tests can check nothing is plaintext), a fetch that
// answers like the Hub (and fails like an unreachable one), timers a test runs by hand, and the
// desktop shell's bridge. The Hub's rules modelled:
// - Replica routes need a signed-in session (401) of a device with `offline-replica` (403
//   `policy_denied` `replica_not_granted`) while sync is on (403 `sync_disabled`); push answers
//   403 `device_mismatch` for another device's id.
// - Snapshot pages live entities of every kind in id order with `feedCursor`; the first page clears
//   a reset. Changes: 409 `replica_reset` after a reset (since > 0), 409 `cursor_ahead`.
// - Push: per op `invalid_hlc`, `hlc_device_mismatch`, `clock_skew`, `unknown_field`,
//   `read_only_field`, `not_deletable`, `invalid_value` (a message body must be a user message);
//   per entity `deleted`, `not_found`, creates of threads and messages with a UUID, messages
//   append-only (`append_only`), fields last-writer-wins by HLC with `concurrent` and `stale`
//   merge-log entries, as the Hub keeps them.
// - Idempotency-Key: a repeat with the same body gets the first answer (`idempotent-replay`),
//   another body 409 `idempotency_key_reused`; 5xx and 429 answers are forgotten.
// - Merge log newest first, `before`, status filter; restore: 404, 409 `already_restored`,
//   `deleted`, and a `restore` entry for the value it replaces. Devices: status from last contact,
//   errors and how far behind; reset 404 for an unknown device.
// The REST routes the offline views read and write (threads, messages, projects, spaces, pages)
// answer from the same entities, so a test can go online, offline and back.
//
// Wiring: none in test/fakes.ts (sync tests build their own client with `createApi(hub.fetch,
// { offline })` and spread `hub.api` over `createHub().api` for Settings → Sync).
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  HLC_PATTERN,
  SYNC_CREATABLE,
  SYNC_DELETABLE,
  SYNC_FIELDS,
  SYNC_KINDS,
  SYNC_TOMBSTONE,
  syncMessageBodySchema,
  type MessageView,
  type NovaShellBridge,
  type PageView,
  type ProjectView,
  type SendMessageResponse,
  type ShellLocalChatRequest,
  type ShellLocalRuntimeModelsView,
  type SpaceView,
  type SyncChangeView,
  type SyncEntityView,
  type SyncKind,
  type SyncMergeEntryView,
  type SyncMergeSideView,
  type SyncOp,
  type SyncOpResult,
  type SyncReplicaView,
  type ThreadView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError, createApi, type ApiErrorBody, type CallOptions } from '../src/api.ts';
import { OfflineProvider } from '../src/offline/context.tsx';
import { OfflineRuntime } from '../src/offline/runtime.ts';
import { syncApi, type SyncApi } from '../src/replica/api.ts';
import { formatHlc, parseHlc } from '../src/replica/hlc.ts';
import type { KvBackend, KvStoreName } from '../src/replica/vault.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';

export const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (v: unknown) => JSON.stringify(v ?? null);

// ---- storage, timers ----------------------------------------------------------------------------

/** An in-memory KvBackend; `raw` is exactly what would be on disk. */
export function memoryKv() {
  const raw = new Map<KvStoreName, Map<string, unknown>>();
  const store = (s: KvStoreName) => {
    let m = raw.get(s);
    if (!m) raw.set(s, (m = new Map()));
    return m;
  };
  const kv: KvBackend = {
    get: async (s, k) => store(s).get(k),
    put: async (s, entries) => {
      for (const [k, v] of entries) store(s).set(k, v);
    },
    delete: async (s, keys) => {
      for (const k of keys) store(s).delete(k);
    },
    entries: async (s) => [...store(s).entries()],
    clear: async (s) => {
      store(s).clear();
    },
  };
  return { kv, raw, store };
}

/** Timers a test fires by hand (`run` fires every pending one). */
export function manualTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    set: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      pending.push(t);
      return () => {
        const i = pending.indexOf(t);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    /** Fire every pending timer (once each). */
    run: () => {
      for (const t of pending.splice(0)) t.fn();
    },
  };
}

// ---- the fake Hub ----------------------------------------------------------------------------------

interface Field {
  value: unknown;
  hlc: string;
  deviceId: string | null;
  cursor: number;
}

interface Ent {
  kind: SyncKind;
  id: string;
  fields: Map<string, Field>;
}

export interface FakeDevice {
  id: string;
  name: string;
  platform: string | null;
  scopes: string[];
  revoked: boolean;
  cursor: number;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  resetAt: string | null;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

const denied = (reason: string, message = 'denied') =>
  new HttpError(403, { code: 'policy_denied', message, retryable: false, details: { reason } });
const conflict = (reason: string, message = 'conflict', retryable = false) =>
  new HttpError(409, { code: 'conflict', message, retryable, details: { reason } });
const notFound = (message = 'not found') =>
  new HttpError(404, { code: 'not_found', message, retryable: false });

export const THIS_DEVICE = '01900000-0000-7000-8000-00000000d001';
export const OTHER_DEVICE = '01900000-0000-7000-8000-00000000d002';

export class FakeSyncHub {
  now = T0;
  /** The Hub is unreachable: every request fails as fetch does. */
  down = false;
  /** Answer every request with this gateway status instead (a proxy whose Hub is down). */
  gateway: number | null = null;
  syncEnabled = true;
  maxSkewMs = 300_000;
  accountId = 'acc1';
  signedIn = true;
  deviceId: string | null = THIS_DEVICE;
  scopes: string[] | null = ['offline-replica', 'local-runtime'];
  readonly devices = new Map<string, FakeDevice>();
  readonly entities = new Map<string, Ent>();
  readonly merge: SyncMergeEntryView[] = [];
  cursor = 0;
  /** Requests as the fetch saw them, with their Idempotency-Key. */
  readonly requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
  /** Answers the next request to a path ("POST /api/v1/sync/push") with this error. */
  readonly failNext = new Map<string, { status: number; body: ApiErrorBody }>();
  /** Routes ("POST /api/v1/sync/push") whose next answer is lost after the Hub acted on it. */
  readonly loseAnswer = new Set<string>();
  /** Delivers an event to the app (tests point it at the fake event stream). */
  onEvent: ((name: string, payload: Record<string, unknown>) => void) | null = null;
  /** Messages the Hub was asked to answer (`…/messages/:mid/answer`). */
  readonly answered: string[] = [];
  /** Chats with a turn running (the answer route refuses `turn_in_progress`). */
  readonly busy = new Set<string>();
  /** Chats shared with other members (the answer route refuses `shared_thread`). */
  readonly shared = new Set<string>();
  #hubPt = 0;
  #hubC = 0;
  #entrySeq = 0;
  readonly #idem = new Map<string, { hash: string; status: number; body: unknown }>();

  constructor() {
    for (const [id, name] of [
      [THIS_DEVICE, 'Laptop'],
      [OTHER_DEVICE, 'Phone'],
    ] as const)
      this.devices.set(id, {
        id,
        name,
        platform: id === THIS_DEVICE ? 'linux' : 'ios',
        scopes: ['offline-replica'],
        revoked: false,
        cursor: 0,
        lastPullAt: null,
        lastPushAt: null,
        lastError: null,
        resetAt: null,
      });
  }

  iso(ms = this.now): string {
    return new Date(ms).toISOString();
  }

  hubHlc(): string {
    if (this.now > this.#hubPt) {
      this.#hubPt = this.now;
      this.#hubC = 0;
    } else this.#hubC += 1;
    return formatHlc({ pt: this.#hubPt, c: this.#hubC, node: 'hub' });
  }

  /** A clock value as another device would stamp it. */
  deviceHlc(deviceId: string, ms = this.now, c = 0): string {
    return formatHlc({ pt: ms, c, node: deviceId });
  }

  #emit(name: string, payload: Record<string, unknown>): void {
    this.onEvent?.(name, payload);
  }

  #ent(kind: SyncKind, id: string): Ent | undefined {
    return this.entities.get(`${kind}:${id}`);
  }

  #live(kind: SyncKind, id: string): Ent | undefined {
    const e = this.#ent(kind, id);
    return e && !e.fields.has(SYNC_TOMBSTONE) ? e : undefined;
  }

  #set(
    kind: SyncKind,
    id: string,
    field: string,
    value: unknown,
    hlc: string,
    deviceId: string | null,
  ) {
    let e = this.#ent(kind, id);
    if (!e) this.entities.set(`${kind}:${id}`, (e = { kind, id, fields: new Map() }));
    e.fields.set(field, { value, hlc, deviceId, cursor: ++this.cursor });
  }

  value(kind: SyncKind, id: string, field: string): unknown {
    return this.#ent(kind, id)?.fields.get(field)?.value;
  }

  /** A change made on the Hub itself (or by `deviceId`), announced with `sync.changed`. */
  write(
    kind: SyncKind,
    id: string,
    fields: Record<string, unknown>,
    deviceId: string | null = null,
  ) {
    for (const [f, v] of Object.entries(fields))
      this.#set(kind, id, f, v, deviceId ? this.deviceHlc(deviceId) : this.hubHlc(), deviceId);
    this.#emit('sync.changed', { cursor: this.cursor });
  }

  remove(kind: SyncKind, id: string) {
    this.#set(kind, id, SYNC_TOMBSTONE, true, this.hubHlc(), null);
    this.merge.splice(
      0,
      this.merge.length,
      ...this.merge.filter((m) => !(m.kind === kind && m.entityId === id)),
    );
    this.#emit('sync.changed', { cursor: this.cursor });
  }

  /** A chat with two messages, a project, a space with a page. */
  seed() {
    this.write('project', 'p1', {
      name: 'Garden',
      instructions: 'Answer briefly.',
      createdAt: this.iso(),
    });
    this.write('thread', 't1', {
      title: 'Trip planning',
      pinned: false,
      archived: false,
      project: 'p1',
      mode: 'chat',
      createdAt: this.iso(),
    });
    this.write('thread', 't2', {
      title: 'Old notes',
      pinned: false,
      archived: true,
      project: null,
      mode: 'chat',
      createdAt: this.iso(),
    });
    this.write('message', 'm1', {
      body: {
        threadId: 't1',
        role: 'user',
        text: 'Where should we go?',
        parentId: null,
        status: 'complete',
        model: null,
        files: [],
        createdAt: this.iso(this.now + 1000),
      },
    });
    this.write('message', 'm2', {
      body: {
        threadId: 't1',
        role: 'assistant',
        text: 'Try the coast.',
        parentId: 'm1',
        status: 'complete',
        model: 'pa1/mock-fast',
        files: [],
        createdAt: this.iso(this.now + 2000),
      },
    });
    this.write('space', 's1', { name: 'Field notes', createdAt: this.iso() });
    this.write('page', 'pg1', {
      title: 'Packing',
      content: 'Boots',
      space: 's1',
      version: 3,
      createdAt: this.iso(),
    });
    return this;
  }

  // ---- sessions and replica guard -------------------------------------------------------------

  #signedIn(): void {
    if (!this.signedIn)
      throw new HttpError(401, { code: 'unauthorized', message: 'sign in', retryable: false });
  }

  #replica(): FakeDevice {
    this.#signedIn();
    const dev = this.deviceId ? this.devices.get(this.deviceId) : undefined;
    if (!dev || dev.revoked || !(this.scopes ?? []).includes('offline-replica'))
      throw denied('replica_not_granted', 'this device has no offline replica');
    if (!this.syncEnabled) throw denied('sync_disabled', 'sync is turned off on this Hub');
    return dev;
  }

  /** The owner revokes a device, or takes its offline copy away. */
  revoke(deviceId: string, reason: 'revoked' | 'scope_removed' = 'revoked') {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    if (reason === 'revoked') dev.revoked = true;
    dev.scopes = dev.scopes.filter((s) => s !== 'offline-replica');
    if (deviceId === this.deviceId) {
      if (reason === 'revoked') this.signedIn = false;
      else this.scopes = (this.scopes ?? []).filter((s) => s !== 'offline-replica');
    }
    this.#emit('sync.replica.revoked', { deviceId, reason });
  }

  // ---- sync routes -----------------------------------------------------------------------------

  snapshot(q: URLSearchParams) {
    const dev = this.#replica();
    const limit = Math.min(500, Number(q.get('limit') ?? 200));
    const cursor = q.get('cursor');
    let kind = (q.get('kind') as SyncKind | null) ?? SYNC_KINDS[0];
    let after = '';
    if (cursor) {
      const [k, a] = cursor.split('|');
      kind = k as SyncKind;
      after = a ?? '';
    }
    const ids = [...this.entities.values()]
      .filter((e) => e.kind === kind && e.id > after && !e.fields.has(SYNC_TOMBSTONE))
      .map((e) => e.id)
      .sort()
      .slice(0, limit);
    const items: SyncEntityView[] = ids.map((id) => {
      const e = this.#ent(kind, id)!;
      return {
        kind,
        id,
        fields: Object.fromEntries(
          [...e.fields].map(([f, v]) => [f, { value: v.value, hlc: v.hlc, deviceId: v.deviceId }]),
        ),
      };
    });
    let nextCursor: string | null = null;
    if (ids.length === limit) nextCursor = `${kind}|${ids.at(-1)}`;
    else if (!q.get('kind')) {
      const next = SYNC_KINDS[SYNC_KINDS.indexOf(kind) + 1];
      if (next) nextCursor = `${next}|`;
    }
    if (!cursor) dev.resetAt = null;
    dev.lastPullAt = this.iso();
    return { kind, items, nextCursor, feedCursor: this.cursor };
  }

  changes(q: URLSearchParams) {
    const dev = this.#replica();
    const since = Number(q.get('since') ?? 0);
    const limit = Number(q.get('limit') ?? 500);
    if (dev.resetAt && since > 0) throw conflict('replica_reset', 'load a snapshot first');
    if (since > this.cursor) throw conflict('cursor_ahead', 'the cursor is ahead');
    const rows: SyncChangeView[] = [];
    for (const e of this.entities.values())
      for (const [field, f] of e.fields)
        if (f.cursor > since)
          rows.push({
            cursor: f.cursor,
            kind: e.kind,
            id: e.id,
            field,
            value: f.value,
            hlc: f.hlc,
            deviceId: f.deviceId,
          });
    rows.sort((a, b) => a.cursor - b.cursor);
    const page = rows.slice(0, limit);
    const cursor = page.at(-1)?.cursor ?? since;
    dev.cursor = cursor;
    dev.lastPullAt = this.iso();
    return { changes: page, cursor, more: rows.length > limit };
  }

  push(body: { deviceId: string; ops: SyncOp[] }) {
    const dev = this.#replica();
    if (body.deviceId !== dev.id) throw denied('device_mismatch', 'not this device');
    const deviceId = dev.id;
    const results: SyncOpResult[] = [];
    const r = (
      op: SyncOp,
      index: number,
      status: SyncOpResult['status'],
      extra: Partial<SyncOpResult> = {},
    ) => {
      results[index] = { index, kind: op.kind, id: op.id, field: op.field, status, ...extra };
    };
    const groups = new Map<string, { op: SyncOp; index: number }[]>();
    body.ops.forEach((op, index) => {
      const h = parseHlc(op.hlc);
      const fields = SYNC_FIELDS[op.kind] as { write: readonly string[]; read: readonly string[] };
      let reason: string | null = null;
      if (!h || !HLC_PATTERN.test(op.hlc)) reason = 'invalid_hlc';
      else if (h.node !== deviceId) reason = 'hlc_device_mismatch';
      else if (h.pt > this.now + this.maxSkewMs) reason = 'clock_skew';
      else if (op.field === SYNC_TOMBSTONE) {
        if (!SYNC_DELETABLE.includes(op.kind)) reason = 'not_deletable';
      } else if (!fields.write.includes(op.field))
        reason = fields.read.includes(op.field) ? 'read_only_field' : 'unknown_field';
      else if (op.kind === 'message' && !syncMessageBodySchema.safeParse(op.value).success)
        reason = 'invalid_value';
      else if (op.kind === 'message' && (op.value as { role: string }).role === 'assistant') {
        const v = op.value as { threadId: string; parentId: string };
        const parent = this.#live('message', v.parentId)?.fields.get('body')?.value as
          { threadId?: string } | undefined;
        if (!(this.scopes ?? []).includes('local-runtime')) reason = 'local_runtime_not_granted';
        else if (parent?.threadId !== v.threadId) reason = 'invalid_value';
      }
      if (reason) return r(op, index, 'rejected', { reason });
      const key = `${op.kind}:${op.id}`;
      groups.set(key, [...(groups.get(key) ?? []), { op, index }]);
    });
    let changed = false;
    const entries: SyncMergeEntryView[] = [];
    for (const ops of groups.values()) {
      const { kind, id } = ops[0]!.op;
      const e = this.#ent(kind, id);
      if (e?.fields.has(SYNC_TOMBSTONE)) {
        for (const o of ops) r(o.op, o.index, 'rejected', { reason: 'deleted' });
        continue;
      }
      if (!e) {
        const okThread =
          kind !== 'message' ||
          !!this.#live('thread', (ops[0]!.op.value as { threadId: string }).threadId);
        if (!SYNC_CREATABLE.includes(kind) || !UUID.test(id) || !okThread) {
          for (const o of ops)
            r(o.op, o.index, 'rejected', {
              reason: UUID.test(id) || !SYNC_CREATABLE.includes(kind) ? 'not_found' : 'invalid_id',
            });
          continue;
        }
        for (const o of ops) {
          const value =
            kind === 'message'
              ? {
                  ...(o.op.value as object),
                  parentId:
                    (o.op.value as { parentId?: string | null }).parentId ??
                    this.#leaf((o.op.value as { threadId: string }).threadId),
                  status: 'complete',
                  model: (o.op.value as { model?: string }).model ?? null,
                  provenance: (o.op.value as { provenance?: string }).provenance ?? null,
                  files: [],
                  createdAt: this.iso(),
                }
              : o.op.value;
          this.#set(kind, id, o.op.field, value, o.op.hlc, deviceId);
          r(o.op, o.index, 'accepted', { hlc: o.op.hlc });
        }
        if (kind === 'thread') {
          this.#set(kind, id, 'mode', 'chat', ops[0]!.op.hlc, deviceId);
          this.#set(kind, id, 'createdAt', this.iso(), ops[0]!.op.hlc, deviceId);
        }
        changed = true;
        continue;
      }
      if (kind === 'message') {
        const b = e.fields.get('body');
        for (const o of ops)
          if (b?.hlc === o.op.hlc) r(o.op, o.index, 'accepted', { hlc: b.hlc });
          else r(o.op, o.index, 'rejected', { reason: 'append_only' });
        continue;
      }
      for (const o of [...ops].sort((a, b) => (a.op.hlc < b.op.hlc ? -1 : 1))) {
        const cur = e.fields.get(o.op.field);
        if (cur?.hlc === o.op.hlc) {
          r(o.op, o.index, 'accepted', { hlc: cur.hlc });
          continue;
        }
        if (!cur || o.op.hlc > cur.hlc) {
          if (
            cur &&
            json(cur.value) !== json(o.op.value) &&
            o.op.base !== cur.hlc &&
            cur.deviceId !== deviceId
          )
            entries.push(
              this.#entry(kind, id, o.op.field, 'concurrent', cur, {
                value: o.op.value,
                hlc: o.op.hlc,
                deviceId,
              }),
            );
          this.#set(kind, id, o.op.field, o.op.value, o.op.hlc, deviceId);
          changed = true;
          r(o.op, o.index, 'accepted', { hlc: o.op.hlc });
        } else {
          if (json(cur.value) !== json(o.op.value) && cur.deviceId !== deviceId)
            entries.push(
              this.#entry(
                kind,
                id,
                o.op.field,
                'stale',
                { value: o.op.value, hlc: o.op.hlc, deviceId },
                cur,
              ),
            );
          r(o.op, o.index, 'overwritten', { reason: 'stale', hlc: cur.hlc, value: cur.value });
        }
      }
      // A page saved from a device is a new version of it, as on the Hub (FR-036).
      if (kind === 'page' && ops.some((o) => results[o.index]?.status === 'accepted'))
        this.#set(
          kind,
          id,
          'version',
          Number(e.fields.get('version')?.value ?? 1) + 1,
          this.hubHlc(),
          null,
        );
    }
    for (const m of entries) {
      results.find(
        (x) => x.kind === m.kind && x.id === m.entityId && x.field === m.field,
      )!.entryId = m.id;
      this.#emit('sync.conflict', { entryId: m.id, kind: m.kind, id: m.entityId, field: m.field });
    }
    dev.lastPushAt = this.iso();
    const refused = results.filter((x) => x.status === 'rejected');
    dev.lastError = refused.length ? `${refused.length} change(s) refused` : null;
    if (changed) this.#emit('sync.changed', { cursor: this.cursor });
    return { results, cursor: this.cursor, hlc: this.hubHlc() };
  }

  #side(s: { value: unknown; hlc: string; deviceId: string | null }): SyncMergeSideView {
    return {
      value: s.value,
      hlc: s.hlc,
      deviceId: s.deviceId,
      deviceName: s.deviceId ? (this.devices.get(s.deviceId)?.name ?? null) : null,
    };
  }

  #entry(
    kind: SyncKind,
    entityId: string,
    field: string,
    reason: SyncMergeEntryView['reason'],
    lost: { value: unknown; hlc: string; deviceId: string | null },
    winner: { value: unknown; hlc: string; deviceId: string | null },
  ): SyncMergeEntryView {
    const m: SyncMergeEntryView = {
      id: `me-${String(++this.#entrySeq).padStart(4, '0')}`,
      kind,
      entityId,
      field,
      reason,
      lost: this.#side(lost),
      winner: this.#side(winner),
      status: 'open',
      createdAt: this.iso(),
      restoredAt: null,
    };
    this.merge.push(m);
    return m;
  }

  /** A conflict as if two devices had raced (for the merge-log views). */
  conflict(kind: SyncKind, entityId: string, field: string, lost: unknown, winner: unknown) {
    const cur = this.#ent(kind, entityId)?.fields.get(field);
    return this.#entry(
      kind,
      entityId,
      field,
      'concurrent',
      { value: lost, hlc: this.deviceHlc(OTHER_DEVICE, this.now - 5000), deviceId: OTHER_DEVICE },
      { value: winner, hlc: cur?.hlc ?? this.hubHlc(), deviceId: cur ? cur.deviceId : THIS_DEVICE },
    );
  }

  mergeLog(q: URLSearchParams) {
    this.#signedIn();
    const status = q.get('status') ?? 'all';
    const before = q.get('before');
    const limit = Number(q.get('limit') ?? 100);
    const items = [...this.merge]
      .filter((m) => status === 'all' || m.status === status)
      .filter((m) => !before || m.id < before)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((m) => structuredClone(m));
    return { items };
  }

  restore(id: string) {
    this.#signedIn();
    const m = this.merge.find((x) => x.id === id);
    if (!m) throw notFound('merge log entry not found');
    if (m.status === 'restored') throw conflict('already_restored', 'restored already');
    if (!this.#live(m.kind, m.entityId)) throw conflict('deleted', 'the entity was deleted');
    const cur = this.#ent(m.kind, m.entityId)!.fields.get(m.field);
    const hlc = this.hubHlc();
    if (cur && json(cur.value) !== json(m.lost.value))
      this.#entry(m.kind, m.entityId, m.field, 'restore', cur, {
        value: m.lost.value,
        hlc,
        deviceId: this.deviceId,
      });
    this.#set(m.kind, m.entityId, m.field, m.lost.value, hlc, this.deviceId);
    m.status = 'restored';
    m.restoredAt = this.iso();
    this.#emit('sync.changed', { cursor: this.cursor });
    return structuredClone(m);
  }

  replicaView(d: FakeDevice): SyncReplicaView {
    const granted = !d.revoked && d.scopes.includes('offline-replica');
    let behind = 0;
    for (const e of this.entities.values())
      for (const f of e.fields.values()) if (f.cursor > d.cursor) behind += 1;
    const seen = [d.lastPullAt, d.lastPushAt].filter((v): v is string => !!v).map(Date.parse);
    const last = seen.length ? Math.max(...seen) : null;
    const status: SyncReplicaView['status'] =
      d.revoked || !granted || last === null || this.now - last > 10 * 60_000
        ? 'offline'
        : d.lastError
          ? 'error'
          : behind > 0
            ? 'pending'
            : 'synced';
    return {
      deviceId: d.id,
      name: d.name,
      platform: d.platform,
      granted,
      revoked: d.revoked,
      status,
      cursor: d.cursor,
      behind,
      lastPullAt: d.lastPullAt,
      lastPushAt: d.lastPushAt,
      lastError: d.lastError,
      resetAt: d.resetAt,
    };
  }

  resetDevice(id: string) {
    this.#signedIn();
    const d = this.devices.get(id);
    if (!d) throw notFound('device not found');
    d.resetAt = this.iso();
    d.cursor = 0;
    d.lastError = null;
    this.#emit('sync.replica.reset', { deviceId: id });
    return this.replicaView(d);
  }

  // ---- the REST views the offline layer reads and writes ------------------------------------------

  /** The newest message of a chat (where the Hub appends). */
  #leaf(threadId: string): string | null {
    return this.#messages(threadId).at(-1)?.id ?? null;
  }

  threadView(id: string): ThreadView {
    const e = this.#live('thread', id);
    if (!e) throw notFound('thread not found');
    const v = (f: string) => e.fields.get(f)?.value;
    return {
      id,
      mode: (v('mode') as ThreadView['mode'] | undefined) ?? 'chat',
      title: (v('title') as string | null | undefined) ?? null,
      projectId: (v('project') as string | null | undefined) ?? null,
      pinned: v('pinned') === true,
      archived: v('archived') === true,
      unread: false,
      temporary: false,
      state: 'idle',
      model: 'pa1/mock-smart',
      reasoningLevel: null,
      parentThreadId: null,
      branchFromMessageId: null,
      side: false,
      memoryOptOut: false,
      createdAt: (v('createdAt') as string | undefined) ?? this.iso(),
      updatedAt: this.iso(),
    };
  }

  #messages(threadId: string): MessageView[] {
    return [...this.entities.values()]
      .filter((e) => e.kind === 'message' && !e.fields.has(SYNC_TOMBSTONE))
      .map((e) => ({ e, b: e.fields.get('body')?.value as Record<string, unknown> }))
      .filter(({ b }) => b.threadId === threadId)
      .map(({ e, b }) => ({
        id: e.id,
        threadId,
        turnId: null,
        role: b.role as MessageView['role'],
        status: 'complete' as const,
        parts: [{ type: 'text' as const, text: String(b.text) }],
        model: (b.model as string | null) ?? null,
        usage: null,
        createdAt: String(b.createdAt),
        parentId: (b.parentId as string | null) ?? null,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  projectView(id: string): ProjectView {
    const e = this.#live('project', id);
    if (!e) throw notFound('project not found');
    return {
      id,
      name: String(e.fields.get('name')?.value),
      instructions: (e.fields.get('instructions')?.value as string | null) ?? null,
      memoryScope: 'project_only',
      threadCount: 1,
      sourceCount: 2,
      createdAt: this.iso(),
      updatedAt: this.iso(),
    };
  }

  spaceView(id: string): SpaceView {
    const e = this.#live('space', id);
    if (!e) throw notFound('space not found');
    const pages = [...this.entities.values()].filter(
      (p) =>
        p.kind === 'page' && p.fields.get('space')?.value === id && !p.fields.has(SYNC_TOMBSTONE),
    );
    return {
      id,
      name: String(e.fields.get('name')?.value),
      description: 'Notes from the road',
      projectId: null,
      agentEdits: 'propose',
      pageCount: pages.length,
      createdAt: (e.fields.get('createdAt')?.value as string | undefined) ?? this.iso(),
      updatedAt: this.iso(),
    };
  }

  /** `POST …/messages/:mid/answer`: the Hub answers a message a device wrote offline. */
  answer(threadId: string, messageId: string): SendMessageResponse {
    this.threadView(threadId);
    const body = this.#live('message', messageId)?.fields.get('body')?.value as
      { threadId?: string; role?: string } | undefined;
    if (!body || body.threadId !== threadId) throw notFound('message not found');
    const refuse = (status: number, code: string, reason: string) =>
      new HttpError(status, { code, message: reason, retryable: false, details: { reason } });
    if (this.shared.has(threadId)) throw refuse(400, 'validation', 'shared_thread');
    if (body.role !== 'user') throw refuse(400, 'validation', 'not_user_message');
    if (this.busy.has(threadId)) throw refuse(409, 'conflict', 'turn_in_progress');
    const after = this.#messages(threadId).filter((m) => m.parentId === messageId);
    if (after.some((m) => m.role === 'assistant')) throw refuse(409, 'conflict', 'answered');
    if (after.length) throw refuse(409, 'conflict', 'not_last');
    this.answered.push(messageId);
    const aid = `a-hub-${this.cursor + 1}`;
    this.write('message', aid, {
      body: {
        threadId,
        role: 'assistant',
        text: 'Answered by the Hub.',
        parentId: messageId,
        status: 'complete',
        model: 'pa1/mock-fast',
        provenance: null,
        files: [],
        createdAt: this.iso(),
      },
    });
    return {
      disposition: 'started',
      turnId: 'turn2',
      userMessageId: messageId,
      assistantMessageId: aid,
    };
  }

  pageView(spaceId: string, id: string): PageView {
    const e = this.#live('page', id);
    if (!e || e.fields.get('space')?.value !== spaceId) throw notFound('page not found');
    return {
      id,
      spaceId,
      title: String(e.fields.get('title')?.value),
      slug: 'packing.html',
      position: 0,
      version: Number(e.fields.get('version')?.value ?? 1),
      updatedBy: 'user',
      openComments: 0,
      openProposals: 0,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      content: String(e.fields.get('content')?.value),
    };
  }

  #route(method: string, path: string, body: Record<string, unknown>): unknown {
    const [base = '', qs = ''] = path.split('?');
    const q = new URLSearchParams(qs);
    const parts = base
      .replace(/^\/api\/v1\//, '')
      .split('/')
      .map(decodeURIComponent);
    const [head, id, sub, subId] = parts;
    const is = (m: string, n: number) => method === m && parts.length === n;
    if (head === 'hello' && is('GET', 1))
      return { name: 'Nova', version: '0.7.0', apiVersions: ['v1'], setupRequired: false };
    if (head === 'session' && is('GET', 1)) {
      this.#signedIn();
      return {
        accountId: this.accountId,
        displayName: 'Sam',
        deviceId: this.deviceId,
        scopes: this.scopes,
      };
    }
    if (head === 'settings' && is('GET', 1))
      return {
        settings: [
          { key: 'appearance.theme', value: 'light', source: 'global', locked: false },
          { key: 'sync.enabled', value: true, source: 'global', locked: false },
        ],
      };
    if (head === 'models' && is('GET', 1)) return { items: [] };
    if (head === 'sync') {
      if (id === 'snapshot' && is('GET', 2)) return this.snapshot(q);
      if (id === 'changes' && is('GET', 2)) return this.changes(q);
      if (id === 'push' && is('POST', 2))
        return this.push(body as { deviceId: string; ops: SyncOp[] });
      if (id === 'merge-log' && is('GET', 2)) return this.mergeLog(q);
      if (id === 'merge-log' && sub && subId === 'restore' && is('POST', 4))
        return this.restore(sub);
      if (id === 'devices' && is('GET', 2)) {
        this.#signedIn();
        return { items: [...this.devices.values()].map((d) => this.replicaView(d)) };
      }
      if (id === 'devices' && sub && subId === 'reset' && is('POST', 4))
        return this.resetDevice(sub);
    }
    this.#signedIn();
    if (head === 'threads') {
      if (is('GET', 1)) {
        const archived = q.get('archived') === 'true';
        const items = [...this.entities.values()]
          .filter((e) => e.kind === 'thread' && !e.fields.has(SYNC_TOMBSTONE))
          .map((e) => this.threadView(e.id))
          .filter((t) => t.archived === archived);
        return { items, nextCursor: null };
      }
      if (id && is('GET', 2))
        return { thread: this.threadView(id), messages: this.#messages(id), queue: [] };
      if (id && sub === 'queue' && is('GET', 3)) return { items: [] };
      if (id && is('PATCH', 2)) {
        this.threadView(id);
        const map: Record<string, string> = {
          title: 'title',
          pinned: 'pinned',
          archived: 'archived',
          projectId: 'project',
        };
        this.write(
          'thread',
          id,
          Object.fromEntries(
            Object.entries(body)
              .filter(([k]) => k in map)
              .map(([k, v]) => [map[k]!, v]),
          ),
        );
        return this.threadView(id);
      }
      if (id && sub === 'messages' && subId && parts[4] === 'answer' && is('POST', 5))
        return this.answer(id, subId);
      if (id && sub === 'messages' && is('POST', 3)) {
        this.threadView(id);
        const mid = `m-hub-${this.cursor + 1}`;
        this.write('message', mid, {
          body: {
            threadId: id,
            role: 'user',
            text: body.text,
            parentId: null,
            status: 'complete',
            model: null,
            files: [],
            createdAt: this.iso(),
          },
        });
        const res: SendMessageResponse = {
          disposition: 'started',
          turnId: 'turn1',
          userMessageId: mid,
          assistantMessageId: 'a1',
        };
        return res;
      }
    }
    if (head === 'projects') {
      if (is('GET', 1))
        return {
          items: [...this.entities.values()]
            .filter((e) => e.kind === 'project' && !e.fields.has(SYNC_TOMBSTONE))
            .map((e) => this.projectView(e.id)),
        };
      if (id && is('GET', 2)) return this.projectView(id);
      if (id && is('PATCH', 2)) {
        this.projectView(id);
        this.write('project', id, body);
        return this.projectView(id);
      }
    }
    if (head === 'spaces') {
      if (is('GET', 1))
        return {
          items: [...this.entities.values()]
            .filter((e) => e.kind === 'space' && !e.fields.has(SYNC_TOMBSTONE))
            .map((e) => this.spaceView(e.id)),
        };
      if (id && is('GET', 2)) return this.spaceView(id);
      if (id && is('PATCH', 2)) {
        this.spaceView(id);
        this.write('space', id, { name: body.name });
        return this.spaceView(id);
      }
      if (id && sub === 'pages' && is('GET', 3))
        return {
          items: [...this.entities.values()]
            .filter(
              (e) =>
                e.kind === 'page' &&
                e.fields.get('space')?.value === id &&
                !e.fields.has(SYNC_TOMBSTONE),
            )
            .map((e) => {
              const { content: _c, ...summary } = this.pageView(id, e.id);
              return summary;
            }),
        };
      if (id && sub === 'pages' && subId && is('GET', 4)) return this.pageView(id, subId);
      if (id && sub === 'pages' && subId && is('PUT', 4)) {
        const page = this.pageView(id, subId);
        if (body.baseVersion !== page.version)
          throw conflict('stale_version', 'a newer version was saved');
        const fields: Record<string, unknown> = {};
        if (typeof body.title === 'string') fields.title = body.title;
        if (typeof body.content === 'string') fields.content = body.content;
        this.write('page', subId, { ...fields, version: page.version + 1 });
        return this.pageView(id, subId);
      }
    }
    throw notFound(`no route ${method} ${base}`);
  }

  /** A fetch that answers like this Hub, or fails like an unreachable one. */
  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname + input.search
          : input.url;
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const key = headers['idempotency-key'] ?? null;
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.requests.push({ method, path, key, body });
    if (this.down) throw new TypeError('Failed to fetch');
    if (this.gateway) return new Response('Bad gateway', { status: this.gateway });
    const respond = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });
    const route = `${method} ${path.split('?')[0]}`;
    const scripted = this.failNext.get(route);
    if (scripted) {
      this.failNext.delete(route);
      return respond(scripted.status, { error: scripted.body });
    }
    const idemKey = key
      ? `${this.deviceId ?? 'owner'}|${method}|${path.split('?')[0]}|${key}`
      : null;
    const hash = json(body);
    if (idemKey) {
      const seen = this.#idem.get(idemKey);
      if (seen && seen.hash !== hash)
        return respond(409, {
          error: {
            code: 'conflict',
            message: 'key reused',
            retryable: false,
            details: { reason: 'idempotency_key_reused' },
          },
        });
      if (seen) return respond(seen.status, seen.body, { 'idempotent-replay': 'true' });
    }
    let status = 200;
    let data: unknown;
    try {
      data = this.#route(method, path, body);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      status = err.status;
      data = { error: err.body };
    }
    if (idemKey && status < 500 && status !== 429)
      this.#idem.set(idemKey, { hash, status, body: data });
    if (this.loseAnswer.delete(route)) throw new TypeError('Failed to fetch');
    return respond(status, data);
  };

  /** A request function like createApi's, through this fetch (for the sync calls in services). */
  readonly call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const res = await this.fetch(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json()) as { error?: ApiErrorBody } & T;
    if (!res.ok) throw new ApiError(res.status, data.error!);
    return data;
  };

  /** The sync calls of the app's client, as spies (what `createApi` will spread). */
  readonly api: SyncMocks = Object.fromEntries(
    Object.entries(syncApi(this.call)).map(([k, fn]) => [
      k,
      vi.fn(fn as (...a: unknown[]) => unknown),
    ]),
  ) as unknown as SyncMocks;
}

export type SyncMocks = { [K in keyof SyncApi]: Mock<SyncApi[K]> };

// ---- the desktop shell's bridge -----------------------------------------------------------------------

export function fakeShell(
  opts: {
    models?: ShellLocalRuntimeModelsView;
    answer?: string[];
    fail?: string;
  } = {},
) {
  const chats: ShellLocalChatRequest[] = [];
  const bridge: NovaShellBridge = {
    version: 1,
    platform: 'linux',
    openWindow: async () => true,
    shortcuts: async () => [],
    setShortcut: async () => [],
    localRuntime: {
      models: async () => opts.models ?? { ok: true, models: ['llama3.2', 'qwen3:8b'] },
      chat: async (req, onDelta) => {
        chats.push(req);
        if (opts.fail) throw new Error(opts.fail);
        const parts = opts.answer ?? ['Pack ', 'light.'];
        for (const p of parts) onDelta(p);
        return { text: parts.join('') };
      },
    },
  };
  return { bridge, chats };
}

export function installShell(bridge: NovaShellBridge | null) {
  const w = window as unknown as { novaShell?: NovaShellBridge };
  if (bridge) w.novaShell = bridge;
  else delete w.novaShell;
}

// ---- the offline layer on a fake Hub ------------------------------------------------------------------

/** A runtime on `hub` with memory storage and hand-run timers, and the app client it is part of. */
export function offlineSetup(hub = new FakeSyncHub(), kv = memoryKv()) {
  const timers = manualTimers();
  const runtime = new OfflineRuntime({
    kv: () => kv.kv,
    now: () => hub.now,
    random: () => 0.5,
    setTimer: timers.set,
    windowEvents: false,
  });
  const api = createApi(hub.fetch, { offline: runtime });
  return { hub, kv, timers, runtime, api };
}

/** Wait until `cond` holds, letting promises settle (no timers involved). */
export async function settle(cond: () => boolean = () => true, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!cond()) throw new Error('condition never held');
}

/**
 * Render `ui` inside the providers the offline and sync views need: the main fake Hub's client with
 * the sync calls spread over it, and (when given) the offline runtime.
 */
export async function renderOffline(
  ui: ReactNode,
  opts: { runtime?: OfflineRuntime | null; hub?: FakeSyncHub } = {},
) {
  const main = createHub();
  main.state.settings = { 'onboarding.state': DONE_ONBOARDING };
  const sync = opts.hub ?? new FakeSyncHub();
  const api = { ...main.api, ...sync.api };
  const { settings } = await main.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, {
      children: createElement(OfflineProvider, { runtime: opts.runtime ?? null, children: ui }),
    }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { main, sync, api, ...utils };
}
