// The fake Hub's M6 browser and screen parts: the agent browser (sites, domain lists, sessions,
// recorded actions, private sign-ins, saved logins; FR-086, FR-094, FR-096, FR-098) and computer
// use (control state, kill key, grants, recorded screen actions, takeover, appshots; FR-093,
// FR-207, FR-087, FR-075), in memory, with the Hub's rules: a bad site pattern answers 400, a
// blocked site with developer-protocol mode 400, developer-protocol mode while the setting is off
// 403 `policy_denied`, closing a browser that is not open 404, a sign-in that no longer waits 410
// `request_expired`, a saved login for another site 400, granting an app Nova never controls 403
// `policy_denied`, renewing a revoked grant 409, a second takeover 409, input or ending without a
// takeover 409, and seeing a computer without a controlled desktop (or browser) 409. Unknown
// computers answer 404. Views handed out are copies and never mutated. Since M7 the trace is
// newest first with an opaque cursor (a forged one is 400), and a site keeps its levels per
// project or agent until it is blocked or removed (their routes are in fakes-m7-misc.ts).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6browser: M6BrowserState`,
// `createHub` defaults it to `m6BrowserState()`, and `impl` spreads
// `...m6BrowserImpl(state.m6browser, { id, ts: () => ts(), maybeFail, setting: (k) =>
// resolveSetting(k, layers()).value })`. Until then tests build the client with
// `createBrowserHub()` and spread its `api` over `createHub().api` (`renderWithBrowser` does).
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  appshotCreateSchema,
  putBrowserDomainsSchema,
  putBrowserSiteSchema,
  patchBrowserSiteSchema,
  resolveSetting,
  screenGrantSchema,
  submitBrowserSigninSchema,
  takeoverInputSchema,
  type AppshotView,
  type BrowserActionView,
  type BrowserLoginView,
  type BrowserSessionView,
  type BrowserSigninView,
  type BrowserSiteLevel,
  type BrowserSiteView,
  type BrowserStatusView,
  type ComputerView,
  type ScreenActionView,
  type ScreenControlState,
  type ScreenControlTier,
  type ScreenGrantView,
  type ScreenStatusView,
  type ScreenTakeoverView,
  type ScreenWindowView,
  type SettingKey,
  type SettingValue,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { BrowserApi, BrowserSigninResult } from '../src/browser/api.ts';
import type { ScreenApi } from '../src/screen/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import {
  DONE_ONBOARDING,
  FakeEventSource,
  createHub,
  fakeEventSource,
  fakeWebSocket,
  testRegistry,
} from './fakes.ts';

export type BrowserScreenApi = BrowserApi & ScreenApi;

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;
/** A 1×1 PNG, base64. */
export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---- view builders ----------------------------------------------------------------------------

