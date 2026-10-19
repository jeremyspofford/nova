// Words for managed policy (FR-106; docs/12 §10; ADR-097 D4): where a policy comes from, each
// source's status, why a key of a policy does not apply, the restrictions in plain sentences, the
// values it sets, and the Hub's refusals. Every user-facing string of the managed views is here,
// whole sentences only, so they can be extracted for translation.
import { MANAGED_TEXT, type IconName } from '@nova/ui';
import type {
  ManagedChannel,
  ManagedIgnoreReason,
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

export const MANAGED_STRINGS = {
  managed: MANAGED_TEXT,
  title: 'Managed policy',
  intro:
    'Your organization can set and lock settings on this Hub and restrict what Nova may do. A policy only ever tightens: it can turn things off, never on.',
  precedenceTitle: 'How a setting is decided',
  precedence: [
    "Nova's default.",
    "This Hub's settings, as you set them.",
    "Your organization's policy, which locks the setting.",
  ],
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
} as const;

// ---- sources -----------------------------------------------------------------------------------

export const CHANNEL_LABEL: Record<ManagedChannel | 'both', string> = {
  local: 'Policy file on this Hub',
  remote: 'Signed remote policy',
  test: 'Test policy file',
  both: 'Policy file and remote policy',
};

/** The short source shown next to "Managed by your organization". */
export const LOCK_SOURCE: Record<ManagedChannel | 'both', string> = {
  local: '(policy file)',
  remote: '(remote policy)',
  test: '(test policy file)',
  both: '(policy file and remote policy)',
};

export interface StatusSpec {
  text: string;
  icon: IconName;
  /** For StateChip: ready (ok), needs_input (warn), blocked (danger), or none. */
  tone: 'ready' | 'needs_input' | 'blocked' | null;
}

export const SOURCE_STATUS: Record<ManagedSourceStatus, StatusSpec> = {
  absent: { text: 'Not present', icon: 'slash', tone: null },
  active: { text: 'In force', icon: 'check', tone: 'ready' },
  ignored: { text: 'Ignored', icon: 'alert', tone: 'needs_input' },
  invalid: { text: 'Cannot be read', icon: 'alert', tone: 'blocked' },
  refused: { text: 'Refused', icon: 'shield', tone: 'blocked' },
  unreachable: { text: 'Unreachable', icon: 'network', tone: 'needs_input' },
};

/** What a source's status means, in a sentence (its problem comes from the Hub). */
export function sourceStatusText(s: ManagedSourceView): string {
  const problem = s.problem ?? 'no reason given';
  switch (s.status) {
    case 'absent':
      return s.channel === 'local'
        ? 'There is no policy file at this location.'
        : 'No remote policy is configured.';
    case 'active':
      return 'Read, checked and in force.';
    case 'ignored':
      return `Ignored, so nothing in it applies: ${problem}.`;
    case 'invalid':
      return `It cannot be read, so every agent tool is denied: ${problem}.`;
    case 'refused':
      return `Refused: ${problem}.`;
    case 'unreachable':
      return `It could not be fetched: ${problem}.`;
  }
}

// ---- ignored keys ------------------------------------------------------------------------------

export const IGNORE_REASON: Record<ManagedIgnoreReason, string> = {
  unknown_key: 'Nova has no setting by this name.',
  invalid_value: 'The value is not valid for this setting.',
  loosens: 'It would loosen a security setting, and a policy can only tighten them.',
  unordered:
    'Nova cannot tell whether this value tightens or loosens the setting, so a policy cannot set it.',
  manual_mode: 'Manual mode can never be turned off.',
};

// ---- restrictions ------------------------------------------------------------------------------

const RESTRICT_PART: Record<keyof ManagedRestrict, string> = {
  permissionModes: 'permission modes',
  tools: 'tools',
  plugins: 'plugins',
  extensions: 'extensions',
  mcpServers: 'MCP servers',
  sessions: 'sessions',
  folders: 'folders',
  browserDomains: 'browser sites',
  egress: 'network access',
  telemetryExport: 'telemetry export',
  routing: 'model routing',
  unverifiedInstalls: 'unverified installs',
  apps: 'apps',
};

/** `restrict.egress` → "Follows from the network access restriction." */
export function derivedText(derivedFrom: string): string {
  const part = derivedFrom.replace(/^restrict\./, '') as keyof ManagedRestrict;
  return `Follows from the ${RESTRICT_PART[part] ?? part} restriction.`;
}

const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'none');
const modes = (xs: readonly PermissionMode[]) => list(xs.map((m) => MODE_LABEL[m] ?? m));

