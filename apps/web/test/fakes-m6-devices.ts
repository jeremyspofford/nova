// The fake Hub's M6 devices part: devices running `novad` (docs/23), in memory, with the Hub's
// rules from apps/hub/src/devices.ts and packages/core/src/devices/service.ts: a revoked or
// unknown device answers 404; an action that reaches the device answers 503 `node_unavailable`
// while it is offline and 400 `capability_missing` (with `reason`, `minVersion`) when its novad is
// too old or the module is missing or not allowed; a module the policy does not allow cannot start
// (403 `module_not_allowed`); wakes are rate-limited (429 `wake_rate_limited`); power actions may
// be off in novad (403 `power_actions_disabled`) and Wake-on-LAN needs elevation (403
// `elevation_required`); files outside the user's folders answer 403 `folder_access_required`,
// protected paths 403 `protected_path`; the signed-in user asking for a folder is granted at once,
// anyone else gets a pending request with a Hub approval card, decided when that card is
// answered; committing a staged write whose file changed on the device marks it `conflict` and
// answers 409; a write that is not `staged` cannot be committed or discarded (409); an agent with
// another computer answers 409 `agent_connected` unless `replace`. Views handed out are copies.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6devices: M6DevicesState`,
// `createHub` defaults it to `m6DevicesState()`, and `impl` spreads
// `...m6DevicesImpl(state.m6devices, { id, ts: () => ts(), maybeFail, approvals: {
//   list: () => state.m3.approvals, add: (a) => { state.m3.approvals = [...state.m3.approvals, a]; } } })`.
// Until then tests build the client with `createDevicesHub()` and spread its `api` over
// `createHub().api` (see `renderWithDevices`).
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  connectAgentDeviceSchema,
  deviceAccessRequestSchema,
  deviceGrantSchema,
  devicePathSchema,
  devicePowerSchema,
  enrollDeviceSchema,
  pushDeviceUpdatesSchema,
  updateDeviceSchema,
  type AgentDeviceConnectionView,
  type AgentView,
  type ApprovalView,
  type DeviceAccessRequestView,
  type DeviceCapabilityName,
  type DeviceCapabilityStatus,
  type DeviceGrantee,
  type DeviceModuleName,
  type DeviceModuleView,
  type DeviceUpdateView,
  type DeviceView,
  type StagedWriteView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { DevicesApi } from '../src/devices/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
export const ACCOUNT_ID = 'a1';
const GIB = 1024 ** 3;
let n = 0;

// ---- the Hub's capability table (packages/core/src/devices/versions.ts) -------------------------

const CAPABILITY_MODULE: Record<DeviceCapabilityName, DeviceModuleName> = {
  files: 'storage',
  staged_writes: 'storage',
  exec: 'storage',
  mcp: 'storage',
  power: 'management',
  services: 'management',
  updates: 'management',
  computer_use: 'screen',
  browser: 'browser',
  capture: 'capture',
};

export const MIN_VERSIONS: Record<DeviceCapabilityName, string> = {
  files: '0.6.0',
  staged_writes: '0.6.0',
  exec: '0.6.0',
  mcp: '0.6.0',
  power: '0.6.0',
  services: '0.6.0',
  updates: '0.6.0',
  computer_use: '0.7.0',
  browser: '0.7.0',
  capture: '0.8.0',
};

function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Each capability with whether the device can serve it (FR-148). */
export function capabilityStatuses(d: {
  novadVersion: string | null;
  capability: Record<string, unknown> | null;
  policy: DeviceView['policy'];
}): DeviceCapabilityStatus[] {
  const mods = d.capability?.modules;
  const modules = Array.isArray(mods) ? (mods as string[]) : [];
  const allowed = d.policy.allowedModules ?? null;
  return (Object.keys(CAPABILITY_MODULE) as DeviceCapabilityName[]).map((name) => {
    const module = CAPABILITY_MODULE[name];
    const minVersion = MIN_VERSIONS[name];
    let reason: DeviceCapabilityStatus['reason'] = null;
    if (!modules.includes(module)) reason = 'module_missing';
    else if (allowed && !allowed.includes(module)) reason = 'module_not_allowed';
    else if (!d.novadVersion || compareVersions(d.novadVersion, minVersion) < 0)
      reason = 'update_required';
    return { name, module, minVersion, available: reason === null, reason };
  });
}

/** The derived fields of a device view, recomputed after a change. */
function derive(d: DeviceView): DeviceView {
  const capabilities = capabilityStatuses(d);
  return {
    ...d,
    capabilities,
    updateRequired: capabilities.some((c) => c.reason === 'update_required'),
    routingEligible: d.policy.routingEligible !== false,
  };
}

