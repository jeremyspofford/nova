// The fake Hub's M6.5 Network part: the network panel and diagnostics, the Network Setup
// assistant, trust and the Relay, in memory, with the Hub's rules from apps/hub/src/{network,
// network-setup,trust,relay}.ts and packages/core/src/network/setup/service.ts:
// - PATCH /network is all or nothing: 400 `validation` with zod `issues`, `no_transport` when every
//   transport would be off, `url_required` for Direct public without a URL, `unknown_device` for
//   a Wake helper that is not one; each real change is recorded for rollback. Testing before the
//   Hub listens answers 400 `no_listener`. Rollback reverts the newest applied change and answers
//   409 `nothing_to_roll_back` when there is none (404 for an unknown `changeId`).
// - Setup: plans check the options with the Hub's schema and the provider rules
//   (`control_url_required`, `auth_key_required`, `api_key_required`, `wireguard_options_required`,
//   `mesh_certs_unavailable`); applying follows the Hub's order of refusals (404, 409
//   `nothing_to_apply`, `not_applicable`, `already_applied`, `earlier_step_pending`, `setup_busy`,
//   403 `system_changes_disabled` when `network.setup.allowSystemChanges` is off, 409
//   `would_lock_out`, 403 `consent_required` with the exact description) and a scripted outcome
//   per step (`verified` by default, or `rolled_back`, `rollback_failed`, `failed`); rollback
//   refuses `not_last_step` and `nothing_to_roll_back`. Consents are per kind and provider.
// - Trust: PATCH refuses a managed value (403 `managed`); renew answers 409 `trust_off`,
//   `no_local_ca` or `no_mesh_cert`. Relay: PATCH checks the URL and managed values; revoking an
//   unknown client is 404. Views handed out are copies.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m65network: M65NetworkState`,
// `createHub` defaults it to `m65NetworkState()`, and `impl` spreads
// `...m65NetworkImpl(state.m65network, { id, ts: () => ts(), maybeFail, setting: (k) =>
// resolveSetting(k, layers()).value })`. Until then tests build the client with
// `createNetworkHub()` and spread its `api` over `createHub().api` (see `renderWithNetwork`).
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  RELAY_HOSTED_URL,
  networkSetupOptionsSchema,
  patchRelaySchema,
  resolveSetting,
  trustPatchSchema,
  updateNetworkSchema,
  type DeviceReachabilityView,
  type EndpointCandidate,
  type MeshProvider,
  type NetworkChangeView,
  type NetworkDetectionView,
  type NetworkListenerView,
  type NetworkSetupConsentView,
  type NetworkSetupOptions,
  type NetworkSetupRunView,
  type NetworkSetupStepView,
  type NetworkTransportView,
  type RelayConfigView,
  type RelayPairedClientView,
  type RelayTestView,
  type SettingKey,
  type SettingValue,
  type TransportEventView,
  type TrustView,
  type WakeHelperView,
  type WakeLogView,
} from '@nova/shared';
import type { z } from 'zod';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { NetworkPanel, NetworkSurfaceApi } from '../src/netsurface/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;
const nid = (p: string) => `${p}${++n}`;

// ---- builders ----------------------------------------------------------------------------------

export function endpoint(over: Partial<EndpointCandidate> = {}): EndpointCandidate {
  return {
    transport: 'lan',
    url: 'http://192.168.1.10:8443',
    priority: 10,
    health: 'ok',
    latencyMs: 3,
    checkedAt: T0,
    detail: 'eth0',
    ...over,
  };
}

export function transportView(over: Partial<NetworkTransportView> = {}): NetworkTransportView {
  return { transport: 'lan', enabled: true, status: 'up', endpoints: [], detail: null, ...over };
}

export function changeView(over: Partial<NetworkChangeView> = {}): NetworkChangeView {
  return {
    id: nid('ch'),
    kind: 'network.settings',
    summary: 'Changed transports',
    actor: 'user',
    status: 'applied',
    error: null,
    createdAt: T0,
    rolledBackAt: null,
    ...over,
  };
}

export function eventView(over: Partial<TransportEventView> = {}): TransportEventView {
  return {
    id: nid('ev'),
    kind: 'advertised',
    transport: 'lan',
    fromTransport: null,
    url: 'http://192.168.1.10:8443',
    detail: null,
    createdAt: T0,
    ...over,
  };
}

export function reachability(over: Partial<DeviceReachabilityView> = {}): DeviceReachabilityView {
  return {
    deviceId: nid('dev'),
    name: 'Desk PC',
    kind: 'novad',
    roles: ['client'],
    status: 'active',
    lastSeenAt: T0,
    reachable: true,
    relayPaired: false,
    endpoints: [],
    ...over,
  };
}

export function wakeHelper(over: Partial<WakeHelperView> = {}): WakeHelperView {
  return {
    deviceId: nid('wh'),
    name: 'Garage NUC',
    status: 'active',
    addresses: ['192.168.1.20'],
    subnets: ['192.168.1.0/24'],
    lastSeenAt: T0,
    ...over,
  };
}

