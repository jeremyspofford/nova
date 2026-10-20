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
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import { ApiError, errorMessage } from '../api.ts';
import type { DeviceWakeResult } from './api.ts';

/**
 * The Devices area's shared words (FR-016). Groups are read through the exported maps below
 * (`ROLE_LABEL`, `CAPABILITY_LABEL`, ...), whose values are getters: each read translates in the
 * active locale. The views' own sentences live next to them, in `devices.<view>` namespaces.
 */
export const DEVICES_TEXT = defineMessages('devices', {
  status: {
    active: 'Online',
    unreachable: 'Offline',
    pending: 'Waiting for first contact',
    revoked: 'Revoked',
  },
  roles: {
    hub: 'Hub',
    client: 'Client',
    compute: 'Compute node',
    'wake-helper': 'Wake helper',
  },
  noRole: 'No role',
  roleHelp: {
    client: 'A phone, tablet or computer you use Nova on.',
    compute: 'Runs models and other heavy work for this Hub.',
    'wake-helper': 'Always on, on the same network as your other devices, so it can wake them.',
  },
  scopes: {
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
  },
  noScopes: 'No extra scopes',
  joinKinds: {
    browser: 'Web browser',
    native: 'Nova app',
    novad: 'novad',
    compute: 'nova-compute',
  },
  runs: {
    hub: 'This Hub',
    novad: 'novad {version}',
    novadUnknown: 'novad, version unknown',
    compute: 'nova-compute',
    unknown: 'Unknown',
  },
  wake: {
    sentMac: 'Wake signal sent to {name} ({mac}).',
    sentByHub: 'Wake signal sent to {name} by the Hub.',
    sentThrough: 'Wake signal sent to {name} through {helper}.',
    sentThroughHelper: 'Wake signal sent to {name} through a Wake helper.',
  },
  capabilityNames: {
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
  },
  /** A capability's name inside a sentence ("This device does not report files."). */
  capabilityNouns: {
    files: 'files',
    staged_writes: 'staged writes',
    exec: 'commands',
    mcp: 'local MCP servers',
    power: 'power',
    services: 'services',
    updates: 'updates',
    computer_use: 'computer use',
    browser: 'browser',
    capture: 'ambient capture',
  },
  moduleNames: {
    management: 'Management',
    compute: 'Compute',
    browser: 'Browser',
    screen: 'Screen',
    storage: 'Storage',
    capture: 'Capture',
  },
  /** A module's name inside a sentence ("This device has no capture module."). */
  moduleNouns: {
    management: 'management',
    compute: 'compute',
    browser: 'browser',
    screen: 'screen',
    storage: 'storage',
    capture: 'capture',
  },
  modulePurpose: {
    management: 'Power, services and updates',
    compute: 'Runs models',
    browser: 'Browser automation for agents',
    screen: 'Computer use',
    storage: 'Files, staged writes and local MCP servers',
    capture: 'Ambient capture, with no network access',
  },
  capabilityReason: {
    update: 'Needs novad {version}',
    notAllowed: '{module} module not allowed by policy',
    missing: 'No {module} module',
  },
  summary: {
    none: 'No capabilities yet',
    needUpdate: '{capabilities} · {n, plural, one {# needs an update} other {# need an update}}',
  },
  moduleStates: {
    running: 'Running',
    stopped: 'Stopped',
    backoff: 'Restarting after a crash',
    disabled: 'Disabled',
  },
  stagedStatus: {
    staged: 'Waiting for review',
    committed: 'Written',
    discarded: 'Discarded',
    conflict: 'Conflict',
    expired: 'Expired',
    failed: 'Failed',
  },
  updateStatus: {
    applied: 'Applied',
    staged: 'Staged',
    rolled_back: 'Rolled back',
    refused: 'Refused',
    failed: 'Failed',
  },
  granteeKinds: {
    user: 'You',
    agent: 'Agent',
    session: 'Code session',
    run: 'Work run',
    thread: 'Chat',
  },
  grantee: {
    you: 'You',
    agent: 'Agent {name}',
    other:
      '{kind, select, session {Code session {id}} run {Work run {id}} thread {Chat {id}} other {{id}}}',
  },
  access: {
    mcp: 'Can call its tools',
    write: 'Read and change',
    read: 'Read only',
  },
  unreachable: {
    revoked: 'This device was revoked.',
    pending: 'The device has not connected yet.',
    offline: 'The device is offline.',
  },
  blocked: {
    notReported: 'This device does not report {capability}.',
    update: 'Needs novad {version}; this device has {have}.',
    updateUnknown: 'Needs novad {version}; this device has an unknown version.',
    notAllowed: "The {module} module is not allowed by this device's policy.",
    missing: 'This device has no {module} module.',
  },
  errors: {
    generic: 'Something went wrong.',
    offline: 'The device is offline. Try again when it reconnects.',
    updateHas: 'This device needs novad {version} for that (it has {have}).',
    update: 'This device needs novad {version} for that.',
    newerHas: 'This device needs a newer novad for that (it has {have}).',
    newer: 'This device needs a newer novad for that.',
    moduleMissing: 'This device has no {module} module.',
    moduleNotAllowed: "The {module} module is not allowed by this device's policy.",
    notWakeable: 'This device does not report Wake-on-LAN. Enable it on the device first.',
    wakeLimit:
      'This device was woken {limit, plural, one {# time} other {# times}} in the last hour, the most allowed. Try again later.',
    wakeLimited:
      'This device was woken too many times in the last hour, the most allowed. Try again later.',
    powerOff: 'Power actions are off in this device’s novad settings.',
    elevation:
      'novad needs elevated rights to change Wake-on-LAN. Run the steps on the device yourself.',
    protectedPath: 'That path is protected and is never shared or written.',
    folderAccess: 'That folder is not shared with you on this device.',
    notRouting: 'This device is kept out of agent work by its policy.',
    agentConnected: 'This agent already has a connected computer.',
    firmwareOff: 'Firmware changes are off.',
    noWakeHelper:
      'Nothing on this device’s network can wake it: there is no Wake helper there, and the Hub is not on that network. Add an always-on device there as a Wake helper.',
    mismatch:
      'That code does not match the one on the device. Compare the six digits on both screens.',
    decided:
      '{status, select, approved {This request was already approved.} denied {This request was already denied.} expired {This request has already expired.} other {This request was already decided.}}',
    expired: 'This request has expired. Add the device again with a new code.',
    keyRevoked:
      'This device’s key was revoked. Reset the device so it makes a new key, then add it again.',
    keyInUse: 'This device’s key is already registered.',
    addOff: 'Adding devices with a code is turned off. Turn it on in Settings → Devices.',
    codesLimit: 'Too many codes were made in the last hour (at most {limit}). Try again later.',
    codesLimited: 'Too many codes were made in the last hour. Try again later.',
    noRelay:
      'The Relay is not set up on this Hub. Add the device directly, or set up a Relay in Network.',
    revoked: 'This device was revoked.',
  },
  unknownSize: 'unknown size',
  paths: {
    empty: 'Enter a folder path.',
    relative: 'Enter a full path, starting with / (or a drive like C:\\).',
    dots: 'The path cannot contain . or .. parts.',
  },
});

