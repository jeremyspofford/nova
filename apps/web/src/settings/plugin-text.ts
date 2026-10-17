// Plain words for plugins, skills and hooks (FR-045, FR-046, FR-197; docs/04 §2.10, docs/14 §5).
// A plugin's declared permissions are shown as sentences before anything is installed, and the
// same sentences are diffed on update, so a new permission is never a surprise.
import type { HookEvent, HookView, PluginView, SkillSource } from '@nova/shared';
import type { IconName } from '@nova/ui';

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The action classes of contracts/schemas/plugin-manifest.json. */
export const ACTION_TEXT: Record<string, string> = {
  read: 'read data',
  write: 'change data',
  send: 'send data or messages',
  delete: 'delete data',
  execute: 'run programs',
};

export const DEFAULT_TEXT: Record<string, string> = {
  allow: 'runs without asking',
  ask: 'asks you first',
  deny: 'is blocked',
};

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
  out.push(
    network.length
      ? `Reach these hosts on the network: ${network.join(', ')}`
      : 'No network access',
  );
  const fs = strings(permissions.fs);
  if (fs.length) out.push(`Use files at: ${fs.join(', ')}`);
  const secrets = strings(permissions.secrets);
  if (secrets.length) out.push(`Use these stored secrets: ${secrets.join(', ')}`);
  for (const [name, spec] of Object.entries(record(permissions.tools) ?? {})) {
    const s = record(spec);
    const action = typeof s?.action === 'string' ? (ACTION_TEXT[s.action] ?? s.action) : 'act';
    const d = typeof s?.default === 'string' ? DEFAULT_TEXT[s.default] : undefined;
    out.push(`Tool ${name} can ${action}${d ? `; it ${d}` : ''}`);
  }
  for (const [cls, d] of Object.entries(record(permissions.actionDefaults) ?? {})) {
    const text = typeof d === 'string' ? DEFAULT_TEXT[d] : undefined;
    if (text) out.push(`Its tools that ${ACTION_TEXT[cls] ?? cls}: ${text}`);
  }
  if (record(permissions.hooks)?.answersAsks === true)
    out.push('Its hooks may answer approval questions that your rules or tool defaults raise');
  const extensions = strings(permissions.browserExtensions);
  if (extensions.length)
    out.push(
      `Asks to install browser extensions (each needs your consent): ${extensions.join(', ')}`,
    );
  const ui = record(permissions.ui);
  const connect = strings(ui?.connectDomains);
  if (connect.length) out.push(`Its app screens may connect to: ${connect.join(', ')}`);
  const resource = strings(ui?.resourceDomains);
  if (resource.length) out.push(`Its app screens may load files from: ${resource.join(', ')}`);
  const frame = strings(ui?.frameDomains);
  if (frame.length) out.push(`Its app screens may embed pages from: ${frame.join(', ')}`);
  for (const k of Object.keys(permissions)) if (!KNOWN.has(k)) out.push(`Also asks for: ${k}`);
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

export const PLUGIN_STATUS: Record<
  PluginView['status'],
  { text: string; tone: string | null; icon: IconName }
> = {
  ok: { text: 'Ready', tone: 'ready', icon: 'check' },
  needs_trust: { text: 'Hooks need trust', tone: 'needs_input', icon: 'hand' },
  disabled: { text: 'Off', tone: null, icon: 'stop' },
  error: { text: 'Error', tone: 'blocked', icon: 'alert' },
};

export const SKILL_SOURCE_TEXT: Record<SkillSource, string> = {
  builtin: 'Built-in',
  user: 'Yours',
  project: 'Project',
  plugin: 'Plugin',
  managed: 'Managed',
  import: 'Imported',
};

/** Hook events in plain words (docs/04 §2.10). */
export const HOOK_EVENT_TEXT: Record<HookEvent, string> = {
  'session.start': 'When a session starts',
  'session.end': 'When a session ends',
  'prompt.submit': 'When you send a message',
  'tool.pre': 'Before tool use',
  'permission.request': 'When a tool asks for approval',
  'tool.post': 'After tool use',
  'compact.pre': 'Before compaction',
  'compact.post': 'After compaction',
  'subagent.start': 'When a sub-agent starts',
  'subagent.stop': 'When a sub-agent stops',
  stop: 'When a reply stops',
  interrupt: 'When you interrupt',
};

/** What a hook on each event can do (docs/08 §4.1, events and effects). */
export const HOOK_CAN_TEXT: Record<HookEvent, string> = {
  'session.start': 'add context',
  'session.end': 'only observe',
  'prompt.submit': 'add context, block the message (you see why)',
  'tool.pre': 'block this tool call, add context',
  'permission.request': 'answer an eligible approval question with allow or deny, add context',
  'tool.post': 'add context',
  'compact.pre': 'add compaction instructions',
  'compact.post': 'add context',
  'subagent.start': 'add context to the sub-agent',
  'subagent.stop': 'add context to the parent',
  stop: 'ask once to continue, within the run budget',
  interrupt: 'only observe',
};

export const HOOK_CANNOT_TEXT =
  'override built-in safety, managed policy or a deny, change tool arguments or results, or read secrets';

export const HOOK_STATUS: Record<
  HookView['status'],
  { text: string; tone: string | null; icon: IconName }
> = {
  trusted: { text: 'Trusted', tone: 'ready', icon: 'check' },
  needs_trust: { text: 'Needs trust', tone: 'needs_input', icon: 'hand' },
  disabled: { text: 'Disabled', tone: null, icon: 'stop' },
  revoked: { text: 'Trust revoked', tone: 'blocked', icon: 'stop' },
};

export const HOOK_EFFECT_TEXT: Record<NonNullable<HookView['lastRun']>['effect'], string> = {
  none: 'no effect',
  context: 'added context',
  decision: 'answered an approval',
  continue: 'asked to continue',
  blocked: 'blocked',
  error: 'failed',
};

export function hookSourceText(h: Pick<HookView, 'source' | 'pluginId'>): string {
  switch (h.source) {
    case 'managed':
      return 'Managed by your organization';
    case 'user':
      return 'Your hooks file';
    case 'project':
      return 'A project hook file';
    case 'plugin':
      return h.pluginId ? `Plugin ${h.pluginId}` : 'A plugin';
    case 'extension':
      return 'An extension';
  }
}

/** What the hook runs: its argv, or the MCP tool it calls. */
export function hookHandlerText(h: Pick<HookView, 'handler'>): string {
  return h.handler.type === 'command' ? h.handler.command.join(' ') : `MCP tool ${h.handler.tool}`;
}

/** `sha256:9f2c…41ab`: enough to compare by eye; the full hash is shown where it is trusted. */
export function shortHash(hash: string): string {
  const colon = hash.indexOf(':');
  const algo = colon > 0 ? hash.slice(0, colon + 1) : '';
  const hex = colon > 0 ? hash.slice(colon + 1) : hash;
  return hex.length > 12 ? `${algo}${hex.slice(0, 4)}…${hex.slice(-4)}` : hash;
}

/** "30 s", "2 min", "1 min 30 s". */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}