export function detectionView(over: Partial<NetworkDetectionView> = {}): NetworkDetectionView {
  const mesh = (provider: MeshProvider) => ({
    provider,
    installed: false,
    version: null,
    loggedIn: false,
    state: null,
    controlUrl: null,
    ips: [],
    dnsName: null,
    tags: [],
    peers: [],
    routes: [],
    exitNode: false,
    detail: 'not installed',
  });
  return {
    platform: 'linux',
    interfaces: [
      {
        name: 'eth0',
        kind: 'lan',
        provider: null,
        addresses: [{ address: '192.168.1.10', family: 'IPv4', cidr: '192.168.1.10/24' }],
      },
      {
        name: 'lo',
        kind: 'loopback',
        provider: null,
        addresses: [{ address: '127.0.0.1', family: 'IPv4', cidr: '127.0.0.1/8' }],
      },
    ],
    subnets: ['192.168.1.0/24'],
    dns: { nameservers: ['192.168.1.1'], search: ['lan'], source: '/etc/resolv.conf' },
    meshes: [mesh('headscale'), mesh('tailscale'), mesh('netbird'), mesh('wireguard')],
    firewall: { tool: 'ufw', active: true, detail: null },
    packageManager: 'apt',
    meshUrls: [],
    detectedAt: T0,
    ...over,
  };
}

export function stepView(over: Partial<NetworkSetupStepView> = {}): NetworkSetupStepView {
  return {
    id: nid('st'),
    runId: 'run1',
    index: 0,
    kind: 'mesh.up',
    provider: 'tailscale',
    title: 'Join the tailnet',
    description: 'Log the Hub in to Tailscale (tailscale up --auth-key=<secret>).',
    commands: [['tailscale', 'up', '--auth-key=<secret>']],
    undoCommands: [],
    affects: [],
    undoAffects: [],
    systemChange: true,
    status: 'pending',
    consent: { required: true, remembered: false },
    checks: [],
    error: null,
    autoRolledBack: false,
    appliedAt: null,
    verifiedAt: null,
    rolledBackAt: null,
    ...over,
  };
}

export function runView(over: Partial<NetworkSetupRunView> = {}): NetworkSetupRunView {
  const id = over.id ?? nid('run');
  return {
    id,
    provider: 'tailscale',
    status: 'planned',
    options: {},
    outputs: {},
    steps: [],
    error: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function trustView(over: Partial<TrustView> = {}): TrustView {
  return {
    mode: 'local-ca',
    meshCerts: true,
    pinNativeShells: true,
    hubFingerprint: 'hubFp_8Qx3c2T9b0',
    hubPublicKey: 'pk',
    serving: { scheme: 'https', source: 'trust' },
    restartRequired: false,
    ca: {
      fingerprint: 'AB:CD:EF:01',
      subject: 'CN=Nova Hub CA',
      notBefore: T0,
      notAfter: '2036-10-01T12:00:00.000Z',
      nameConstraints: { dns: ['local', 'lan'], ip: ['192.168.0.0/16'] },
    },
    leaf: {
      serial: '01',
      sans: ['studio.local', '192.168.1.10'],
      notBefore: T0,
      notAfter: '2026-12-30T12:00:00.000Z',
      renewAt: '2026-11-30T12:00:00.000Z',
    },
    meshCert: null,
    issued: [],
    problems: [],
    ...over,
  };
}

export function relayClient(over: Partial<RelayPairedClientView> = {}): RelayPairedClientView {
  return {
    id: nid('rc'),
    deviceId: nid('dev'),
    requestId: null,
    name: 'Sam’s phone',
    platform: 'iOS',
    kind: 'native',
    status: 'active',
    routeId: 'r1',
    relayUrl: 'wss://relay.example.com',
    createdAt: T0,
    lastSeenAt: T0,
    revokedAt: null,
    ...over,
  };
}

// ---- state -------------------------------------------------------------------------------------

type Outcome = 'verified' | 'rolled_back' | 'rollback_failed' | 'failed';

export interface M65NetworkState {
  transports: { lan: boolean; mesh: boolean; relay: boolean; directPublic: boolean };
  mdns: boolean;
  mdnsName: string | null;
  /** The name mDNS answers to when none is set (the computer's host name). */
  hostName: string;
  includeLoopback: boolean;
  includeLinkLocal: boolean;
  directPublicUrl: string | null;
  healthCheckSeconds: number;
  wakeHelpers: string[];
  availableHelpers: WakeHelperView[];
  /** Past wakes as the Hub lists them (newest first). */
  recentWakes: WakeLogView[];
  listener: NetworkListenerView | null;
  /** The last check's transports ([] before the first check). */
  checked: NetworkTransportView[];
  checkedAt: string | null;
  events: TransportEventView[];
  changes: (NetworkChangeView & { undo?: Record<string, unknown> })[];
  /** The next rollback fails with this message (the change keeps it as its error). */
  rollbackError: string | null;
  devices: DeviceReachabilityView[];
  problems: string[];
  mesh: Record<string, unknown> | null;
  relayStatus: Record<string, unknown> | null;
  egressMode: string;
  // setup
  detection: NetworkDetectionView;
  runs: NetworkSetupRunView[];
  consents: (NetworkSetupConsentView & { revoked?: boolean })[];
  outcomes: Record<string, Outcome>;
  /** Steps (by id) whose apply or undo would cut the owner's path. */
  lockOut: string[];
  /** Steps (by id) whose undo fails. */
  undoFails: string[];
  busy: boolean;
  verifyOk: boolean;
  // trust
  trust: TrustView;
  managedTrust: string[];
  // relay
  relay: RelayConfigView;
  relayClients: RelayPairedClientView[];
  relayTest: RelayTestView | null;
  managedRelay: string[];
}

export function m65NetworkState(init: Partial<M65NetworkState> = {}): M65NetworkState {
  return {
    transports: { lan: true, mesh: true, relay: true, directPublic: false },
    mdns: true,
    mdnsName: null,
    hostName: 'studio',
    includeLoopback: false,
    includeLinkLocal: false,
    directPublicUrl: null,
    healthCheckSeconds: 60,
    wakeHelpers: [],
    availableHelpers: [],
    recentWakes: [],
    listener: { host: '0.0.0.0', port: 8443, protocol: 'https' },
    checked: [
      transportView({ transport: 'lan', endpoints: [endpoint()] }),
      transportView({ transport: 'mesh', status: 'none', detail: 'no mesh is set up' }),
      transportView({ transport: 'relay', status: 'none', detail: 'the Relay is off' }),
      transportView({
        transport: 'direct',
        enabled: false,
        status: 'off',
        detail: 'direct is not advertised',
      }),
    ],
    checkedAt: T0,
    events: [],
    changes: [],
    rollbackError: null,
    devices: [],
    problems: [],
    mesh: null,
    relayStatus: { state: 'disabled', detail: null, url: null, latencyMs: null },
    egressMode: 'allowlist',
    detection: detectionView(),
    runs: [],
    consents: [],
    outcomes: {},
    lockOut: [],
    undoFails: [],
    busy: false,
    verifyOk: true,
    trust: trustView(),
    managedTrust: [],
    relay: {
      enabled: false,
      url: '',
      selfHosted: true,
      effectiveUrl: '',
      status: {
        state: 'disabled',
        detail: null,
        url: null,
        routeId: null,
        since: T0,
        latencyMs: null,
      },
      clients: { active: 0, pending: 0 },
    },
    relayClients: [],
    relayTest: null,
    managedRelay: [],
    ...init,
  };
}

// ---- errors ------------------------------------------------------------------------------------

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });
const notFound = (what: string) => fail(404, 'not_found', `${what} not found`);
const conflict = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  fail(409, 'conflict', message, { reason, ...details });
const invalid = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  fail(400, 'validation', message, { reason, ...details });
const zodFail = (err: z.ZodError, prefix = '') =>
  fail(400, 'validation', 'request failed validation', {
    issues: err.issues.map((i) => ({
      path: `${prefix}${i.path.join('.')}`,
      message: i.message,
    })),
  });

