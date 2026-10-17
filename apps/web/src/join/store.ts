// Where the joining device keeps its request while it waits for approval, so a reload can keep
// polling with the same key (docs/22 §4.1). IndexedDB stores the CryptoKey objects themselves
// (the private key stays non-extractable); without IndexedDB, or when it fails, memory is used
// and a reload starts over. Nothing secret is written anywhere else.

export interface JoinRecord {
  pairingId: string;
  requestId: string;
  confirmation: string;
  /** When the Hub stops waiting for the approval. */
  expiresAt: string;
  name: string;
  keys: CryptoKeyPair;
  /** The last status poll's time (Unix seconds); the next one must be later. */
  lastTime: number;
}

export interface JoinStore {
  load(): Promise<JoinRecord | null>;
  save(record: JoinRecord): Promise<void>;
  clear(): Promise<void>;
}

export function memoryJoinStore(initial: JoinRecord | null = null): JoinStore {
  let record = initial;
  return {
    load: () => Promise.resolve(record),
    save: (r) => {
      record = r;
      return Promise.resolve();
    },
    clear: () => {
      record = null;
      return Promise.resolve();
    },
  };
}

const DB = 'nova-add-device';
const STORE = 'request';
const KEY = 'current';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function open(idb: IDBFactory): Promise<IDBDatabase> {
  const r = idb.open(DB, 1);
  r.onupgradeneeded = () => {
    if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
  };
  return req(r);
}

async function withStore<T>(
  idb: IDBFactory,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open(idb);
  try {
    return await req(fn(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

function isRecord(v: unknown): v is JoinRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<JoinRecord>;
  return (
    typeof r.pairingId === 'string' &&
    typeof r.requestId === 'string' &&
    typeof r.confirmation === 'string' &&
    typeof r.expiresAt === 'string' &&
    typeof r.name === 'string' &&
    typeof r.lastTime === 'number' &&
    typeof r.keys === 'object' &&
    r.keys !== null
  );
}

/** IndexedDB when it works, memory otherwise (private windows, blocked storage, tests). */
export function browserJoinStore(idb: IDBFactory | undefined = globalThis.indexedDB): JoinStore {
  const memory = memoryJoinStore();
  if (!idb) return memory;
  let broken = false;
  const attempt = async <T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    if (broken) return fallback();
    try {
      return await fn();
    } catch {
      broken = true;
      return fallback();
    }
  };
  return {
    load: () =>
      attempt(
        async () => {
          const v = await withStore<unknown>(idb, 'readonly', (s) => s.get(KEY));
          return isRecord(v) ? v : null;
        },
        () => memory.load(),
      ),
    save: (r) =>
      attempt(
        async () => {
          await memory.save(r);
          await withStore(idb, 'readwrite', (s) => s.put(r, KEY));
        },
        () => memory.save(r),
      ),
    clear: () =>
      attempt(
        async () => {
          await memory.clear();
          await withStore(idb, 'readwrite', (s) => s.delete(KEY));
        },
        () => memory.clear(),
      ),
  };
}

/** The device id this browser was added as, so its own device page can say so. */
export const THIS_DEVICE_KEY = 'nova.device.id';

export function rememberThisDevice(deviceId: string): void {
  try {
    window.localStorage.setItem(THIS_DEVICE_KEY, deviceId);
  } catch {
    // storage unavailable: the device page just cannot tell
  }
}

export function thisDeviceId(): string | null {
  try {
    return window.localStorage.getItem(THIS_DEVICE_KEY);
  } catch {
    return null;
  }
}

/** Full-page navigation (the session cookie changes); tests replace `assign`. */
export const pageNav = {
  assign: (path: string): void => {
    window.location.assign(path);
  },
};
