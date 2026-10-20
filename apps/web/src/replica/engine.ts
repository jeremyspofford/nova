// Keeps this device's offline copy in step with the Hub (FR-109, FR-129, ADR-036, docs/13 §2):
// only while the session grants `offline-replica`. A first (or reset) load pages through
// /sync/snapshot and then pulls /sync/changes from the cursor of its first page; afterwards the
// copy pulls on `sync.changed` and whenever the Hub comes back. A 409 `replica_reset` or
// `cursor_ahead` (and `sync.replica.reset` for this device) loads it again. `sync.replica.revoked`
// for this device, a 401, or a refused grant wipe it, key and all. One job runs at a time.
import { defineMessages } from '@nova/i18n';
import type { EventEnvelope, SyncKind, SyncOp, SyncPushResult } from '@nova/shared';
import { ApiError } from '../api.ts';
import { REPLICA_SCOPE, type SyncApi, type SyncSession } from './api.ts';
import { HybridClock } from './hlc.ts';
import { Replica } from './replica.ts';
import type { KvBackend } from './vault.ts';

export const SYNC_EVENTS = ['sync.changed', 'sync.replica.revoked', 'sync.replica.reset'] as const;

export type ReplicaPhase =
  /** The session grants no offline copy (or none is known yet). */
  | 'off'
  /** Granted, but this browser cannot keep one encrypted (no IndexedDB or WebCrypto). */
  | 'unsupported'
  | 'loading'
  | 'ready'
  /** Sync is turned off on the Hub: the copy stays as it is. */
  | 'paused'
  | 'error'
  /** Revoked, the grant taken away, or signed out: the copy was wiped. */
  | 'removed';

export type RemovalReason = 'revoked' | 'scope_removed' | 'signed_out';

export interface ReplicaState {
  phase: ReplicaPhase;
  /** The session grants this device an offline copy; null until the session is known. */
  granted: boolean | null;
  deviceId: string | null;
  /**
   * The Hub's own words when syncing failed (English, D9), or null. `replicaReason` words every
   * state at render time.
   */
  reason: string | null;
  removal: RemovalReason | null;
  syncing: boolean;
  loadedAt: string | null;
  lastSyncAt: string | null;
  cursor: number;
  bytes: number;
  counts: Record<SyncKind, number> | null;
  /** Bumps whenever the copy changes. */
  version: number;
}

export const REMOVAL_TEXT = defineMessages('replica.removal', {
  revoked: 'The Hub revoked this device, so its offline copy was removed.',
  scope_removed: 'The Hub no longer lets this device keep an offline copy, so it was removed.',
  signed_out: 'This device is signed out of the Hub, so its offline copy was removed.',
});

export const REPLICA_TEXT = defineMessages('replica', {
  unsupported:
    'This browser cannot keep an encrypted offline copy: it needs IndexedDB and WebCrypto, ' +
    'which need HTTPS or this computer.',
  paused: 'Sync is turned off on the Hub, so this copy is not updated.',
  failed: 'Sync failed.',
});

/** Why the copy is unavailable, paused, failed or was removed, in the active locale; else null. */
export function replicaReason(
  s: Pick<ReplicaState, 'phase' | 'removal' | 'reason'>,
): string | null {
  switch (s.phase) {
    case 'removed':
      return s.removal ? REMOVAL_TEXT[s.removal] : null;
    case 'unsupported':
      return REPLICA_TEXT.unsupported;
    case 'paused':
      return REPLICA_TEXT.paused;
    case 'error':
      return s.reason ?? REPLICA_TEXT.failed;
    default:
      return null;
  }
}

type Client = Pick<SyncApi, 'syncSnapshot' | 'syncChanges' | 'syncPush'>;

export interface EngineDeps {
  /** Where the copy is kept; null when the browser has no IndexedDB or WebCrypto. */
  kv: () => KvBackend | null;
  client: Client;
  now?: () => number;
  /** Snapshot and changes page sizes (the Hub caps them at 500 and 1000). */
  pageSize?: number;
}

function reasonOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

const fresh = (): ReplicaState => ({
  phase: 'off',
  granted: null,
  deviceId: null,
  reason: null,
  removal: null,
  syncing: false,
  loadedAt: null,
  lastSyncAt: null,
  cursor: 0,
  bytes: 0,
  counts: null,
  version: 0,
});

export class SyncEngine {
  readonly #deps: EngineDeps;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #replica: Replica | null = null;
  #clock: HybridClock | null = null;
  #state: ReplicaState = fresh();
  #queue: Promise<void> = Promise.resolve();
  #pulling = false;
  #pullAgain = false;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** The copy, once it holds a finished load (reads use it only then). */
  get replica(): Replica | null {
    return this.#replica?.meta?.loadedAt ? this.#replica : null;
  }