const S = DEVICES_TEXT;

/** Items joined the locale's way, without "and": "Files, Staged writes, Commands". */
export function listText(items: readonly string[]): string {
  return fmt.list(items, { type: 'unit', style: 'short' });
}

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

/** A status's chip: its words (read in the active locale when shown), tone and icon. */
export interface StatusChip<I> {
  readonly text: string;
  readonly tone: ChipTone;
  readonly icon: I;
}

export const DEVICE_STATUS: Record<
  DeviceView['status'],
  StatusChip<'check' | 'alert' | 'stop' | null>
> = {
  active: {
    get text() {
      return S.status.active;
    },
    tone: 'ready',
    icon: 'check',
  },
  unreachable: {
    get text() {
      return S.status.unreachable;
    },
    tone: 'needs_input',
    icon: 'alert',
  },
  pending: {
    get text() {
      return S.status.pending;
    },
    tone: 'running',
    icon: null,
  },
  revoked: {
    get text() {
      return S.status.revoked;
    },
    tone: 'blocked',
    icon: 'stop',
  },
};

/** A role's name; read `ROLE_LABEL[role] ?? role` at render time. */
export const ROLE_LABEL: Readonly<Record<string, string>> = S.roles;

export function rolesText(roles: readonly string[]): string {
  return roles.length ? listText(roles.map((r) => messageFor(S.roles, r) ?? r)) : S.noRole;
}

