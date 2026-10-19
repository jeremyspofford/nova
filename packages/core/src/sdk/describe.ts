// What an extension may do, in plain words, for the install preview, the update diff and the
// extension's settings page (docs/14 §5, docs/26 §3: the permission preview is mandatory). Each
// line has a stable key, so two versions can be compared line by line.
import type { ExtensionPermissionLine } from '@nova/shared';
import type { PluginManifest } from '../plugins/types.ts';
import {
  EXTENSION_DATA_VAR,
  EXTENSION_ROOT_VAR,
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

/** Every permission of an extension and its plugin, as lines in plain words. */
export function extensionPermissionLines(
  m: ExtensionManifest,
  plugin: PluginManifest,
): ExtensionPermissionLine[] {
  const out: ExtensionPermissionLine[] = [];
  const p = m.permissions;
  for (const host of p.network ?? [])
    out.push({
      key: `network:${host}`,
      kind: 'network',
      text: host === '*' ? 'Reach any host on the network' : `Reach ${host} over the network`,
      sensitive: true,
    });
  for (const s of p.fs ?? []) {
    const path = typeof s === 'string' ? s : s.path;
    const write = typeof s === 'string' ? path === EXTENSION_DATA_VAR : s.write === true;
    const where =
      path === EXTENSION_DATA_VAR
        ? 'its own data folder'
        : path === EXTENSION_ROOT_VAR
          ? 'its own files'
          : path;
    out.push({
      key: `fs:${path}:${write ? 'rw' : 'r'}`,
      kind: 'fs',
      text: `${write ? 'Read and write' : 'Read'} ${where}`,
      sensitive: path !== EXTENSION_DATA_VAR && path !== EXTENSION_ROOT_VAR,
    });
  }
  for (const name of p.secrets ?? [])
    out.push({
      key: `secret:${name}`,
      kind: 'secret',
      text: `Read the secret "${name}" you store for it`,
      sensitive: true,
    });
  for (const id of p.commands ?? [])
    out.push({
      key: `command:${id}`,
      kind: 'command',
      text: `Add the command ${id}`,
      sensitive: false,
    });
  for (const panel of p.panels ?? []) {
    const domains = [
      ...(panel.connectDomains ?? []),
      ...(panel.resourceDomains ?? []),
      ...(panel.frameDomains ?? []),
    ];
    out.push({
      key: `panel:${panel.id}:${panel.entryPoint}`,
      kind: 'panel',
      text: `Show the panel "${panel.title}" (${panel.entryPoint})${domains.length ? `, which may reach ${[...new Set(domains)].join(', ')}` : ''}`,
      sensitive: domains.length > 0,
    });
  }
  const defaults = { ...(plugin.permissions.actionDefaults ?? {}), ...(p.actionDefaults ?? {}) };
  for (const [name, t] of Object.entries(p.tools ?? {})) {
    const d = t.default ?? defaults[t.action] ?? 'ask';
    out.push({
      key: `tool:${name}:${t.action}:${d}`,
      kind: 'tool',
      text: `Offer the tool ${name} to models (${ACTION_TEXT[t.action]}; ${DEFAULT_TEXT[d]})`,
      sensitive: t.action !== 'read' || d === 'allow',
    });
  }
  for (const h of p.hooks ?? []) {
    const matcher = h.matcher === undefined ? '' : ` for ${[h.matcher].flat().join(', ')}`;
    out.push({
      key: `hook:${h.id}:${h.event}`,
      kind: 'hook',
      text: `Run the hook ${h.id} at ${h.event}${matcher} (after you trust it)`,
      sensitive: true,
    });
  }
  for (const e of p.events ?? [])
    out.push({
      key: `event:${resolveEventName(e)}`,
      kind: 'event',
      text: `Observe ${resolveEventName(e)} events`,
      sensitive: false,
    });
  // What the plugin part brings beyond the SDK part.
  const pp = plugin.permissions;
  for (const host of pp.network ?? [])
    out.push({
      key: `plugin.network:${host}`,
      kind: 'plugin',
      text: `Its plugin servers and hooks may reach ${host}`,
      sensitive: true,
    });
  for (const path of pp.fs ?? [])
    out.push({
      key: `plugin.fs:${path}`,
      kind: 'plugin',
      text: `Its plugin may use ${path}`,
      sensitive: true,
    });
  for (const name of pp.secrets ?? [])
    out.push({
      key: `plugin.secret:${name}`,
      kind: 'plugin',
      text: `Its plugin asks for the secret "${name}"`,
      sensitive: true,
    });
  for (const key of Object.keys(plugin.mcpServers ?? {}))
    out.push({
      key: `plugin.server:${key}`,
      kind: 'plugin',
      text: `Start the MCP server ${key} on this Hub`,
      sensitive: true,
    });
  if (pp.hooks?.answersAsks)
    out.push({
      key: 'plugin.answersAsks',
      kind: 'plugin',
      text: 'Its plugin hooks may answer approval questions your rules raise',
      sensitive: true,
    });
  return out;
}

/** What a new version adds and drops, by line key (docs/14 §5 permission diff). */
export function extensionPermissionDiff(
  before: readonly ExtensionPermissionLine[],
  after: readonly ExtensionPermissionLine[],
): { added: ExtensionPermissionLine[]; removed: ExtensionPermissionLine[] } {
  const was = new Set(before.map((l) => l.key));
  const now = new Set(after.map((l) => l.key));
  return {
    added: after.filter((l) => !was.has(l.key)),
    removed: before.filter((l) => !now.has(l.key)),
  };
}
