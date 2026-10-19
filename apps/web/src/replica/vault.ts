// Encrypted storage on this device (FR-129, ADR-036, docs/13 §2.1): the offline copy, the copies
// of a few Hub answers it needs to start offline, and the queue of changes waiting to send, kept in
// IndexedDB. Every record is sealed with AES-GCM (WebCrypto) under a key that is generated here as
// non-extractable and kept in IndexedDB too, so its bytes never reach script or disk in the
// clear. Each record's name is bound into its seal, so sealed records cannot be swapped. When a
// key is gone its records cannot be opened and are wiped; wiping a key wipes what it sealed.

export const KV_STORES = ['keys', 'replica', 'meta', 'cache', 'queue'] as const;
export type KvStoreName = (typeof KV_STORES)[number];

/** A small key-value store per object store; IndexedDB in the app, memory in tests. */
export interface KvBackend {
  get(store: KvStoreName, key: string): Promise<unknown>;
  put(store: KvStoreName, entries: readonly (readonly [string, unknown])[]): Promise<void>;
  delete(store: KvStoreName, keys: readonly string[]): Promise<void>;
  entries(store: KvStoreName): Promise<[string, unknown][]>;
  clear(store: KvStoreName): Promise<void>;
}

/** WebCrypto is there (it needs a secure context: HTTPS or this computer). */
export function cryptoAvailable(): boolean {
  return 'crypto' in globalThis && 'subtle' in globalThis.crypto;
}

const DB_NAME = 'nova-offline';

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** IndexedDB, or null where the browser offers none (or none with WebCrypto). */
export function indexedDbBackend(name = DB_NAME): KvBackend | null {
  if (!('indexedDB' in globalThis) || !cryptoAvailable()) return null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = globalThis.indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        for (const s of KV_STORES)
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB did not open'));
      req.onblocked = () => reject(new Error('IndexedDB is in use by an older version of Nova'));
    }).catch((err: unknown) => {
      opening = null;
      throw err;
    });
    return opening;
  };
  const write = async (store: KvStoreName, fn: (s: IDBObjectStore) => void): Promise<void> => {
    const tx = (await open()).transaction(store, 'readwrite');
    const ended = finished(tx);
    fn(tx.objectStore(store));
    await ended;
  };
  return {
    async get(store, key) {
      const tx = (await open()).transaction(store, 'readonly');
      return done(tx.objectStore(store).get(key) as IDBRequest<unknown>);
    },
    put: (store, entries) =>
      write(store, (s) => {
        for (const [k, v] of entries) s.put(v, k);
      }),
    delete: (store, keys) =>
      write(store, (s) => {
        for (const k of keys) s.delete(k);
      }),
    async entries(store) {
      const s = (await open()).transaction(store, 'readonly').objectStore(store);
      const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
      return keys.map(
        (k, i) => [typeof k === 'string' ? k : JSON.stringify(k), values[i]] as [string, unknown],
      );
    },
    clear: (store) =>
      write(store, (s) => {
        s.clear();
      }),
  };
}

/** A record as it is stored: never plaintext. */
export interface Sealed {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function isKey(v: unknown): v is CryptoKey {
  return typeof v === 'object' && v !== null && 'algorithm' in v && 'usages' in v && 'type' in v;
}

function isSealed(v: unknown): v is Sealed {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<Sealed>;
  return s.v === 1 && s.iv !== undefined && s.data !== undefined;
}

export type VaultName = 'replica' | 'queue';

export class Vault {
  readonly #key: CryptoKey;

  private constructor(key: CryptoKey) {
    this.#key = key;
  }

  /** The named key, or null when there is none. */
  static async load(kv: KvBackend, name: VaultName): Promise<Vault | null> {
    const found = await kv.get('keys', name);
    return isKey(found) ? new Vault(found) : null;
  }

  /** A new key, generated here as non-extractable, in place of any old one. */
  static async create(kv: KvBackend, name: VaultName): Promise<Vault> {
    const key = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await kv.put('keys', [[name, key]]);
    return new Vault(key);
  }

  async seal(record: string, value: unknown): Promise<Sealed> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(record) },
      this.#key,
      utf8(JSON.stringify(value)),
    );
    return { v: 1, iv, data };
  }

  /** The value, or a rejection when the record was not sealed by this key under this name. */
  async unseal(record: string, sealed: unknown): Promise<unknown> {
    if (!isSealed(sealed)) throw new Error('not a sealed record');
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData: utf8(record) },
      this.#key,
      sealed.data,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  }
}

/** One object store of sealed records; it counts their stored size. */
export class SealedStore {
  readonly #kv: KvBackend;
  readonly #store: KvStoreName;
  readonly #vault: Vault;
  readonly #sizes = new Map<string, number>();

  constructor(kv: KvBackend, store: KvStoreName, vault: Vault) {
    this.#kv = kv;
    this.#store = store;
    this.#vault = vault;
  }

  #name(key: string): string {
    return `${this.#store}:${key}`;
  }

  async put(entries: readonly (readonly [string, unknown])[]): Promise<void> {
    if (!entries.length) return;
    const sealed = await Promise.all(
      entries.map(async ([k, v]) => [k, await this.#vault.seal(this.#name(k), v)] as const),
    );
    await this.#kv.put(this.#store, sealed);
    for (const [k, s] of sealed) this.#sizes.set(k, s.data.byteLength + s.iv.byteLength);
  }

  async get(key: string): Promise<unknown> {
    const raw = await this.#kv.get(this.#store, key);
    if (raw === undefined) return undefined;
    try {
      return await this.#vault.unseal(this.#name(key), raw);
    } catch {
      return undefined;
    }
  }

  /** Every record that opens; the ones that do not (another key, damage) are removed. */
  async all(): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    const bad: string[] = [];
    for (const [k, raw] of await this.#kv.entries(this.#store)) {
      try {
        out.set(k, await this.#vault.unseal(this.#name(k), raw));
        const s = raw as Sealed;
        this.#sizes.set(k, s.data.byteLength + s.iv.byteLength);
      } catch {
        bad.push(k);
      }
    }
    if (bad.length) await this.#kv.delete(this.#store, bad);
    return out;
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    await this.#kv.delete(this.#store, keys);
    for (const k of keys) this.#sizes.delete(k);
  }

  async clear(): Promise<void> {
    await this.#kv.clear(this.#store);
    this.#sizes.clear();
  }

  /** Bytes stored (sealed), as far as this store has seen them. */
  bytes(): number {
    let n = 0;
    for (const s of this.#sizes.values()) n += s;
    return n;
  }
}
