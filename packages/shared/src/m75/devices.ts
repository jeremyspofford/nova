// M7.5 device operations (ADR-096 D1, D3, D9; FR-126, FR-142, FR-145, FR-148, FR-150): the
// management channel over mutual TLS, the device-side policy a heartbeat answer carries,
// decommissioning a novad device, the device routes the M6 UI lacked (managed services,
// available updates, owner overrides) and the compute-node leftovers (VRAM, quiet hours and the
// node's managed services).
import { z } from 'zod';

// ---- D1: the Hub -> novad management channel -----------------------------------------------

/**
 * How the Hub reaches a device's management endpoint: `mutual_tls` (an https endpoint; the Hub
 * presents its client certificate and verifies the device's by chain and URI SAN) or `plain_http`
 * (a device without a certificate, as before M7.5). A device that registered https is never
 * called over plain HTTP.
 */
export const DEVICE_MANAGEMENT_CHANNELS = ['mutual_tls', 'plain_http'] as const;
export type DeviceManagementChannel = (typeof DEVICE_MANAGEMENT_CHANNELS)[number];

/**
 * Why a management call over mutual TLS failed (`policy_denied` `{reason: device_tls_failed,
 * tls}`): the Hub has no local CA or no client certificate, the device's certificate does not
 * chain to the Hub CA, is expired or not yet valid, names another device, carries another key
 * than the one the Hub pinned, is revoked or unknown to the Hub, is not usable for a server, or
 * the handshake failed (the device refused the Hub's certificate).
 */
export const DEVICE_TLS_FAILURES = [
  'no_ca',
  'no_client_certificate',
  'untrusted_certificate',
  'expired',
  'not_yet_valid',
  'wrong_device',
  'key_mismatch',
  'revoked',
  'unknown_certificate',
  'unsupported_purpose',
  'handshake_failed',
] as const;
export type DeviceTlsFailure = (typeof DEVICE_TLS_FAILURES)[number];

/**
 * A device certificate's renewal (D1): `offered` (a fresh certificate is in the heartbeat answers
 * until the device presents it), `presented` (the device uses the renewed one; the old one is
 * revoked) or `none`. Renewed because the certificate lacked serverAuth (issued before M7.5) or
 * had less than a third of its life left.
 */
export const DEVICE_RENEWAL_STATES = ['none', 'offered', 'presented'] as const;
export type DeviceRenewalState = (typeof DEVICE_RENEWAL_STATES)[number];

export interface DeviceCertificateRenewalView {
  state: DeviceRenewalState;
  /** When the renewed certificate was issued; null for `none`. */
  offeredAt: string | null;
  /** The renewed certificate's end of validity; null for `none`. */
  notAfter: string | null;
  reason: 'missing_server_auth' | 'expiring' | null;
}

/** What the Hub knows about a device's certificate for the management channel (D1). */
export interface DeviceCertificateStateView {
  /** Null when the device holds no live certificate of the Hub CA. */
  renewal: DeviceCertificateRenewalView | null;
  /** The certificate the device uses now lacks serverAuth (issued before M7.5). */
  legacyCertificate: boolean;
  /**
   * When the Hub stops accepting that legacy certificate on the management channel (the renewal's
   * issue time plus the grace); null while no renewal was offered or the certificate is current.
   */
  legacyGraceEndsAt: string | null;
}

export interface DeviceManagementTlsView extends DeviceCertificateStateView {
  deviceId: string;
  name: string;
  status: 'pending' | 'active' | 'unreachable' | 'revoked';
  endpoint: string | null;
  /** Null for a device without an endpoint. */
  channel: DeviceManagementChannel | null;
  /** The last management call since the Hub started (memory only). */
  lastCall: { ok: boolean; at: string; failure: DeviceTlsFailure | null } | null;
}

/** `GET /api/v1/devices/management-tls`: every novad device's management channel. */
export interface DeviceManagementTlsSummaryView {
  /** The Hub's client certificate for the channel, when it has one. */
  hubClient: { serial: string; notAfter: string; uri: string } | null;
  items: DeviceManagementTlsView[];
  /** Plain sentences, also in diagnostics (`deviceManagement`). */
  problems: string[];
}

// ---- D3: the device-side policy in the heartbeat answer --------------------------------------

/** `policy` in the `/agent/v1/heartbeat` answer; both false unless the owner turned them on. */
export interface DeviceHeartbeatPolicy {
  /** `devices.firmware.allowChanges` (FR-146), as the firmware area decides it for the device. */
  firmwareChanges: boolean;
  /** `devices.boot.allowLowLevel` (FR-143), as the boot area decides it for the device. */
  lowLevelBoot: boolean;
}

// ---- D9: decommission --------------------------------------------------------------------------

/** `POST /api/v1/devices/:id/decommission`. */
export const deviceDecommissionSchema = z
  .object({
    /** Also delete the device's Nova data (`novad uninstall --purge`). */
    purge: z.boolean().default(false),
  })
  .strict();
export type DeviceDecommissionRequest = z.infer<typeof deviceDecommissionSchema>;

export const DEVICE_DECOMMISSION_STATUSES = [
  'awaiting_approval',
  'running',
  'done',
  'denied',
  'expired',
  'cancelled',
  'failed',
] as const;
export type DeviceDecommissionStatus = (typeof DEVICE_DECOMMISSION_STATUSES)[number];

/**
 * What the device did: `wiped` (it removed its services and credentials, and its data with
 * purge), `unreachable` (offline: revoked at once, its credentials go at its next contact),
 * `refused` (it answered with an error; revoked anyway) or `not_told` (the Hub could not sign the
 * authorization; revoked anyway).
 */
