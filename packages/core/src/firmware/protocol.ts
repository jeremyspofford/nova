// novad's firmware routes as the Hub reads them (ADR-096 D4): `/agent/v1/firmware/{read,plan,
// apply,rollback}`. Every answer is a device's word, so each is parsed with bounds before the Hub
// keeps or shows any of it; keys outside the allowlist are dropped.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FIRMWARE_KEYS,
  FIRMWARE_REFUSAL_REASONS,
  FIRMWARE_SETTING_TYPES,
  firmwareValueSchema,
  type FirmwareValue,
} from '@nova/shared';
import { canonicalJson } from '../nodes/crypto.ts';

export const FIRMWARE_PATHS = {
  read: '/agent/v1/firmware/read',
  plan: '/agent/v1/firmware/plan',
  apply: '/agent/v1/firmware/apply',
  rollback: '/agent/v1/firmware/rollback',
} as const;

const text = (max: number) => z.string().max(max);

/**
 * A name from a list novad may grow (a backend, a bootloader): any short plain name is kept as
 * sent, anything else becomes `unreadable`. An unknown name never makes a whole answer
 * unreadable; clients show it as "unknown (<name>)".
 */
export const openNameSchema = z
  .unknown()
  .optional()
  .transform((v) =>
    typeof v === 'string' && /^[A-Za-z0-9._:+-]{1,50}$/.test(v) ? v : 'unreadable',
  );
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'a hex SHA-256');
const value = firmwareValueSchema.nullable();

export const firmwarePlatformWireSchema = z.object({
  vendor: text(200).default(''),
  product: text(200).default(''),
  biosVendor: text(200).default(''),
  biosVersion: text(200).default(''),
  biosDate: text(100).default(''),
  uefi: z.boolean().default(false),
});

export const firmwareSettingWireSchema = z.object({
  key: text(100),
  vendorKey: text(200).default(''),
  value: value.default(null),
  type: z.enum(FIRMWARE_SETTING_TYPES),
  allowed: z.array(text(200)).max(256).nullable().default(null),
  readOnly: z.boolean().default(false),
  securityDegrading: z.array(text(200)).max(64).default([]),
});

export const firmwareReadWireSchema = z.object({
  supported: z.boolean(),
  reason: text(500).nullable().optional(),
  platform: firmwarePlatformWireSchema.nullable().optional(),
  method: z
    .unknown()
    .optional()
    .transform((v) => (v === null || v === undefined ? null : openNameSchema.parse(v))),
  adminPasswordSet: z.boolean().default(false),
  settings: z.array(firmwareSettingWireSchema).max(64).default([]),
  updates: z
    .array(z.object({ device: text(200), version: text(100), summary: text(500).default('') }))
    .max(100)
    .default([]),
});
export type FirmwareReadWire = z.infer<typeof firmwareReadWireSchema>;

export const firmwareSnapshotWireSchema = z.object({
  id: z.string().min(1).max(100),
  takenAt: text(40),
  values: z.record(text(100), value),
  sha256: hex64,
});

export const firmwarePlanWireSchema = z.object({
  planId: z.string().min(1).max(100),
  snapshot: firmwareSnapshotWireSchema,
  diff: z
    .array(
      z.object({
        key: text(100),
        vendorKey: text(200).default(''),
        from: value.default(null),
        to: value.default(null),
        securityDegrading: z.boolean().default(false),
      }),
    )
    .max(32),
  refused: z
    .array(z.object({ key: text(100), reason: z.enum(FIRMWARE_REFUSAL_REASONS) }))
    .max(32)
    .default([]),
  requiresReboot: z.boolean().default(false),
});
export type FirmwarePlanWire = z.infer<typeof firmwarePlanWireSchema>;

const appliedEntry = z.object({
  key: text(100),
  from: value.default(null),
  to: value.default(null),
});

export const firmwareApplyWireSchema = z.object({
  applied: z.array(appliedEntry).max(32).default([]),
  pendingReboot: z.boolean().default(false),
  watchdog: z
    .object({ deadline: text(40) })
    .nullable()
    .default(null),
});

export const firmwareRollbackWireSchema = z.object({
  restored: z.array(appliedEntry).max(32).default([]),
});

export function isFirmwareKey(key: string): key is (typeof FIRMWARE_KEYS)[number] {
  return (FIRMWARE_KEYS as readonly string[]).includes(key);
}

/** How a snapshot's values are hashed on both sides: hex SHA-256 of their canonical JSON. */
export function firmwareSnapshotSha256(values: Record<string, FirmwareValue | null>): string {
  return createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex');
}

/** Whether two setting values are the same (lists compare element by element). */
export function sameFirmwareValue(a: FirmwareValue | null, b: FirmwareValue | null): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const OFF = /^(disabled?|off|false|no|0|none)$/i;

/**
 * Whether setting `key` to `to` weakens security (docs/23 §6.3 item 5): a value the device lists
 * as degrading, or, whatever the device says, Secure Boot or the TPM turned off. Fail closed: the
 * Hub's own rule cannot be talked out of by a device that forgot to flag it.
 */
export function firmwareSecurityDegrading(
  key: string,
  to: FirmwareValue | null,
  deviceSays: readonly string[] = [],
): boolean {
  if (typeof to === 'string' && deviceSays.includes(to)) return true;
  if (typeof to === 'number' && deviceSays.includes(String(to))) return true;
  if ((key === 'secureBoot' || key === 'tpm') && (typeof to === 'string' || typeof to === 'number'))
    return OFF.test(String(to).trim());
  return false;
}