// ---- builders ------------------------------------------------------------------------------------

export function moduleView(over: Partial<DeviceModuleView> = {}): DeviceModuleView {
  return {
    name: 'storage',
    version: '0.7.0',
    state: 'running',
    pid: 4242,
    restarts: 0,
    lastExit: null,
    disabledReason: null,
    startedAt: T0,
    previousVersion: null,
    ...over,
  };
}

export const MAC = 'aa:bb:cc:dd:ee:ff';

export function deviceView(over: Partial<DeviceView> = {}): DeviceView {
  const base: DeviceView = {
    id: `dev${++n}`,
    name: 'Desk PC',
    roles: ['client'],
    status: 'active',
    platform: 'linux',
    novadVersion: '0.7.0',
    updateChannel: 'stable',
    endpoint: 'http://10.0.0.7:7420',
    capability: {
      schemaVersion: 1,
      deviceId: 'local-1',
      roles: ['client'],
      modules: ['browser', 'management', 'screen', 'storage'],
      hardware: {
        arch: 'x86_64',
        cores: 8,
        ramBytes: 16 * GIB,
        gpus: [{ vendor: 'nvidia', name: 'RTX 4070', vramBytes: 12 * GIB }],
        nic: { wol: true, macs: [MAC] },
      },
      os: { family: 'linux', version: '6.8', sandbox: { bubblewrap: true, podman: false } },
      services: { computeBackends: ['llama.cpp'] },
      power: { wakeable: true },
      locale: { timezone: 'Europe/Lisbon', locale: 'en-GB' },
      scheduling: { routingWeight: 10 },
      computePolicy: { maxConcurrentJobs: 2 },
    },
    capabilities: [],
    updateRequired: false,
    capabilityOverrides: {},
    policy: {},
    configPending: false,
    routingEligible: true,
    modules: [
      moduleView({ name: 'browser' }),
      moduleView({ name: 'management' }),
      moduleView({ name: 'screen' }),
      moduleView({ name: 'storage' }),
    ],
    wake: { wakeable: true, macs: [MAC] },
    lastSeenAt: T0,
    createdAt: T0,
  };
  return derive({ ...base, ...over });
}

export function grantView(over: Partial<DeviceAccessRequestView> = {}): DeviceAccessRequestView {
  return {
    id: `gr${++n}`,
    deviceId: 'dev1',
    grantee: { kind: 'user', id: ACCOUNT_ID },
    kind: 'folder',
    target: '/home/sam/notes',
    access: 'read',
    reason: null,
    status: 'granted',
    approvalId: null,
    decidedBy: 'hub',
    createdAt: T0,
    decidedAt: T0,
    ...over,
  };
}

/** A pending request from someone else, with its Hub approval card. */
export function pendingRequest(
  over: Partial<DeviceAccessRequestView> = {},
): DeviceAccessRequestView {
  const id = `gr${++n}`;
  return grantView({
    id,
    grantee: { kind: 'agent', id: 'ag1' },
    access: 'write',
    status: 'pending',
    approvalId: `ap-${id}`,
    decidedBy: null,
    decidedAt: null,
    ...over,
  });
}

export function stagedView(over: Partial<StagedWriteView> = {}): StagedWriteView {
  return {
    id: `st${++n}`,
    deviceId: 'dev1',
    grantee: { kind: 'agent', id: 'ag1' },
    sessionRef: 'agent:ag1',
    path: '/home/sam/notes/todo.md',
    baseSha256: 'b'.repeat(64),
    newSha256: 'c'.repeat(64),
    size: 42,
    diff: '--- a/todo.md\n+++ b/todo.md\n@@ -1,2 +1,2 @@\n # Todo\n-buy milk\n+buy oat milk\n',
    additions: 1,
    deletions: 1,
    binary: false,
    status: 'staged',
    error: null,
    createdAt: T0,
    committedAt: null,
    ...over,
  };
}

export function connectionView(
  over: Partial<AgentDeviceConnectionView> = {},
): AgentDeviceConnectionView {
  return {
    id: `cn${++n}`,
    agentId: 'ag1',
    deviceId: 'dev1',
    deviceName: 'Desk PC',
    capabilities: ['files', 'staged_writes', 'exec'],
    status: 'active',
    createdAt: T0,
    revokedAt: null,
    ...over,
  };
}

export function updateView(over: Partial<DeviceUpdateView> = {}): DeviceUpdateView {
  return {
    id: `up${++n}`,
    deviceId: 'dev1',
    target: 'novad',
    fromVersion: '0.6.0',
    toVersion: '0.7.0',
    channel: 'stable',
    status: 'applied',
    detail: null,
    createdAt: T0,
    ...over,
  };
}

