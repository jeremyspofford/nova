// Hub ↔ novad wire shapes (contracts/hub-api.md §3). novad calls /agent/v1/register with a one-use
// enrollment token, then heartbeats and capability updates with its device credential; the Hub
// calls the device's management endpoint with the management token the device generated. Until
// certificates arrive (M6.5) these are bearer tokens over LAN HTTP, like compute nodes (ADR-089).
import { isIPv4 } from 'node:net';
import { z } from 'zod';
import { NovaError } from '@nova/shared';
import { PUBLIC_KEY_PATTERN, SIGNATURE_PATTERN } from '../nodes/crypto.ts';

export const DEVICE_PROTOCOL_VERSIONS: readonly number[] = [1];
export const DEVICE_ENROLL_PREFIX = 'nvd_';
export const DEVICE_CREDENTIAL_PREFIX = 'nvc_';
/**
 * The management token novad generates. Its own prefix, so it is never mistaken for Nova's MCP
 * client tokens (`nvm_`); novad refuses a stored token without it too (docs/23 §9).
 */
export const MANAGEMENT_TOKEN_PREFIX = 'nvdm_';
export const DEVICE_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEVICE_MISSED_BEATS = 3;
export const DEVICE_ENROLL_TTL_MS = 15 * 60 * 1000;
/** novad discards a stage after 24 h; the Hub marks it expired then too (docs/23 §4.1). */
export const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

const endpointSchema = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((u) => {
    const url = new URL(u);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'the endpoint must be a plain http(s) base URL');

export const novadVersionSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^\d+(\.\d+){0,3}(-[0-9A-Za-z.]+)?$/, 'a version like 0.6.0');

