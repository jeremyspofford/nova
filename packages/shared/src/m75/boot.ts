// M7.5 boot (FR-143, docs/23 §5.2, ADR-096 D5): named boot profiles per device, tried once with a
// watchdog and made the default only with the owner's approval, and network boot (PXE/iPXE) from
// images the owner placed on the Hub. Low-level boot (`devices.boot.allowLowLevel`) and PXE
// (`devices.pxe.enabled`) are off by default; nothing here is proactive or reachable by a model.
import { z } from 'zod';

/** A trial of a profile: `pending` until the device confirms it (`ok`), gave up (`reverted`) or the Hub's watchdog ran out (`failed`). */
export const BOOT_ATTEMPT_STATUSES = ['pending', 'ok', 'reverted', 'failed'] as const;
export type BootAttemptStatus = (typeof BOOT_ATTEMPT_STATUSES)[number];

/** What the owner asked the device to do: try a profile once, make a tried one the default, or clear a pending one-shot. */
export const BOOT_REQUEST_KINDS = ['try', 'commit', 'revert'] as const;
export type BootRequestKind = (typeof BOOT_REQUEST_KINDS)[number];

/**
 * A request waits for its approval, then is sent once: `sent` (the device took it), `failed`
 * (refused or unreachable), `denied` (the approval was), `expired` (not approved in time).
 */
export const BOOT_REQUEST_STATUSES = [
  'awaiting_approval',
  'denied',
  'expired',
  'sent',
  'failed',
] as const;
export type BootRequestStatus = (typeof BOOT_REQUEST_STATUSES)[number];

/** The bootloaders novad names; `fake` is its test backend (a JSON file, set in its config). */
export const BOOTLOADERS = ['systemd-boot', 'grub', 'uefi', 'fake', 'none'] as const;
export type Bootloader = (typeof BOOTLOADERS)[number];

export function isKnownBootloader(v: string): v is Bootloader {
  return (BOOTLOADERS as readonly string[]).includes(v);
}

/** `devices.boot.watchdogSeconds` bounds and default (ADR-096 D3). */
export const BOOT_WATCHDOG_MIN_SECONDS = 120;
export const BOOT_WATCHDOG_MAX_SECONDS = 3600;
export const BOOT_WATCHDOG_DEFAULT_SECONDS = 600;
/** The Hub fails a trial still pending this long after its deadline (ADR-096 D5). */
export const BOOT_WATCHDOG_GRACE_SECONDS = 120;

/** A bootloader entry as the device lists it. */
export interface BootEntryView {
  id: string;
  title: string;
  isDefault: boolean;
}

/** `/agent/v1/boot/status` as the device answered it. */
export interface DeviceBootStatusView {
  supported: boolean;
  reason: string | null;
  /**
   * One of `BOOTLOADERS`, or the name a newer novad sent (shown as "unknown (<name>)"), or
   * `unreadable`: an unknown name never makes the whole answer unreadable.
   */
  bootloader: string;
  entries: BootEntryView[];
  booted: string | null;
  pending: { profileId: string; entryId: string; deadline: string } | null;
  last: {
    profileId: string;
    entryId: string;
    result: 'ok' | 'reverted' | 'failed';
    at: string;
  } | null;
}

