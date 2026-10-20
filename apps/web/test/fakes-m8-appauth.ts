// The fake Hub's M8 parts of web agent W11, in memory, with the Hub's rules:
// - third-party apps (apps/hub/src/appauth.ts, packages/core/src/appauth/service.ts): the consent
//   request is checked like `parseRequest` (member 403 `owner_only`; an unknown app 404
//   `unknown_client`, a missing or unregistered redirect 400 `redirect_uri_required` /
//   `redirect_uri_mismatch` and a repeated client_id or redirect_uri 400 `invalid_request`, all
//   without `redirectTo`; then, with `redirectTo` (the app's redirect with the OAuth error, state
//   and iss): managed policy 403 `managed`, `apps.enabled` off 403 `apps_disabled`, a response
//   type other than `code` 400 `unsupported_response_type`, no S256 challenge 400
//   `invalid_request`, an unknown or unregistered scope 400 `invalid_scope`); the decision denies
//   to `error=access_denied` or approves (kept scopes must be requested: 400 `not_requested`) to a
//   one-use code, adding to an earlier grant; the owner's list and revoke (404 `not_found`; the
//   app stays registered); the registered apps no one authorizes (`listPending`: approved once,
//   or registered within the last hour, newest first; `expiresAt` null once approved) and
//   removing one (404 `not_found`, 409 `conflict` `{reason: authorized}` while it is allowed);
// - OTLP export (apps/hub/src/otlp.ts): owner only; `putOtlpSchema` (400 `validation` issues),
//   enabling refused by managed policy (403 `managed`), a setting managed policy locks refused
//   (403 `managed`), at most 20 headers (400 `{field: headers}`); header values only as set or
//   not; the test needs an endpoint (400 `no_endpoint`) and is refused by managed policy;
// - email OAuth (apps/hub/src/channels.ts, packages/core/src/channels/service.ts) over the M7
//   channels fake: an `auth: oauth` mailbox needs the provider's endpoints and client ID (400
//   `config.<key>`), has no password, an optional `oauthClientSecret`, and is configured once
//   authorized; start answers the provider's page (400 for a binding that does not use OAuth),
//   sign-out revokes; `authorizeMailbox` stands in for the provider's redirect;
// - team (apps/hub/src/team.ts, packages/core/src/team/member-purge.ts): removed members (owner
//   only), purge (`{confirm: true}`; 404, 409 `already_purged`; a failing purge answers `failed`),
//   the export URL, and `GET /team/me/access` (the owner-only routes and limits for a member).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m8appauth: M8AppAuthState`,
// `createHub` defaults it to `m8AppAuthState()`, and `impl` spreads
// `...m8AppAuthImpl(state.m8appauth, { member, setting, managed, channels, channelsState })` after
// the M7 parts, with `channels` the M7 misc part's object (its channel calls are wrapped). Until then tests use `renderW11`, which spreads it over the fakes it needs.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { z } from 'zod';
import {
  APP_SCOPE_TEXT,
  APP_SCOPES,
  OTLP_SIGNALS,
  createChannelBindingM7Schema,
  isAppScope,
  putOtlpSchema,
  resolveSetting,
  type AppConsentView,
  type AppGrantView,
  type AppPendingView,
  type AppScope,
  type ChannelBindingViewM7,
  type ChannelOAuthView,
  type ManagedPolicyView,
  type OtlpSignal,
  type OtlpStatusView,
  type OtlpTestResultView,
  type RemovedMemberView,
  type SettingKey,
  type SettingValue,
  type TeamAccessView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { AppAuthApi } from '../src/appauth/api-m8.ts';
import type { ChannelsM8Api } from '../src/channels/api-m8.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import type { TeamM8Api } from '../src/team/api-m8.ts';
import { TeamRoleProvider, memberSettingsApi } from '../src/team/role.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { createChannelsHub, type M6ChannelsState } from './fakes-m6-channels.ts';
import {
  m7Adapters,
  m7MiscImpl,
  m7MiscState,
  type M7MiscApi,
  type M7MiscState,
} from './fakes-m7-misc.ts';
import { MEMBER_ID, OWNER_ID, m7TeamState } from './fakes-m7-team.ts';

const T0 = '2026-10-01T12:00:00.000Z';
/** An unapproved registration lapses after this long (AppAuthService `pendingTtlMs`). */
const PENDING_TTL_MS = 3_600_000;
let seq = 0;
const nid = (p: string) => `${p}${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 3, 9, 0, clock++)).toISOString();

/** The Hub's address as the browser reaches it (the issuer and the redirect base). */
const origin = () => window.location.origin;

// ---- builders ----------------------------------------------------------------------------------

export interface FakeAppClient {
  id: string;
  name: string;
  redirectUris: string[];
  scopes: AppScope[];
  registeredAt: string;
  approved: boolean;
}

export function appClient(over: Partial<FakeAppClient> = {}): FakeAppClient {
  return {
    id: 'app_notes',
    name: 'Notes Desk',
    redirectUris: ['http://127.0.0.1/callback'],
    scopes: ['account:read', 'threads:read', 'memory:read'],
    registeredAt: T0,
    approved: false,
    ...over,
  };
}

export function appGrant(over: Partial<AppGrantView> = {}): AppGrantView {
  return {
    id: nid('auth'),
    clientId: 'app_notes',
    name: 'Notes Desk',
    redirectUris: ['http://127.0.0.1/callback'],
    scopes: ['threads:read'],
    sessions: 1,
    createdAt: T0,
    lastUsedAt: null,
    ...over,
  };
}

/** A valid S256 challenge (43 base64url characters). */
export const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** An app's authorization request, as the app sends it to `/authorize`. */
export function consentQuery(over: Record<string, string | null> = {}): string {
  const p: Record<string, string | null> = {
    client_id: 'app_notes',
    redirect_uri: 'http://127.0.0.1:53682/callback',
    response_type: 'code',
    scope: 'account:read threads:read',
    state: 'xyz',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== null) q.set(k, v);
  return q.toString();
}

export function removedMember(over: Partial<RemovedMemberView> = {}): RemovedMemberView {
  return {
    accountId: 'acc-robin',
    displayName: 'Robin',
    removedAt: T0,
    removedBy: OWNER_ID,
    status: 'scheduled',
    purgeAfter: new Date(Date.now() + 23 * 86_400_000).toISOString(),
    purgedAt: null,
    cause: null,
    error: null,
    counts: null,
    exportable: true,
    cleanupPending: false,
    ...over,
  };
}

const emptyCounts = (): Record<OtlpSignal, number> => ({ traces: 0, metrics: 0, logs: 0 });

// ---- state -------------------------------------------------------------------------------------

export interface FakeOtlp {
  enabled: boolean;
  endpoint: string;
  /** Header name -> its value in the vault (null: the reference is there, the value is not). */
  headers: Record<string, string | null>;
  signals: Record<OtlpSignal, boolean>;
  includeContent: boolean;
  sent: Record<OtlpSignal, number>;
  queued: Record<OtlpSignal, number>;
  dropped: Record<OtlpSignal, number>;
  failures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
}

export interface M8AppAuthState {
  clients: FakeAppClient[];
  grants: AppGrantView[];
  /** One-use codes issued by approvals, newest last. */
  codes: string[];
  /** The OTLP export's settings, header values and counters. */
  otlp: FakeOtlp;
  /** What the collector answers to a test. */
  otlpTest: OtlpTestResultView;
  /** Email OAuth by credential group (the mailbox). */
  mailOAuth: Record<string, ChannelOAuthView>;
  /** The provider's authorization page `startChannelOAuth` answers. */
  providerUrl: string;
  removed: RemovedMemberView[];
  /** What a purge does. */
  purgeOutcome: 'purged' | 'failed';
}

export function m8AppAuthState(init: Partial<M8AppAuthState> = {}): M8AppAuthState {
  return {
    clients: [appClient()],
    grants: [],
    codes: [],
    otlp: {
      enabled: false,
      endpoint: '',
      headers: {},
      signals: { traces: true, metrics: true, logs: true },
      includeContent: false,
      sent: emptyCounts(),
      queued: emptyCounts(),
      dropped: emptyCounts(),
      failures: 0,
      lastError: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
    },
    otlpTest: { ok: true, status: 200, error: null },
    mailOAuth: {},
    providerUrl: 'https://login.mail.example.com/oauth2/authorize?client_id=nova',
    removed: [],
    purgeOutcome: 'purged',
    ...init,
  };
}

// ---- errors ------------------------------------------------------------------------------------

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });
const ownerOnly = (why: string) =>
  fail(403, 'policy_denied', `only the owner of this Hub can change ${why}`, {
    reason: 'owner_only',
  });
const zodFail = (err: z.ZodError) =>
  fail(400, 'validation', 'request failed validation', {
    issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
const fieldError = (field: string, message: string) => fail(400, 'validation', message, { field });
const copy = <T>(v: T): T => structuredClone(v);

// ---- implementation ----------------------------------------------------------------------------

export type M8AppAuthApi = AppAuthApi & ChannelsM8Api & TeamM8Api;

/** The channel calls this part widens for email OAuth (over the M7 channels fake). */
export type M8ChannelOverrides = Pick<
  M7MiscApi,
  | 'listChannels'
  | 'getChannel'
  | 'createChannel'
  | 'updateChannel'
  | 'connectChannel'
  | 'disconnectChannel'
>;

export interface M8AppAuthHelpers {
  /** The account behind the requests is a member (owner-only routes refuse). */
  member: () => boolean;
  setting: <K extends SettingKey>(key: K) => SettingValue<K>;
  /** The managed layer (a key in it is locked). */
  managed: () => Record<string, unknown>;
  /** The M7 channels calls this part wraps, and their state. */
  channels: M8ChannelOverrides;
  channelsState: M6ChannelsState;
  ts?: () => string;
}

const MAIL_OAUTH_CONFIG = [
  'auth',
  'oauthAuthUrl',
  'oauthTokenUrl',
  'oauthRevokeUrl',
  'oauthClientId',
  'oauthScopes',
] as const;

export function m8AppAuthImpl(
  st: M8AppAuthState,
  h: M8AppAuthHelpers,
): M8AppAuthApi & M8ChannelOverrides & { authorizeMailbox: (bindingId: string) => void } {
  const ts = h.ts ?? nextTs;
  const owner = (why: string) => {
    if (h.member()) throw ownerOnly(why);
  };

  // ---- apps --------------------------------------------------------------------------------
  const allowed = (): 'ok' | 'managed' | 'apps_disabled' => {
    const r = h.setting('managed.restrict');
    if (r.layers.some((l) => l.apps === false)) return 'managed';
    return h.setting('apps.enabled') ? 'ok' : 'apps_disabled';
  };
  const redirectWith = (uri: string, params: Record<string, string | undefined>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };
  const loopback = (uri: string) => {
    try {
      const u = new URL(uri);
      return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]');
    } catch {
      return false;
    }
  };
  const matches = (registered: string[], requested: string) => {
    if (registered.includes(requested)) return true;
    if (!loopback(requested)) return false;
    const r = new URL(requested);
    return registered.some((c) => {
      if (!loopback(c)) return false;
      const u = new URL(c);
      return u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    });
  };

  function parseRequest(query: string) {
    owner("the Hub's app authorizations");
    const p = new URLSearchParams(query.replace(/^\?/, ''));
    if (p.getAll('client_id').length > 1 || p.getAll('redirect_uri').length > 1)
      throw fail(400, 'validation', 'the request repeats client_id or redirect_uri', {
        reason: 'invalid_request',
      });
    const client = st.clients.find((c) => c.id === p.get('client_id'));
    if (!client)
      throw fail(404, 'not_found', 'this app is not registered with the Hub', {
        reason: 'unknown_client',
      });
    const requested = p.get('redirect_uri');
    if (!requested)
      throw fail(400, 'validation', 'the request names no redirect URI', {
        reason: 'redirect_uri_required',
      });
    if (!matches(client.redirectUris, requested))
      throw fail(400, 'validation', 'the redirect URI is not one this app registered', {
        reason: 'redirect_uri_mismatch',
      });
    const state = p.get('state') ?? undefined;
    const back = (params: Record<string, string>) =>
      redirectWith(requested, { ...params, state, iss: origin() });
    const refuse = (
      status: number,
      code: string,
      error: string,
      description: string,
      reason = error,
    ) =>
      fail(status, code, description, {
        reason,
        redirectTo: back({ error, error_description: description }),
      });
    const a = allowed();
    if (a !== 'ok')
      throw refuse(
        403,
        'policy_denied',
        'access_denied',
        a === 'managed'
          ? 'your organization turned app authorization off'
          : 'app authorization is turned off on this Hub',
        a,
      );
    if (p.get('response_type') !== 'code')
      throw refuse(
        400,
        'validation',
        'unsupported_response_type',
        'only response_type=code is supported',
      );
    if (p.get('code_challenge_method') !== 'S256')
      throw refuse(
        400,
        'validation',
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required',
      );
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? ''))
      throw refuse(400, 'validation', 'invalid_request', 'code_challenge is not an S256 challenge');
    const raw = p.get('scope');
    let scopes: AppScope[];
    if (raw === null) scopes = [...client.scopes];
    else {
      const list = raw.split(/\s+/).filter(Boolean);
      const unknown = list.filter((s) => !isAppScope(s));
      if (unknown.length)
        throw refuse(400, 'validation', 'invalid_scope', `unknown scope ${unknown.join(' ')}`);
      scopes = APP_SCOPES.filter((s) => list.includes(s));
    }
    const extra = scopes.filter((s) => !client.scopes.includes(s));
    if (extra.length)
      throw refuse(
        400,
        'validation',
        'invalid_scope',
        `the app did not register ${extra.join(' ')}`,
      );
    if (!scopes.length) throw refuse(400, 'validation', 'invalid_scope', 'no scope requested');
    return { client, requested, scopes, back };
  }

  /** Where a redirect goes, as the pending list shows it (AppAuthService `redirectHost`). */
  const redirectHost = (uri: string) => {
    try {
      const u = new URL(uri);
      return u.protocol === 'http:' ? u.host : u.protocol.slice(0, -1);
    } catch {
      return uri.slice(0, 100);
    }
  };
  const kindOf = (uri: string): 'loopback' | 'private_scheme' =>
    loopback(uri) ? 'loopback' : 'private_scheme';

  const apps: AppAuthApi = {
    getAppConsent: async (query) => {
      const req = parseRequest(query);
      const grant = st.grants.find((g) => g.clientId === req.client.id);
      const view: AppConsentView = {
        client: {
          id: req.client.id,
          name: req.client.name,
          redirectUri: req.requested,
          redirectKind: kindOf(req.requested),
          registeredAt: req.client.registeredAt,
        },
        scopes: req.scopes.map((scope) => ({
          scope,
          ...APP_SCOPE_TEXT[scope],
          granted: grant?.scopes.includes(scope) ?? false,
        })),
        authorized: grant !== undefined,
      };
      return view;
    },
    decideAppConsent: async (body) => {
      const req = parseRequest(body.query);
      if (body.decision === 'deny')
        return {
          redirectTo: req.back({ error: 'access_denied', error_description: 'the owner said no' }),
        };
      const kept = body.scopes ?? req.scopes;
      const extra = kept.filter((s) => !req.scopes.includes(s));
      if (extra.length)
        throw fail(400, 'validation', `the app did not ask for ${extra.join(' ')}`, {
          field: 'scopes',
          reason: 'not_requested',
        });
      const at = ts();
      const existing = st.grants.find((g) => g.clientId === req.client.id);
      if (existing)
        existing.scopes = APP_SCOPES.filter((s) => existing.scopes.includes(s) || kept.includes(s));
      else
        st.grants.push(
          appGrant({
            clientId: req.client.id,
            name: req.client.name,
            redirectUris: [...req.client.redirectUris],
            scopes: APP_SCOPES.filter((s) => kept.includes(s)),
            sessions: 0,
            createdAt: at,
          }),
        );
      req.client.approved = true;
      const code = nid('code');
      st.codes.push(code);
      return { redirectTo: req.back({ code }) };
    },
    listApps: async () => {
      owner("the Hub's app authorizations");
      return { items: copy(st.grants) };
    },
    revokeApp: async (id) => {
      owner("the Hub's app authorizations");
      if (!st.grants.some((g) => g.id === id)) throw fail(404, 'not_found', 'app not found');
      st.grants = st.grants.filter((g) => g.id !== id);
      return { ok: true };
    },
    listPendingApps: async () => {
      owner("the Hub's app authorizations");
      const now = Date.now();
      const items: AppPendingView[] = st.clients
        .filter(
          (c) =>
            !st.grants.some((g) => g.clientId === c.id) &&
            (c.approved || Date.parse(c.registeredAt) + PENDING_TTL_MS > now),
        )
        .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt) || b.id.localeCompare(a.id))
        .map((c) => ({
          clientId: c.id,
          name: c.name,
          redirectHosts: [...new Set(c.redirectUris.map(redirectHost))],
          scopes: [...c.scopes],
          registeredAt: c.registeredAt,
          expiresAt: c.approved
            ? null
            : new Date(Date.parse(c.registeredAt) + PENDING_TTL_MS).toISOString(),
        }));
      return { items };
    },
    removePendingApp: async (clientId) => {
      owner("the Hub's app authorizations");
      if (!st.clients.some((c) => c.id === clientId)) throw fail(404, 'not_found', 'app not found');
      if (st.grants.some((g) => g.clientId === clientId))
        throw fail(409, 'conflict', 'this app is authorized: revoke it first', {
          reason: 'authorized',
        });
      st.clients = st.clients.filter((c) => c.id !== clientId);
      return { ok: true };
    },

    // ---- OTLP ------------------------------------------------------------------------------
    getOtlp: async () => {
      owner("the Hub's telemetry export");
      return otlpStatus();
    },
    updateOtlp: async (body) => {
      owner("the Hub's telemetry export");
      const parsed = putOtlpSchema.safeParse(body);
      if (!parsed.success) throw zodFail(parsed.error);
      const b = parsed.data;
      if (b.enabled === true && managedOff())
        throw fail(403, 'policy_denied', 'Telemetry export is off: managed policy', {
          reason: 'managed',
        });
      const locked = (key: string) => {
        if (key in h.managed())
          throw fail(403, 'policy_denied', `${key} is managed by your organization`, {
            reason: 'managed',
          });
      };
      const o = st.otlp;
      if (b.headers) {
        locked('telemetry.otlp.headers');
        const next = { ...o.headers };
        for (const [name, value] of Object.entries(b.headers)) {
          const existing = Object.keys(next).find((k) => k.toLowerCase() === name.toLowerCase());
          if (existing) delete next[existing];
          if (value !== null) next[name] = value;
        }
        if (Object.keys(next).length > 20)
          throw fail(400, 'validation', 'at most 20 headers', { field: 'headers' });
        o.headers = next;
      }
      if (b.endpoint !== undefined) {
        locked('telemetry.otlp.endpoint');
        o.endpoint = b.endpoint;
      }
      if (b.signals) {
        locked('telemetry.otlp.signals');
        o.signals = { ...o.signals, ...b.signals };
      }
      if (b.includeContent !== undefined) {
        locked('telemetry.otlp.includeContent');
        o.includeContent = b.includeContent;
      }
      if (b.enabled !== undefined) {
        locked('telemetry.otlp.enabled');
        o.enabled = b.enabled;
      }
      return otlpStatus();
    },
    testOtlp: async () => {
      owner("the Hub's telemetry export");
      if (managedOff())
        throw fail(403, 'policy_denied', 'Telemetry export is off: managed policy', {
          reason: 'managed',
        });
      if (!st.otlp.endpoint)
        throw fail(400, 'validation', 'name a collector endpoint first', {
          field: 'endpoint',
          reason: 'no_endpoint',
        });
      return copy(st.otlpTest);
    },
  };

  function managedOff(): boolean {
    return h.setting('managed.restrict').layers.some((l) => l.telemetryExport === false);
  }

  function otlpStatus(): OtlpStatusView {
    const o = st.otlp;
    const off = managedOff();
    return {
      enabled: o.enabled,
      endpoint: o.endpoint,
      headers: Object.entries(o.headers).map(([name, value]) => ({ name, set: value !== null })),
      signals: { ...o.signals },
      includeContent: o.includeContent,
      managedOff: off,
      active: o.enabled && !off && o.endpoint !== '' && OTLP_SIGNALS.some((k) => o.signals[k]),
      queued: { ...o.queued },
      dropped: { ...o.dropped },
      sent: { ...o.sent },
      failures: o.failures,
      lastError: o.lastError,
      lastSuccessAt: o.lastSuccessAt,
      nextAttemptAt: o.nextAttemptAt,
    };
  }

  // ---- email OAuth over the M7 channels ------------------------------------------------------
  const cs = h.channelsState;
  const group = (bid: string) => cs.groups[bid] ?? bid;
  const stored = (bid: string) => {
    const b = cs.bindings.find((x) => x.id === bid) as ChannelBindingViewM7 | undefined;
    if (!b) throw fail(404, 'not_found', 'channel binding not found');
    return b;
  };
  const oauthOf = (b: ChannelBindingViewM7) => b.kind === 'email' && b.config.auth === 'oauth';
  const NEEDS: ChannelOAuthView = {
    status: 'needs_auth',
    scopes: [],
    expiresAt: null,
    authorizedAt: null,
    lastError: null,
  };
  /** The view as the M8 Hub derives it for an OAuth mailbox. */
  const m8View = (v: ChannelBindingViewM7): ChannelBindingViewM7 => {
    if (!oauthOf(v)) return v;
    const g = group(v.id);
    const oauth = copy(st.mailOAuth[g] ?? NEEDS);
    return {
      ...v,
      credentials: [{ name: 'oauthClientSecret', set: `${g}/oauthClientSecret` in cs.secrets }],
      status: !cs.enabled[v.id]
        ? 'disconnected'
        : oauth.status === 'connected'
          ? 'connected'
          : 'not_configured',
      oauth,
    };
  };
  const setConfig = (bid: string, config: Record<string, string | null>) => {
    cs.bindings = cs.bindings.map((x) => (x.id === bid ? { ...x, config, updatedAt: ts() } : x));
  };
  const oauthCheck = (config: Record<string, string | null | undefined>) => {
    if (config.auth !== 'oauth') return;
    for (const key of ['oauthAuthUrl', 'oauthTokenUrl', 'oauthClientId'] as const)
      if (!config[key]) throw fieldError(`config.${key}`, `OAuth sign-in needs ${key}`);
  };
  const m7 = h.channels;

  const channels: M8ChannelOverrides = {
    listChannels: async (q) => {
      const out = await m7.listChannels(q);
      return { ...out, items: out.items.map((b) => m8View(b)) };
    },
    getChannel: async (bid) => m8View(await m7.getChannel(bid)),
    connectChannel: async (bid) => m8View(await m7.connectChannel(bid)),
    disconnectChannel: async (bid) => m8View(await m7.disconnectChannel(bid)),
    createChannel: async (body) => {
      const parsed = createChannelBindingM7Schema.safeParse(body);
      if (!parsed.success) throw zodFail(parsed.error);
      const req = parsed.data;
      if (req.kind !== 'email' || req.shareCredentialsWith || req.config?.auth !== 'oauth')
        return m8View(await m7.createChannel(body));
      if (req.credentials) throw fieldError('credentials', 'an OAuth mailbox has no password');
      oauthCheck(req.config);
      // The M7 part stores a password; an OAuth mailbox has none, only an optional secret.
      const { oauthClientSecret, ...rest } = req;
      const made = await m7.createChannel({ ...rest, credentials: { password: 'unused' } });
      const g = group(made.id);
      delete cs.secrets[`${g}/password`];
      if (oauthClientSecret) cs.secrets[`${g}/oauthClientSecret`] = oauthClientSecret;
      return m8View(await m7.getChannel(made.id));
    },
    updateChannel: async (bid, body) => {
      const b = stored(bid);
      if (b.kind !== 'email') return m8View(await m7.updateChannel(bid, body));
      // The OAuth settings and secret are this part's; the rest goes to the M7 part.
      const { config: givenConfig, credentials: givenCredentials, ...others } = body;
      const config: Record<string, string | null> = { ...givenConfig };
      const oauth: Record<string, string> = {};
      for (const k of MAIL_OAUTH_CONFIG) {
        const was = b.config[k];
        if (typeof was === 'string') oauth[k] = was;
        if (k in config) {
          const v = config[k];
          if (v === null || v === undefined) delete oauth[k];
          else oauth[k] = v;
          delete config[k];
        }
      }
      oauthCheck(oauth);
      const credentials: Record<string, string> = { ...givenCredentials };
      const secret = credentials.oauthClientSecret;
      delete credentials.oauthClientSecret;
      const rest = {
        ...others,
        ...(Object.keys(config).length ? { config } : {}),
        ...(Object.keys(credentials).length ? { credentials } : {}),
      };
      if (Object.keys(rest).length) await m7.updateChannel(bid, rest);
      const merged: Record<string, string | null> = { ...stored(bid).config };
      for (const k of MAIL_OAUTH_CONFIG) delete merged[k];
      setConfig(bid, { ...merged, ...oauth });
      if (secret) cs.secrets[`${group(bid)}/oauthClientSecret`] = secret;
      return m8View(await m7.getChannel(bid));
    },
  };

  const channelsM8: ChannelsM8Api = {
    startChannelOAuth: async (bid) => {
      const b = stored(bid);
      if (!oauthOf(b)) throw fieldError('config.auth', 'this channel does not sign in with OAuth');
      return {
        authorizeUrl: `${st.providerUrl}&state=${nid('st')}`,
        redirectUri: `${origin()}/api/v1/channels/oauth/callback`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    revokeChannelOAuth: async (bid) => {
      const b = stored(bid);
      if (!oauthOf(b)) throw fieldError('config.auth', 'this channel does not sign in with OAuth');
      st.mailOAuth[group(bid)] = { ...NEEDS };
      return m8View(await m7.getChannel(bid));
    },
  };

  // ---- team --------------------------------------------------------------------------------
  const team: TeamM8Api = {
    listRemovedMembers: async () => {
      owner("the Hub's people");
      return { items: copy(st.removed) };
    },
    purgeRemovedMember: async (accountId) => {
      owner("the Hub's people");
      const m = st.removed.find((x) => x.accountId === accountId);
      if (!m) throw fail(404, 'not_found', 'no such removed member');
      if (m.status === 'purged')
        throw fail(409, 'conflict', "this member's data was already purged", {
          reason: 'already_purged',
        });
      const next: RemovedMemberView =
        st.purgeOutcome === 'purged'
          ? {
              ...m,
              displayName: null,
              status: 'purged',
              purgeAfter: null,
              purgedAt: ts(),
              cause: 'request',
              error: null,
              counts: {
                rows: { thread: 12, message: 240, memory_item: 8 },
                blobs: 3,
                secrets: 2,
                folders: 1,
              },
              exportable: false,
            }
          : { ...m, status: 'failed', error: 'the database was busy' };
      st.removed = st.removed.map((x) => (x.accountId === accountId ? next : x));
      return copy(next);
    },
    removedMemberExportUrl: (accountId) =>
      `/api/v1/team/removed/${encodeURIComponent(accountId)}/export`,
    getTeamAccess: async () => accessView(h.member()),
  };

  return {
    ...apps,
    ...channels,
    ...channelsM8,
    ...team,
    authorizeMailbox: (bid) => {
      st.mailOAuth[group(bid)] = {
        status: 'connected',
        scopes: ['https://mail.example.com/imap', 'https://mail.example.com/smtp'],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        authorizedAt: ts(),
        lastError: null,
      };
    },
  };
}

/** `GET /api/v1/team/me/access` as the Hub answers it (a few of the owner-only routes). */
export function accessView(member: boolean): TeamAccessView {
  return {
    role: member ? 'member' : 'owner',
    refused: member
      ? [
          { method: 'GET', route: '/api/v1/settings', why: "the Hub's settings" },
          { method: 'PATCH', route: '/api/v1/settings', why: "the Hub's settings" },
          {
            method: 'POST',
            route: '/api/v1/mcp/bundles/install',
            why: 'programs on the Hub machine',
          },
          {
            method: 'POST',
            route: '/api/v1/mcp/bundles/preview',
            why: 'programs on the Hub machine',
          },
          {
            method: 'GET',
            route: '/api/v1/telemetry/otlp',
            why: "the Hub's telemetry export (FR-223)",
          },
          { method: 'GET', route: '/api/v1/apps', why: 'which apps may use the Hub (FR-222)' },
        ]
      : [],
    limits: {
      stdioMcpServers: !member,
      privateAddresses: !member,
      narrowingOnlyAllowLists: member,
      hubSettings: !member,
    },
  };
}

// ---- rendering ---------------------------------------------------------------------------------

type M8Impl = ReturnType<typeof m8AppAuthImpl>;

/** Every call of this part as a spy over the in-memory implementation. */
export type M8AppAuthMocks = {
  [K in keyof M8Impl]: M8Impl[K] extends (...a: infer A) => infer R
    ? Mock<(...a: A) => R>
    : M8Impl[K];
};

export interface RenderW11Options {
  member?: boolean;
  settings?: Record<string, unknown>;
  managed?: Record<string, unknown>;
  /** What `GET /api/v1/managed` answers: where the policy comes from (the lock notes' source). */
  policy?: ManagedPolicyView;
  appauth?: Partial<M8AppAuthState>;
  channels?: Partial<M6ChannelsState>;
  misc?: Partial<M7MiscState>;
  /** Calls that fail once, from the first render on. */
  fail?: Partial<Record<string, Error>>;
}

/**
 * Render `ui` with the main fake Hub's client, the M6/M7 channels parts and this part spread over
 * them (what `createApi` will do), the team role (Sam the owner, or Alex the member, whose
 * settings are their own) and the app's providers.
 */
export async function renderW11(ui: ReactNode, opts: RenderW11Options = {}) {
  const member = opts.member ?? false;
  const hub = createHub({ m7team: m7TeamState({ me: member ? MEMBER_ID : OWNER_ID }) });
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  if (opts.policy) hub.state.m8managed.view = opts.policy;
  const setting = <K extends SettingKey>(k: K): SettingValue<K> =>
    resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value;
  const channelsHub = createChannelsHub({
    adapters: m7Adapters().map((a) => ({ ...a })) as unknown as M6ChannelsState['adapters'],
    ...opts.channels,
  });
  const failNext: Partial<Record<string, Error>> = { ...opts.fail };
  const maybeFail = (name: string) => {
    const e = failNext[name];
    if (e) {
      delete failNext[name];
      throw e;
    }
  };
  const misc = m7MiscImpl(m7MiscState(opts.misc), {
    m6channels: channelsHub.state,
    m6browser: hub.state.m6browser,
    m65network: hub.state.m65network,
    id: nid,
    ts: nextTs,
    setting,
    maybeFail: (name) => maybeFail(name),
  });
  const state = m8AppAuthState(opts.appauth);
  const impl = m8AppAuthImpl(state, {
    member: () => member,
    setting,
    managed: () => hub.state.managed,
    channels: misc,
    channelsState: channelsHub.state,
  });
  const api8 = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [
      k,
      typeof fn === 'function'
        ? vi.fn(async (...a: unknown[]) => {
            maybeFail(k);
            return (fn as (...x: unknown[]) => unknown)(...a);
          })
        : fn,
    ]),
  ) as unknown as M8AppAuthMocks;
  // The export URL and the provider stand-in are plain functions, not requests.
  api8.removedMemberExportUrl = vi.fn(impl.removedMemberExportUrl);
  api8.authorizeMailbox = vi.fn(impl.authorizeMailbox);
  const api = { ...hub.api, ...channelsHub.api, ...misc, ...api8 };
  const store = member ? memberSettingsApi(hub.api) : api;
  const { settings } = await store.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, {
      children: createElement(TeamRoleProvider, {
        role: member ? 'member' : 'owner',
        children: ui,
      }),
    }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api: store, initial: settings, children: inner }),
    }),
  );
  return {
    hub,
    api: api8,
    state,
    channels: channelsHub.state,
    failNext,
    ...utils,
  };
}
