// Fakes for the M7 phone work (FR-111, FR-077, FR-137 client):
// - the fake Hub's push part with the Hub's rules from apps/hub/src/push.ts and
//   packages/core/src/channels/push/service.ts: the account's VAPID key; subscriptions listed without
//   their endpoints; a subscribe checks the shared schema (400 `validation`), https on the
//   `push.webPushHosts` list (400 `validation`, `field: endpoint`), at most 50 (409 `conflict`) and
//   renews an endpoint it knows (same id); removing or testing an unknown id is 404 `not_found`;
//   a test reports each subscription's scripted outcome (`sent` by default, or `failed`, `gone`;
//   a gone one is dropped);
// - a browser PushManager and service worker registration (`fakePushEnv`);
// - a minimal in-memory IndexedDB (`fakeIndexedDb`) for the encrypted Relay store;
// - a Relay link (`FakeRelayLink`, the part of RelayClient the app uses) whose tunnel answers
//   come from a handler, with its connection state and the Hub's `paired` notice under test
//   control.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m7push: M7PushState`, `createHub`
// defaults it to `m7PushState()`, and `impl` spreads `...m7PushImpl(state.m7push, { id, ts: () =>
// ts(), maybeFail, setting: (k) => resolveSetting(k, layers()).value })`. Until then tests use
// `renderWithPush`, which spreads it over `createHub().api`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  createPushSubscriptionSchema,
  resolveSetting,
  type PushSubscriptionView,
  type PushTestView,
  type SettingKey,
  type SettingValue,
} from '@nova/shared';
import type { PairedClient, RelayPairingDecision } from '@nova/relay';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { PushApi } from '../src/push/api.ts';
import type {
  PermissionState,
  PushEnv,
  PushManagerLike,
  PushSubscriptionLike,
} from '../src/push/browser.ts';
import type { RelayPairing } from '../src/relaytransport/store.ts';
import type { RelayConnect, RelayLink, RelayLinkOptions } from '../src/relaytransport/transport.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import type { createHub } from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;
const nid = (p: string) => `${p}${++n}`;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

function bytes(len: number, fill: number): Uint8Array {
  const out = new Uint8Array(len).fill(fill);
  out[0] = 4;
  return out;
}

/** An uncompressed P-256 point's shape (65 bytes), base64url: the Hub's VAPID public key. */
export const VAPID_KEY = b64url(bytes(65, 7));
/** A key the Hub had before (a browser subscription made with it must be renewed). */
export const OLD_VAPID_KEY = b64url(bytes(65, 9));

// ---- the Hub's push part --------------------------------------------------------------------------

export interface FakePushSubscription extends PushSubscriptionView {
  endpoint: string;
}

export interface M7PushState {
  vapidKey: string;
  subscriptions: FakePushSubscription[];
  /** A test push's outcome per subscription id (`sent` when absent). */
  outcomes: Record<string, { status: 'sent' | 'failed' | 'gone'; detail?: string }>;
}

export function m7PushState(init: Partial<M7PushState> = {}): M7PushState {
  return { vapidKey: VAPID_KEY, subscriptions: [], outcomes: {}, ...init };
}

export function subscriptionView(over: Partial<FakePushSubscription> = {}): FakePushSubscription {
  return {
    id: nid('ps'),
    kind: 'webpush',
    endpoint: `https://fcm.googleapis.com/fcm/send/${nid('e')}`,
    endpointOrigin: 'https://fcm.googleapis.com',
    label: 'Chrome on Android',
    deviceId: null,
    status: 'active',
    lastSuccessAt: null,
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const view = (s: FakePushSubscription): PushSubscriptionView => {
  const { endpoint: _endpoint, ...rest } = s;
  return { ...rest };
};

function notFound(): ApiError {
  return new ApiError(404, {
    code: 'not_found',
    message: 'push subscription not found',
    retryable: false,
  });
}

function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p));
}

export interface PushImplDeps {
  id: (prefix: string) => string;
  ts: () => string;
  maybeFail: (name: keyof PushApi) => void;
  setting: <K extends SettingKey>(key: K) => SettingValue<K>;
}

