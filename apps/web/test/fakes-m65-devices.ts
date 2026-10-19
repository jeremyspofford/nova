// The fake Hub's M6.5 Add Device and device-management part (FR-132, FR-140), in memory, with the
// Hub's rules from apps/hub/src/add-device.ts, packages/core/src/pairing/ and Add Device protocol
// v2 (commit, then reveal):
// - owner side: a start makes a single-use 8-character code (5 minutes; at most 20 an hour, 429
//   `start_rate_limited`; 403 `add_device_disabled` when adding is off; 400 `relay_unavailable`
//   for the Relay without one); requests are listed only once revealed; approve needs the six
//   digits the device shows (400 `confirmation_mismatch`), a decided request answers 409
//   `decided` and an expired one 410 `expired`; scopes of a revoked device answer 409 `revoked`;
//   revoke works for every kind and is idempotent; unknown ids are 404.
// - device side (`joinFetch`, a `fetch` for the public routes): `complete` checks the code (five
//   wrong ones burn the pairing; 401 `wrong_code` with `attemptsLeft`; 410 `expired` for a used,
//   expired or unknown pairing; 400 `kind_not_allowed`) and answers with the Hub's nonce;
//   `reveal` checks the signature and the commitment (a bad one burns the request, 401
//   `bad_reveal`; a second reveal is 409 `already_revealed`) and answers with the v2
//   confirmation and the Hub identity's signature, both computed here with node:crypto,
//   independently of the page's WebCrypto code; `status` checks the signature, a time within
//   60 s and later than the last accepted one (401 `replayed`, `stale_time`, `bad_signature`),
//   and hands the session grant out once.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m65devices: M65DevicesState`,
// `createHub` defaults it to `m65DevicesState()`, and `impl` spreads
// `...m65DevicesImpl(state.m65devices, { m6: state.m6devices, id, ts: () => ts(), maybeFail })`.
// Until then tests use `renderWithAllDevices`, which spreads it over the M6 devices fake.
/* eslint-disable @typescript-eslint/require-await */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  ADD_DEVICE_KINDS_BY_ROLE,
  ADD_DEVICE_SIGNATURE_HEADER,
  ADD_DEVICE_TIME_HEADER,
  addDeviceStartSchema,
  deviceScopesSchema,
  type AddDeviceKind,
  type AddDeviceRequestView,
  type AddDeviceRole,
  type AddDeviceTransport,
  type DeviceSummaryView,
  type DeviceView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { AddDeviceApi, AddDeviceStarted } from '../src/devices/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { createDevicesHub, type M6DevicesState } from './fakes-m6-devices.ts';

const T0 = '2026-10-01T12:00:00.000Z';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const HUB_URL = 'http://hub.test';
let n = 0;

// ---- builders ------------------------------------------------------------------------------------

export function summaryView(over: Partial<DeviceSummaryView> = {}): DeviceSummaryView {
  return {
    id: `sd${++n}`,
    name: 'Phone',
    kind: 'client',
    addedAs: 'browser',
    roles: ['client'],
    scopes: [],
    platform: 'iOS',
    status: 'active',
    fingerprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    sessions: 1,
    novadVersion: null,
    lastSeenAt: T0,
    createdAt: T0,
    ...over,
  };
}

/** A request the owner sees (already revealed), with confirmation 123456 unless given. */
export function requestView(over: Partial<AddDeviceRequestView> = {}): AddDeviceRequestView {
  return {
    id: `rq${++n}`,
    pairingId: 'pr1',
    role: 'client',
    kind: 'browser',
    name: 'Safari on iPhone',
    platform: 'iOS',
    scopes: [],
    confirmation: '123456',
    fingerprint: 'ffeeddccbbaa',
    via: 'direct',
    status: 'pending',
    deviceId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    decidedAt: null,
    ...over,
  };
}

// ---- state ---------------------------------------------------------------------------------------

export interface FakePairing {
  id: string;
  role: AddDeviceRole;
  scopes: string[];
  name: string | null;
  transport: AddDeviceTransport;
  /** Canonical code (no dash). */
  code: string;
  status: 'open' | 'used' | 'burned' | 'expired';
  attempts: number;
  expiresAt: string;
}

/** A request with what the device side needs (public key, commitment, nonces). */
export interface FakeRequest {
  view: AddDeviceRequestView;
  /** `committed` until revealed (then the view's status counts). */
  phase: 'committed' | 'revealed';
  publicKey: string;
  commitment: string;
  hubNonce: string;
  code: string;
  lastPoll: number;
  granted: boolean;
}

