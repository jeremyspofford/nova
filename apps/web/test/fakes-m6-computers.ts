// The fake Hub's M6 computers part (apps/hub/src/computers.ts), in memory, with the Hub's rules:
// unknown computers, snapshots, rules and credentials answer 404 `not_found`; a connected
// device's computer cannot be snapshotted or restored (400 `capability_missing`); rules and
// credentials are checked with the shared zod schemas (400 `validation`, so a bare `*` or a
// wildcard that is not the leftmost label is refused); an empty credential update answers 400;
// credential values are kept but never returned; the decision log filters by decision and exact
// host (lower case) and returns at most `limit`, newest first. The global policy is read from the
// main fake's settings, as the Hub reads `network.*`. Views handed out are copies.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6computers: M6ComputersState`,
// `createHub` defaults it to `m6ComputersState()`, and `impl` spreads
// `...m6ComputersImpl(state.m6computers, { id, ts: () => ts(), maybeFail, global: () => ({
// mode: resolveSetting('network.egressMode', layers()).value, allow: ..., deny: ... }) })`.
// Until then tests build the client with `createComputersHub()` and spread its `api` over
// `createHub().api` (`renderWithComputers` does).
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  EGRESS_SCOPE_KINDS,
  computerSnapshotSchema,
  egressCredentialCreateSchema,
  egressCredentialUpdateSchema,
  egressScopeSchema,
  networkDecisionQuerySchema,
  resolveSetting,
  type ActivityItemView,
  type ComputerSnapshotView,
  type ComputerView,
  type DiagnosticsSnapshot,
  type EgressCredentialView,
  type EgressScopeKind,
  type EgressScopeView,
  type EgressView,
  type NetworkDecisionView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { AgentRef, ComputersApi } from '../src/computers/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

export function computerView(over: Partial<ComputerView> = {}): ComputerView {
  return {
    id: `cmp${++n}`,
    kind: 'local_container',
    agentId: 'ag1',
    deviceId: null,
    provider: 'container',
    state: 'running',
    substrate: 'container',
    detail: 'Rootless container with the egress proxy.',
    baseImage: 'nova/sandbox:1',
    snapshotCount: 0,
    createdAt: T0,
    updatedAt: T0,
    lastUsedAt: T0,
    ...over,
  };
}

export function snapshotView(over: Partial<ComputerSnapshotView> = {}): ComputerSnapshotView {
  return {
    id: `snap${++n}`,
    computerId: 'cmp1',
    label: 'Before the upgrade',
    sizeBytes: 2_400_000,
    createdAt: T0,
    ...over,
  };
}

export function scopeView(over: Partial<EgressScopeView> = {}): EgressScopeView {
  return {
    kind: 'agent',
    id: 'ag1',
    mode: null,
    allow: [],
    deny: [],
    hooks: [],
    allowLocalBinding: false,
    updatedAt: T0,
    ...over,
  };
}