export function m7PushImpl(st: M7PushState, d: PushImplDeps): PushApi {
  return {
    getPushVapidKey: async () => {
      d.maybeFail('getPushVapidKey');
      return { publicKey: st.vapidKey };
    },
    listPushSubscriptions: async () => {
      d.maybeFail('listPushSubscriptions');
      return { items: st.subscriptions.map(view) };
    },
    subscribePush: async (body) => {
      d.maybeFail('subscribePush');
      const parsed = createPushSubscriptionSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError(400, {
          code: 'validation',
          message: parsed.error.issues[0]?.message ?? 'invalid',
          retryable: false,
        });
      const url = new URL(parsed.data.endpoint);
      const hosts = d.setting('push.webPushHosts');
      if (url.protocol !== 'https:' || !hostAllowed(url.hostname, hosts))
        throw new ApiError(400, {
          code: 'validation',
          message: `${url.hostname} is not a push service this Hub sends to (push.webPushHosts)`,
          retryable: false,
          details: { field: 'endpoint' },
        });
      const existing = st.subscriptions.find((s) => s.endpoint === parsed.data.endpoint);
      if (!existing && st.subscriptions.length >= 50)
        throw new ApiError(409, {
          code: 'conflict',
          message: 'at most 50 push subscriptions; remove one',
          retryable: false,
        });
      const now = d.ts();
      const next: FakePushSubscription = existing
        ? {
            ...existing,
            label: parsed.data.label ?? existing.label,
            status: 'active',
            lastError: null,
            updatedAt: now,
          }
        : subscriptionView({
            id: d.id('ps'),
            endpoint: parsed.data.endpoint,
            endpointOrigin: url.origin,
            label: parsed.data.label ?? null,
            createdAt: now,
            updatedAt: now,
          });
      st.subscriptions = [next, ...st.subscriptions.filter((s) => s.id !== next.id)];
      return view(next);
    },
    unsubscribePush: async (id) => {
      d.maybeFail('unsubscribePush');
      if (!st.subscriptions.some((s) => s.id === id)) throw notFound();
      st.subscriptions = st.subscriptions.filter((s) => s.id !== id);
      return { ok: true };
    },
    testPush: async (subscriptionId) => {
      d.maybeFail('testPush');
      const rows = st.subscriptions.filter((s) => !subscriptionId || s.id === subscriptionId);
      if (subscriptionId && rows.length === 0) throw notFound();
      const results: PushTestView['results'] = rows.map((s) => {
        const o = st.outcomes[s.id] ?? { status: 'sent' as const };
        return {
          subscriptionId: s.id,
          status: o.status,
          detail: o.status === 'sent' ? null : (o.detail ?? 'push service error'),
        };
      });
      const gone = new Set(results.filter((r) => r.status === 'gone').map((r) => r.subscriptionId));
      st.subscriptions = st.subscriptions
        .filter((s) => !gone.has(s.id))
        .map((s) =>
          results.some((r) => r.subscriptionId === s.id && r.status === 'sent')
            ? { ...s, lastSuccessAt: d.ts() }
            : s,
        );
      return {
        sent: results.filter((r) => r.status === 'sent').length,
        failed: results.filter((r) => r.status !== 'sent').length,
        results,
      };
    },
  };
}

export type PushMocks = { [K in keyof PushApi]: PushApi[K] & Mock };