const copy = <T>(v: T): T => structuredClone(v);

// ---- the implementation ------------------------------------------------------------------------

const DONE = new Set(['verified', 'manual', 'skipped']);
const KEYS = [
  'transports',
  'mdns',
  'mdnsName',
  'includeLoopback',
  'includeLinkLocal',
  'directPublicUrl',
  'healthCheckSeconds',
  'wakeHelpers',
] as const;
type Key = (typeof KEYS)[number];

export function m65NetworkImpl(
  st: M65NetworkState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof NetworkSurfaceApi) => void;
    setting: <K extends SettingKey>(key: K) => SettingValue<K>;
  },
): NetworkSurfaceApi {
  const { id, ts, maybeFail, setting } = helpers;

  const transportsNow = (): NetworkTransportView[] => {
    const on = {
      lan: st.transports.lan,
      mesh: st.transports.mesh,
      relay: st.transports.relay,
      direct: st.transports.directPublic,
    };
    if (st.checked.length === 0)
      return (['lan', 'mesh', 'relay', 'direct'] as const).map((t) =>
        transportView({
          transport: t,
          enabled: on[t],
          status: on[t] ? 'none' : 'off',
          detail: st.listener ? 'not tested yet' : 'the Hub has not reported where it listens yet',
        }),
      );
    return st.checked.map((t) => {
      const enabled = on[t.transport];
      return enabled
        ? { ...t, enabled }
        : {
            ...t,
            enabled,
            status: 'off',
            endpoints: [],
            detail: `${t.transport} is not advertised`,
          };
    });
  };
  const advertised = () =>
    transportsNow()
      .filter((t) => t.enabled)
      .flatMap((t) => t.endpoints.filter((c) => c.health === 'ok'))
      .sort((a, b) => a.priority - b.priority);
  const primary = () => advertised()[0]?.transport ?? null;
  const lastChange = () => st.changes.find((c) => c.status === 'applied') ?? null;
  const strip = (c: NetworkChangeView & { undo?: unknown }): NetworkChangeView => {
    const { undo: _undo, ...rest } = c;
    return copy(rest);
  };

  const panel = (): NetworkPanel => {
    const last = lastChange();
    return copy({
      transports: transportsNow(),
      advertised: advertised(),
      primary: primary(),
      listener: st.listener,
      lan: {
        mdns: {
          enabled: st.mdns,
          running: st.mdns && st.transports.lan,
          name: st.mdnsName ?? st.hostName,
        },
        includeLoopback: st.includeLoopback,
        includeLinkLocal: st.includeLinkLocal,
      },
      directPublic: { url: st.directPublicUrl },
      healthCheckSeconds: st.healthCheckSeconds,
      trust: null,
      egress: { mode: st.egressMode, href: '/api/v1/egress' },
      wakeHelpers: {
        configured: st.wakeHelpers,
        available: st.availableHelpers,
        recent: st.recentWakes,
      },
      lastChange: last ? strip(last) : null,
    });
  };

  const read = (k: Key): unknown => copy(st[k]);
  const write = (k: Key, v: unknown) => {
    (st as unknown as Record<Key, unknown>)[k] = copy(v);
  };

  // ---- setup ----------------------------------------------------------------------------------

  const run = (rid: string) => {
    const r = st.runs.find((x) => x.id === rid);
    if (!r) throw notFound('setup run');
    return r;
  };
  const consentFor = (s: NetworkSetupStepView) =>
    st.consents.find((c) => !c.revoked && c.kind === s.kind && c.provider === s.provider) ?? null;
  const runOut = (r: NetworkSetupRunView): NetworkSetupRunView =>
    copy({
      ...r,
      steps: [...r.steps]
        .sort((a, b) => a.index - b.index)
        .map((s) => ({
          ...s,
          consent: {
            required: s.consent.required,
            remembered: consentFor(s)?.description === s.description,
          },
        })),
    });
  const settle = (r: NetworkSetupRunView) => {
    r.updatedAt = ts();
    if (r.steps.every((s) => DONE.has(s.status))) r.status = 'completed';
    else if (r.steps.some((s) => s.status === 'failed' || s.status === 'rollback_failed'))
      r.status = 'failed';
    else if (
      r.steps.every(
        (s) => s.status === 'pending' || s.status === 'rolled_back' || DONE.has(s.status),
      ) &&
      r.steps.some((s) => s.status === 'rolled_back')
    )
      r.status = 'rolled_back';
    else r.status = 'in_progress';
  };
  const isChange = (s: NetworkSetupStepView) => s.consent.required;
  const allow = () => setting('network.setup.allowSystemChanges');

  const planSteps = (
    rid: string,
    provider: MeshProvider,
    o: NetworkSetupOptions,
  ): NetworkSetupStepView[] => {
    const steps: Partial<NetworkSetupStepView>[] = [];
    const mesh = st.detection.meshes.find((m) => m.provider === provider);
    if (o.installClient !== false && !mesh?.installed)
      steps.push({
        kind: 'client.install',
        provider: 'os',
        title: `Install ${provider === 'headscale' ? 'Tailscale' : provider}`,
        description: `Install the ${provider} client with apt (apt-get install -y ${provider}).`,
        commands: [['apt-get', 'install', '-y', provider]],
      });
    if (provider === 'headscale') {
      steps.push({
        kind: 'server.user',
        provider: 'headscale',
        title: `Headscale user ${o.headscale?.user ?? 'nova'}`,
        description: `Create the user ${o.headscale?.user ?? 'nova'} on the Headscale server if it does not exist.`,
        commands: [['headscale', 'users', 'create', o.headscale?.user ?? 'nova']],
      });
      if (o.headscale?.acl !== false)
        steps.push({
          kind: 'server.acl',
          provider: 'headscale',
          title: 'Tags and access rules',
          description: 'Update the ACL policy so Nova devices reach tag:nova-hub on TCP 8443.',
          commands: [['headscale', 'policy', 'set', '--file', '<new policy file>']],
          affects: ['mesh'],
          undoAffects: ['mesh'],
        });
    }
    steps.push({
      kind: 'mesh.up',
      provider: provider === 'headscale' ? 'tailscale' : provider,
      title: provider === 'wireguard' ? 'Bring up wg-nova' : `Join ${provider}`,
      description: `Join the ${provider} mesh as ${o.hostname ?? 'nova-hub'}.`,
      commands: [[provider === 'netbird' ? 'netbird' : 'tailscale', 'up']],
      undoCommands: [[provider === 'netbird' ? 'netbird' : 'tailscale', 'down']],
    });
    if (provider === 'netbird')
      steps.push({
        kind: 'mesh.routes',
        provider: 'netbird',
        title: 'Subnet routes',
        description: 'Add the routes in the NetBird management console; Nova cannot do this one.',
        commands: [],
        systemChange: false,
        status: 'manual',
        consent: { required: false, remembered: false },
      });
    steps.push({
      kind: 'firewall.ports',
      provider: 'ufw',
      title: 'Firewall',
      description: 'Allow 8443/tcp on the mesh interface in ufw.',
      commands: [
        ['ufw', 'allow', 'in', 'on', 'tailscale0', 'to', 'any', 'port', '8443', 'proto', 'tcp'],
      ],
      undoCommands: [
        ['ufw', 'delete', 'allow', 'in', 'on', 'tailscale0', 'to', 'any', 'port', '8443'],
      ],
    });
    steps.push({
      kind: 'reachability',
      provider: 'hub',
      title: 'Reachability test',
      description: 'Test that the Hub answers on its mesh address.',
      commands: [],
      systemChange: false,
      consent: { required: false, remembered: false },
    });
    return steps.map((s, index) => stepView({ runId: rid, index, ...s }));
  };

  const plan = (provider: MeshProvider, body: unknown): NetworkSetupRunView => {
    const parsed = networkSetupOptionsSchema.safeParse(body ?? {});
    if (!parsed.success) throw zodFail(parsed.error, 'options.');
    const o = parsed.data;
    const loggedIn = (p: MeshProvider) =>
      st.detection.meshes.find((m) => m.provider === p)?.loggedIn ?? false;
    if (provider === 'headscale') {
      if (!o.controlUrl)
        throw invalid('control_url_required', 'the Headscale server URL (controlUrl) is required');
      if (o.headscale?.cliAddress && !o.headscale.apiKey)
        throw invalid('api_key_required', 'a remote Headscale needs its API key');
      if (o.certs === 'mesh')
        throw invalid(
          'mesh_certs_unavailable',
          'Headscale cannot issue mesh certificates; use local-ca',
        );
    }
    if ((provider === 'tailscale' || provider === 'netbird') && !loggedIn(provider) && !o.authKey)
      throw invalid('auth_key_required', `a ${provider} auth key (authKey) is required to join`);
    if (provider === 'wireguard') {
      if (!o.wireguard)
        throw invalid('wireguard_options_required', 'WireGuard needs an address and its peers');
      if (o.certs === 'mesh')
        throw invalid('mesh_certs_unavailable', 'WireGuard has no mesh certificates; use local-ca');
    }
    const rid = id('run');
    const options: Record<string, unknown> = { ...o };
    if (o.authKey) options.authKey = 'stored';
    if (o.headscale?.apiKey) options.headscale = { ...o.headscale, apiKey: 'stored' };
    const r = runView({
      id: rid,
      provider,
      options,
      outputs:
        provider === 'wireguard'
          ? { wireguardPublicKey: 'hUbPuBlIcKeY0123456789abcdefghijklmnopqrstu=' }
          : {},
      steps: planSteps(rid, provider, o),
      createdAt: ts(),
      updatedAt: ts(),
    });
    st.runs = [r, ...st.runs];
    return runOut(r);
  };

  const apply = (
    rid: string,
    opts: { stepId?: string; consent?: { stepId: string; description: string } },
  ) => {
    const r = run(rid);
    const steps = [...r.steps].sort((a, b) => a.index - b.index);
    const step = opts.stepId
      ? steps.find((s) => s.id === opts.stepId)
      : steps.find((s) => ['pending', 'failed', 'rolled_back'].includes(s.status));
    if (!step) {
      if (opts.stepId) throw notFound('setup step');
      throw conflict('nothing_to_apply', 'every step of this run is done');
    }
    if (step.status === 'manual' || step.status === 'skipped')
      throw conflict('not_applicable', 'this step is done by hand or already in place');
    if (step.status === 'applied' || step.status === 'verified')
      throw conflict('already_applied', 'this step is applied');
    const earlier = steps.find(
      (s) =>
        s.index < step.index &&
        s.status !== 'manual' &&
        s.status !== 'skipped' &&
        s.status !== 'verified',
    );
    if (earlier)
      throw conflict('earlier_step_pending', `apply "${earlier.title}" first`, {
        stepId: earlier.id,
      });
    if (st.busy) throw conflict('setup_busy', 'another setup step is running');
    const at = ts();
    if (isChange(step)) {
      if (step.systemChange && !allow())
        throw fail(
          403,
          'policy_denied',
          'host changes are off: turn on network.setup.allowSystemChanges to let Nova run this step',
          { reason: 'system_changes_disabled', setting: 'network.setup.allowSystemChanges' },
        );
      if (st.lockOut.includes(step.id))
        throw conflict(
          'would_lock_out',
          'this step could cut the lan path you are using, and no other path to the Hub passes its test',
          { transport: 'lan', affects: step.affects },
        );
      if (!consentFor(step)) {
        const given = opts.consent;
        if (!given || given.stepId !== step.id || given.description !== step.description)
          throw fail(403, 'policy_denied', 'confirm this step first: send its description back', {
            reason: 'consent_required',
            stepId: step.id,
            description: step.description,
          });
        st.consents = [
          ...st.consents,
          {
            id: id('consent'),
            kind: step.kind,
            provider: step.provider,
            description: step.description,
            grantedAt: at,
          },
        ];
      }
    }
    const outcome = st.outcomes[step.id] ?? 'verified';
    step.appliedAt = at;
    if (outcome === 'verified') {
      step.status = 'verified';
      step.error = null;
      step.autoRolledBack = false;
      step.verifiedAt = at;
      step.checks = [
        { name: 'mesh reachable', ok: true, detail: 'https://nova-hub.example.ts.net:8443' },
      ];
    } else if (outcome === 'failed') {
      step.status = 'failed';
      step.error = 'the command failed: exit code 1';
    } else {
      step.status = outcome;
      step.autoRolledBack = true;
      step.rolledBackAt = at;
      step.checks = [{ name: 'mesh reachable', ok: false, detail: 'timed out' }];
      step.error =
        outcome === 'rolled_back'
          ? 'the mesh path failed its reachability test'
          : 'the mesh path failed its reachability test; the rollback failed too: tailscale down: exit code 1';
    }
    settle(r);
    const out = runOut(r);
    return { action: 'apply' as const, run: out, step: out.steps.find((s) => s.id === step.id)! };
  };

  const rollbackRun = (rid: string, stepId?: string): NetworkSetupRunView => {
    const r = run(rid);
    const applied = r.steps
      .filter((s) => ['applied', 'verified', 'rollback_failed'].includes(s.status) && isChange(s))
      .sort((a, b) => b.index - a.index);
    let targets = applied;
    if (stepId) {
      const last = applied[0];
      if (!last || last.id !== stepId)
        throw conflict(
          'not_last_step',
          'only the last applied step can be rolled back alone; roll back the run instead',
        );
      targets = [last];
    }
    if (!targets.length) throw conflict('nothing_to_roll_back', 'nothing in this run is applied');
    if (st.busy) throw conflict('setup_busy', 'another setup step is running');
    if (targets.some((s) => s.systemChange) && !allow())
      throw fail(
        403,
        'policy_denied',
        'host changes are off: turn on network.setup.allowSystemChanges to roll back',
        {
          reason: 'system_changes_disabled',
          setting: 'network.setup.allowSystemChanges',
        },
      );
    if (targets.some((s) => st.lockOut.includes(s.id)))
      throw conflict(
        'would_lock_out',
        'rolling this back could cut the path you are using, and no other path to the Hub passes its test',
      );
    for (const s of targets) {
      if (st.undoFails.includes(s.id)) {
        s.status = 'rollback_failed';
        s.error = 'ufw delete: exit code 1';
      } else {
        s.status = 'rolled_back';
        s.error = null;
        s.autoRolledBack = false;
        s.rolledBackAt = ts();
      }
    }
    if (!stepId)
      for (const c of r.steps.filter((s) => s.kind === 'reachability')) {
        c.status = 'pending';
        c.checks = [];
      }
    settle(r);
    return runOut(r);
  };

  // ---- trust ------------------------------------------------------------------------------------

  const restartRequired = (mode: string) => {
    const s = st.trust.serving;
    if (!s || s.source === 'explicit') return false;
    return (mode === 'none') !== (s.scheme === 'http');
  };

  // ---- relay ------------------------------------------------------------------------------------

  const relayOut = (): RelayConfigView => {
    const r = st.relay;
    const effectiveUrl = r.url.trim() || (r.selfHosted ? '' : RELAY_HOSTED_URL);
    const active = st.relayClients.filter((c) => c.status === 'active').length;
    const pending = st.relayClients.filter((c) => c.status === 'pending').length;
    return copy({ ...r, effectiveUrl, clients: { active, pending } });
  };

  return {
    getNetworkPanel: async () => {
      maybeFail('getNetworkPanel');
      return panel();
    },
    updateNetworkPanel: async (body) => {
      maybeFail('updateNetworkPanel');
      const parsed = updateNetworkSchema.safeParse(body);
      if (!parsed.success) throw zodFail(parsed.error);
      const req = parsed.data;
      const next = new Map<Key, unknown>();
      const transports = { ...st.transports, ...req.transports };
      if (req.transports) {
        if (!Object.values(transports).some(Boolean))
          throw invalid('no_transport', 'keep at least one transport on', { field: 'transports' });
        next.set('transports', transports);
      }
      const url = req.directPublic !== undefined ? req.directPublic.url : st.directPublicUrl;
      if (transports.directPublic && !url)
        throw invalid('url_required', 'set the public URL to advertise Direct public', {
          field: 'directPublic.url',
        });
      if (req.directPublic !== undefined)
        next.set('directPublicUrl', url === null ? null : url.replace(/\/+$/, ''));
      if (req.lan?.mdns !== undefined) next.set('mdns', req.lan.mdns);
      if (req.lan?.mdnsName !== undefined) next.set('mdnsName', req.lan.mdnsName);
      if (req.lan?.includeLoopback !== undefined)
        next.set('includeLoopback', req.lan.includeLoopback);
      if (req.lan?.includeLinkLocal !== undefined)
        next.set('includeLinkLocal', req.lan.includeLinkLocal);
      if (req.healthCheckSeconds !== undefined)
        next.set('healthCheckSeconds', req.healthCheckSeconds);
      if (req.wakeHelpers !== undefined) {
        const known = new Set(st.availableHelpers.map((h) => h.deviceId));
        const unknown = req.wakeHelpers.filter((x) => !known.has(x));
        if (unknown.length)
          throw invalid('unknown_device', 'not a Wake Helper of this account', {
            field: 'wakeHelpers',
            ids: unknown,
          });
        next.set('wakeHelpers', [...new Set(req.wakeHelpers)]);
      }
      const previous: Record<string, unknown> = {};
      for (const [k, v] of next) {
        if (JSON.stringify(read(k)) === JSON.stringify(v)) continue;
        previous[k] = read(k);
        write(k, v);
      }
      const keys = Object.keys(previous);
      if (!keys.length) return { ...panel(), change: null };
      const change = changeView({
        id: id('ch'),
        summary: `Changed ${keys.join(', ')}`,
        createdAt: ts(),
      });
      st.changes = [{ ...change, undo: previous }, ...st.changes];
      return { ...panel(), change: copy(change) };
    },
    testNetwork: async () => {
      maybeFail('testNetwork');
      if (!st.listener)
        throw fail(400, 'capability_missing', 'the Hub has not reported where it listens', {
          reason: 'no_listener',
        });
      st.checkedAt = ts();
      return copy({
        checkedAt: st.checkedAt,
        transports: transportsNow(),
        advertised: advertised(),
        primary: primary(),
      });
    },
    rollbackNetworkChange: async (changeId) => {
      maybeFail('rollbackNetworkChange');
      const target = changeId ? st.changes.find((c) => c.id === changeId) : lastChange();
      if (!target) {
        if (changeId) throw notFound('network change');
        throw conflict('nothing_to_roll_back', 'there is no network change to roll back');
      }
      if (target.status !== 'applied')
        throw conflict('rolled_back', 'this change was already rolled back');
      if (st.rollbackError) {
        target.error = st.rollbackError;
        const message = st.rollbackError;
        st.rollbackError = null;
        throw fail(500, 'server_error', message);
      }
      for (const [k, v] of Object.entries(target.undo ?? {})) {
        if ((KEYS as readonly string[]).includes(k)) write(k as Key, v);
        if (k === 'trustMode') st.trust.mode = v as TrustView['mode'];
      }
      target.status = 'rolled_back';
      target.error = null;
      target.rolledBackAt = ts();
      return { change: strip(target), network: panel() };
    },
    getNetworkDiagnostics: async () => {
      maybeFail('getNetworkDiagnostics');
      const t = st.trust;
      return copy({
        checkedAt: st.checkedAt,
        primary: primary(),
        transports: transportsNow(),
        endpoints: transportsNow().flatMap((x) =>
          x.endpoints.map((c) => ({
            ...c,
            uptime24h: { checks: 24, ok: c.health === 'ok' ? 24 : 20 },
          })),
        ),
        trust: {
          mode: t.mode,
          caFingerprint: t.ca?.fingerprint ?? null,
          leafNotAfter: t.leaf?.notAfter ?? null,
          leafSans: t.leaf?.sans ?? [],
          meshCert: t.meshCert ? { host: t.meshCert.host, notAfter: t.meshCert.notAfter } : null,
          problems: t.problems,
        },
        mesh: st.mesh,
        relay: st.relayStatus,
        devices: st.devices,
        events: st.events,
        changes: st.changes.map(strip),
        problems: st.problems,
      });
    },

    detectNetwork: async () => {
      maybeFail('detectNetwork');
      return { action: 'detect' as const, detection: copy(st.detection) };
    },
    planNetworkSetup: async (provider, options = {}) => {
      maybeFail('planNetworkSetup');
      return { action: 'plan' as const, run: plan(provider, options) };
    },
    applyNetworkSetupStep: async (runId, opts = {}) => {
      maybeFail('applyNetworkSetupStep');
      return apply(runId, opts);
    },
    verifyNetworkSetup: async (runId, stepId) => {
      maybeFail('verifyNetworkSetup');
      const r = run(runId);
      const steps = r.steps
        .filter((s) => (stepId ? s.id === stepId : true))
        .filter((s) => s.status === 'applied' || s.status === 'verified');
      if (stepId && !steps.length)
        throw conflict('not_applied', 'only an applied step can be verified');
      const checks = [
        ...steps.map((s) => ({
          name: s.title,
          ok: st.verifyOk,
          detail: st.verifyOk ? null : 'not running',
        })),
        {
          name: 'mesh reachable',
          ok: st.verifyOk,
          detail: st.verifyOk ? 'https://nova-hub.example.ts.net:8443' : 'timed out',
        },
      ];
      return { action: 'verify' as const, run: runOut(r), ok: checks.every((c) => c.ok), checks };
    },
    listNetworkSetupRuns: async () => {
      maybeFail('listNetworkSetupRuns');
      return { items: st.runs.map(runOut) };
    },
    getNetworkSetupRun: async (rid) => {
      maybeFail('getNetworkSetupRun');
      return runOut(run(rid));
    },
    rollbackNetworkSetup: async (rid, stepId) => {
      maybeFail('rollbackNetworkSetup');
      return rollbackRun(rid, stepId);
    },
    listNetworkSetupConsents: async () => {
      maybeFail('listNetworkSetupConsents');
      return {
        items: st.consents.filter((c) => !c.revoked).map(({ revoked: _r, ...c }) => copy(c)),
      };
    },
    revokeNetworkSetupConsent: async (cid) => {
      maybeFail('revokeNetworkSetupConsent');
      const c = st.consents.find((x) => x.id === cid && !x.revoked);
      if (!c) throw notFound('consent');
      c.revoked = true;
      return { ok: true as const };
    },

    getTrust: async () => {
      maybeFail('getTrust');
      return copy(st.trust);
    },
    updateTrust: async (body) => {
      maybeFail('updateTrust');
      const parsed = trustPatchSchema.safeParse(body);
      if (!parsed.success) throw zodFail(parsed.error);
      const patch = parsed.data;
      for (const k of Object.keys(patch))
        if (st.managedTrust.includes(k))
          throw fail(403, 'policy_denied', `trust.${k} is managed by your organization`, {
            reason: 'managed',
          });
      const before = st.trust.mode;
      if (patch.mode !== undefined) st.trust.mode = patch.mode;
      if (patch.meshCerts !== undefined) st.trust.meshCerts = patch.meshCerts;
      if (patch.pinNativeShells !== undefined) st.trust.pinNativeShells = patch.pinNativeShells;
      if (patch.mode !== undefined && patch.mode !== before)
        st.changes = [
          {
            ...changeView({
              id: id('ch'),
              kind: 'trust.mode',
              summary: `Trust: ${before} → ${patch.mode}`,
              createdAt: ts(),
            }),
            undo: { trustMode: before },
          },
          ...st.changes,
        ];
      st.trust.restartRequired = restartRequired(st.trust.mode);
      return copy(st.trust);
    },
    renewTrust: async (target) => {
      maybeFail('renewTrust');
      const t = st.trust;
      if (t.mode === 'none') throw conflict('trust_off', 'no trust path is chosen');
      const leaf = (target === 'leaf' || target === 'all') && t.mode === 'local-ca';
      const mesh = (target === 'mesh' || target === 'all') && t.meshCert !== null;
      if (!leaf && !mesh)
        throw conflict(
          target === 'leaf' ? 'no_local_ca' : 'no_mesh_cert',
          'nothing to renew in this trust mode',
        );
      if (leaf && t.leaf)
        t.leaf = {
          ...t.leaf,
          serial: id('serial'),
          notBefore: ts(),
          notAfter: '2027-01-15T12:00:00.000Z',
        };
      if (mesh && t.meshCert)
        t.meshCert = { ...t.meshCert, status: 'ok', notAfter: '2027-01-15T12:00:00.000Z' };
      return copy(t);
    },
    trustCaUrl: (format) => `/api/v1/trust/ca.${format}`,

    getRelay: async () => {
      maybeFail('getRelay');
      return relayOut();
    },
    updateRelay: async (body) => {
      maybeFail('updateRelay');
      const parsed = patchRelaySchema.safeParse(body);
      if (!parsed.success) throw zodFail(parsed.error);
      const p = parsed.data;
      for (const k of Object.keys(p))
        if (st.managedRelay.includes(k))
          throw fail(403, 'policy_denied', `relay.${k} is set by managed policy`, {
            reason: 'managed',
          });
      if (p.url !== undefined) st.relay.url = p.url;
      if (p.selfHosted !== undefined) st.relay.selfHosted = p.selfHosted;
      if (p.enabled !== undefined) st.relay.enabled = p.enabled;
      const url = st.relay.url.trim() || (st.relay.selfHosted ? '' : RELAY_HOSTED_URL);
      st.relay.status = {
        ...st.relay.status,
        state: !st.relay.enabled ? 'disabled' : url ? 'connecting' : 'unconfigured',
        url: url || null,
        since: ts(),
      };
      return relayOut();
    },
    testRelay: async () => {
      maybeFail('testRelay');
      return copy(
        st.relayTest ?? {
          ok: st.relay.enabled,
          url: relayOut().effectiveUrl || null,
          reachable: true,
          latencyMs: 42,
          version: '0.1.0',
          state: st.relay.status.state,
          detail: st.relay.enabled ? null : 'the Relay is off',
        },
      );
    },
    listRelayClients: async () => {
      maybeFail('listRelayClients');
      return { items: copy(st.relayClients) };
    },
    revokeRelayClient: async (cid) => {
      maybeFail('revokeRelayClient');
      const c = st.relayClients.find((x) => x.id === cid);
      if (!c) throw notFound('no such paired client');
      if (c.status !== 'revoked') {
        c.status = 'revoked';
        c.revokedAt = ts();
      }
      return { ok: true as const, client: copy(c) };
    },
  };
}