/** An agent as the agents list returns it (only id and name matter here). */
export function agentChoice(id: string, name: string): AgentView {
  return { id, name } as AgentView;
}

/** A signed bundle as a file holds it (the schema's shape; the fake does not verify it). */
export function bundle(target: string, version: string) {
  return {
    manifest: { target, version, channel: 'stable', sha256: 'd'.repeat(64), size: 2048 },
    signature: 'A'.repeat(86),
    payload: 'AAAA',
  };
}

// ---- state ---------------------------------------------------------------------------------------

export interface M6DevicesState {
  devices: DeviceView[];
  /** Files on each device: absolute path → text, or null for a folder. */
  fs: Record<string, Record<string, string | null>>;
  grants: DeviceAccessRequestView[];
  staged: StagedWriteView[];
  /** Paths that changed on the device after staging: committing a write to one conflicts. */
  changedOnDevice: string[];
  connections: AgentDeviceConnectionView[];
  updates: DeviceUpdateView[];
  /** What the device answers to power status, per device id. */
  power: Record<string, Record<string, unknown>>;
  /** Devices whose novad config turns power actions off. */
  powerActionsOff: string[];
  /** Devices whose novad runs without elevation (Wake-on-LAN changes are refused). */
  noElevation: string[];
  /** Local MCP servers per device. */
  mcp: Record<string, { name: string; tools: { name: string; description?: string }[] }[]>;
  /** Managed services per device: name → state. */
  services: Record<string, Record<string, string>>;
  agents: AgentView[];
  wakes: { deviceId: string; mac: string; at: string }[];
  wakesPerHour: number;
  /** How an update to a target ends on the device (default `applied`). */
  updateOutcome: Record<string, DeviceUpdateView['status']>;
  enrollments: { token: string; roles: string[]; expiresAt: string }[];
}

