// This device's offline copy (FR-109, FR-129): the Hub's synced entities as the Hub last said
// they are, one record per entity, each field with its clock and the device that set it, plus the
// copy's own state (cursor, when it last loaded and synced, this device's clock). Everything is
// sealed at rest (vault.ts). The copy mirrors the Hub only: changes made here wait in the outbound
// queue (src/offline/queue.ts) and come back through the change feed once the Hub took them.
import {
  SYNC_TOMBSTONE,
  type SyncChangeView,
  type SyncEntityView,
  type SyncKind,
} from '@nova/shared';
import { SealedStore, Vault, type KvBackend } from './vault.ts';

export interface FieldState {
  value: unknown;
  hlc: string;
  /** The device whose change set it; null for a change made on the Hub. */
  deviceId: string | null;
}

export interface Entity {
  kind: SyncKind;
  id: string;
  fields: Record<string, FieldState>;
}

export interface ReplicaMeta {
  v: 1;
  accountId: string | null;
  deviceId: string;
  /** The change feed's cursor this copy has applied. */
  cursor: number;
  /** When the last full load finished; null while one is under way (it then starts over). */
  loadedAt: string | null;
  lastSyncAt: string | null;
  /** This device's clock, so it never goes back after a restart. */
  clock: string | null;
}

const recordKey = (kind: SyncKind, id: string) => `${kind}:${id}`;

function isEntity(v: unknown): v is Entity {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<Entity>;
  return typeof e.kind === 'string' && typeof e.id === 'string' && typeof e.fields === 'object';
}

function isMeta(v: unknown): v is ReplicaMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<ReplicaMeta>;
  return m.v === 1 && typeof m.deviceId === 'string' && typeof m.cursor === 'number';
}

export class Replica {
  readonly #entities = new Map<string, Entity>();
  readonly #records: SealedStore;
  readonly #metaStore: SealedStore;
  /** Copies of a few Hub answers, so the app can start without the Hub (src/offline/reads.ts). */
  readonly cache: SealedStore;
  #meta: ReplicaMeta | null = null;
  #version = 0;

  private constructor(kv: KvBackend, vault: Vault) {
    this.#records = new SealedStore(kv, 'replica', vault);
    this.#metaStore = new SealedStore(kv, 'meta', vault);
    this.cache = new SealedStore(kv, 'cache', vault);
  }

  /**
   * The copy on this device. Without its key nothing can be opened: whatever is left is wiped and,
   * unless `create` is set, there is no copy (null).
   */
  static async open(kv: KvBackend, create: boolean): Promise<Replica | null> {
    let vault = await Vault.load(kv, 'replica');
    if (!vault) {
      await Replica.wipe(kv);
      if (!create) return null;
      vault = await Vault.create(kv, 'replica');
    }
    const r = new Replica(kv, vault);
    const [records, meta] = await Promise.all([r.#records.all(), r.#metaStore.get('meta')]);
    for (const v of records.values()) if (isEntity(v)) r.#entities.set(recordKey(v.kind, v.id), v);
    r.#meta = isMeta(meta) ? meta : null;
    if (!r.#meta && records.size) await r.clearEntities();
    return r;
  }

  /** Removes the key and everything it sealed: the copy, its state and the saved answers. */
  static async wipe(kv: KvBackend): Promise<void> {
    await kv.delete('keys', ['replica']);
    await Promise.all([kv.clear('replica'), kv.clear('meta'), kv.clear('cache')]);
  }

  get meta(): ReplicaMeta | null {
    return this.#meta;
  }

  /** Bumps on every change, so views built from the copy know to rebuild. */
  get version(): number {
    return this.#version;
  }

  async setMeta(meta: ReplicaMeta): Promise<void> {
    this.#meta = meta;
    await this.#metaStore.put([['meta', meta]]);
  }

  async updateMeta(patch: Partial<ReplicaMeta>): Promise<void> {
    if (!this.#meta) return;
    await this.setMeta({ ...this.#meta, ...patch });
  }

  entity(kind: SyncKind, id: string): Entity | null {
    return this.#entities.get(recordKey(kind, id)) ?? null;
  }

  value(kind: SyncKind, id: string, field: string): unknown {
    return this.entity(kind, id)?.fields[field]?.value;
  }

  list(kind: SyncKind): Entity[] {
    const out: Entity[] = [];
    for (const e of this.#entities.values()) if (e.kind === kind) out.push(e);
    return out;
  }

  counts(): Record<SyncKind, number> {
    const c: Record<SyncKind, number> = {
      thread: 0,
      message: 0,
      project: 0,
      memory: 0,
      space: 0,
      page: 0,
      schedule: 0,
      setting: 0,
    };
    for (const e of this.#entities.values()) c[e.kind] += 1;
    return c;
  }

  /** Bytes the sealed copy takes on this device (records, state and saved answers). */
  bytes(): number {
    return this.#records.bytes() + this.#metaStore.bytes() + this.cache.bytes();
  }

  /** A page of the full load: these entities as they are now. */
  async load(items: readonly SyncEntityView[]): Promise<void> {
    const put: [string, Entity][] = [];
    for (const item of items) {
      const e: Entity = { kind: item.kind, id: item.id, fields: { ...item.fields } };
      this.#entities.set(recordKey(e.kind, e.id), e);
      put.push([recordKey(e.kind, e.id), e]);
    }
    this.#version += 1;
    await this.#records.put(put);
  }

  /** Changes from the feed, oldest first: a field takes the Hub's value; a tombstone removes. */
  async apply(changes: readonly SyncChangeView[]): Promise<void> {
    const touched = new Map<string, Entity | null>();
    for (const c of changes) {
      const k = recordKey(c.kind, c.id);
      if (c.field === SYNC_TOMBSTONE) {
        if (c.value === true) {
          this.#entities.delete(k);
          touched.set(k, null);
        }
        continue;
      }
      const e = this.#entities.get(k) ?? { kind: c.kind, id: c.id, fields: {} };
      e.fields = { ...e.fields, [c.field]: { value: c.value, hlc: c.hlc, deviceId: c.deviceId } };
      this.#entities.set(k, e);
      touched.set(k, e);
    }
    if (!touched.size) return;
    this.#version += 1;
    const put: [string, Entity][] = [];
    const del: string[] = [];
    for (const [k, e] of touched) {
      if (e) put.push([k, e]);
      else del.push(k);
    }
    await this.#records.put(put);
    await this.#records.delete(del);
  }

  /** Empties the copy but keeps its key (a new full load follows). */
  async clearEntities(): Promise<void> {
    this.#entities.clear();
    this.#version += 1;
    await this.#records.clear();
  }
}
