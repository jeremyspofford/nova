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
import { defineMessages, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import type { ChipTone, StatusChip } from '../devices/format.ts';

/**
 * The boot area's shared words (FR-016). Each read translates in the active locale; the Boot
 * tab's own sentences live in `boot.panel`.
 */
export const BOOT_TEXT = defineMessages('boot', {
  bootloaders: {
    'systemd-boot': 'systemd-boot',
    grub: 'GRUB',
    uefi: 'UEFI boot manager',
    fake: 'Test bootloader (fake)',
    none: 'None found',
  },
  /** A bootloader a newer novad sent, shown as it is. */
  unknownBootloader: 'unknown ({name})',
  attemptStatus: {
    pending: 'Trying',
    ok: 'Came back',
    reverted: 'Back on the default',
    failed: 'Did not come back',
  },
  /** A device's revert, worded from novad's reason. */
  revertedBy: {
    deadline:
      'It restarted into the entry but was not back in time, so it returned to its default entry.',
    not_booted:
      'It did not start the entry (it booted another one), so it is on its default entry.',
    not_restarted:
      'It did not restart before the watchdog deadline, so the one-shot boot was cleared and it stays on its default entry.',
    other: 'Its watchdog ended the trial and it is on its default entry.',
  },
  attemptReasons: {
    revert: 'You cleared the one-shot boot.',
    no_heartbeat:
      'It has not been heard from since the trial. It returns to its default entry at its next power cycle.',
    no_watchdog_report: 'It is online but never confirmed the entry.',
    revoked: 'The device was revoked.',
  },
  requestKinds: {
    try: 'Boot once',
    commit: 'Make default',
    revert: 'Clear the one-shot',
  },
  requestStatus: {
    awaiting_approval: 'Waiting for your approval',
    denied: 'Denied',
    expired: 'Expired',
    sent: 'Sent to the device',
    failed: 'Not made',
  },
  minutes: '{m, plural, one {# minute} other {# minutes}}',
  seconds: '{s, plural, one {# second} other {# seconds}}',
});

const S = BOOT_TEXT;

export const BOOTLOADER_TEXT: Readonly<Record<Bootloader, string>> = S.bootloaders;

/** A bootloader's name; one a newer novad sent reads "unknown (<name>)". */
export function bootloaderText(name: string): string {
  return isKnownBootloader(name) ? BOOTLOADER_TEXT[name] : S.unknownBootloader({ name });
}

function chip<K extends string>(
  words: Readonly<Record<K, string>>,
  key: K,
  tone: ChipTone,
  icon: IconName | null,
): StatusChip<IconName | null> {
  return {
    get text() {
      return words[key];
    },
    tone,
    icon,
  };
}

export const ATTEMPT_STATUS: Record<BootAttemptStatus, StatusChip<IconName | null>> = {
  pending: chip(S.attemptStatus, 'pending', 'running', null),
  ok: chip(S.attemptStatus, 'ok', 'ready', 'check'),
  reverted: chip(S.attemptStatus, 'reverted', 'needs_input', 'undo'),
  failed: chip(S.attemptStatus, 'failed', 'blocked', 'alert'),
};

/**
 * Why a trial ended other than `ok`. A device's revert is worded from novad's reason, the first
 * word of the attempt's `detail`: `deadline`, `not_booted` or `not_restarted`. A reason Nova has
 * no words for is shown as the Hub sent it.
 */
export function attemptReasonText(
  reason: string | null,
  detail: string | null = null,
): string | null {
  if (reason === null) return null;
  if (reason === 'reverted_by_device') {
    const why = detail?.split(':')[0]?.trim() ?? '';
    return messageFor(S.revertedBy, why) ?? S.revertedBy.other;
  }
  return messageFor(S.attemptReasons, reason) ?? reason;
}

export const REQUEST_KIND_TEXT: Readonly<Record<BootRequestKind, string>> = S.requestKinds;

export const REQUEST_STATUS: Record<BootRequestStatus, StatusChip<IconName | null>> = {
  awaiting_approval: chip(S.requestStatus, 'awaiting_approval', 'needs_input', 'shield'),
  denied: chip(S.requestStatus, 'denied', 'neutral', 'stop'),
  expired: chip(S.requestStatus, 'expired', 'neutral', 'clock'),
  sent: chip(S.requestStatus, 'sent', 'ready', 'check'),
  failed: chip(S.requestStatus, 'failed', 'blocked', 'alert'),
};

/** Watchdog choices for a trial, in minutes (the setting allows 2 to 60). */
export const WATCHDOG_MINUTES = [2, 5, 10, 15, 20, 30, 45, 60] as const;

/** "10 minutes", "1 minute", or "150 seconds" when not a whole number of minutes. */
export function minutesText(seconds: number): string {
  const m = seconds / 60;
  if (Number.isInteger(m)) return S.minutes({ m });
  return S.seconds({ s: seconds });
}

/** The watchdog options, with the current value kept when it is not a whole preset. */
export function watchdogOptions(current: number): { value: string; label: string }[] {
  const presets: number[] = WATCHDOG_MINUTES.map((m) => m * 60);
  const all = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return all.map((s) => ({ value: String(s), label: minutesText(s) }));
}
