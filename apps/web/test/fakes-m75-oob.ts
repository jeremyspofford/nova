// The fake Hub's M7.5 out-of-band part (FR-147; ADR-096 D6), in memory, with the Hub's rules from
// apps/hub/src/oob.ts and packages/core/src/oob/service.ts:
// - every route is the owner's: a member gets 403 `policy_denied` `{reason: owner_only}`;
// - off by default; `enableOob` needs exactly `{confirm: true}` (403 `consent_required`) and a
//   managed lock refuses both ways (403 `managed`); turning it off withdraws waiting cards;
// - creating, editing and acting need it on (403 `oob_disabled`); deleting works while it is off;
// - Intel AMT is refused (400 `capability_missing` `{reason: not_built}`), credentials in the
//   address too (400 `validation` `{reason: credentials_in_address}`); IPMI takes no system id or
//   pin; linking an unknown device is 400 `unknown_device`; credentials are never returned;
// - read actions (check, power status, sensors, BIOS read) run at once and come back `done`, or
//   are recorded `failed` and refused: a BMC failure is 409 `conflict` with its reason, a Redfish
//   BMC presenting another certificate than the pinned one is 403 `tls_pin_mismatch`; IPMI has no
//   BIOS and no USB boot (400 `not_supported_by_ipmi`);
// - a Redfish BMC's first check reads its certificate without credentials and keeps it
//   unconfirmed; every other action is 409 `pin_unconfirmed` until `confirmOobPin` with that same
//   fingerprint (409 `pin_changed` otherwise, `no_pin` before a check); an entered pin counts as
//   confirmed; any edit withdraws the BMC's waiting cards and approved plans (`endpoint_changed`);
// - only the owner's own "Allow once" runs an action (`approval_not_by_user` otherwise);
// - every other action files a Hub-only approval card (`answerIn: 'hub'`, risk high,
//   confirm_at_action, allow once or deny) and comes back `awaiting_approval`; once the card is
//   answered the action runs (or ends `denied`/`expired`) the next time the fake is asked;
// - `bios.plan` needs `devices.firmware.allowChanges` (403 `firmware_disabled`), leaves out what
//   it cannot change (security-degrading values without the override and the setting, unchanged
//   ones), refuses an empty plan (409 `nothing_to_change`), and once approved is `approved` until
//   `bios.apply` uses it (409 `approval_required` before, `plan_used` after).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m75oob: M75OobState`, `createHub`
// defaults it to `m75OobState()`, and `impl` spreads `...m75OobImpl(state.m75oob, { id, ts: () =>
// ts(), maybeFail, approvals: {list, add, update} over state.m3.approvals, setting: (k) =>
// resolveSetting(k, layers()).value, deviceIds: () => state.m6devices.devices.map((d) => d.id) })`.
// Until then tests use `renderWithM75` (test/fakes-m75-devops.ts).
/* eslint-disable @typescript-eslint/require-await */
import { vi, type Mock } from 'vitest';
import type { z } from 'zod';
import {
  OOB_ACTION_BODY_SCHEMAS,
  OOB_READ_ACTIONS,
  confirmOobPinSchema,
  createOobEndpointSchema,
  updateOobEndpointSchema,
  type ApprovalView,
  type OobAction,
  type OobActionStatus,
  type OobActionView,
  type OobBiosKey,
  type OobBiosPlanView,
  type OobBiosReadView,
  type OobBiosSettingView,
  type OobEndpointView,
  type OobPowerState,
  type OobSensorView,
  type OobStatusView,
} from '@nova/shared';
import { ApiError } from '../src/api.ts';
import type { OobApi } from '../src/oob/api-m75.ts';
import type { ApprovalStore } from './fakes-m6-devices.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

export const PIN_A = 'ab'.repeat(32);
export const PIN_B = 'cd'.repeat(32);

// ---- builders ------------------------------------------------------------------------------------

