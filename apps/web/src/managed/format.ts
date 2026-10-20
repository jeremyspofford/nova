// Words for managed policy (FR-106; docs/12 §10; ADR-097 D4): where a policy comes from, each
// source's status, why a key of a policy does not apply, the restrictions in plain sentences, the
// values it sets, and the Hub's refusals. Every user-facing string of the managed views is a
// message here (FR-016), whole sentences only, read at render time; the Hub's own words (a
// source's problem, why a value is invalid, the fail-closed reason) stay as the Hub sent them.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import type {
  ManagedChannel,
  ManagedPolicyView,
  ManagedRestrict,
  ManagedSourceStatus,
  ManagedSourceView,
  PermissionMode,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { MODE_LABEL } from '../code/modes.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';

/** Settings → Managed policy. */
export const MANAGED_PATH = '/settings/managed';

export const MANAGED_STRINGS = defineMessages('managed', {
  title: 'Managed policy',
  intro:
    'Your organization can set and lock settings on this Hub and restrict what Nova may do. A policy only ever tightens: it can turn things off, never on.',
  precedenceTitle: 'How a setting is decided',
  /** The three layers, in order. */
  precedence: {
    defaults: "Nova's default.",
    hub: "This Hub's settings, as you set them.",
    policy: "Your organization's policy, which locks the setting.",
  },
  precedenceBoth:
    'When the policy file and the remote policy both set something, the stricter value applies.',
  none: 'No managed policy applies to this Hub. Every setting is yours to change.',
  active: "Your organization's policy is in force on this Hub.",
  failClosedTitle: "Your organization's policy could not be read",
  failClosed:
    'Every agent tool is denied until the policy is fixed. The last good policy stays in force.',
  sourcesTitle: 'Sources',
  restrictTitle: 'Restrictions',
  restrictNone: 'The policy restricts nothing beyond the settings below.',
  restrictBoth: 'Both sources apply; where they differ, the stricter one wins.',
  settingsTitle: 'Settings it sets',
  settingsNone: 'The policy sets no settings.',
  settingsCaption: 'Settings the policy sets',
  ignoredTitle: 'Not applied',
  ignoredIntro: 'These parts of the policy do not apply, and why.',
  colSetting: 'Setting',
  colValue: 'Value',
  colSource: 'Source',
  colWhy: 'Why',
  reload: 'Check for changes',
  reloading: 'Checking',
  reloaded: 'The policy was read again.',
  reloadedSame: 'The policy was read again. Nothing changed.',
  ownerReloads: 'Only the owner of this Hub can check the policy for changes.',
  memberHidden:
    "Your organization's policy applies to everyone on this Hub. Only the Hub's owner can see its details here.",
  loadError: 'Could not load the managed policy.',
  location: 'Location',
  serial: 'Version',
  loadedAt: 'Read',
  checkedAt: 'Last checked',
  lastChecked: 'Last checked: {when}',
  inForceCached: 'In force from the copy kept on this Hub (the last good one).',
  inForceLastGood: 'The last good policy from this source stays in force.',
  testOverride: 'For tests only: this file comes from NOVA_MANAGED_SETTINGS_FILE.',
  bannerSee: 'See the managed policy',
  bannerActive:
    'Your organization manages this Hub. Settings it sets say “Managed by your organization” and cannot be changed here.',
  derived: 'Follows from a restriction',
  on: 'On',
  off: 'Off',
  notSet: 'Not set',
  empty: 'Empty',
  noneValue: 'None',
  /** An empty list inside a restriction sentence: "Agents may use only these tools: none." */
  noneInList: 'none',
  retry: 'Retry',
  loading: 'Loading the managed policy',
  checkFailed: 'Could not check the policy.',
  somethingWrong: 'Something went wrong.',
  notAccepted: 'The Hub did not accept the request. Reload the page and try again.',
  /** The accessible name of a source's restriction list. */
  restrictionsFrom: 'Restrictions: {source}',
  /** A source in force, in the Settings banner: its name, then its location. */
  sourceAt: '{source}: {location}',
  /** The egress allow list in force: the policy's hosts, or yours within them (ADR-097). */
  egressInForce: 'Hosts agents may reach now: {list}.',
  egressNoneOfYours:
    "None of the hosts on your own allow list is within the policy's hosts, so agents may reach none of them without asking. Add hosts the policy allows in Network, or empty your list to use the policy's hosts.",
  egressOutside:
    "These hosts on your allow list are outside the policy's and do not apply: {list}.",
});

// ---- sources -----------------------------------------------------------------------------------

export const CHANNEL_LABEL = defineMessages('managed.channel', {
  local: 'Policy file on this Hub',
  remote: 'Signed remote policy',
  test: 'Test policy file',
  both: 'Policy file and remote policy',
});

