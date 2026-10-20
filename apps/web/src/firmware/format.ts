// Words and pure helpers for the Firmware and Boot tabs of a device (FR-146, FR-143; docs/23
// §5.2, §6): what each setting, status and watchdog outcome is called, why a machine is not
// supported, and every refusal of the firmware and boot areas in plain words (never a raw code).
import {
  isKnownFirmwareMethod,
  type FirmwareChangeStatus,
  type FirmwareChangeView,
  type FirmwareMethod,
  type FirmwareRefusalReason,
  type FirmwareValue,
  type FirmwareWatchdogState,
} from '@nova/shared';
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import { ApiError } from '../api.ts';
import { deviceErrorMessage, listText, type StatusChip } from '../devices/format.ts';

/**
 * The firmware area's shared words (FR-016), also used by the Boot tab: settings, methods,
 * statuses, the watchdog and every refusal of the firmware and boot areas. Each read translates
 * in the active locale; the views' own sentences live next to them, in `firmware.<view>`
 * namespaces.
 */
export const FIRMWARE_TEXT = defineMessages('firmware', {
  hubOnlyLine:
    'Only you can answer this, in Nova: here or on the Approvals page. Chat channels, email links and agents cannot answer it.',
  turnOnInSettings: 'Turn it on in Settings → Devices',
  readAgain: 'Read again',
  askForApproval: 'Ask for approval',
  whatChanges: 'What changes on {device}',
  columns: {
    setting: 'Setting',
    before: 'Before',
    after: 'After',
  },
  notReported: 'Not reported',
  empty: 'Empty',
  keys: {
    wol: 'Wake-on-LAN',
    powerOnAfterPowerLoss: 'After a power cut',
    bootOrder: 'Boot order',
    virtualization: 'Virtualization (VT-x, AMD-V)',
    secureBoot: 'Secure Boot',
    tpm: 'TPM',
    fanProfile: 'Fan profile',
  },
  methods: {
    'firmware-attributes': 'Linux firmware attributes',
    efibootmgr: 'efibootmgr (boot order only)',
    fake: 'Test backend (no real firmware)',
  },
  noMethod: 'Nothing',
  /** A backend or bootloader name a newer novad sent, shown as it is. */
  unknownName: 'unknown ({name})',
  support: {
    unsupported: 'This machine is not in the hardware support matrix.',
    os_not_supported:
      'Nova changes firmware settings only on Linux devices. On Windows and macOS the vendor tools are not built in.',
    legacy_bios:
      'This machine starts in legacy BIOS mode and its maker has no supported interface, so Nova cannot change its settings.',
    unknown_platform: 'The device did not report its maker and model.',
    no_backend: 'novad found no way to reach this machine’s firmware settings.',
  },
  refusals: {
    unknown_key: 'not a setting Nova may change',
    read_only: 'read-only on this machine',
    not_allowed_value: 'that value is not allowed here',
    unsupported: 'not supported on this machine',
  },
  changeStatus: {
    planned: 'Planned',
    awaiting_approval: 'Waiting for your approval',
    approved: 'Approved, ready to apply',
    applied: 'Applied',
    rolled_back: 'Rolled back',
    failed: 'Failed',
    reverted: 'Reverted by the watchdog',
    revert_failed: 'Not reverted: check it',
  },
  changeKinds: {
    apply: 'Change',
    rollback: 'Rollback',
  },
  countdown: {
    past: 'Past the deadline',
    hours: '{h} h {m} min left',
    minutes: '{m} min {s} s left',
    seconds: '{s} s left',
  },
  watchdog: {
    pendingBy:
      'Restarting with the watchdog armed: the device must come back by {time} ({left}), or it restores the previous settings.',
    pending:
      'Restarting with the watchdog armed: the device must come back, or it restores the previous settings.',
    ok: 'The device came back after the restart and kept the new settings.',
    /** Worded from novad's reason, never claiming a restart that did not happen. */
    reverted:
      '{reason, select, not_restarted {The device did not restart before the deadline: its watchdog restored the previous settings without a restart.} deadline {The device restarted into the change but was not back in time: its watchdog restored the previous settings.} other {Its watchdog restored the previous settings.}}',
    revertFailed:
      '{reason, select, not_restarted {The device did not restart before the deadline, and its watchdog could not restore the previous settings. Roll the change back from here, or check its firmware settings.} deadline {The device restarted into the change but was not back in time, and its watchdog could not restore the previous settings. Roll the change back from here, or check its firmware settings.} other {Its watchdog could not restore the previous settings. Roll the change back from here, or check its firmware settings.}}',
    missed:
      'The device has not reported since the restart. Its watchdog restores the previous settings when it starts.',
  },
  /** What the watchdog recorded on a change (`watchdog:<reason or error code>`). */
  watchdogErrors: {
    reverted: 'The watchdog restored the previous settings.',
    deadline:
      'The device did not come back by the deadline, so its watchdog restored the previous settings.',
    not_restarted:
      'The device did not restart by the deadline, so its watchdog restored the previous settings without a restart.',
    incomplete: 'The watchdog restored only some of the previous settings.',
    admin_password_required:
      'The watchdog could not restore the settings: this machine needs its BIOS admin password, which novad never keeps.',
    error: 'The watchdog could not restore the previous settings.',
  },
  /** A watchdog error Nova has no words for; `detail` is novad's code with spaces. */
  watchdogErrorOther: 'The watchdog could not restore the previous settings ({detail}).',
  errors: {
    notMade: 'The device did not make the change.',
    ownerOnly: 'Only the owner of this Hub can manage device firmware and boot.',
    consentRequired: 'Turning this on needs your explicit confirmation.',
    firmwareDisabled:
      'BIOS and firmware changes are off. Turn them on in Settings → Devices first.',
    lowLevelBootOff: 'Low-level boot changes are off. Turn them on in Settings → Devices first.',
    unsupportedHardware: 'Nova cannot change this on this machine. {reason}',
    securityDegrading:
      'This change weakens security, and changes like that are off. Turn on “Allow changes that weaken security” in Settings → Devices first.',
    securityDegradingKeys:
      'This change weakens security ({keys}), and changes like that are off. Turn on “Allow changes that weaken security” in Settings → Devices first.',
    approvalWaiting: 'Your approval for this change is still waiting. Answer it first.',
    approvalRequired: 'This change needs your approval first.',
    approvalExpired: 'The approval for this change expired. Ask for approval again.',
    approvalDenied:
      'The approval for this change was denied. Ask again, or plan a different change.',
    approvalMismatch: 'This is not the change that was approved. Ask for approval again.',
    approvalMissing: 'This change has no approval, so it was not sent.',
    hubOnlyAnswer: 'This approval can be answered only in Nova, by you.',
    alreadyApplied: 'This change was already applied.',
    failed: 'This change failed. Plan it again.',
    nothingToApply: 'This plan changes nothing.',
    nothingToRollBack:
      'Nothing to roll back: the device already has the settings of that snapshot.',
    rolledBack: 'This change was already rolled back.',
    biosPassword:
      'This machine needs its BIOS admin password. Store it in the BIOS admin password section first.',
    identity:
      'The Hub’s identity key is not loaded, so it cannot sign the change. Check Network → Trust.',
    busy: 'Another firmware operation is running on this device. Try again in a moment.',
    snapshotMissing: 'There is no snapshot to restore for this change.',
    snapshotUnreadable: 'The Hub’s copy of the snapshot cannot be read.',
    snapshotCorrupt: 'The Hub’s copy of the snapshot failed its check, so it was not used.',
    snapshotMismatch: 'The device’s snapshot did not match its checksum. Nothing was changed.',
    snapshotNotApplicable: 'That snapshot does not fit this machine’s settings now.',
    unexpectedDiff:
      'The device planned a change you did not ask for, so Nova stopped. Nothing was changed.',
    baseMismatch:
      'The settings on the device changed since the plan. Nothing was written: plan again.',
    planMismatch: 'The device no longer has this plan. Plan the change again.',
    applyFailedUnrestored:
      'Writing a setting failed and the device could not restore the previous settings. Check its firmware settings before it restarts.',
    applyFailed: 'Writing a setting failed. The device restored the previous settings.',
    rollbackFailed:
      'The rollback failed on the device. Check its firmware settings before it restarts.',
    rebootNotOffered:
      'A rollback does not restart the device. Restart it yourself for the settings to take effect.',
    rebootUnavailable:
      'The device cannot restart itself: power actions are off in its novad settings.',
    watchdogPending:
      'A restart with the watchdog is already pending on this device. Wait for it to finish.',
    watchdogUnavailable:
      'The watchdog cannot restore a machine with a BIOS admin password, so Nova does not restart it. Apply without the restart, restart it yourself, and roll back from Nova if needed.',
    watchdogUsed: 'The watchdog already handled this change.',
    tlsRequired:
      'This needs the device’s secure management channel (mutual TLS), and the device has no certificate for it yet. Switch the Hub to its local CA in Network → Trust, then add the device again so it gets one.',
    noClientCertificate:
      'The Hub has no client certificate for the device’s secure management channel yet. Check Network → Trust.',
    authorizationRefused: 'The device refused the Hub’s signed authorization. Nothing was changed.',
    authorizationExpired:
      'The Hub’s signed authorization expired before the device got it. Check the clocks, then try again.',
    replayed: 'The device already used this authorization. Nothing was changed again.',
    moduleNotAllowed: 'The firmware module is not allowed by this device’s policy.',
    kernelArgs:
      'Kernel arguments are not supported yet: a profile boots an entry as its bootloader defines it.',
    nameTaken: 'This device already has a boot profile with that name.',
    attemptPending:
      'A boot trial is already running on this device. Wait for it to finish, or revert it.',
    requestPending: 'A boot change for this device is already waiting for approval.',
    /** `setting` is GRUB_DEFAULT=saved and `file` /etc/default/grub, shown as they are. */
    grubDefaultNotSaved:
      'GRUB keeps a chosen default only with {setting}. Set it in {file} on the device, update GRUB, then make the entry the default again.',
    unverifiedTrial:
      'The device could not tell which entry it booted, so this trial is not verified. Check that it booted this entry, then confirm it.',
    notConfirmed: 'Only a trial the device confirmed can become the default.',
    alreadyDefault: 'This trial is already the default.',
    unknownEntry: 'The device has no boot entry with that id. Refresh and choose one it lists.',
    badAnswer: 'The device sent an answer the Hub cannot read.',
    interrupted:
      'The Hub restarted while sending this change, so it is not known whether the device took it. Check the device, then ask again.',
    revoked: 'This device was revoked.',
  },
});