export function siteView(over: Partial<BrowserSiteView> = {}): BrowserSiteView {
  return {
    pattern: 'example.com',
    access: 'allow',
    level: 'always_ask',
    devProtocol: false,
    scopedLevels: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function sessionView(over: Partial<BrowserSessionView> = {}): BrowserSessionView {
  return {
    computerId: 'pc1',
    state: 'running',
    url: 'https://shop.example.com/cart',
    title: 'Your cart',
    host: 'shop.example.com',
    pausedBy: null,
    pageTools: [],
    startedAt: T0,
    lastActionAt: T0,
    persistCookies: false,
    crash: null,
    restarts: 0,
    ...over,
  };
}

export function browserActionView(over: Partial<BrowserActionView> = {}): BrowserActionView {
  return {
    id: `ba${(++n).toString().padStart(4, '0')}`,
    computerId: 'pc1',
    threadId: null,
    turnId: null,
    callId: null,
    tool: 'browser.click',
    action: 'click',
    target: 'button "Add to cart"',
    url: 'https://shop.example.com/item',
    host: 'shop.example.com',
    result: 'ok',
    error: null,
    classification: null,
    before: true,
    after: true,
    approvalId: null,
    createdAt: T0,
    ...over,
  };
}

export function signinView(over: Partial<BrowserSigninView> = {}): BrowserSigninView {
  return {
    id: `si${++n}`,
    computerId: 'pc1',
    threadId: null,
    host: 'shop.example.com',
    url: 'https://shop.example.com/login',
    state: 'pending',
    savedLogins: [],
    createdAt: T0,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  };
}

export function loginView(over: Partial<BrowserLoginView> = {}): BrowserLoginView {
  return {
    id: `lg${++n}`,
    host: 'shop.example.com',
    username: 'sam@example.com',
    createdAt: T0,
    lastUsedAt: null,
    ...over,
  };
}

export function computerView(over: Partial<ComputerView> = {}): ComputerView {
  return {
    id: 'pc1',
    kind: 'cloud',
    agentId: 'ag1',
    deviceId: null,
    provider: 'mock_cloud',
    state: 'running',
    substrate: 'cloud_stub',
    detail: null,
    baseImage: null,
    snapshotCount: 0,
    createdAt: T0,
    updatedAt: T0,
    lastUsedAt: null,
    ...over,
  };
}

export function grantView(over: Partial<ScreenGrantView> = {}): ScreenGrantView {
  return {
    id: `gr${++n}`,
    computerId: 'pc1',
    app: 'Spreadsheet',
    tier: 'full',
    grantedBy: 'user',
    threadId: null,
    createdAt: T0,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    revokedAt: null,
    active: true,
    remainingSeconds: 1800,
    ...over,
  };
}

export function screenActionView(over: Partial<ScreenActionView> = {}): ScreenActionView {
  return {
    id: `sa${(++n).toString().padStart(4, '0')}`,
    computerId: 'pc1',
    actor: 'agent:ag1',
    origin: 'tool',
    kind: 'click',
    args: { kind: 'click', x: 120, y: 40 },
    app: 'Spreadsheet',
    windowTitle: 'Expenses.xlsx',
    tier: 'full',
    status: 'ok',
    error: null,
    threadId: null,
    turnId: null,
    callId: null,
    takeoverId: null,
    hasBefore: true,
    hasAfter: true,
    createdAt: T0,
    completedAt: T0,
    ...over,
  };
}

export function windowView(over: Partial<ScreenWindowView> = {}): ScreenWindowView {
  return {
    id: `w${++n}`,
    app: 'Spreadsheet',
    title: 'Expenses.xlsx',
    focused: false,
    tier: 'full',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    granted: false,
    ...over,
  };
}

export function appshotView(over: Partial<AppshotView> = {}): AppshotView {
  return {
    id: `as${++n}`,
    computerId: 'pc1',
    artifactId: `art${n}`,
    source: 'window',
    app: 'Spreadsheet',
    windowTitle: 'Expenses.xlsx',
    url: null,
    width: 800,
    height: 600,
    threadId: null,
    capturedBy: 'user',
    capturedAt: T0,
    ...over,
  };
}

// ---- state ------------------------------------------------------------------------------------

/** One computer's screen: control row, grants, takeovers and what is on it. */
export interface FakeScreen {
  enabled: boolean;
  stoppedAt: string | null;
  stoppedBy: string | null;
  /** Every grant, revoked and expired ones included. */
  grants: ScreenGrantView[];
  takeover: ScreenTakeoverView | null;
  actions: ScreenActionView[];
  /** The windows an observation returns (tiers as the controller reports them). */
  windows: ScreenWindowView[];
  /** It has a controlled desktop. */
  desktop: boolean;
  /** It has a browser (frames, browser takeover, browser appshots). */
  browser: boolean;
  lastActionAt: string | null;
  activeApp: string | null;
}

export function fakeScreen(over: Partial<FakeScreen> = {}): FakeScreen {
  return {
    enabled: false,
    stoppedAt: null,
    stoppedBy: null,
    grants: [],
    takeover: null,
    actions: [],
    windows: [],
    desktop: true,
    browser: true,
    lastActionAt: null,
    activeApp: null,
    ...over,
  };
}

export interface M6BrowserState {
  status: BrowserStatusView;
  sites: BrowserSiteView[];
  sessions: BrowserSessionView[];
  actions: BrowserActionView[];
  /** Pending private sign-in forms. */
  signins: BrowserSigninView[];
  logins: BrowserLoginView[];
  /** What the browser reports after a sign-in answer. */
  signinResult: BrowserSigninResult;
  computers: ComputerView[];
  screens: Record<string, FakeScreen>;
  appshots: AppshotView[];
}

export function m6BrowserState(init: Partial<M6BrowserState> = {}): M6BrowserState {
  const st: M6BrowserState = {
    status: { available: true, detail: 'Chromium 140', driver: 'playwright', egress: 'wired' },
    sites: [],
    sessions: [],
    actions: [],
    signins: [],
    logins: [],
    signinResult: { state: 'completed', message: 'Signed in to the site in the agent browser.' },
    computers: [computerView()],
    screens: {},
    appshots: [],
    ...init,
  };
  for (const c of st.computers) st.screens[c.id] ??= fakeScreen();
  return st;
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = (what = 'Not found') => err(404, 'not_found', what);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

const sameApp = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const RANK: Record<ScreenControlTier, number> = { none: 0, view: 1, click: 2, full: 3 };
const SENSITIVE =
  /\b(passwords?|password manager|keychain|credentials?|system settings|system preferences|control panel|bank|banking|payments?|wallet|antivirus|security)\b/;

/** The Hub's tier: the lowest of the reported one, the app name's class and the user's override. */
function effectiveTier(
  app: string,
  reported: ScreenControlTier,
  overrides: Record<string, ScreenControlTier>,
): ScreenControlTier {
  const n = app.toLowerCase();
  const byName: ScreenControlTier | null = SENSITIVE.test(n)
    ? 'none'
    : /\b(web browser|browser)\b/.test(n)
      ? 'view'
      : /\b(terminal|console|shell|command prompt|code editor|text editor|editor|ide)\b/.test(n)
        ? 'click'
        : null;
  const override = Object.entries(overrides).find(([k]) => sameApp(k, app))?.[1] ?? null;
  let out = reported;
  for (const t of [byName, override]) if (t && RANK[t] < RANK[out]) out = t;
  return out;
}

// ---- implementation ---------------------------------------------------------------------------

export function m6BrowserImpl(
  st: M6BrowserState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof BrowserScreenApi) => void;
    setting: <K extends SettingKey>(key: K) => SettingValue<K>;
    now?: () => number;
  },
): BrowserScreenApi {
  const { id, ts, maybeFail, setting } = helpers;
  const now = helpers.now ?? (() => Date.now());

  // ---- browser ----
  const site = (pattern: string) => {
    const s = st.sites.find((x) => x.pattern === pattern.trim().toLowerCase());
    if (!s) throw notFound('no such site');
    return s;
  };
  const sortSites = () =>
    (st.sites = [...st.sites].sort(
      (a, b) => a.access.localeCompare(b.access) || a.pattern.localeCompare(b.pattern),
    ));
  const putSite = (input: z.input<typeof putBrowserSiteSchema>): BrowserSiteView => {
    const b = parse(putBrowserSiteSchema, input);
    const prev = st.sites.find((s) => s.pattern === b.pattern) ?? null;
    if (b.access === 'block' && b.devProtocol)
      throw err(400, 'validation', 'a blocked site cannot use developer-protocol mode');
    if (b.devProtocol === true && !setting('browser.devProtocol'))
      throw err(403, 'policy_denied', 'developer-protocol mode is turned off by policy', {
        setting: 'browser.devProtocol',
      });
    const level: BrowserSiteLevel | null =
      b.access === 'block' ? null : (b.level ?? prev?.level ?? 'always_ask');
    const devProtocol =
      b.access === 'block' ? false : (b.devProtocol ?? prev?.devProtocol ?? false);
    const at = ts();
    const v = siteView({
      pattern: b.pattern,
      access: b.access,
      level,
      devProtocol,
      // A scoped level survives a change of the account level; blocking the site removes it.
      scopedLevels: b.access === 'block' ? [] : (prev?.scopedLevels ?? []),
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    });
    st.sites = [...st.sites.filter((s) => s.pattern !== b.pattern), v];
    sortSites();
    return { ...v };
  };
  const domains = () => ({
    allow: st.sites.filter((s) => s.access === 'allow').map((s) => s.pattern),
    deny: st.sites.filter((s) => s.access === 'block').map((s) => s.pattern),
  });

  // ---- screen ----
  const screenOf = (cid: string): FakeScreen => {
    if (!st.computers.some((c) => c.id === cid)) throw notFound('computer not found');
    return (st.screens[cid] ??= fakeScreen());
  };
  const grantOut = (g: ScreenGrantView): ScreenGrantView => {
    const left = Math.max(0, Math.floor((Date.parse(g.expiresAt) - now()) / 1000));
    const active = !g.revokedAt && left > 0;
    return { ...g, active, remainingSeconds: active ? left : 0 };
  };
  const activeGrants = (s: FakeScreen) => s.grants.map(grantOut).filter((g) => g.active);
  const stateOf = (s: FakeScreen): ScreenControlState => {
    if (s.takeover) return 'taken_over';
    if (!s.enabled) return 'disabled';
    if (s.stoppedAt) return 'stopped';
    return activeGrants(s).length ? 'controlling' : 'idle';
  };
  const statusOf = (cid: string): ScreenStatusView => {
    const s = screenOf(cid);
    const state = stateOf(s);
    const grants = activeGrants(s);
    const killKey = setting('screen.killKey');
    const apps = [...new Set(grants.map((g) => g.app))].sort((a, b) => a.localeCompare(b));
    const visible = state === 'controlling';
    return {
      computerId: cid,
      enabled: s.enabled,
      state,
      stoppedAt: s.stoppedAt,
      stoppedBy: s.stoppedBy,
      grants,
      takeover: s.takeover ? { ...s.takeover } : null,
      indicator: {
        visible,
        apps: visible ? apps : [],
        text: visible ? `Nova is controlling ${apps.join(', ')} · ${killKey} to stop` : null,
        killKey,
      },
      lastActionAt: s.lastActionAt,
      activeApp: s.activeApp,
    };
  };
  const grantRow = (cid: string, gid: string) => {
    const g = screenOf(cid).grants.find((x) => x.id === gid);
    if (!g) throw notFound('grant not found');
    return g;
  };
  const renew = (cid: string, gid: string, minutes?: number): ScreenGrantView => {
    const g = grantRow(cid, gid);
    if (g.revokedAt) throw err(409, 'conflict', 'that grant was revoked; grant the app again');
    const m = minutes ?? setting('screen.grantMinutes');
    g.expiresAt = new Date(now() + m * 60_000).toISOString();
    return grantOut(g);
  };
  const noDesktop = () => err(409, 'conflict', 'this computer has no controlled desktop');

  return {
    // ---- browser: status, sites, domain lists ----
    browserStatus: async () => {
      maybeFail('browserStatus');
      return { ...st.status };
    },
    listBrowserSites: async () => {
      maybeFail('listBrowserSites');
      return { items: st.sites.map((s) => ({ ...s })) };
    },
    putBrowserSite: async (body) => {
      maybeFail('putBrowserSite');
      return putSite(body);
    },
    patchBrowserSite: async (pattern, body) => {
      maybeFail('patchBrowserSite');
      const b = parse(patchBrowserSiteSchema, body);
      const prev = site(pattern);
      if (prev.access === 'block' && (b.level || b.devProtocol))
        throw err(400, 'validation', 'a blocked site has no level or developer-protocol mode');
      return putSite({ pattern: prev.pattern, access: prev.access, ...b });
    },
    deleteBrowserSite: async (pattern) => {
      maybeFail('deleteBrowserSite');
      const s = site(pattern);
      st.sites = st.sites.filter((x) => x.pattern !== s.pattern);
      return { ok: true };
    },
    browserDomains: async () => {
      maybeFail('browserDomains');
      return domains();
    },
    setBrowserDomains: async (body) => {
      maybeFail('setBrowserDomains');
      const b = parse(putBrowserDomainsSchema, body);
      if (b.deny) {
        const deny = new Set(b.deny);
        st.sites = st.sites.filter((s) => s.access !== 'block' || deny.has(s.pattern));
        for (const p of deny) putSite({ pattern: p, access: 'block' });
      }
      if (b.allow) {
        const allow = new Set(b.allow);
        st.sites = st.sites.filter((s) => s.access !== 'allow' || allow.has(s.pattern));
        for (const p of allow) {
          const prev = st.sites.find((s) => s.pattern === p);
          if (!prev) putSite({ pattern: p, access: 'allow' });
        }
      }
      return domains();
    },

    // ---- browser: sessions and the trace ----
    listBrowserSessions: async () => {
      maybeFail('listBrowserSessions');
      return { items: st.sessions.filter((s) => s.state !== 'closed').map((s) => ({ ...s })) };
    },
    closeBrowserSession: async (cid) => {
      maybeFail('closeBrowserSession');
      if (!st.sessions.some((s) => s.computerId === cid && s.state !== 'closed'))
        throw notFound('no open browser for that computer');
      st.sessions = st.sessions.filter((s) => s.computerId !== cid);
      return { ok: true };
    },
    // Newest first; the cursor is the last row's (createdAt, id), opaque to the client (M7).
    listBrowserActions: async (q = {}) => {
      maybeFail('listBrowserActions');
      let after: [string, string] | null = null;
      if (q.cursor) {
        try {
          const v = JSON.parse(atob(q.cursor)) as unknown;
          if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'string'))
            throw new Error('shape');
          after = [v[0] as string, v[1] as string];
        } catch {
          throw err(400, 'validation', 'that cursor is not one the Hub made');
        }
      }
      const limit = q.limit ?? 100;
      const sorted = st.actions
        .filter(
          (a) =>
            (!q.computerId || a.computerId === q.computerId) &&
            (!q.threadId || a.threadId === q.threadId) &&
            (!q.callId || a.callId === q.callId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .filter(
          (a) =>
            !after ||
            a.createdAt < after[0] ||
            (a.createdAt === after[0] && a.id.localeCompare(after[1]) < 0),
        );
      const items = sorted.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((a) => ({ ...a })),
        nextCursor:
          sorted.length > limit && last ? btoa(JSON.stringify([last.createdAt, last.id])) : null,
      };
    },
    browserShotUrl: (aid, which) => `/api/v1/browser/actions/${aid}/screenshots/${which}`,

    // ---- browser: private sign-in ----
    listBrowserSignins: async (threadId) => {
      maybeFail('listBrowserSignins');
      return {
        items: st.signins
          .filter((s) => !threadId || s.threadId === threadId)
          .map((s) => ({ ...s })),
      };
    },
    submitBrowserSignin: async (sid, body) => {
      maybeFail('submitBrowserSignin');
      const p = st.signins.find((s) => s.id === sid);
      if (!p) throw err(410, 'request_expired', 'this sign-in is no longer waiting');
      const b = parse(submitBrowserSigninSchema, body);
      if ('loginId' in b && !p.savedLogins.some((l) => l.id === b.loginId))
        throw err(400, 'validation', 'that saved login is not for this site');
      st.signins = st.signins.filter((s) => s.id !== sid);
      if ('username' in b && b.save)
        st.logins = [
          ...st.logins,
          loginView({ id: id('lg'), host: p.host, username: b.username, createdAt: ts() }),
        ];
      return { ...st.signinResult };
    },
    cancelBrowserSignin: async (sid) => {
      maybeFail('cancelBrowserSignin');
      if (!st.signins.some((s) => s.id === sid))
        throw err(410, 'request_expired', 'this sign-in is no longer waiting');
      st.signins = st.signins.filter((s) => s.id !== sid);
      return { ok: true };
    },
    listBrowserLogins: async () => {
      maybeFail('listBrowserLogins');
      return { items: st.logins.map((l) => ({ ...l })) };
    },
    deleteBrowserLogin: async (lid) => {
      maybeFail('deleteBrowserLogin');
      if (!st.logins.some((l) => l.id === lid)) throw notFound('no such saved login');
      st.logins = st.logins.filter((l) => l.id !== lid);
      return { ok: true };
    },

    // ---- screen: status, enablement, kill key ----
    listScreenComputers: async () => {
      maybeFail('listScreenComputers');
      return { items: st.computers.map((c) => ({ ...c })) };
    },
    screenStatus: async (cid) => {
      maybeFail('screenStatus');
      return statusOf(cid);
    },
    setScreenControl: async (cid, enabled) => {
      maybeFail('setScreenControl');
      screenOf(cid).enabled = enabled;
      return statusOf(cid);
    },
    killScreen: async (cid) => {
      maybeFail('killScreen');
      const s = screenOf(cid);
      s.stoppedAt = ts();
      s.stoppedBy = 'user';
      return statusOf(cid);
    },
    resumeScreen: async (cid) => {
      maybeFail('resumeScreen');
      const s = screenOf(cid);
      s.stoppedAt = null;
      s.stoppedBy = null;
      return statusOf(cid);
    },
    screenObservation: async (cid) => {
      maybeFail('screenObservation');
      const s = screenOf(cid);
      if (!s.desktop) throw noDesktop();
      const overrides = setting('screen.tierOverrides');
      const grants = activeGrants(s);
      return {
        computerId: cid,
        width: 1280,
        height: 800,
        takenAt: ts(),
        windows: s.windows.map((w) => ({
          ...w,
          tier: effectiveTier(w.app, w.tier, overrides),
          granted: grants.some((g) => sameApp(g.app, w.app)),
        })),
        tree: '',
        mime: 'image/png',
        image: PNG_1X1,
      };
    },
    screenFrameUrl: (cid, surface, nonce = 0) =>
      `/api/v1/computers/${cid}/screen/frame?surface=${surface}${nonce ? `&n=${nonce}` : ''}`,

    // ---- screen: grants ----
    listScreenGrants: async (cid, all = false) => {
      maybeFail('listScreenGrants');
      const s = screenOf(cid);
      return { items: all ? s.grants.map(grantOut) : activeGrants(s) };
    },
    grantScreenApp: async (cid, body) => {
      maybeFail('grantScreenApp');
      const s = screenOf(cid);
      const b = parse(screenGrantSchema, body);
      const seen = s.windows.find((w) => sameApp(w.app, b.app));
      const tier = effectiveTier(b.app, seen?.tier ?? 'full', setting('screen.tierOverrides'));
      if (tier === 'none')
        throw err(
          403,
          'policy_denied',
          `${b.app} is never controlled by Nova; do this step yourself.`,
          {
            app: b.app,
            tier,
          },
        );
      const existing = activeGrants(s).find((g) => sameApp(g.app, b.app));
      if (existing) return renew(cid, existing.id, b.minutes);
      const minutes = b.minutes ?? setting('screen.grantMinutes');
      const g = grantView({
        id: id('gr'),
        computerId: cid,
        app: b.app,
        tier,
        threadId: b.threadId ?? null,
        createdAt: ts(),
        expiresAt: new Date(now() + minutes * 60_000).toISOString(),
      });
      s.grants = [g, ...s.grants];
      return grantOut(g);
    },
    renewScreenGrant: async (cid, gid) => {
      maybeFail('renewScreenGrant');
      return renew(cid, gid);
    },
    revokeScreenGrant: async (cid, gid) => {
      maybeFail('revokeScreenGrant');
      const g = grantRow(cid, gid);
      g.revokedAt ??= ts();
      return grantOut(g);
    },

    // ---- screen: recorded actions ----
    listScreenActions: async (cid, q = {}) => {
      maybeFail('listScreenActions');
      const s = screenOf(cid);
      const items = [...s.actions]
        .sort((a, b) => b.id.localeCompare(a.id))
        .filter((a) => !q.before || a.id < q.before)
        .slice(0, q.limit ?? 50);
      return { items: items.map((a) => ({ ...a })) };
    },
    screenShotUrl: (cid, aid, which) => `/api/v1/computers/${cid}/screen/actions/${aid}/${which}`,

    // ---- screen: takeover ----
    getTakeover: async (cid) => {
      maybeFail('getTakeover');
      const t = screenOf(cid).takeover;
      return { takeover: t ? { ...t } : null };
    },
    startTakeover: async (cid, surface = 'desktop') => {
      maybeFail('startTakeover');
      const s = screenOf(cid);
      if (s.takeover) throw err(409, 'conflict', 'you have already taken over this computer');
      if (surface === 'browser' && !s.browser)
        throw err(409, 'conflict', 'this computer has no browser the user can take over');
      if (surface === 'desktop' && !s.desktop) throw noDesktop();
      s.takeover = {
        id: id('to'),
        computerId: cid,
        surface,
        startedBy: 'user',
        startedAt: ts(),
        endedAt: null,
        endReason: null,
        inputCount: 0,
      };
      st.sessions = st.sessions.map((x) =>
        x.computerId === cid && surface === 'browser'
          ? { ...x, state: 'paused', pausedBy: 'user' }
          : x,
      );
      return { ...s.takeover };
    },
    takeoverInput: async (cid, body) => {
      maybeFail('takeoverInput');
      const s = screenOf(cid);
      const b = parse(takeoverInputSchema, body);
      if (!s.takeover) throw err(409, 'conflict', 'take over the computer first');
      if ('action' in b && s.takeover.surface !== 'desktop')
        throw err(400, 'validation', 'this takeover is of the browser; send browser input');
      if ('browser' in b && s.takeover.surface !== 'browser')
        throw err(400, 'validation', 'this takeover is of the desktop; send screen input');
      s.takeover.inputCount++;
      return { ok: true, error: null };
    },
    endTakeover: async (cid) => {
      maybeFail('endTakeover');
      const s = screenOf(cid);
      if (!s.takeover) throw err(409, 'conflict', 'this computer is not taken over');
      const ended = { ...s.takeover, endedAt: ts(), endReason: 'returned' };
      s.takeover = null;
      st.sessions = st.sessions.map((x) =>
        x.computerId === cid && x.pausedBy === 'user'
          ? { ...x, state: 'running', pausedBy: null }
          : x,
      );
      return ended;
    },
    screenLivePath: (cid, surface) => `/api/v1/computers/${cid}/screen/live?surface=${surface}`,

    // ---- screen: appshots ----
    captureAppshot: async (cid, body = {}) => {
      maybeFail('captureAppshot');
      const s = screenOf(cid);
      const b = parse(appshotCreateSchema, body);
      let app: string | null = null;
      let title: string | null = null;
      if (b.source === 'browser') {
        if (!s.browser) throw err(409, 'conflict', 'this computer has no browser');
        const page = st.sessions.find((x) => x.computerId === cid);
        app = 'Browser';
        title = page?.title ?? null;
      } else {
        if (!s.desktop) throw noDesktop();
        if (b.source === 'window') {
          const w = b.app
            ? s.windows.find((x) => sameApp(x.app, b.app ?? ''))
            : s.windows.find((x) => x.focused);
          if (!w) throw notFound('no such window on the screen');
          app = w.app;
          title = w.title;
        }
      }
      const shot = appshotView({
        id: id('as'),
        computerId: cid,
        artifactId: id('art'),
        source: b.source,
        app,
        windowTitle: title,
        threadId: b.threadId ?? null,
        capturedAt: ts(),
      });
      st.appshots = [shot, ...st.appshots];
      return { ...shot };
    },
    listAppshots: async (q = {}) => {
      maybeFail('listAppshots');
      return {
        items: st.appshots
          .filter(
            (a) =>
              (!q.computerId || a.computerId === q.computerId) &&
              (!q.threadId || a.threadId === q.threadId),
          )
          .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
          .slice(0, q.limit ?? 50)
          .map((a) => ({ ...a })),
      };
    },
    getAppshot: async (aid) => {
      maybeFail('getAppshot');
      const a = st.appshots.find((x) => x.id === aid);
      if (!a) throw notFound('appshot not found');
      return { ...a };
    },
    appshotImageUrl: (artifactId) => `/api/v1/artifacts/${artifactId}/content`,
  };
}