/** The short source shown next to "Managed by your organization". */
export const LOCK_SOURCE = defineMessages('managed.lockSource', {
  local: '(policy file)',
  remote: '(remote policy)',
  test: '(test policy file)',
  both: '(policy file and remote policy)',
});

export interface StatusSpec {
  text: string;
  icon: IconName;
  /** For StateChip: ready (ok), needs_input (warn), blocked (danger), or none. */
  tone: 'ready' | 'needs_input' | 'blocked' | null;
}

const STATUS_TEXT = defineMessages('managed.status', {
  absent: 'Not present',
  active: 'In force',
  ignored: 'Ignored',
  invalid: 'Cannot be read',
  refused: 'Refused',
  unreachable: 'Unreachable',
});

const STATUS_LOOK: Record<ManagedSourceStatus, Omit<StatusSpec, 'text'>> = {
  absent: { icon: 'slash', tone: null },
  active: { icon: 'check', tone: 'ready' },
  ignored: { icon: 'alert', tone: 'needs_input' },
  invalid: { icon: 'alert', tone: 'blocked' },
  refused: { icon: 'shield', tone: 'blocked' },
  unreachable: { icon: 'network', tone: 'needs_input' },
};

/** A source status's chip: its word (in the active locale) and its look. */
export function sourceStatus(status: ManagedSourceStatus): StatusSpec {
  return { ...STATUS_LOOK[status], text: STATUS_TEXT[status] };
}

const STATUS_SENTENCE = defineMessages('managed.statusText', {
  absentLocal: 'There is no policy file at this location.',
  absentRemote: 'No remote policy is configured.',
  active: 'Read, checked and in force.',
  ignored: 'Ignored, so nothing in it applies: {problem}.',
  invalid: 'It cannot be read, so every agent tool is denied: {problem}.',
  refused: 'Refused: {problem}.',
  unreachable: 'It could not be fetched: {problem}.',
  /** Stands in for the Hub's problem when it gave none. */
  noReason: 'no reason given',
});

/** What a source's status means, in a sentence (its problem comes from the Hub). */
export function sourceStatusText(s: ManagedSourceView): string {
  const problem = s.problem ?? STATUS_SENTENCE.noReason;
  switch (s.status) {
    case 'absent':
      return s.channel === 'local' ? STATUS_SENTENCE.absentLocal : STATUS_SENTENCE.absentRemote;
    case 'active':
      return STATUS_SENTENCE.active;
    case 'ignored':
      return STATUS_SENTENCE.ignored({ problem });
    case 'invalid':
      return STATUS_SENTENCE.invalid({ problem });
    case 'refused':
      return STATUS_SENTENCE.refused({ problem });
    case 'unreachable':
      return STATUS_SENTENCE.unreachable({ problem });
  }
}

// ---- ignored keys ------------------------------------------------------------------------------

export const IGNORE_REASON = defineMessages('managed.ignore', {
  unknown_key: 'Nova has no setting by this name.',
  invalid_value: 'The value is not valid for this setting.',
  loosens: 'It would loosen a security setting, and a policy can only tighten them.',
  unordered:
    'Nova cannot tell whether this value tightens or loosens the setting, so a policy cannot set it.',
  manual_mode: 'Manual mode can never be turned off.',
});

// ---- restrictions ------------------------------------------------------------------------------

// One whole sentence per `restrict` part (keys are the parts of ManagedRestrict).
const DERIVED_TEXT = defineMessages('managed.derived', {
  permissionModes: 'Follows from the permission modes restriction.',
  tools: 'Follows from the tools restriction.',
  plugins: 'Follows from the plugins restriction.',
  extensions: 'Follows from the extensions restriction.',
  mcpServers: 'Follows from the MCP servers restriction.',
  sessions: 'Follows from the sessions restriction.',
  folders: 'Follows from the folders restriction.',
  browserDomains: 'Follows from the browser sites restriction.',
  egress: 'Follows from the network access restriction.',
  telemetryExport: 'Follows from the telemetry export restriction.',
  routing: 'Follows from the model routing restriction.',
  unverifiedInstalls: 'Follows from the unverified installs restriction.',
  apps: 'Follows from the apps restriction.',
  /** A part this version does not know: `{part}` is the policy key. */
  unknown: 'Follows from the {part} restriction.',
});

/** `restrict.egress` → "Follows from the network access restriction." */
export function derivedText(derivedFrom: string): string {
  const part = derivedFrom.replace(/^restrict\./, '');
  return (part !== 'unknown' && messageFor(DERIVED_TEXT, part)) || DERIVED_TEXT.unknown({ part });
}

