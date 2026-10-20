// What an extension may do, in plain words, for the install preview, the update diff and the
// extension's settings page (docs/14 §5, docs/26 §3: the permission preview is mandatory). Each
// line has a stable `key` (what it is) and a `detail` (what can change under that key: a tool's
// action and default, a server's command line and approval default, a hook's handler), so two
// versions compare as added, removed and changed lines. Both parts are listed: the SDK part
// (extension.json) and the plugin part (plugin.json: its tools and defaults, MCP servers, hooks,
// roles, UI and browser extensions), since an update may change either (M8 supply review #2).
import type { ExtensionPermissionLine } from '@nova/shared';
import { canonicalJson } from '../nodes/crypto.ts';
import type { PluginManifest } from '../plugins/types.ts';
import {
  EXTENSION_DATA_VAR,
  EXTENSION_ROOT_VAR,
  observableEventsFor,
  resolveEventName,
  type ExtensionManifest,
} from './manifest.ts';

const ACTION_TEXT: Record<string, string> = {
  read: 'reads',
  write: 'changes things',
  send: 'sends to others',
  delete: 'deletes',
  execute: 'runs programs',
};

const DEFAULT_TEXT: Record<string, string> = {
  allow: 'allowed without asking',
  ask: 'asks you first',
  deny: 'refused',
};

/** The plugin parts a manifest only names by path: its hooks (from a hooks file) and roles. */
export interface PluginParts {
  hooks?: readonly {
    id: string;
    event: string;
    matcher?: string | string[];
    handler: unknown;
    failClosed?: boolean;
  }[];
  roles?: readonly { key: string; tools: readonly string[]; modelHint: string | null }[];
}

/** A canonical JSON detail with the undefined fields left out. */
function detail(value: Record<string, unknown>): string {
  return canonicalJson(
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)),
  );
}

/** Whether observing an event pattern lets an extension see what people write (sensitive). */
function readsConversations(pattern: string): boolean {
  return observableEventsFor(pattern).some((e) => e.startsWith('chat.message.'));
}

