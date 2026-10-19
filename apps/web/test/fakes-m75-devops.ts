// The fake Hub's M7.5 device-operations part (ADR-096 D1, D9; FR-126, FR-142, FR-145, FR-148,
// FR-150), in memory over the M6 devices fake, with the Hub's rules from apps/hub/src/devices.ts,
// apps/hub/src/node-routes.ts and packages/core/src/{devices,nodes}/service.ts:
// - every route is the owner's (a member gets 403 `owner_only`); unknown devices are 404;
// - the management channel is `mutual_tls` for an https endpoint, `plain_http` for http, null
//   without one; a refused last call carries its failure; problems are the Hub's sentences; the
//   certificate renewal state is what the test seeds (`renewals`);
// - managed services need the device reachable (503 `node_unavailable`) with the services
//   capability (400 `capability_missing`); an older novad cannot list them (400
//   `{reason: update_required}`); their state is the M6 fake's, so actions there show up here;
// - available updates are what the test seeds (default: the Hub serves no builds);
// - overrides: the change number and whether the device has it; Push now needs the device online;
// - decommission files a high-risk, Hub-only approval card (`answerIn: 'hub'`) and answers 202
//   `awaiting_approval`; a revoked device is 409 `revoked`, a second request 409
//   `decommission_pending`; once the card is answered (seen at the next call) the device is told
//   (`wiped`, or `refused` when seeded) when online, else `unreachable`, and revoked either way;
// - compute nodes: detail (quiet now from the policy's zone, else the node's), policy (merged,
//   revision + 1; 409 `revoked`; 400 `validation`), services (503 offline, 400 `update_required`
//   for an older node, 404 for an unknown service).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m75devops: M75DevOpsState`,
// `createHub` defaults it to `m75DevOpsState()`, and `impl` spreads `...m75DevOpsImpl(
// state.m75devops, { m6: state.m6devices, others: () => state.m65devices.others, id, ts: () =>
// ts(), maybeFail, approvals: {list, add, update} over state.m3.approvals })`. Until then tests
// use `renderWithM75` below, which also spreads the out-of-band fake.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  deviceDecommissionSchema,
  nodePolicySchema,
  quietHoursActive,
  resolveSetting,
  type DeviceAvailableUpdateView,
  type DeviceDecommissionView,
  type DeviceManagementTlsSummaryView,
  type DeviceCertificateStateView,
  type DeviceManagementTlsView,
  type DeviceServiceView,
  type DeviceSummaryView,
  type DeviceView,
  type NodeDetailView,
  type NodeGpuVram,
  type NodePolicy,
  type NodeServiceView,
  type SettingKey,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { DeviceOpsApi } from '../src/devices/api-m75.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { TeamRoleProvider } from '../src/team/role.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { createDevicesHub, type M6DevicesState } from './fakes-m6-devices.ts';
import { createAddDeviceHub, type M65DevicesState } from './fakes-m65-devices.ts';
import { MEMBER_ID } from './fakes-m7-team.ts';
import { createOobHub, type M75OobState, type OobApprovals } from './fakes-m75-oob.ts';

const T0 = '2026-10-01T12:00:00.000Z';
const GIB = 1024 ** 3;

// ---- builders ------------------------------------------------------------------------------------

export interface FakeNode {
  policy: NodePolicy;
  /** The zone the node declares (its capability document's locale). */
  zone: string | null;
  vram: NodeGpuVram[] | null;
  load: { running: number; queued: number } | null;
  reportedQuiet: boolean | null;
  /** The node's services, or `old` for a nova-compute that cannot list them. */
  services: NodeServiceView[] | 'old';
}

export function fakeNode(over: Partial<FakeNode> = {}): FakeNode {
  return {
    policy: { quietHours: [], timeZone: null, routingEligible: true, revision: 0 },
    zone: 'Europe/Lisbon',
    vram: [
      { index: 0, vendor: 'NVIDIA', name: 'RTX 4090', totalBytes: 24 * GIB, usedBytes: 6 * GIB },
    ],
    load: { running: 1, queued: 0 },
    reportedQuiet: false,
    services: [
      { name: 'jobs', kind: 'builtin', state: 'running', unit: null },
      { name: 'backend', kind: 'systemd', state: 'running', unit: 'ollama.service' },
    ],
    ...over,
  };
}