const RESTRICT_TEXT = defineMessages('managed.restrict', {
  modesAllow: 'Code sessions may use only these modes: {modes}. Manual is always allowed.',
  modesDeny: 'These modes are turned off: {modes}.',
  toolsAllow: 'Agents may use only these tools: {list}.',
  toolsDeny: 'Agents may not use these tools: {list}.',
  pluginsAllow: 'Only these plugins may be used: {list}.',
  pluginsDeny: 'These plugins may not be used: {list}.',
  extensionsAllow: 'Only these extensions may be used: {list}.',
  extensionsDeny: 'These extensions may not be used: {list}.',
  mcpAllow: 'Only these MCP servers may be used: {list}.',
  mcpDeny: 'These MCP servers may not be used: {list}.',
  mcpUserAdded: 'MCP servers you add yourself are not allowed.',
  mcpLocalStdio: 'MCP servers that run as programs on this Hub (stdio) are not allowed.',
  sessionsLocal: "Code sessions on this Hub's own files are turned off.",
  sessionsSsh: 'Code sessions over SSH are turned off.',
  sshHosts: 'SSH sessions may connect only to: {list}.',
  foldersAllow: 'Sessions, project folders and tool roots may use only these folders: {list}.',
  foldersDeny: 'These folders are off limits: {list}.',
  browserAllow: 'The agent browser may open only these sites: {list}.',
  browserDeny: 'The agent browser may not open these sites: {list}.',
  egressOff: 'Agents have no network access.',
  egressLimited: "Agents' network access is limited.",
  egressAllowlist: 'Agents may reach only the hosts that are allowed.',
  egressAllow: 'Agents may reach hosts only within: {list}.',
  egressDeny: 'Hosts agents may never reach: {list}.',
  telemetryOff: 'Telemetry export (OpenTelemetry/OTLP) stays off.',
  cloudOff: 'Cloud models are turned off: only local models and compute nodes.',
  providers: 'Models may come only from: {list}.',
  verifiedOnly: 'Only plugins, extensions and bundles with a verified signature can be installed.',
  appsOff: 'No third-party app or MCP client can be authorized.',
});

/** Names joined the locale's way without a conjunction ("a, b, c"), or "none". */
const list = (xs: readonly string[]) =>
  xs.length ? fmt.list(xs, { type: 'unit', style: 'short' }) : MANAGED_STRINGS.noneInList;
const modes = (xs: readonly PermissionMode[]) => list(xs.map((m) => MODE_LABEL[m] ?? m));

/**
 * The egress allow list in force (`view.egress`): the hosts agents may reach now, and a note when
 * the owner's own list keeps none of them or has hosts outside the policy's.
 */
export function egressLines(egress: ManagedPolicyView['egress']): string[] {
  if (!egress) return [];
  const S = MANAGED_STRINGS;
  const out = [S.egressInForce({ list: list(egress.effective) })];
  const outside = egress.own.filter((h) => !egress.effective.includes(h));
  if (egress.own.length && !egress.effective.length) out.push(S.egressNoneOfYours);
  else if (outside.length) out.push(S.egressOutside({ list: list(outside) }));
  return out;
}

/** One plain sentence per thing a `restrict` block restricts, in the schema's order. */
export function restrictionLines(r: ManagedRestrict): string[] {
  const T = RESTRICT_TEXT;
  const out: string[] = [];
  const pm = r.permissionModes;
  if (pm?.allow) out.push(T.modesAllow({ modes: modes(pm.allow) }));
  if (pm?.deny?.length) out.push(T.modesDeny({ modes: modes(pm.deny) }));
  if (r.tools?.allow) out.push(T.toolsAllow({ list: list(r.tools.allow) }));
  if (r.tools?.deny?.length) out.push(T.toolsDeny({ list: list(r.tools.deny) }));
  if (r.plugins?.allow) out.push(T.pluginsAllow({ list: list(r.plugins.allow) }));
  if (r.plugins?.deny?.length) out.push(T.pluginsDeny({ list: list(r.plugins.deny) }));
  if (r.extensions?.allow) out.push(T.extensionsAllow({ list: list(r.extensions.allow) }));
  if (r.extensions?.deny?.length) out.push(T.extensionsDeny({ list: list(r.extensions.deny) }));
  const mcp = r.mcpServers;
  if (mcp?.allow) out.push(T.mcpAllow({ list: list(mcp.allow) }));
  if (mcp?.deny?.length) out.push(T.mcpDeny({ list: list(mcp.deny) }));
  if (mcp?.userAdded === false) out.push(T.mcpUserAdded);
  if (mcp?.localStdio === false) out.push(T.mcpLocalStdio);
  const s = r.sessions;
  if (s?.local === false) out.push(T.sessionsLocal);
  if (s?.ssh === false) out.push(T.sessionsSsh);
  if (s?.sshHosts) out.push(T.sshHosts({ list: list(s.sshHosts) }));
  if (r.folders?.allow) out.push(T.foldersAllow({ list: list(r.folders.allow) }));
  if (r.folders?.deny?.length) out.push(T.foldersDeny({ list: list(r.folders.deny) }));
  if (r.browserDomains?.allow) out.push(T.browserAllow({ list: list(r.browserDomains.allow) }));
  if (r.browserDomains?.deny?.length)
    out.push(T.browserDeny({ list: list(r.browserDomains.deny) }));
  const e = r.egress;
  if (e?.mode === 'off') out.push(T.egressOff);
  if (e?.mode === 'limited') out.push(T.egressLimited);
  if (e?.mode === 'allowlist') out.push(T.egressAllowlist);
  if (e?.allow) out.push(T.egressAllow({ list: list(e.allow) }));
  if (e?.deny?.length) out.push(T.egressDeny({ list: list(e.deny) }));
  if (r.telemetryExport === false) out.push(T.telemetryOff);
  if (r.routing?.allowCloud === false) out.push(T.cloudOff);
  if (r.routing?.providers)
    out.push(T.providers({ list: list(r.routing.providers.map((p) => PROVIDER_NAMES[p] ?? p)) }));
  if (r.unverifiedInstalls === false) out.push(T.verifiedOnly);
  if (r.apps === false) out.push(T.appsOff);
  return out;
}