/** Every permission of an extension and its plugin, as lines in plain words. */
export function extensionPermissionLines(
  m: ExtensionManifest,
  plugin: PluginManifest,
  parts: PluginParts = {},
): ExtensionPermissionLine[] {
  const out: ExtensionPermissionLine[] = [];
  const line = (
    key: string,
    kind: ExtensionPermissionLine['kind'],
    text: string,
    sensitive: boolean,
    d: string | null = null,
  ) => out.push({ key, kind, text, sensitive, detail: d });
  const p = m.permissions;

  // ---- the SDK part (extension.json) ----
  for (const host of p.network ?? [])
    line(
      `network:${host}`,
      'network',
      host === '*' ? 'Reach any host on the network' : `Reach ${host} over the network`,
      true,
    );
  for (const s of p.fs ?? []) {
    const path = typeof s === 'string' ? s : s.path;
    const write = typeof s === 'string' ? path === EXTENSION_DATA_VAR : s.write === true;
    const own = path === EXTENSION_DATA_VAR || path === EXTENSION_ROOT_VAR;
    const where =
      path === EXTENSION_DATA_VAR
        ? 'its own data folder'
        : path === EXTENSION_ROOT_VAR
          ? 'its own files'
          : path;
    line(
      `fs:${path}`,
      'fs',
      `${write ? 'Read and write' : 'Read'} ${where}`,
      !own,
      write ? 'rw' : 'r',
    );
  }
  for (const name of p.secrets ?? [])
    line(`secret:${name}`, 'secret', `Read the secret "${name}" you store for it`, true);
  for (const id of p.commands ?? [])
    line(`command:${id}`, 'command', `Add the command ${id}`, false);
  for (const panel of p.panels ?? []) {
    const domains = [
      ...(panel.connectDomains ?? []),
      ...(panel.resourceDomains ?? []),
      ...(panel.frameDomains ?? []),
    ];
    line(
      `panel:${panel.id}`,
      'panel',
      `Show the panel "${panel.title}" (${panel.entryPoint})${domains.length ? `, which may reach ${[...new Set(domains)].join(', ')}` : ''}`,
      domains.length > 0,
      detail({
        entryPoint: panel.entryPoint,
        resource: panel.resource,
        file: panel.file,
        extensions: panel.extensions,
        connectDomains: panel.connectDomains,
        resourceDomains: panel.resourceDomains,
        frameDomains: panel.frameDomains,
      }),
    );
  }
  const defaults = { ...(plugin.permissions.actionDefaults ?? {}), ...(p.actionDefaults ?? {}) };
  for (const [name, t] of Object.entries(p.tools ?? {})) {
    const d = t.default ?? defaults[t.action] ?? 'ask';
    line(
      `tool:${name}`,
      'tool',
      `Offer the tool ${name} to models (${ACTION_TEXT[t.action]}; ${DEFAULT_TEXT[d]})`,
      t.action !== 'read' || d === 'allow',
      `${t.action}:${d}`,
    );
  }
  for (const [action, effect] of Object.entries(p.actionDefaults ?? {}))
    line(
      `action_default:${action}`,
      'action_default',
      `Its tools that ${ACTION_TEXT[action] ?? action}: ${DEFAULT_TEXT[effect] ?? effect}`,
      effect === 'allow' && action !== 'read',
      effect,
    );
  for (const h of p.hooks ?? []) {
    const matcher = h.matcher === undefined ? '' : ` for ${[h.matcher].flat().join(', ')}`;
    line(
      `hook:${h.id}`,
      'hook',
      `Run the hook ${h.id} at ${h.event}${matcher} (after you trust it)`,
      true,
      detail({
        event: h.event,
        matcher: h.matcher,
        failClosed: h.failClosed,
        timeoutMs: h.timeoutMs,
      }),
    );
  }
  for (const e of p.events ?? []) {
    const name = resolveEventName(e);
    const chats = readsConversations(e);
    line(
      `event:${name}`,
      'event',
      chats ? `Observe ${name} events (it sees your conversations)` : `Observe ${name} events`,
      chats,
    );
  }

  // ---- the plugin part (plugin.json) ----
  const pp = plugin.permissions;
  for (const host of pp.network ?? [])
    line(
      `plugin.network:${host}`,
      'network',
      `Its plugin servers and hooks may reach ${host}`,
      true,
    );
  for (const path of pp.fs ?? [])
    line(`plugin.fs:${path}`, 'fs', `Its plugin may use ${path}`, true);
  for (const name of pp.secrets ?? [])
    line(`plugin.secret:${name}`, 'secret', `Its plugin asks for the secret "${name}"`, true);
  for (const [name, t] of Object.entries(pp.tools ?? {})) {
    const d = t.default ?? pp.actionDefaults?.[t.action] ?? 'ask';
    line(
      `plugin.tool:${name}`,
      'tool',
      `Its plugin's tool ${name} (${ACTION_TEXT[t.action]}; ${DEFAULT_TEXT[d]})`,
      t.action !== 'read' || d === 'allow',
      `${t.action}:${d}`,
    );
  }
  for (const [action, effect] of Object.entries(pp.actionDefaults ?? {}))
    line(
      `plugin.action_default:${action}`,
      'action_default',
      `Its plugin's tools that ${ACTION_TEXT[action] ?? action}: ${DEFAULT_TEXT[effect] ?? effect}`,
      effect === 'allow' && action !== 'read',
      effect,
    );
  for (const [key, c] of Object.entries(plugin.mcpServers ?? {})) {
    const run = c.transport === 'stdio' ? [c.command ?? '', ...(c.args ?? [])].join(' ') : c.url;
    line(
      `plugin.server:${key}`,
      'mcp_server',
      `Start the MCP server ${key} on this Hub${run ? ` (${run})` : ''}${c.defaultApproval ? `; its tools: ${DEFAULT_TEXT[c.defaultApproval]}` : ''}`,
      true,
      // The marketplace's shape for a plain plugin's server (market/permissions.ts), so the web
      // shows both alike: what runs or where it connects, and how its tools are approved.
      JSON.stringify({
        transport: c.transport ?? null,
        command: c.command ?? null,
        url: c.url ?? null,
        args: c.args ?? [],
        defaultApproval: c.defaultApproval ?? null,
        policy: c.policy ?? null,
        enabledTools: c.enabledTools ?? null,
        disabledTools: c.disabledTools ?? [],
      }),
    );
  }
  if (pp.hooks?.answersAsks)
    line(
      'plugin.answersAsks',
      'hooks_answer_asks',
      'Its plugin hooks may answer approval questions your rules raise',
      true,
    );
  for (const h of parts.hooks ?? []) {
    const handler = h.handler as { type?: string; command?: string[]; tool?: string };
    const what =
      handler.type === 'command'
        ? `runs ${(handler.command ?? []).join(' ')}`
        : `calls ${handler.tool ?? 'a tool'}`;
    line(
      `plugin.hook:${h.id}`,
      'hook',
      `Its plugin hook ${h.id} at ${h.event} ${what} (after you trust it)`,
      true,
      detail({ event: h.event, matcher: h.matcher, handler: h.handler, failClosed: h.failClosed }),
    );
  }
  for (const r of parts.roles ?? [])
    line(
      `plugin.role:${r.key}`,
      'role',
      `Adds the sub-agent role ${r.key}${r.tools.length ? ` (tools: ${r.tools.join(', ')})` : ''}`,
      r.tools.length > 0,
      detail({ tools: [...r.tools], modelHint: r.modelHint }),
    );
  for (const e of plugin.ui?.entryPoints ?? [])
    line(
      `plugin.ui:${e.kind}:${e.resource}`,
      'ui_entry',
      `Shows ${e.title ?? e.resource} (${e.kind})`,
      false,
      detail({ title: e.title, extensions: e.extensions }),
    );
  for (const field of ['connectDomains', 'resourceDomains', 'frameDomains'] as const)
    for (const d of pp.ui?.[field] ?? [])
      line(`plugin.ui_domain:${field}:${d}`, 'ui_domain', `Its plugin's UI may reach ${d}`, true);
  for (const b of plugin.browserExtensions ?? [])
    line(
      `plugin.browser_extension:${b.id}`,
      'browser_extension',
      `Asks to install the browser extension ${b.id} (with your separate consent)`,
      true,
      detail({ path: b.path, browsers: b.browsers, hosts: b.hosts }),
    );
  return out;
}

export interface ExtensionPermissionChange {
  key: string;
  text: string;
  before: string | null;
  after: string | null;
}

/**
 * What a new version adds, drops and changes, by line key and detail (docs/14 §5 permission
 * diff). Anything added or changed needs the owner's acceptance in the marketplace.
 */
export function extensionPermissionDiff(
  before: readonly ExtensionPermissionLine[],
  after: readonly ExtensionPermissionLine[],
): {
  added: ExtensionPermissionLine[];
  removed: ExtensionPermissionLine[];
  changed: ExtensionPermissionChange[];
} {
  const was = new Map(before.map((l) => [l.key, l]));
  const now = new Set(after.map((l) => l.key));
  const changed: ExtensionPermissionChange[] = [];
  for (const l of after) {
    const b = was.get(l.key);
    if (b && (b.detail ?? null) !== (l.detail ?? null))
      changed.push({ key: l.key, text: l.text, before: b.detail ?? null, after: l.detail ?? null });
  }
  return {
    added: after.filter((l) => !was.has(l.key)),
    removed: before.filter((l) => !now.has(l.key)),
    changed,
  };
}
