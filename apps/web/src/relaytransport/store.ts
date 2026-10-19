// Where this browser keeps its Relay pairing (FR-137 client, docs/22 §3.1): the paired client
// record (routing ids, route token, session keys), the device session the Hub granted through the
// tunnel, and a join that is still waiting for the owner. Everything is kept in IndexedDB and
// encrypted at rest with AES-GCM under a key that cannot be exported (WebCrypto keeps it; IndexedDB
// stores the CryptoKey object itself). The device's Ed25519 key is stored the same way, as a
// non-extractable CryptoKey. The session keys are raw bytes the cipher needs, so they cannot be
// non-extractable: they are sealed instead. Without IndexedDB (private windows, blocked storage,
// tests) memory is used and a reload forgets the pairing. Wiping the wrapping key wipes the rest.
import type { EndpointCandidate } from '@nova/shared';
import type { PairedClient } from '@nova/relay';

/** A small key-value store: IndexedDB in browsers, memory otherwise. */
export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKv(): KeyValue & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: (k) => Promise.resolve(entries.get(k)),
    set: (k, v) => {
      entries.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      entries.delete(k);
      return Promise.resolve();
    },
  };
}

const DB = 'nova-relay';
const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB (one database, one object store); any failure falls back to memory for good. */
export function indexedDbKv(idb: IDBFactory | undefined = globalThis.indexedDB): KeyValue {
  const memory = memoryKv();
  if (!idb) return memory;
  let broken = false;
  const open = (): Promise<IDBDatabase> => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    return req(r);
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
    fallback: () => Promise<T>,
  ): Promise<T> => {
    if (broken) return fallback();
    try {
      const db = await open();
      try {
        return await req(fn(db.transaction(STORE, mode).objectStore(STORE)));
      } finally {
        db.close();
      }
    } catch {
      broken = true;
      return fallback();
    }
  };
  return {
    get: (k) =>
      run<unknown>(
        'readonly',
        (s) => s.get(k),
        () => memory.get(k),
      ),
    set: async (k, v) => {
      await memory.set(k, v);
      await run(
        'readwrite',
        (s) => s.put(v, k),
        () => Promise.resolve(k),
      );
    },
    delete: async (k) => {
      await memory.delete(k);
      await run(
        'readwrite',
        (s) => s.delete(k),
        () => Promise.resolve(undefined),
      );
    },
  };
}

// ---- sealing ------------------------------------------------------------------------------------

interface Sealed {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  data: Uint8Array<ArrayBuffer>;
}

/** By tag, not `instanceof`: a value read back from storage may come from another realm. */
function isBytes(v: unknown): v is Uint8Array<ArrayBuffer> {
  return Object.prototype.toString.call(v) === '[object Uint8Array]';
}

function isSealed(v: unknown): v is Sealed {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<Sealed>;
  return s.v === 1 && isBytes(s.iv) && isBytes(s.data);
}

function isCryptoKey(v: unknown): v is CryptoKey {
  return Object.prototype.toString.call(v) === '[object CryptoKey]';
}

const WRAP_KEY = 'wrap-key';

/** Encrypts JSON values at rest under a non-extractable AES-GCM key kept in the same store. */
export class SealedStore {
  readonly #kv: KeyValue;
  #key: Promise<CryptoKey> | null = null;

  constructor(kv: KeyValue) {
    this.#kv = kv;
  }

  #wrapKey(): Promise<CryptoKey> {
    this.#key ??= (async () => {
      const existing = await this.#kv.get(WRAP_KEY);
      if (isCryptoKey(existing)) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await this.#kv.set(WRAP_KEY, key);
      return key;
    })().catch((err: unknown) => {
      this.#key = null;
      throw err;
    });
    return this.#key;
  }

  async put(name: string, value: unknown): Promise<void> {
    const key = await this.#wrapKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(value));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const sealed: Sealed = { v: 1, iv, data };
    await this.#kv.set(name, sealed);
  }

  /** The value, or null when absent or when it no longer opens (a wiped key). */
  async get(name: string): Promise<unknown> {
    const sealed = await this.#kv.get(name);
    if (!isSealed(sealed)) return null;
    try {
      const key = await this.#wrapKey();
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.iv },
        key,
        sealed.data,
      );
      return JSON.parse(new TextDecoder().decode(plain)) as unknown;
    } catch {
      return null;
    }
  }

  delete(name: string): Promise<void> {
    return this.#kv.delete(name);
  }

  /** CryptoKey objects are stored as they are (non-extractable keys stay inside WebCrypto). */
  putKeys(name: string, keys: CryptoKeyPair): Promise<void> {
    return this.#kv.set(name, keys);
  }

  async getKeys(name: string): Promise<CryptoKeyPair | null> {
    const v = await this.#kv.get(name);
    if (typeof v !== 'object' || v === null) return null;
    const p = v as Partial<CryptoKeyPair>;
    return isCryptoKey(p.privateKey) && isCryptoKey(p.publicKey)
      ? { privateKey: p.privateKey, publicKey: p.publicKey }
      : null;
  }
}