export function oobEndpoint(over: Partial<OobEndpointView> = {}): OobEndpointView {
  const id = over.id ?? `ep${++n}`;
  return {
    id,
    name: 'Rack BMC',
    kind: 'redfish',
    address: '10.0.0.20',
    port: null,
    systemId: null,
    deviceId: null,
    credentialRef: `secret://oob/${id}`,
    hasCredentials: true,
    tlsPin: null,
    tlsPinnedAt: null,
    // A pin given here counts as confirmed (as an entered one does), unless said otherwise.
    tlsPinConfirmed: over.tlsPinConfirmed ?? Boolean(over.tlsPin),
    tlsPinConfirmedAt: over.tlsPinConfirmedAt ?? (over.tlsPin ? T0 : null),
    lastCheckAt: null,
    lastCheckOk: null,
    lastError: null,
    supported: (over.kind ?? 'redfish') !== 'amt',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function oobAction(over: Partial<OobActionView> = {}): OobActionView {
  return {
    id: `oa${++n}`,
    endpointId: 'ep1',
    endpointName: 'Rack BMC',
    action: 'power.status',
    params: {},
    status: 'done',
    approvalId: null,
    planId: null,
    before: null,
    after: null,
    result: { powerState: 'on' },
    error: null,
    createdAt: T0,
    expiresAt: null,
    decidedAt: null,
    finishedAt: T0,
    ...over,
  };
}

export function biosSetting(over: Partial<OobBiosSettingView> = {}): OobBiosSettingView {
  return {
    key: 'wol',
    vendorKey: 'WakeOnLan',
    value: 'Disabled',
    pending: null,
    allowed: ['Enabled', 'Disabled'],
    securityDegrading: [],
    ...over,
  };
}

/** A BMC as the fake answers for it. */
export interface FakeBmc {
  power: OobPowerState;
  /** The SHA-256 of the certificate the BMC presents now (Redfish). */
  presentedPin: string;
  sensors: OobSensorView[];
  bios:
    | { supported: true; vendor: string; settings: OobBiosSettingView[] }
    | { supported: false; vendor: string | null; reason: string };
  /** Every call fails with this reason (409 `conflict`), e.g. `bmc_unreachable`. */
  fail: string | null;
  /** The BMC does not offer PowerCycle (409 `unsupported_by_bmc`). */
  noCycle: boolean;
  /** `bios.apply` fails before its write (the plan stays approved) or after it (it fails). */
  applyFails: 'before' | 'after' | null;
}

export function fakeBmc(over: Partial<FakeBmc> = {}): FakeBmc {
  return {
    power: 'on',
    presentedPin: PIN_A,
    sensors: [
      { name: 'CPU1 Temp', kind: 'temperature', reading: 48, unit: 'Cel', health: 'ok' },
      { name: 'Fan 1', kind: 'fan', reading: 5400, unit: 'RPM', health: 'warning' },
    ],
    bios: {
      supported: true,
      vendor: 'Dell',
      settings: [
        biosSetting(),
        biosSetting({
          key: 'powerOnAfterPowerLoss',
          vendorKey: 'AcPwrRcvry',
          value: 'Off',
          allowed: ['On', 'Off', 'Last'],
        }),
        biosSetting({
          key: 'secureBoot',
          vendorKey: 'SecureBoot',
          value: 'Enabled',
          allowed: ['Enabled', 'Disabled'],
          securityDegrading: ['Disabled'],
        }),
      ],
    },
    fail: null,
    noCycle: false,
    applyFails: null,
    ...over,
  };
}

// ---- state ---------------------------------------------------------------------------------------

export interface M75OobState {
  enabled: boolean;
  /** Managed policy sets `devices.oob.enabled`: enabling and disabling are refused. */
  managed: boolean;
  /** The signed-in person is a member: every route is refused. */
  member: boolean;
  endpoints: OobEndpointView[];
  /** Credentials by endpoint id: write-only, never in a view. */
  credentials: Record<string, { username: string; password: string }>;
  /** Newest first. */
  actions: OobActionView[];
  bmc: Record<string, FakeBmc>;
}

export function m75OobState(init: Partial<M75OobState> = {}): M75OobState {
  const state: M75OobState = {
    enabled: false,
    managed: false,
    member: false,
    endpoints: [],
    credentials: {},
    actions: [],
    bmc: {},
    ...init,
  };
  for (const ep of state.endpoints) {
    state.bmc[ep.id] ??= fakeBmc();
    if (ep.hasCredentials) state.credentials[ep.id] ??= { username: 'root', password: 'calvin' };
  }
  return state;
}

export interface OobApprovals extends ApprovalStore {
  update: (a: ApprovalView) => void;
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

const ACTION_WORDS: Record<OobAction, string> = {
  check: 'Check',
  'power.status': 'Read the power state of',
  'power.on': 'Power on',
  'power.off': 'Power off (hard)',
  'power.cycle': 'Power cycle',
  'power.reset': 'Reset (hard restart)',
  sensors: 'Read the sensors of',
  'bios.read': 'Read the BIOS settings of',
  'bios.plan': 'Change BIOS settings of',
  'bios.apply': 'Apply BIOS settings to',
  'boot.next': 'Set the next boot of',
};

const TTL_MS = 10 * 60_000;

/** The Hub's address rules (packages/core/src/oob/address.ts), in short. */
function parseAddress(address: string, kind: string): { host: string; port: number | null } {
  const s = address.trim();
  const bad = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
    err(400, 'validation', message, { reason, ...extra });
  if (s.includes('@'))
    throw bad(
      'credentials_in_address',
      'credentials go in the credentials field, never in the address',
    );
  if (/\s/.test(s))
    throw bad('bad_address', 'the address cannot contain spaces or control characters');
  if (s.includes('://')) {
    if (kind !== 'redfish' || !s.startsWith('https://'))
      throw bad('bad_address', 'only a Redfish BMC may be given as a URL, and only https://');
    const url = new URL(s);
    return { host: url.hostname, port: url.port ? Number(url.port) : null };
  }
  if (s.includes('/')) throw bad('bad_address', 'give a host name or IP address only');
  const host = s.toLowerCase();
  const last = host.split('.').pop() ?? '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)))
    throw bad(
      'bad_address',
      `${s} is a numeric host form; give the IPv4 address in dotted decimal`,
    );
  const refused =
    host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '::1'
      ? 'loopback'
      : host.startsWith('169.254.')
        ? 'link_local'
        : host === HUB_ADDRESS
          ? 'hub'
          : null;
  if (refused) throw bad('address_not_allowed', `${s} is not a BMC address`, { kind: refused });
  return { host, port: null };
}

/** The fake Hub's own address (refused as a BMC address). */
export const HUB_ADDRESS = '10.0.0.2';

export function m75OobImpl(
  st: M75OobState,
  deps: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof OobApi) => void;
    approvals: OobApprovals;
    setting: (key: string) => unknown;
    /** Device ids a BMC may be linked to. */
    deviceIds: () => string[];
  },
): OobApi {
  const { id, ts, maybeFail, approvals } = deps;
  const copy = <T>(v: T): T => structuredClone(v);

  const owner = () => {
    if (st.member)
      throw err(
        403,
        'policy_denied',
        'only the owner of this Hub can change out-of-band management',
        {
          reason: 'owner_only',
        },
      );
  };
  const on = () => {
    if (!st.enabled)
      throw err(403, 'oob_disabled', 'Out-of-band management is off', { reason: 'oob_disabled' });
  };
  const endpoint = (eid: string) => {
    const ep = st.endpoints.find((e) => e.id === eid);
    if (!ep) throw err(404, 'not_found', 'no such out-of-band endpoint');
    return ep;
  };
  const putEndpoint = (ep: OobEndpointView) => {
    st.endpoints = st.endpoints.map((e) => (e.id === ep.id ? ep : e));
    return ep;
  };
  const putAction = (a: OobActionView) => {
    st.actions = st.actions.some((x) => x.id === a.id)
      ? st.actions.map((x) => (x.id === a.id ? a : x))
      : [a, ...st.actions];
    return a;
  };
  const amt = () =>
    err(400, 'capability_missing', 'Intel AMT is not built', { reason: 'not_built' });
  const notIpmi = (what: string) =>
    err(400, 'capability_missing', `${what} is not available over IPMI; use Redfish`, {
      reason: 'not_supported_by_ipmi',
    });
  const firmwareOn = () => {
    if (deps.setting('devices.firmware.allowChanges') !== true)
      throw err(403, 'firmware_disabled', 'BIOS/firmware changes are off', {
        reason: 'firmware_changes_off',
      });
  };
  const status = (): OobStatusView => ({
    enabled: st.enabled,
    kinds: {
      redfish: { built: true },
      ipmi: { built: true },
      amt: { built: false, reason: 'not_built' },
    },
    readActions: [...OOB_READ_ACTIONS],
    endpoints: st.endpoints.length,
  });

  /**
   * Talk to the BMC: its failure, then (Redfish) the pin, read unconfirmed on first use, then the
   * credentials, which a Redfish BMC gets only once its pin is confirmed (`check` may go without).
   */
  const connect = (ep: OobEndpointView, unauthenticated = false): FakeBmc => {
    const bmc = (st.bmc[ep.id] ??= fakeBmc());
    if (bmc.fail) throw err(409, 'conflict', `the BMC failed: ${bmc.fail}`, { reason: bmc.fail });
    if (ep.kind === 'redfish') {
      if (!ep.tlsPin)
        ep = putEndpoint({
          ...ep,
          tlsPin: bmc.presentedPin,
          tlsPinnedAt: ts(),
          tlsPinConfirmed: false,
          tlsPinConfirmedAt: null,
        });
      else if (ep.tlsPin !== bmc.presentedPin)
        throw err(
          403,
          'policy_denied',
          'The BMC presented a different TLS certificate than the one pinned.',
          { reason: 'tls_pin_mismatch', expected: ep.tlsPin, presented: bmc.presentedPin },
        );
      if (!ep.tlsPinConfirmed) {
        if (unauthenticated) return bmc;
        throw unconfirmed(ep);
      }
    }
    if (!st.credentials[ep.id])
      throw err(409, 'conflict', 'the endpoint has no credentials; enter them again', {
        reason: 'credentials_missing',
      });
    return bmc;
  };
  const unconfirmed = (ep: OobEndpointView) =>
    err(
      409,
      'conflict',
      ep.tlsPin
        ? 'confirm the BMC certificate fingerprint first: no credentials are sent before that'
        : 'check the BMC first, then confirm its certificate fingerprint',
      { reason: 'pin_unconfirmed', tlsPin: ep.tlsPin },
    );

  const biosView = (bmc: FakeBmc): OobBiosReadView =>
    bmc.bios.supported
      ? {
          supported: true,
          reason: null,
          vendor: bmc.bios.vendor,
          settings: copy(bmc.bios.settings),
        }
      : { supported: false, reason: bmc.bios.reason, vendor: bmc.bios.vendor, settings: [] };

  /** What the BMC does for an action. */
  const perform = (
    epId: string,
    action: OobAction,
    params: Record<string, unknown>,
  ): { before?: unknown; after?: unknown; result: unknown } => {
    const ep = endpoint(epId);
    const bmc = connect(ep, action === 'check');
    const pinned = endpoint(epId);
    switch (action) {
      case 'check': {
        if (ep.kind === 'ipmi') return { result: { protocol: 'ipmi', powerState: bmc.power } };
        const confirmed = pinned.tlsPinConfirmed;
        return {
          result: {
            protocol: 'redfish',
            vendor: 'Dell',
            product: 'iDRAC',
            redfishVersion: '1.11.0',
            tlsPin: pinned.tlsPin,
            pinConfirmed: confirmed,
            authenticated: confirmed,
            systems: confirmed ? ['System.Embedded.1'] : null,
          },
        };
      }
      case 'power.status':
        return { result: { powerState: bmc.power } };
      case 'power.on':
      case 'power.off':
      case 'power.cycle':
      case 'power.reset': {
        if (action === 'power.cycle' && bmc.noCycle)
          throw err(409, 'conflict', 'this BMC does not offer PowerCycle', {
            reason: 'unsupported_by_bmc',
          });
        const before = { powerState: bmc.power };
        bmc.power = action === 'power.off' ? 'off' : 'on';
        const after = { powerState: bmc.power };
        return { before, after, result: { before, after } };
      }
      case 'sensors':
        return { result: { sensors: copy(bmc.sensors) } };
      case 'bios.read':
        return { result: biosView(bmc) };
      case 'boot.next':
        return {
          before: { enabled: 'Disabled', target: 'None', mode: 'UEFI' },
          after: { enabled: 'Once', target: params.target, mode: 'UEFI' },
          result: { target: params.target, oneTime: true },
        };
      default:
        throw err(400, 'validation', `${action} is not a Redfish action here`);
    }
  };

  /** Run a recorded action now and record its outcome; failures are recorded, then thrown. */
  const runAction = (a: OobActionView): OobActionView => {
    const at = ts();
    try {
      const out = perform(a.endpointId!, a.action, a.params);
      const done = putAction({
        ...a,
        status: 'done',
        before: out.before ?? a.before,
        after: out.after ?? null,
        result: out.result,
        finishedAt: at,
      });
      if (a.action === 'check') {
        const ep = endpoint(a.endpointId!);
        putEndpoint({ ...ep, lastCheckAt: at, lastCheckOk: true, lastError: null });
      }
      return done;
    } catch (e) {
      const ae = e instanceof ApiError ? e : err(500, 'server_error', String(e));
      const reason = typeof ae.body.details?.reason === 'string' ? ae.body.details.reason : null;
      putAction({
        ...a,
        status: 'failed',
        error: { code: ae.body.code, reason, message: ae.body.message },
        finishedAt: at,
      });
      const ep = st.endpoints.find((x) => x.id === a.endpointId);
      if (ep)
        putEndpoint({
          ...ep,
          lastError: ae.body.message,
          ...(a.action === 'check' ? { lastCheckAt: at, lastCheckOk: false } : {}),
        });
      throw ae;
    }
  };

  const fileCard = (
    ep: OobEndpointView,
    action: OobAction,
    params: Record<string, unknown>,
    plan: OobBiosPlanView | null,
    before: unknown = null,
  ): OobActionView => {
    const now = ts();
    const expiresAt = new Date(Date.parse(now) + TTL_MS).toISOString();
    const approvalId = id('ap');
    let summary = `${ACTION_WORDS[action]} ${ep.name} (${ep.address}) through its BMC`;
    if (plan) {
      summary += `: ${plan.diff.map((d) => `${d.key} ${d.from ?? '(unset)'} -> ${d.to}`).join(', ')}; applied at the next reboot`;
      if (plan.diff.some((d) => d.securityDegrading)) summary = `Weakens security: ${summary}`;
    }
    approvals.add({
      id: approvalId,
      threadId: null,
      turnId: null,
      callId: null,
      action: summary,
      tool: `oob.${action}`,
      argsPreview: JSON.stringify({
        endpoint: ep.name,
        address: ep.address,
        kind: ep.kind,
        action,
        params,
        ...(plan ? { diff: plan.diff } : {}),
      }),
      reason:
        'Out-of-band action asked by the owner. It acts on the hardware even when its operating system is down.',
      tier: 'confirm_at_action',
      risk: 'high',
      userAsked: true,
      ruleId: null,
      options: ['allow_once', 'deny_continue'],
      alwaysScopes: [],
      status: 'pending',
      decision: null,
      decidedBy: null,
      createdAt: now,
      expiresAt,
      decidedAt: null,
      answerIn: 'hub',
    });
    return putAction(
      oobAction({
        id: plan?.planId ?? id('oa'),
        endpointId: ep.id,
        endpointName: ep.name,
        action,
        params,
        status: 'awaiting_approval',
        approvalId,
        before,
        result: plan,
        createdAt: now,
        expiresAt,
        finishedAt: null,
      }),
    );
  };

  /** Answered cards: run (or end) their action, as the Hub does on `approval.decided`. */
  const sync = () => {
    for (const a of st.actions) {
      if (a.status !== 'awaiting_approval' || !a.approvalId) continue;
      const card = approvals.list().find((x) => x.id === a.approvalId);
      if (!card || card.status === 'pending') continue;
      const decided = ts();
      const byUser = card.decidedBy === 'user';
      const allowed = card.status === 'decided' && card.decision === 'allow_once' && byUser;
      if (!allowed) {
        const expired = card.status === 'expired' || card.decision === 'timeout';
        const notMine = card.decision === 'allow_once' && !byUser;
        putAction({
          ...a,
          status: expired ? 'expired' : 'denied',
          decidedAt: decided,
          finishedAt: decided,
          error: {
            code: 'policy_denied',
            reason: expired
              ? 'approval_expired'
              : notMine
                ? 'approval_not_by_user'
                : 'approval_denied',
            message: expired ? 'the approval expired' : 'the owner denied the action',
          },
        });
        continue;
      }
      if (a.action === 'bios.plan') {
        putAction({
          ...a,
          status: 'approved',
          decidedAt: decided,
          expiresAt: new Date(Date.parse(decided) + TTL_MS).toISOString(),
        });
        continue;
      }
      const running = putAction({ ...a, status: 'running', decidedAt: decided });
      try {
        runAction(running);
      } catch {
        // Recorded as failed.
      }
    }
  };

  /** Withdraw waiting cards (turned off, or the endpoint went). */
  const withdraw = (rows: OobActionView[], reason: string, message: string) => {
    for (const a of rows) {
      putAction({
        ...a,
        status: 'expired',
        error: { code: 'conflict', reason, message },
        finishedAt: ts(),
      });
      const card = approvals.list().find((x) => x.id === a.approvalId);
      if (card && card.status === 'pending') approvals.update({ ...card, status: 'cancelled' });
    }
  };

  const plan = (ep: OobEndpointView, params: Record<string, unknown>): OobActionView => {
    firmwareOn();
    const changes = params.changes as { key: OobBiosKey; value: string }[];
    const wants = params.allowSecurityDegrading === true;
    const allowDegrading =
      wants && deps.setting('devices.firmware.allowSecurityDegrading') === true;
    const row = () =>
      putAction(
        oobAction({
          id: id('oa'),
          endpointId: ep.id,
          endpointName: ep.name,
          action: 'bios.plan',
          params,
          status: 'running',
          result: null,
          createdAt: ts(),
          finishedAt: null,
        }),
      );
    let bmc: FakeBmc;
    try {
      bmc = connect(ep);
      if (!bmc.bios.supported)
        throw err(409, 'conflict', bmc.bios.reason, { reason: 'unsupported_hardware' });
    } catch (e) {
      try {
        runAction(row());
      } catch {
        // recorded
      }
      throw e;
    }
    const settings = bmc.bios.settings;
    const diff: OobBiosPlanView['diff'] = [];
    const refused: OobBiosPlanView['refused'] = [];
    for (const c of changes) {
      const s = settings.find((x) => x.key === c.key);
      if (!s) refused.push({ key: c.key, reason: 'unsupported' });
      else if (!s.allowed.length) refused.push({ key: c.key, reason: 'read_only' });
      else if (!s.allowed.includes(c.value))
        refused.push({ key: c.key, reason: 'not_allowed_value' });
      else if (s.value === c.value) refused.push({ key: c.key, reason: 'unchanged' });
      else if (s.securityDegrading.includes(c.value) && !allowDegrading)
        refused.push({ key: c.key, reason: 'security_degrading' });
      else
        diff.push({
          key: c.key,
          vendorKey: s.vendorKey,
          from: s.value,
          to: c.value,
          securityDegrading: s.securityDegrading.includes(c.value),
        });
    }
    if (!diff.length) {
      const failed = row();
      putAction({
        ...failed,
        status: 'failed',
        error: { code: 'conflict', reason: 'nothing_to_change', message: 'nothing to change' },
        finishedAt: ts(),
      });
      throw err(409, 'conflict', 'nothing to change', { reason: 'nothing_to_change', refused });
    }
    const values = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    const planView: OobBiosPlanView = {
      planId: id('oa'),
      vendor: bmc.bios.vendor,
      snapshot: { takenAt: ts(), values, sha256: 'e'.repeat(64) },
      diff,
      refused,
      requiresReboot: true,
      allowSecurityDegrading: diff.some((d) => d.securityDegrading),
    };
    return fileCard(ep, 'bios.plan', params, planView, values);
  };

  const apply = (ep: OobEndpointView, params: Record<string, unknown>): OobActionView => {
    const p = st.actions.find(
      (a) => a.id === params.planId && a.endpointId === ep.id && a.action === 'bios.plan',
    );
    if (!p) throw err(404, 'not_found', 'no such BIOS plan for this endpoint');
    if (p.status === 'applied')
      throw err(409, 'conflict', 'this plan was applied already', { reason: 'plan_used' });
    if (p.status === 'failed' || p.status === 'expired')
      throw err(
        409,
        'conflict',
        'this plan can no longer be applied; read the BIOS and plan again',
        {
          reason: `plan_${p.status}`,
          cause: p.error?.reason ?? null,
        },
      );
    if (p.status !== 'approved')
      throw err(409, 'approval_required', 'the BIOS plan needs your approval first', {
        approvalId: p.approvalId,
        status: p.status,
      });
    firmwareOn();
    const planView = p.result as OobBiosPlanView;
    if (
      planView.diff.some((d) => d.securityDegrading) &&
      deps.setting('devices.firmware.allowSecurityDegrading') !== true
    )
      throw err(403, 'policy_denied', 'security-degrading BIOS changes are not allowed', {
        reason: 'security_degrading',
      });
    const bmc = connect(ep);
    if (bmc.applyFails) {
      const failure = err(409, 'conflict', 'the BMC failed: bmc_error', { reason: 'bmc_error' });
      if (bmc.applyFails === 'after')
        putAction({
          ...p,
          status: 'failed',
          error: {
            code: 'conflict',
            reason: 'apply_outcome_unknown',
            message: 'the BMC may have taken part of the change; read the BIOS and plan again',
          },
          finishedAt: ts(),
        });
      putAction(
        oobAction({
          id: id('oa'),
          endpointId: ep.id,
          endpointName: ep.name,
          action: 'bios.apply',
          params,
          status: 'failed',
          planId: p.id,
          result: null,
          error: { code: 'conflict', reason: 'bmc_error', message: 'the BMC failed: bmc_error' },
          createdAt: ts(),
          finishedAt: ts(),
        }),
      );
      throw failure;
    }
    putAction({ ...p, status: 'applied', finishedAt: ts() });
    if (bmc.bios.supported)
      bmc.bios.settings = bmc.bios.settings.map((s) => {
        const d = planView.diff.find((x) => x.key === s.key);
        return d ? { ...s, pending: d.to } : s;
      });
    const pending = Object.fromEntries(planView.diff.map((d) => [d.key, d.to]));
    return putAction(
      oobAction({
        id: id('oa'),
        endpointId: ep.id,
        endpointName: ep.name,
        action: 'bios.apply',
        params,
        status: 'done',
        planId: p.id,
        before: planView.snapshot.values,
        after: pending,
        result: {
          applied: planView.diff.map((d) => ({ key: d.key, from: d.from, to: d.to })),
          pending,
          pendingReboot: true,
        },
        createdAt: ts(),
        finishedAt: ts(),
      }),
    );
  };

  return {
    getOobStatus: async () => {
      maybeFail('getOobStatus');
      owner();
      sync();
      return status();
    },
    enableOob: async (consent) => {
      maybeFail('enableOob');
      owner();
      if ((consent as unknown as { confirm?: unknown } | null)?.confirm !== true)
        throw err(403, 'policy_denied', 'Out-of-band management needs your consent', {
          reason: 'consent_required',
        });
      if (st.managed)
        throw err(403, 'policy_denied', 'devices.oob.enabled is set by managed policy', {
          reason: 'managed',
        });
      st.enabled = true;
      return status();
    },
    disableOob: async () => {
      maybeFail('disableOob');
      owner();
      if (st.managed)
        throw err(403, 'policy_denied', 'devices.oob.enabled is set by managed policy', {
          reason: 'managed',
        });
      st.enabled = false;
      withdraw(
        st.actions.filter((a) => a.status === 'awaiting_approval' || a.status === 'approved'),
        'oob_disabled',
        'out-of-band management was turned off',
      );
      return status();
    },
    listOobEndpoints: async () => {
      maybeFail('listOobEndpoints');
      owner();
      return { items: copy(st.endpoints) };
    },
    createOobEndpoint: async (body) => {
      maybeFail('createOobEndpoint');
      owner();
      on();
      const b = parse(createOobEndpointSchema, body);
      if (b.kind === 'amt') throw amt();
      const addr = parseAddress(b.address, b.kind);
      if (b.port !== undefined && addr.port !== null && b.port !== addr.port)
        throw err(400, 'validation', 'the address and the port name different ports');
      if (b.kind === 'ipmi' && b.systemId)
        throw err(400, 'validation', 'systemId is for Redfish endpoints only');
      if (b.kind === 'ipmi' && b.tlsPin)
        throw err(400, 'validation', 'IPMI has no TLS certificate to pin');
      if (b.deviceId && !deps.deviceIds().includes(b.deviceId))
        throw err(400, 'validation', 'no such device to link', { reason: 'unknown_device' });
      const at = ts();
      const ep = oobEndpoint({
        id: id('ep'),
        name: b.name,
        kind: b.kind,
        address: addr.host,
        port: b.port ?? addr.port,
        systemId: b.systemId ?? null,
        deviceId: b.deviceId ?? null,
        hasCredentials: true,
        tlsPin: b.tlsPin ?? null,
        tlsPinnedAt: b.tlsPin ? at : null,
        tlsPinConfirmed: Boolean(b.tlsPin),
        tlsPinConfirmedAt: b.tlsPin ? at : null,
        createdAt: at,
        updatedAt: at,
      });
      st.credentials[ep.id] = b.credentials;
      st.bmc[ep.id] ??= fakeBmc();
      st.endpoints = [...st.endpoints, ep];
      return copy(ep);
    },
    getOobEndpoint: async (eid) => {
      maybeFail('getOobEndpoint');
      owner();
      return copy(endpoint(eid));
    },
    updateOobEndpoint: async (eid, body) => {
      maybeFail('updateOobEndpoint');
      owner();
      on();
      const b = parse(updateOobEndpointSchema, body);
      const before = endpoint(eid);
      if (before.kind === 'amt') throw amt();
      let host = before.address;
      let port = b.port === undefined ? before.port : b.port;
      if (b.address !== undefined) {
        const addr = parseAddress(b.address, before.kind);
        host = addr.host;
        if (addr.port !== null) port = addr.port;
      }
      if (before.kind === 'ipmi' && (b.systemId || b.tlsPin))
        throw err(400, 'validation', 'systemId and tlsPin are for Redfish endpoints only');
      if (b.deviceId && !deps.deviceIds().includes(b.deviceId))
        throw err(400, 'validation', 'no such device to link', { reason: 'unknown_device' });
      const moved = host !== before.address || port !== before.port;
      const at = ts();
      let pin = before.tlsPin;
      let pinnedAt = before.tlsPinnedAt;
      let confirmedAt = before.tlsPinConfirmedAt;
      if (b.tlsPin !== undefined) {
        pin = b.tlsPin;
        pinnedAt = b.tlsPin ? at : null;
        confirmedAt = b.tlsPin ? at : null;
      } else if (moved) {
        pin = null;
        pinnedAt = null;
        confirmedAt = null;
      }
      if (b.credentials) st.credentials[eid] = b.credentials;
      // An approval names the BMC as it was: an edit withdraws its open cards and plans.
      withdraw(
        st.actions.filter(
          (a) =>
            a.endpointId === eid && (a.status === 'awaiting_approval' || a.status === 'approved'),
        ),
        'endpoint_changed',
        'the endpoint was changed after the approval was asked',
      );
      return copy(
        putEndpoint({
          ...before,
          name: b.name ?? before.name,
          address: host,
          port,
          systemId: b.systemId === undefined ? before.systemId : b.systemId,
          deviceId: b.deviceId === undefined ? before.deviceId : b.deviceId,
          hasCredentials: Boolean(st.credentials[eid]),
          tlsPin: pin,
          tlsPinnedAt: pinnedAt,
          tlsPinConfirmed: pin !== null && confirmedAt !== null,
          tlsPinConfirmedAt: pin !== null ? confirmedAt : null,
          ...(moved ? { lastCheckAt: null, lastCheckOk: null, lastError: null } : {}),
          updatedAt: at,
        }),
      );
    },
    confirmOobPin: async (eid, tlsPin) => {
      maybeFail('confirmOobPin');
      owner();
      on();
      const { tlsPin: pin } = parse(confirmOobPinSchema, { tlsPin });
      const ep = endpoint(eid);
      if (ep.kind !== 'redfish')
        throw err(400, 'validation', 'only a Redfish BMC has a certificate to confirm');
      if (!ep.tlsPin)
        throw err(409, 'conflict', 'no fingerprint yet: run check first', { reason: 'no_pin' });
      if (ep.tlsPin !== pin)
        throw err(409, 'conflict', 'the BMC certificate is not the one you confirmed', {
          reason: 'pin_changed',
          tlsPin: ep.tlsPin,
        });
      if (ep.tlsPinConfirmed) return copy(ep);
      return copy(putEndpoint({ ...ep, tlsPinConfirmed: true, tlsPinConfirmedAt: ts() }));
    },
    deleteOobEndpoint: async (eid) => {
      maybeFail('deleteOobEndpoint');
      owner();
      endpoint(eid);
      withdraw(
        st.actions.filter(
          (a) =>
            a.endpointId === eid && (a.status === 'awaiting_approval' || a.status === 'approved'),
        ),
        'endpoint_deleted',
        'the endpoint was deleted',
      );
      st.endpoints = st.endpoints.filter((e) => e.id !== eid);
      delete st.credentials[eid];
      return { ok: true as const };
    },
    oobAction: async (eid, action, body) => {
      maybeFail('oobAction');
      owner();
      sync();
      const ep = endpoint(eid);
      on();
      if (ep.kind === 'amt') throw amt();
      const params = parse(OOB_ACTION_BODY_SCHEMAS[action], body ?? {});
      if (ep.kind === 'ipmi' && action.startsWith('bios.')) throw notIpmi('BIOS settings');
      if (ep.kind === 'ipmi' && action === 'boot.next' && params.target === 'usb')
        throw notIpmi('A one-time USB boot');
      if (ep.kind === 'redfish' && action !== 'check' && !(ep.tlsPin && ep.tlsPinConfirmed))
        throw unconfirmed(ep);
      if ((OOB_READ_ACTIONS as readonly string[]).includes(action)) {
        const row = putAction(
          oobAction({
            id: id('oa'),
            endpointId: ep.id,
            endpointName: ep.name,
            action,
            params,
            status: 'running' as OobActionStatus,
            result: null,
            createdAt: ts(),
            finishedAt: null,
          }),
        );
        return { action: copy(runAction(row)) };
      }
      if (action === 'bios.apply') return { action: copy(apply(ep, params)) };
      if (action === 'bios.plan') return { action: copy(plan(ep, params)) };
      return { action: copy(fileCard(ep, action, params, null)) };
    },
    listOobActions: async (q = {}) => {
      maybeFail('listOobActions');
      owner();
      sync();
      return {
        items: copy(
          st.actions
            .filter((a) => !q.endpointId || a.endpointId === q.endpointId)
            .slice(0, q.limit ?? 50),
        ),
      };
    },
    getOobAction: async (aid) => {
      maybeFail('getOobAction');
      owner();
      sync();
      const a = st.actions.find((x) => x.id === aid);
      if (!a) throw err(404, 'not_found', 'no such out-of-band action');
      return copy(a);
    },
  };
}

export type OobMocks = OobApi & Record<keyof OobApi, Mock<(...args: never[]) => unknown>>;

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createOobHub(
  init: Partial<M75OobState>,
  deps: {
    approvals: OobApprovals;
    setting: (key: string) => unknown;
    deviceIds: () => string[];
  },
) {
  const state = m75OobState(init);
  const failNext: Partial<Record<keyof OobApi, Error>> = {};
  const impl = m75OobImpl(state, {
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
  ) as unknown as OobMocks;
  return { api, state, failNext };
}