// ---- standalone client and render --------------------------------------------------------------

export type NetworkMocks = NetworkSurfaceApi & Record<keyof NetworkSurfaceApi, Mock>;

let tick = 0;
const nextTs = () => new Date(Date.parse(T0) + ++tick * 1000).toISOString();

/**
 * The network part as its own client. `setting` reads the main fake's settings (host changes);
 * `failNext` makes the next call to a method fail.
 */
export function createNetworkHub(
  init: Partial<M65NetworkState> = {},
  setting: <K extends SettingKey>(key: K) => SettingValue<K> = (k) =>
    resolveSetting(k, { global: {}, managed: {} }).value,
) {
  const state = m65NetworkState(init);
  const failNext: Partial<Record<keyof NetworkSurfaceApi, Error>> = {};
  const impl = m65NetworkImpl(state, {
    id: nid,
    ts: nextTs,
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
  ) as unknown as NetworkMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the Network views need, with the main fake Hub's client and
 * the network part spread over it (what `createApi` will do).
 */
export async function renderWithNetwork(
  ui: ReactNode,
  opts: {
    network?: Partial<M65NetworkState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const network = createNetworkHub(
    opts.network,
    (k) => resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value,
  );
  const api = { ...hub.api, ...network.api };
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
  return { hub, network, api: network.api, state: network.state, ...utils };
}