export function createPushHub(
  init: Partial<M7PushState> = {},
  setting: <K extends SettingKey>(key: K) => SettingValue<K> = (k) =>
    resolveSetting(k, { global: {}, managed: {} }).value,
) {
  const state = m7PushState(init);
  const failNext: Partial<Record<keyof PushApi, Error>> = {};
  const impl = m7PushImpl(state, {
    id: nid,
    ts: () => new Date().toISOString(),
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
    setting,
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as PushMocks;
  return { api, state, failNext };
}

/** Render `ui` with the main fake Hub's client and the push part spread over it. */
export async function renderWithPush(
  ui: ReactNode,
  opts: {
    push?: Partial<M7PushState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    hub?: ReturnType<typeof createHub>;
    /** Calls that fail once, from the first render on. */
    fail?: Partial<Record<keyof PushApi, Error>>;
  } = {},
) {
  // Loaded here, so tests of the Relay parts need not load the whole fake Hub.
  const { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } = await import('./fakes.ts');
  const hub = opts.hub ?? createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const push = createPushHub(
    opts.push,
    (k) => resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value,
  );
  Object.assign(push.failNext, opts.fail);
  const api = { ...hub.api, ...push.api };
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, push, api, state: push.state, ...utils };
}

// ---- the browser's PushManager --------------------------------------------------------------------

export class FakeBrowserSubscription implements PushSubscriptionLike {
  readonly endpoint: string;
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  unsubscribed = false;
  readonly #manager: FakePushManager;
  readonly #keys: { p256dh: string; auth: string };

  constructor(manager: FakePushManager, endpoint: string, key: Uint8Array | null) {
    this.#manager = manager;
    this.endpoint = endpoint;
    this.options = { applicationServerKey: key ? new Uint8Array(key).buffer : null };
    this.#keys = { p256dh: b64url(bytes(65, 3)), auth: b64url(new Uint8Array(16).fill(5)) };
  }

  toJSON(): PushSubscriptionJSON {
    return { endpoint: this.endpoint, expirationTime: null, keys: { ...this.#keys } };
  }

  async unsubscribe(): Promise<boolean> {
    this.unsubscribed = true;
    if (this.#manager.current === this) this.#manager.current = null;
    return true;
  }
}

export class FakePushManager implements PushManagerLike {
  current: FakeBrowserSubscription | null = null;
  /** The endpoint the next subscription gets. */
  nextEndpoint = 'https://fcm.googleapis.com/fcm/send/browser-1';
  subscribeCalls: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }[] = [];
  failSubscribe: Error | null = null;

  async getSubscription(): Promise<PushSubscriptionLike | null> {
    return this.current;
  }

  async subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionLike> {
    this.subscribeCalls.push(options);
    if (this.failSubscribe) throw this.failSubscribe;
    if (!options.userVisibleOnly) throw new Error('userVisibleOnly is required');
    if (options.applicationServerKey.length !== 65) throw new Error('bad application server key');
    this.current = new FakeBrowserSubscription(
      this,
      this.nextEndpoint,
      options.applicationServerKey,
    );
    return this.current;
  }

  /** A subscription this browser already holds (made with `key`). */
  existing(endpoint: string, key: string): FakeBrowserSubscription {
    this.current = new FakeBrowserSubscription(
      this,
      endpoint,
      new Uint8Array(Buffer.from(key, 'base64url')),
    );
    return this.current;
  }
}

export interface FakePushEnv extends PushEnv {
  manager: FakePushManager;
  /** The answer the permission prompt gives. */
  prompt: PermissionState;
  current: PermissionState;
  prompts: number;
  store: Map<string, string>;
}

export function fakePushEnv(
  over: Partial<Pick<PushEnv, 'secure' | 'pushManager' | 'iosTab'>> & {
    permission?: PermissionState;
    prompt?: PermissionState;
    worker?: boolean;
  } = {},
): FakePushEnv {
  const manager = new FakePushManager();
  const store = new Map<string, string>();
  const env: FakePushEnv = {
    secure: over.secure ?? true,
    pushManager: over.pushManager ?? true,
    iosTab: over.iosTab ?? false,
    manager,
    prompt: over.prompt ?? 'granted',
    current: over.permission ?? 'default',
    prompts: 0,
    store,
    permission: () => env.current,
    requestPermission: async () => {
      env.prompts++;
      env.current = env.prompt;
      return env.current;
    },
    registration: async () => (over.worker === false ? null : { pushManager: manager }),
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  };
  return env;
}

// ---- IndexedDB ------------------------------------------------------------------------------------

interface FakeRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

function settle<T>(r: FakeRequest<T>, value: T): void {
  queueMicrotask(() => {
    r.result = value;
    r.onsuccess?.();
  });
}

/** Enough of IndexedDB for one database with key-value stores; values are kept as they are. */
export function fakeIndexedDb(opts: { failOpen?: boolean } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map());
    },
    transaction: (name: string) => ({
      objectStore: () => {
        const s = stores.get(name);
        if (!s) throw new Error(`no store ${name}`);
        const request = <T>(fn: () => T) => {
          const r: FakeRequest<T | undefined> = {
            result: undefined,
            error: null,
            onsuccess: null,
            onerror: null,
          };
          settle(r, fn());
          return r;
        };
        return {
          get: (k: string) => request(() => s.get(k)),
          put: (v: unknown, k: string) =>
            request(() => {
              s.set(k, v);
              return k;
            }),
          delete: (k: string) =>
            request(() => {
              s.delete(k);
            }),
        };
      },
    }),
    close: () => undefined,
  };
  const factory = {
    stores,
    open: () => {
      const r: FakeRequest<typeof db> = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (opts.failOpen) {
          r.error = new Error('blocked');
          r.onerror?.();
          return;
        }
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return factory as unknown as IDBFactory & { stores: Map<string, Map<string, unknown>> };
}

// ---- the Relay link -------------------------------------------------------------------------------

export type TunnelHandler = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
) => Response | Promise<Response>;

export class FakeRelayLink implements RelayLink {
  state: RelayLink['state'] = 'idle';
  started = 0;
  stopped = 0;
  readonly calls: {
    path: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];
  readonly opts: RelayLinkOptions;
  handler: TunnelHandler;
  #waiters: ((d: RelayPairingDecision) => void)[] = [];
  #decision: RelayPairingDecision | null = null;

  constructor(opts: RelayLinkOptions, handler: TunnelHandler) {
    this.opts = opts;
    this.handler = handler;
  }

  start(): void {
    this.started++;
    this.setState('open');
  }

  stop(): void {
    this.stopped++;
    this.state = 'stopped';
  }

  setState(state: RelayLink['state']): void {
    this.state = state;
    this.opts.onState?.(state, null);
  }

  /** The Hub's sealed `paired` notice. */
  notifyPaired(info: { requestId: string | null; deviceId: string | null }): void {
    this.opts.onHubFloor?.(1234);
    this.#decide({ decision: 'approved', ...info });
  }

  /** The Hub's sealed `decided` notice (M7): the owner denied it, or it expired. */
  notifyDecided(decision: 'denied' | 'expired', requestId: string | null = 'req1'): void {
    this.opts.onHubFloor?.(1235);
    this.#decide({ decision, requestId });
  }

  #decide(d: RelayPairingDecision): void {
    if (this.#decision) return;
    this.#decision = d;
    for (const fn of this.#waiters.splice(0)) fn(d);
  }

  waitForDecision(): Promise<RelayPairingDecision> {
    if (this.#decision) return Promise.resolve(this.#decision);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async fetch(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    if (this.state === 'revoked') throw new Error('this device was removed from the Relay');
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body
          ? new TextDecoder().decode(init.body)
          : undefined;
    this.calls.push({ path, method, headers, ...(body !== undefined ? { body } : {}) });
    return this.handler(path, {
      method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  }
}

/** A `connect` that makes FakeRelayLinks answering with `handler`. */
export function fakeConnect(handler: TunnelHandler): RelayConnect & { links: FakeRelayLink[] } {
  const links: FakeRelayLink[] = [];
  const connect = ((_paired: PairedClient, opts: RelayLinkOptions) => {
    const link = new FakeRelayLink(opts, handler);
    links.push(link);
    return link;
  }) as unknown as RelayConnect & { links: FakeRelayLink[] };
  connect.links = links;
  return connect;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function pairedClient(over: Partial<PairedClient> = {}): PairedClient {
  return {
    v: 1,
    relayUrl: 'wss://relay.example',
    hubRoute: 'hubroute1',
    clientRoute: 'clientroute1',
    clientId: 'client1',
    routeToken: 'route-token-secret',
    sendKey: 'c2VuZGtleQ',
    recvKey: 'cmVjdmtleQ',
    ...over,
  };
}

export function relayPairing(over: Partial<RelayPairing> = {}): RelayPairing {
  return {
    v: 1,
    paired: pairedClient(),
    token: 'nvs_device_session',
    deviceId: 'dev1',
    hubFingerprint: null,
    name: 'Safari on iPhone',
    pairedAt: T0,
    hubFloor: 0,
    endpoints: [],
    ...over,
  };
}
