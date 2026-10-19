// The fake Hub's M7.5 local browser fallback and extension bridge part (FR-209, FR-096), in
// memory, with the Hub's rules from apps/hub/src/browser.ts and packages/core/src/browser/
// {fallback,bridge}.ts:
// - fallback consents and sessions are the account's; `all` adds revoked consents (newest first);
//   revoking an unknown consent is 404 `consent not found`, a revoked one is a no-op, and a
//   session running on it ends with `consent_revoked`.
// - the bridge routes are the Hub owner's (403 `policy_denied` `owner_only` for a member); a
//   device that is not on the Hub (or revoked) is 404 `device not found`; bodies are checked with
//   the shared schemas (400 `validation`, "request failed validation"); a grant needs
//   `browser.extensionBridge` (403 `bridge_disabled`), "all sites" also
//   `browser.extensionBridgeAllSites` (403 `all_sites_disabled`); one of the Hub's own hosts (or a
//   subdomain, or a loopback name) is never granted (403 `hub_host`); granting an active host gives it
//   back, a pending one becomes active; confirming an unknown grant is 404, a revoked one 409
//   `conflict`, "all sites" without the acknowledgement 400 `elevated_ack_required`; revoking a
//   grant of another device is 404 `grant not found`, a revoked one is a no-op.
//
// Wired into test/fakes.ts (`m75browser`). `renderM75Browser` spreads a separate copy over the main
// fake so a test reaches its state and failures directly.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  confirmBridgeGrantSchema,
  createBridgeGrantSchema,
  resolveSetting,
  type AuditEntryView,
  type BrowserBridgeGrantView,
  type BrowserBridgeStatusView,
  type BrowserBridgeTabView,
  type BrowserFallbackConsentView,
  type BrowserFallbackOfferContext,
  type BrowserFallbackSessionView,
  type ServerRequestView,
  type SettingKey,
  type SettingValue,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import type { z } from 'zod';
import { ApiError } from '../src/api.ts';
import type { BrowserDeviceApi } from '../src/browserdevice/api-m75.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import {
  DONE_ONBOARDING,
  createHub,
  fakeEventSource,
  fakeWebSocket,
  testRegistry,
} from './fakes.ts';
import { agentView } from './fakes-m6-agents.ts';
import { createBrowserHub, type M6BrowserState } from './fakes-m6-browser.ts';
import { createDevicesHub, type M6DevicesState } from './fakes-m6-devices.ts';
import { createAddDeviceHub } from './fakes-m65-devices.ts';

const T0 = '2026-10-02T09:00:00.000Z';
export const ACCOUNT = 'a1';
let n = 0;

// ---- builders ----------------------------------------------------------------------------------

export function consentView(
  over: Partial<BrowserFallbackConsentView> = {},
): BrowserFallbackConsentView {
  return {
    id: `fc${++n}`,
    scopeKind: 'agent',
    scopeRef: 'ag1',
    deviceId: 'd1',
    deviceName: 'Desk PC',
    site: 'example.com',
    profile: 'clean',
    grantedBy: 'user',
    createdAt: T0,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    ...over,
  };
}

export function fallbackSessionView(
  over: Partial<BrowserFallbackSessionView> = {},
): BrowserFallbackSessionView {
  return {
    id: `fs${++n}`,
    computerId: 'pc1',
    threadId: 't1',
    deviceId: 'd1',
    site: 'example.com',
    profile: 'clean',
    cause: 'block_page',
    consentId: null,
    startedAt: T0,
    endedAt: null,
    endReason: null,
    egress: null,
    ...over,
  };
}

export function bridgeGrantView(
  over: Partial<BrowserBridgeGrantView> = {},
): BrowserBridgeGrantView {
  const host = over.host ?? 'github.com';
  return {
    id: `bg${++n}`,
    deviceId: 'd1',
    host,
    allSites: host === '*',
    state: 'active',
    browserPermission: true,
    confirmedBy: 'a1',
    confirmedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    revokedAt: null,
    revokedBy: null,
    ...over,
  };
}

export function bridgeTab(over: Partial<BrowserBridgeTabView> = {}): BrowserBridgeTabView {
  return {
    tabId: ++n,
    host: 'github.com',
    title: 'Pull requests',
    origin: 'shared',
    since: T0,
    ...over,
  };
}

/** What the bridge on one device looks like, from the events novad relayed. */
export interface FakeBridge {
  connected: boolean;
  since: string | null;
  extensionVersion: string | null;
  browser: string | null;
  user: string | null;
  tabs: BrowserBridgeTabView[];
}