export function decommissionView(
  over: Partial<DeviceDecommissionView> = {},
): DeviceDecommissionView {
  return {
    id: 'dc1',
    deviceId: 'd1',
    deviceName: 'Desk PC',
    purge: false,
    status: 'awaiting_approval',
    approvalId: 'ap-dc1',
    deviceResult: null,
    detail: null,
    createdAt: T0,
    decidedAt: null,
    finishedAt: null,
    ...over,
  };
}

// ---- state ---------------------------------------------------------------------------------------

export interface M75DevOpsState {
  member: boolean;
  /** What novad's config declares per device: name → kind, module and unit. */
  serviceMeta: Record<string, Record<string, Omit<DeviceServiceView, 'name' | 'state'>>>;
  /** Devices whose novad cannot list its services. */
  oldNovad: string[];
  available: Record<string, DeviceAvailableUpdateView>;
  /** Each device's latest change number (default 3). */
  revisions: Record<string, number>;
  hubClient: DeviceManagementTlsSummaryView['hubClient'];
  lastCalls: Record<string, DeviceManagementTlsView['lastCall']>;
  /** Each device's certificate renewal state (default: no certificate, no renewal). */
  renewals: Record<string, DeviceCertificateStateView>;
  decommissions: DeviceDecommissionView[];
  /** What a reachable device answers to the decommission (default `wiped`). */
  decommissionAnswer: Record<string, 'wiped' | 'refused'>;
  nodes: Record<string, FakeNode>;
  now: () => Date;
}

