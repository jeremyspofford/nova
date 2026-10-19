// M7.5 out-of-band management (FR-147; docs/23 §7; ADR-096 D6): the Hub talks to BMCs directly
// (Redfish over HTTPS with a pinned certificate, IPMI through ipmitool). Intel AMT is not built
// (WS-Management is out of scope for M7.5). Views and zod requests for /api/v1/oob.
import { z } from 'zod';
import { idSchema } from '../api.ts';
import { FIRMWARE_KEYS, type FirmwareKey } from './firmware.ts';

/** How the Hub reaches a BMC. `amt` is refused with `capability_missing` `{reason: not_built}`. */
export const OOB_KINDS = ['redfish', 'ipmi', 'amt'] as const;
export type OobKind = (typeof OOB_KINDS)[number];

/** Every out-of-band action (D6). `check` reads the Redfish service root or the chassis status. */
export const OOB_ACTIONS = [
  'check',
  'power.status',
  'power.on',
  'power.off',
  'power.cycle',
  'power.reset',
  'sensors',
  'bios.read',
  'bios.plan',
  'bios.apply',
  'boot.next',
] as const;
export type OobAction = (typeof OOB_ACTIONS)[number];

/** Actions that read only and need no approval; every other action needs one (D6). */
export const OOB_READ_ACTIONS = ['check', 'power.status', 'sensors', 'bios.read'] as const;

export function oobActionNeedsApproval(action: OobAction): boolean {
  return !(OOB_READ_ACTIONS as readonly string[]).includes(action);
}

/**
 * An action's record: read actions end `done` or `failed` at once; the others wait for their
 * approval (`awaiting_approval`) and then run (`running`, `done`, `failed`), or end `denied` or
 * `expired`. A `bios.plan` that was approved is `approved` until `bios.apply` uses it (`applied`).
 */
export const OOB_ACTION_STATUSES = [
  'awaiting_approval',
  'approved',
  'running',
  'done',
  'failed',
  'denied',
  'expired',
  'applied',
] as const;
export type OobActionStatus = (typeof OOB_ACTION_STATUSES)[number];

/** One-time boot targets (Redfish `BootSourceOverrideTarget`, IPMI `chassis bootdev`). */
export const OOB_BOOT_TARGETS = ['pxe', 'disk', 'cdrom', 'bios', 'usb'] as const;
export type OobBootTarget = (typeof OOB_BOOT_TARGETS)[number];

/**
 * The firmware settings in scope (BM2, docs/23 §6.2) by their canonical keys: the same allowlist as
 * the device firmware area (D4). The Redfish attribute names behind them are this area's own table
 * (`packages/core/src/oob/bios.ts`): BMC attribute names differ from the OS-side ones.
 */
export const OOB_BIOS_KEYS = FIRMWARE_KEYS;
export type OobBiosKey = FirmwareKey;

/** Why a planned BIOS change was left out of the plan. */
export type OobBiosRefusal =
  'unsupported' | 'read_only' | 'not_allowed_value' | 'security_degrading' | 'unchanged';

/** SHA-256 of the BMC certificate's DER: 64 hex digits, colons allowed; stored lower case. */
export const oobTlsPinSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/:/g, '').toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 fingerprint (64 hex digits)'));

const credentialsSchema = z
  .object({
    // HTTP Basic and ipmitool cannot carry a colon or control characters in a user name.
    username: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (v) => ![...v].some((c) => c === ':' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
        'no colon or control characters',
      ),
    password: z.string().min(1).max(256),
  })
  .strict();

const systemIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'a Redfish system id (letters, digits, dot, dash, underscore)');

/** `POST /api/v1/oob/endpoints`. The address is a host name or IP (a bare https:// URL for Redfish). */
export const createOobEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(OOB_KINDS),
    address: z.string().trim().min(1).max(300),
    port: z.number().int().min(1).max(65535).optional(),
    systemId: systemIdSchema.optional(),
    credentials: credentialsSchema,
    deviceId: idSchema.nullable().optional(),
    tlsPin: oobTlsPinSchema.nullable().optional(),
  })
  .strict();
export type CreateOobEndpointRequest = z.infer<typeof createOobEndpointSchema>;

/** `PATCH /api/v1/oob/endpoints/:id`. `tlsPin: null` forgets the pin (pinned again on next use). */
export const updateOobEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    systemId: systemIdSchema.nullable().optional(),
    credentials: credentialsSchema.optional(),
    deviceId: idSchema.nullable().optional(),
    tlsPin: oobTlsPinSchema.nullable().optional(),
  })
  .strict();
export type UpdateOobEndpointRequest = z.infer<typeof updateOobEndpointSchema>;

/**
 * `POST /api/v1/oob/endpoints/:id/pin/confirm`: the owner confirms the certificate fingerprint a
 * first `check` read (compared with the one stored, so a changed certificate is not confirmed).
 */
export const confirmOobPinSchema = z.object({ tlsPin: oobTlsPinSchema }).strict();

/** `POST /api/v1/oob/enable`: turning out-of-band management on needs this explicit consent. */
export const enableOobSchema = z.object({ confirm: z.literal(true) }).strict();