export interface M65DevicesState {
  /** Devices that do not run novad (browsers, apps, nova-compute nodes, approved-not-registered). */
  others: DeviceSummaryView[];
  /** Scopes of novad devices (their M6 view has none). */
  novadScopes: Record<string, string[]>;
  pairings: FakePairing[];
  requests: FakeRequest[];
  bootstrap: AddDeviceStarted['bootstrap'];
  addEnabled: boolean;
  relay: { relayUrl: string; relayPairingId: string } | null;
  startsThisHour: number;
  /** The Hub identity; null for a Hub without one (hello answers null fields). */
  hubKey: {
    publicKey: string;
    fingerprint: string;
    privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  } | null;
  /** What the Hub's clock reads (ms). */
  now: () => number;
  /** A man in the middle: what the reveal answers instead. */
  tamper: { confirmation?: string; hubSignature?: string | null } | null;
  /** Every accepted status poll: [requestId, time, at (ms)]. */
  polls: { requestId: string; time: number; at: number }[];
  /** Session tokens handed out to browsers (as the cookie). */
  sessions: string[];
  /** Codes handed out by the next starts, canonical (else random). */
  nextCodes: string[];
  /** Answer the next public calls with no connection. */
  offline: number;
}

export function hubIdentity(): NonNullable<M65DevicesState['hubKey']> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return {
    publicKey: raw,
    fingerprint: createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('base64url'),
    privateKey,
  };
}