export function credentialView(over: Partial<EgressCredentialView> = {}): EgressCredentialView {
  const id = over.id ?? `cred${++n}`;
  return {
    id,
    name: 'Weather API',
    hosts: ['api.weather.test'],
    scheme: 'bearer',
    header: null,
    username: null,
    scope: null,
    secretRef: `secret://egress/${id}`,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function decisionView(over: Partial<NetworkDecisionView> = {}): NetworkDecisionView {
  return {
    id: `dec${++n}`,
    createdAt: T0,
    decision: 'allow',
    cause: null,
    method: 'GET',
    host: 'api.weather.test',
    port: 443,
    scope: { kind: 'agent', id: 'ag1' },
    addressClass: 'public',
    mode: 'allowlist',
    status: 200,
    inspected: true,
    bytesIn: 2048,
    bytesOut: 300,
    ...over,
  };
}

/** A computer item of the Activity trace (FR-098). */
export function computerItem(over: Partial<ActivityItemView> = {}): ActivityItemView {
  return {
    id: `act${++n}`,
    ts: T0,
    kind: 'computer',
    title: 'Browser: click #submit',
    detail: null,
    status: 'ok',
    callId: null,
    turnId: 't1',
    shots: {
      before: '/api/v1/browser/actions/ba1/screenshots/before',
      after: '/api/v1/browser/actions/ba1/screenshots/after',
    },
    ...over,
  };
}

/** A stored credential: the view plus the write-only value the Hub keeps in its vault. */
export type StoredCredential = EgressCredentialView & { value: string };

export interface M6ComputersState {
  computers: ComputerView[];
  snapshots: ComputerSnapshotView[];
  agents: AgentRef[];
  scopes: EgressScopeView[];
  credentials: StoredCredential[];
  /** Newest first, as the Hub reads them. */
  decisions: NetworkDecisionView[];
  inspection: EgressView['inspection'];
  /** Restores done, in order (computer id and snapshot id). */
  restores: { computerId: string; snapshotId: string }[];
}

export function m6ComputersState(init: Partial<M6ComputersState> = {}): M6ComputersState {
  return {
    computers: [],
    snapshots: [],
    agents: [],
    scopes: [],
    credentials: [],
    decisions: [],
    inspection: {
      https: true,
      caCertPem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
    },
    restores: [],
    ...init,
  };
}

const err = (status: number, code: string, message: string) =>
  new ApiError(status, { code, message, retryable: false });

const notFound = (what = 'Not found') => err(404, 'not_found', what);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

const strip = ({ value: _value, ...view }: StoredCredential): EgressCredentialView => ({
  ...view,
  hosts: [...view.hosts],
});

export function m6ComputersImpl(
  st: M6ComputersState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof ComputersApi) => void;
    /** The `network.*` settings, as the Hub reads them for GET /egress. */
    global: () => EgressView['global'];
  },
): ComputersApi {
  const { id, ts, maybeFail, global } = helpers;
  const computer = (cid: string) => {
    const c = st.computers.find((x) => x.id === cid);
    if (!c) throw notFound('no such computer');
    return c;
  };
  const dir = (cid: string) => {
    const c = computer(cid);
    if (c.kind === 'local_host')
      throw err(
        400,
        'capability_missing',
        "a connected device's computer is managed on the device",
      );
    return c;
  };
  const patchComputer = (cid: string, patch: Partial<ComputerView>) => {
    st.computers = st.computers.map((c) => (c.id === cid ? { ...c, ...patch } : c));
    return { ...computer(cid) };
  };
  const count = (cid: string) => st.snapshots.filter((s) => s.computerId === cid).length;
  const scopeKind = (k: string): EgressScopeKind => {
    if (!(EGRESS_SCOPE_KINDS as readonly string[]).includes(k))
      throw err(400, 'validation', `unknown scope kind ${k}`);
    return k as EgressScopeKind;
  };
  const cred = (cid: string) => {
    const c = st.credentials.find((x) => x.id === cid);
    if (!c) throw notFound('no such credential');
    return c;
  };

  return {
    listComputers: async () => {
      maybeFail('listComputers');
      return { items: st.computers.map((c) => ({ ...c })) };
    },
    getComputer: async (cid) => {
      maybeFail('getComputer');
      return { ...computer(cid) };
    },
    listComputerSnapshots: async (cid) => {
      maybeFail('listComputerSnapshots');
      computer(cid);
      return {
        items: st.snapshots
          .filter((s) => s.computerId === cid)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .map((s) => ({ ...s })),
      };
    },
    createComputerSnapshot: async (cid, body = {}) => {
      maybeFail('createComputerSnapshot');
      const b = parse(computerSnapshotSchema, body);
      dir(cid);
      const s = snapshotView({
        id: id('snap'),
        computerId: cid,
        label: b.label ?? null,
        sizeBytes: 1024,
        createdAt: ts(),
      });
      st.snapshots = [...st.snapshots, s];
      patchComputer(cid, { snapshotCount: count(cid) });
      return { ...s };
    },
    deleteComputerSnapshot: async (cid, sid) => {
      maybeFail('deleteComputerSnapshot');
      computer(cid);
      if (!st.snapshots.some((s) => s.id === sid && s.computerId === cid))
        throw notFound('no such snapshot');
      st.snapshots = st.snapshots.filter((s) => s.id !== sid);
      patchComputer(cid, { snapshotCount: count(cid) });
      return { ok: true };
    },
    restoreComputer: async (cid, sid) => {
      maybeFail('restoreComputer');
      dir(cid);
      if (!st.snapshots.some((s) => s.id === sid && s.computerId === cid))
        throw notFound('no such snapshot');
      st.restores = [...st.restores, { computerId: cid, snapshotId: sid }];
      return patchComputer(cid, { updatedAt: ts() });
    },
    stopComputer: async (cid) => {
      maybeFail('stopComputer');
      computer(cid);
      return patchComputer(cid, { state: 'stopped' });
    },
    listComputerAgents: async () => {
      maybeFail('listComputerAgents');
      return { items: st.agents.map((a) => ({ ...a })) };
    },

    getEgress: async () => {
      maybeFail('getEgress');
      return {
        global: global(),
        scopes: st.scopes.map((s) => ({ ...s })),
        inspection: { ...st.inspection },
      };
    },
    egressCaUrl: () => '/api/v1/egress/ca.pem',
    putEgressScope: async (kind, sid, body) => {
      maybeFail('putEgressScope');
      const k = scopeKind(kind);
      const b = parse(egressScopeSchema, body);
      const v: EgressScopeView = { kind: k, id: sid, ...b, updatedAt: ts() };
      st.scopes = [...st.scopes.filter((s) => !(s.kind === k && s.id === sid)), v];
      return { ...v };
    },
    deleteEgressScope: async (kind, sid) => {
      maybeFail('deleteEgressScope');
      const k = scopeKind(kind);
      if (!st.scopes.some((s) => s.kind === k && s.id === sid))
        throw notFound('no network policy for this scope');
      st.scopes = st.scopes.filter((s) => !(s.kind === k && s.id === sid));
      return { ok: true };
    },

    listEgressCredentials: async () => {
      maybeFail('listEgressCredentials');
      return { items: st.credentials.map(strip) };
    },
    createEgressCredential: async (body) => {
      maybeFail('createEgressCredential');
      const b = parse(egressCredentialCreateSchema, body);
      const cid = id('cred');
      const at = ts();
      const stored: StoredCredential = {
        id: cid,
        name: b.name,
        hosts: b.hosts,
        scheme: b.scheme,
        header: b.header ?? null,
        username: b.username ?? null,
        scope: b.scope ?? null,
        secretRef: `secret://egress/${cid}`,
        createdAt: at,
        updatedAt: at,
        value: b.value,
      };
      st.credentials = [...st.credentials, stored];
      return strip(stored);
    },
    updateEgressCredential: async (cid, body) => {
      maybeFail('updateEgressCredential');
      const b = parse(egressCredentialUpdateSchema, body);
      if (!Object.keys(b).length) throw err(400, 'validation', 'nothing to update');
      const cur = cred(cid);
      const scheme = b.scheme ?? cur.scheme;
      const header = b.header !== undefined ? b.header : cur.header;
      if (scheme === 'header' && !header)
        throw err(400, 'validation', 'scheme header needs a header name');
      const next: StoredCredential = {
        ...cur,
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.hosts !== undefined ? { hosts: b.hosts } : {}),
        scheme,
        header: header ?? null,
        ...(b.username !== undefined ? { username: b.username } : {}),
        ...(b.scope !== undefined ? { scope: b.scope } : {}),
        ...(b.value !== undefined ? { value: b.value } : {}),
        updatedAt: ts(),
      };
      st.credentials = st.credentials.map((c) => (c.id === cid ? next : c));
      return strip(next);
    },
    deleteEgressCredential: async (cid) => {
      maybeFail('deleteEgressCredential');
      cred(cid);
      st.credentials = st.credentials.filter((c) => c.id !== cid);
      return { ok: true };
    },

    listNetworkDecisions: async (q = {}) => {
      maybeFail('listNetworkDecisions');
      const p = parse(networkDecisionQuerySchema, q);
      const host = p.host?.toLowerCase();
      const all = st.decisions.filter(
        (d) => (!p.decision || d.decision === p.decision) && (!host || d.host === host),
      );
      // Newest first, paged by the id of the last row seen (the Hub pages by audit sequence).
      const start = p.before ? all.findIndex((d) => d.id === p.before) + 1 : 0;
      const page = all.slice(start, start + p.limit);
      const last = page.at(-1);
      return {
        items: page.map((d) => ({ ...d })),
        nextCursor: page.length === p.limit && last ? last.id : null,
      };
    },
  };
}

