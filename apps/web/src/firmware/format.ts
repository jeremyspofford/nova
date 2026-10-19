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
import { ApiError } from '../api.ts';
import { deviceErrorMessage, type ChipTone } from '../devices/format.ts';
import type { IconName } from '@nova/ui';

const enc = encodeURIComponent;

/** What a Hub-only approval card says (`answerIn: 'hub'`, docs/23 §6.3). */
export const HUB_ONLY_TEXT =
  'Only you can answer this, in Nova: here or on the Approvals page. Chat channels, email links and agents cannot answer it.';

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

export const FIRMWARE_KEY_LABEL: Record<string, string> = {
  wol: 'Wake-on-LAN',
  powerOnAfterPowerLoss: 'After a power cut',
  bootOrder: 'Boot order',
  virtualization: 'Virtualization (VT-x, AMD-V)',
  secureBoot: 'Secure Boot',
  tpm: 'TPM',
  fanProfile: 'Fan profile',
};

export function keyLabel(key: string): string {
  return FIRMWARE_KEY_LABEL[key] ?? key;
}

/** A value as text: a list (boot order) in order, `unset` when the device reports none. */
export function valueText(v: FirmwareValue | null | undefined): string {
  if (v === null || v === undefined) return 'Not reported';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'Empty';
  return String(v);
}

export const METHOD_TEXT: Record<FirmwareMethod, string> = {
  'firmware-attributes': 'Linux firmware attributes',
  efibootmgr: 'efibootmgr (boot order only)',
  fake: 'Test backend (no real firmware)',
};

/** How novad reaches the settings; a backend a newer novad named reads "unknown (<name>)". */
export function methodText(method: string | null): string {
  if (method === null) return 'Nothing';
  return isKnownFirmwareMethod(method) ? METHOD_TEXT[method] : `unknown (${method})`;
}

/** Why a machine is not supported, in words; the vendor's reason is already a sentence. */
export function supportReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case null:
    case undefined:
    case '':
    case 'unsupported':
      return 'This machine is not in the hardware support matrix.';
    case 'os_not_supported':
      return 'Nova changes firmware settings only on Linux devices. On Windows and macOS the vendor tools are not built in.';
    case 'legacy_bios':
      return 'This machine starts in legacy BIOS mode and its maker has no supported interface, so Nova cannot change its settings.';
    case 'unknown_platform':
      return 'The device did not report its maker and model.';
    case 'no_backend':
      return 'novad found no way to reach this machine’s firmware settings.';
    default:
      return /[.!]$/.test(reason) ? reason : `${reason}.`;
  }
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

export const REFUSAL_TEXT: Record<FirmwareRefusalReason, string> = {
  unknown_key: 'not a setting Nova may change',
  read_only: 'read-only on this machine',
  not_allowed_value: 'that value is not allowed here',
  unsupported: 'not supported on this machine',
};

export const CHANGE_STATUS: Record<
  FirmwareChangeStatus,
  { text: string; tone: ChipTone; icon: IconName | null }