// ---- test helpers -----------------------------------------------------------------------------

/** Deliver a Hub event to every open stream that listens for it (each view has its own). */
export function emitHub(name: string, payload: Record<string, unknown>): number {
  const streams = FakeEventSource.all.filter((x) => !x.closed && x.listeners.has(name));
  for (const es of streams) es.emit(name, payload);
  return streams.length;
}

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type BrowserMocks = BrowserScreenApi &
  Record<keyof BrowserScreenApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createBrowserHub(
  init: Partial<M6BrowserState> = {},
  settings: () => Record<string, unknown> = () => ({}),
  managed: () => Record<string, unknown> = () => ({}),
) {
  const state = m6BrowserState(init);
  const failNext: Partial<Record<keyof BrowserScreenApi, Error>> = {};
  const impl = m6BrowserImpl(state, {
    id: nextId,
    ts: nextTs,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
    setting: (key) => resolveSetting(key, { global: settings(), managed: managed() }).value,
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as BrowserMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the browser and screen views need, with the main fake Hub's
 * client and the browser and screen parts spread over it (what `createApi` will do), and the fake
 * WebSocket factory for the live view.
 */
export async function renderWithBrowser(
  ui: ReactNode,
  opts: {
    browser?: Partial<M6BrowserState>;
    settings?: Record<string, unknown>;
    /** Values set by managed policy (locked). */
    managed?: Record<string, unknown>;
    mac?: boolean;
    /** Calls that fail the first time (set before the first render). */
    fail?: Partial<Record<keyof BrowserScreenApi, Error>>;
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const fake = createBrowserHub(
    opts.browser,
    () => hub.state.settings,
    () => hub.state.managed,
  );
  Object.assign(fake.failNext, opts.fail);
  const api = { ...hub.api, ...fake.api };
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(opts.mac ?? false),
      webSocket: fakeWebSocket,
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, fake, api: fake.api, state: fake.state, ...utils };
}
