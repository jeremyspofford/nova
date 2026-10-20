// The offline layer (FR-109, FR-112, FR-128, FR-129, docs/13 §2.3, docs/21 §9). `createApi` hands
// it every request it makes: it hears each answer (so it knows the Hub is reachable and keeps what
// views may need again) and is asked about each request the Hub could not be reached for. Then a
// read is answered from this device (the offline copy, or this page's memory without one) and a
// write, on a device with a copy, is queued as a sync change. While the Hub is away it checks back
// with growing pauses; when the Hub answers again it pulls the copy first and then sends what
// waits, in order. It also follows the sync events on the app's one event stream.
import { defineMessages } from '@nova/i18n';
import { SETTINGS, isSettingKey, uuidv7, type SyncOp } from '@nova/shared';
import { ApiError, type HubRequest, type LowLevelCall, type OfflineHandler } from '../api.ts';
import { subscribeHubEvents } from '../hub-events.ts';
import type { EventSourceFactory } from '../sse.ts';
import { syncApi, type SyncApi, type SyncSession } from '../replica/api.ts';
import { SYNC_EVENTS, SyncEngine, type ReplicaState } from '../replica/engine.ts';
import type { Replica } from '../replica/replica.ts';
import { indexedDbBackend, type KvBackend } from '../replica/vault.ts';
import { threadView, type ViewSource } from '../replica/views.ts';
import {
  answerParent,
  backoffMs,
  OutboundQueue,
  QUEUE_NOTES,
  type QueueItem,
  type QueueNote,
  type SendOutcome,
} from './queue.ts';
import { answerRead, BOOT_PATHS, ReadCache, SESSION_PATH, splitPath, V1 } from './reads.ts';
import { takeWrite, type WriteContext } from './writes.ts';

export interface OfflineState {
  hub: 'online' | 'offline';
  /** When the Hub stopped answering. */
  since: string | null;
  /** The next check of the Hub while it is away. */
  nextCheckAt: string | null;
  checking: boolean;
  replica: ReplicaState;
  queue: readonly QueueItem[];
  /** Where offline reads come from: the copy, or (without one) this page's memory. */
  reads: 'replica' | 'memory';
  /** The session's device scopes (null for a session of no device, or before it is known). */
  scopes: readonly string[] | null;
}

export interface RuntimeOptions {
  /** Where the copy and the queue are kept; IndexedDB by default (null where there is none). */
  kv?: () => KvBackend | null;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Pauses between checks of the Hub while it is away. */
  probe?: { baseMs: number; maxMs: number };
  /** Pauses before a waiting change is tried again. */
  backoff?: { baseMs: number; maxMs: number };
  /** Follow the browser's online and offline events (default true). */
  windowEvents?: boolean;
}

const RUNTIME_TEXT = defineMessages('offline.runtime', {
  /** Thrown when a local answer cannot be kept (shown by the local answer panel). */
  noCopy: 'This device has no offline copy.',
});

const isNote = (v: unknown): v is QueueNote =>
  typeof v === 'string' && (QUEUE_NOTES as readonly string[]).includes(v);

function isCacheable(path: string): boolean {
  const base = path.split('?')[0] ?? path;
  if (BOOT_PATHS.includes(base)) return true;
  const head = splitPath(path)?.parts[0];
  return head === 'threads' || head === 'projects' || head === 'spaces';
}

/**
 * A start-up answer as it is kept on the device: settings without the security-relevant ones,
 * which stay on the Hub as they do for sync (docs/13 §2.1); the app uses their defaults offline.
 */
export function forDisk(path: string, data: unknown): unknown {
  if (path !== `${V1}/settings` || typeof data !== 'object' || data === null) return data;
  const rows = (data as { settings?: unknown }).settings;
  if (!Array.isArray(rows)) return data;
  return {
    ...data,
    settings: rows.filter((r: { key?: unknown }) => {
      const key = typeof r.key === 'string' ? r.key : '';
      return isSettingKey(key) && !(SETTINGS[key] as { security?: boolean }).security;
    }),
  };
}

