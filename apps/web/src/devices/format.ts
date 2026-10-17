// Paths, words and pure helpers shared by the Devices views (docs/23; FR-141..FR-150, FR-210,
// FR-081): what each status, capability and module is called, why something is unavailable, how
// a Hub error reads, folder paths on the device, file previews and unified diffs.
import type {
  AddDeviceKind,
  AddDeviceRole,
  DeviceAccessRequestView,
  DeviceCapabilityName,
  DeviceCapabilityStatus,
  DeviceGrantee,
  DeviceModuleName,
  DeviceModuleView,
  DeviceSummaryView,
  DeviceView,
  StagedWriteView,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { plural } from '../settings/common.ts';
import type { DeviceWakeResult } from './api.ts';

const enc = encodeURIComponent;

export const DEVICE_TABS = [
  'capabilities',
  'modules',
  'power',
  'updates',
  'policy',
  'files',
  'agents',
  'mcp',
] as const;
export type DeviceTab = (typeof DEVICE_TABS)[number];

export const DEVICES_PATH = '/devices';
/** The Add a device flow, a page of its own (like /work/scheduled). */
export const DEVICES_ADD_PATH = '/devices/add';
export const ADD_DEVICE_ID = 'add';
/** The one-use command path for scripted installs (M6). */
export const ADD_COMMAND_PATH = `${DEVICES_ADD_PATH}?method=command`;

/** `/devices/add?role=compute`. */
export function addDevicePath(role?: AddDeviceRole): string {
  return role ? `${DEVICES_ADD_PATH}?role=${role}` : DEVICES_ADD_PATH;
}

export function devicePath(id?: string | null, tab?: DeviceTab): string {
  if (!id) return DEVICES_PATH;
  const base = `${DEVICES_PATH}/${enc(id)}`;
  return tab && tab !== 'capabilities' ? `${base}?tab=${tab}` : base;
}

/** The tab a `?tab=` query names, or the first one. */
export function tabFrom(search: string): DeviceTab {
  const t = new URLSearchParams(search).get('tab') ?? '';
  return (DEVICE_TABS as readonly string[]).includes(t) ? (t as DeviceTab) : 'capabilities';
}

// ---- words -------------------------------------------------------------------------------------

export type ChipTone = 'ready' | 'running' | 'needs_input' | 'blocked' | 'neutral';

export const DEVICE_STATUS: Record<
  DeviceView['status'],
  { text: string; tone: ChipTone; icon: 'check' | 'alert' | 'stop' | null }
> = {
  active: { text: 'Online', tone: 'ready', icon: 'check' },
  unreachable: { text: 'Offline', tone: 'needs_input', icon: 'alert' },
  pending: { text: 'Waiting for first contact', tone: 'running', icon: null },
  revoked: { text: 'Revoked', tone: 'blocked', icon: 'stop' },
};

export const ROLE_LABEL: Record<string, string> = {
  hub: 'Hub',
  client: 'Client',
  compute: 'Compute node',
  'wake-helper': 'Wake helper',
};

export function rolesText(roles: readonly string[]): string {
  return roles.length ? roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') : 'No role';
}

// ---- Add Device: roles, scopes and kinds (FR-132, docs/22 §4.2) --------------------------------

export const ROLE_HELP: Record<AddDeviceRole, string> = {
  client: 'A phone, tablet or computer you use Nova on.',
  compute: 'Runs models and other heavy work for this Hub.',
  'wake-helper': 'Always on, on the same network as your other devices, so it can wake them.',
};

/**
 * The scopes each role can be given at add time and later (docs/22 §4.2). They are recorded on the
 * device and shown on its page; folders, the browser and the screen still ask before each use.
 */
export const SCOPES_BY_ROLE: Record<AddDeviceRole, readonly string[]> = {
  client: ['offline-replica', 'local-runtime', 'files', 'browser', 'computer_use'],
  compute: ['exec'],
  'wake-helper': [],
};

export const SCOPE_TEXT: Record<string, { label: string; help: string }> = {
  'offline-replica': {
    label: 'Offline copy',
    help: 'Keeps a copy of your chats and files on the device, to use without the Hub.',
  },
  'local-runtime': {
    label: 'Local models',
    help: 'May run models on the device itself when it has them.',
  },
  files: {
    label: 'Files',
    help: 'Agents may ask for its folders. Each folder is still shared only when you allow it.',
  },
  browser: { label: 'Browser', help: 'Agents may use its browser when you allow it.' },
  computer_use: {
    label: 'Computer use',
    help: 'Agents may use its screen and keyboard when you allow it.',
  },
  exec: { label: 'Commands', help: 'Agents may run commands on it, in a sandbox.' },
};

export function scopeLabel(scope: string): string {
  return SCOPE_TEXT[scope]?.label ?? scope;
}

/** "Offline copy, Files", or "No extra scopes". */
export function scopesText(scopes: readonly string[]): string {
  return scopes.length ? scopes.map(scopeLabel).join(', ') : 'No extra scopes';
}

/** The scopes a device with these roles can have, then any others it already has. */
export function scopeChoices(roles: readonly string[], current: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roles) {
    for (const s of SCOPES_BY_ROLE[r as AddDeviceRole] ?? []) if (!out.includes(s)) out.push(s);
  }
  for (const s of current) if (!out.includes(s)) out.push(s);
  return out;
}