export function connectedBridge(over: Partial<FakeBridge> = {}): FakeBridge {
  return {
    connected: true,
    since: T0,
    extensionVersion: '0.7.5',
    browser: 'Chromium 140',
    user: 'sam',
    tabs: [],
    ...over,
  };
}

/** The Hub's fallback offer for `site` on `device` (packages/core/src/browser/fallback.ts). */
export function fallbackOffer(
  over: Partial<ServerRequestView> & {
    site?: string;
    device?: string;
    extension?: boolean;
    threadId?: string;
    cause?: BrowserFallbackOfferContext['cause'];
  } = {},
): ServerRequestView {
  const {
    site = 'example.com',
    device = 'Desk PC',
    extension = true,
    threadId = 't1',
    cause = 'block_page',
  } = over;
  const clean = `Continue on ${device} (clean profile)`;
  const own = `Continue in my own browser on ${device} (extension)`;
  const question =
    `${site} refused the agent's browser (a block page). Let the agent continue ${site} on ` +
    `${device}'s browser? A clean profile starts empty and reaches only ${site} and its ` +
    `subdomains; in your own browser the agent acts only in a tab it opens or one you shared, ` +
    `on ${site}. It stops when the agent leaves the site. Your choice is remembered for ` +
    `${site} on ${device} until you revoke it in Settings → Browser.`;
  const offered: BrowserFallbackOfferContext['choices'] = [
    { id: 'clean', label: clean, profile: 'clean' },
    ...(extension ? [{ id: 'extension' as const, label: own, profile: 'extension' as const }] : []),
    { id: 'decline', label: 'Not now', profile: null },
  ];
  const context: BrowserFallbackOfferContext = {
    kind: 'browser.fallback',
    site,
    deviceId: 'd1',
    deviceName: device,
    cause,
    choices: offered,
  };
  const rest = { ...over };
  delete rest.site;
  delete rest.device;
  delete rest.extension;
  delete rest.threadId;
  delete rest.cause;
  return {
    id: `rq${++n}`,
    kind: 'user_input',
    correlation: { threadId, callId: `call${n}`, turnId: 'turn1' },
    targetDeviceId: null,
    status: 'pending',
    payload: {
      question,
      choices: offered.map((c) => c.label),
      allowFreeText: false,
      context,
    },
    resolution: null,
    createdAt: T0,
    expiresAt: '2026-10-02T09:10:00.000Z',
    ...rest,
  };
}

export function auditEntry(over: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    id: `au${++n}`,
    actor: 'system',
    kind: 'browser',
    action: 'browser.bridge.history.search',
    resource: null,
    decision: null,
    result: null,
    threadId: null,
    turnId: null,
    createdAt: T0,
    hash: 'h',
    ...over,
  };
}

// ---- state -------------------------------------------------------------------------------------

export interface M75BrowserState {
  consents: BrowserFallbackConsentView[];
  sessions: BrowserFallbackSessionView[];
  /** The bridge per device id (in memory on the Hub; a device without one is not connected). */
  bridges: Record<string, FakeBridge>;
  grants: BrowserBridgeGrantView[];
  /** The devices on this Hub by id, for the bridge routes' device check. */
  devices: Record<string, { name: string; revoked?: boolean }>;
  /** The signed-in account is a member: the bridge routes answer 403 `owner_only`. */
  member: boolean;
  /** The Hub's own host names (configured, mDNS, Direct, Relay); loopback names always count. */
  hubHosts: string[];
}