export function m65DevicesState(init: Partial<M65DevicesState> = {}): M65DevicesState {
  return {
    others: [],
    novadScopes: {},
    pairings: [],
    requests: [],
    bootstrap: {
      command: `curl -fsSL ${HUB_URL}/api/v1/agent/dist/novad-linux-amd64 | sh -s -- install --code XXXX`,
      why: null,
      powershell: null,
    },
    addEnabled: true,
    relay: null,
    startsThisHour: 0,
    hubKey: null,
    now: () => Date.now(),
    tamper: null,
    polls: [],
    sessions: [],
    nextCodes: [],
    offline: 0,
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = (what = 'device') => err(404, 'not_found', `${what} not found`);

export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s : null;
}

const display = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

function digits(text: string): string {
  let r = 0;
  for (const b of createHash('sha256').update(text, 'utf8').digest()) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}

/** The v2 confirmation, computed with node:crypto (independently of the page's WebCrypto). */
export function confirmationV2(f: {
  fingerprint: string;
  pairingId: string;
  publicKey: string;
  code: string;
  deviceNonce: string;
  hubNonce: string;
}): string {
  return digits(
    [
      'nova-add-device-v2',
      f.fingerprint,
      f.pairingId,
      f.publicKey,
      f.code,
      f.deviceNonce,
      f.hubNonce,
    ].join('|'),
  );
}

function verifyEd25519(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** The summary the Hub lists for a novad device. */
function novadSummary(d: DeviceView, scopes: string[]): DeviceSummaryView {
  return {
    id: d.id,
    name: d.name,
    kind: d.roles[0] ?? 'client',
    addedAs: null,
    roles: d.roles,
    scopes,
    platform: d.platform,
    status: d.status,
    fingerprint: `fp-${d.id}`.padEnd(64, '0'),
    sessions: 0,
    novadVersion: d.novadVersion,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
  };
}

export function m65DevicesImpl(
  st: M65DevicesState,
  deps: {
    m6: M6DevicesState;
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof AddDeviceApi) => void;
  },
): AddDeviceApi {
  const { m6, id, maybeFail } = deps;
  const copy = <T>(v: T): T => structuredClone(v);
  const all = (): DeviceSummaryView[] => [
    ...m6.devices.map((d) => novadSummary(d, st.novadScopes[d.id] ?? [])),
    ...st.others,
  ];
  const nowIso = () => new Date(st.now()).toISOString();
  const pending = (r: FakeRequest) => r.phase === 'revealed';
  const sweep = () => {
    for (const r of st.requests)
      if (r.view.status === 'pending' && r.view.expiresAt <= nowIso())
        r.view = { ...r.view, status: 'expired', decidedAt: nowIso() };
  };
  const pendingFor = (rid: string): FakeRequest => {
    const r = st.requests.find((x) => x.view.id === rid && pending(x));
    if (!r) throw notFound('request');
    if (r.view.status === 'pending' && r.view.expiresAt <= nowIso()) {
      sweep();
      throw err(410, 'request_expired', 'this request has expired', { reason: 'expired' });
    }
    if (r.view.status !== 'pending')
      throw err(409, 'conflict', `this request was already ${r.view.status}`, {
        reason: 'decided',
        status: r.view.status,
      });
    return r;
  };

  return {
    listAllDevices: async () => {
      maybeFail('listAllDevices');
      return { items: copy(all()) };
    },
    startAddDevice: async (body) => {
      maybeFail('startAddDevice');
      const r = addDeviceStartSchema.safeParse(body);
      if (!r.success) throw err(400, 'validation', r.error.issues[0]?.message ?? 'Invalid');
      if (!st.addEnabled)
        throw err(403, 'policy_denied', 'adding devices is turned off on this Hub', {
          reason: 'add_device_disabled',
        });
      if (st.startsThisHour >= 20)
        throw err(429, 'rate_limited', 'too many devices added in the last hour', {
          reason: 'start_rate_limited',
          limit: 20,
        });
      const transport = r.data.transport ?? 'direct';
      if (transport === 'relay' && !st.relay)
        throw err(400, 'capability_missing', 'the Relay is not set up on this Hub', {
          reason: 'relay_unavailable',
        });
      st.startsThisHour++;
      let code = st.nextCodes.shift();
      if (!code) {
        code = '';
        for (let i = 0; i < 8; i++) code += ALPHABET[Math.floor(Math.random() * 32)];
      }
      const pairing: FakePairing = {
        id: id('pr'),
        role: r.data.role,
        scopes: [...new Set(r.data.scopes ?? [])],
        name: r.data.name ?? null,
        transport,
        code,
        status: 'open',
        attempts: 0,
        expiresAt: new Date(st.now() + 5 * 60_000).toISOString(),
      };
      st.pairings = [...st.pairings, pairing];
      const fp = st.hubKey?.fingerprint ?? null;
      const q = new URLSearchParams({ p: pairing.id });
      if (fp) q.set('fp', fp);
      const relay = transport === 'relay' ? st.relay : null;
      if (relay) {
        q.set('r', relay.relayUrl);
        q.set('rp', relay.relayPairingId);
      }
      return {
        pairingId: pairing.id,
        code: display(code),
        expiresAt: pairing.expiresAt,
        role: pairing.role,
        scopes: pairing.scopes,
        transport,
        qr: `${HUB_URL}/add-device?${q.toString()}#c=${display(code)}`,
        deepLink: `nova://add-device?h=${encodeURIComponent(HUB_URL)}&${q.toString()}#c=${display(code)}`,
        pageUrl: `${HUB_URL}/add-device?p=${pairing.id}`,
        bootstrap: copy(st.bootstrap),
        hubFingerprint: fp,
        endpoints: [],
        relay,
      };
    },
    listAddRequests: async (status = 'pending') => {
      maybeFail('listAddRequests');
      sweep();
      const items = st.requests
        .filter(pending)
        .map((r) => r.view)
        .filter((v) => status === 'all' || v.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { items: copy(items) };
    },
    approveAddRequest: async (rid, confirmation) => {
      maybeFail('approveAddRequest');
      const r = pendingFor(rid);
      const typed = confirmation.replace(/\s/g, '');
      if (!/^\d{3} ?\d{3}$/.test(confirmation.trim()))
        throw err(400, 'validation', 'the six-digit code the device shows', {
          field: 'confirmation',
        });
      if (typed !== r.view.confirmation)
        throw err(400, 'validation', 'the confirmation does not match the device', {
          reason: 'confirmation_mismatch',
          field: 'confirmation',
        });
      const active = r.view.kind === 'browser' || r.view.kind === 'native';
      const deviceId = id('dev');
      st.others = [
        ...st.others,
        summaryView({
          id: deviceId,
          name: r.view.name,
          kind: r.view.role,
          addedAs: r.view.kind,
          roles: [r.view.role],
          scopes: r.view.scopes,
          platform: r.view.platform,
          status: active ? 'active' : 'pending',
          sessions: 0,
          lastSeenAt: active ? nowIso() : null,
          createdAt: nowIso(),
        }),
      ];
      r.view = {
        ...r.view,
        status: 'approved',
        deviceId,
        decidedAt: nowIso(),
        expiresAt: new Date(st.now() + 10 * 60_000).toISOString(),
      };
      return copy(r.view);
    },
    denyAddRequest: async (rid) => {
      maybeFail('denyAddRequest');
      const r = pendingFor(rid);
      r.view = { ...r.view, status: 'denied', decidedAt: nowIso() };
      return copy(r.view);
    },
    setDeviceScopes: async (did, scopes) => {
      maybeFail('setDeviceScopes');
      const parsed = deviceScopesSchema.safeParse({ scopes });
      if (!parsed.success)
        throw err(400, 'validation', parsed.error.issues[0]?.message ?? 'Invalid');
      const d = all().find((x) => x.id === did);
      if (!d) throw notFound();
      if (d.status === 'revoked')
        throw err(409, 'conflict', 'this device was revoked', { reason: 'revoked' });
      const next = [...new Set(parsed.data.scopes)];
      if (m6.devices.some((x) => x.id === did)) st.novadScopes[did] = next;
      else st.others = st.others.map((x) => (x.id === did ? { ...x, scopes: next } : x));
      return copy(all().find((x) => x.id === did)!);
    },
    revokeDevice: async (did) => {
      maybeFail('revokeDevice');
      const at = deps.ts();
      if (m6.devices.some((x) => x.id === did)) {
        m6.devices = m6.devices.map((x) => (x.id === did ? { ...x, status: 'revoked' } : x));
        m6.connections = m6.connections.map((c) =>
          c.deviceId === did && c.status === 'active'
            ? { ...c, status: 'revoked', revokedAt: at }
            : c,
        );
        m6.grants = m6.grants.map((g) =>
          g.deviceId === did && (g.status === 'pending' || g.status === 'granted')
            ? { ...g, status: 'revoked', decidedAt: at }
            : g,
        );
        return { ok: true as const };
      }
      const d = st.others.find((x) => x.id === did);
      if (!d) throw notFound();
      st.others = st.others.map((x) =>
        x.id === did ? { ...x, status: 'revoked', sessions: 0 } : x,
      );
      return { ok: true as const };
    },
  };
}

// ---- the joining device's side (public routes) ----------------------------------------------------

function respond(st: M65DevicesState, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', date: new Date(st.now()).toUTCString() },
  });
}

