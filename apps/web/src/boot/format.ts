// Words for the Boot tab of a device (FR-143; docs/23 §5.2): bootloaders, trial and request
// statuses, why a trial ended, and the watchdog choices. Refusals use the firmware area's map
// (src/firmware/format.ts), which covers the boot reasons too.
import {
  isKnownBootloader,
  type BootAttemptStatus,
  type BootRequestKind,
  type BootRequestStatus,
  type Bootloader,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import type { ChipTone } from '../devices/format.ts';

export const BOOTLOADER_TEXT: Record<Bootloader, string> = {
  'systemd-boot': 'systemd-boot',
  grub: 'GRUB',
  uefi: 'UEFI boot manager',
  fake: 'Test bootloader (fake)',
  none: 'None found',
};

/** A bootloader's name; one a newer novad sent reads "unknown (<name>)". */
export function bootloaderText(name: string): string {
  return isKnownBootloader(name) ? BOOTLOADER_TEXT[name] : `unknown (${name})`;
}

export const ATTEMPT_STATUS: Record<
  BootAttemptStatus,
  { text: string; tone: ChipTone; icon: IconName | null }
> = {
  pending: { text: 'Trying', tone: 'running', icon: null },
  ok: { text: 'Came back', tone: 'ready', icon: 'check' },
  reverted: { text: 'Back on the default', tone: 'needs_input', icon: 'undo' },
  failed: { text: 'Did not come back', tone: 'blocked', icon: 'alert' },
};

/**
 * Why a trial ended other than `ok`. A device's revert is worded from novad's reason, the first
 * word of the attempt's `detail`: `deadline`, `not_booted` or `not_restarted`.
 */
export function attemptReasonText(
  reason: string | null,
  detail: string | null = null,
): string | null {
  switch (reason) {
    case null:
      return null;
    case 'reverted_by_device':
      switch (detail?.split(':')[0]?.trim()) {
        case 'deadline':
          return 'It restarted into the entry but was not back in time, so it returned to its default entry.';
        case 'not_booted':
          return 'It did not start the entry (it booted another one), so it is on its default entry.';
        case 'not_restarted':
          return 'It did not restart before the watchdog deadline, so the one-shot boot was cleared and it stays on its default entry.';
        default:
          return 'Its watchdog ended the trial and it is on its default entry.';
      }
    case 'revert':
      return 'You cleared the one-shot boot.';
    case 'no_heartbeat':
      return 'It has not been heard from since the trial. It returns to its default entry at its next power cycle.';
    case 'no_watchdog_report':
      return 'It is online but never confirmed the entry.';
    case 'revoked':
      return 'The device was revoked.';
    default:
      return reason;
  }
}

export const REQUEST_KIND_TEXT: Record<BootRequestKind, string> = {
  try: 'Boot once',
  commit: 'Make default',
  revert: 'Clear the one-shot',
};

export const REQUEST_STATUS: Record<
  BootRequestStatus,
  { text: string; tone: ChipTone; icon: IconName | null }
> = {
  awaiting_approval: { text: 'Waiting for your approval', tone: 'needs_input', icon: 'shield' },
  denied: { text: 'Denied', tone: 'neutral', icon: 'stop' },
  expired: { text: 'Expired', tone: 'neutral', icon: 'clock' },
  sent: { text: 'Sent to the device', tone: 'ready', icon: 'check' },
  failed: { text: 'Not made', tone: 'blocked', icon: 'alert' },
};

/** Watchdog choices for a trial, in minutes (the setting allows 2 to 60). */
export const WATCHDOG_MINUTES = [2, 5, 10, 15, 20, 30, 45, 60] as const;

export function minutesText(seconds: number): string {
  const m = seconds / 60;
  if (Number.isInteger(m)) return m === 1 ? '1 minute' : `${m} minutes`;
  return `${seconds} seconds`;
}

/** The watchdog options, with the current value kept when it is not a whole preset. */
export function watchdogOptions(current: number): { value: string; label: string }[] {
  const presets: number[] = WATCHDOG_MINUTES.map((m) => m * 60);
  const all = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return all.map((s) => ({ value: String(s), label: minutesText(s) }));
}
