// Paths, words and pure helpers for out-of-band management (FR-147; docs/23 §7; ADR-096 D6): what
// each BMC kind, action, status, power state, boot target and BIOS setting is called, what an
// action will change (said before it is asked for), how a result reads, and every refusal the Hub
// answers in plain words.
import type {
  OobAction,
  OobActionError,
  OobActionStatus,
  OobActionView,
  OobBiosKey,
  OobBiosPlanView,
  OobBiosReadView,
  OobBiosRefusal,
  OobBootTarget,
  OobEndpointView,
  OobKind,
  OobPowerState,
  OobSensorView,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import type { ChipTone } from '../devices/format.ts';
import type { IconName } from '@nova/ui';

const enc = encodeURIComponent;

// ---- paths -------------------------------------------------------------------------------------

/** The out-of-band page lives under Devices: /devices/oob, like /devices/add. */
export const OOB_ID = 'oob';
export const OOB_PATH = `/devices/${OOB_ID}`;

/** One BMC's page: /devices/oob/<endpointId>. */
export function oobEndpointPath(endpointId: string, action?: OobAction): string {
  const base = `${OOB_PATH}/${enc(endpointId)}`;
  return action ? `${base}?action=${action}` : base;
}

/**
 * A device's out-of-band tab, on one of its BMCs: /devices/<deviceId>/oob/<endpointId>, with
 * `?action=power.cycle` to open that action's confirmation (the boot area's failed-boot alert).
 */
export function deviceOobPath(deviceId: string, endpointId?: string, action?: OobAction): string {
  const base = `/devices/${enc(deviceId)}/oob${endpointId ? `/${enc(endpointId)}` : ''}`;
  return action ? `${base}?action=${action}` : base;
}

const ACTION_SET = new Set<string>([
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
]);

export interface OobLocation {
  /** The device whose page this is, or null on the out-of-band page. */
  deviceId: string | null;
  /** The BMC named in the path, or null. */
  endpointId: string | null;
  /** `?action=`: the action whose confirmation opens (never one that runs by itself). */
  action: OobAction | null;
}

/**
 * The out-of-band part of a location: `/devices/oob[/<endpointId>]` or
 * `/devices/<deviceId>/oob[/<endpointId>]`, each with an optional `?action=`; null otherwise.
 */
export function parseOobLocation(loc: string): OobLocation | null {
  const q = loc.indexOf('?');
  const path = q < 0 ? loc : loc.slice(0, q);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'devices') return null;
  const raw = new URLSearchParams(q < 0 ? '' : loc.slice(q + 1)).get('action') ?? '';
  const action = ACTION_SET.has(raw) ? (raw as OobAction) : null;
  if (parts[1] === OOB_ID) return { deviceId: null, endpointId: parts[2] ?? null, action };
  if (parts[1] && parts[2] === OOB_ID)
    return { deviceId: parts[1], endpointId: parts[3] ?? null, action };
  return null;
}

// ---- words -------------------------------------------------------------------------------------

export const KIND_LABEL: Record<OobKind, string> = {
  redfish: 'Redfish',
  ipmi: 'IPMI',
  amt: 'Intel AMT',
};

export const KIND_HELP: Record<OobKind, string> = {
  redfish:
    'Most current server BMCs (iDRAC, iLO, XClarity and others). Over HTTPS, with the BMC certificate pinned.',
  ipmi: 'Older BMCs, through ipmitool on the Hub. Power, sensors and next boot; no BIOS settings.',
  amt: 'Not available in this version.',
};

export const DEFAULT_PORT: Record<OobKind, number> = { redfish: 443, ipmi: 623, amt: 16993 };

export const ACTION_LABEL: Record<OobAction, string> = {
  check: 'Check the connection',
  'power.status': 'Power status',
  'power.on': 'Power on',
  'power.off': 'Power off',
  'power.cycle': 'Power cycle',
  'power.reset': 'Reset',
  sensors: 'Read the sensors',
  'bios.read': 'Read the BIOS settings',
  'bios.plan': 'BIOS change plan',
  'bios.apply': 'Apply a BIOS change',
  'boot.next': 'Next boot',
};