function refusal(st: M65DevicesState, e: ApiError): Response {
  return respond(st, e.status, { error: e.body });
}

/**
 * A `fetch` for the joining device's page: `GET /api/v1/hello`, `POST …/add/complete`,
 * `POST …/add/reveal` and `GET …/add/status/:id`, against the same state as the owner's calls.
 */
export function joinFetch(st: M65DevicesState): typeof fetch & Mock {
  const handle = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (st.offline > 0) {
      st.offline--;
      throw new TypeError('Failed to fetch');
    }
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const nowS = Math.floor(st.now() / 1000);
    const nowIso = new Date(st.now()).toISOString();
    try {
      if (method === 'GET' && url === '/api/v1/hello') {
        return respond(st, 200, {
          name: 'nova-hub',
          version: '0.1.0',
          apiVersions: ['v1'],
          setupRequired: false,
          hubFingerprint: st.hubKey?.fingerprint ?? null,
          hubPublicKey: st.hubKey?.publicKey ?? null,
        });
      }
      if (method === 'POST' && url === '/api/v1/devices/add/complete') {
        if (!st.addEnabled)
          throw err(403, 'policy_denied', 'adding devices is turned off', {
            reason: 'add_device_disabled',
          });
        const keys = ['pairingId', 'code', 'publicKey', 'name', 'platform', 'kind', 'commitment'];
        if (
          Object.keys(body).some((k) => !keys.includes(k)) ||
          typeof body.code !== 'string' ||
          typeof body.publicKey !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(body.publicKey) ||
          typeof body.commitment !== 'string' ||
          typeof body.name !== 'string' ||
          !body.name.trim() ||
          typeof body.platform !== 'string' ||
          typeof body.kind !== 'string'
        )
          throw err(400, 'validation', 'invalid request');
        const code = normalizeCode(body.code);
        let p: FakePairing | undefined;
        const gone = () =>
          err(410, 'request_expired', 'this code has expired or was already used', {
            reason: 'expired',
          });
        const wrong = (tried: FakePairing[]) => {
          let left = 5;
          for (const t of tried) {
            t.attempts++;
            if (t.attempts >= 5) t.status = 'burned';
            left = Math.min(left, Math.max(0, 5 - t.attempts));
          }
          return err(401, 'auth_missing', 'the code is not right', {
            reason: 'wrong_code',
            attemptsLeft: left,
          });
        };
        if (typeof body.pairingId === 'string') {
          p = st.pairings.find((x) => x.id === body.pairingId);
          if (!p) throw gone();
          if (p.status === 'open' && p.expiresAt <= nowIso) p.status = 'expired';
          if (p.status !== 'open') throw gone();
          if (code !== p.code) throw wrong([p]);
        } else {
          const open = st.pairings.filter((x) => x.status === 'open' && x.expiresAt > nowIso);
          p = open.find((x) => x.code === code);
          if (!p) throw open.length ? wrong(open) : gone();
        }
        const kind = body.kind as AddDeviceKind;
        if (!ADD_DEVICE_KINDS_BY_ROLE[p.role].includes(kind))
          throw err(400, 'validation', `a ${kind} cannot join as ${p.role}`, {
            reason: 'kind_not_allowed',
          });
        p.status = 'used';
        const hubNonce = createHash('sha256')
          .update(`${p.id}|${Math.random()}`)
          .digest('base64url');
        const view: AddDeviceRequestView = {
          id: `rq-${p.id}`,
          pairingId: p.id,
          role: p.role,
          kind,
          name: p.name ?? body.name.trim(),
          platform: body.platform,
          scopes: p.scopes,
          confirmation: '',
          fingerprint: createHash('sha256')
            .update(Buffer.from(body.publicKey, 'base64url'))
            .digest('hex'),
          via: 'direct',
          status: 'pending',
          deviceId: null,
          createdAt: nowIso,
          expiresAt: new Date(st.now() + 10 * 60_000).toISOString(),
          decidedAt: null,
        };
        st.requests = [
          ...st.requests,
          {
            view,
            phase: 'committed',
            publicKey: body.publicKey,
            commitment: body.commitment,
            hubNonce,
            code: p.code,
            lastPoll: 0,
            granted: false,
          },
        ];
        return respond(st, 202, {
          requestId: view.id,
          pairingId: p.id,
          expiresAt: view.expiresAt,
          hubNonce,
          status: 'committed',
        });
      }
      const signed = (r: FakeRequest | undefined, prefix: string) => {
        const timeText = headers.get(ADD_DEVICE_TIME_HEADER) ?? '';
        const sig = headers.get(ADD_DEVICE_SIGNATURE_HEADER) ?? '';
        const bad = (reason: string) =>
          err(401, 'auth_missing', 'this request is not signed by the device', { reason });
        if (!/^\d{1,12}$/.test(timeText) || !sig) throw bad('missing_proof');
        const time = Number(timeText);
        if (!r || !verifyEd25519(r.publicKey, `${prefix}.${r.view.id}.${time}`, sig))
          return { time, ok: false as const, bad };
        if (Math.abs(nowS - time) > 60) throw bad('stale_time');
        return { time, ok: true as const, bad };
      };
      if (method === 'POST' && url === '/api/v1/devices/add/reveal') {
        const r = st.requests.find((x) => x.view.id === body.requestId);
        const proof = signed(r, 'nova-add-device-reveal-v1');
        const burn = () => {
          if (r) r.view = { ...r.view, status: 'denied', decidedAt: nowIso };
          return err(401, 'auth_missing', 'the reveal does not match', { reason: 'bad_reveal' });
        };
        if (!proof.ok) throw r ? burn() : proof.bad('bad_signature');
        if (r!.phase === 'revealed')
          throw err(409, 'conflict', 'already revealed', { reason: 'already_revealed' });
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        const commit = createHash('sha256')
          .update(`nova-add-device-commit-v1|${r!.publicKey}|${nonce}`, 'utf8')
          .digest('base64url');
        if (commit !== r!.commitment) throw burn();
        const confirmation = confirmationV2({
          fingerprint: st.hubKey?.fingerprint ?? '',
          pairingId: r!.view.pairingId,
          publicKey: r!.publicKey,
          code: r!.code,
          deviceNonce: nonce,
          hubNonce: r!.hubNonce,
        });
        r!.phase = 'revealed';
        r!.view = { ...r!.view, confirmation };
        const statement = [
          'nova-add-device-reveal-v1',
          r!.view.id,
          r!.view.pairingId,
          r!.publicKey,
          st.tamper?.confirmation ?? confirmation,
        ].join('|');
        const hubSignature =
          st.tamper && 'hubSignature' in st.tamper
            ? st.tamper.hubSignature
            : st.hubKey
              ? sign(null, Buffer.from(statement, 'utf8'), st.hubKey.privateKey).toString(
                  'base64url',
                )
              : null;
        return respond(st, 200, {
          requestId: r!.view.id,
          confirmation: st.tamper?.confirmation ?? confirmation,
          status: 'pending',
          hubSignature,
        });
      }
      const m = /^\/api\/v1\/devices\/add\/status\/([^/]+)$/.exec(url);
      if (method === 'GET' && m) {
        const r = st.requests.find((x) => x.view.id === decodeURIComponent(m[1]!));
        const proof = signed(r, 'nova-add-device-status-v1');
        if (!proof.ok) throw proof.bad('bad_signature');
        if (proof.time <= r!.lastPoll) throw proof.bad('replayed');
        r!.lastPoll = proof.time;
        st.polls = [...st.polls, { requestId: r!.view.id, time: proof.time, at: st.now() }];
        if (r!.view.status === 'pending' && r!.view.expiresAt <= nowIso)
          r!.view = { ...r!.view, status: 'expired', decidedAt: nowIso };
        const v = r!.view;
        if (v.status !== 'approved') return respond(st, 200, { status: v.status });
        if (r!.granted) return respond(st, 200, { status: 'approved', deviceId: v.deviceId });
        r!.granted = true;
        const token = `nvs_${v.id}`;
        st.sessions = [...st.sessions, token];
        return respond(st, 200, {
          status: 'approved',
          deviceId: v.deviceId,
          grant: { type: 'session', token },
        });
      }
      return respond(st, 404, {
        error: { code: 'not_found', message: 'Not found', retryable: false },
      });
    } catch (e) {
      if (e instanceof ApiError) return refusal(st, e);
      throw e;
    }
  };
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handle(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
  );
}

