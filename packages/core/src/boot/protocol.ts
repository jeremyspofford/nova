// The boot routes of novad's management channel (ADR-096 D5) as the Hub reads them, and the
// device authorization the privileged ones carry (D2). novad's answers are parsed here, so an
// answer that does not fit is refused rather than guessed at.
import { z } from 'zod';
import { NovaError, type DeviceBootStatusView } from '@nova/shared';
import {
  deviceAuthzBodySha256,
  signDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceAuthzSigner,
} from '../firmware/authz.ts';
import { openNameSchema } from '../firmware/protocol.ts';

export const BOOT_STATUS_PATH = '/agent/v1/boot/status';
export const BOOT_SET_PATH = '/agent/v1/boot/set';
export const BOOT_COMMIT_PATH = '/agent/v1/boot/commit';
export const BOOT_REVERT_PATH = '/agent/v1/boot/revert';

/** The authorization kinds of the boot routes (D2). */
export const BOOT_AUTHZ_KINDS = ['boot.set', 'boot.commit', 'boot.revert'] as const;
export type BootAuthzKind = (typeof BOOT_AUTHZ_KINDS)[number];

/** Heartbeat events that close a trial (D5). */
export const BOOT_WATCHDOG_EVENTS = ['boot.watchdog.ok', 'boot.watchdog.reverted'] as const;

const text = (max: number) => z.string().max(max);
const isoish = z.string().min(1).max(64);

const entrySchema = z.object({
  id: text(200).min(1),
  title: text(300),
  isDefault: z.boolean(),
});

/** `/agent/v1/boot/status` → the device's bootloader, entries and one-shot state. */
export const deviceBootStatusSchema = z.object({
  supported: z.boolean(),
  reason: text(500).nullish(),
  // A bootloader a newer novad names is shown as unknown, never a reason to refuse the answer.
  bootloader: openNameSchema,
  entries: z.array(entrySchema).max(500).default([]),
  booted: text(200).nullish(),
  pending: z.object({ profileId: text(100), entryId: text(200), deadline: isoish }).nullish(),
  last: z
    .object({
      profileId: text(100),
      entryId: text(200),
      result: z.enum(['ok', 'reverted', 'failed']),
      at: isoish,
    })
    .nullish(),
});

export function bootStatusView(raw: unknown): DeviceBootStatusView {
  const s = deviceBootStatusSchema.parse(raw);
  return {
    supported: s.supported,
    reason: s.reason ?? null,
    bootloader: s.bootloader,
    entries: s.entries,
    booted: s.booted ?? null,
    pending: s.pending ?? null,
    last: s.last ?? null,
  };
}

/** `/agent/v1/boot/set` → `{pending}`. */
export const bootSetAnswerSchema = z.object({
  pending: z.object({ profileId: text(100), entryId: text(200), deadline: isoish }),
});

/** A `boot.watchdog.*` event in a heartbeat's `events` (D5). */
export const bootWatchdogEventSchema = z.object({
  kind: z.enum(BOOT_WATCHDOG_EVENTS),
  /** The D2 changeId of the `boot.set` the trial came from (novad sends it since M7.5 review). */
  changeId: text(100).nullish(),
  profileId: text(100).nullish(),
  entryId: text(200).nullish(),
  at: isoish.nullish(),
  /** `boot.watchdog.ok`: whether novad saw the trial entry booted (GRUB cannot tell: false). */
  verified: z.boolean().nullish(),
  detail: z.unknown().optional(),
});
export type BootWatchdogEvent = z.infer<typeof bootWatchdogEventSchema>;

/** What the Hub asks its signer for: one change, approved, for one device. */
export interface BootAuthorizationRequest {
  kind: BootAuthzKind;
  deviceId: string;
  /** UUIDv7, never reused. */
  changeId: string;
  approvalId: string;
  /** The request body without its authorization (its SHA-256 becomes `bodySha256`). */
  body: Record<string, unknown>;
}

export type { DeviceAuthorization };

/** Signs a device authorization with the Hub identity key (the firmware area's D2 signer). */
export type BootAuthorizer = (req: BootAuthorizationRequest) => Promise<DeviceAuthorization>;

/** Hex SHA-256 of a body's canonical JSON: the approval's `argsHash` and D2's `bodySha256`. */
export function bootBodySha256(body: Record<string, unknown>): string {
  return deviceAuthzBodySha256(body);
}

/**
 * The boot area's D2 signer: the firmware area's `signDeviceAuthorization` with the Hub identity
 * key, using the request's own change id. Without a loaded identity it refuses
 * (`identity_missing`): nothing is ever sent unsigned.
 */
export function bootAuthorizer(
  signer: () => DeviceAuthzSigner | null,
  now: () => Date = () => new Date(),
): BootAuthorizer {
  return (req) => {
    const s = signer();
    if (!s)
      return Promise.reject(
        new NovaError('conflict', 'the Hub identity is not loaded: it cannot sign this', {
          details: { reason: 'identity_missing' },
        }),
      );
    return Promise.resolve(
      signDeviceAuthorization(s, {
        kind: req.kind,
        deviceId: req.deviceId,
        approvalId: req.approvalId,
        body: req.body,
        changeId: req.changeId,
        now: now(),
      }),
    );
  };
}