export const JOIN_KIND_LABEL: Record<AddDeviceKind, string> = {
  browser: 'Web browser',
  native: 'Nova app',
  novad: 'novad',
  compute: 'nova-compute',
};

/** What the device runs: "novad 0.7.0", "Web browser", "nova-compute", "This Hub". */
export function runsText(
  d: DeviceSummaryView,
  novad: Pick<DeviceView, 'novadVersion'> | null,
): string {
  if (d.kind === 'hub') return 'This Hub';
  if (novad || d.addedAs === 'novad' || d.novadVersion)
    return (novad?.novadVersion ?? d.novadVersion)
      ? `novad ${novad?.novadVersion ?? d.novadVersion}`
      : 'novad, version unknown';
  if (d.addedAs) return JOIN_KIND_LABEL[d.addedAs];
  return d.kind === 'compute' ? 'nova-compute' : 'Unknown';
}

/** A browser or the app: it signs in with a session instead of being reached by the Hub. */
export function isSessionDevice(d: Pick<DeviceSummaryView, 'addedAs'>): boolean {
  return d.addedAs === 'browser' || d.addedAs === 'native';
}

/** The Wake result in words: through which helper, or by the Hub (FR-138). */
export function wakeSentText(
  name: string,
  w: Pick<DeviceWakeResult, 'mac' | 'via'>,
  helperName: (id: string) => string | null = () => null,
): string {
  if (!w.via) return `Wake signal sent to ${name} (${w.mac}).`;
  if (w.via === 'hub') return `Wake signal sent to ${name} by the Hub.`;
  return `Wake signal sent to ${name} through ${helperName(w.via) ?? 'a Wake helper'}.`;
}

export const CAPABILITY_LABEL: Record<DeviceCapabilityName, string> = {
  files: 'Files',
  staged_writes: 'Staged writes',
  exec: 'Commands',
  mcp: 'Local MCP servers',
  power: 'Power',
  services: 'Services',
  updates: 'Updates',
  computer_use: 'Computer use',
  browser: 'Browser',
  capture: 'Ambient capture',
};

export const MODULE_LABEL: Record<DeviceModuleName, string> = {
  management: 'Management',
  compute: 'Compute',
  browser: 'Browser',
  screen: 'Screen',
  storage: 'Storage',
  capture: 'Capture',
};

export const MODULE_PURPOSE: Record<DeviceModuleName, string> = {
  management: 'Power, services and updates',
  compute: 'Runs models',
  browser: 'Browser automation for agents',
  screen: 'Computer use',
  storage: 'Files, staged writes and local MCP servers',
  capture: 'Ambient capture, with no network access',
};

export function moduleLabel(name: string): string {
  return MODULE_LABEL[name as DeviceModuleName] ?? name;
}

/** Why a capability is not available, in a few words. */
export function capabilityReason(s: DeviceCapabilityStatus): string | null {
  if (s.available || !s.reason) return null;
  if (s.reason === 'update_required') return `Needs novad ${s.minVersion}`;
  if (s.reason === 'module_not_allowed')
    return `${moduleLabel(s.module)} module not allowed by policy`;
  return `No ${moduleLabel(s.module).toLowerCase()} module`;
}

/** "Files, Staged writes, Commands · 2 need an update". */
export function capabilitySummary(d: DeviceView): string {
  const on = d.capabilities.filter((c) => c.available).map((c) => CAPABILITY_LABEL[c.name]);
  const update = d.capabilities.filter((c) => c.reason === 'update_required').length;
  const parts = [on.length ? on.join(', ') : 'No capabilities yet'];
  if (update) parts.push(`${update} ${update === 1 ? 'needs' : 'need'} an update`);
  return parts.join(' · ');
}

export const MODULE_STATE: Record<
  DeviceModuleView['state'],
  { text: string; tone: ChipTone; icon: 'check' | 'alert' | 'stop' | null }
