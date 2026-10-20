// The content hash a hook is trusted by (FR-197, docs/08 §4.1): SHA-256 over the canonical JSON of
// its definition plus the bytes of every script it runs that sits inside its folder (plugin or
// project). Editing the definition or the script changes the hash, so the hook needs trust again.
// A plugin hook's hash also covers the digest of the plugin's files, as an SDK hook's covers its
// bundle: a script can import helpers its command line never names, so an update that changes any
// file a hook could load needs trust again (M8 supply review #6). Left out are the files the Hub
// reads itself and shows apart: the manifest, its hooks file (each hook's own definition is in its
// hash), its role and command files, and the commands the installer writes. So an update that only
// bumps the version or adds a role keeps the trust of hooks it did not touch.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { canonicalJson } from '../nodes/crypto.ts';
import { reallyInside, resolveInside, treeDigest, walkTree } from './paths.ts';
import type { PluginHookConfig } from './types.ts';

/**
 * The argv entries of a command hook that name files inside `root` (relative paths or
 * `${pluginRoot}/…`), in order and without duplicates.
 */
export function pluginHookScriptPaths(hook: PluginHookConfig, root: string): string[] {
  if (hook.handler.type !== 'command') return [];
  const out: string[] = [];
  for (const arg of [...hook.handler.command, ...(hook.handler.windowsCommand ?? [])]) {
    if (!arg || arg.startsWith('-')) continue;
    let full: string;
    try {
      full = resolveInside(root, arg);
    } catch {
      continue;
    }
    try {
      if (!existsSync(full) || !statSync(full).isFile() || !reallyInside(root, full)) continue;
    } catch {
      continue;
    }
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

/** Folders that are not the plugin's own content: written by the installer from its commands. */
const CONVERTED = '.nova-plugin/commands/';
const MANIFEST = '.nova-plugin/plugin.json';
const TREE_CACHE_MAX = 200;
/**
 * Tree digests by folder, with a stamp of every file's size and times: dispatches re-hash hooks
 * every time, so an unchanged folder is not read again (a change of any file changes the stamp).
 */
const treeCache = new Map<string, { stamp: string; digest: string }>();

/** A manifest path as a tree path (`./agents/a.md` → `agents/a.md`); null when it leaves. */
function treePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  return n.startsWith('../') || n.startsWith('/') ? null : n;
}

/** The files the Hub reads itself and shows apart: the manifest and what it names as data. */
function shownApart(root: string): Set<string> {
  const out = new Set([MANIFEST]);
  let m: { hooks?: unknown; agents?: unknown; commands?: unknown };
  try {
    m = JSON.parse(readFileSync(join(root, ...MANIFEST.split('/')), 'utf8')) as typeof m;
  } catch {
    return out;
  }
  for (const p of [
    m.hooks,
    ...(Array.isArray(m.agents) ? (m.agents as unknown[]) : []),
    ...(Array.isArray(m.commands) ? (m.commands as unknown[]) : []),
  ]) {
    const t = treePath(p);
    if (t) out.add(t);
  }
  return out;
}

/**
 * The digest of the plugin files a hook could load: every file but the converted commands and
 * the files the Hub reads itself (see the header).
 */
export function pluginTreeDigest(root: string): string {
  const all = walkTree(root);
  const stamp = all
    .map((e) => {
      const st = statSync(e.source);
      return `${e.path}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;
    })
    .join('\n');
  const hit = treeCache.get(root);
  if (hit?.stamp === stamp) return hit.digest;
  const apart = shownApart(root);
  const digest = treeDigest(all.filter((e) => !e.path.startsWith(CONVERTED) && !apart.has(e.path)));
  treeCache.delete(root);
  treeCache.set(root, { stamp, digest });
  if (treeCache.size > TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value!);
  return digest;
}

/**
 * `sha256:<hex>` for a hook definition, the scripts it runs inside `root`, and the digest of the
 * files in `root` (the plugin folder) a hook could load.
 */
export function pluginHookContentHash(hook: PluginHookConfig, root: string): string {
  const h = createHash('sha256');
  h.update(canonicalJson(hook));
  for (const file of pluginHookScriptPaths(hook, root)) {
    h.update('\0');
    h.update(readFileSync(file));
  }
  h.update('\0tree\0');
  h.update(pluginTreeDigest(root));
  return `sha256:${h.digest('hex')}`;
}

/** Replace `${pluginRoot}` with the installed folder (docs/08 §3.1). */
export function expandPluginRoot(value: string, root: string): string {
  return value.split('${pluginRoot}').join(root);
}