export function m75DevOpsState(init: Partial<M75DevOpsState> = {}): M75DevOpsState {
  return {
    member: false,
    serviceMeta: {},
    oldNovad: [],
    available: {},
    revisions: {},
    hubClient: {
      serial: '0a1b2c3d',
      notAfter: '2026-12-30T00:00:00.000Z',
      uri: 'urn:nova:hub:abc',
    },
    lastCalls: {},
    renewals: {},
    decommissions: [],
    decommissionAnswer: {},
    nodes: {},
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const OVERRIDABLE = ['models', 'computePolicy', 'scheduling', 'limits', 'power', 'locale', 'data'];

export function m75DevOpsImpl(
  st: M75DevOpsState,
  deps: {
    m6: M6DevicesState;
    others: () => DeviceSummaryView[];
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof DeviceOpsApi) => void;
    approvals: OobApprovals;
  },
): DeviceOpsApi {
  const { m6, id, ts, maybeFail, approvals } = deps;
  const copy = <T>(v: T): T => structuredClone(v);
  const owner = () => {
    if (st.member)
      throw err(403, 'policy_denied', 'only the owner of this Hub can change devices', {
        reason: 'owner_only',
      });
  };
  const device = (did: string): DeviceView => {
    const d = m6.devices.find((x) => x.id === did);
    if (!d) throw err(404, 'not_found', 'device not found');
    return d;
  };
  const putDevice = (d: DeviceView) => {
    m6.devices = m6.devices.map((x) => (x.id === d.id ? d : x));
  };
  const reachable = (d: DeviceView) => {
    if (d.status === 'revoked') throw err(404, 'not_found', 'device not found');
    if (d.status !== 'active' || !d.endpoint)
      throw err(503, 'node_unavailable', 'the device is not reachable', {
        reason: 'unreachable',
        status: d.status,
      });
  };
  const channel = (d: DeviceView): DeviceManagementTlsView => ({
    deviceId: d.id,
    name: d.name,
    status: d.status,
    endpoint: d.endpoint,
    channel: d.endpoint ? (d.endpoint.startsWith('https://') ? 'mutual_tls' : 'plain_http') : null,
    lastCall: st.lastCalls[d.id] ?? null,
    renewal: null,
    legacyCertificate: false,
    legacyGraceEndsAt: null,
    ...st.renewals[d.id],
  });

  /** Answered decommission cards: the device is told (when online) and revoked. */
  const sync = () => {
    for (const r of st.decommissions) {
      if (r.status !== 'awaiting_approval' || !r.approvalId) continue;
      const card = approvals.list().find((a) => a.id === r.approvalId);
      if (!card || card.status === 'pending') continue;
      const at = ts();
      const put = (v: DeviceDecommissionView) => {
        st.decommissions = st.decommissions.map((x) => (x.id === v.id ? v : x));
      };
      if (!(
        card.status === 'decided' &&
        card.decision === 'allow_once' &&
        card.decidedBy === 'user'
      )) {
        const expired = card.status === 'expired' || card.decision === 'timeout';
        put({ ...r, status: expired ? 'expired' : 'denied', decidedAt: at, finishedAt: at });
        continue;
      }
      const d = m6.devices.find((x) => x.id === r.deviceId);
      if (!d || d.status === 'revoked') {
        put({
          ...r,
          status: 'failed',
          detail: 'the device was already revoked',
          decidedAt: at,
          finishedAt: at,
        });
        continue;
      }
      const online = d.status === 'active' && Boolean(d.endpoint);
      const answer = st.decommissionAnswer[d.id] ?? 'wiped';
      const result = online ? answer : 'unreachable';
      const detail =
        result === 'unreachable'
          ? 'The device was offline: it is revoked now and wipes its credentials at its next contact.'
          : result === 'refused'
            ? 'The device refused: authorization_invalid. It is revoked anyway.'
            : null;
      putDevice({ ...d, status: 'revoked' });
      put({ ...r, status: 'done', deviceResult: result, detail, decidedAt: at, finishedAt: at });
    }
  };

  const node = (nid: string) => {
    const n = st.nodes[nid];
    if (!n) throw err(404, 'not_found', 'node not found');
    const summary = deps.others().find((x) => x.id === nid);
    return { n, summary, status: summary?.status ?? 'active' };
  };
  const nodeReachable = (nid: string) => {
    const x = node(nid);
    if (x.status === 'revoked') throw err(404, 'not_found', 'node not found');
    if (x.status !== 'active')
      throw err(503, 'node_unavailable', 'the node is not reachable', {
        reason: 'unreachable',
        status: x.status,
      });
    return x;
  };

  return {
    getManagementTls: async () => {
      maybeFail('getManagementTls');
      owner();
      const items = m6.devices.filter((d) => d.status !== 'revoked').map(channel);
      const problems: string[] = [];
      const plain = items.filter((i) => i.channel === 'plain_http' && i.status === 'active');
      if (plain.length)
        problems.push(
          `${plain.length} device${plain.length === 1 ? ' is' : 's are'} managed over plain HTTP (${plain
            .map((i) => i.name)
            .join(
              ', ',
            )}): add ${plain.length === 1 ? 'it' : 'them'} again with the Hub local CA as the trust path to use mutual TLS.`,
        );
      for (const i of items)
        if (i.lastCall && !i.lastCall.ok && i.lastCall.failure)
          problems.push(`${i.name}: the management channel was refused (${i.lastCall.failure}).`);
      return copy({ hubClient: st.hubClient, items, problems });
    },
    listDeviceServices: async (did) => {
      maybeFail('listDeviceServices');
      owner();
      const d = device(did);
      reachable(d);
      const cap = d.capabilities.find((c) => c.name === 'services');
      if (cap && !cap.available)
        throw err(400, 'capability_missing', 'this device cannot serve services', {
          reason: cap.reason,
          capability: 'services',
          module: cap.module,
          minVersion: cap.minVersion,
        });
      if (st.oldNovad.includes(did))
        throw err(400, 'capability_missing', 'this novad cannot list its services yet', {
          reason: 'update_required',
          capability: 'services',
        });
      const meta = st.serviceMeta[did] ?? {};
      const states = m6.services[did] ?? {};
      const names = [...new Set([...Object.keys(meta), ...Object.keys(states)])];
      return {
        items: names.map((name) => ({
          name,
          kind: meta[name]?.kind ?? 'module',
          module: meta[name]?.module ?? null,
          unit: meta[name]?.unit ?? null,
          state: states[name] ?? null,
        })),
      };
    },
    getAvailableUpdate: async (did) => {
      maybeFail('getAvailableUpdate');
      owner();
      const d = device(did);
      if (d.status === 'revoked') throw err(404, 'not_found', 'device not found');
      return copy(
        st.available[did] ?? {
          deviceId: did,
          current: { novad: d.novadVersion },
          platform: { os: 'linux', arch: 'amd64' },
          novad: null,
          newer: false,
          reason: 'no_builds',
        },
      );
    },
    getDeviceOverrides: async (did) => {
      maybeFail('getDeviceOverrides');
      owner();
      const d = device(did);
      const config = st.revisions[did] ?? 3;
      const doc = d.capability ?? {};
      return copy({
        deviceId: did,
        capabilityOverrides: d.capabilityOverrides,
        policy: d.policy,
        updateChannel: d.updateChannel,
        configRevision: config,
        pushedRevision: d.configPending ? config - 1 : config,
        configPending: d.configPending,
        effective: Object.fromEntries(OVERRIDABLE.filter((k) => k in doc).map((k) => [k, doc[k]])),
      });
    },
    pushDeviceOverrides: async (did) => {
      maybeFail('pushDeviceOverrides');
      owner();
      const d = device(did);
      reachable(d);
      putDevice({ ...d, configPending: false });
      const config = st.revisions[did] ?? 3;
      const doc = d.capability ?? {};
      return copy({
        deviceId: did,
        capabilityOverrides: d.capabilityOverrides,
        policy: d.policy,
        updateChannel: d.updateChannel,
        configRevision: config,
        pushedRevision: config,
        configPending: false,
        effective: Object.fromEntries(OVERRIDABLE.filter((k) => k in doc).map((k) => [k, doc[k]])),
      });
    },
    getDecommission: async (did) => {
      maybeFail('getDecommission');
      owner();
      device(did);
      sync();
      const mine = st.decommissions.filter((r) => r.deviceId === did);
      return { decommission: copy(mine[mine.length - 1] ?? null) };
    },
    requestDecommission: async (did, body) => {
      maybeFail('requestDecommission');
      owner();
      sync();
      const d = device(did);
      const b = deviceDecommissionSchema.parse(body ?? {});
      if (d.status === 'revoked')
        throw err(409, 'conflict', 'the device was already revoked', { reason: 'revoked' });
      const open = st.decommissions.find(
        (r) => r.deviceId === did && (r.status === 'awaiting_approval' || r.status === 'running'),
      );
      if (open)
        throw err(409, 'conflict', 'a decommission of this device is already waiting', {
          reason: 'decommission_pending',
          decommissionId: open.id,
        });
      const online = d.status === 'active' && Boolean(d.endpoint);
      const what = b.purge
        ? 'stop its modules, remove its services, wipe its credentials and delete its Nova data'
        : 'stop its modules, remove its services and wipe its credentials';
      const approvalId = id('ap');
      const at = ts();
      approvals.add({
        id: approvalId,
        threadId: null,
        turnId: null,
        callId: null,
        action: `Decommission ${d.name}: ${what}; revoke it and its certificate`,
        tool: 'device.decommission',
        argsPreview: JSON.stringify({
          device: d.name,
          deviceId: did,
          purge: b.purge,
          reachable: online,
          after: { status: 'revoked', certificate: 'revoked' },
        }),
        reason: online
          ? 'The device is told to wipe itself, then revoked.'
          : 'The device is offline: it is revoked at once and wipes its credentials at its next contact.',
        tier: 'confirm_at_action',
        risk: 'high',
        userAsked: false,
        ruleId: null,
        options: ['allow_once', 'deny_continue'],
        alwaysScopes: [],
        status: 'pending',
        decision: null,
        decidedBy: null,
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + 3_600_000).toISOString(),
        decidedAt: null,
        answerIn: 'hub',
      });
      const v = decommissionView({
        id: id('dc'),
        deviceId: did,
        deviceName: d.name,
        purge: b.purge,
        approvalId,
        createdAt: at,
      });
      st.decommissions = [...st.decommissions, v];
      return copy(v);
    },
    getNodeDetail: async (nid) => {
      maybeFail('getNodeDetail');
      owner();
      const { n, summary, status } = node(nid);
      const quietNow =
        status !== 'revoked' &&
        (n.reportedQuiet === true ||
          quietHoursActive(n.policy.quietHours, st.now(), n.policy.timeZone ?? n.zone));
      const view: NodeDetailView = {
        id: nid,
        name: summary?.name ?? 'Node',
        status,
        policy: n.policy,
        quietNow,
        reportedQuiet: n.reportedQuiet,
        vram: n.vram,
        load: status === 'active' ? n.load : null,
        lastSeenAt: summary?.lastSeenAt ?? T0,
      };
      return copy(view);
    },
    setNodePolicy: async (nid, body) => {
      maybeFail('setNodePolicy');
      owner();
      const { n, status } = node(nid);
      if (status === 'revoked')
        throw err(409, 'conflict', 'the node was revoked', { reason: 'revoked' });
      const r = nodePolicySchema.safeParse(body);
      if (!r.success) throw err(400, 'validation', r.error.issues[0]?.message ?? 'Invalid');
      const p = r.data;
      n.policy = {
        quietHours: p.quietHours ?? n.policy.quietHours,
        timeZone: p.timeZone === undefined ? n.policy.timeZone : p.timeZone,
        routingEligible: p.routingEligible ?? n.policy.routingEligible,
        revision: n.policy.revision + 1,
      };
      return copy(n.policy);
    },
    listNodeServices: async (nid) => {
      maybeFail('listNodeServices');
      owner();
      const { n } = nodeReachable(nid);
      if (n.services === 'old')
        throw err(400, 'capability_missing', 'this node cannot list its services yet', {
          reason: 'update_required',
        });
      return { items: copy(n.services) };
    },
    nodeServiceAction: async (nid, name, action) => {
      maybeFail('nodeServiceAction');
      owner();
      const { n } = nodeReachable(nid);
      if (n.services === 'old') throw err(404, 'not_found', 'Not found');
      const s = n.services.find((x) => x.name === name);
      if (!s) throw err(404, 'not_found', `no service named ${name}`);
      const state = action === 'stop' ? 'stopped' : action === 'status' ? s.state : 'running';
      n.services = n.services.map((x) => (x.name === name ? { ...x, state } : x));
      return { service: copy({ ...s, state }) };
    },
  };
}

