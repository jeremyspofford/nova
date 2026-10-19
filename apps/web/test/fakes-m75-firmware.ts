// The fake Hub's M7.5 firmware and boot parts (FR-146, FR-143), in memory, with the Hub's rules
// from apps/hub/src/firmware.ts + packages/core/src/firmware/service.ts and apps/hub/src/boot.ts +
// packages/core/src/boot/service.ts and pxe.ts:
// - every route is the owner's (403 `policy_denied` `{reason: owner_only}` for a member);
// - firmware: the toggles live in the Hub settings (`PUT …/firmware/policy`; turning one on needs
//   `confirm: true`, else 403 `consent_required`); plan, request-approval, apply and rollback are
//   refused while `devices.firmware.allowChanges` is off (403 `firmware_disabled`); an unsupported
//   machine answers 409 `conflict` `{reason: unsupported_hardware, detail}`; an offline device 503
//   `node_unavailable`; a security-degrading change needs the override at approval and at apply
//   (403 `security_degrading`); apply needs the owner's own "Allow once" (409
//   `approval_required`, 409 `approval_expired`, 403 `approval_denied`) and the stored BIOS
//   password when the machine has one (409 `bios_password_required`); a rollback is its own
//   change with its own approval and never restarts (400 `reboot_not_offered`); approval cards are
//   Hub-only (`answerIn: 'hub'`) and the change follows its card's decision, as the Hub does on
//   `approval.decided`;
// - boot: try and commit are refused with low-level boot off (403 `low_level_boot_off`), kernel
//   arguments in a profile 400 `capability_missing` `{reason: kernel_args_not_supported}`, a
//   second trial 409 `attempt_pending`, a second request 409 `request_pending`, a commit of an
//   unconfirmed trial 409 `not_confirmed`; an approved request is sent once (and fails with the
//   device's error when told to); revert always works and is sent at once; the PXE token is shown
//   once.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m75firmware: M75FirmwareState`,
// `createHub` defaults it to `m75FirmwareState()`, and `impl` spreads
// `...m75FirmwareImpl(state.m75firmware, { setting, writeSetting, approvals, deviceName })`.
// Until then tests use `renderWithFirmware`, which spreads it over the devices fakes.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { z } from 'zod';
import {
  FIRMWARE_SUPPORT_MATRIX,
  createBootProfileSchema,
  firmwarePolicySchema,
  firmwareSupportFor,
  planFirmwareSchema,
  resolveSetting,
  tryBootProfileSchema,
  updateBootProfileSchema,
  type ApprovalView,
  type BootAttemptView,
  type BootImageView,
  type BootProfileView,
  type BootRequestView,
  type DeviceBootStatusView,
  type FirmwareChangeStatus,
  type FirmwareChangeView,
  type FirmwareDiffEntry,
  type FirmwareMethod,
  type FirmwarePlatform,
  type FirmwareRefusalView,
  type FirmwareSettingView,
  type FirmwareSnapshotView,
  type FirmwareUpdateView,
  type FirmwareValue,
  type PxeTokenView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { BootApi } from '../src/boot/api-m75.ts';
import type { FirmwareApi, FirmwareRead } from '../src/firmware/api-m75.ts';
import { weakensSecurity } from '../src/firmware/format.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider, type SettingsClient } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { createAddDeviceHub } from './fakes-m65-devices.ts';
import { createDevicesHub, type M6DevicesState } from './fakes-m6-devices.ts';
import { MEMBER_ID, m7TeamState } from './fakes-m7-team.ts';

// ---- state ---------------------------------------------------------------------------------------

export interface FakeFirmwareDevice {
  supported: boolean;
  reason: string | null;
  platform: FirmwarePlatform | null;
  method: FirmwareMethod | null;
  adminPasswordSet: boolean;
  settings: FirmwareSettingView[];
  updates: FirmwareUpdateView[];
  /** The device does not answer (503 `node_unavailable`). */
  offline?: boolean;
  /** The device refuses the next apply with this error. */
  failApply?: { status: number; code: string; reason: string; restored?: boolean };
}

export interface FakeBootDevice {
  /** The device's answer to `boot/status`; null with `offline`. */
  status: DeviceBootStatusView | null;
  offline?: boolean;
  profiles: BootProfileView[];
  attempts: BootAttemptView[];
  requests: BootRequestView[];
  pxe: PxeTokenView;
  /** The device refuses the next request sent to it with this error. */
  failSend?: { code: string; reason: string | null; message: string };
}

interface SnapshotRow extends FirmwareSnapshotView {
  values: Record<string, FirmwareValue | null>;
}

export interface M75FirmwareState {
  firmware: Record<string, FakeFirmwareDevice>;
  boot: Record<string, FakeBootDevice>;
  changes: FirmwareChangeView[];
  snapshots: SnapshotRow[];
  /** Devices whose BIOS admin password the vault holds. */
  passwords: string[];
  images: BootImageView[];
  imagesFolder: string;
  /** Every call answers 403 `owner_only` (a member signed in). */
  member: boolean;
  /** The last PXE token made (what the page showed once). */
  lastToken: string | null;
}

/** Dell-shaped settings: every canonical key; Secure Boot and TPM degrade when off. */
export function dellSettings(): FirmwareSettingView[] {
  return [
    {
      key: 'wol',
      vendorKey: 'WakeOnLan',
      value: 'Disabled',
      type: 'enum',
      allowed: ['Disabled', 'LanOnly', 'LanWlan'],
      readOnly: false,
      securityDegrading: [],
    },
    {
      key: 'powerOnAfterPowerLoss',
      vendorKey: 'AcPwrRcvry',
      value: 'Off',
      type: 'enum',
      allowed: ['Off', 'On', 'Last'],
      readOnly: false,
      securityDegrading: [],
    },
    {
      key: 'bootOrder',
      vendorKey: 'BootOrder',
      value: ['ubuntu', 'Windows Boot Manager', 'UEFI HTTP'],
      type: 'order',
      allowed: null,
      readOnly: false,
      securityDegrading: [],
    },
    {
      key: 'virtualization',
      vendorKey: 'Virtualization',
      value: 'Enabled',
      type: 'enum',
      allowed: ['Disabled', 'Enabled'],
      readOnly: false,
      securityDegrading: [],
    },
    {
      key: 'secureBoot',
      vendorKey: 'SecureBoot',
      value: 'Enabled',
      type: 'enum',
      allowed: ['Disabled', 'Enabled'],
      readOnly: false,
      securityDegrading: ['Disabled'],
    },
    {
      key: 'tpm',
      vendorKey: 'TpmSecurity',
      value: 'Enabled',
      type: 'enum',
      allowed: ['Disabled', 'Enabled'],
      readOnly: false,
      securityDegrading: ['Disabled'],
    },
    {
      key: 'fanProfile',
      vendorKey: 'ThermalManagement',
      value: 'Optimized',
      type: 'enum',
      allowed: ['Optimized', 'Cool', 'Quiet'],
      readOnly: true,
      securityDegrading: [],
    },
  ];
}

export function firmwareDevice(over: Partial<FakeFirmwareDevice> = {}): FakeFirmwareDevice {
  return {
    supported: true,
    reason: null,
    platform: {
      vendor: 'Dell Inc.',
      product: 'OptiPlex 7090',
      biosVendor: 'Dell Inc.',
      biosVersion: '1.21.0',
      biosDate: '2025-04-11',
      uefi: true,
    },
    method: 'firmware-attributes',
    adminPasswordSet: false,
    settings: dellSettings(),
    updates: [{ device: 'System Firmware', version: '1.22.0', summary: 'Security fixes' }],
    ...over,
  };
}

export function bootDevice(over: Partial<FakeBootDevice> = {}): FakeBootDevice {
  return {
    status: {
      supported: true,
      reason: null,
      bootloader: 'systemd-boot',
      entries: [
        { id: 'ubuntu.conf', title: 'Ubuntu 24.04', isDefault: true },
        { id: 'nova-test.conf', title: 'Nova test image', isDefault: false },
      ],
      booted: 'ubuntu.conf',
      pending: null,
      last: null,
    },
    profiles: [],
    attempts: [],
    requests: [],
    pxe: { deviceId: '', active: false, createdAt: null, lastUsedAt: null },
    ...over,
  };
}

export function m75FirmwareState(init: Partial<M75FirmwareState> = {}): M75FirmwareState {
  return {
    firmware: {},
    boot: {},
    changes: [],
    snapshots: [],
    passwords: [],
    images: [],
    imagesFolder: '/var/lib/nova/boot-images',
    member: false,
    lastToken: null,
    ...init,
  };
}

// ---- the implementation --------------------------------------------------------------------------

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

/** Switches `PATCH /api/v1/settings` turns on only with `confirm: true` (apps/hub/src/app.ts). */
export const CONSENT_SETTING_KEYS: readonly string[] = [
  'devices.firmware.allowChanges',
  'devices.firmware.allowSecurityDegrading',
  'devices.boot.allowLowLevel',
  'devices.pxe.enabled',
];

/**
 * The Hub's refusal of a settings write that turns a consent switch on without `confirm: true`
 * (403 `policy_denied` `{reason: consent_required}`), or null. For the fake's `setSetting`.
 */
export function consentRefusal(
  key: string,
  value: unknown,
  opts: { confirm?: boolean } = {},
): ApiError | null {
  if (!CONSENT_SETTING_KEYS.includes(key) || value !== true || opts.confirm === true) return null;
  return err(403, 'policy_denied', 'turning this on needs an explicit confirmation', {
    reason: 'consent_required',
  });
}

export interface M75FirmwareHelpers {
  setting: (key: string) => unknown;
  writeSetting: (key: string, value: unknown) => void;
  approvals: {
    list: () => ApprovalView[];
    add: (a: ApprovalView) => void;
  };
  deviceName: (id: string) => string;
  /** The device's management address (`https:` once it holds a certificate). */
  endpoint?: (id: string) => string | null;
}

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DONE: readonly FirmwareChangeStatus[] = ['applied', 'rolled_back', 'reverted'];

function short(v: FirmwareValue | null): string {
  if (v === null) return 'unset';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

const same = (a: FirmwareValue | null, b: FirmwareValue | null) =>
  JSON.stringify(a) === JSON.stringify(b);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

export function m75FirmwareImpl(st: M75FirmwareState, h: M75FirmwareHelpers) {
  const owner = () => {
    if (st.member)
      throw err(403, 'policy_denied', "only the Hub's owner can manage the Hub's device firmware", {
        reason: 'owner_only',
      });
  };
  const on = (k: string) => h.setting(k) === true;
  const policy = () => ({
    allowChanges: on('devices.firmware.allowChanges'),
    allowSecurityDegrading: on('devices.firmware.allowSecurityDegrading'),
  });
  const requireAllowed = () => {
    if (!on('devices.firmware.allowChanges'))
      throw err(403, 'firmware_disabled', 'BIOS/firmware changes are off', {
        reason: 'firmware_disabled',
        setting: 'devices.firmware.allowChanges',
      });
  };
  const fwDevice = (id: string) => {
    const d = st.firmware[id];
    if (!d) throw err(404, 'not_found', 'device not found');
    return d;
  };
  const reachable = (d: { offline?: boolean }) => {
    if (d.offline)
      throw err(503, 'node_unavailable', 'the device is not reachable', { reason: 'unreachable' });
  };
  const supportOf = (d: FakeFirmwareDevice) => {
    const m = firmwareSupportFor(d.platform, 'linux');
    if (!d.supported) return { supported: false, reason: d.reason ?? m.reason, entry: m.entry };
    if (!m.supported) return { supported: false, reason: m.reason, entry: m.entry };
    return { supported: true, reason: null, entry: m.entry };
  };
  const supported = (d: FakeFirmwareDevice) => {
    const s = supportOf(d);
    if (!s.supported)
      throw err(409, 'conflict', `firmware settings cannot be changed on this machine`, {
        reason: 'unsupported_hardware',
        detail: s.reason ?? 'unsupported',
      });
  };
  const degrading = (diff: FirmwareDiffEntry[]) => {
    if (diff.some((e) => e.securityDegrading) && !on('devices.firmware.allowSecurityDegrading'))
      throw err(
        403,
        'policy_denied',
        'this change weakens security (Secure Boot, TPM) and the separate override is off',
        {
          reason: 'security_degrading',
          keys: diff.filter((e) => e.securityDegrading).map((e) => e.key),
          setting: 'devices.firmware.allowSecurityDegrading',
        },
      );
  };
  const approvalOf = (c: FirmwareChangeView) =>
    c.approval ? h.approvals.list().find((a) => a.id === c.approval!.id) : undefined;
  /** Follow the card's decision, as the Hub does on `approval.decided`. */
  const sync = (c: FirmwareChangeView): FirmwareChangeView => {
    const a = approvalOf(c);
    if (!a || !c.approval) return c;
    c.approval = {
      id: a.id,
      status: a.status,
      decision: a.decision,
      decidedAt: a.decidedAt,
      expiresAt: a.expiresAt,
    };
    if (c.status === 'awaiting_approval' && a.status === 'decided')
      c.status = a.decision === 'allow_once' && a.decidedBy === 'user' ? 'approved' : 'planned';
    return c;
  };
  const change = (deviceId: string, changeId: string) => {
    const c = st.changes.find((x) => x.id === changeId && x.deviceId === deviceId);
    if (!c) throw err(404, 'not_found', 'firmware change not found');
    return sync(c);
  };
  const copy = (c: FirmwareChangeView): FirmwareChangeView => structuredClone(c);

  const openApproval = (c: FirmwareChangeView, deviceId: string): FirmwareChangeView => {
    const now = Date.now();
    const name = h.deviceName(deviceId);
    const verb = c.kind === 'rollback' ? 'Restore' : 'Change';
    const list = c.diff
      .map(
        (e) =>
          `${e.key} ${short(e.from)} -> ${short(e.to)}${e.securityDegrading ? ' (weakens security)' : ''}`,
      )
      .join('; ');
    const a: ApprovalView = {
      id: nextId('appr'),
      threadId: null,
      turnId: null,
      callId: null,
      action: `${verb} BIOS/firmware settings on ${name}: ${list}${c.requiresReboot ? ' (takes effect after a reboot)' : ''}`,
      tool: c.kind === 'rollback' ? 'device.firmware.rollback' : 'device.firmware.apply',
      argsPreview: JSON.stringify({ device: name, deviceId, change: c.id, diff: c.diff }),
      reason: 'Requested by the owner',
      tier: 'confirm_at_action',
      risk: 'high',
      userAsked: true,
      ruleId: null,
      options: ['allow_once', 'deny_continue'],
      alwaysScopes: [],
      status: 'pending',
      decision: null,
      decidedBy: null,
      createdAt: iso(now),
      expiresAt: iso(now + 24 * 3600_000),
      decidedAt: null,
      runId: null,
      codeSessionId: null,
      threadTitle: null,
      answerIn: 'hub',
      scope: `device:${deviceId}`,
    };
    h.approvals.add(a);
    c.status = 'awaiting_approval';
    c.approval = {
      id: a.id,
      status: 'pending',
      decision: null,
      decidedAt: null,
      expiresAt: a.expiresAt,
    };
    c.error = null;
    c.updatedAt = iso(now);
    return copy(c);
  };

  const readView = (id: string): FirmwareRead => {
    const d = fwDevice(id);
    reachable(d);
    const s = supportOf(d);
    return {
      deviceId: id,
      supported: s.supported,
      reason: s.reason,
      platform: d.platform,
      method: d.method,
      adminPasswordSet: d.adminPasswordSet,
      settings: structuredClone(d.settings),
      updates: structuredClone(d.updates),
      support: s.entry,
      policy: policy(),
      readAt: iso(),
      cached: false,
      adminPasswordStored: st.passwords.includes(id),
    };
  };

  const firmware: FirmwareApi = {
    getFirmwarePolicy: async () => {
      owner();
      return policy();
    },
    setFirmwarePolicy: async (body) => {
      owner();
      const req = parse(firmwarePolicySchema, body);
      const before = policy();
      const turningOn =
        (req.allowChanges === true && !before.allowChanges) ||
        (req.allowSecurityDegrading === true && !before.allowSecurityDegrading);
      if (turningOn && req.confirm !== true)
        throw err(403, 'policy_denied', 'turning this on needs an explicit confirmation', {
          reason: 'consent_required',
        });
      if (req.allowChanges !== undefined)
        h.writeSetting('devices.firmware.allowChanges', req.allowChanges);
      if (req.allowSecurityDegrading !== undefined)
        h.writeSetting('devices.firmware.allowSecurityDegrading', req.allowSecurityDegrading);
      return policy();
    },
    getFirmwareSupport: async () => {
      owner();
      return { items: [...FIRMWARE_SUPPORT_MATRIX] };
    },
    readFirmware: async (id) => {
      owner();
      return readView(id);
    },
    planFirmware: async (id, changes) => {
      owner();
      requireAllowed();
      const body = parse(planFirmwareSchema, { changes });
      const d = fwDevice(id);
      reachable(d);
      supported(d);
      const diff: FirmwareDiffEntry[] = [];
      const refused: FirmwareRefusalView[] = [];
      for (const ch of body.changes) {
        const s = d.settings.find((x) => x.key === ch.key);
        if (!s) refused.push({ key: ch.key, reason: 'unknown_key' });
        else if (s.readOnly) refused.push({ key: ch.key, reason: 'read_only' });
        else if (s.type === 'enum' && s.allowed && !s.allowed.includes(String(ch.value)))
          refused.push({ key: ch.key, reason: 'not_allowed_value' });
        else if (!same(s.value, ch.value))
          diff.push({
            key: s.key,
            vendorKey: s.vendorKey,
            from: s.value,
            to: ch.value,
            securityDegrading: weakensSecurity(s.key, ch.value, s.securityDegrading),
          });
      }
      const now = iso();
      const snap: SnapshotRow = {
        id: nextId('snap'),
        deviceId: id,
        deviceSnapshotId: nextId('dsnap'),
        takenAt: now,
        keys: d.settings.map((s) => s.key).sort(),
        sha256: 'a'.repeat(64),
        createdAt: now,
        values: Object.fromEntries(d.settings.map((s) => [s.key, structuredClone(s.value)])),
      };
      st.snapshots = [snap, ...st.snapshots];
      const c: FirmwareChangeView = {
        id: nextId('fwc'),
        deviceId: id,
        kind: 'apply',
        status: 'planned',
        method: d.method ?? 'unknown',
        planId: nextId('plan'),
        snapshotId: snap.id,
        rollbackOf: null,
        diff,
        refused,
        from: Object.fromEntries(diff.map((e) => [e.key, e.from])),
        to: Object.fromEntries(diff.map((e) => [e.key, e.to])),
        securityDegrading: diff.some((e) => e.securityDegrading),
        requiresReboot: diff.length > 0,
        reboot: null,
        approval: null,
        watchdog: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        appliedAt: null,
      };
      st.changes = [c, ...st.changes];
      return copy(c);
    },
    getFirmwareChange: async (id, changeId) => {
      owner();
      fwDevice(id);
      return copy(change(id, changeId));
    },
    requestFirmwareApproval: async (id, changeId) => {
      owner();
      requireAllowed();
      const c = change(id, changeId);
      if (DONE.includes(c.status))
        throw err(409, 'conflict', 'this change was already applied', {
          reason: 'already_applied',
          status: c.status,
        });
      if (c.status === 'failed')
        throw err(409, 'conflict', 'this change failed; plan it again', { reason: 'failed' });
      if (c.status === 'approved') return copy(c);
      if (c.status === 'awaiting_approval' && c.approval?.status === 'pending') return copy(c);
      if (!c.diff.length)
        throw err(409, 'conflict', 'this plan changes nothing', { reason: 'nothing_to_apply' });
      degrading(c.diff);
      return openApproval(c, id);
    },
    applyFirmwareChange: async (id, changeId, opts = {}) => {
      owner();
      requireAllowed();
      const c = change(id, changeId);
      if (DONE.includes(c.status))
        throw err(409, 'conflict', 'this change was already applied', {
          reason: 'already_applied',
          status: c.status,
        });
      if (c.status === 'failed')
        throw err(409, 'conflict', 'this change failed; plan it again', { reason: 'failed' });
      if (c.kind === 'rollback' && opts.reboot === true)
        throw err(400, 'validation', 'a rollback does not reboot; reboot the device yourself', {
          reason: 'reboot_not_offered',
        });
      const a = approvalOf(c);
      if (!a)
        throw err(409, 'approval_required', 'this change needs the owner’s approval first', {
          reason: 'approval_required',
          approvalId: null,
        });
      if (a.status === 'pending')
        throw err(409, 'approval_required', 'the approval for this change is still pending', {
          reason: 'approval_required',
          approvalId: a.id,
        });
      if (a.status === 'expired' || a.status === 'cancelled')
        throw err(409, 'conflict', 'the approval for this change expired; ask again', {
          reason: 'approval_expired',
          approvalId: a.id,
        });
      if (a.decision !== 'allow_once' || a.decidedBy !== 'user')
        throw err(403, 'policy_denied', 'the approval for this change was denied', {
          reason: 'approval_denied',
          approvalId: a.id,
        });
      degrading(c.diff);
      const d = fwDevice(id);
      reachable(d);
      supported(d);
      if (d.adminPasswordSet) {
        // novad never keeps the password, so its watchdog cannot restore: no guarded restart.
        if (c.kind === 'apply' && opts.reboot === true)
          throw err(
            403,
            'policy_denied',
            'the watchdog cannot restore a machine with a BIOS admin password, so no reboot',
            { reason: 'watchdog_unavailable', detail: 'admin_password_set' },
          );
        if (!(h.endpoint?.(id) ?? '').startsWith('https:'))
          throw err(403, 'policy_denied', 'the BIOS admin password is only sent over mutual TLS', {
            reason: 'tls_required',
          });
        if (!st.passwords.includes(id))
          throw err(409, 'conflict', 'this machine needs its BIOS admin password', {
            reason: 'bios_password_required',
          });
      }
      if (d.failApply) {
        const f = d.failApply;
        delete d.failApply;
        const final = f.reason === 'base_mismatch' || f.reason === 'apply_failed';
        if (final) c.status = 'failed';
        c.error = `${f.code}:${f.reason}`;
        throw err(f.status, f.code, 'the device refused the change', {
          reason: f.reason,
          ...(f.restored !== undefined ? { restored: f.restored } : {}),
        });
      }
      const now = Date.now();
      for (const e of c.diff) {
        const s = d.settings.find((x) => x.key === e.key);
        if (s) s.value = structuredClone(e.to);
      }
      c.status = 'applied';
      c.appliedAt = iso(now);
      c.updatedAt = iso(now);
      c.error = null;
      if (c.kind === 'apply') {
        c.reboot = opts.reboot === true;
        // The Hub sends `devices.firmware.watchdogSeconds` with a restart; novad arms it.
        const seconds = Number(h.setting('devices.firmware.watchdogSeconds') ?? 600);
        c.watchdog = c.reboot ? { state: 'pending', deadline: iso(now + seconds * 1000) } : null;
      } else if (c.rollbackOf) {
        const original = st.changes.find((x) => x.id === c.rollbackOf);
        if (original && (original.status === 'applied' || original.status === 'revert_failed')) {
          original.status = 'rolled_back';
          if (original.watchdog?.state === 'pending') original.watchdog = null;
        }
      }
      // The approval is used once.
      return copy(c);
    },
    rollbackFirmwareSnapshot: async (id, snapshotId) => {
      owner();
      requireAllowed();
      const snap = st.snapshots.find((s) => s.id === snapshotId && s.deviceId === id);
      if (!snap) throw err(404, 'not_found', 'snapshot not found');
      const original = st.changes.find((c) => c.snapshotId === snap.id && c.kind === 'apply');
      if (!original || (original.status !== 'applied' && original.status !== 'revert_failed'))
        throw err(409, 'conflict', 'nothing to roll back to this snapshot', {
          reason: original?.status === 'rolled_back' ? 'rolled_back' : 'nothing_to_roll_back',
        });
      const open = st.changes
        .map(sync)
        .find(
          (c) =>
            c.rollbackOf === original.id &&
            (c.status === 'approved' ||
              (c.status === 'awaiting_approval' && c.approval?.status === 'pending')),
        );
      if (open) return copy(open);
      const d = fwDevice(id);
      reachable(d);
      supported(d);
      const diff: FirmwareDiffEntry[] = [];
      for (const [key, to] of Object.entries(snap.values)) {
        const s = d.settings.find((x) => x.key === key);
        const from = s?.value ?? null;
        if (same(from, to)) continue;
        diff.push({
          key,
          vendorKey: s?.vendorKey ?? key,
          from,
          to,
          securityDegrading: weakensSecurity(key, to, s?.securityDegrading),
        });
      }
      if (!diff.length)
        throw err(409, 'conflict', 'the device already holds the snapshot values', {
          reason: 'nothing_to_roll_back',
        });
      degrading(diff);
      const now = iso();
      const c: FirmwareChangeView = {
        id: nextId('fwc'),
        deviceId: id,
        kind: 'rollback',
        status: 'planned',
        method: original.method,
        planId: null,
        snapshotId: snap.id,
        rollbackOf: original.id,
        diff,
        refused: [],
        from: Object.fromEntries(diff.map((e) => [e.key, e.from])),
        to: Object.fromEntries(diff.map((e) => [e.key, e.to])),
        securityDegrading: diff.some((e) => e.securityDegrading),
        requiresReboot: original.requiresReboot,
        reboot: null,
        approval: null,
        watchdog: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        appliedAt: null,
      };
      st.changes = [c, ...st.changes];
      return openApproval(c, id);
    },
    getFirmwareHistory: async (id) => {
      owner();
      fwDevice(id);
      return {
        changes: st.changes.filter((c) => c.deviceId === id).map((c) => copy(sync(c))),
        snapshots: st.snapshots
          .filter((s) => s.deviceId === id)
          .map(({ values: _values, ...s }) => ({ ...s })),
      };
    },
    setBiosPassword: async (id, password) => {
      owner();
      fwDevice(id);
      if (!password) throw err(400, 'validation', 'a password is required');
      if (!st.passwords.includes(id)) st.passwords = [...st.passwords, id];
      return { stored: true };
    },
    clearBiosPassword: async (id) => {
      owner();
      fwDevice(id);
      st.passwords = st.passwords.filter((x) => x !== id);
      return { stored: false };
    },
  };

  // ---- boot ----------------------------------------------------------------------------------

  const bootOf = (id: string) => {
    const b = st.boot[id];
    if (!b) throw err(404, 'not_found', 'device not found');
    return b;
  };
  const lowLevelOff = () =>
    err(403, 'policy_denied', 'low-level boot changes are turned off on this Hub', {
      reason: 'low_level_boot_off',
    });
  const noKernelArgs = (body: unknown) => {
    if (typeof body !== 'object' || body === null) return;
    if ('kernelArgs' in body || 'cmdline' in body || 'kernelArguments' in body)
      throw err(400, 'capability_missing', 'kernel arguments in boot profiles are not supported', {
        reason: 'kernel_args_not_supported',
      });
  };
  const checkEntry = (b: FakeBootDevice, entryId: string, mode: 'optional' | 'required') => {
    if (b.offline) {
      if (mode === 'optional') return;
      throw err(503, 'node_unavailable', 'the device is not reachable', { reason: 'unreachable' });
    }
    const s = b.status;
    if (!s?.supported)
      throw err(409, 'conflict', "this device's boot cannot be managed", {
        reason: 'unsupported_hardware',
        detail: s?.reason ?? null,
      });
    if (!s.entries.some((e) => e.id === entryId))
      throw err(400, 'validation', 'the device has no boot entry with that id', {
        reason: 'unknown_entry',
        entries: s.entries.map((e) => e.id),
      });
  };
  const nameFree = (b: FakeBootDevice, name: string, except: string | null) => {
    if (b.profiles.some((p) => p.name === name && p.id !== except))
      throw err(409, 'conflict', 'a boot profile of this device already has that name', {
        reason: 'name_taken',
      });
  };
  const titleOf = (b: FakeBootDevice, entryId: string | null) =>
    b.status?.entries.find((e) => e.id === entryId)?.title ?? entryId ?? '';

  const createRequest = (
    deviceId: string,
    b: FakeBootDevice,
    r: {
      kind: BootRequestView['kind'];
      profileId: string | null;
      attemptId: string | null;
      entryId: string | null;
      body: Record<string, unknown>;
      action: string;
      auto?: boolean;
    },
  ): BootRequestView => {
    const now = Date.now();
    const approvalId = nextId('appr');
    const a: ApprovalView = {
      id: approvalId,
      threadId: null,
      turnId: null,
      callId: null,
      action: r.action,
      tool: `device.boot.${r.kind}`,
      argsPreview: JSON.stringify({ device: h.deviceName(deviceId), ...r.body }),
      reason: 'Asked by the owner',
      tier: 'confirm_at_action',
      risk: 'high',
      userAsked: true,
      ruleId: null,
      options: ['allow_once', 'deny_continue'],
      alwaysScopes: [],
      status: r.auto ? 'decided' : 'pending',
      decision: r.auto ? 'allow_once' : null,
      decidedBy: r.auto ? 'user' : null,
      createdAt: iso(now),
      expiresAt: iso(now + 30 * 60_000),
      decidedAt: r.auto ? iso(now) : null,
      runId: null,
      codeSessionId: null,
      threadTitle: null,
      answerIn: 'hub',
      scope: `device:${deviceId}`,
    };
    h.approvals.add(a);
    const req: BootRequestView & { body?: Record<string, unknown> } = {
      id: nextId('breq'),
      deviceId,
      kind: r.kind,
      status: 'awaiting_approval',
      profileId: r.profileId,
      attemptId: r.attemptId,
      entryId: r.entryId,
      approvalId,
      changeId: nextId('chg'),
      error: null,
      createdAt: iso(now),
      expiresAt: a.expiresAt,
      decidedAt: null,
      sentAt: null,
      body: r.body,
    };
    b.requests = [req, ...b.requests];
    return req;
  };

  /** Send an approved request to the device, once (what the Hub does on approval). */
  const send = (b: FakeBootDevice, req: BootRequestView & { body?: Record<string, unknown> }) => {
    const now = Date.now();
    req.decidedAt = iso(now);
    const fail = (code: string, reason: string | null, message: string) => {
      req.status = 'failed';
      req.error = { code, reason, message };
    };
    if (b.failSend) {
      const f = b.failSend;
      delete b.failSend;
      fail(f.code, f.reason, f.message);
      return;
    }
    if (b.offline) {
      fail('node_unavailable', 'unreachable', 'the device is not reachable');
      return;
    }
    if (req.kind !== 'revert' && !on('devices.boot.allowLowLevel')) {
      fail('policy_denied', 'low_level_boot_off', 'low-level boot changes are turned off');
      return;
    }
    req.status = 'sent';
    req.sentAt = iso(now);
    if (req.kind === 'try') {
      const seconds = Number(req.body?.watchdogSeconds ?? 600);
      const deadline = iso(now + seconds * 1000);
      const attempt: BootAttemptView = {
        id: nextId('batt'),
        deviceId: req.deviceId,
        profileId: req.profileId!,
        requestId: req.id,
        entryId: req.entryId!,
        status: 'pending',
        reboot: req.body?.reboot !== false,
        watchdogSeconds: seconds,
        deadline,
        reason: null,
        detail: null,
        verified: null,
        committedAt: null,
        createdAt: iso(now),
        finishedAt: null,
      };
      b.attempts = [attempt, ...b.attempts];
      req.attemptId = attempt.id;
      if (b.status)
        b.status.pending = { profileId: attempt.profileId, entryId: attempt.entryId, deadline };
    } else if (req.kind === 'commit') {
      const a = b.attempts.find((x) => x.id === req.attemptId);
      if (a) a.committedAt = iso(now);
      if (b.status)
        b.status.entries = b.status.entries.map((e) => ({ ...e, isDefault: e.id === req.entryId }));
    } else {
      const pending = b.attempts.find((x) => x.status === 'pending');
      if (pending) {
        pending.status = 'reverted';
        pending.reason = 'revert';
        pending.finishedAt = iso(now);
        req.attemptId ??= pending.id;
      }
      if (b.status) b.status.pending = null;
    }
  };

  /** Requests whose card was answered: sent once when allowed, denied otherwise. */
  const syncBoot = (b: FakeBootDevice) => {
    for (const req of b.requests) {
      if (req.status !== 'awaiting_approval' || req.decidedAt) continue;
      const a = h.approvals.list().find((x) => x.id === req.approvalId);
      if (!a || a.status === 'pending') continue;
      if (a.status === 'decided' && a.decidedBy === 'user' && a.decision === 'allow_once')
        send(b, req);
      else {
        req.status = a.status === 'expired' ? 'expired' : 'denied';
        req.decidedAt = iso();
      }
    }
  };
  const view = (r: BootRequestView & { body?: unknown }): BootRequestView => {
    const { body: _body, ...rest } = r;
    return structuredClone(rest);
  };

  const boot: BootApi = {
    getDeviceBoot: async (id) => {
      owner();
      const b = bootOf(id);
      syncBoot(b);
      return {
        deviceId: id,
        lowLevelBoot: on('devices.boot.allowLowLevel'),
        pxeEnabled: on('devices.pxe.enabled'),
        watchdogSeconds: Number(h.setting('devices.boot.watchdogSeconds') ?? 600),
        status: b.offline ? null : structuredClone(b.status),
        statusError: b.offline
          ? {
              code: 'node_unavailable',
              reason: 'unreachable',
              message: 'the device is not reachable',
            }
          : null,
        profiles: [...b.profiles].sort((x, y) => x.name.localeCompare(y.name)),
        attempts: structuredClone(b.attempts),
        requests: b.requests.map(view),
        pxe: { ...b.pxe, deviceId: id },
      };
    },
    listBootProfiles: async (id) => {
      owner();
      return { items: structuredClone(bootOf(id).profiles) };
    },
    createBootProfile: async (id, body) => {
      owner();
      noKernelArgs(body);
      const input = parse(createBootProfileSchema, body);
      const b = bootOf(id);
      nameFree(b, input.name, null);
      checkEntry(b, input.entryId, 'optional');
      const now = iso();
      const p: BootProfileView = {
        id: nextId('bprof'),
        deviceId: id,
        name: input.name,
        entryId: input.entryId,
        createdAt: now,
        updatedAt: now,
      };
      b.profiles = [...b.profiles, p];
      return { ...p };
    },
    updateBootProfile: async (id, pid, body) => {
      owner();
      noKernelArgs(body);
      const input = parse(updateBootProfileSchema, body);
      const b = bootOf(id);
      const p = b.profiles.find((x) => x.id === pid);
      if (!p) throw err(404, 'not_found', 'boot profile not found');
      if (input.name !== undefined) nameFree(b, input.name, p.id);
      if (input.entryId !== undefined && input.entryId !== p.entryId)
        checkEntry(b, input.entryId, 'optional');
      Object.assign(p, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
        updatedAt: iso(),
      });
      return { ...p };
    },
    deleteBootProfile: async (id, pid) => {
      owner();
      const b = bootOf(id);
      if (!b.profiles.some((p) => p.id === pid))
        throw err(404, 'not_found', 'boot profile not found');
      b.profiles = b.profiles.filter((p) => p.id !== pid);
      return { ok: true };
    },
    tryBootProfile: async (id, pid, body = {}) => {
      owner();
      const input = parse(tryBootProfileSchema, body);
      const b = bootOf(id);
      if (!on('devices.boot.allowLowLevel')) throw lowLevelOff();
      const p = b.profiles.find((x) => x.id === pid);
      if (!p) throw err(404, 'not_found', 'boot profile not found');
      const pending = b.attempts.find((a) => a.status === 'pending');
      if (pending)
        throw err(409, 'conflict', 'a boot trial is already pending on this device', {
          reason: 'attempt_pending',
          attemptId: pending.id,
        });
      syncBoot(b);
      const open = b.requests.find((r) => r.status === 'awaiting_approval');
      if (open)
        throw err(409, 'conflict', 'a boot change for this device is waiting for approval', {
          reason: 'request_pending',
          requestId: open.id,
        });
      checkEntry(b, p.entryId, 'required');
      const seconds =
        input.watchdogSeconds ?? Number(h.setting('devices.boot.watchdogSeconds') ?? 600);
      const name = h.deviceName(id);
      return view(
        createRequest(id, b, {
          kind: 'try',
          profileId: p.id,
          attemptId: null,
          entryId: p.entryId,
          body: {
            profileId: p.id,
            entryId: p.entryId,
            watchdogSeconds: seconds,
            reboot: input.reboot,
          },
          action: `${input.reboot ? 'Restart' : 'Next restart'}: boot ${name} once into "${titleOf(b, p.entryId)}" (profile ${p.name}); it returns to its default entry if it is not back within ${Math.round(seconds / 60)} min`,
        }),
      );
    },
    getBootAttempt: async (id, aid) => {
      owner();
      const a = bootOf(id).attempts.find((x) => x.id === aid);
      if (!a) throw err(404, 'not_found', 'boot attempt not found');
      return { ...a };
    },
    commitBootAttempt: async (id, aid, opts = {}) => {
      owner();
      const b = bootOf(id);
      if (!on('devices.boot.allowLowLevel')) throw lowLevelOff();
      const a = b.attempts.find((x) => x.id === aid);
      if (!a) throw err(404, 'not_found', 'boot attempt not found');
      if (a.status !== 'ok')
        throw err(409, 'conflict', 'only a trial the device confirmed can become the default', {
          reason: 'not_confirmed',
          status: a.status,
        });
      if (a.committedAt)
        throw err(409, 'conflict', 'this trial is already the default', {
          reason: 'already_default',
        });
      if (a.verified === false && opts.confirmUnverified !== true)
        throw err(409, 'conflict', 'the device could not verify that this trial booted', {
          reason: 'unverified_trial',
        });
      syncBoot(b);
      const open = b.requests.find((r) => r.status === 'awaiting_approval');
      if (open)
        throw err(409, 'conflict', 'a boot change for this device is waiting for approval', {
          reason: 'request_pending',
          requestId: open.id,
        });
      checkEntry(b, a.entryId, 'required');
      return view(
        createRequest(id, b, {
          kind: 'commit',
          profileId: a.profileId,
          attemptId: a.id,
          entryId: a.entryId,
          body: { profileId: a.profileId, entryId: a.entryId },
          action: `Make "${titleOf(b, a.entryId)}" the default boot entry of ${h.deviceName(id)}`,
        }),
      );
    },
    revertBoot: async (id) => {
      owner();
      const b = bootOf(id);
      const pending = b.attempts.find((a) => a.status === 'pending');
      const req = createRequest(id, b, {
        kind: 'revert',
        profileId: pending?.profileId ?? null,
        attemptId: pending?.id ?? null,
        entryId: pending?.entryId ?? null,
        body: {},
        action: `Clear the pending one-shot boot of ${h.deviceName(id)}; it boots its default entry`,
        auto: true,
      });
      send(b, req);
      if (req.status === 'failed' && req.error)
        throw err(
          req.error.code === 'node_unavailable' ? 503 : 500,
          req.error.code,
          req.error.message,
          { reason: req.error.reason, requestId: req.id },
        );
      return view(req);
    },
    getBootRequest: async (id, rid) => {
      owner();
      const b = bootOf(id);
      syncBoot(b);
      const r = b.requests.find((x) => x.id === rid);
      if (!r) throw err(404, 'not_found', 'boot request not found');
      return view(r);
    },
    listBootImages: async () => {
      owner();
      return {
        enabled: on('devices.pxe.enabled'),
        folder: st.imagesFolder,
        items: structuredClone(st.images),
      };
    },
    createPxeToken: async (id) => {
      owner();
      const b = bootOf(id);
      const token = `nvb_${'x'.repeat(39)}${(++seq).toString().padStart(4, '0')}`;
      st.lastToken = token;
      b.pxe = { deviceId: id, active: true, createdAt: iso(), lastUsedAt: null };
      return { ...b.pxe, token, scriptUrl: `http://hub.test/boot/ipxe/${token}` };
    },
    revokePxeToken: async (id) => {
      owner();
      const b = bootOf(id);
      b.pxe = { deviceId: id, active: false, createdAt: null, lastUsedAt: null };
      return { ...b.pxe };
    },
  };

  return { ...firmware, ...boot };
}

export type M75FirmwareApi = FirmwareApi & BootApi;
export type M75FirmwareMocks = {
  [K in keyof M75FirmwareApi]: Mock<M75FirmwareApi[K]>;
} & M75FirmwareApi;

// ---- what tests make happen on the device ----------------------------------------------------------

/** The device's firmware watchdog reported (or the Hub's sweep gave up): as the Hub records it. */
export function firmwareWatchdog(
  st: M75FirmwareState,
  changeId: string,
  state: 'ok' | 'reverted' | 'revert_failed' | 'missed',
  /** novad's reason for a revert: `deadline` or `not_restarted`. */
  reason: 'deadline' | 'not_restarted' | null = null,
): void {
  const c = st.changes.find((x) => x.id === changeId);
  if (!c) throw new Error(`no change ${changeId}`);
  c.watchdog = { state, deadline: c.watchdog?.deadline ?? null, reason };
  if (state === 'revert_failed') {
    // The device could not restore: the change stays, and can be rolled back from the Hub.
    c.status = 'revert_failed';
    c.error = 'watchdog:admin_password_required';
  }
  if (state === 'reverted') {
    c.status = 'reverted';
    c.error = `watchdog:${reason ?? 'reverted'}`;
    const d = st.firmware[c.deviceId];
    for (const e of c.diff) {
      const s = d?.settings.find((x) => x.key === e.key);
      if (s) s.value = structuredClone(e.from);
    }
  }
}

/** The device reported on its boot trial (or the Hub's watchdog failed it). */
export function bootWatchdog(
  st: M75FirmwareState,
  deviceId: string,
  status: 'ok' | 'reverted' | 'failed',
  reason: string | null = null,
  /** For `ok`: whether the device saw the entry booted (GRUB cannot tell: false). */
  verified = true,
  /** novad's reason for a revert (`deadline`, `not_booted`, `not_restarted`), kept as detail. */
  detail: string | null = null,
): void {
  const b = st.boot[deviceId];
  const a = b?.attempts.find((x) => x.status === 'pending');
  if (!b || !a) throw new Error(`no pending trial on ${deviceId}`);
  a.status = status;
  if (status === 'ok') a.verified = verified;
  a.reason = status === 'ok' ? null : (reason ?? 'reverted_by_device');
  if (detail !== null) a.detail = detail;
  a.finishedAt = iso();
  if (b.status) {
    b.status.pending = null;
    b.status.last = { profileId: a.profileId, entryId: a.entryId, result: status, at: iso() };
    if (status === 'ok') b.status.booted = a.entryId;
  }
}

// ---- rendering -------------------------------------------------------------------------------------

/**
 * Render `ui` with the main fake Hub's client, the devices fakes and this one spread over it (what
 * `createApi` will do once it spreads `firmwareApi` and `bootApi`). `member` signs in as a member
 * of the Hub: the team role says so and every firmware and boot call answers `owner_only`.
 */
export async function renderWithFirmware(
  ui: ReactNode,
  opts: {
    devices?: Partial<M6DevicesState>;
    firmware?: Partial<M75FirmwareState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    member?: boolean;
  } = {},
) {
  const hub = createHub(opts.member ? { m7team: m7TeamState({ me: MEMBER_ID }) } : {});
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
  const added = createAddDeviceHub({}, devices.state);
  const state = m75FirmwareState({ member: opts.member ?? false, ...opts.firmware });
  const impl = m75FirmwareImpl(state, {
    setting: (k) =>
      resolveSetting(k as never, { global: hub.state.settings, managed: hub.state.managed }).value,
    writeSetting: (k, v) => {
      hub.state.settings = { ...hub.state.settings, [k]: v };
    },
    approvals: {
      list: () => hub.state.m3.approvals,
      add: (a) => {
        hub.state.m3.approvals = [...hub.state.m3.approvals, a];
      },
    },
    deviceName: (id) => devices.state.devices.find((d) => d.id === id)?.name ?? 'a device',
    endpoint: (id) => devices.state.devices.find((d) => d.id === id)?.endpoint ?? null,
  });
  const fw = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as M75FirmwareMocks;
  // The settings route as the Hub has it: consent switches turn on only with `confirm: true`.
  const write = hub.api.setSetting as unknown as SettingsClient['setSetting'];
  const setSetting = vi.fn(async (key: string, value: unknown, opts?: { confirm?: boolean }) => {
    const refused = consentRefusal(key, value, opts);
    if (refused) throw refused;
    return opts ? write(key, value, opts) : write(key, value);
  });
  const api = { ...hub.api, ...devices.api, ...added.api, ...fw, setSetting };
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
  return { hub, devices, api: fw, setSetting, state, ...utils };
}