/** The power actions that change something, in button order. */
export const POWER_ACTIONS = ['power.on', 'power.off', 'power.cycle', 'power.reset'] as const;
export type OobPowerAction = (typeof POWER_ACTIONS)[number];

/** What a power action does, said in its confirmation. */
export const POWER_EFFECT: Record<OobPowerAction, string> = {
  'power.on': 'The BMC turns the machine on.',
  'power.off':
    'The BMC cuts the power at once (a hard power off). The operating system does not shut down first, and unsaved work on the machine is lost.',
  'power.cycle':
    'The BMC turns the machine off and on again at once. The operating system does not shut down first, and unsaved work on the machine is lost.',
  'power.reset':
    'The BMC restarts the machine at once (a hard reset). The operating system does not shut down first, and unsaved work on the machine is lost.',
};

export const POWER_TEXT: Record<OobPowerState, string> = {
  on: 'On',
  off: 'Off',
  powering_on: 'Powering on',
  powering_off: 'Powering off',
  unknown: 'Unknown',
};

export const BOOT_TARGET_LABEL: Record<OobBootTarget, string> = {
  pxe: 'Network (PXE)',
  disk: 'Hard disk',
  cdrom: 'CD or DVD',
  bios: 'BIOS setup',
  usb: 'USB drive',
};

export const BIOS_KEY_LABEL: Record<OobBiosKey, string> = {
  wol: 'Wake-on-LAN',
  powerOnAfterPowerLoss: 'Power on after power loss',
  bootOrder: 'Boot order',
  virtualization: 'Virtualization',
  secureBoot: 'Secure Boot',
  tpm: 'TPM',
  fanProfile: 'Fan profile',
};

export const BIOS_REFUSAL_TEXT: Record<OobBiosRefusal, string> = {
  unsupported: 'this BMC does not offer it',
  read_only: 'it is read-only',
  not_allowed_value: 'that value is not allowed',
  security_degrading: 'it weakens security and needs the separate override',
  unchanged: 'it already has that value',
};

export const STATUS_CHIP: Record<
  OobActionStatus,
  { text: string; tone: ChipTone; icon: IconName | null }
