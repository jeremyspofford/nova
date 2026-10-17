// M6 devices API shapes (owned by the devices area; the web reads them). Devices running `novad`
// (docs/23): capability documents and overrides (FR-142, FR-150), modules and services (FR-141,
// FR-145), power and Wake-on-LAN (FR-144), signed updates (FR-148), device file operations with
// staged writes and folder-access requests (FR-210), and an agent's connected computer (FR-081).
import { z } from 'zod';
import { idSchema } from '../api.ts';

export const DEVICE_MODULES = [
  'management',
  'compute',
  'browser',
  'screen',
  'storage',
  'capture',
] as const;
export type DeviceModuleName = (typeof DEVICE_MODULES)[number];

export const DEVICE_UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type DeviceUpdateChannel = (typeof DEVICE_UPDATE_CHANNELS)[number];

/** Roles a `novad` device can enroll with (the Hub role is not enrolled this way). */
export const DEVICE_ENROLL_ROLES = ['client', 'compute', 'wake-helper'] as const;

/**
 * What a Hub session can use on a device. Each needs a module and a minimum `novad` version
 * (FR-148): a device below it is refused that capability and keeps its others.
 */
export const DEVICE_CAPABILITIES = [
  'files',
  'staged_writes',
  'exec',
  'mcp',
  'power',
  'services',
  'updates',
  'computer_use',
  'browser',
  'capture',
] as const;
export type DeviceCapabilityName = (typeof DEVICE_CAPABILITIES)[number];

/** Who a grant or a staged write belongs to on the device. */
export const DEVICE_GRANTEE_KINDS = ['user', 'agent', 'session', 'run', 'thread'] as const;
export const deviceGranteeSchema = z
  .object({
    kind: z.enum(DEVICE_GRANTEE_KINDS),
    id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\p{Cc}]+$/u, 'printable characters only'),
  })
  .strict();
export type DeviceGrantee = z.infer<typeof deviceGranteeSchema>;

/** An absolute path on the device, without `.`/`..` segments or NUL bytes. */
export const devicePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.includes('\0') &&
      (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) &&
      !p.split(/[\\/]/).some((s) => s === '.' || s === '..'),
    'an absolute path with no . or .. segments',
  );

const quietRange = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM-HH:MM');
const nonNegInt = z.number().int().min(0);