const S = FIRMWARE_TEXT;

const enc = encodeURIComponent;

/** What a Hub-only approval card says (`answerIn: 'hub'`, docs/23 §6.3), in the active locale. */
export function hubOnlyText(): string {
  return S.hubOnlyLine;
}

/** The device a `device:<id>` approval is about, and its name from the card's preview. */
export function approvalDevice(a: {
  scope?: string | null;
  argsPreview: string | null;
}): { id: string; name: string | null } | null {
  const m = /^device:(.+)$/.exec(a.scope ?? '');
  if (!m?.[1]) return null;
  let name: string | null = null;
  try {
    const p: unknown = JSON.parse(a.argsPreview ?? '');
    if (typeof p === 'object' && p !== null && 'device' in p && typeof p.device === 'string')
      name = p.device.trim() || null;
  } catch {
    // A preview that is not JSON names no device; the link still works.
  }
  return { id: m[1], name };
}

/** Where the "Firmware and boot" settings live (Settings → Devices). */
export const FIRMWARE_SETTINGS_PATH = '/settings/devices';
/** The anchor of that section, so links can land on it. */
export const FIRMWARE_SETTINGS_ANCHOR = 'firmware-boot';

export function firmwareTabPath(deviceId: string): string {
  return `/devices/${enc(deviceId)}?tab=firmware`;
}