  get deviceId(): string | null {
    return this.#replica?.meta?.deviceId ?? null;
  }

  state(): ReplicaState {
    return this.#state;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** A clock value for a change made on this device (FR-109). */
  tick(): string | null {
    if (!this.#clock) return null;
    const v = this.#clock.tick();
    void this.#replica?.updateMeta({ clock: v }).catch(() => undefined);
    return v;
  }

  /** Take in a clock this device has seen (a queued change made before a restart). */
  receive(hlc: string): void {
    this.#clock?.receive(hlc);
  }

  /** Opens the copy saved on this device, for a start without the Hub. */
  restore(): Promise<Replica | null> {
    return this.#serial(async () => {
      if (this.#replica) return;
      const kv = this.#deps.kv();
      if (!kv) return;
      const r = await Replica.open(kv, false);
      if (!r?.meta) return;
      this.#use(r);
      this.#set({ granted: true, phase: r.meta.loadedAt ? 'ready' : 'loading' });
    }).then(() => this.replica);
  }

  /**
   * The session is known: keep, load or wipe the copy. Offline (the Hub unreachable now) the copy
   * is only opened; it syncs when `start` runs again with the Hub back.
   */
  start(session: SyncSession, online: boolean): Promise<void> {
    return this.#serial(async () => {
      const deviceId = session.deviceId ?? null;
      const granted = !!deviceId && (session.scopes ?? []).includes(REPLICA_SCOPE);
      const kv = this.#deps.kv();
      if (!granted || !deviceId) {
        // A copy left from before (the grant went while this device was away) goes now.
        if (this.#replica || (kv && (await kv.get('keys', 'replica')) !== undefined))
          await this.#wipe(kv);
        // Just removed: the reason stays for the user to read.
        if (this.#state.phase === 'removed') this.#set({ granted: false, deviceId });
        else this.#set({ ...fresh(), granted: false, deviceId, phase: 'off' });
        return;
      }
      if (!kv) {
        this.#set({ granted: true, deviceId, phase: 'unsupported', reason: null });
        return;
      }
      const r = this.#replica ?? (await Replica.open(kv, true));
      if (!r) return;
      const meta = r.meta;
      if (!meta || meta.deviceId !== deviceId || meta.accountId !== session.accountId) {
        await r.clearEntities();
        await r.setMeta({
          v: 1,
          accountId: session.accountId,
          deviceId,
          cursor: 0,
          loadedAt: null,
          lastSyncAt: null,
          clock: null,
        });
      }
      this.#use(r);
      this.#set({
        granted: true,
        deviceId,
        removal: null,
        reason: null,
        phase: r.meta?.loadedAt ? 'ready' : 'loading',
      });
      if (!online) return;
      if (r.meta?.loadedAt) await this.#pull();
      else await this.#load();
    });
  }

  /** Pull what changed (coalesced: a request during a pull runs one more). */
  pull(): Promise<void> {
    if (this.#pulling) {
      this.#pullAgain = true;
      return this.#queue;
    }
    this.#pulling = true;
    return this.#serial(async () => {
      try {
        do {
          this.#pullAgain = false;
          await this.#pull();
        } while (this.#pullAgain);
      } finally {
        this.#pulling = false;
      }
    });
  }

  /** Wipe the copy on this device and load it again from the Hub. */
  reload(): Promise<void> {
    return this.#serial(() => this.#load());
  }

  /** The copy goes: revoked, the grant taken away, or signed out. */
  remove(reason: RemovalReason): Promise<void> {
    return this.#serial(async () => {
      if (this.#state.phase === 'removed' && this.#state.removal === reason) return;
      const had = this.#replica !== null || this.#state.granted === true;
      await this.#wipe(this.#deps.kv());
      this.#set({
        ...fresh(),
        phase: had ? 'removed' : 'off',
        granted: false,
        removal: had ? reason : null,
        reason: null,
      });
    });
  }

  /** Send this device's changes (the outbound queue calls it); the clock takes in the answer. */
  async push(ops: SyncOp[], idempotencyKey: string): Promise<SyncPushResult> {
    const deviceId = this.deviceId;
    if (!deviceId) throw new Error('no offline copy on this device');
    try {
      const res = await this.#deps.client.syncPush({ deviceId, ops }, idempotencyKey);
      this.#clock?.receive(res.hlc);
      return res;
    } catch (err) {
      await this.#refused(err);
      throw err;
    }
  }

  onEvent(env: EventEnvelope): void {
    const mine = env.payload.deviceId === this.deviceId && this.deviceId !== null;
    if (env.name === 'sync.changed') {
      if (this.replica) void this.pull();
    } else if (env.name === 'sync.replica.revoked' && mine) {
      void this.remove(env.payload.reason === 'scope_removed' ? 'scope_removed' : 'revoked');
    } else if (env.name === 'sync.replica.reset' && mine) {
      void this.reload();
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #use(r: Replica): void {
    this.#replica = r;
    const meta = r.meta;
    this.#clock = meta
      ? new HybridClock({ node: meta.deviceId, initial: meta.clock, now: this.#now })
      : null;
  }

  async #wipe(kv: KvBackend | null): Promise<void> {
    this.#replica = null;
    this.#clock = null;
    if (kv) await Replica.wipe(kv);
  }

  async #load(): Promise<void> {
    const r = this.#replica;
    if (!r?.meta) return;
    this.#set({ phase: 'loading', syncing: true, reason: null });
    try {
      await r.clearEntities();
      await r.updateMeta({ cursor: 0, loadedAt: null });
      let cursor: string | undefined;
      let feed: number | null = null;
      do {
        const page = await this.#deps.client.syncSnapshot({
          ...(cursor ? { cursor } : {}),
          limit: Math.min(500, this.#deps.pageSize ?? 500),
        });
        feed ??= page.feedCursor;
        for (const item of page.items)
          for (const f of Object.values(item.fields)) this.#clock?.receive(f.hlc);
        await r.load(page.items);
        cursor = page.nextCursor ?? undefined;
        this.#emit();
      } while (cursor);
      const at = new Date(this.#now()).toISOString();
      await r.updateMeta({
        cursor: feed ?? 0,
        loadedAt: at,
        lastSyncAt: at,
        clock: this.#clock?.last() ?? null,
      });
      this.#set({ phase: 'ready' });
      await this.#pull();
    } catch (err) {
      await this.#failed(err);
    } finally {
      this.#set({ syncing: false });
    }
  }

  async #pull(): Promise<void> {
    const r = this.#replica;
    if (!r?.meta?.loadedAt) return;
    this.#set({ syncing: true });
    try {
      let more = true;
      while (more) {
        const meta = r.meta;
        const res = await this.#deps.client.syncChanges(meta.cursor, this.#deps.pageSize ?? 500);
        for (const c of res.changes) this.#clock?.receive(c.hlc);
        await r.apply(res.changes);
        await r.updateMeta({
          cursor: res.cursor,
          lastSyncAt: new Date(this.#now()).toISOString(),
          clock: this.#clock?.last() ?? null,
        });
        more = res.more && res.changes.length > 0;
        this.#emit();
      }
      if (this.#state.phase !== 'ready') this.#set({ phase: 'ready', reason: null });
    } catch (err) {
      const reason = reasonOf(err);
      if (err instanceof ApiError && err.status === 409 && reason !== null) {
        if (reason === 'replica_reset' || reason === 'cursor_ahead') {
          this.#set({ syncing: false });
          await this.#load();
          return;
        }
      }
      await this.#failed(err);
    } finally {
      if (this.#state.syncing) this.#set({ syncing: false });
    }
  }

  /** A refusal that ends or pauses the copy; true when it was one. */
  async #refused(err: unknown): Promise<boolean> {
    if (!(err instanceof ApiError)) return false;
    const reason = reasonOf(err);
    if (err.status === 401) {
      await this.#removeNow('signed_out');
      return true;
    }
    if (err.status === 403 && reason === 'replica_not_granted') {
      await this.#removeNow('scope_removed');
      return true;
    }
    if (err.status === 403 && reason === 'sync_disabled') {
      this.#set({ phase: 'paused', reason: null });
      return true;
    }
    return false;
  }

  async #failed(err: unknown): Promise<void> {
    if (await this.#refused(err)) return;
    // The Hub went away mid-sync: the copy stays as it is; the offline layer notices.
    if (!(err instanceof ApiError)) return;
    this.#set({ phase: 'error', reason: err.body.message || null });
  }

  async #removeNow(reason: RemovalReason): Promise<void> {
    await this.#wipe(this.#deps.kv());
    this.#set({
      ...fresh(),
      phase: 'removed',
      granted: false,
      removal: reason,
      reason: null,
    });
  }

  #set(patch: Partial<ReplicaState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  #emit(): void {
    const r = this.#replica;
    const meta = r?.meta ?? null;
    this.#state = {
      ...this.#state,
      deviceId: meta?.deviceId ?? this.#state.deviceId,
      loadedAt: meta?.loadedAt ?? null,
      lastSyncAt: meta?.lastSyncAt ?? null,
      cursor: meta?.cursor ?? 0,
      bytes: r?.bytes() ?? 0,
      counts: r ? r.counts() : null,
      version: this.#state.version + 1,
    };
    for (const fn of [...this.#listeners]) fn();
  }
}