export const DEVICE_DECOMMISSION_RESULTS = ['wiped', 'unreachable', 'refused', 'not_told'] as const;
export type DeviceDecommissionResult = (typeof DEVICE_DECOMMISSION_RESULTS)[number];

export interface DeviceDecommissionView {
  id: string;
  deviceId: string;
  deviceName: string;
  purge: boolean;
  status: DeviceDecommissionStatus;
  /** The approval card (tier high) the owner answers. */
  approvalId: string | null;
  deviceResult: DeviceDecommissionResult | null;
  /** The device's refusal or the failure, in a sentence. */
  detail: string | null;
  createdAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
}

// ---- managed services, available updates, owner overrides --------------------------------------

/** A service the device owner declared in novad's config (FR-145). */
export interface DeviceServiceView {
  name: string;
  kind: 'module' | 'systemd';
  state: string | null;
  module: string | null;
  unit: string | null;
}

/** `GET /api/v1/devices/:id/updates/available` (FR-148). */
export interface DeviceAvailableUpdateView {
  deviceId: string;
  current: { novad: string | null };
  /** The build platform the device reports (`linux`/`darwin`/`windows`, `amd64`/`arm64`). */
  platform: { os: string; arch: string } | null;
  /** The `novad` build this Hub serves for that platform (the agent-dist manifest), if any. */
  novad: { version: string; file: string; sha256: string; size: number } | null;
  newer: boolean;
  /**
   * `newer_available`, `up_to_date`, `no_builds` (the Hub serves none), `no_build_for_platform`,
   * `unknown_platform` or `unknown_version`.
   */
  reason:
    | 'newer_available'
    | 'up_to_date'
    | 'no_builds'
    | 'no_build_for_platform'
    | 'unknown_platform'
    | 'unknown_version';
}

/** `GET /api/v1/devices/:id/overrides` (FR-142, FR-150). */
export interface DeviceOverridesView {
  deviceId: string;
  /** What the owner set on the Hub (PATCH /api/v1/devices/:id). */
  capabilityOverrides: Record<string, unknown>;
  policy: Record<string, unknown>;
  updateChannel: 'stable' | 'beta' | 'nightly';
  configRevision: number;
  pushedRevision: number;
  /** The device has not taken the last change yet. */
  configPending: boolean;
  /**
   * What the device's last signed capability document says for the overridable sections (the
   * device's own detection and local overrides, then the Hub's): what is in force there.
   */
  effective: Record<string, unknown>;
}

// ---- compute nodes (FR-126 leftovers) ------------------------------------------------------------

const quietRange = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM-HH:MM');

function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `now`, read in `timeZone` (UTC when unknown), falls in one of the `HH:MM-HH:MM` ranges
 * (a range may cross midnight; `start == end` is empty). The compute node and the Hub agree on it.
 */
export function quietHoursActive(
  ranges: readonly string[],
  now: Date,
  timeZone?: string | null,
): boolean {
  if (ranges.length === 0) return false;
  let minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
      minutes =
        Number(parts.find((p) => p.type === 'hour')?.value ?? '0') * 60 +
        Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    } catch {
      // An unknown zone: UTC.
    }
  }
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map((x) => Number.parseInt(x, 10));
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return ranges.some((r) => {
    const [a, b] = r.split('-');
    if (!a || !b) return false;
    const start = at(a);
    const end = at(b);
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  });
}

/** The owner's policy for a compute node (FR-150): `PUT /api/v1/devices/:id/node/policy`. */
export const nodePolicySchema = z
  .object({
    quietHours: z.array(quietRange).max(10),
    /** IANA time zone; the node's own zone when null. */
    timeZone: z.string().min(1).max(64).refine(knownTimeZone, 'an IANA time zone').nullable(),
    routingEligible: z.boolean(),
  })
  .partial()
  .strict();
export type NodePolicyInput = z.infer<typeof nodePolicySchema>;

export interface NodePolicy {
  quietHours: string[];
  timeZone: string | null;
  routingEligible: boolean;
  revision: number;
}

/** One GPU's memory as the node last reported it. */
export interface NodeGpuVram {
  index: number;
  vendor: string | null;
  name: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
}

export const NODE_SERVICE_NAMES = ['jobs', 'backend'] as const;
export type NodeServiceName = (typeof NODE_SERVICE_NAMES)[number];
export const NODE_SERVICE_ACTIONS = ['start', 'stop', 'restart', 'status'] as const;
export type NodeServiceAction = (typeof NODE_SERVICE_ACTIONS)[number];

/**
 * A compute node's managed service: `jobs` (its job API: stopped, it takes no new jobs) and
 * `backend` (the model server, when the node manages it through a systemd unit).
 */
export interface NodeServiceView {
  name: NodeServiceName;
  kind: 'builtin' | 'systemd';
  state: 'running' | 'stopped' | 'unknown';
  unit: string | null;
}

/** `GET /api/v1/devices/:id/node`: a compute node's policy and what its heartbeats report. */
export interface NodeDetailView {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'unreachable' | 'revoked';
  policy: NodePolicy;
  /** Whether the node is in its quiet hours now (it takes no new jobs; routing skips it). */
  quietNow: boolean;
  /** The node said so in its last heartbeat. */
  reportedQuiet: boolean | null;
  vram: NodeGpuVram[] | null;
  load: { running: number; queued: number } | null;
  lastSeenAt: string | null;
}