export function bootTabPath(deviceId: string): string {
  return `/devices/${enc(deviceId)}?tab=boot`;
}

// ---- settings and values --------------------------------------------------------------------

/** A setting's name; read `FIRMWARE_KEY_LABEL[key]` at render time (or use `keyLabel`). */
export const FIRMWARE_KEY_LABEL: Readonly<Record<string, string>> = S.keys;

export function keyLabel(key: string): string {
  return messageFor(S.keys, key) ?? key;
}

/** A value as text: a list (boot order) in order, `unset` when the device reports none. */
export function valueText(v: FirmwareValue | null | undefined): string {
  if (v === null || v === undefined) return S.notReported;
  if (Array.isArray(v)) return v.length ? listText(v) : S.empty;
  return String(v);
}

export const METHOD_TEXT: Readonly<Record<FirmwareMethod, string>> = S.methods;

/** How novad reaches the settings; a backend a newer novad named reads "unknown (<name>)". */
export function methodText(method: string | null): string {
  if (method === null) return S.noMethod;
  return isKnownFirmwareMethod(method) ? METHOD_TEXT[method] : S.unknownName({ name: method });
}

/** Why a machine is not supported, in words; the vendor's reason is already a sentence. */
export function supportReasonText(reason: string | null | undefined): string {
  if (!reason) return S.support.unsupported;
  // A vendor's reason from the support matrix is the Hub's own English sentence (D9).
  return messageFor(S.support, reason) ?? (/[.!]$/.test(reason) ? reason : `${reason}.`);
}

