// How this browser talks to its Hub (FR-137 client, FR-135; docs/22 §2, §3.1, §3.2). A browser
// that is not paired through a Relay uses the page's own origin with its session cookie, exactly as
// before: requests pass straight through. A browser paired through a Relay (the join page's Relay
// path) holds a device session token and the Relay client record; it picks a path with
// `selectEndpoint` (happy eyeballs: the page's origin first, the Relay 300 ms later or as soon as
// the origin fails), sends the token as a bearer header either way, and tunnels requests through
// the Relay (`RelayClient.fetch`) when the origin does not answer. A request that fails for lack
// of a connection is sent again through the Relay when that is safe (a read, or a write carrying
// an Idempotency-Key); otherwise the error goes back to the caller (the offline queue). While on
// the Relay it tries the origin again every minute and when the browser comes back online. The
// event stream follows the path: the browser's EventSource on the cookie path, a fetch reader with
// the token otherwise (src/relaytransport/sse.ts). A Relay that says this device was removed
// (revoked, unauthorized) ends the pairing here too.
import {
  selectEndpoint,
  type EndpointAttempt,
  type EndpointCandidate,
  type NetworkTransport,
  type SelectEndpointOptions,
} from '@nova/shared';
import {
  RelayClient,
  type ConnectionState,
  type PairedClient,
  type RelayPairingDecision,
} from '@nova/relay';
import { browserEventSource, type EventSourceFactory, type EventSourceLike } from '../sse.ts';
import { cleanEndpoints, originCandidate, relayCandidate } from './endpoints.ts';
import { FetchEventSource, type StreamFetch } from './sse.ts';
import { relayStore, type RelayPairing, type RelayStore } from './store.ts';

/** What the transport needs of a Relay client (`RelayClient`; tests pass a fake). */
export interface RelayLink {
  readonly state: ConnectionState;
  start(): void;
  stop(): void;
  fetch(
    path: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  /** The owner's decision on a pairing that waits: approved, denied or expired (first stands). */
  waitForDecision(): Promise<RelayPairingDecision>;
}

export interface RelayLinkOptions {
  hubStreamFloor?: number;
  onHubFloor?: (floor: number) => void;
  onState?: (state: ConnectionState, detail: string | null) => void;
}

export type RelayConnect = (paired: PairedClient, opts: RelayLinkOptions) => RelayLink;

export const connectRelay: RelayConnect = (paired, opts) => new RelayClient({ paired, ...opts });

export interface HubPath {
  /** `origin`: the address the app was loaded from; `relay`: the tunnel. */
  via: 'origin' | 'relay';
  transport: NetworkTransport;
  url: string;
  latencyMs: number | null;
  /** When this path was chosen (ms). */
  since: number;
}

export interface TransportSnapshot {
  path: HubPath | null;
  /** This browser is paired through a Relay. */
  paired: boolean;
  relayState: ConnectionState | null;
  checking: boolean;
  /** Nothing answered at the last check. */
  unreachable: boolean;
  /** The Relay said this device was removed; the pairing is gone. */
  revoked: boolean;
  attempts: EndpointAttempt[];
  /** The Hub's advertised endpoints, as last seen. */
  advertised: EndpointCandidate[];
}

export interface TransportOptions {
  /** The direct fetch (default: the browser's, looked up at call time). */
  fetch?: typeof fetch;
  /** The page's origin (default: `window.location.origin`). */
  origin?: string;
  store?: RelayStore;
  connect?: RelayConnect;
  /** The browser's EventSource for the cookie path. */
  eventSource?: EventSourceFactory;
  select?: SelectEndpointOptions;
  /** While on the Relay, how often to try the origin again (default 60 s). */
  recheckMs?: number;
  now?: () => number;
  /** Where `online` events come from (default: `window`); null turns them off. */
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

const ENDPOINTS_KEY = 'nova.hub.endpoints';

/** A failure to reach the server at all (not an HTTP status, not an abort). */
export function isNetworkError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return false;
  return err instanceof TypeError && err.name !== 'AbortError';
}

export function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Safe to send again: a read, or a write the Hub answers once per Idempotency-Key. */
export function retrySafe(method: string, headers: Record<string, string>): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || 'idempotency-key' in headers;
}