const scopesKey = (s: SyncSession | null) =>
  `${s?.deviceId ?? ''}|${[...(s?.scopes ?? [])].sort().join(',')}`;

export class OfflineRuntime implements OfflineHandler {
  readonly engine: SyncEngine;
  readonly queue: OutboundQueue;
  readonly cache = new ReadCache();
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  readonly #probe: { baseMs: number; maxMs: number };
  readonly #windowEvents: boolean;
  readonly #listeners = new Set<() => void>();
  #call: LowLevelCall | null = null;
  #api: SyncApi | null = null;
  #session: SyncSession | null = null;
  #online = true;
  #since: string | null = null;
  #probeAttempt = 0;
  #nextCheckAt: string | null = null;
  #checking = false;
  #cancelProbe: (() => void) | null = null;
  #restoring: Promise<void> | null = null;
  #reconnecting: Promise<void> | null = null;
  #reconnectAgain = false;
  #started = 0;
  #bootKeptFor: Replica | null = null;
  #state: OfflineState;

  constructor(opts: RuntimeOptions = {}) {
    let idb: KvBackend | null | undefined;
    const kv = opts.kv ?? (() => (idb === undefined ? (idb = indexedDbBackend()) : idb));
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? Math.random;
    this.#setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.#probe = opts.probe ?? { baseMs: 2000, maxMs: 60_000 };
    this.#windowEvents = opts.windowEvents ?? true;
    this.engine = new SyncEngine({
      kv,
      now: this.#now,
      client: {
        syncSnapshot: (q) => this.#sync().syncSnapshot(q),
        syncChanges: (since, limit) => this.#sync().syncChanges(since, limit),
        syncPush: (body, key) => this.#sync().syncPush(body, key),
      },
    });
    this.queue = new OutboundQueue({
      kv,
      send: (item) => this.#send(item),
      online: () => this.#online,
      now: this.#now,
      random: this.#random,
      setTimer: this.#setTimer,
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
    });
    this.engine.subscribe(() => {
      this.#keepBootAnswers();
      this.#emit();
    });
    this.queue.subscribe(() => this.#emit());
    this.#state = this.#build();
  }

  // ---- the hand-off from createApi (OfflineHandler) -----------------------------------------------

  attach(call: LowLevelCall): void {
    this.#call = call;
    this.#api = syncApi(call);
  }

  answered(req: HubRequest, status: number, data: unknown): void {
    this.#markOnline();
    if (status === 401) {
      // Signed out: nothing this page loaded is shown again offline.
      this.cache.clear();
      const s = this.engine.state();
      if (s.granted || this.engine.replica) void this.engine.remove('signed_out');
      return;
    }
    if (req.method !== 'GET' || status < 200 || status >= 300) return;
    const base = req.path.split('?')[0] ?? req.path;
    if (base === SESSION_PATH) this.#sessionSeen(data as SyncSession);
    if (!isCacheable(req.path)) return;
    this.cache.remember(req.path, data);
    const r = this.engine.replica;
    if (r && BOOT_PATHS.includes(req.path))
      void r.cache.put([[req.path, forDisk(req.path, data)]]).catch(() => undefined);
  }

  async unreachable(req: HubRequest, _err: unknown): Promise<{ data: unknown } | null> {
    this.#markOffline();
    if (req.options.offline === false) return null;
    await this.#restore();
    if (req.method === 'GET') {
      const data = answerRead(req, this.cache, this.viewSource());
      if (data === undefined || data === null) return null;
      if ((req.path.split('?')[0] ?? '') === SESSION_PATH && !this.#session)
        this.#setSession(data as SyncSession);
      return { data };
    }
    const ctx = this.#writeContext();
    return ctx ? takeWrite(req, ctx) : null;
  }

  // ---- for the UI ----------------------------------------------------------------------------------

  readonly subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };

  readonly getState = (): OfflineState => this.#state;

  /** Follow the sync events and the browser's connection while the app is open. */
  start(deps: { eventSource: EventSourceFactory }): () => void {
    this.#started += 1;
    const off = subscribeHubEvents(deps.eventSource, [...SYNC_EVENTS, 'device.scopes.changed'], {
      onEvent: (env) => {
        const s = this.#session;
        // The owner granted or took away this device's scopes: the copy follows at once.
        if (env.name === 'device.scopes.changed') {
          const scopes = env.payload.scopes;
          if (s?.deviceId && env.payload.deviceId === s.deviceId && Array.isArray(scopes))
            this.#sessionSeen({ ...s, scopes: scopes.filter((x) => typeof x === 'string') });
          return;
        }
        this.engine.onEvent(env);
      },
      onOpen: () => this.#markOnline(),
    });
    const onOnline = () => void this.checkNow();
    const onOffline = () => this.#markOffline();
    if (this.#windowEvents) {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }
    void this.#boot();
    return () => {
      this.#started -= 1;
      off();
      if (this.#windowEvents) {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    };
  }

  /** Ask the Hub now instead of waiting for the next check. */
  async checkNow(): Promise<boolean> {
    if (this.#checking || !this.#call) return this.#online;
    this.#cancelProbe?.();
    this.#cancelProbe = null;
    this.#nextCheckAt = null;
    this.#checking = true;
    this.#emit();
    try {
      await this.#call('GET', `${V1}/hello`, undefined, { offline: false });
    } catch {
      // Still away, or it answered with an error (which counts as reachable).
    } finally {
      this.#checking = false;
    }
    if (!this.#online) {
      this.#probeAttempt += 1;
      this.#scheduleProbe();
    }
    this.#emit();
    return this.#online;
  }

  /** Resolves once a catch-up with the Hub and the sending after it are over. */
  async idle(): Promise<void> {
    await this.#reconnecting;
    await this.queue.idle();
  }

  /** The copy with this device's waiting changes, as views read it; null without a copy. */
  viewSource(): ViewSource | null {
    const replica = this.engine.replica;
    if (!replica) return null;
    return { replica, pending: this.queue.pending(), hints: this.cache.hints() };
  }

  /** Keep an answer this computer's model wrote while the Hub was away (FR-128). */
  async addAnswer(input: {
    threadId: string;
    parentId: string | null;
    text: string;
    model: string;
  }): Promise<QueueItem> {
    const deviceId = this.engine.deviceId;
    const src = this.viewSource();
    const hlc = this.engine.tick();
    if (!deviceId || !src || !hlc) throw new Error(RUNTIME_TEXT.noCopy);
    const id = uuidv7();
    const op: SyncOp = {
      kind: 'message',
      id,
      field: 'body',
      value: {
        threadId: input.threadId,
        role: 'assistant',
        text: input.text,
        parentId: input.parentId,
        model: input.model,
        provenance: 'offline',
      },
      hlc,
      base: null,
    };
    const item = await this.queue.add({
      kind: 'answer',
      subject: { action: 'answer', name: threadView(src, input.threadId)?.title?.trim() || null },
      threadId: input.threadId,
      entityId: id,
      text: input.text,
      model: input.model,
      deviceId,
      ops: [op],
    });
    if (this.#online) void this.queue.drain();
    return item;
  }

  // ---- internals ----------------------------------------------------------------------------------

  /** The app's start-up answers go into a copy once it holds a load (they came before it). */
  #keepBootAnswers(): void {
    const r = this.engine.replica;
    if (!r || r === this.#bootKeptFor) return;
    this.#bootKeptFor = r;
    const entries = BOOT_PATHS.filter((p) => this.cache.has(p)).map(
      (p) => [p, forDisk(p, this.cache.get(p))] as const,
    );
    void r.cache.put(entries).catch(() => undefined);
  }

  #sync(): SyncApi {
    if (!this.#api) throw new Error('the offline layer is not attached to the Hub client');
    return this.#api;
  }

  #setSession(s: SyncSession): void {
    this.#session = s;
    this.#emit();
  }

  #sessionSeen(s: SyncSession): void {
    const before = scopesKey(this.#session);
    this.#setSession(s);
    if (this.#started > 0 && before !== scopesKey(s)) void this.engine.start(s, this.#online);
  }

  /** Once: open the copy and the queue kept on this device (for a start without the Hub). */
  #restore(): Promise<void> {
    this.#restoring ??= (async () => {
      await Promise.all([this.engine.restore(), this.queue.load()]);
      for (const i of this.queue.items()) for (const op of i.ops) this.engine.receive(op.hlc);
      const r = this.engine.replica;
      if (!r) return;
      for (const p of BOOT_PATHS) {
        if (this.cache.has(p)) continue;
        const v = await r.cache.get(p);
        if (v !== undefined) this.cache.remember(p, v);
      }
    })().catch(() => undefined);
    return this.#restoring;
  }

  async #boot(): Promise<void> {
    await this.#restore();
    let session = this.#session;
    if (!session) {
      try {
        session = await this.#sync().syncSession();
      } catch {
        return;
      }
    }
    this.#setSession(session);
    await this.engine.start(session, this.#online);
    if (this.#online) await this.queue.drain();
  }

  #writeContext(): WriteContext | null {
    const replica = this.engine.replica;
    const deviceId = this.engine.deviceId;
    const source = this.viewSource();
    if (!replica || !deviceId || !source) return null;
    return {
      source,
      replica,
      deviceId,
      queue: this.queue,
      tick: () => {
        const v = this.engine.tick();
        if (!v) throw new Error(RUNTIME_TEXT.noCopy);
        return v;
      },
    };
  }

  #markOffline(): void {
    if (!this.#online) return;
    this.#online = false;
    this.#since = new Date(this.#now()).toISOString();
    this.#probeAttempt = 0;
    this.#scheduleProbe();
    this.#emit();
  }

  #markOnline(): void {
    if (this.#online) return;
    this.#online = true;
    this.#since = null;
    this.#probeAttempt = 0;
    this.#nextCheckAt = null;
    this.#cancelProbe?.();
    this.#cancelProbe = null;
    this.#emit();
    void this.#reconnect();
  }

  #scheduleProbe(): void {
    if (this.#online || this.#cancelProbe || !this.#call) return;
    const delay = backoffMs(this.#probeAttempt + 1, this.#random(), this.#probe);
    this.#nextCheckAt = new Date(this.#now() + delay).toISOString();
    this.#cancelProbe = this.#setTimer(() => {
      this.#cancelProbe = null;
      void this.checkNow();
    }, delay);
  }

  /** The Hub is back: the copy catches up first, then what waits goes out (docs/13 §2.3). */
  #reconnect(): Promise<void> {
    // Back again while the last catch-up still runs: it goes round once more.
    if (this.#reconnecting) {
      this.#reconnectAgain = true;
      return this.#reconnecting;
    }
    this.#reconnecting = (async () => {
      try {
        do {
          this.#reconnectAgain = false;
          try {
            if (this.#started > 0) {
              const s = await this.#sync().syncSession({ offline: false });
              this.#setSession(s);
              await this.engine.start(s, true);
            }
            await this.queue.drain();
          } catch {
            // It went away again; the next check tries once more.
          }
        } while (this.#reconnectAgain && this.#online);
      } finally {
        this.#reconnecting = null;
      }
    })();
    return this.#reconnecting;
  }