export const registerDeviceSchema = z.object({
  enrollToken: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100),
  endpoint: endpointSchema,
  publicKey: z.string().regex(PUBLIC_KEY_PATTERN, 'a raw Ed25519 public key, base64url'),
  capability: z.record(z.string(), z.unknown()),
  signature: z.string().regex(SIGNATURE_PATTERN, 'an Ed25519 signature, base64url'),
  managementToken: z
    .string()
    .min(20)
    .max(200)
    .refine(
      (t) => t.startsWith(MANAGEMENT_TOKEN_PREFIX),
      `a management token (${MANAGEMENT_TOKEN_PREFIX}…)`,
    ),
  novadVersion: novadVersionSchema,
  protocolVersions: z.array(z.number().int().min(1).max(1000)).min(1).max(16),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceSchema>;

export interface RegisterDeviceResponse {
  deviceId: string;
  /** `nvc_…`, returned once; the Hub keeps its hash. */
  credential: string;
  heartbeatIntervalMs: number;
  protocolVersion: number;
  updateChannel: string;
  /** The update signing key the device pins (FR-148), when the Hub has one configured. */
  updateKey: string | null;
}

const short = z.string().max(500);

export const moduleReportSchema = z.object({
  name: z.string().min(1).max(50),
  version: z.string().max(50),
  state: z.enum(['running', 'stopped', 'backoff', 'disabled']),
  desired: z.boolean().optional(),
  pid: z.number().int().nullable().optional(),
  restarts: z.number().int().min(0).default(0),
  lastExit: short.nullable().optional(),
  disabledReason: short.nullable().optional(),
  startedAt: short.nullable().optional(),
  previousVersion: short.nullable().optional(),
});
export type ModuleReport = z.infer<typeof moduleReportSchema>;

const granteeWire = z.object({ kind: z.string().max(20), id: z.string().max(200) });

/** A decision made on the device (`novad access approve|deny`), reported with a heartbeat. */
export const accessDecisionSchema = z.object({
  id: z.string().min(1).max(100),
  grantee: granteeWire,
  kind: z.enum(['folder', 'mcp']),
  target: z.string().min(1).max(4096),
  access: z.enum(['read', 'write', 'call']),
  status: z.enum(['granted', 'denied']),
  decidedBy: z.string().max(20).nullable().optional(),
  decidedAt: short.nullable().optional(),
  grantId: z.string().max(100).nullable().optional(),
});

export type AccessDecision = z.infer<typeof accessDecisionSchema>;

/** `a.b.c.d/p` with p from 1 to 30 and no host bits set (a /31 or /32 has no broadcast). */
function isLanNetwork(value: string): boolean {
  const [ip, bits, extra] = value.split('/');
  if (extra !== undefined || !ip || !bits || !/^\d{1,2}$/.test(bits) || !isIPv4(ip)) return false;
  const prefix = Number(bits);
  if (prefix < 1 || prefix > 30) return false;
  const n = ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
  return (n & (0xffffffff >>> prefix)) === 0;
}

/**
 * One physical LAN subnet a device reports with its power status (FR-138), for Wake Helper
 * routing. A reported `broadcast` is accepted but never used: the Hub computes it from `network`.
 */
export const deviceLanSubnetSchema = z.object({
  interface: z.string().max(64).optional(),
  network: z
    .string()
    .max(18)
    .refine(isLanNetwork, 'an IPv4 network like 192.168.1.0/24 (/1 to /30)'),
  broadcast: z.string().max(45).optional(),
});
export type DeviceLanSubnet = z.infer<typeof deviceLanSubnetSchema>;

/** The power status a device reports; `lan` is checked, the rest is kept as reported. */
export const devicePowerReportSchema = z
  .object({ lan: z.array(deviceLanSubnetSchema).max(32).optional() })
  .catchall(z.unknown());

export const deviceHeartbeatSchema = z.object({
  novadVersion: novadVersionSchema,
  /**
   * The management endpoint the device serves now (ADR-096 D1): novad sends `https://…` once it
   * holds a device certificate. The Hub takes an https endpoint only for a device holding a live
   * certificate it issued, never moves a device from https back to http, and does not move a
   * plain-HTTP endpoint (nothing would authenticate the new address).
   */
  endpoint: endpointSchema.optional(),
  modules: z.array(moduleReportSchema).max(20).default([]),
  events: z.array(z.record(z.string(), z.unknown())).max(500).default([]),
  accessDecisions: z.array(accessDecisionSchema).max(500).default([]),
  power: devicePowerReportSchema.optional(),
});
export type DeviceHeartbeat = z.infer<typeof deviceHeartbeatSchema>;

export const deviceCapabilitiesUpdateSchema = z.object({
  capability: z.record(z.string(), z.unknown()),
  signature: z.string().regex(SIGNATURE_PATTERN, 'an Ed25519 signature, base64url'),
  novadVersion: novadVersionSchema,
});

/** A device-side access request as novad returns it. */
export const wireRequestSchema = z.object({
  id: z.string().min(1).max(100),
  grantee: granteeWire,
  kind: z.enum(['folder', 'mcp']),
  target: z.string().min(1).max(4096),
  access: z.enum(['read', 'write', 'call']),
  reason: z.string().max(500).nullable().optional(),
  status: z.enum(['pending', 'granted', 'denied']),
  grantId: z.string().max(100).nullable().optional(),
  decidedBy: z.string().max(20).nullable().optional(),
});
export type WireRequest = z.infer<typeof wireRequestSchema>;

export const wireStagedSchema = z.object({
  id: z.string().min(1).max(100),
  path: z.string().min(1).max(4096),
  baseSha256: z.string().nullable(),
  newSha256: z.string(),
  size: z.number().int().min(0),
  diff: z.string(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  binary: z.boolean(),
  diffTruncated: z.boolean().optional(),
});

/** The highest protocol version both sides speak; `capability_missing` naming both otherwise. */
export function negotiateDeviceProtocol(offered: readonly number[]): number {
  const common = offered.filter((v) => DEVICE_PROTOCOL_VERSIONS.includes(v));
  if (common.length === 0) {
    throw new NovaError('capability_missing', 'no device protocol version in common', {
      details: { hub: [...DEVICE_PROTOCOL_VERSIONS], device: [...offered] },
    });
  }
  return Math.max(...common);
}
