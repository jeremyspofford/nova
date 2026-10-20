// Which way each security setting tightens (FR-106, ADR-097 D4). Managed policy only tightens:
// a managed value for a security key applies as the tighter of itself and the value the user
// had (allow lists intersect, deny lists merge, a disabling switch wins, docs/12 §10), and a
// managed value looser than the key's built-in default is an attempt to loosen it: ignored for
// that key and reported. A security key with no known direction cannot be set by managed policy
// (Nova cannot tell whether a value tightens it), so its value is ignored and reported too.
import { SETTINGS, isSettingKey, type SettingDefinition } from '@nova/shared';

export type TightenRule =
  /** A switch whose `tight` value is the safe one. */
  | { kind: 'bool'; tight: boolean }
  /** An enum, tightest first. */
  | { kind: 'order'; order: readonly string[] }
  /** A number: lower is tighter. */
  | { kind: 'min' }
  /** A number: higher is tighter. */
  | { kind: 'max' }
  /** A list of what is allowed: lists intersect. */
  | { kind: 'allow' }
  /** A list of what is refused: lists merge. */
  | { kind: 'deny' }
  /** `tools.roots`: roots intersect by path, the narrower access wins. */
  | { kind: 'roots' }
  /**
   * `plugins.catalogs`: catalogs intersect by id and location; a pin (`publisherKey`, `commit`)
   * either side sets is kept, and a catalog the two pin differently is dropped.
   */
  | { kind: 'catalogs' }
  /** A number of days where null means "keep forever": the policy's value caps the user's. */
  | { kind: 'cap' }
  /**
   * `plugins.trustedPublishers`: keys intersect by key. With unverified installs refused the
   * policy's list is the whole list (see `ManagedPolicy.settingsLayer`).
   */
  | { kind: 'publishers' }
  /** A choice the administrator pins (the reviewer model): the policy's value is the value. */
  | { kind: 'pin' }
  /** An object whose named fields tighten on their own; other fields come from the policy. */
  | { kind: 'fields'; fields: Readonly<Record<string, TightenRule>> };

const OFF: TightenRule = { kind: 'bool', tight: false };
const ON: TightenRule = { kind: 'bool', tight: true };
const MIN: TightenRule = { kind: 'min' };
const MAX: TightenRule = { kind: 'max' };

/** Every security key a policy may set, by how it tightens. */
export const SECURITY_RULES: Readonly<Record<string, TightenRule>> = {
  'routing.allowCloud': OFF,
  'tools.roots': { kind: 'roots' },
  // Custom profiles have no place in the order: a policy may name only the built-in ones.
  'tools.permissionProfile': { kind: 'order', order: ['read-only', 'workspace', 'full'] },
  'tools.approvalPolicy': {
    kind: 'order',
    order: ['ask_always', 'defaults', 'review', 'never_ask'],
  },
  'policy.allowPersistentGrants': OFF,
  'policy.approvalTimeoutMinutes': MIN,
  'plugins.catalogs': { kind: 'catalogs' },
  'mcpServer.enabled': OFF,
  'runs.subagents': { kind: 'fields', fields: { maxChildren: MIN, maxConcurrent: MIN } },
  'code.permissionMode': { kind: 'order', order: ['manual', 'accept_edits', 'auto', 'bypass'] },
  'code.allowBypass': OFF,
  'channels.privateToShared': { kind: 'order', order: ['deny', 'ask', 'allow'] },
  'triggers.ratePerHour': MIN,
  'screen.grantMinutes': MIN,
  'network.egressMode': { kind: 'order', order: ['off', 'limited', 'allowlist'] },
  'network.egressAllow': { kind: 'allow' },
  'network.egressDeny': { kind: 'deny' },
  'computers.limits': {
    kind: 'fields',
    fields: { cpus: MIN, memoryMb: MIN, wallClockSeconds: MIN },
  },
  'agents.wakes': { kind: 'fields', fields: { minMinutes: MAX, horizonDays: MIN, perDay: MIN } },
  'browser.persistCookies': OFF,
  'browser.allowLocalSites': OFF,
  'browser.devProtocol': OFF,
  'network.setup.allowSystemChanges': OFF,
  'devices.add.enabled': OFF,
  'devices.add.sessionDays': MIN,
  'network.transports': {
    kind: 'fields',
    fields: { lan: OFF, mesh: OFF, relay: OFF, directPublic: OFF },
  },
  'network.lan.mdns': OFF,
  'network.lan.includeLoopback': OFF,
  'network.lan.includeLinkLocal': OFF,
  'trust.pinNativeShells': ON,
  'relay.enabled': OFF,
  'sync.enabled': OFF,
  'sync.maxSkewSeconds': MIN,
  'code.ssh.enabled': OFF,
  'channels.approvalLinkMinutes': MIN,
  'push.enabled': OFF,
  'push.detail': { kind: 'order', order: ['none', 'redacted', 'titles'] },
  'scripts.enabled': OFF,
  'scripts.limits': {
    kind: 'fields',
    fields: { cpuMs: MIN, memoryMb: MIN, maxCalls: MIN, logChars: MIN },
  },
  'externalAgents.enabled': OFF,
  'devices.tls.allowWithoutCertificate': OFF,
  'cloud.runner.enabled': OFF,
  'cloud.runner.unrestrictedNetwork': OFF,
  'team.invitationHours': MIN,
  'team.publicProfiles': OFF,
  'devices.boot.allowLowLevel': OFF,
  'devices.pxe.enabled': OFF,
  'browser.localFallback': OFF,
  'browser.extensionBridge': OFF,
  'browser.extensionBridgeAllSites': OFF,
  'devices.oob.enabled': OFF,
  'devices.firmware.allowChanges': OFF,
  'devices.firmware.allowSecurityDegrading': OFF,
  'privacy.telemetry': OFF,
  // M8 apps and telemetry (FR-222, FR-223).
  'apps.enabled': OFF,
  'telemetry.otlp.enabled': OFF,
  'telemetry.otlp.includeContent': OFF,
  'telemetry.otlp.signals': { kind: 'fields', fields: { traces: OFF, metrics: OFF, logs: OFF } },
  // M8 marketplace (FR-049): policy may only turn sideloads off and remove kinds.
  'market.allowSideload': OFF,
  'market.allowedKinds': { kind: 'allow' },
  // M8 data controls and SDK (FR-105, FR-121, FR-117): crash reports and extensions off tighten;
  // retention is capped by the policy's days (null keeps forever, the loosest).
  'privacy.crashReports': OFF,
  'sdk.enabled': OFF,
  'retention.threadsDays': { kind: 'cap' },
  'retention.runsDays': { kind: 'cap' },
  'retention.auditDays': { kind: 'cap' },
  'retention.artifactsDays': { kind: 'cap' },
  'retention.tracesDays': { kind: 'cap' },
  'plugins.trustedPublishers': { kind: 'publishers' },
  // The administrator chooses which model judges consequential actions under Auto (FR-085). It
  // cannot make Auto available where the policy turns it off (restrict.permissionModes).
  'review.model': { kind: 'pin' },
  // M8 apps (FR-222): registration only with the owner's session tightens.
  'apps.openRegistration': OFF,
  // Where opt-in crash reports go (FR-121): '' forbids sending anywhere, an address pins where
  // they go. Neither loosens privacy: nothing is sent unless the user turns crash reports on,
  // which policy can only turn off.
  'privacy.crashReportEndpoint': { kind: 'pin' },
  // How long a removed member's data waits before it is purged (decision 5): shorter is less
  // data kept, longer is a hold for export or review. Neither is safer for every organization,
  // so the administrator fixes the value; 0 (kept until the owner purges it) included.
  'team.removedMemberPurgeDays': { kind: 'pin' },
  // M8 sites (FR-037): publishing to remote hosting targets off tightens.
  'sites.remoteTargets': OFF,
};

