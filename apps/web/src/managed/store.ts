// The managed policy view, read once per Hub client and shared by every view that names where a
// lock comes from (the settings banner, each "Managed by your organization" note, the Managed
// policy page). The page and the banner follow `managed.policy.changed` and call `refresh`; the
// notes only read. A client without the managed calls (an older Hub, or a test double without
// them) reads as "nothing known", and a refusal (a member on a Hub that keeps the view for its
// owner) is kept as the error.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ManagedPolicyView } from '@nova/shared';
import type { ManagedApi } from './api-m8.ts';

export interface ManagedSnapshot {
  view: ManagedPolicyView | null;
  error: unknown;
  loading: boolean;
  /** The client has the managed calls. */
  supported: boolean;
}

type Client = Partial<Pick<ManagedApi, 'getManagedPolicy'>>;

class ManagedStore {
  #snap: ManagedSnapshot;
  readonly #subs = new Set<() => void>();
  readonly #client: Client;
  #inflight: Promise<void> | null = null;
  #again = false;

  constructor(client: Client) {
    this.#client = client;
    this.#snap = {
      view: null,
      error: null,
      loading: false,
      supported: typeof client.getManagedPolicy === 'function',
    };
  }

  snapshot = (): ManagedSnapshot => this.#snap;

  subscribe = (fn: () => void): (() => void) => {
    this.#subs.add(fn);
    return () => {
      this.#subs.delete(fn);
    };
  };

  #set(next: Partial<ManagedSnapshot>): void {
    this.#snap = { ...this.#snap, ...next };
    for (const fn of [...this.#subs]) fn();
  }

  /** Load once (the first view that asks). */
  ensure(): void {
    if (!this.#snap.supported || this.#snap.view || this.#snap.error || this.#inflight) return;
    void this.refresh();
  }

  /** Read the view again; a refresh while one runs asks for one more. */
  refresh(): Promise<void> {
    const get = this.#client.getManagedPolicy;
    if (typeof get !== 'function') return Promise.resolve();
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#set({ loading: true });
    this.#inflight = (async () => {
      do {
        this.#again = false;
        try {
          const view = await get();
          this.#set({ view, error: null });
        } catch (error) {
          this.#set({ error });
        }
      } while (this.#again);
      this.#inflight = null;
      this.#set({ loading: false });
    })();
    return this.#inflight;
  }

  /** A view the Hub just answered (the owner's reload). */
  put(view: ManagedPolicyView): void {
    this.#set({ view, error: null });
  }
}

const stores = new WeakMap<object, ManagedStore>();

function storeFor(api: object): ManagedStore {
  let s = stores.get(api);
  if (!s) {
    s = new ManagedStore(api);
    stores.set(api, s);
  }
  return s;
}

export interface ManagedViewState extends ManagedSnapshot {
  refresh: () => Promise<void>;
  put: (view: ManagedPolicyView) => void;
}

/** The managed policy view of this Hub client, loaded on first use (`api` from useServices). */
export function useManagedView(api: object): ManagedViewState {
  const store = storeFor(api);
  const snap = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => store.ensure(), [store]);
  const refresh = useCallback(() => store.refresh(), [store]);
  const put = useCallback((v: ManagedPolicyView) => store.put(v), [store]);
  return { ...snap, refresh, put };
}