// ---- test helpers -----------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type ComputersMocks = ComputersApi &
  Record<keyof ComputersApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createComputersHub(
  init: Partial<M6ComputersState> = {},
  global: () => EgressView['global'] = () => ({ mode: 'allowlist', allow: [], deny: [] }),
) {
  const state = m6ComputersState(init);
  const failNext: Partial<Record<keyof ComputersApi, Error>> = {};
  const impl = m6ComputersImpl(state, {
    id: nextId,
    ts: nextTs,
    global,
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
  ) as unknown as ComputersMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the computers and network views need, with the main fake
 * Hub's client and the computers part spread over it (what `createApi` will do). The egress
 * view's global policy follows the main fake's `network.*` settings.
 */
export async function renderWithComputers(
  ui: ReactNode,
  opts: {
    computers?: Partial<M6ComputersState>;
    settings?: Record<string, unknown>;
    /** Values set by managed policy (locked). */
    managed?: Record<string, unknown>;
    sandbox?: DiagnosticsSnapshot['sandbox'];
    /** Errors the first call of each named method throws. */
    fail?: Partial<Record<keyof ComputersApi, Error>>;
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  if (opts.sandbox)
    hub.state.m3.diagnostics = { ...hub.state.m3.diagnostics, sandbox: opts.sandbox };
  const layers = () => ({ global: hub.state.settings, managed: hub.state.managed });
  const computers = createComputersHub(opts.computers, () => ({
    mode: resolveSetting('network.egressMode', layers()).value,
    allow: resolveSetting('network.egressAllow', layers()).value,
    deny: resolveSetting('network.egressDeny', layers()).value,
  }));
  Object.assign(computers.failNext, opts.fail);
  const api = { ...hub.api, ...computers.api };
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
  return { hub, computers, api: computers.api, state: computers.state, ...utils };
}