  async #send(item: QueueItem): Promise<SendOutcome> {
    const st = this.engine.state();
    const deviceId = this.engine.deviceId;
    if (!deviceId || !this.engine.replica) {
      if (st.phase === 'loading') return { kind: 'later', problem: 'loading' };
      return { kind: 'failed', code: 'no_replica', problem: 'no_replica' };
    }
    if (st.phase === 'paused')
      return { kind: 'failed', code: 'sync_disabled', problem: 'sync_disabled' };
    let ready = item;
    // Clocked for another device, or refused for its clock: stamp it again, with a new key.
    if (
      item.deviceId !== deviceId ||
      item.errorCode === 'clock_skew' ||
      item.errorCode === 'hlc_device_mismatch'
    ) {
      const ops = item.ops.map((op) => ({ ...op, hlc: this.engine.tick() ?? op.hlc }));
      ready = { ...item, ops, deviceId, idempotencyKey: `nova-q-${uuidv7()}` };
      await this.queue.revise(item.id, {
        ops,
        deviceId,
        idempotencyKey: ready.idempotencyKey,
      });
    }
    try {
      const res = await this.engine.push(ready.ops, ready.idempotencyKey);
      // The copy takes the Hub's result before the change leaves the queue.
      await this.engine.pull().catch(() => undefined);
      const refused = res.results.find((r) => r.status === 'rejected');
      if (refused)
        return { kind: 'failed', code: refused.reason ?? 'rejected', problem: 'rejected' };
      const lost = res.results.some((r) => r.status === 'overwritten');
      let note: QueueNote | null = lost ? 'overwritten' : null;
      if (item.kind === 'message' && item.threadId) {
        const asked = await this.#askForAnswer(ready, item.threadId);
        if (typeof asked !== 'string' && asked !== null) return asked;
        note = asked ?? note;
      }
      return { kind: 'done', note };
    } catch (err) {
      if (!(err instanceof ApiError)) return { kind: 'unreachable' };
      const reason = err.body.details?.reason;
      if (err.status === 401) return { kind: 'failed', code: 'signed_out', problem: 'signed_out' };
      if (err.status === 403 && reason === 'replica_not_granted')
        return { kind: 'failed', code: 'no_replica', problem: 'no_replica' };
      if (err.status === 403 && reason === 'sync_disabled')
        return { kind: 'failed', code: 'sync_disabled', problem: 'sync_disabled' };
      if (err.status === 409 && reason === 'idempotency_in_flight')
        return { kind: 'later', problem: 'in_flight' };
      // The Hub's own words when it gave some (English, D9), else this app's by code.
      const said = err.body.message || null;
      if (err.status === 429 || err.status >= 500)
        return { kind: 'later', problem: said ? null : 'not_yet', error: said };
      return {
        kind: 'failed',
        code: err.body.code,
        problem: said ? null : 'rejected',
        error: said,
      };
    }
  }

  /**
   * A message written offline reaches the Hub as history; the Hub is then asked to answer it
   * (`…/messages/:mid/answer`), once, with its own key so a resend is answered once. Not when a
   * later message of the same chat waits (that one is answered, with this one in view), nor when
   * this computer's model already answered it. A note says how it went.
   */
  async #askForAnswer(item: QueueItem, threadId: string): Promise<SendOutcome | QueueNote | null> {
    const items = this.queue.items();
    const after = items.slice(items.findIndex((i) => i.id === item.id) + 1);
    if (after.some((i) => i.status !== 'done' && i.kind === 'message' && i.threadId === threadId))
      return null;
    if (items.some((i) => i.kind === 'answer' && answerParent(i) === item.entityId)) return null;
    try {
      await this.#sync().answerMessage(threadId, item.entityId, `${item.idempotencyKey}-answer`);
      return 'requested';
    } catch (err) {
      if (!(err instanceof ApiError)) return { kind: 'unreachable' };
      if (err.status === 429 || err.status >= 500)
        return { kind: 'later', problem: 'answer_not_yet' };
      const reason = err.body.details?.reason;
      return isNote(reason) && reason !== 'overwritten' && reason !== 'requested'
        ? reason
        : 'answer_failed';
    }
  }

  #build(): OfflineState {
    return {
      hub: this.#online ? 'online' : 'offline',
      since: this.#since,
      nextCheckAt: this.#nextCheckAt,
      checking: this.#checking,
      replica: this.engine.state(),
      queue: this.queue.items(),
      reads: this.engine.replica ? 'replica' : 'memory',
      scopes: this.#session?.scopes ?? null,
    };
  }

  #emit(): void {
    this.#state = this.#build();
    for (const fn of [...this.#listeners]) fn();
  }
}