/** One plain sentence per thing a `restrict` block restricts, in the schema's order. */
export function restrictionLines(r: ManagedRestrict): string[] {
  const out: string[] = [];
  const pm = r.permissionModes;
  if (pm?.allow)
    out.push(
      `Code sessions may use only these modes: ${modes(pm.allow)}. Manual is always allowed.`,
    );
  if (pm?.deny?.length) out.push(`These modes are turned off: ${modes(pm.deny)}.`);
  if (r.tools?.allow) out.push(`Agents may use only these tools: ${list(r.tools.allow)}.`);
  if (r.tools?.deny?.length) out.push(`Agents may not use these tools: ${list(r.tools.deny)}.`);
  if (r.plugins?.allow) out.push(`Only these plugins may be used: ${list(r.plugins.allow)}.`);
  if (r.plugins?.deny?.length) out.push(`These plugins may not be used: ${list(r.plugins.deny)}.`);
  if (r.extensions?.allow)
    out.push(`Only these extensions may be used: ${list(r.extensions.allow)}.`);
  if (r.extensions?.deny?.length)
    out.push(`These extensions may not be used: ${list(r.extensions.deny)}.`);
  const mcp = r.mcpServers;
  if (mcp?.allow) out.push(`Only these MCP servers may be used: ${list(mcp.allow)}.`);
  if (mcp?.deny?.length) out.push(`These MCP servers may not be used: ${list(mcp.deny)}.`);
  if (mcp?.userAdded === false) out.push('MCP servers you add yourself are not allowed.');
  if (mcp?.localStdio === false)
    out.push('MCP servers that run as programs on this Hub (stdio) are not allowed.');
  const s = r.sessions;
  if (s?.local === false) out.push("Code sessions on this Hub's own files are turned off.");
  if (s?.ssh === false) out.push('Code sessions over SSH are turned off.');
  if (s?.sshHosts) out.push(`SSH sessions may connect only to: ${list(s.sshHosts)}.`);
  if (r.folders?.allow)
    out.push(
      `Sessions, project folders and tool roots may use only these folders: ${list(r.folders.allow)}.`,
    );
  if (r.folders?.deny?.length) out.push(`These folders are off limits: ${list(r.folders.deny)}.`);
  if (r.browserDomains?.allow)
    out.push(`The agent browser may open only these sites: ${list(r.browserDomains.allow)}.`);
  if (r.browserDomains?.deny?.length)
    out.push(`The agent browser may not open these sites: ${list(r.browserDomains.deny)}.`);
  const e = r.egress;
  if (e?.mode === 'off') out.push('Agents have no network access.');
  if (e?.mode === 'limited') out.push("Agents' network access is limited.");
  if (e?.mode === 'allowlist') out.push('Agents may reach only the hosts that are allowed.');
  if (e?.allow) out.push(`Hosts agents may reach: ${list(e.allow)}.`);
  if (e?.deny?.length) out.push(`Hosts agents may never reach: ${list(e.deny)}.`);
  if (r.telemetryExport === false) out.push('Telemetry export (OpenTelemetry/OTLP) stays off.');
  if (r.routing?.allowCloud === false)
    out.push('Cloud models are turned off: only local models and compute nodes.');
  if (r.routing?.providers)
    out.push(
      `Models may come only from: ${list(r.routing.providers.map((p) => PROVIDER_NAMES[p] ?? p))}.`,
    );
  if (r.unverifiedInstalls === false)
    out.push('Only plugins, extensions and bundles with a verified signature can be installed.');
  if (r.apps === false) out.push('No third-party app or MCP client can be authorized.');
  return out;
}

// ---- values ------------------------------------------------------------------------------------

/** A policy value in words: On/Off, lists joined, objects as compact JSON (at most 200 chars). */
export function formatPolicyValue(v: unknown): string {
  if (v === null || v === undefined) return MANAGED_STRINGS.notSet;
  if (typeof v === 'boolean') return v ? MANAGED_STRINGS.on : MANAGED_STRINGS.off;
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'string') return v === '' ? MANAGED_STRINGS.empty : v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    return v.length ? v.join(', ') : MANAGED_STRINGS.noneValue;
  const json = JSON.stringify(v) ?? '';
  return json.length > 200 ? `${json.slice(0, 199)}…` : json;
}

// ---- where a lock comes from -------------------------------------------------------------------

/**
 * The source of a locked setting: the setting's own channel when the policy names it, else the
 * sources in force. Null when nothing is known (no view, or nothing in force).
 */
export function lockChannel(
  view: Pick<ManagedPolicyView, 'settings' | 'sources'> | null,
  key?: string,
): ManagedChannel | 'both' | null {
  if (!view) return null;
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

export function managedErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (isOwnerOnlyError(err)) return MANAGED_STRINGS.ownerReloads;
  if (err instanceof ApiError && err.body.code === 'validation')
    return 'The Hub did not accept the request. Reload the page and try again.';
  return errorMessage(err, fallback);
}