export function ruleFor(key: string): TightenRule | null {
  return Object.hasOwn(SECURITY_RULES, key) ? SECURITY_RULES[key]! : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whether `v` has a place in the rule's order (a custom permission profile has none). */
export function comparable(rule: TightenRule, v: unknown): boolean {
  switch (rule.kind) {
    case 'bool':
      return typeof v === 'boolean';
    case 'order':
      return typeof v === 'string' && rule.order.includes(v);
    case 'min':
    case 'max':
      return typeof v === 'number' && Number.isFinite(v);
    case 'allow':
    case 'deny':
    case 'roots':
    case 'catalogs':
    case 'publishers':
      return Array.isArray(v);
    case 'cap':
      return v === null || (typeof v === 'number' && Number.isFinite(v));
    case 'pin':
      return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    case 'fields':
      return (
        isRecord(v) &&
        Object.entries(rule.fields).every(([f, r]) => v[f] === undefined || comparable(r, v[f]))
      );
  }
}

/**
 * Whether `a` permits more than `b` in some respect. Lists never do here: they are combined (an
 * allow list intersects, a deny list merges), so they cannot loosen.
 */
export function looser(rule: TightenRule, a: unknown, b: unknown): boolean {
  switch (rule.kind) {
    case 'bool':
      return a !== b && a !== rule.tight;
    case 'order': {
      const ia = rule.order.indexOf(a as string);
      const ib = rule.order.indexOf(b as string);
      return ia >= 0 && ib >= 0 && ia > ib;
    }
    case 'min':
      return typeof a === 'number' && typeof b === 'number' && a > b;
    case 'max':
      return typeof a === 'number' && typeof b === 'number' && a < b;
    case 'allow':
    case 'deny':
    case 'roots':
    case 'catalogs':
    case 'publishers':
    case 'pin':
      return false;
    case 'cap':
      return (
        (a === null && b !== null) || (typeof a === 'number' && typeof b === 'number' && a > b)
      );
    case 'fields':
      return (
        isRecord(a) &&
        isRecord(b) &&
        Object.entries(rule.fields).some(
          ([f, r]) => a[f] !== undefined && b[f] !== undefined && looser(r, a[f], b[f]),
        )
      );
  }
}

const key = (v: unknown) => JSON.stringify(v);

/** What pins a catalog: the key its index is signed with, the commit a Git catalog is read at. */
const CATALOG_PINS = ['publisherKey', 'commit'] as const;

/**
 * The tighter of the policy's value `m` and the user's `u` (the meet). Where `u` has no place in
 * the order (a custom profile), the policy's value wins: it is already no looser than the default.
 */
export function meet(rule: TightenRule, m: unknown, u: unknown): unknown {
  switch (rule.kind) {
    case 'bool':
      return m === rule.tight || u === rule.tight ? rule.tight : m;
    case 'order': {
      const im = rule.order.indexOf(m as string);
      const iu = rule.order.indexOf(u as string);
      return iu >= 0 && iu < im ? u : m;
    }
    case 'min':
      return typeof u === 'number' && typeof m === 'number' ? Math.min(m, u) : m;
    case 'max':
      return typeof u === 'number' && typeof m === 'number' ? Math.max(m, u) : m;
    case 'allow': {
      if (!Array.isArray(m) || !Array.isArray(u)) return m;
      const theirs = new Set(u.map(key));
      return m.filter((x) => theirs.has(key(x)));
    }
    case 'deny': {
      if (!Array.isArray(m) || !Array.isArray(u)) return m;
      const mine: unknown[] = m;
      const theirs: unknown[] = u;
      const seen = new Set(mine.map(key));
      return [...mine, ...theirs.filter((x) => !seen.has(key(x)))];
    }
    case 'roots': {
      if (!Array.isArray(m) || !Array.isArray(u)) return m;
      const out: unknown[] = [];
      for (const r of m) {
        if (!isRecord(r)) continue;
        const theirs = u.find((x) => isRecord(x) && x.path === r.path) as
          Record<string, unknown> | undefined;
        if (!theirs) continue;
        out.push({
          ...r,
          access: r.access === 'read' || theirs.access === 'read' ? 'read' : 'write',
        });
      }
      return out;
    }
    case 'catalogs': {
      if (!Array.isArray(m) || !Array.isArray(u)) return m;
      const out: unknown[] = [];
      for (const c of m as unknown[]) {
        if (!isRecord(c)) continue;
        const theirs = (u as unknown[]).find(
          (x) => isRecord(x) && x.id === c.id && x.location === c.location,
        );
        if (!isRecord(theirs)) continue;
        const merged: Record<string, unknown> = { ...c };
        let conflict = false;
        for (const pin of CATALOG_PINS) {
          if (c[pin] === undefined) {
            if (theirs[pin] !== undefined) merged[pin] = theirs[pin];
          } else if (theirs[pin] !== undefined && theirs[pin] !== c[pin]) conflict = true;
        }
        if (!conflict) out.push(merged);
      }
      return out;
    }
    case 'cap':
      if (m === null) return u === undefined ? m : u;
      return typeof u === 'number' && typeof m === 'number' ? Math.min(m, u) : m;
    case 'publishers': {
      if (!Array.isArray(m) || !Array.isArray(u)) return m;
      const theirs = new Set(
        (u as unknown[]).flatMap((x) => (isRecord(x) && typeof x.key === 'string' ? [x.key] : [])),
      );
      return (m as unknown[]).filter((x) => isRecord(x) && theirs.has(x.key as string));
    }
    case 'pin':
      return m;
    case 'fields': {
      if (!isRecord(m) || !isRecord(u)) return m;
      const out: Record<string, unknown> = { ...m };
      for (const [f, r] of Object.entries(rule.fields))
        if (m[f] !== undefined && u[f] !== undefined) out[f] = meet(r, m[f], u[f]);
      return out;
    }
  }
}

/** Why a policy's value for a security key cannot apply, or null when it can. */
export function securityValueProblem(
  settingKey: string,
  value: unknown,
): { reason: 'loosens' | 'unordered'; message: string } | null {
  const rule = ruleFor(settingKey);
  if (!rule || !comparable(rule, value))
    return {
      reason: 'unordered',
      message: `${settingKey} is security-relevant and Nova cannot tell whether this value tightens it, so managed policy cannot set it`,
    };
  if (isSettingKey(settingKey) && looser(rule, value, SETTINGS[settingKey].default))
    return {
      reason: 'loosens',
      message: `${settingKey}: managed policy can only tighten security settings, and this value is looser than the default`,
    };
  return null;
}

/**
 * The value a security key takes under the policy: the meet of the policy's value and the user's
 * (or the default). A meet the key's schema refuses (a merged list over its size limit) keeps the
 * policy's own value, which was checked on load.
 */
export function tightenSetting(settingKey: string, managed: unknown, user: unknown): unknown {
  const rule = ruleFor(settingKey);
  if (!rule || !isSettingKey(settingKey)) return managed;
  const d = SETTINGS[settingKey] as SettingDefinition;
  // A stored value that fails the schema resolves to the default (settings.ts), so does it here.
  let u: unknown = d.default;
  if (user !== undefined) {
    const parsed = d.schema.safeParse(user);
    if (parsed.success) u = parsed.data;
  }
  const out = meet(rule, managed, u);
  const checked = d.schema.safeParse(out);
  return checked.success ? checked.data : managed;
}