export const oobBootNextSchema = z
  .object({
    target: z.enum(OOB_BOOT_TARGETS),
    /** Boot mode for the override; left as the BMC has it when omitted. */
    mode: z.enum(['uefi', 'legacy']).optional(),
  })
  .strict();

export const oobBiosPlanSchema = z
  .object({
    changes: z
      .array(z.object({ key: z.enum(OOB_BIOS_KEYS), value: z.string().min(1).max(100) }).strict())
      .min(1)
      .max(OOB_BIOS_KEYS.length)
      .refine((c) => new Set(c.map((x) => x.key)).size === c.length, 'each key at most once'),
    /** The separate, explicit override a security-degrading change needs (docs/23 §6.3 item 5). */
    allowSecurityDegrading: z.boolean().optional(),
  })
  .strict();

export const oobBiosApplySchema = z.object({ planId: idSchema }).strict();

const emptySchema = z.object({}).strict();

/** The body each action takes (`POST /api/v1/oob/endpoints/:id/actions/:action`). */
export const OOB_ACTION_BODY_SCHEMAS: Record<OobAction, z.ZodType<Record<string, unknown>>> = {
  check: emptySchema,
  'power.status': emptySchema,
  'power.on': emptySchema,
  'power.off': emptySchema,
  'power.cycle': emptySchema,
  'power.reset': emptySchema,
  sensors: emptySchema,
  'bios.read': emptySchema,
  'bios.plan': oobBiosPlanSchema,
  'bios.apply': oobBiosApplySchema,
  'boot.next': oobBootNextSchema,
};

export interface OobEndpointView {
  id: string;
  name: string;
  kind: OobKind;
  address: string;
  /** null: the protocol's default (443 for Redfish, 623 for IPMI). */
  port: number | null;
  systemId: string | null;
  deviceId: string | null;
  /** The vault entry holding the user name and password (never returned). */
  credentialRef: string;
  hasCredentials: boolean;
  tlsPin: string | null;
  tlsPinnedAt: string | null;
  /**
   * The owner confirmed the pin (an entered pin counts). Until then a Redfish BMC gets only the
   * unauthenticated service root (`check`): no credentials and no other action.
   */
  tlsPinConfirmed: boolean;
  tlsPinConfirmedAt: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  /** false for `amt` (not built). */
  supported: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OobActionError {
  code: string;
  reason: string | null;
  message: string;
}

export interface OobActionView {
  id: string;
  endpointId: string | null;
  endpointName: string;
  action: OobAction;
  params: Record<string, unknown>;
  status: OobActionStatus;
  approvalId: string | null;
  /** `bios.apply`: the `bios.plan` action it applied. */
  planId: string | null;
  before: unknown;
  after: unknown;
  result: unknown;
  error: OobActionError | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/v1/oob`. */
export interface OobStatusView {
  enabled: boolean;
  kinds: {
    redfish: { built: true };
    ipmi: { built: true };
    amt: { built: false; reason: 'not_built' };
  };
  /** Actions that need no approval. */
  readActions: OobAction[];
  endpoints: number;
}

/** A diff line of a BIOS plan (D4 shape). */
export interface OobBiosDiffView {
  key: OobBiosKey;
  vendorKey: string;
  from: string | null;
  to: string;
  securityDegrading: boolean;
}

/** The result of `bios.plan`: nothing is changed until it is approved and applied. */
export interface OobBiosPlanView {
  planId: string;
  vendor: string;
  snapshot: { takenAt: string; values: Record<string, string | null>; sha256: string };
  diff: OobBiosDiffView[];
  refused: { key: OobBiosKey; reason: OobBiosRefusal }[];
  /** Redfish pending settings apply at the next reboot. */
  requiresReboot: true;
  allowSecurityDegrading: boolean;
}

/** What the boot area offers in a failed-boot alert when the device has a linked BMC (D5). */
export interface OobPowerCycleLink {
  endpointId: string;
  endpointName: string;
  deviceId: string;
  action: 'power.cycle';
  method: 'POST';
  href: string;
}

export type OobPowerState = 'on' | 'off' | 'powering_on' | 'powering_off' | 'unknown';

/** One reading of `sensors` (Redfish Thermal and Power, IPMI `sdr list`). */
export interface OobSensorView {
  name: string;
  kind: 'temperature' | 'fan' | 'voltage' | 'power' | 'other';
  reading: number | null;
  unit: string | null;
  health: 'ok' | 'warning' | 'critical' | 'unknown';
}

/** An allowlisted BIOS setting as the BMC reports it, with the value pending for the next boot. */
export interface OobBiosSettingView {
  key: OobBiosKey;
  vendorKey: string;
  value: string | null;
  pending: string | null;
  allowed: string[];
  securityDegrading: string[];
}

/** The result of `bios.read`: only allowlisted settings, never the BMC's other attributes. */
export interface OobBiosReadView {
  supported: boolean;
  reason: string | null;
  vendor: string | null;
  settings: OobBiosSettingView[];
}