> = {
  awaiting_approval: { text: 'Waiting for your approval', tone: 'needs_input', icon: 'hand' },
  approved: { text: 'Approved: ready to apply', tone: 'needs_input', icon: 'check' },
  running: { text: 'Running', tone: 'running', icon: null },
  done: { text: 'Done', tone: 'ready', icon: 'check' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
  denied: { text: 'Denied', tone: 'neutral', icon: 'stop' },
  expired: { text: 'Expired', tone: 'neutral', icon: 'clock' },
  applied: { text: 'Applied', tone: 'ready', icon: 'check' },
};

export const SENSOR_KIND_LABEL: Record<OobSensorView['kind'], string> = {
  temperature: 'Temperature',
  fan: 'Fan',
  voltage: 'Voltage',
  power: 'Power',
  other: 'Other',
};

export const HEALTH_TEXT: Record<OobSensorView['health'], string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

/** "redfish.example:8443" or "10.0.0.20". */
export function addressText(ep: Pick<OobEndpointView, 'address' | 'port' | 'kind'>): string {
  const host = ep.address.includes(':') ? `[${ep.address}]` : ep.address;
  return ep.port ? `${host}:${ep.port}` : `${host} (port ${DEFAULT_PORT[ep.kind]})`;
}

/** "ab12 cd34 … 9f0e": the start and end of a SHA-256 fingerprint, for reading aloud. */
export function shortPin(pin: string): string {
  const groups = pin.match(/.{1,4}/g) ?? [];
  return groups.length > 4
    ? `${groups.slice(0, 2).join(' ')} … ${groups.slice(-2).join(' ')}`
    : pin;
}

/** The whole fingerprint in colon-separated pairs, as BMC pages usually show it. */
export function pinPairs(pin: string): string {
  return (pin.match(/.{1,2}/g) ?? []).join(':').toUpperCase();
}

/** A fingerprint as typed: 64 hex digits, colons and spaces allowed; null when it is not one. */
export function normalizePin(text: string): string | null {
  const v = text.replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** What one setting's value reads as. */
export function valueText(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? 'not set' : v;
}

// ---- results -----------------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function power(v: unknown): string | null {
  const s = rec(v).powerState;
  return typeof s === 'string' && s in POWER_TEXT ? POWER_TEXT[s as OobPowerState] : null;
}

/** The power state an action's result reports, if any. */
export function powerOf(a: Pick<OobActionView, 'result'>): OobPowerState | null {
  const r = rec(a.result);
  const s = r.powerState ?? rec(r.after).powerState;
  return typeof s === 'string' && s in POWER_TEXT ? (s as OobPowerState) : null;
}

export function sensorsOf(a: Pick<OobActionView, 'result'>): OobSensorView[] {
  const s = rec(a.result).sensors;
  return Array.isArray(s) ? (s as OobSensorView[]) : [];
}

export function biosReadOf(a: Pick<OobActionView, 'result'>): OobBiosReadView | null {
  const r = rec(a.result);
  return typeof r.supported === 'boolean' && Array.isArray(r.settings)
    ? (r as unknown as OobBiosReadView)
    : null;
}

/** The plan a `bios.plan` action holds (its diff, refusals and snapshot). */
export function planOf(a: Pick<OobActionView, 'action' | 'result'>): OobBiosPlanView | null {
  if (a.action !== 'bios.plan') return null;
  const r = rec(a.result);
  return Array.isArray(r.diff) && typeof r.planId === 'string'
    ? (r as unknown as OobBiosPlanView)
    : null;
}

/** "Hard disk once (UEFI)". */
export function bootText(params: Record<string, unknown>): string {
  const t = params.target;
  const m = params.mode;
  const target =
    typeof t === 'string' && t in BOOT_TARGET_LABEL
      ? BOOT_TARGET_LABEL[t as OobBootTarget]
      : 'the chosen device';
  return `${target} once${m === 'uefi' ? ' (UEFI)' : m === 'legacy' ? ' (Legacy)' : ''}`;
}

/** One line on what an action asked for and what came of it. */
export function actionSummary(a: OobActionView): string | null {
  const r = rec(a.result);
  switch (a.action) {
    case 'check': {
      if (a.status !== 'done') return null;
      if (r.protocol === 'ipmi')
        return `IPMI answered; power ${power(r)?.toLowerCase() ?? 'unknown'}.`;
      const product = [r.vendor, r.product].filter((x) => typeof x === 'string').join(' ');
      const version = typeof r.redfishVersion === 'string' ? ` ${r.redfishVersion}` : '';
      const answered = `Redfish${version} answered${product ? ` (${product})` : ''}.`;
      return r.authenticated === false
        ? `${answered} Its certificate waits for your confirmation; no credentials were sent.`
        : answered;
    }
    case 'power.status': {
      const p = powerOf(a);
      return p ? `Power: ${POWER_TEXT[p].toLowerCase()}.` : null;
    }
    case 'power.on':
    case 'power.off':
    case 'power.cycle':
    case 'power.reset': {
      const before = power(r.before ?? a.before);
      const after = power(r.after ?? a.after);
      return before || after
        ? `Power ${before?.toLowerCase() ?? 'unknown'} → ${after?.toLowerCase() ?? 'unknown'}.`
        : null;
    }
    case 'sensors':
      return a.status === 'done' ? `${sensorsOf(a).length} readings.` : null;
    case 'bios.read': {
      const b = biosReadOf(a);
      if (!b) return null;
      return b.supported
        ? `${b.settings.length} allowlisted settings (${b.vendor ?? 'unknown vendor'}).`
        : `Not supported: ${b.reason ?? 'unknown hardware'}.`;
    }
    case 'bios.plan': {
      const p = planOf(a);
      if (!p) return null;
      return p.diff
        .map(
          (d) =>
            `${BIOS_KEY_LABEL[d.key]}: ${valueText(d.from)} → ${d.to}${d.securityDegrading ? ' (weakens security)' : ''}`,
        )
        .join('; ');
    }
    case 'bios.apply': {
      const applied = Array.isArray(r.applied) ? (r.applied as Record<string, unknown>[]) : [];
      return applied.length
        ? `Pending for the next restart: ${applied
            .map(
              (x) =>
                `${typeof x.key === 'string' && x.key in BIOS_KEY_LABEL ? BIOS_KEY_LABEL[x.key as OobBiosKey] : String(x.key)} → ${String(x.to)}`,
            )
            .join(', ')}.`
        : null;
    }
    case 'boot.next':
      return `${bootText(a.params)}.`;
    default:
      return null;
  }
}

// ---- refusals ------------------------------------------------------------------------------------

const REASON_TEXT: Record<string, string> = {
  owner_only: 'Only the owner of this Hub can use out-of-band management.',
  oob_disabled: 'Out-of-band management is off. Turn it on first.',
  consent_required: 'Turning on out-of-band management needs your explicit consent.',
  managed: 'Your organization’s policy sets out-of-band management; it cannot be changed here.',
  not_built: 'Intel AMT is not available in this version. Use the machine’s Redfish or IPMI BMC.',
  not_supported_by_ipmi:
    'IPMI cannot do that. BIOS settings and a one-time USB boot need the BMC’s Redfish address.',
  ipmitool_missing:
    'ipmitool is not installed on the Hub, so IPMI BMCs cannot be reached. Install it on the Hub, or use Redfish.',
  tls_pin_mismatch:
    'The BMC presented a different certificate than the one pinned, so nothing was sent to it. If you replaced its certificate on purpose, re-pin it.',
  pin_unconfirmed:
    'Confirm the BMC’s certificate first: the Hub sends it no credentials before that. Check the connection, then compare and confirm the fingerprint.',
  no_pin: 'Check the connection first: that reads the BMC’s certificate.',
  pin_changed:
    'The BMC now presents another certificate than the one shown. Check the connection again and compare the new fingerprint.',
  bmc_unreachable: 'The BMC did not answer. Check its address and that the Hub can reach it.',
  bmc_timeout: 'The BMC did not answer in time.',
  bmc_tls_failed: 'The secure connection to the BMC failed.',
  bmc_no_certificate: 'The BMC presented no certificate.',
  bmc_too_large: 'The BMC’s answer was too large.',
  bmc_auth_failed: 'The BMC refused the user name or password. Enter the credentials again.',
  bmc_session_failed:
    'The BMC refused the IPMI session: it cannot be reached, or the credentials are wrong.',
  bmc_not_found: 'The BMC does not offer that.',
  bmc_precondition_failed: 'The settings changed on the BMC in the meantime. Try again.',
  bmc_refused: 'The BMC refused the request.',
  bmc_error: 'The BMC reported an error.',
  redirect_refused:
    'The BMC answered with a redirect, which Nova never follows. Enter the address the BMC serves itself.',
  not_redfish: 'That address does not answer as Redfish. Check it, or add the BMC as IPMI.',
  bad_response: 'The BMC gave an answer Nova cannot use.',
  no_system: 'The BMC lists no system to manage.',
  system_not_found: 'The BMC has no system with that id. Check the system id.',
  unsupported_by_bmc: 'This BMC does not offer that action.',
  unsupported_hardware: 'BIOS settings are not supported on this hardware through its BMC.',
  firmware_changes_off:
    'BIOS and firmware changes are off. Turn on “Allow BIOS/firmware changes” in Settings → Devices first.',
  security_degrading:
    'This change weakens security (Secure Boot or the TPM) and needs the separate override, which is off.',
  nothing_to_change: 'Nothing to change: every chosen value is already set or not allowed.',
  plan_used: 'This plan was already applied. Make a new plan to change more.',
  plan_expired: 'The approval of this plan ran out. Make the plan again.',
  base_mismatch: 'The BIOS settings changed since the plan. Make the plan again.',
  credentials_missing: 'The Hub has no credentials for this BMC. Enter them again.',
  credentials_in_address:
    'Put the user name and password in their own fields, never in the address.',
  bad_address:
    'Enter a host name or an IP address in the usual dotted form. For Redfish, an https:// address with a port also works.',
  unknown_device: 'That device is not on this Hub.',
  plan_target_changed: 'The BMC was edited since this plan was approved. Make the plan again.',
  plan_failed:
    'Applying this plan failed earlier, so it cannot be used again. Read the BIOS settings and plan again.',
  apply_outcome_unknown:
    'The BMC may have taken part of the change before it failed. Read the BIOS settings to see what is pending, then plan again.',
  approval_not_by_user: 'Only your own answer in Nova runs an out-of-band action.',
  endpoint_changed: 'The BMC was edited, so its waiting approvals were withdrawn.',
  approval_denied: 'You denied it.',
  approval_expired: 'Nobody answered the approval in time.',
  approval_cancelled: 'The approval was withdrawn.',
  approval_mismatch: 'The approval did not cover this action, so it did not run.',
  endpoint_deleted: 'The BMC was removed.',
  interrupted: 'The Hub restarted during the action; it was not run again.',
};

const ADDRESS_KIND: Record<string, string> = {
  loopback: 'a loopback address (the Hub itself)',
  link_local: 'a link-local address',
  multicast: 'a multicast address',
  unspecified: 'not a usable address',
  broadcast: 'a broadcast address',
  reserved: 'a reserved address',
};

const CODE_TEXT: Record<string, string> = {
  oob_disabled: REASON_TEXT.oob_disabled!,
  firmware_disabled: REASON_TEXT.firmware_changes_off!,
  approval_required: 'This plan needs your approval first.',
  not_found: 'That BMC or action is no longer on this Hub.',
  rate_limited: 'Too many requests. Try again in a minute.',
};

function reasonText(reason: string | null, details: Record<string, unknown> = {}): string | null {
  if (!reason) return null;
  if (reason === 'address_not_allowed') {
    const kind = typeof details.kind === 'string' ? details.kind : '';
    return kind === 'hub'
      ? 'That is one of the Hub’s own addresses. A BMC is another machine on the network.'
      : `That is ${ADDRESS_KIND[kind] ?? 'an address a BMC cannot have'}. Enter the BMC’s own address on the network.`;
  }
  if (reason === 'system_ambiguous') {
    const systems = Array.isArray(details.systems) ? details.systems.join(', ') : '';
    return `This BMC manages several systems. Enter the system id to use${systems ? ` (it lists ${systems})` : ''}.`;
  }
  return REASON_TEXT[reason] ?? null;
}

/** A Hub refusal about out-of-band management, in plain words. */
export function oobErrorMessage(err: unknown, fallback = 'That did not work.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const details = err.body.details ?? {};
  const reason = typeof details.reason === 'string' ? details.reason : null;
  return (
    reasonText(reason, details) ??
    CODE_TEXT[err.body.code] ??
    // Validation messages are the Hub's own sentences ("the address and the port name …").
    (err.body.code === 'validation' && err.body.message
      ? `${err.body.message.charAt(0).toUpperCase()}${err.body.message.slice(1)}.`.replace(
          /\.\.$/,
          '.',
        )
      : fallback)
  );
}

/** Why a recorded action failed or ended, in plain words. */
export function actionErrorText(e: OobActionError): string {
  return (
    reasonText(e.reason) ??
    CODE_TEXT[e.code] ??
    (e.message ? `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}` : 'It failed.')
  );
}

/**
 * The action (newest first) that last failed on a pin mismatch, unless a later one got through or
 * the pin was changed or cleared since.
 */
export function pinMismatch(
  ep: Pick<OobEndpointView, 'tlsPin' | 'tlsPinnedAt'>,
  actions: readonly OobActionView[],
): OobActionView | null {
  if (!ep.tlsPin) return null;
  for (const a of actions) {
    if (a.status === 'done') return null;
    if (a.status === 'failed' && a.error?.reason === 'tls_pin_mismatch')
      return ep.tlsPinnedAt && a.createdAt < ep.tlsPinnedAt ? null : a;
  }
  return null;
}

/** Actions waiting for the owner: an approval card, or an approved plan to apply. */
export function openActions(actions: readonly OobActionView[]): OobActionView[] {
  return actions.filter((a) => a.status === 'awaiting_approval' || a.status === 'approved');
}