> = {
  running: { text: 'Running', tone: 'ready', icon: 'check' },
  stopped: { text: 'Stopped', tone: 'neutral', icon: 'stop' },
  backoff: { text: 'Restarting after a crash', tone: 'needs_input', icon: 'alert' },
  disabled: { text: 'Disabled', tone: 'blocked', icon: 'stop' },
};

/** A module the supervisor gave up on after repeated crashes. */
export function crashLooped(m: DeviceModuleView): boolean {
  return m.disabledReason === 'crash_loop';
}

export const STAGED_STATUS: Record<
  StagedWriteView['status'],
  { text: string; tone: ChipTone; icon: 'hand' | 'check' | 'alert' | 'stop' | 'clock' }
> = {
  staged: { text: 'Waiting for review', tone: 'needs_input', icon: 'hand' },
  committed: { text: 'Written', tone: 'ready', icon: 'check' },
  discarded: { text: 'Discarded', tone: 'neutral', icon: 'stop' },
  conflict: { text: 'Conflict', tone: 'blocked', icon: 'alert' },
  expired: { text: 'Expired', tone: 'neutral', icon: 'clock' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
};

export const UPDATE_STATUS_TEXT: Record<string, string> = {
  applied: 'Applied',
  staged: 'Staged',
  rolled_back: 'Rolled back',
  refused: 'Refused',
  failed: 'Failed',
};

export const GRANTEE_KIND_LABEL: Record<DeviceGrantee['kind'], string> = {
  user: 'You',
  agent: 'Agent',
  session: 'Code session',
  run: 'Work run',
  thread: 'Chat',
};

/** "You", "Agent Scout", "Work run 0193…". */
export function granteeText(g: DeviceGrantee, agentName?: (id: string) => string | null): string {
  if (g.kind === 'user') return 'You';
  if (g.kind === 'agent') return `Agent ${agentName?.(g.id) ?? g.id}`;
  return `${GRANTEE_KIND_LABEL[g.kind]} ${g.id}`;
}

export function accessText(r: Pick<DeviceAccessRequestView, 'access' | 'kind'>): string {
  if (r.kind === 'mcp') return 'Can call its tools';
  return r.access === 'write' ? 'Read and change' : 'Read only';
}

// ---- why something is unavailable --------------------------------------------------------------

/** Why actions that reach the device cannot run now, or null when they can. */
export function deviceUnreachable(d: Pick<DeviceView, 'status'>): string | null {
  if (d.status === 'revoked') return 'This device was revoked.';
  if (d.status === 'pending') return 'The device has not connected yet.';
  if (d.status === 'unreachable') return 'The device is offline.';
  return null;
}

/** Why a capability cannot be used on this device now, or null when it can. */
export function capabilityBlocked(d: DeviceView, name: DeviceCapabilityName): string | null {
  const off = deviceUnreachable(d);
  if (off) return off;
  const s = d.capabilities.find((c) => c.name === name);
  if (!s) return `This device does not report ${CAPABILITY_LABEL[name].toLowerCase()}.`;
  if (s.available) return null;
  if (s.reason === 'update_required')
    return `Needs novad ${s.minVersion}; this device has ${d.novadVersion ?? 'an unknown version'}.`;
  if (s.reason === 'module_not_allowed')
    return `The ${moduleLabel(s.module).toLowerCase()} module is not allowed by this device's policy.`;
  return `This device has no ${moduleLabel(s.module).toLowerCase()} module.`;
}

export function errorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.body.code : null;
}