// ---- values ------------------------------------------------------------------------------------

/** A policy value in words: On/Off, lists joined, objects as compact JSON (at most 200 chars). */
export function formatPolicyValue(v: unknown): string {
  if (v === null || v === undefined) return MANAGED_STRINGS.notSet;
  if (typeof v === 'boolean') return v ? MANAGED_STRINGS.on : MANAGED_STRINGS.off;
  if (typeof v === 'number') return fmt.number(v);
  if (typeof v === 'string') return v === '' ? MANAGED_STRINGS.empty : v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    return v.length ? fmt.list(v, { type: 'unit', style: 'short' }) : MANAGED_STRINGS.noneValue;
  const json = JSON.stringify(v) ?? '';
  return json.length > 200 ? `${json.slice(0, 199)}…` : json;
}

// ---- where a lock comes from -------------------------------------------------------------------

/**
 * The source of a locked setting: the setting's own channel when the policy names it (for
 * `restrict.<part>`, the sources whose restrict block sets that part), else the sources in force.
 * Null when nothing is known (no view, or nothing in force).
 */
export function lockChannel(
  view:
    | (Pick<ManagedPolicyView, 'settings' | 'sources'> &
        Partial<Pick<ManagedPolicyView, 'restrict'>>)
    | null,
  key?: string,
): ManagedChannel | 'both' | null {
  if (!view) return null;
  if (key?.startsWith('restrict.')) {
    const part = key.slice('restrict.'.length) as keyof ManagedRestrict;
    const from = new Set(
      (view.restrict ?? []).filter((r) => r.restrict[part] !== undefined).map((r) => r.channel),
    );
    if (from.has('test')) return 'test';
    if (from.has('local') && from.has('remote')) return 'both';
    const [only] = from;
    if (only) return only;
  }
  const own = key ? view.settings.find((s) => s.key === key) : undefined;
  if (own) return own.channel;
  const inForce = view.sources.filter((s) => s.inForce).map((s) => s.channel);
  // The test file (tests only) is layered over the others: it is the one that sets things.
  if (inForce.includes('test')) return 'test';
  if (inForce.includes('local') && inForce.includes('remote')) return 'both';
  return inForce[0] ?? null;
}

/** A policy is in force or failing closed (the settings banner shows). */
export function policyShows(
  view: Pick<ManagedPolicyView, 'active' | 'failClosed'> | null,
): boolean {
  return !!view && (view.active || view.failClosed !== null);
}

// ---- refusals ----------------------------------------------------------------------------------

const reasonOf = (err: unknown): string | null => {
  const r = err instanceof ApiError ? err.body.details?.reason : null;
  return typeof r === 'string' ? r : null;
};

/** 403 `owner_only` from the managed routes. */
export function isOwnerOnlyError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && reasonOf(err) === 'owner_only';
}

export function managedErrorMessage(
  err: unknown,
  fallback: string = MANAGED_STRINGS.somethingWrong,
): string {
  if (isOwnerOnlyError(err)) return MANAGED_STRINGS.ownerReloads;
  if (err instanceof ApiError && err.body.code === 'validation') return MANAGED_STRINGS.notAccepted;
  return errorMessage(err, fallback);
}