export interface BootProfileView {
  id: string;
  deviceId: string;
  name: string;
  entryId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BootAttemptView {
  id: string;
  deviceId: string;
  profileId: string;
  /** The request that set it (`try`). */
  requestId: string;
  entryId: string;
  status: BootAttemptStatus;
  reboot: boolean;
  watchdogSeconds: number;
  /** When the device gives up on the entry (the Hub's clock). */
  deadline: string;
  /**
   * Why it ended other than `ok`: `reverted_by_device`, `revert` (the owner cleared it),
   * `no_heartbeat` (the device never came back) or `no_watchdog_report` (it is up but never
   * confirmed the entry).
   */
  reason: string | null;
  detail: string | null;
  /**
   * Whether the device saw the trial entry booted when it confirmed it: false when it could not
   * tell (GRUB reports no booted entry), null before a report. Making an unverified trial the
   * default needs `confirmUnverified: true`.
   */
  verified: boolean | null;
  /** When a `commit` made its entry the default. */
  committedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface BootRequestView {
  id: string;
  deviceId: string;
  kind: BootRequestKind;
  status: BootRequestStatus;
  profileId: string | null;
  /** The attempt a `commit` makes the default, or the one a `try` started. */
  attemptId: string | null;
  entryId: string | null;
  /** The approval card; a `revert` is approved by the owner's own request. */
  approvalId: string | null;
  /** The device authorization's change id (UUIDv7, never reused; ADR-096 D2). */
  changeId: string;
  /** Why it failed: the device's or the Hub's error code and reason. */
  error: { code: string; reason: string | null; message: string } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  sentAt: string | null;
}

/** A device's PXE boot token: its value is shown once, when it is made or rotated. */
export interface PxeTokenView {
  deviceId: string;
  active: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface PxeTokenCreatedView extends PxeTokenView {
  /** `nvb_…`: shown once; only its hash is kept. */
  token: string;
  /** Where iPXE fetches its menu, on the address the request came in on. */
  scriptUrl: string;
}

/** An image in `<dataDir>/boot-images` the iPXE menu offers. */
export interface BootImageView {
  name: string;
  size: number;
  modifiedAt: string;
}

/** `GET /api/v1/devices/:id/boot`. */
export interface DeviceBootView {
  deviceId: string;
  /** `devices.boot.allowLowLevel`: off, try and commit are refused (revert always works). */
  lowLevelBoot: boolean;
  /** `devices.pxe.enabled`. */
  pxeEnabled: boolean;
  /** `devices.boot.watchdogSeconds`, the default for a try. */
  watchdogSeconds: number;
  /** The device's own answer; null with `statusError` when it could not be read. */
  status: DeviceBootStatusView | null;
  statusError: { code: string; reason: string | null; message: string } | null;
  profiles: BootProfileView[];
  /** Newest first, at most 20. */
  attempts: BootAttemptView[];
  /** Newest first, at most 20. */
  requests: BootRequestView[];
  pxe: PxeTokenView;
}

/** An entry id as a bootloader names it: no control characters. */
export const bootEntryIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\P{Cc}+$/u, 'printable characters only');

export const bootProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^\P{Cc}+$/u, 'printable characters only');

/** `POST /api/v1/devices/:id/boot/profiles`. Kernel arguments are not supported in M7.5. */
export const createBootProfileSchema = z
  .object({ name: bootProfileNameSchema, entryId: bootEntryIdSchema })
  .strict();
export type CreateBootProfileInput = z.infer<typeof createBootProfileSchema>;

/** `PATCH /api/v1/devices/:id/boot/profiles/:pid`. */
export const updateBootProfileSchema = z
  .object({ name: bootProfileNameSchema.optional(), entryId: bootEntryIdSchema.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.entryId !== undefined, 'nothing to change');
export type UpdateBootProfileInput = z.infer<typeof updateBootProfileSchema>;

/** `POST /api/v1/devices/:id/boot/profiles/:pid/try`: an approval card first, then the device. */
export const tryBootProfileSchema = z
  .object({
    watchdogSeconds: z
      .number()
      .int()
      .min(BOOT_WATCHDOG_MIN_SECONDS)
      .max(BOOT_WATCHDOG_MAX_SECONDS)
      .optional(),
    /** Reboot into the entry at once (default); false sets the one-shot for the next reboot. */
    reboot: z.boolean().default(true),
  })
  .strict();
export type TryBootProfileInput = z.infer<typeof tryBootProfileSchema>;

/** `POST /api/v1/devices/:id/boot/revert` takes no fields. */
export const bootEmptyBodySchema = z.object({}).strict();

/**
 * `POST /api/v1/devices/:id/boot/attempts/:aid/commit`. A trial the device could not verify
 * (`verified: false`) is refused (409 `conflict` `{reason: unverified_trial}`) unless the owner
 * confirms it anyway.
 */
export const commitBootAttemptSchema = z
  .object({ confirmUnverified: z.boolean().optional() })
  .strict();

/**
 * A file directly in `<dataDir>/boot-images`: a letter or digit first, then letters, digits, dots,
 * dashes and underscores, never `..` (no paths, no traversal).
 */
export const bootImageNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dots, dashes and underscores')
  .refine((n) => !n.includes('..'), 'no ".."');

/** A PXE boot token: `nvb_` and 32 random bytes, base64url. */
export const PXE_TOKEN_PREFIX = 'nvb_';
export const pxeTokenSchema = z.string().regex(/^nvb_[A-Za-z0-9_-]{43}$/, 'a PXE boot token');