export type DevOpsMocks = DeviceOpsApi &
  Record<keyof DeviceOpsApi, Mock<(...args: never[]) => unknown>>;

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 10, 0, clock++)).toISOString();

export function createDevOpsHub(
  init: Partial<M75DevOpsState>,
  deps: { m6: M6DevicesState; others: () => DeviceSummaryView[]; approvals: OobApprovals },
) {
  const state = m75DevOpsState(init);
  const failNext: Partial<Record<keyof DeviceOpsApi, Error>> = {};
  const impl = m75DevOpsImpl(state, {
    ...deps,
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
  ) as unknown as DevOpsMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` with the main fake Hub's client and, spread over it, the M6 devices, M6.5 Add
 * Device, M7.5 out-of-band and M7.5 device-operations fakes (what `createApi` will do). Cards go
 * to the main fake's approvals, so `decideApproval` answers them as on the Hub. `as: 'member'`
 * signs in as a member (the Hub refuses every route; the views show the owner-only notice).
 */
export async function renderWithM75(
  ui: ReactNode,
  opts: {
    devices?: Partial<M6DevicesState>;
    added?: Partial<M65DevicesState>;
    oob?: Partial<M75OobState>;
    ops?: Partial<M75DevOpsState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    as?: 'owner' | 'member';
    /** Calls the client lacks (an older client). */
    omit?: string[];
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const member = opts.as === 'member';
  if (member) hub.state.m7team.me = MEMBER_ID;
  const approvals: OobApprovals = {
    list: () => hub.state.m3.approvals,
    add: (a) => {
      hub.state.m3.approvals = [...hub.state.m3.approvals, a];
    },
    update: (a) => {
      hub.state.m3.approvals = hub.state.m3.approvals.map((x) => (x.id === a.id ? a : x));
    },
  };
  const devices = createDevicesHub(opts.devices, { approvals });
  const added = createAddDeviceHub(opts.added ?? {}, devices.state);
  const oob = createOobHub(
    { member, ...opts.oob },
    {
      approvals,
      setting: (k) =>
        resolveSetting(k as SettingKey, { global: hub.state.settings, managed: hub.state.managed })
          .value,
      deviceIds: () => [
        ...devices.state.devices.map((d) => d.id),
        ...added.state.others.map((d) => d.id),
      ],
    },
  );
  const ops = createDevOpsHub(
    { member, ...opts.ops },
    { m6: devices.state, others: () => added.state.others, approvals },
  );
  const api = { ...hub.api, ...devices.api, ...added.api, ...oob.api, ...ops.api };
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
      children: createElement(SettingsProvider, {
        api,
        initial: settings,
        children: createElement(TeamRoleProvider, { children: inner }),
      }),
    }),
  );
  return { hub, devices, added, oob, ops, api, ...utils };
}