// ---- the pairing record ---------------------------------------------------------------------------

/** This browser's pairing with its Hub through a Relay, once the owner approved it. */
export interface RelayPairing {
  v: 1;
  paired: PairedClient;
  /** The device session the Hub granted through the tunnel (a bearer token). */
  token: string;
  deviceId: string | null;
  /** The Hub identity's fingerprint the pairing checked, when the QR carried one. */
  hubFingerprint: string | null;
  name: string;
  pairedAt: string;
  /** The highest Hub-opened stream counter seen (replay protection across reloads). */
  hubFloor: number;
  /** The Hub's advertised endpoints, as last seen (`POST /api/v1/hello`). */
  endpoints: EndpointCandidate[];
}

/** A Relay join waiting for the owner (kept so a reload keeps waiting). */
export interface PendingRelayJoin {
  v: 1;
  paired: PairedClient;
  addPairingId: string;
  confirmation: string;
  hubFingerprint: string | null;
  name: string;
  /** When this page stops waiting (the Hub's 10 minutes for the owner). */
  expiresAt: string;
}

export interface RelayStore {
  load(): Promise<RelayPairing | null>;
  /** Keep the pairing (and the device key it was made with, when given). */
  save(p: RelayPairing, keys?: CryptoKeyPair): Promise<void>;
  clear(): Promise<void>;
  loadPending(): Promise<{ join: PendingRelayJoin; keys: CryptoKeyPair } | null>;
  savePending(join: PendingRelayJoin, keys: CryptoKeyPair): Promise<void>;
  clearPending(): Promise<void>;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function isPairedClient(v: unknown): v is PairedClient {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<PairedClient>;
  return (
    p.v === 1 &&
    str(p.relayUrl) &&
    str(p.hubRoute) &&
    str(p.clientRoute) &&
    str(p.clientId) &&
    str(p.routeToken) &&
    str(p.sendKey) &&
    str(p.recvKey)
  );
}

function asPairing(v: unknown): RelayPairing | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Partial<RelayPairing>;
  if (r.v !== 1 || !isPairedClient(r.paired) || !str(r.token)) return null;
  return {
    v: 1,
    paired: r.paired,
    token: r.token,
    deviceId: typeof r.deviceId === 'string' ? r.deviceId : null,
    hubFingerprint: typeof r.hubFingerprint === 'string' ? r.hubFingerprint : null,
    name: typeof r.name === 'string' ? r.name : '',
    pairedAt: typeof r.pairedAt === 'string' ? r.pairedAt : new Date(0).toISOString(),
    hubFloor: typeof r.hubFloor === 'number' && Number.isFinite(r.hubFloor) ? r.hubFloor : 0,
    endpoints: Array.isArray(r.endpoints) ? r.endpoints : [],
  };
}

function asPending(v: unknown): PendingRelayJoin | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Partial<PendingRelayJoin>;
  if (
    p.v !== 1 ||
    !isPairedClient(p.paired) ||
    !str(p.addPairingId) ||
    !str(p.confirmation) ||
    !str(p.expiresAt)
  )
    return null;
  return {
    v: 1,
    paired: p.paired,
    addPairingId: p.addPairingId,
    confirmation: p.confirmation,
    hubFingerprint: typeof p.hubFingerprint === 'string' ? p.hubFingerprint : null,
    name: typeof p.name === 'string' ? p.name : '',
    expiresAt: p.expiresAt,
  };
}

const PAIRING = 'pairing';
const PENDING = 'pending';
const PAIRING_KEYS = 'pairing-keys';
const PENDING_KEYS = 'pending-keys';

export function relayStore(kv: KeyValue = indexedDbKv()): RelayStore {
  const box = new SealedStore(kv);
  return {
    load: async () => asPairing(await box.get(PAIRING).catch(() => null)),
    save: async (p, keys) => {
      if (keys) await box.putKeys(PAIRING_KEYS, keys);
      await box.put(PAIRING, p);
    },
    clear: async () => {
      await box.delete(PAIRING);
      await kv.delete(PAIRING_KEYS);
    },
    loadPending: async () => {
      const join = asPending(await box.get(PENDING).catch(() => null));
      const keys = join ? await box.getKeys(PENDING_KEYS).catch(() => null) : null;
      return join && keys ? { join, keys } : null;
    },
    savePending: async (join, keys) => {
      await box.putKeys(PENDING_KEYS, keys);
      await box.put(PENDING, join);
    },
    clearPending: async () => {
      await box.delete(PENDING);
      await kv.delete(PENDING_KEYS);
    },
  };
}