/** A Hub error about a device, in plain words. */
export function deviceErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const d = err.body.details ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  switch (str(d.reason) ?? err.body.code) {
    case 'node_unavailable':
    case 'unreachable':
      return 'The device is offline. Try again when it reconnects.';
    case 'update_required':
      return `This device needs novad ${str(d.minVersion) ?? 'a newer version'} for that${
        str(d.novadVersion) ? ` (it has ${str(d.novadVersion)})` : ''
      }.`;
    case 'module_missing':
      return `This device has no ${moduleLabel(str(d.module) ?? '').toLowerCase()} module.`;
    case 'module_not_allowed':
      return `The ${moduleLabel(str(d.module) ?? '').toLowerCase()} module is not allowed by this device's policy.`;
    case 'not_wakeable':
      return 'This device does not report Wake-on-LAN. Enable it on the device first.';
    case 'wake_rate_limited':
      return `This device was woken ${typeof d.limit === 'number' ? plural(d.limit, 'time') : 'too many times'} in the last hour, the most allowed. Try again later.`;
    case 'power_actions_disabled':
      return 'Power actions are off in this device’s novad settings.';
    case 'elevation_required':
      return 'novad needs elevated rights to change Wake-on-LAN. Run the steps on the device yourself.';
    case 'protected_path':
      return 'That path is protected and is never shared or written.';
    case 'folder_access_required':
      return 'That folder is not shared with you on this device.';
    case 'not_routing_eligible':
      return 'This device is kept out of agent work by its policy.';
    case 'agent_connected':
      return 'This agent already has a connected computer.';
    case 'firmware_disabled':
      return 'Firmware changes are off.';
    case 'no_wake_helper':
      return 'Nothing on this device’s network can wake it: there is no Wake helper there, and the Hub is not on that network. Add an always-on device there as a Wake helper.';
    case 'confirmation_mismatch':
      return 'That code does not match the one on the device. Compare the six digits on both screens.';
    case 'decided':
      return `This request was already ${str(d.status) ?? 'decided'}.`;
    case 'expired':
      return 'This request has expired. Add the device again with a new code.';
    case 'key_revoked':
      return 'This device’s key was revoked. Reset the device so it makes a new key, then add it again.';
    case 'key_in_use':
      return 'This device’s key is already registered.';
    case 'add_device_disabled':
      return 'Adding devices with a code is turned off. Turn it on in Settings → Devices.';
    case 'start_rate_limited':
      return `Too many codes were made in the last hour${typeof d.limit === 'number' ? ` (at most ${d.limit})` : ''}. Try again later.`;
    case 'relay_unavailable':
      return 'The Relay is not set up on this Hub. Add the device directly, or set up a Relay in Network.';
    case 'revoked':
      return 'This device was revoked.';
    default:
      return errorMessage(err, fallback);
  }
}

// ---- numbers, times and quiet hours --------------------------------------------------------------

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown size';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

export const QUIET_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** "22:00-07:00, 12:00-13:00" → ranges, or the first bad entry. */
export function parseQuietHours(text: string): { ranges: string[] } | { bad: string } {
  const ranges = text
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/\s*[–—]\s*|\s+-\s+/, '-'))
    .filter(Boolean);
  const bad = ranges.find((r) => !QUIET_RANGE.test(r));
  return bad ? { bad } : { ranges };
}

// ---- paths on the device -------------------------------------------------------------------------

/** Windows drive paths use backslashes; everything else forward slashes. */
function sepOf(path: string): '/' | '\\' {
  return /^[A-Za-z]:\\/.test(path) ? '\\' : '/';
}

export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** The folders from a root down to `path`: [{label, path}], for a breadcrumb. */
export function pathCrumbs(root: string, path: string): { label: string; path: string }[] {
  const sep = sepOf(root);
  const trim = (p: string) =>
    p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p;
  const r = trim(root);
  const p = trim(path);
  const out = [{ label: r, path: r }];
  if (p === r || !p.startsWith(r)) return out;
  let cur = r;
  for (const part of p.slice(r.length).split(/[\\/]/).filter(Boolean)) {
    cur = cur.endsWith(sep) ? `${cur}${part}` : `${cur}${sep}${part}`;
    out.push({ label: part, path: cur });
  }
  return out;
}

export const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

/** The Hub's rule: absolute, no `.` or `..` segments, no NUL. */
export function pathProblem(p: string): string | null {
  if (!p.trim()) return 'Enter a folder path.';
  if (!ABSOLUTE_PATH.test(p)) return 'Enter a full path, starting with / (or a drive like C:\\).';
  if (p.includes('\0') || p.split(/[\\/]/).some((s) => s === '.' || s === '..'))
    return 'The path cannot contain . or .. parts.';
  return null;
}

// ---- file previews -------------------------------------------------------------------------------

/** How much of a file the preview reads. */
export const PREVIEW_BYTES = 256 * 1024;

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Text when the bytes look like text (no NUL in the first 8 KB), else null. */
export function previewText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// ---- unified diffs -------------------------------------------------------------------------------

export interface DiffRow {
  kind: 'add' | 'del' | 'same' | 'hunk' | 'meta';
  text: string;
}

/** Rows of a unified diff; file headers are dropped, hunk headers kept. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ')) continue;
    if (line.startsWith('@@')) rows.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) rows.push({ kind: 'same', text: line.slice(1) });
    else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: line.slice(1).trim() });
    else if (line) rows.push({ kind: 'meta', text: line });
  }
  return rows;
}

/** "+3 −1". */
export function changeCount(w: Pick<StagedWriteView, 'additions' | 'deletions'>): string {
  return `+${w.additions} −${w.deletions}`;
}