function readEndpointsCache(): EndpointCandidate[] {
  try {
    return cleanEndpoints(JSON.parse(window.localStorage.getItem(ENDPOINTS_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function writeEndpointsCache(list: EndpointCandidate[]): void {
  try {
    window.localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the next answer is used instead
  }
}

async function isHub(res: Response, fingerprint: string | null): Promise<string | null> {
  if (!res.ok) return `answered ${res.status}`;
  const body = (await res.json().catch(() => null)) as {
    name?: unknown;
    hubFingerprint?: unknown;
  } | null;
  if (body?.name !== 'nova-hub') return 'not a Nova Hub';
  if (fingerprint && typeof body.hubFingerprint === 'string' && body.hubFingerprint !== fingerprint)
    return 'a different Hub';
  return null;
}

export class HubTransport {
  readonly #o: TransportOptions;
  #store: RelayStore | null = null;
  #ready: Promise<void> | null = null;
  #pairing: RelayPairing | null = null;
  #link: RelayLink | null = null;
  #relayState: ConnectionState | null = null;
  #path: HubPath | null = null;
  #selecting: Promise<HubPath | null> | null = null;
  #attempts: EndpointAttempt[] = [];
  #unreachable = false;
  #revoked = false;
  #advertised: EndpointCandidate[] | null = null;
  #recheck: ReturnType<typeof setInterval> | null = null;
  #onlineHooked = false;
  #used = false;
  #refreshed = false;
  readonly #listeners = new Set<() => void>();
  #snapshot: TransportSnapshot | null = null;

  constructor(opts: TransportOptions = {}) {
    this.#o = opts;
  }

  // ---- state for the UI ----------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };

  getSnapshot = (): TransportSnapshot => {
    this.#snapshot ??= {
      path: this.#path,
      paired: this.#pairing !== null,
      relayState: this.#relayState,
      checking: this.#selecting !== null,
      unreachable: this.#unreachable,
      revoked: this.#revoked,
      attempts: this.#attempts,
      advertised: this.#advertised ?? [],
    };
    return this.#snapshot;
  };

  #emit(): void {
    this.#snapshot = null;
    for (const fn of [...this.#listeners]) fn();
  }

  // ---- setup -----------------------------------------------------------------------------------

  #origin(): string {
    return this.#o.origin ?? window.location.origin;
  }

  #directFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return (this.#o.fetch ?? globalThis.fetch)(input, init);
  }

  #advertisedList(): EndpointCandidate[] {
    this.#advertised ??= this.#pairing?.endpoints.length
      ? this.#pairing.endpoints
      : readEndpointsCache();
    return this.#advertised;
  }

  #originPath(): HubPath {
    const c = originCandidate(this.#origin(), this.#advertisedList());
    return {
      via: 'origin',
      transport: c.transport,
      url: c.url,
      latencyMs: null,
      since: Date.now(),
    };
  }

  #load(): Promise<void> {
    this.#ready ??= (async () => {
      this.#store ??= this.#o.store ?? relayStore();
      this.#pairing = await this.#store.load().catch(() => null);
      if (!this.#pairing) this.#path = this.#originPath();
      this.#emit();
    })();
    return this.#ready;
  }

  /** Read the pairing again (after the join page stored one, or a reset). */
  async reload(): Promise<void> {
    this.#ready = null;
    this.#stopLink();
    this.#path = null;
    this.#advertised = null;
    await this.#load();
  }

  /** Forget the Relay pairing on this browser (the device was removed, or the user asked). */
  async forget(): Promise<void> {
    await this.#load();
    this.#drop();
    await this.#store?.clear().catch(() => undefined);
    this.#emit();
  }

  #drop(): void {
    this.#stopLink();
    this.#pairing = null;
    this.#path = this.#originPath();
    this.#clearRecheck();
  }

  // ---- the Relay link --------------------------------------------------------------------------

  #ensureLink(): RelayLink | null {
    const pairing = this.#pairing;
    if (!pairing) return null;
    if (this.#link) return this.#link;
    const connect = this.#o.connect ?? connectRelay;
    const link = connect(pairing.paired, {
      hubStreamFloor: pairing.hubFloor,
      onHubFloor: (floor) => {
        if (this.#pairing !== pairing) return;
        pairing.hubFloor = floor;
        void this.#store?.save(pairing).catch(() => undefined);
      },
      onState: (state) => {
        if (this.#link !== link) return;
        this.#relayState = state;
        if (state === 'revoked' || state === 'unauthorized') {
          // The Hub removed this device: the pairing is of no use any more.
          this.#revoked = true;
          this.#drop();
          void this.#store?.clear().catch(() => undefined);
          this.#emit();
          return;
        }
        this.#emit();
      },
    });
    this.#link = link;
    this.#relayState = link.state;
    link.start();
    return link;
  }

  #stopLink(): void {
    const link = this.#link;
    this.#link = null;
    this.#relayState = null;
    link?.stop();
  }

  async #viaRelay(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const pairing = this.#pairing;
    const link = this.#ensureLink();
    if (!pairing || !link) throw new TypeError('Failed to fetch: this device is not paired');
    const req = typeof input === 'string' || input instanceof URL ? null : input;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let path = raw;
    if (!raw.startsWith('/')) {
      const u = new URL(raw);
      if (u.origin !== this.#origin())
        throw new TypeError('Failed to fetch: only Hub API calls go through the Relay');
      path = u.pathname + u.search;
    }
    const headers = { ...headerRecord(req?.headers), ...headerRecord(init.headers) };
    delete headers.cookie;
    headers.authorization = `Bearer ${pairing.token}`;
    const method = init.method ?? req?.method ?? 'GET';
    let body: string | Uint8Array | undefined;
    const b = init.body ?? (req && method !== 'GET' && method !== 'HEAD' ? await req.text() : null);
    if (typeof b === 'string') body = b;
    else if (b instanceof URLSearchParams) body = b.toString();
    else if (ArrayBuffer.isView(b)) body = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    else if (b instanceof Blob) body = new Uint8Array(await b.arrayBuffer());
    else if (Object.prototype.toString.call(b) === '[object ArrayBuffer]')
      body = new Uint8Array(b as ArrayBuffer);
    else if (b !== null && b !== undefined)
      throw new TypeError('Failed to fetch: this request cannot go through the Relay');
    const signal = init.signal ?? req?.signal ?? undefined;
    try {
      return await link.fetch(path, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      // Callers treat this like any lost connection ("Cannot reach the Hub").
      throw new TypeError(`Failed to fetch through the Relay: ${detail}`, { cause: err });
    }
  }

  // ---- choosing a path ------------------------------------------------------------------------

  /** Check which way the Hub answers now (one check at a time). */
  select(): Promise<HubPath | null> {
    this.#selecting ??= this.#select().finally(() => {
      this.#selecting = null;
      this.#emit();
    });
    this.#emit();
    return this.#selecting;
  }

  async #select(): Promise<HubPath | null> {
    await this.#load();
    const pairing = this.#pairing;
    if (!pairing) {
      this.#path = this.#originPath();
      return this.#path;
    }
    const advertised = this.#advertisedList();
    const origin = originCandidate(this.#origin(), advertised);
    const relay = relayCandidate(pairing.paired.relayUrl, advertised);
    const fp = pairing.hubFingerprint;
    const probe = async (c: EndpointCandidate, signal: AbortSignal) => {
      if (c === relay) {
        const link = this.#ensureLink();
        if (!link) return { ok: false, detail: 'not paired' };
        const res = await link.fetch('/api/v1/hello', { signal });
        const problem = await isHub(res, fp);
        return { ok: problem === null, detail: problem };
      }
      const res = await this.#directFetch(`${this.#origin()}/api/v1/hello`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      const problem = await isHub(res, fp);
      return { ok: problem === null, detail: problem };
    };
    const sel = await selectEndpoint([origin, relay], probe, this.#o.select);
    if (this.#pairing !== pairing) return this.#path;
    this.#attempts = sel.attempts;
    this.#unreachable = sel.winner === null;
    const w = sel.winner;
    const prev = this.#path;
    if (w) {
      const via = w === relay ? 'relay' : 'origin';
      this.#path = {
        via,
        transport: w.transport,
        url: w.url,
        latencyMs: sel.latencyMs,
        since: prev?.via === via ? prev.since : (this.#o.now ?? Date.now)(),
      };
      if (via === 'relay') this.#startRecheck();
      else {
        this.#clearRecheck();
        this.#stopLink();
      }
      if (prev?.via !== via || !this.#advertised?.length) {
        this.#refreshed = true;
        void this.refreshEndpoints();
      }
    } else if (!prev) {
      this.#path = null;
    }
    this.#hookOnline();
    return this.#path;
  }

  #startRecheck(): void {
    if (this.#recheck) return;
    this.#recheck = setInterval(() => void this.select(), this.#o.recheckMs ?? 60_000);
  }

  #clearRecheck(): void {
    if (this.#recheck) clearInterval(this.#recheck);
    this.#recheck = null;
  }

  #hookOnline(): void {
    if (this.#onlineHooked) return;
    const target = this.#o.events === undefined ? globalThis.window : this.#o.events;
    if (!target) return;
    this.#onlineHooked = true;
    target.addEventListener('online', () => {
      if (this.#pairing) void this.select();
    });
  }

  /** The app's client sends its calls through this transport (src/api.ts). */
  get inUse(): boolean {
    return this.#used;
  }

  /** `refreshEndpoints` once per page load (the path indicator asks for it). */
  refreshEndpointsOnce(): void {
    if (this.#refreshed) return;
    this.#refreshed = true;
    void this.refreshEndpoints();
  }

  /** Learn the Hub's advertised endpoints (`POST /api/v1/hello`, with the session). */
  async refreshEndpoints(): Promise<void> {
    try {
      const res = await this.fetch('/api/v1/hello', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { endpoints?: unknown } | null;
      const list = cleanEndpoints(body?.endpoints);
      this.#advertised = list;
      writeEndpointsCache(list);
      const pairing = this.#pairing;
      if (pairing) {
        pairing.endpoints = list;
        await this.#store?.save(pairing).catch(() => undefined);
      }
      if (this.#path?.via === 'origin') {
        const c = originCandidate(this.#origin(), list);
        this.#path = { ...this.#path, transport: c.transport };
      }
      this.#emit();
    } catch {
      // the path indicator keeps its guess
    }
  }

  // ---- requests --------------------------------------------------------------------------------

  /** `fetch` for the Hub API: the cookie path, or the paired path with its fallback. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.#used = true;
    await this.#load();
    if (!this.#pairing) return this.#directFetch(input, init);
    const path = this.#path ?? (await this.select());
    if (path?.via === 'relay') return this.#viaRelay(input, init);
    const headers = {
      ...headerRecord(input instanceof Request ? input.headers : undefined),
      ...headerRecord(init?.headers),
      authorization: `Bearer ${this.#pairing.token}`,
    };
    try {
      return await this.#directFetch(input, { ...init, headers });
    } catch (err) {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      if (!isNetworkError(err, signal)) throw err;
      const next = await this.select();
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (next?.via === 'relay' && retrySafe(method, headers)) return this.#viaRelay(input, init);
      throw err;
    }
  };

  /** The event-stream factory that follows the path (`EventSourceFactory` of src/sse.ts). */
  eventSource: EventSourceFactory = (url) => new PathEventSource(this, url);

  /** For PathEventSource: how a stream opens now, and a way to open it. */
  async streamRoute(): Promise<
    | { kind: 'native' }
    | { kind: 'direct' | 'relay'; open: StreamFetch; headers: Record<string, string> }
  > {
    await this.#load();
    const pairing = this.#pairing;
    if (!pairing) return { kind: 'native' };
    const path = this.#path ?? (await this.select());
    if (path?.via === 'relay')
      return { kind: 'relay', open: (p, init) => this.#viaRelay(p, init), headers: {} };
    return {
      kind: 'direct',
      open: (p, init) => this.#directFetch(p, init),
      headers: { authorization: `Bearer ${pairing.token}` },
    };
  }

  /** A stream failed: check the path again when this browser is paired. */
  streamFailed(): void {
    if (this.#pairing && !this.#selecting) void this.select();
  }

  nativeEventSource(url: string): EventSourceLike {
    return (this.#o.eventSource ?? browserEventSource)(url);
  }
}

const CLOSED = 2;

/**
 * An EventSource that opens on the transport's current path and, when the path changes, reports
 * itself closed so src/sse.ts reopens it (with `?after=<last id>`) on the new one.
 */
class PathEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null = null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null = null;
  readonly #t: HubTransport;
  readonly #listeners: [string, (ev: MessageEvent<string>) => void][] = [];
  #inner: EventSourceLike | null = null;
  #kind: 'native' | 'direct' | 'relay' | null = null;
  #closed = false;
  #unsubscribe: (() => void) | null = null;

  constructor(t: HubTransport, url: string) {
    this.#t = t;
    void t.streamRoute().then(
      (route) => {
        if (this.#closed) return;
        this.#kind = route.kind;
        this.#inner =
          route.kind === 'native'
            ? t.nativeEventSource(url)
            : new FetchEventSource(route.open, url, route.headers);
        const inner = this.#inner;
        inner.onopen = (ev) => {
          this.readyState = inner.readyState;
          this.onopen?.call(this, ev);
        };
        inner.onerror = (ev) => {
          this.readyState = inner.readyState;
          t.streamFailed();
          this.onerror?.call(this, ev);
        };
        for (const [type, fn] of this.#listeners) inner.addEventListener(type, fn);
        this.#unsubscribe = t.subscribe(() => this.#check());
      },
      () => this.#fail(),
    );
  }

  #check(): void {
    const path = this.#t.getSnapshot();
    const want = !path.paired ? 'native' : path.path?.via === 'relay' ? 'relay' : 'direct';
    if (this.#kind && want !== this.#kind && !path.checking) this.#fail();
  }

  #fail(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#inner?.close();
    this.readyState = CLOSED;
    this.onerror?.call(this, new Event('error'));
  }

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.#listeners.push([type, listener]);
    this.#inner?.addEventListener(type, listener);
  }

  close(): void {
    this.#closed = true;
    this.readyState = CLOSED;
    this.#unsubscribe?.();
    this.#inner?.close();
  }
}

/** The app's one transport (src/api.ts sends every Hub call through it). */
export const hubTransport = new HubTransport();

/** `fetch` through the app's transport. */
export const hubFetch: typeof fetch = (input, init) => hubTransport.fetch(input, init);
