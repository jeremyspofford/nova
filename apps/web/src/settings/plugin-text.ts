// Plain words for plugins, skills and hooks (FR-045, FR-046, FR-197; docs/04 §2.10, docs/14 §5).
// A plugin's declared permissions are shown as sentences before anything is installed, and the
// same sentences are diffed on update, so a new permission is never a surprise. Messages (FR-016):
// each read translates in the active locale.
import { defineMessages, fmt, subscribe } from '@nova/i18n';
import type { HookEvent, HookView, PluginView, SkillSource } from '@nova/shared';
import type { IconName } from '@nova/ui';

export const PLUGIN_TEXT = defineMessages('settings.pluginText', {
  reachHosts: 'Reach these hosts on the network: {hosts}',
  noNetwork: 'No network access',
  filesAt: 'Use files at: {paths}',
  secretsUsed: 'Use these stored secrets: {names}',
  /** A tool's declared action class (contracts/schemas/plugin-manifest.json). */
  toolCan:
    'Tool {name} can {action, select, read {read data} write {change data} send {send data or messages} delete {delete data} execute {run programs} none {act} other {{actionId}}}',
  /** …and its default decision. */
  toolCanDefault:
    'Tool {name} can {action, select, read {read data} write {change data} send {send data or messages} delete {delete data} execute {run programs} none {act} other {{actionId}}}; it {decision, select, allow {runs without asking} ask {asks you first} other {is blocked}}',
  actionDefault:
    'Its tools that {action, select, read {read data} write {change data} send {send data or messages} delete {delete data} execute {run programs} none {act} other {{actionId}}}: {decision, select, allow {runs without asking} ask {asks you first} other {is blocked}}',
  answersAsks: 'Its hooks may answer approval questions that your rules or tool defaults raise',
  browserExtensions: 'Asks to install browser extensions (each needs your consent): {names}',
  connectTo: 'Its app screens may connect to: {domains}',
  loadFrom: 'Its app screens may load files from: {domains}',
  embedFrom: 'Its app screens may embed pages from: {domains}',
  alsoAsks: 'Also asks for: {name}',
  pluginStatus: {
    ok: 'Ready',
    needs_trust: 'Hooks need trust',
    disabled: 'Off',
    error: 'Error',
  },
  skillSource: {
    builtin: 'Built-in',
    user: 'Yours',
    project: 'Project',
    plugin: 'Plugin',
    managed: 'Managed',
    import: 'Imported',
  },
  /** Hook events in plain words (docs/04 §2.10). */
  hookEvent: {
    sessionStart: 'When a session starts',
    sessionEnd: 'When a session ends',
    promptSubmit: 'When you send a message',
    toolPre: 'Before tool use',
    permissionRequest: 'When a tool asks for approval',
    toolPost: 'After tool use',
    compactPre: 'Before compaction',
    compactPost: 'After compaction',
    subagentStart: 'When a sub-agent starts',
    subagentStop: 'When a sub-agent stops',
    stop: 'When a reply stops',
    interrupt: 'When you interrupt',
  },
  /** What a hook on each event can do (docs/08 §4.1, events and effects). */
  hookCan: {
    sessionStart: 'add context',
    sessionEnd: 'only observe',
    promptSubmit: 'add context, block the message (you see why)',
    toolPre: 'block this tool call, add context',
    permissionRequest: 'answer an eligible approval question with allow or deny, add context',
    toolPost: 'add context',
    compactPre: 'add compaction instructions',
    compactPost: 'add context',
    subagentStart: 'add context to the sub-agent',
    subagentStop: 'add context to the parent',
    stop: 'ask once to continue, within the run budget',
    interrupt: 'only observe',
  },
  hookCannot:
    'override built-in safety, managed policy or a deny, change tool arguments or results, or ' +
    'read secrets',
  hookStatus: {
    trusted: 'Trusted',
    needs_trust: 'Needs trust',
    disabled: 'Disabled',
    revoked: 'Trust revoked',
  },
  hookEffect: {
    none: 'no effect',
    context: 'added context',
    decision: 'answered an approval',
    continue: 'asked to continue',
    blocked: 'blocked',
    error: 'failed',
  },
  hookSource: {
    managed: 'Managed by your organization',
    user: 'Your hooks file',
    project: 'A project hook file',
    plugin: 'Plugin {id}',
    aPlugin: 'A plugin',
    extension: 'An extension',
  },
  mcpTool: 'MCP tool {tool}',
});
const S = PLUGIN_TEXT;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The default decisions a manifest may declare. */
const DECISIONS = new Set(['allow', 'ask', 'deny']);