/** A request a device already committed and revealed (seed it with `requests`). */
export function revealed(over: Partial<AddDeviceRequestView> = {}): FakeRequest {
  return {
    view: requestView(over),
    phase: 'revealed',
    publicKey: 'x'.repeat(43),
    commitment: '',
    hubNonce: '',
    code: 'ABCDEFGH',
    lastPoll: 0,
    granted: false,
  };
}

/** As if a device committed and revealed now: a pending request the owner sees. */
export function arrive(st: M65DevicesState, over: Partial<AddDeviceRequestView> = {}): FakeRequest {
  const r = revealed(over);
  const view = r.view;
  const p = st.pairings.find((x) => x.id === view.pairingId);
  if (p) p.status = 'used';
  st.requests = [...st.requests, r];
  return r;
}

// ---- rendering -------------------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type AddDeviceMocks = AddDeviceApi &
  Record<keyof AddDeviceApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake over the M6 devices state: every method a spy. */
export function createAddDeviceHub(init: Partial<M65DevicesState>, m6: M6DevicesState) {
  const state = m65DevicesState(init);
  const failNext: Partial<Record<keyof AddDeviceApi, Error>> = {};
  const impl = m65DevicesImpl(state, {
    m6,
    id: nextId,
    ts: nextTs,
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
  ) as unknown as AddDeviceMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` with the main fake Hub's client, the M6 devices fake and this one spread over it
 * (what `createApi` will do once it spreads `addDeviceApi`).
 */
export async function renderWithAllDevices(
  ui: ReactNode,
  opts: {
    devices?: Partial<M6DevicesState>;
    added?: Partial<M65DevicesState>;
    /** Calls that fail the first time, from the first render on. */
    fail?: Partial<Record<keyof AddDeviceApi, Error>>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    /** Calls the client lacks (an older Hub). */
    omit?: string[];
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const devices = createDevicesHub(opts.devices, {
    approvals: {
      list: () => hub.state.m3.approvals,
      add: (a) => {
        hub.state.m3.approvals = [...hub.state.m3.approvals, a];
      },
    },
  });
  const added = createAddDeviceHub(opts.added ?? {}, devices.state);
  Object.assign(added.failNext, opts.fail);
  const api = { ...hub.api, ...devices.api, ...added.api };
  for (const name of opts.omit ?? []) delete (api as Record<string, unknown>)[name];
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
  return {
    hub,
    devices,
    added,
    api: { ...devices.api, ...added.api },
    state: devices.state,
    addState: added.state,
    ...utils,
  };
}