export function m75BrowserState(init: Partial<M75BrowserState> = {}): M75BrowserState {
  return {
    consents: [],
    sessions: [],
    bridges: {},
    grants: [],
    devices: { d1: { name: 'Desk PC' } },
    member: false,
    hubHosts: ['hub.example', 'nova.local'],
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', 'request failed validation', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
}

const newestFirst = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

// ---- implementation ----------------------------------------------------------------------------

export function m75BrowserImpl(
  st: M75BrowserState,
  ctx: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof BrowserDeviceApi) => void;
    setting: <K extends SettingKey>(k: K) => SettingValue<K>;
  },
): BrowserDeviceApi {
  const owner = () => {
    if (st.member)
      throw err(403, 'policy_denied', "only the Hub's owner manages the extension bridge", {
        reason: 'owner_only',
      });
  };
  const device = (id: string) => {
    const d = st.devices[id];
    if (!d || d.revoked) throw err(404, 'not_found', 'device not found');
    return d;
  };
  // The Hub's own hosts and their subdomains, and loopback names (bridge.ts isHubHost).
  const hubHost = (h: string) =>
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    st.hubHosts.some((o) => o === h || (o.includes('.') && h.endsWith(`.${o}`)));
  const live = (deviceId: string, host: string) =>
    st.grants.find((g) => g.deviceId === deviceId && g.host === host && g.state !== 'revoked');
  const put = (g: BrowserBridgeGrantView) => {
    st.grants = [...st.grants.filter((x) => x.id !== g.id), g];
    return { ...g };
  };
  const create = (deviceId: string, body: z.infer<typeof createBridgeGrantSchema>) => {
    device(deviceId);
    if (!ctx.setting('browser.extensionBridge'))
      throw err(403, 'policy_denied', 'the extension bridge is turned off', {
        reason: 'bridge_disabled',
      });
    const host = body.kind === 'all_sites' ? '*' : body.host;
    if (host === '*' && !ctx.setting('browser.extensionBridgeAllSites'))
      throw err(403, 'policy_denied', 'the "all sites" grant is turned off by policy', {
        reason: 'all_sites_disabled',
      });
    if (host !== '*' && hubHost(host))
      throw err(403, 'policy_denied', 'the Hub’s own addresses are never granted to the bridge', {
        reason: 'hub_host',
      });
    const at = ctx.ts();
    const before = live(deviceId, host);
    if (before?.state === 'active') return { ...before };
    if (before)
      return put({
        ...before,
        state: 'active',
        confirmedBy: ACCOUNT,
        confirmedAt: at,
        updatedAt: at,
      });
    return put(
      bridgeGrantView({
        id: ctx.id('bg'),
        deviceId,
        host,
        allSites: host === '*',
        state: 'active',
        browserPermission: false,
        confirmedBy: ACCOUNT,
        confirmedAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    );
  };

  return {
    listFallbackConsents: async (q = {}) => {
      ctx.maybeFail('listFallbackConsents');
      return {
        items: st.consents
          .filter(
            (c) =>
              (q.all || !c.revokedAt) &&
              (!q.scopeKind || c.scopeKind === q.scopeKind) &&
              (!q.scopeRef || c.scopeRef === q.scopeRef) &&
              (!q.deviceId || c.deviceId === q.deviceId),
          )
          .sort(newestFirst)
          .map((c) => ({ ...c })),
      };
    },
    revokeFallbackConsent: async (id) => {
      ctx.maybeFail('revokeFallbackConsent');
      const c = st.consents.find((x) => x.id === id);
      if (!c) throw err(404, 'not_found', 'consent not found');
      if (c.revokedAt) return { ok: true };
      const at = ctx.ts();
      st.consents = st.consents.map((x) =>
        x.id === id ? { ...x, revokedAt: at, revokedBy: ACCOUNT } : x,
      );
      st.sessions = st.sessions.map((s) =>
        s.consentId === id && !s.endedAt ? { ...s, endedAt: at, endReason: 'consent_revoked' } : s,
      );
      return { ok: true };
    },
    listFallbackSessions: async (q = {}) => {
      ctx.maybeFail('listFallbackSessions');
      return {
        items: st.sessions
          .filter((s) => !q.computerId || s.computerId === q.computerId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, q.limit ?? 50)
          .map((s) => ({ ...s })),
      };
    },
    getBridgeStatus: async (deviceId): Promise<BrowserBridgeStatusView> => {
      ctx.maybeFail('getBridgeStatus');
      owner();
      const d = device(deviceId);
      const b = st.bridges[deviceId];
      return {
        deviceId,
        deviceName: d.name,
        connected: b?.connected ?? false,
        since: b?.since ?? null,
        extensionVersion: b?.extensionVersion ?? null,
        browser: b?.browser ?? null,
        user: b?.user ?? null,
        enabled: ctx.setting('browser.extensionBridge'),
        allSitesAllowed: ctx.setting('browser.extensionBridgeAllSites'),
        tabs: (b?.tabs ?? []).map((t) => ({ ...t })),
      };
    },
    listBridgeGrants: async (deviceId, all = false) => {
      ctx.maybeFail('listBridgeGrants');
      owner();
      device(deviceId);
      return {
        items: st.grants
          .filter((g) => g.deviceId === deviceId && (all || g.state !== 'revoked'))
          .sort(newestFirst)
          .map((g) => ({ ...g })),
      };
    },
    createBridgeGrant: async (deviceId, body) => {
      ctx.maybeFail('createBridgeGrant');
      owner();
      return create(deviceId, parse(createBridgeGrantSchema, body));
    },
    confirmBridgeGrant: async (deviceId, grantId, body) => {
      ctx.maybeFail('confirmBridgeGrant');
      owner();
      const b = parse(confirmBridgeGrantSchema, body);
      const row = st.grants.find((g) => g.id === grantId);
      if (!row) throw err(404, 'not_found', 'grant not found');
      if (row.state === 'revoked') throw err(409, 'conflict', 'the grant was revoked');
      if (row.host === '*' && b.acknowledgeElevatedRisk !== true)
        throw err(400, 'validation', '"all sites" needs its own acknowledgement of the risk', {
          reason: 'elevated_ack_required',
        });
      const view = create(
        row.deviceId,
        row.host === '*'
          ? { kind: 'all_sites', confirm: true, acknowledgeElevatedRisk: true }
          : { kind: 'host', host: row.host, confirm: true },
      );
      if (view.deviceId !== deviceId) throw err(404, 'not_found', 'grant not found');
      return view;
    },
    revokeBridgeGrant: async (deviceId, grantId) => {
      ctx.maybeFail('revokeBridgeGrant');
      owner();
      device(deviceId);
      const row = st.grants.find((g) => g.id === grantId && g.deviceId === deviceId);
      if (!row) throw err(404, 'not_found', 'grant not found');
      if (row.state === 'revoked') return { ok: true };
      const at = ctx.ts();
      put({ ...row, state: 'revoked', revokedAt: at, revokedBy: ACCOUNT, updatedAt: at });
      return { ok: true };
    },
  };
}

// ---- test helpers ------------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 30, clock++)).toISOString();

export type M75BrowserMocks = BrowserDeviceApi &
  Record<keyof BrowserDeviceApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createM75BrowserHub(
  init: Partial<M75BrowserState> = {},
  setting: <K extends SettingKey>(k: K) => SettingValue<K>,
) {
  const state = m75BrowserState(init);
  const failNext: Partial<Record<keyof BrowserDeviceApi, Error>> = {};
  const impl = m75BrowserImpl(state, {
    id: nextId,
    ts: nextTs,
    setting,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as M75BrowserMocks;
  return { api, state, failNext };
}

export interface RenderM75Options {
  /** This part's state. */
  m75?: Partial<M75BrowserState>;
  /** The M6 browser part (sessions, actions) for the browser panel. */
  browser?: Partial<M6BrowserState>;
  /** The M6 devices part, for a device's page. */
  devices?: Partial<M6DevicesState>;
  /** Pending and answered questions (the request broker). */
  requests?: ServerRequestView[];
  audit?: AuditEntryView[];
  agents?: { id: string; name: string }[];
  settings?: Record<string, unknown>;
  managed?: Record<string, unknown>;
  /** Calls of this part that fail once, from the first render on. */
  fail?: Partial<Record<keyof BrowserDeviceApi, Error>>;
  /** Leave this part's calls out, also the main fake's (a client without the M7.5 calls). */
  without?: boolean;
}

/**
 * Render `ui` with the main fake Hub's client, the M6 browser and devices parts, the M6.5
 * add-device part and this part spread over them (what `createApi` will do).
 */
export async function renderM75Browser(ui: ReactNode, opts: RenderM75Options = {}) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  if (opts.requests) hub.state.m5work.requests = opts.requests;
  if (opts.audit) hub.state.m3.audit = opts.audit;
  if (opts.agents) hub.state.m6agents.agents = opts.agents.map((a) => agentView(a));
  const setting = <K extends SettingKey>(k: K): SettingValue<K> =>
    resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value;
  const browser = createBrowserHub(
    opts.browser,
    () => hub.state.settings,
    () => hub.state.managed,
  );
  const devices = createDevicesHub(opts.devices, {
    approvals: {
      list: () => hub.state.m3.approvals,
      add: (a) => {
        hub.state.m3.approvals = [...hub.state.m3.approvals, a];
      },
    },
  });
  const added = createAddDeviceHub({}, devices.state);
  const m75 = createM75BrowserHub(opts.m75, setting);
  Object.assign(m75.failNext, opts.fail);
  const api = {
    ...hub.api,
    ...devices.api,
    ...added.api,
    ...browser.api,
    ...m75.api,
  };
  // The main fake provides these calls too: an older client has none of them.
  if (opts.without)
    for (const name of Object.keys(m75.api)) delete (api as Record<string, unknown>)[name];
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      webSocket: fakeWebSocket,
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return {
    hub,
    api: m75.api,
    state: m75.state,
    failNext: m75.failNext,
    browser: browser.state,
    devicesState: devices.state,
    ...utils,
  };
}