> = {
  planned: { text: 'Planned', tone: 'neutral', icon: 'edit' },
  awaiting_approval: { text: 'Waiting for your approval', tone: 'needs_input', icon: 'shield' },
  approved: { text: 'Approved, ready to apply', tone: 'ready', icon: 'check' },
  applied: { text: 'Applied', tone: 'ready', icon: 'check' },
  rolled_back: { text: 'Rolled back', tone: 'neutral', icon: 'undo' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
  reverted: { text: 'Reverted by the watchdog', tone: 'blocked', icon: 'undo' },
  revert_failed: { text: 'Not reverted: check it', tone: 'blocked', icon: 'alert' },
};

/** Statuses of a change still in progress (the "current" change of a device). */
export const OPEN_STATUSES: readonly FirmwareChangeStatus[] = [
  'planned',
  'awaiting_approval',
  'approved',
];

export function changeKindText(c: Pick<FirmwareChangeView, 'kind'>): string {
  return c.kind === 'rollback' ? 'Rollback' : 'Change';
}

/** "9 min 5 s left", "1 h 2 min left", or "Past the deadline". */
export function countdownText(deadline: string | null | undefined, now: number): string {
  if (!deadline) return '';
  const ms = Date.parse(deadline) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Past the deadline';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${m} min left`;
  if (m) return `${m} min ${sec} s left`;
  return `${sec} s left`;
}

/** A time of day for a deadline: "14:32". */
export function clockText(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** What the watchdog says about an applied change. */
export function watchdogText(
  w: { state: FirmwareWatchdogState; deadline: string | null; reason?: string | null } | null,
  now: number,
): string | null {
  if (!w) return null;
  switch (w.state) {
    case 'pending': {
      const left = countdownText(w.deadline, now);
      return `Restarting with the watchdog armed: the device must come back${
        w.deadline ? ` by ${clockText(w.deadline)}` : ''
      }${left ? ` (${left})` : ''}, or it restores the previous settings.`;
    }
    case 'ok':
      return 'The device came back after the restart and kept the new settings.';
    // Worded from novad's reason, never claiming a restart that did not happen.
    case 'reverted':
      return w.reason === 'not_restarted'
        ? 'The device did not restart before the deadline: its watchdog restored the previous settings without a restart.'
        : w.reason === 'deadline'
          ? 'The device restarted into the change but was not back in time: its watchdog restored the previous settings.'
          : 'Its watchdog restored the previous settings.';
    case 'revert_failed': {
      const what =
        w.reason === 'not_restarted'
          ? 'The device did not restart before the deadline, and its watchdog'
          : w.reason === 'deadline'
            ? 'The device restarted into the change but was not back in time, and its watchdog'
            : 'Its watchdog';
      return `${what} could not restore the previous settings. Roll the change back from here, or check its firmware settings.`;
    }
    case 'missed':
      return 'The device has not reported since the restart. Its watchdog restores the previous settings when it starts.';
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
    e.message || 'The device did not make the change.',
  );
}

/** What the watchdog recorded on a change (`watchdog:<reason or error code>`). */
function WATCHDOG_ERROR(detail: string): string {
  switch (detail) {
    case '':
    case 'reverted':
      return 'The watchdog restored the previous settings.';
    case 'deadline':
      return 'The device did not come back by the deadline, so its watchdog restored the previous settings.';
    case 'not_restarted':
      return 'The device did not restart by the deadline, so its watchdog restored the previous settings without a restart.';
    case 'incomplete':
      return 'The watchdog restored only some of the previous settings.';
    case 'admin_password_required':
      return 'The watchdog could not restore the settings: this machine needs its BIOS admin password, which novad never keeps.';
    case 'error':
      return 'The watchdog could not restore the previous settings.';
    default:
      return `The watchdog could not restore the previous settings (${detail.replace(/_/g, ' ')}).`;
  }
}

/** A change's recorded error (`code:reason`, or `watchdog:detail`) in plain words. */
export function changeErrorText(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error.startsWith('watchdog:')) return WATCHDOG_ERROR(error.slice('watchdog:'.length));
  const [code = 'server_error', reason] = error.split(':');
  return firmwareErrorMessage(
    new ApiError(0, { code, message: '', retryable: false, details: reason ? { reason } : {} }),
    'The device did not make the change.',
  );
}

function reasonOf(err: ApiError): string | null {
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** A firmware or boot refusal from the Hub (or from the device through it), in plain words. */
export function firmwareErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return deviceErrorMessage(err, fallback);
  const d = err.body.details ?? {};
  const reason = reasonOf(err);
  switch (reason ?? err.body.code) {
    case 'owner_only':
      return 'Only the owner of this Hub can manage device firmware and boot.';
    case 'consent_required':
      return 'Turning this on needs your explicit confirmation.';
    case 'firmware_disabled':
      return 'BIOS and firmware changes are off. Turn them on in Settings → Devices first.';
    case 'low_level_boot_off':
      return 'Low-level boot changes are off. Turn them on in Settings → Devices first.';
    case 'unsupported_hardware':
      return `Nova cannot change this on this machine. ${supportReasonText(str(d.detail))}`;
    case 'security_degrading': {
      const keys = Array.isArray(d.keys) ? d.keys.map((k) => keyLabel(String(k))) : [];
      return `This change weakens security${keys.length ? ` (${keys.join(', ')})` : ''}, and changes like that are off. Turn on “Allow changes that weaken security” in Settings → Devices first.`;
    }
    case 'approval_required':
      return str(d.approvalId)
        ? 'Your approval for this change is still waiting. Answer it first.'
        : 'This change needs your approval first.';
    case 'approval_expired':
      return 'The approval for this change expired. Ask for approval again.';
    case 'approval_denied':
      return 'The approval for this change was denied. Ask again, or plan a different change.';
    case 'approval_mismatch':
      return 'This is not the change that was approved. Ask for approval again.';
    case 'approval_missing':
      return 'This change has no approval, so it was not sent.';
    case 'hub_only':
      return 'This approval can be answered only in Nova, by you.';
    case 'already_applied':
      return 'This change was already applied.';
    case 'failed':
      return 'This change failed. Plan it again.';
    case 'nothing_to_apply':
      return 'This plan changes nothing.';
    case 'nothing_to_roll_back':
      return 'Nothing to roll back: the device already has the settings of that snapshot.';
    case 'rolled_back':
      return 'This change was already rolled back.';
    case 'bios_password_required':
    case 'admin_password_required':
      return 'This machine needs its BIOS admin password. Store it in the BIOS admin password section first.';
    case 'identity_unavailable':
    case 'identity_missing':
      return 'The Hub’s identity key is not loaded, so it cannot sign the change. Check Network → Trust.';
    case 'firmware_busy':
      return 'Another firmware operation is running on this device. Try again in a moment.';
    case 'snapshot_missing':
      return 'There is no snapshot to restore for this change.';
    case 'snapshot_unreadable':
      return 'The Hub’s copy of the snapshot cannot be read.';
    case 'snapshot_corrupt':
      return 'The Hub’s copy of the snapshot failed its check, so it was not used.';
    case 'snapshot_mismatch':
      return 'The device’s snapshot did not match its checksum. Nothing was changed.';
    case 'snapshot_not_applicable':
      return 'That snapshot does not fit this machine’s settings now.';
    case 'unexpected_diff':
      return 'The device planned a change you did not ask for, so Nova stopped. Nothing was changed.';
    case 'base_mismatch':
      return 'The settings on the device changed since the plan. Nothing was written: plan again.';
    case 'plan_mismatch':
      return 'The device no longer has this plan. Plan the change again.';
    case 'apply_failed':
      return d.restored === false
        ? 'Writing a setting failed and the device could not restore the previous settings. Check its firmware settings before it restarts.'
        : 'Writing a setting failed. The device restored the previous settings.';
    case 'rollback_failed':
      return 'The rollback failed on the device. Check its firmware settings before it restarts.';
    case 'reboot_not_offered':
      return 'A rollback does not restart the device. Restart it yourself for the settings to take effect.';
    case 'reboot_unavailable':
      return 'The device cannot restart itself: power actions are off in its novad settings.';
    case 'watchdog_pending':
    case 'boot_pending':
      return 'A restart with the watchdog is already pending on this device. Wait for it to finish.';
    case 'watchdog_unavailable':
      return 'The watchdog cannot restore a machine with a BIOS admin password, so Nova does not restart it. Apply without the restart, restart it yourself, and roll back from Nova if needed.';
    case 'watchdog_already_used':
      return 'The watchdog already handled this change.';
    case 'tls_required':
      return 'This needs the device’s secure management channel (mutual TLS), and the device has no certificate for it yet. Switch the Hub to its local CA in Network → Trust, then add the device again so it gets one.';
    case 'no_client_certificate':
      return 'The Hub has no client certificate for the device’s secure management channel yet. Check Network → Trust.';
    case 'authorization_invalid':
    case 'authorization_mismatch':
      return 'The device refused the Hub’s signed authorization. Nothing was changed.';
    case 'authorization_expired':
      return 'The Hub’s signed authorization expired before the device got it. Check the clocks, then try again.';
    case 'replayed':
      return 'The device already used this authorization. Nothing was changed again.';
    case 'module_not_allowed':
      return str(d.module) === 'firmware' || !str(d.module)
        ? 'The firmware module is not allowed by this device’s policy.'
        : deviceErrorMessage(err, fallback);
    case 'kernel_args_not_supported':
      return 'Kernel arguments are not supported yet: a profile boots an entry as its bootloader defines it.';
    case 'name_taken':
      return 'This device already has a boot profile with that name.';
    case 'attempt_pending':
      return 'A boot trial is already running on this device. Wait for it to finish, or revert it.';
    case 'request_pending':
      return 'A boot change for this device is already waiting for approval.';
    case 'grub_default_not_saved':
      return 'GRUB keeps a chosen default only with GRUB_DEFAULT=saved. Set it in /etc/default/grub on the device, update GRUB, then make the entry the default again.';
    case 'unverified_trial':
      return 'The device could not tell which entry it booted, so this trial is not verified. Check that it booted this entry, then confirm it.';
    case 'not_confirmed':
      return 'Only a trial the device confirmed can become the default.';
    case 'already_default':
      return 'This trial is already the default.';
    case 'unknown_entry':
      return 'The device has no boot entry with that id. Refresh and choose one it lists.';
    case 'bad_answer':
      return 'The device sent an answer the Hub cannot read.';
    case 'interrupted':
      return 'The Hub restarted while sending this change, so it is not known whether the device took it. Check the device, then ask again.';
    case 'revoked':
      return 'This device was revoked.';
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