export function m6DevicesState(init: Partial<M6DevicesState> = {}): M6DevicesState {
  return {
    devices: [],
    fs: {},
    grants: [],
    staged: [],
    changedOnDevice: [],
    connections: [],
    updates: [],
    power: {},
    powerActionsOff: [],
    noElevation: [],
    mcp: {},
    services: {},
    agents: [],
    wakes: [],
    wakesPerHour: 6,
    updateOutcome: {},
    enrollments: [],
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = (what = 'device') => err(404, 'not_found', `${what} not found`);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

const PROTECTED = /(^|[\\/])\.(ssh|gnupg|aws)([\\/]|$)/;

function under(folder: string, path: string): boolean {
  const f = folder.replace(/\/+$/, '');
  return path === f || path.startsWith(`${f}/`);
}

function b64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const sameGrantee = (a: DeviceGrantee, b: DeviceGrantee) => a.kind === b.kind && a.id === b.id;

export interface ApprovalStore {
  list: () => ApprovalView[];
  add: (a: ApprovalView) => void;
}

/** The Hub's approval card for a folder-access request. */
export function accessApproval(r: DeviceAccessRequestView, deviceName: string): ApprovalView {
  const verb = r.access === 'write' ? 'read and change' : 'read';
  return {
    id: r.approvalId ?? `ap-${r.id}`,
    threadId: null,
    turnId: null,
    callId: null,
    action: `Let ${r.grantee.kind} ${r.grantee.id} ${verb} ${r.target} on ${deviceName}`,
    tool: 'device.fs.request_access',
    argsPreview: JSON.stringify({ device: deviceName, path: r.target, access: r.access }),
    reason: `Requested by ${r.grantee.kind} ${r.grantee.id}`,
    tier: 'confirm_at_action',
    risk: r.access === 'write' ? 'medium' : 'low',
    userAsked: false,
    ruleId: null,
    options: ['allow_once', 'deny_continue'],
    alwaysScopes: [],
    status: 'pending',
    decision: null,
    decidedBy: null,
    createdAt: r.createdAt,
    expiresAt: '2026-10-02T12:00:00.000Z',
    decidedAt: null,
  };
}

export function m6DevicesImpl(
  st: M6DevicesState,
  deps: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof DevicesApi) => void;
    approvals: ApprovalStore;
  },
): DevicesApi {
  const { id, ts, maybeFail, approvals } = deps;
  const copy = <T>(v: T): T => structuredClone(v);
  const me: DeviceGrantee = { kind: 'user', id: ACCOUNT_ID };

  // Every pending request has its card (as the Hub inserts them together).
  for (const g of st.grants) {
    if (g.status !== 'pending' || !g.approvalId) continue;
    if (!approvals.list().some((a) => a.id === g.approvalId)) {
      const name = st.devices.find((d) => d.id === g.deviceId)?.name ?? 'the device';
      approvals.add(accessApproval(g, name));
    }
  }

  const device = (did: string): DeviceView => {
    const d = st.devices.find((x) => x.id === did);
    if (!d) throw notFound();
    return d;
  };
  const put = (d: DeviceView): DeviceView => {
    const next = derive(d);
    st.devices = st.devices.map((x) => (x.id === d.id ? next : x));
    return next;
  };
  /** A reachable device that can serve `caps` (DeviceService.#usable). */
  const usable = (did: string, caps: DeviceCapabilityName[]): DeviceView => {
    const d = device(did);
    if (d.status === 'revoked') throw notFound();
    if (d.status !== 'active' || !d.endpoint)
      throw err(503, 'node_unavailable', 'the device is not reachable', {
        reason: 'unreachable',
        status: d.status,
      });
    for (const c of caps) {
      const s = d.capabilities.find((x) => x.name === c);
      if (s && !s.available)
        throw err(400, 'capability_missing', `this device cannot serve ${c}`, {
          reason: s.reason,
          capability: c,
          module: s.module,
          minVersion: s.minVersion,
          novadVersion: d.novadVersion,
        });
    }
    return d;
  };
  const canRead = (did: string, g: DeviceGrantee, path: string, need: 'read' | 'write') => {
    if (PROTECTED.test(path))
      throw err(403, 'policy_denied', 'protected path', { reason: 'protected_path', path });
    const ok = st.grants.some(
      (x) =>
        x.deviceId === did &&
        x.status === 'granted' &&
        x.kind === 'folder' &&
        sameGrantee(x.grantee, g) &&
        under(x.target, path) &&
        (need === 'read' || x.access === 'write'),
    );
    if (!ok)
      throw err(403, 'policy_denied', `${path} is outside the folders granted to this session`, {
        reason: 'folder_access_required',
        path,
        access: need,
      });
  };
  const files = (did: string) => (st.fs[did] ??= {});
  /** Pending requests whose card was answered: the Hub passes the answer on (onApprovalDecided). */
  const syncDecisions = () => {
    const cards = approvals.list();
    st.grants = st.grants.map((g) => {
      if (g.status !== 'pending' || !g.approvalId) return g;
      const a = cards.find((x) => x.id === g.approvalId);
      if (!a || a.status !== 'decided' || !a.decision) return g;
      const granted = a.decision.startsWith('allow');
      return {
        ...g,
        status: granted ? 'granted' : 'denied',
        decidedBy: 'hub',
        decidedAt: ts(),
      } satisfies DeviceAccessRequestView;
    });
  };
  const grantFor = (
    did: string,
    grantee: DeviceGrantee,
    kind: 'folder' | 'mcp',
    target: string,
    access: DeviceAccessRequestView['access'],
  ): DeviceAccessRequestView => {
    const at = ts();
    // An upgraded grant replaces the older one for the same folder.
    st.grants = st.grants.map((x) =>
      x.deviceId === did &&
      x.status === 'granted' &&
      x.kind === kind &&
      x.target === target &&
      sameGrantee(x.grantee, grantee)
        ? { ...x, status: 'revoked' }
        : x,
    );
    const g = grantView({
      id: id('gr'),
      deviceId: did,
      grantee,
      kind,
      target,
      access,
      status: 'granted',
      decidedBy: 'hub',
      createdAt: at,
      decidedAt: at,
    });
    st.grants = [...st.grants, g];
    return g;
  };
  const folderExists = (did: string, path: string) => {
    if (files(did)[path.replace(/\/+$/, '') || '/'] !== null)
      throw err(404, 'not_found', 'the folder does not exist on this device');
  };

  return {
    listNovadDevices: async () => {
      maybeFail('listNovadDevices');
      return { items: copy(st.devices) };
    },
    enrollNovadDevice: async (body) => {
      maybeFail('enrollNovadDevice');
      const { roles } = parse(enrollDeviceSchema, body);
      const token = `nvd_${id('tok')}`;
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      st.enrollments = [...st.enrollments, { token, roles, expiresAt }];
      const roleArgs = roles.map((r) => ` --role ${r}`).join('');
      return {
        token,
        expiresAt,
        command: `novad enroll --hub http://hub.test --token ${token}${roleArgs} --endpoint http://<this-device>:7420`,
      };
    },
    getNovadDevice: async (did) => {
      maybeFail('getNovadDevice');
      return copy(device(did));
    },
    updateNovadDevice: async (did, body) => {
      maybeFail('updateNovadDevice');
      const d = device(did);
      const patch = parse(updateDeviceSchema, body);
      if (d.status === 'revoked') throw err(409, 'conflict', 'the device was revoked');
      const config =
        patch.capabilityOverrides !== undefined ||
        patch.policy !== undefined ||
        patch.updateChannel !== undefined;
      return copy(
        put({
          ...d,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.capabilityOverrides !== undefined
            ? { capabilityOverrides: patch.capabilityOverrides }
            : {}),
          ...(patch.policy !== undefined ? { policy: { ...d.policy, ...patch.policy } } : {}),
          ...(patch.updateChannel !== undefined ? { updateChannel: patch.updateChannel } : {}),
          // An online device takes the change at once; an offline one on its next heartbeat.
          configPending: config ? d.status !== 'active' : d.configPending,
        }),
      );
    },
    revokeNovadDevice: async (did) => {
      maybeFail('revokeNovadDevice');
      const d = device(did);
      if (d.status === 'revoked') return { ok: true as const };
      const at = ts();
      put({ ...d, status: 'revoked' });
      st.connections = st.connections.map((c) =>
        c.deviceId === did && c.status === 'active'
          ? { ...c, status: 'revoked', revokedAt: at }
          : c,
      );
      st.grants = st.grants.map((g) =>
        g.deviceId === did && (g.status === 'pending' || g.status === 'granted')
          ? { ...g, status: 'revoked', decidedAt: at }
          : g,
      );
      return { ok: true as const };
    },
    getDeviceCapabilities: async (did) => {
      maybeFail('getDeviceCapabilities');
      const d = device(did);
      return {
        novadVersion: d.novadVersion,
        updateRequired: d.updateRequired,
        items: copy(d.capabilities),
        document: copy(d.capability),
      };
    },

    deviceModuleAction: async (did, name, action) => {
      maybeFail('deviceModuleAction');
      const d = usable(did, ['services']);
      const allowed = d.policy.allowedModules;
      if (action !== 'stop' && allowed && !allowed.includes(name as DeviceModuleName))
        throw err(403, 'policy_denied', `the ${name} module is not allowed on this device`, {
          reason: 'module_not_allowed',
          module: name,
        });
      const m = d.modules.find((x) => x.name === name);
      if (!m) throw err(404, 'not_found', `no module named ${name}`);
      let next: DeviceModuleView;
      if (action === 'rollback') {
        if (!m.previousVersion)
          throw err(409, 'conflict', 'there is no previous version', { reason: 'no_previous' });
        next = { ...m, version: m.previousVersion, previousVersion: null, state: 'running' };
      } else if (action === 'stop') next = { ...m, state: 'stopped', pid: null };
      else
        next = {
          ...m,
          state: 'running',
          disabledReason: null,
          pid: 5000 + ++n,
          startedAt: ts(),
          restarts: action === 'restart' ? m.restarts + 1 : m.restarts,
        };
      put({ ...d, modules: d.modules.map((x) => (x.name === name ? next : x)) });
      return { module: copy(next) };
    },
    deviceServiceAction: async (did, name, action) => {
      maybeFail('deviceServiceAction');
      usable(did, ['services']);
      const svcs = (st.services[did] ??= {});
      const cur = svcs[name];
      if (cur === undefined) throw err(404, 'not_found', `no managed service named ${name}`);
      const state = action === 'stop' ? 'stopped' : action === 'status' ? cur : 'running';
      svcs[name] = state;
      return { service: { name, kind: 'module', state } };
    },
    getDevicePower: async (did) => {
      maybeFail('getDevicePower');
      const d = usable(did, ['power']);
      return copy(
        st.power[did] ?? {
          wakeable: d.wake.wakeable,
          macs: d.wake.macs,
          ac: true,
          afterPowerLoss: 'unknown',
        },
      );
    },
    devicePowerAction: async (did, body) => {
      maybeFail('devicePowerAction');
      const req = parse(devicePowerSchema, body);
      const d = usable(did, ['power']);
      const plan = [{ kind: 'command', argv: ['ethtool', '-s', 'eth0', 'wol', 'g'] }];
      switch (req.action) {
        case 'status':
          return copy(st.power[did] ?? { wakeable: d.wake.wakeable, macs: d.wake.macs });
        case 'wol-plan':
          return { plan, needsElevation: true };
        case 'wol-enable':
          if (!req.apply) return { applied: false, plan };
          if (st.noElevation.includes(did))
            throw err(403, 'policy_denied', 'enabling WoL needs novad to run with elevation', {
              reason: 'elevation_required',
            });
          st.power[did] = { ...st.power[did], wakeable: true, macs: [MAC] };
          put({ ...d, wake: { wakeable: true, macs: [MAC] } });
          return { applied: true };
        default:
          if (st.powerActionsOff.includes(did))
            throw err(403, 'policy_denied', 'power actions are off in this device’s novad config', {
              reason: 'power_actions_disabled',
            });
          return { ok: true, action: req.action };
      }
    },
    wakeDevice: async (did) => {
      maybeFail('wakeDevice');
      const d = device(did);
      if (d.status === 'revoked') throw notFound();
      const mac = d.wake.macs[0];
      if (!d.wake.wakeable || !mac)
        throw err(400, 'capability_missing', 'this device does not report Wake-on-LAN', {
          reason: 'not_wakeable',
        });
      if (st.wakes.filter((w) => w.deviceId === did).length >= st.wakesPerHour)
        throw err(429, 'rate_limited', `at most ${st.wakesPerHour} wakes per hour for a device`, {
          reason: 'wake_rate_limited',
          limit: st.wakesPerHour,
        });
      const at = ts();
      st.wakes = [...st.wakes, { deviceId: did, mac, at }];
      return { id: id('wk'), deviceId: did, mac, status: 'sent' as const, createdAt: at };
    },

    listDeviceUpdates: async (did) => {
      maybeFail('listDeviceUpdates');
      device(did);
      return {
        items: copy(
          st.updates
            .filter((u) => u.deviceId === did)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        ),
      };
    },
    pushDeviceUpdates: async (did, body) => {
      maybeFail('pushDeviceUpdates');
      const { bundles } = parse(pushDeviceUpdatesSchema, body);
      let d = usable(did, ['updates']);
      const ordered = [...bundles].sort(
        (a, b) => Number(a.manifest.target === 'novad') - Number(b.manifest.target === 'novad'),
      );
      const out: DeviceUpdateView[] = [];
      let failed = false;
      for (const b of ordered) {
        const m = b.manifest;
        const mod = d.modules.find((x) => x.name === m.target);
        const from = m.target === 'novad' ? d.novadVersion : (mod?.version ?? null);
        let status: DeviceUpdateView['status'] =
          failed && m.target === 'novad' ? 'refused' : (st.updateOutcome[m.target] ?? 'applied');
        if (status !== 'applied' && status !== 'staged') failed = true;
        if (status === 'applied') {
          if (m.target === 'novad') d = put({ ...d, novadVersion: m.version });
          else if (mod)
            d = put({
              ...d,
              modules: d.modules.map((x) =>
                x.name === m.target ? { ...x, version: m.version, previousVersion: x.version } : x,
              ),
            });
          else status = 'failed';
        }
        const u = updateView({
          id: id('up'),
          deviceId: did,
          target: m.target,
          fromVersion: from,
          toVersion: m.version,
          channel: m.channel,
          status,
          detail: status === 'refused' ? 'an earlier bundle did not apply' : null,
          createdAt: ts(),
        });
        out.push(u);
        st.updates = [...st.updates, u];
      }
      return { items: copy(out) };
    },

    listDeviceFiles: async (did, path) => {
      maybeFail('listDeviceFiles');
      parse(devicePathSchema, path);
      usable(did, ['files']);
      canRead(did, me, path, 'read');
      const fs = files(did);
      const dir = path.replace(/\/+$/, '') || '/';
      if (fs[dir] !== null) throw err(404, 'not_found', 'no such folder');
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const entries = Object.entries(fs)
        .filter(([p]) => p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, content]) => ({
          name: p.slice(prefix.length),
          kind: content === null ? ('dir' as const) : ('file' as const),
          size: content === null ? null : new TextEncoder().encode(content).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { path: dir, entries, truncated: false };
    },
    readDeviceFile: async (did, path, maxBytes) => {
      maybeFail('readDeviceFile');
      parse(devicePathSchema, path);
      usable(did, ['files']);
      canRead(did, me, path, 'read');
      const content = files(did)[path];
      if (content === undefined || content === null) throw err(404, 'not_found', 'no such file');
      const bytes = new TextEncoder().encode(content);
      const max = maxBytes ?? 1024 * 1024;
      let bin = '';
      for (const b of bytes.subarray(0, max)) bin += String.fromCharCode(b);
      return {
        path,
        contentBase64: btoa(bin),
        size: bytes.length,
        sha256: 'f'.repeat(64),
        truncated: bytes.length > max,
      };
    },
    listDeviceGrants: async (did) => {
      maybeFail('listDeviceGrants');
      device(did);
      syncDecisions();
      return {
        items: copy(
          st.grants.filter(
            (g) => g.deviceId === did && (g.status === 'pending' || g.status === 'granted'),
          ),
        ),
      };
    },
    createDeviceGrant: async (did, body) => {
      maybeFail('createDeviceGrant');
      const g = parse(deviceGrantSchema, body);
      if (g.kind === 'folder' && PROTECTED.test(g.path))
        throw err(403, 'policy_denied', 'protected path', {
          reason: 'protected_path',
          path: g.path,
        });
      usable(did, [g.kind === 'mcp' ? 'mcp' : 'files']);
      if (g.kind === 'folder') {
        folderExists(did, g.path);
        return copy(grantFor(did, g.grantee, 'folder', g.path, g.access));
      }
      return copy(grantFor(did, g.grantee, 'mcp', g.server, 'call'));
    },
    revokeDeviceGrant: async (did, grantId) => {
      maybeFail('revokeDeviceGrant');
      const g = st.grants.find((x) => x.id === grantId && x.deviceId === did);
      if (!g) throw notFound('grant');
      if (g.status === 'revoked' || g.status === 'denied') return { ok: true as const };
      usable(did, ['files']);
      st.grants = st.grants.map((x) =>
        x.id === grantId ? { ...x, status: 'revoked', decidedAt: ts() } : x,
      );
      return { ok: true as const };
    },
    requestDeviceAccess: async (did, body) => {
      maybeFail('requestDeviceAccess');
      const req = parse(deviceAccessRequestSchema, body);
      const d = usable(did, ['files']);
      if (PROTECTED.test(req.path))
        throw err(403, 'policy_denied', 'protected', { reason: 'protected_path' });
      folderExists(did, req.path);
      const grantee = req.grantee ?? me;
      // The signed-in user asking for themselves is the approval.
      if (grantee.kind === 'user')
        return copy(grantFor(did, grantee, 'folder', req.path, req.access));
      const g = pendingRequest({
        id: id('gr'),
        deviceId: did,
        grantee,
        target: req.path,
        access: req.access,
        reason: req.reason ?? null,
        createdAt: ts(),
      });
      const withCard = { ...g, approvalId: `ap-${g.id}` };
      st.grants = [...st.grants, withCard];
      approvals.add(accessApproval(withCard, d.name));
      return copy(withCard);
    },

    listStagedWrites: async (did, q = {}) => {
      maybeFail('listStagedWrites');
      device(did);
      return {
        items: copy(
          st.staged
            .filter(
              (w) =>
                w.deviceId === did &&
                (!q.status || w.status === q.status) &&
                (!q.sessionRef || w.sessionRef === q.sessionRef),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        ),
      };
    },
    getStagedWrite: async (did, sid) => {
      maybeFail('getStagedWrite');
      const w = st.staged.find((x) => x.id === sid);
      if (!w || w.deviceId !== did) throw notFound('staged write');
      return copy(w);
    },
    commitStagedWrite: async (did, sid) => {
      maybeFail('commitStagedWrite');
      const w = st.staged.find((x) => x.id === sid);
      if (!w || w.deviceId !== did) throw notFound('staged write');
      if (w.status !== 'staged')
        throw err(409, 'conflict', `the write is ${w.status}`, { reason: w.status });
      if (PROTECTED.test(w.path))
        throw err(403, 'policy_denied', 'protected path', { reason: 'protected_path' });
      usable(did, ['staged_writes']);
      const set = (patch: Partial<StagedWriteView>) => {
        st.staged = st.staged.map((x) => (x.id === sid ? { ...x, ...patch } : x));
      };
      if (st.changedOnDevice.includes(w.path)) {
        set({ status: 'conflict', error: 'the file changed since it was staged' });
        throw err(409, 'conflict', 'the file changed since it was staged');
      }
      set({ status: 'committed', committedAt: ts() });
      return copy(st.staged.find((x) => x.id === sid)!);
    },
    discardStagedWrite: async (did, sid) => {
      maybeFail('discardStagedWrite');
      const w = st.staged.find((x) => x.id === sid);
      if (!w || w.deviceId !== did) throw notFound('staged write');
      if (w.status !== 'staged')
        throw err(409, 'conflict', `the write is ${w.status}`, { reason: w.status });
      st.staged = st.staged.map((x) => (x.id === sid ? { ...x, status: 'discarded' } : x));
      return copy(st.staged.find((x) => x.id === sid)!);
    },

    listDeviceMcp: async (did) => {
      maybeFail('listDeviceMcp');
      usable(did, ['mcp']);
      const granted = (name: string) =>
        st.grants.some(
          (g) =>
            g.deviceId === did &&
            g.status === 'granted' &&
            g.kind === 'mcp' &&
            g.target === name &&
            sameGrantee(g.grantee, me),
        );
      return { servers: copy((st.mcp[did] ?? []).filter((s) => granted(s.name))) };
    },

    listDeviceConnections: async (q = {}) => {
      maybeFail('listDeviceConnections');
      return {
        items: copy(
          st.connections
            .filter(
              (c) =>
                (!q.agentId || c.agentId === q.agentId) &&
                (!q.deviceId || c.deviceId === q.deviceId),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        ),
      };
    },
    connectDevice: async (body) => {
      maybeFail('connectDevice');
      const input = parse(connectAgentDeviceSchema, body);
      if (!st.agents.some((a) => a.id === input.agentId)) throw notFound('agent');
      const d = device(input.deviceId);
      if (d.status === 'revoked') throw notFound();
      if (!d.routingEligible)
        throw err(403, 'policy_denied', 'this device is not eligible for agent work', {
          reason: 'not_routing_eligible',
        });
      for (const c of input.capabilities) {
        const s = d.capabilities.find((x) => x.name === c);
        if (s && !s.available)
          throw err(400, 'capability_missing', `this device cannot serve ${c}`, {
            reason: s.reason,
            capability: c,
            module: s.module,
            minVersion: s.minVersion,
            novadVersion: d.novadVersion,
          });
      }
      const caps = [...new Set(input.capabilities)];
      const current = st.connections.find(
        (c) => c.agentId === input.agentId && c.status === 'active',
      );
      if (current && current.deviceId === input.deviceId) {
        st.connections = st.connections.map((c) =>
          c.id === current.id ? { ...c, capabilities: caps } : c,
        );
        return copy(st.connections.find((c) => c.id === current.id)!);
      }
      if (current && !input.replace)
        throw err(409, 'conflict', 'this agent already has a connected computer', {
          reason: 'agent_connected',
          connectionId: current.id,
          deviceId: current.deviceId,
        });
      const at = ts();
      if (current)
        st.connections = st.connections.map((c) =>
          c.id === current.id ? { ...c, status: 'revoked', revokedAt: at } : c,
        );
      const conn = connectionView({
        id: id('cn'),
        agentId: input.agentId,
        deviceId: d.id,
        deviceName: d.name,
        capabilities: caps,
        createdAt: at,
      });
      st.connections = [...st.connections, conn];
      return copy(conn);
    },
    disconnectDevice: async (cid) => {
      maybeFail('disconnectDevice');
      const c = st.connections.find((x) => x.id === cid);
      if (!c) throw notFound('connection');
      if (c.status === 'revoked') return copy(c);
      const at = ts();
      st.connections = st.connections.map((x) =>
        x.id === cid ? { ...x, status: 'revoked', revokedAt: at } : x,
      );
      // The agent's grants on the device go with it.
      st.grants = st.grants.map((g) =>
        g.deviceId === c.deviceId &&
        g.grantee.kind === 'agent' &&
        g.grantee.id === c.agentId &&
        (g.status === 'pending' || g.status === 'granted')
          ? { ...g, status: 'revoked', decidedAt: at }
          : g,
      );
      return copy(st.connections.find((x) => x.id === cid)!);
    },
    listDeviceAgentChoices: async () => {
      maybeFail('listDeviceAgentChoices');
      return { items: copy(st.agents) };
    },
  };
}

// ---- test helpers ----------------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type DevicesMocks = DevicesApi &
  Record<keyof DevicesApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createDevicesHub(
  init: Partial<M6DevicesState> = {},
  opts: {
    approvals?: ApprovalStore;
    /** A state to use instead of a new one (the main fake Hub's, so every part sees one). */
    state?: M6DevicesState;
  } = {},
) {
  const state = opts.state ?? m6DevicesState(init);
  const own: ApprovalView[] = [];
  const approvals = opts.approvals ?? {
    list: () => own,
    add: (a: ApprovalView) => {
      own.push(a);
    },
  };
  const failNext: Partial<Record<keyof DevicesApi, Error>> = {};
  const impl = m6DevicesImpl(state, {
    id: nextId,
    ts: nextTs,
    approvals,
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
  ) as unknown as DevicesMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the devices views need, with the main fake Hub's client and
 * the devices part spread over it (what `createApi` will do). Folder-access cards go to the main
 * fake's approvals, so `decideApproval` answers them as on the Hub.
 */
export async function renderWithDevices(
  ui: ReactNode,
  opts: {
    devices?: Partial<M6DevicesState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
  } = {},
) {
  // One devices state for the main fake Hub and this part: the Hub's other areas that read
  // devices (M7.5 device operations and out-of-band) see the same ones.
  const hub = createHub({ m6devices: m6DevicesState(opts.devices) });
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const devices = createDevicesHub(
    {},
    {
      approvals: {
        list: () => hub.state.m3.approvals,
        add: (a) => {
          hub.state.m3.approvals = [...hub.state.m3.approvals, a];
        },
      },
      state: hub.state.m6devices,
    },
  );
  const api = { ...hub.api, ...devices.api };
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
  return { hub, devices, api: devices.api, state: devices.state, ...utils };
}

/** Text as the device stores it, base64 (for a hand-made read result). */
export const base64Text = b64;