// ---- Add Device: roles, scopes and kinds (FR-132, docs/22 §4.2) --------------------------------

export const ROLE_HELP: Readonly<Record<AddDeviceRole, string>> = S.roleHelp;

/**
 * The scopes each role can be given at add time and later (docs/22 §4.2). They are recorded on the
 * device and shown on its page; folders, the browser and the screen still ask before each use.
 */
export const SCOPES_BY_ROLE: Record<AddDeviceRole, readonly string[]> = {
  client: ['offline-replica', 'local-runtime', 'files', 'browser', 'computer_use'],
  compute: ['exec'],
  'wake-helper': [],
};

/** A scope's label and help; `SCOPE_TEXT[scope]` is undefined for a scope Nova has no words for. */
export const SCOPE_TEXT: Readonly<
  Record<string, { readonly label: string; readonly help: string } | undefined>
> = S.scopes;

export function scopeLabel(scope: string): string {
  return SCOPE_TEXT[scope]?.label ?? scope;
}

/** "Offline copy, Files", or "No extra scopes". */
export function scopesText(scopes: readonly string[]): string {
  return scopes.length ? listText(scopes.map(scopeLabel)) : S.noScopes;
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

export const JOIN_KIND_LABEL: Readonly<Record<AddDeviceKind, string>> = S.joinKinds;

/** What the device runs: "novad 0.7.0", "Web browser", "nova-compute", "This Hub". */
export function runsText(
  d: DeviceSummaryView,
  novad: Pick<DeviceView, 'novadVersion'> | null,
): string {
  if (d.kind === 'hub') return S.runs.hub;
  if (novad || d.addedAs === 'novad' || d.novadVersion) {
    const version = novad?.novadVersion ?? d.novadVersion;
    return version ? S.runs.novad({ version }) : S.runs.novadUnknown;
  }
  if (d.addedAs) return JOIN_KIND_LABEL[d.addedAs];
  return d.kind === 'compute' ? S.runs.compute : S.runs.unknown;
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
  if (!w.via) return S.wake.sentMac({ name, mac: w.mac });
  if (w.via === 'hub') return S.wake.sentByHub({ name });
  const helper = helperName(w.via);
  return helper ? S.wake.sentThrough({ name, helper }) : S.wake.sentThroughHelper({ name });
}

export const CAPABILITY_LABEL: Readonly<Record<DeviceCapabilityName, string>> = S.capabilityNames;

/** A capability's name inside a sentence: "files", "local MCP servers". */
export function capabilityNoun(name: string): string {
  return messageFor(S.capabilityNouns, name) ?? name;
}

export const MODULE_LABEL: Readonly<Record<DeviceModuleName, string>> = S.moduleNames;

export const MODULE_PURPOSE: Readonly<Record<DeviceModuleName, string>> = S.modulePurpose;

export function moduleLabel(name: string): string {
  return messageFor(S.moduleNames, name) ?? name;
}

/** A module's name inside a sentence: "capture", "management". */
export function moduleNoun(name: string): string {
  return messageFor(S.moduleNouns, name) ?? name;
}

/** Why a capability is not available, in a few words. */
export function capabilityReason(s: DeviceCapabilityStatus): string | null {
  if (s.available || !s.reason) return null;
  if (s.reason === 'update_required') return S.capabilityReason.update({ version: s.minVersion });
  if (s.reason === 'module_not_allowed')
    return S.capabilityReason.notAllowed({ module: moduleLabel(s.module) });
  return S.capabilityReason.missing({ module: moduleNoun(s.module) });
}

/** "Files, Staged writes, Commands · 2 need an update". */
export function capabilitySummary(d: DeviceView): string {
  const on = d.capabilities.filter((c) => c.available).map((c) => CAPABILITY_LABEL[c.name]);
  const update = d.capabilities.filter((c) => c.reason === 'update_required').length;
  const capabilities = on.length ? listText(on) : S.summary.none;
  return update ? S.summary.needUpdate({ capabilities, n: update }) : capabilities;
}

export const MODULE_STATE: Record<
  DeviceModuleView['state'],
  StatusChip<'check' | 'alert' | 'stop' | null>
> = {
  running: {
    get text() {
      return S.moduleStates.running;
    },
    tone: 'ready',
    icon: 'check',
  },
  stopped: {
    get text() {
      return S.moduleStates.stopped;
    },
    tone: 'neutral',
    icon: 'stop',
  },
  backoff: {
    get text() {
      return S.moduleStates.backoff;
    },
    tone: 'needs_input',
    icon: 'alert',
  },
  disabled: {
    get text() {
      return S.moduleStates.disabled;
    },
    tone: 'blocked',
    icon: 'stop',
  },
};

/** A module the supervisor gave up on after repeated crashes. */
export function crashLooped(m: DeviceModuleView): boolean {
  return m.disabledReason === 'crash_loop';
}

export const STAGED_STATUS: Record<
  StagedWriteView['status'],
  StatusChip<'hand' | 'check' | 'alert' | 'stop' | 'clock'>
> = {
  staged: {
    get text() {
      return S.stagedStatus.staged;
    },
    tone: 'needs_input',
    icon: 'hand',
  },
  committed: {
    get text() {
      return S.stagedStatus.committed;
    },
    tone: 'ready',
    icon: 'check',
  },
  discarded: {
    get text() {
      return S.stagedStatus.discarded;
    },
    tone: 'neutral',
    icon: 'stop',
  },
  conflict: {
    get text() {
      return S.stagedStatus.conflict;
    },
    tone: 'blocked',
    icon: 'alert',
  },
  expired: {
    get text() {
      return S.stagedStatus.expired;
    },
    tone: 'neutral',
    icon: 'clock',
  },
  failed: {
    get text() {
      return S.stagedStatus.failed;
    },
    tone: 'blocked',
    icon: 'alert',
  },
};

/** An update's status in words; `UPDATE_STATUS_TEXT[status] ?? status`. */
export const UPDATE_STATUS_TEXT: Readonly<Record<string, string | undefined>> = S.updateStatus;

export const GRANTEE_KIND_LABEL: Readonly<Record<DeviceGrantee['kind'], string>> = S.granteeKinds;

/** "You", "Agent Scout", "Work run 0193…". */
export function granteeText(g: DeviceGrantee, agentName?: (id: string) => string | null): string {
  if (g.kind === 'user') return S.grantee.you;
  if (g.kind === 'agent') return S.grantee.agent({ name: agentName?.(g.id) ?? g.id });
  return S.grantee.other({ kind: g.kind, id: g.id });
}

export function accessText(r: Pick<DeviceAccessRequestView, 'access' | 'kind'>): string {
  if (r.kind === 'mcp') return S.access.mcp;
  return r.access === 'write' ? S.access.write : S.access.read;
}

// ---- why something is unavailable --------------------------------------------------------------

/** Why actions that reach the device cannot run now, or null when they can. */
export function deviceUnreachable(d: Pick<DeviceView, 'status'>): string | null {
  if (d.status === 'revoked') return S.unreachable.revoked;
  if (d.status === 'pending') return S.unreachable.pending;
  if (d.status === 'unreachable') return S.unreachable.offline;
  return null;
}

/** Why a capability cannot be used on this device now, or null when it can. */
export function capabilityBlocked(d: DeviceView, name: DeviceCapabilityName): string | null {
  const off = deviceUnreachable(d);
  if (off) return off;
  const s = d.capabilities.find((c) => c.name === name);
  if (!s) return S.blocked.notReported({ capability: capabilityNoun(name) });
  if (s.available) return null;
  if (s.reason === 'update_required')
    return d.novadVersion
      ? S.blocked.update({ version: s.minVersion, have: d.novadVersion })
      : S.blocked.updateUnknown({ version: s.minVersion });
  if (s.reason === 'module_not_allowed')
    return S.blocked.notAllowed({ module: moduleNoun(s.module) });
  return S.blocked.missing({ module: moduleNoun(s.module) });
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
export function deviceErrorMessage(err: unknown, fallback?: string): string {
  const otherwise = fallback ?? S.errors.generic;
  if (!(err instanceof ApiError)) return errorMessage(err, otherwise);
  const d = err.body.details ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const E = S.errors;
  switch (str(d.reason) ?? err.body.code) {
    case 'node_unavailable':
    case 'unreachable':
      return E.offline;
    case 'update_required': {
      const version = str(d.minVersion);
      const have = str(d.novadVersion);
      if (version) return have ? E.updateHas({ version, have }) : E.update({ version });
      return have ? E.newerHas({ have }) : E.newer;
    }
    case 'module_missing':
      return E.moduleMissing({ module: moduleNoun(str(d.module) ?? '') });
    case 'module_not_allowed':
      return E.moduleNotAllowed({ module: moduleNoun(str(d.module) ?? '') });
    case 'not_wakeable':
      return E.notWakeable;
    case 'wake_rate_limited':
      return typeof d.limit === 'number' ? E.wakeLimit({ limit: d.limit }) : E.wakeLimited;
    case 'power_actions_disabled':
      return E.powerOff;
    case 'elevation_required':
      return E.elevation;
    case 'protected_path':
      return E.protectedPath;
    case 'folder_access_required':
      return E.folderAccess;
    case 'not_routing_eligible':
      return E.notRouting;
    case 'agent_connected':
      return E.agentConnected;
    case 'firmware_disabled':
      return E.firmwareOff;
    case 'no_wake_helper':
      return E.noWakeHelper;
    case 'confirmation_mismatch':
      return E.mismatch;
    case 'decided':
      return E.decided({ status: str(d.status) ?? '' });
    case 'expired':
      return E.expired;
    case 'key_revoked':
      return E.keyRevoked;
    case 'key_in_use':
      return E.keyInUse;
    case 'add_device_disabled':
      return E.addOff;
    case 'start_rate_limited':
      return typeof d.limit === 'number' ? E.codesLimit({ limit: d.limit }) : E.codesLimited;
    case 'relay_unavailable':
      return E.noRelay;
    case 'revoked':
      return E.revoked;
    default:
      return errorMessage(err, otherwise);
  }
}

// ---- numbers, times and quiet hours --------------------------------------------------------------

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return S.unknownSize;
  return fmt.bytes(n);
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
  if (!p.trim()) return S.paths.empty;
  if (!ABSOLUTE_PATH.test(p)) return S.paths.relative;
  if (p.includes('\0') || p.split(/[\\/]/).some((s) => s === '.' || s === '..'))
    return S.paths.dots;
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
  return `+${fmt.number(w.additions)} −${fmt.number(w.deletions)}`;
}