/** Hosts, paths or names as the manifest lists them, joined the locale's way. */
const join = (items: string[]) => fmt.list(items, { type: 'unit' });

const KNOWN = new Set([
  'network',
  'fs',
  'secrets',
  'tools',
  'actionDefaults',
  'hooks',
  'browserExtensions',
  'ui',
]);

/** The manifest's `permissions` block as one sentence per grant. */
export function permissionLines(permissions: Record<string, unknown>): string[] {
  const out: string[] = [];
  const network = strings(permissions.network);
  out.push(network.length ? S.reachHosts({ hosts: join(network) }) : S.noNetwork);
  const fs = strings(permissions.fs);
  if (fs.length) out.push(S.filesAt({ paths: join(fs) }));
  const secrets = strings(permissions.secrets);
  if (secrets.length) out.push(S.secretsUsed({ names: join(secrets) }));
  for (const [name, spec] of Object.entries(record(permissions.tools) ?? {})) {
    const s = record(spec);
    const action = typeof s?.action === 'string' ? s.action : 'none';
    const decision = typeof s?.default === 'string' && DECISIONS.has(s.default) ? s.default : null;
    out.push(
      decision
        ? S.toolCanDefault({ name, action, actionId: action, decision })
        : S.toolCan({ name, action, actionId: action }),
    );
  }
  for (const [cls, d] of Object.entries(record(permissions.actionDefaults) ?? {})) {
    if (typeof d === 'string' && DECISIONS.has(d))
      out.push(S.actionDefault({ action: cls, actionId: cls, decision: d }));
  }
  if (record(permissions.hooks)?.answersAsks === true) out.push(S.answersAsks);
  const extensions = strings(permissions.browserExtensions);
  if (extensions.length) out.push(S.browserExtensions({ names: join(extensions) }));
  const ui = record(permissions.ui);
  const connect = strings(ui?.connectDomains);
  if (connect.length) out.push(S.connectTo({ domains: join(connect) }));
  const resource = strings(ui?.resourceDomains);
  if (resource.length) out.push(S.loadFrom({ domains: join(resource) }));
  const frame = strings(ui?.frameDomains);
  if (frame.length) out.push(S.embedFrom({ domains: join(frame) }));
  for (const k of Object.keys(permissions)) if (!KNOWN.has(k)) out.push(S.alsoAsks({ name: k }));
  return out;
}