const OFF = /^(disabled?|off|false|no|0|none)$/i;

/**
 * Whether setting `key` to `value` weakens security, by the Hub's own rule (docs/23 §6.3 item 5):
 * a value the device flags, or Secure Boot or the TPM turned off whatever the device says.
 */
export function weakensSecurity(
  key: string,
  value: FirmwareValue | null,
  deviceSays: readonly string[] = [],
): boolean {
  if (
    (typeof value === 'string' || typeof value === 'number') &&
    deviceSays.includes(String(value))
  )
    return true;
  if (
    (key === 'secureBoot' || key === 'tpm') &&
    (typeof value === 'string' || typeof value === 'number')
  )
    return OFF.test(String(value).trim());
  return false;
}

/** Two values are the same (lists element by element). */
export function sameValue(a: FirmwareValue | null, b: FirmwareValue | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Why a setting was left out of a plan; `REFUSAL_TEXT[reason] ?? reason`. */
export const REFUSAL_TEXT: Readonly<Record<FirmwareRefusalReason, string>> = S.refusals;

/** A status's chip: its words read in the active locale when shown (`get text`). */
function chip(
  status: FirmwareChangeStatus,
  tone: StatusChip<IconName | null>['tone'],
  icon: IconName | null,
): StatusChip<IconName | null> {
  return {
    get text() {
      return S.changeStatus[status];
    },
    tone,
    icon,
  };
}

export const CHANGE_STATUS: Record<FirmwareChangeStatus, StatusChip<IconName | null>> = {
  planned: chip('planned', 'neutral', 'edit'),
  awaiting_approval: chip('awaiting_approval', 'needs_input', 'shield'),
  approved: chip('approved', 'ready', 'check'),
  applied: chip('applied', 'ready', 'check'),
  rolled_back: chip('rolled_back', 'neutral', 'undo'),
  failed: chip('failed', 'blocked', 'alert'),
  reverted: chip('reverted', 'blocked', 'undo'),
  revert_failed: chip('revert_failed', 'blocked', 'alert'),
};

/** Statuses of a change still in progress (the "current" change of a device). */
export const OPEN_STATUSES: readonly FirmwareChangeStatus[] = [
  'planned',
  'awaiting_approval',
  'approved',
];

export function changeKindText(c: Pick<FirmwareChangeView, 'kind'>): string {
  return c.kind === 'rollback' ? S.changeKinds.rollback : S.changeKinds.apply;
}

/** "9 min 5 s left", "1 h 2 min left", or "Past the deadline". */
export function countdownText(deadline: string | null | undefined, now: number): string {
  if (!deadline) return '';
  const ms = Date.parse(deadline) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return S.countdown.past;
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return S.countdown.hours({ h, m });
  if (m) return S.countdown.minutes({ m, s: sec });
  return S.countdown.seconds({ s: sec });
}

/** A time of day for a deadline: "14:32". */
export function clockText(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return fmt.time(t, { hour: '2-digit', minute: '2-digit' });
}

/** What the watchdog says about an applied change. */
export function watchdogText(
  w: { state: FirmwareWatchdogState; deadline: string | null; reason?: string | null } | null,
  now: number,
): string | null {
  if (!w) return null;
  const W = S.watchdog;
  switch (w.state) {
    case 'pending': {
      const left = countdownText(w.deadline, now);
      const time = clockText(w.deadline);
      return time && left ? W.pendingBy({ time, left }) : W.pending;
    }
    case 'ok':
      return W.ok;
    // Worded from novad's reason, never claiming a restart that did not happen.
    case 'reverted':
      return W.reverted({ reason: w.reason ?? '' });
    case 'revert_failed':
      return W.revertFailed({ reason: w.reason ?? '' });
    case 'missed':
      return W.missed;
  }
}

// ---- errors ---------------------------------------------------------------------------------

/** An error the Hub recorded (`{code, reason, message}`, e.g. a boot request's) in plain words. */
export function storedErrorText(
  e: { code: string; reason: string | null; message: string } | null | undefined,
): string | null {
  if (!e) return null;
  return firmwareErrorMessage(
    new ApiError(0, {
      code: e.code,
      message: e.message,
      retryable: false,
      details: e.reason ? { reason: e.reason } : {},
    }),
    // The Hub's recorded `message` stays English (D9) when Nova has no words for its code.
    e.message || S.errors.notMade,
  );
}

/** What the watchdog recorded on a change (`watchdog:<reason or error code>`). */
function watchdogError(detail: string): string {
  if (!detail) return S.watchdogErrors.reverted;
  return (
    messageFor(S.watchdogErrors, detail) ??
    S.watchdogErrorOther({ detail: detail.replace(/_/g, ' ') })
  );
}

/** A change's recorded error (`code:reason`, or `watchdog:detail`) in plain words. */
export function changeErrorText(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error.startsWith('watchdog:')) return watchdogError(error.slice('watchdog:'.length));
  const [code = 'server_error', reason] = error.split(':');
  return firmwareErrorMessage(
    new ApiError(0, { code, message: '', retryable: false, details: reason ? { reason } : {} }),
    S.errors.notMade,
  );
}