/** The Advanced capability overrides (FR-142); detected facts cannot be overridden. */
export const deviceCapabilityOverridesSchema = z
  .object({
    models: z
      .object({
        storagePaths: z.array(devicePathSchema).max(20),
        cacheQuotaBytes: nonNegInt,
      })
      .partial()
      .strict(),
    computePolicy: z
      .object({
        gpuSharing: z.enum(['exclusive', 'shared']),
        vramReserveBytes: nonNegInt,
        maxConcurrentJobs: nonNegInt,
        maxJobDurationSec: z.number().int().min(1),
      })
      .partial()
      .strict(),
    scheduling: z
      .object({
        quietHours: z.array(quietRange).max(10),
        routingWeight: z.number().min(0).max(1000),
        energyPriceTier: z.string().min(1).max(100),
      })
      .partial()
      .strict(),
    limits: z
      .object({ maxEgressMbps: z.number().min(0).max(100_000) })
      .partial()
      .strict(),
    power: z
      .object({
        policy: z.string().min(1).max(100),
        thermalLimitC: z.number().int().min(30).max(120),
      })
      .partial()
      .strict(),
    locale: z
      .object({ locale: z.string().min(1).max(100) })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type DeviceCapabilityOverrides = z.infer<typeof deviceCapabilityOverridesSchema>;

/** Per-device policy the Hub applies (FR-150). */
export const devicePolicySchema = z
  .object({
    /** False keeps the device out of routing (its models and computer). */
    routingEligible: z.boolean(),
    /** Modules the device may run; null allows all installed ones. */
    allowedModules: z.array(z.enum(DEVICE_MODULES)).max(DEVICE_MODULES.length).nullable(),
    resourceCaps: z
      .object({
        memoryBytes: z
          .number()
          .int()
          .min(64 * 1024 * 1024),
        cpuSeconds: z.number().int().min(1),
        openFiles: z.number().int().min(16).max(1_048_576),
      })
      .partial()
      .strict(),
    quietHours: z.array(quietRange).max(10),
  })
  .partial()
  .strict();
export type DevicePolicy = z.infer<typeof devicePolicySchema>;

export const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    capabilityOverrides: deviceCapabilityOverridesSchema,
    policy: devicePolicySchema,
    updateChannel: z.enum(DEVICE_UPDATE_CHANNELS),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateDeviceRequest = z.infer<typeof updateDeviceSchema>;

export const enrollDeviceSchema = z
  .object({
    roles: z.array(z.enum(DEVICE_ENROLL_ROLES)).min(1).max(3).default(['client']),
  })
  .strict();

export interface DeviceEnrollToken {
  /** `nvd_…`, shown once; one use, 15 minutes. */
  token: string;
  expiresAt: string;
  /** The command to run on the device. */
  command: string;
}

export interface DeviceModuleView {
  name: string;
  version: string;
  state: 'running' | 'stopped' | 'backoff' | 'disabled';
  pid: number | null;
  restarts: number;
  lastExit: string | null;
  disabledReason: string | null;
  startedAt: string | null;
  previousVersion: string | null;
}

export interface DeviceCapabilityStatus {
  name: DeviceCapabilityName;
  module: DeviceModuleName;
  minVersion: string;
  available: boolean;
  /** Why not: `update_required`, `module_missing` or `module_not_allowed`. */
  reason: 'update_required' | 'module_missing' | 'module_not_allowed' | null;
}

export interface DeviceView {
  id: string;
  name: string;
  roles: string[];
  status: 'pending' | 'active' | 'unreachable' | 'revoked';
  platform: string | null;
  novadVersion: string | null;
  updateChannel: DeviceUpdateChannel;
  endpoint: string | null;
  /** The device's last signed capability document. */
  capability: Record<string, unknown> | null;
  capabilities: DeviceCapabilityStatus[];
  /** Some capability needs a newer `novad` (FR-148): Devices shows "Update required". */
  updateRequired: boolean;
  capabilityOverrides: DeviceCapabilityOverrides;
  policy: DevicePolicy;
  /** Overrides or policy changed on the Hub and the device has not taken them yet. */
  configPending: boolean;
  routingEligible: boolean;
  modules: DeviceModuleView[];
  wake: { wakeable: boolean; macs: string[] };
  lastSeenAt: string | null;
  createdAt: string;
}

export const DEVICE_SERVICE_ACTIONS = ['start', 'stop', 'restart', 'status'] as const;
export const DEVICE_MODULE_ACTIONS = ['start', 'stop', 'restart', 'rollback'] as const;

export const devicePowerSchema = z
  .object({
    action: z.enum(['status', 'wol-plan', 'wol-enable', 'sleep', 'restart', 'shutdown']),
    /** WoL changes are planned unless this is set (and the device allows them, with elevation). */
    apply: z.boolean().optional(),
  })
  .strict();

export interface DeviceWakeView {
  id: string;
  deviceId: string;
  mac: string;
  status: 'sent' | 'failed' | 'rate_limited';
  createdAt: string;
}

export const deviceUpdateBundleSchema = z
  .object({
    manifest: z
      .object({
        target: z.string().min(1).max(50),
        version: z
          .string()
          .min(1)
          .max(50)
          .regex(/^\d+(\.\d+){0,3}(-[0-9A-Za-z.]+)?$/),
        channel: z.enum(DEVICE_UPDATE_CHANNELS),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z
          .number()
          .int()
          .min(0)
          .max(64 * 1024 * 1024),
      })
      .strict(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'an Ed25519 signature, base64url'),
    /** Standard base64 of the payload. */
    payload: z.string().max(90 * 1024 * 1024),
  })
  .strict();
export type DeviceUpdateBundle = z.infer<typeof deviceUpdateBundleSchema>;

/** Bundles apply in order; a `novad` bundle goes last (the supervisor updates itself last). */
export const pushDeviceUpdatesSchema = z
  .object({ bundles: z.array(deviceUpdateBundleSchema).min(1).max(10) })
  .strict();

export interface DeviceUpdateView {
  id: string;
  deviceId: string;
  target: string;
  fromVersion: string | null;
  toVersion: string;
  channel: DeviceUpdateChannel;
  status: 'applied' | 'rolled_back' | 'staged' | 'refused' | 'failed';
  detail: string | null;
  createdAt: string;
}

export interface DeviceDirent {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
}

export const deviceAccessRequestSchema = z
  .object({
    path: devicePathSchema,
    access: z.enum(['read', 'write']).default('read'),
    reason: z.string().max(500).optional(),
    /** Who the folder is for; the signed-in user when omitted (granted at once). */
    grantee: deviceGranteeSchema.optional(),
  })
  .strict();

export const deviceGrantSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('folder'),
      grantee: deviceGranteeSchema,
      path: devicePathSchema,
      access: z.enum(['read', 'write']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp'),
      grantee: deviceGranteeSchema,
      server: z.string().min(1).max(100),
    })
    .strict(),
]);