/** What an update changes in the permission sentences (docs/14 §5: the permission diff). */
export function permissionDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { added: string[]; removed: string[] } {
  const a = permissionLines(before);
  const b = permissionLines(after);
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

/** -1, 0 or 1 for two `x.y.z(-pre)` versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const dash = v.indexOf('-');
    const main = (dash < 0 ? v : v.slice(0, dash)).split('.').map((n) => Number.parseInt(n, 10));
    return { main, pre: dash < 0 ? null : v.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const p = x.main[i] ?? 0;
    const q = y.main[i] ?? 0;
    if (Number.isNaN(p) || Number.isNaN(q)) return a.localeCompare(b);
    if (p !== q) return p < q ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** A status chip: its words (read in the active locale), tone and icon. */
function chip(text: () => string, tone: string | null, icon: IconName) {
  return {
    get text() {
      return text();
    },
    tone,
    icon,
  };
}

export const PLUGIN_STATUS: Record<
  PluginView['status'],
  { readonly text: string; tone: string | null; icon: IconName }
> = {
  ok: chip(() => S.pluginStatus.ok, 'ready', 'check'),
  needs_trust: chip(() => S.pluginStatus.needs_trust, 'needs_input', 'hand'),
  disabled: chip(() => S.pluginStatus.disabled, null, 'stop'),
  error: chip(() => S.pluginStatus.error, 'blocked', 'alert'),
};

export const SKILL_SOURCE_TEXT: Readonly<Record<SkillSource, string>> = S.skillSource;

/** Message keys cannot hold dots, so hook events map to keys. */
const EVENT_KEY = {
  'session.start': 'sessionStart',
  'session.end': 'sessionEnd',
  'prompt.submit': 'promptSubmit',
  'tool.pre': 'toolPre',
  'permission.request': 'permissionRequest',
  'tool.post': 'toolPost',
  'compact.pre': 'compactPre',
  'compact.post': 'compactPost',
  'subagent.start': 'subagentStart',
  'subagent.stop': 'subagentStop',
  stop: 'stop',
  interrupt: 'interrupt',
} as const satisfies Record<HookEvent, keyof typeof S.hookEvent>;

/** A message group keyed by hook event; each read translates in the active locale. */
function byEvent(group: Readonly<Record<keyof typeof S.hookEvent, string>>) {
  const out = {};
  for (const [event, key] of Object.entries(EVENT_KEY))
    Object.defineProperty(out, event, { get: () => group[key], enumerable: true });
  return Object.freeze(out) as Readonly<Record<HookEvent, string>>;
}

/** Hook events in plain words (docs/04 §2.10). */
export const HOOK_EVENT_TEXT = byEvent(S.hookEvent);

/** What a hook on each event can do (docs/08 §4.1, events and effects). */
export const HOOK_CAN_TEXT = byEvent(S.hookCan);

/**
 * What no hook can do, in the active locale: a live binding (read it at render; a copy taken at
 * load keeps the language it was taken in).
 */
export let HOOK_CANNOT_TEXT = S.hookCannot;
subscribe(() => {
  HOOK_CANNOT_TEXT = S.hookCannot;
});

export const HOOK_STATUS: Record<
  HookView['status'],
  { readonly text: string; tone: string | null; icon: IconName }
> = {
  trusted: chip(() => S.hookStatus.trusted, 'ready', 'check'),
  needs_trust: chip(() => S.hookStatus.needs_trust, 'needs_input', 'hand'),
  disabled: chip(() => S.hookStatus.disabled, null, 'stop'),
  revoked: chip(() => S.hookStatus.revoked, 'blocked', 'stop'),
};

export const HOOK_EFFECT_TEXT: Readonly<
  Record<NonNullable<HookView['lastRun']>['effect'], string>
> = S.hookEffect;

export function hookSourceText(h: Pick<HookView, 'source' | 'pluginId'>): string {
  switch (h.source) {
    case 'managed':
      return S.hookSource.managed;
    case 'user':
      return S.hookSource.user;
    case 'project':
      return S.hookSource.project;
    case 'plugin':
      return h.pluginId ? S.hookSource.plugin({ id: h.pluginId }) : S.hookSource.aPlugin;
    case 'extension':
      return S.hookSource.extension;
  }
}

/** What the hook runs: its argv, or the MCP tool it calls. */
export function hookHandlerText(h: Pick<HookView, 'handler'>): string {
  return h.handler.type === 'command'
    ? h.handler.command.join(' ')
    : S.mcpTool({ tool: h.handler.tool });
}

/** `sha256:9f2c…41ab`: enough to compare by eye; the full hash is shown where it is trusted. */
export function shortHash(hash: string): string {
  const colon = hash.indexOf(':');
  const algo = colon > 0 ? hash.slice(0, colon + 1) : '';
  const hex = colon > 0 ? hash.slice(colon + 1) : hash;
  return hex.length > 12 ? `${algo}${hex.slice(0, 4)}…${hex.slice(-4)}` : hash;
}

/** "30 s", "2 min", "1 min 30 s", in the active locale. */
export function formatSeconds(totalSeconds: number): string {
  return fmt.duration(Math.max(0, Math.round(totalSeconds)) * 1000);
}
