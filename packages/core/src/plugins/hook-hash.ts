// The content hash a hook is trusted by (FR-197, docs/08 §4.1): SHA-256 over the canonical JSON of
// its definition plus the bytes of every script it runs that sits inside its folder (plugin or
// project). Editing the definition or the script changes the hash, so the hook needs trust again.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { canonicalJson } from '../nodes/crypto.ts';
import { reallyInside, resolveInside } from './paths.ts';
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

/** `sha256:<hex>` for a hook definition and the scripts it runs inside `root`. */
export function pluginHookContentHash(hook: PluginHookConfig, root: string): string {
  const h = createHash('sha256');
  h.update(canonicalJson(hook));
  for (const file of pluginHookScriptPaths(hook, root)) {
    h.update('\0');
    h.update(readFileSync(file));
  }
  return `sha256:${h.digest('hex')}`;
}

/** Replace `${pluginRoot}` with the installed folder (docs/08 §3.1). */
export function expandPluginRoot(value: string, root: string): string {
  return value.split('${pluginRoot}').join(root);
}