export interface DeviceAccessRequestView {
  id: string;
  deviceId: string;
  grantee: DeviceGrantee;
  kind: 'folder' | 'mcp';
  target: string;
  access: 'read' | 'write' | 'call';
  reason: string | null;
  status: 'pending' | 'granted' | 'denied' | 'revoked';
  /** The Hub approval card for it, while it waits. */
  approvalId: string | null;
  decidedBy: 'device' | 'hub' | null;
  createdAt: string;
  decidedAt: string | null;
}

export const stageDeviceWriteSchema = z
  .object({
    path: devicePathSchema,
    /** UTF-8 text, or `contentBase64` for bytes (one of them). */
    content: z
      .string()
      .max(10 * 1024 * 1024)
      .optional(),
    contentBase64: z
      .string()
      .max(14 * 1024 * 1024)
      .optional(),
    baseSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    createDirs: z.boolean().optional(),
    grantee: deviceGranteeSchema.optional(),
    sessionRef: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.content === undefined) !== (v.contentBase64 === undefined), {
    message: 'send content or contentBase64',
  });
export type StageDeviceWriteRequest = z.infer<typeof stageDeviceWriteSchema>;

export interface StagedWriteView {
  id: string;
  deviceId: string;
  grantee: DeviceGrantee;
  sessionRef: string;
  path: string;
  baseSha256: string | null;
  newSha256: string;
  size: number;
  /** Unified diff (text files), or a one-line summary for binary content. */
  diff: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: 'staged' | 'committed' | 'discarded' | 'conflict' | 'expired' | 'failed';
  error: string | null;
  createdAt: string;
  committedAt: string | null;
}

export const DEVICE_CONNECTION_CAPABILITIES = [
  'files',
  'staged_writes',
  'exec',
  'mcp',
  'computer_use',
  'browser',
] as const;

/** Connect a device to an agent as its computer (FR-081): explicit, one at a time. */
export const connectAgentDeviceSchema = z
  .object({
    agentId: idSchema,
    deviceId: idSchema,
    capabilities: z
      .array(z.enum(DEVICE_CONNECTION_CAPABILITIES))
      .min(1)
      .max(DEVICE_CONNECTION_CAPABILITIES.length)
      .default(['files', 'staged_writes', 'exec']),
    /** Replace the agent's current connection instead of refusing with `conflict`. */
    replace: z.boolean().optional(),
  })
  .strict();

export interface AgentDeviceConnectionView {
  id: string;
  agentId: string;
  deviceId: string;
  deviceName: string;
  capabilities: (typeof DEVICE_CONNECTION_CAPABILITIES)[number][];
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
}

export const deviceMcpCallSchema = z
  .object({
    server: z.string().min(1).max(100),
    tool: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).default({}),
    grantee: deviceGranteeSchema.optional(),
  })
  .strict();