function reasonOf(err: ApiError): string | null {
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * A firmware or boot refusal from the Hub (or from the device through it), in plain words. A code
 * Nova has no words for falls back to the devices words, then to the Hub's (English) `message`,
 * then to `fallback`.
 */
export function firmwareErrorMessage(err: unknown, fallback?: string): string {
  if (!(err instanceof ApiError)) return deviceErrorMessage(err, fallback);
  const d = err.body.details ?? {};
  const reason = reasonOf(err);
  const E = S.errors;
  switch (reason ?? err.body.code) {
    case 'owner_only':
      return E.ownerOnly;
    case 'consent_required':
      return E.consentRequired;
    case 'firmware_disabled':
      return E.firmwareDisabled;
    case 'low_level_boot_off':
      return E.lowLevelBootOff;
    case 'unsupported_hardware':
      return E.unsupportedHardware({ reason: supportReasonText(str(d.detail)) });
    case 'security_degrading': {
      const keys = Array.isArray(d.keys) ? d.keys.map((k) => keyLabel(String(k))) : [];
      return keys.length ? E.securityDegradingKeys({ keys: listText(keys) }) : E.securityDegrading;
    }
    case 'approval_required':
      return str(d.approvalId) ? E.approvalWaiting : E.approvalRequired;
    case 'approval_expired':
      return E.approvalExpired;
    case 'approval_denied':
      return E.approvalDenied;
    case 'approval_mismatch':
      return E.approvalMismatch;
    case 'approval_missing':
      return E.approvalMissing;
    case 'hub_only':
      return E.hubOnlyAnswer;
    case 'already_applied':
      return E.alreadyApplied;
    case 'failed':
      return E.failed;
    case 'nothing_to_apply':
      return E.nothingToApply;
    case 'nothing_to_roll_back':
      return E.nothingToRollBack;
    case 'rolled_back':
      return E.rolledBack;
    case 'bios_password_required':
    case 'admin_password_required':
      return E.biosPassword;
    case 'identity_unavailable':
    case 'identity_missing':
      return E.identity;
    case 'firmware_busy':
      return E.busy;
    case 'snapshot_missing':
      return E.snapshotMissing;
    case 'snapshot_unreadable':
      return E.snapshotUnreadable;
    case 'snapshot_corrupt':
      return E.snapshotCorrupt;
    case 'snapshot_mismatch':
      return E.snapshotMismatch;
    case 'snapshot_not_applicable':
      return E.snapshotNotApplicable;
    case 'unexpected_diff':
      return E.unexpectedDiff;
    case 'base_mismatch':
      return E.baseMismatch;
    case 'plan_mismatch':
      return E.planMismatch;
    case 'apply_failed':
      return d.restored === false ? E.applyFailedUnrestored : E.applyFailed;
    case 'rollback_failed':
      return E.rollbackFailed;
    case 'reboot_not_offered':
      return E.rebootNotOffered;
    case 'reboot_unavailable':
      return E.rebootUnavailable;
    case 'watchdog_pending':
    case 'boot_pending':
      return E.watchdogPending;
    case 'watchdog_unavailable':
      return E.watchdogUnavailable;
    case 'watchdog_already_used':
      return E.watchdogUsed;
    case 'tls_required':
      return E.tlsRequired;
    case 'no_client_certificate':
      return E.noClientCertificate;
    case 'authorization_invalid':
    case 'authorization_mismatch':
      return E.authorizationRefused;
    case 'authorization_expired':
      return E.authorizationExpired;
    case 'replayed':
      return E.replayed;
    case 'module_not_allowed':
      return str(d.module) === 'firmware' || !str(d.module)
        ? E.moduleNotAllowed
        : deviceErrorMessage(err, fallback);
    case 'kernel_args_not_supported':
      return E.kernelArgs;
    case 'name_taken':
      return E.nameTaken;
    case 'attempt_pending':
      return E.attemptPending;
    case 'request_pending':
      return E.requestPending;
    case 'grub_default_not_saved':
      return E.grubDefaultNotSaved({ setting: 'GRUB_DEFAULT=saved', file: '/etc/default/grub' });
    case 'unverified_trial':
      return E.unverifiedTrial;
    case 'not_confirmed':
      return E.notConfirmed;
    case 'already_default':
      return E.alreadyDefault;
    case 'unknown_entry':
      return E.unknownEntry;
    case 'bad_answer':
      return E.badAnswer;
    case 'interrupted':
      return E.interrupted;
    case 'revoked':
      return E.revoked;
    default:
      return deviceErrorMessage(err, fallback);
  }
}

/**
 * For a confirmation dialog's action: a refusal becomes an error carrying its plain words, which
 * the dialog shows while it stays open.
 */
export async function inPlainWords<T>(p: Promise<T>, fallback?: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new Error(firmwareErrorMessage(err, fallback), { cause: err });
  }
}
