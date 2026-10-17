// Permission profiles (FR-190, docs/12 §7.1, contracts/schemas/permission-profile.json): filesystem
// entries on paths or tokens plus a network block. Built-ins: read-only, workspace, full (`full`
// only inside a VM or container substrate). Profiles may extend one another; protected paths
// (paths.ts) apply after every profile.
import { createHash } from 'node:crypto';
import { canonicalPath } from './paths.ts';
import type { FsAccess, FsEntry, NetworkBlock, Substrate } from './types.ts';

export interface PermissionProfile {
  id: string;
  name: string;
  builtin?: boolean;
  extends?: string;
  source?: 'builtin' | 'user' | 'managed';
  requiresSubstrate?: 'vm_or_container' | null;
  filesystem: { path: string; access: FsAccess }[];
  network: NetworkBlock;
}

export const BUILTIN_PROFILES: readonly PermissionProfile[] = [
  {
    id: 'read-only',
    name: 'read-only',
    builtin: true,
    source: 'builtin',
    filesystem: [
      { path: ':project', access: 'read' },
      { path: ':minimal', access: 'read' },
    ],
    network: { mode: 'off' },
  },
  {
    id: 'workspace',
    name: 'workspace',
    builtin: true,
    source: 'builtin',
    filesystem: [
      { path: ':project', access: 'write' },
      { path: ':tmp', access: 'write' },
      { path: ':minimal', access: 'read' },
    ],
    network: { mode: 'off' },
  },
  {
    id: 'full',
    name: 'full',
    builtin: true,
    source: 'builtin',
    requiresSubstrate: 'vm_or_container',
    filesystem: [{ path: '/', access: 'write' }],
    network: { mode: 'allowlist', allow: [] },
  },
];

const PATH_SHAPE = /^(\/|[A-Za-z]:[\\/]|~(\/|$)|:(project|tmp|minimal|home)(\/|$))/;
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a profile's own fields (not its parents). Returns a message or null. */
export function checkProfile(p: PermissionProfile): string | null {
  if (!NAME_SHAPE.test(p.name)) return 'profile names use lower-case letters, digits and hyphens';
  for (const e of p.filesystem) {
    if (!PATH_SHAPE.test(e.path))
      return `"${e.path}" must be absolute, a ~ path or a token (:project, :tmp, :minimal, :home)`;
    if (e.path.split(/[\\/]/).includes('..')) return `"${e.path}" may not contain ..`;
  }
  if ((p.network.allow ?? []).includes('*'))
    return 'a bare * is not allowed in the network allowlist';
  return null;
}

/**
 * Flatten `extends` chains: parent entries first, then the child's (later entries refine), the
 * child's network block, and a substrate requirement inherited from any ancestor. A missing
 * parent or a cycle throws.
 */
export function flattenProfile(
  profile: PermissionProfile,
  lookup: (id: string) => PermissionProfile | undefined,
): PermissionProfile {
  const chain: PermissionProfile[] = [];
  const seen = new Set<string>();
  let cur: PermissionProfile | undefined = profile;
  while (cur) {
    if (seen.has(cur.id)) throw new Error(`profile ${profile.name} extends itself`);
    seen.add(cur.id);
    chain.unshift(cur);
    if (!cur.extends) break;
    const parentId: string = cur.extends;
    cur = lookup(parentId);
    if (!cur) throw new Error(`profile ${profile.name} extends unknown profile ${parentId}`);
  }
  const requires = chain.some((p) => p.requiresSubstrate === 'vm_or_container');
  const flat: PermissionProfile = {
    ...profile,
    filesystem: chain.flatMap((p) => p.filesystem),
    network: profile.network,
  };
  delete flat.extends;
  if (requires) flat.requiresSubstrate = 'vm_or_container';
  return flat;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** SHA-256 over canonical JSON (sorted keys), as `sha256:<hex>`. */
export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')}`;
}

/** The definition hash of a flattened profile (what the profile says, before roots). */
export function profileHash(p: PermissionProfile): string {
  return stableHash({
    name: p.name,
    filesystem: p.filesystem,
    network: p.network,
    requiresSubstrate: p.requiresSubstrate ?? null,
  });
}

export function isolatedSubstrate(s: Substrate | null | undefined): boolean {
  return s === 'container' || s === 'micro_vm';
}

export interface ProjectRoot {
  path: string;
  /** What the root itself allows (a `tools.roots` entry may be read-only). */
  access: 'read' | 'write';
  label: string;
}

export interface ExpandOptions {
  /** The session's project roots (the Hub workspace and the `tools.roots` folders). */
  projectRoots: readonly ProjectRoot[];
  /** Per-session temporary directory; `:tmp` entries are skipped without one. */
  tmp?: string | null;
  home?: string | null;
}

export interface ExpandedEntry extends FsEntry {
  label: string;
}

/**
 * Resolve a flattened profile's tokens to absolute entries (FR-190). `:minimal` is provided by
 * the sandbox substrate itself and never becomes a tool root. A project root's own access caps
 * what `:project` grants (a read-only folder stays read-only under `workspace`).
 */
export function expandProfile(profile: PermissionProfile, opts: ExpandOptions): ExpandedEntry[] {
  const out: ExpandedEntry[] = [];
  const join = (base: string, sub: string) =>
    sub ? `${base.replace(/[\\/]+$/, '')}/${sub.replace(/^[\\/]+/, '')}` : base;
  for (const e of profile.filesystem) {
    const m = /^:(project|tmp|minimal|home)(?:[\\/](.*))?$/.exec(e.path);
    if (m) {
      const sub = m[2] ?? '';
      if (m[1] === 'project') {
        for (const r of opts.projectRoots) {
          const access = e.access === 'write' && r.access === 'read' ? 'read' : e.access;
          out.push({ path: join(r.path, sub), access, label: sub ? `${r.label}/${sub}` : r.label });
        }
      } else if (m[1] === 'tmp' && opts.tmp) {
        out.push({ path: join(opts.tmp, sub), access: e.access, label: 'Temporary files' });
      } else if (m[1] === 'home' && opts.home) {
        out.push({ path: join(opts.home, sub), access: e.access, label: 'Home' });
      }
      continue;
    }
    if (e.path === '~' || e.path.startsWith('~/')) {
      if (opts.home)
        out.push({ path: join(opts.home, e.path.slice(2)), access: e.access, label: e.path });
      continue;
    }
    out.push({
      path: e.path,
      access: e.access,
      label: e.path === '/' ? 'Whole filesystem' : e.path,
    });
  }
  return out.filter((x) => canonicalPath(x.path) !== null);
}
