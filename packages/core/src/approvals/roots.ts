// A turn's filesystem roots under its permission profile (FR-190, docs/12 §7.1). The tool runtime
// and the policy gate both call `resolveToolRoots` with the same inputs, so the roots a tool may
// touch and the roots the engine checks are the same, and so is the profile hash in the audit.
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  BUILTIN_PROFILES,
  expandProfile,
  flattenProfile,
  profileHash,
  stableHash,
  type FsAccess,
  type NetworkBlock,
  type PermissionProfile,
} from '@nova/policy';
import { realpathLenient } from '@nova/security';
import { schema, type NovaDatabase } from '@nova/storage';
import type { ToolRoot } from '../tools/types.ts';

export interface ToolRootsInput {
  /** A flattened profile (see `loadPermissionProfile`). */
  profile: PermissionProfile;
  /** The `tools.roots` setting. */
  roots: readonly { path: string; access: 'read' | 'write'; label?: string }[];
  /** `<dataDir>/workspace`: always the first project root, writable when the profile allows. */
  workspaceDir: string;
  /** The home directory for `:home` and `~` entries; defaults to the Hub user's. */
  home?: string | null;
}

export interface ResolvedToolRoots {
  /** Canonical roots, the workspace first; a path deny-listed by the profile is not a root. */
  roots: ToolRoot[];
  /** Paths the profile denies inside the roots. */
  deny: string[];
  /** The profile in force and the hash of what it resolved to (recorded with every decision). */
  profile: { id: string; hash: string };
  network: NetworkBlock;
  requiresSubstrate: 'vm_or_container' | null;
}

function expandHome(p: string, home: string | null): string {
  if (home && (p === '~' || p.startsWith('~/'))) return `${home}${p.slice(1)}`;
  return p;
}

const RANK: Record<FsAccess, number> = { read: 1, write: 2, deny: 3 };

/**
 * Resolve a profile's tokens against the workspace and the `tools.roots` folders. `:minimal` is
 * left to the sandbox substrate and `:tmp` needs a per-session directory, which Hub chats do not
 * have yet (M6), so neither becomes a tool root.
 */
export function resolveToolRoots(input: ToolRootsInput): ResolvedToolRoots {
  const home = input.home === undefined ? homedir() : input.home;
  const projectRoots = [
    { path: input.workspaceDir, access: 'write' as const, label: 'Workspace' },
    ...input.roots.map((r) => {
      const path = expandHome(r.path, home);
      return { path, access: r.access, label: r.label ?? (basename(path) || path) };
    }),
  ];
  const entries = expandProfile(input.profile, { projectRoots, home, tmp: null }).map((e) => ({
    ...e,
    path: realpathLenient(resolve(e.path)),
  }));
  const byPath = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const prev = byPath.get(e.path);
    if (!prev || RANK[e.access] > RANK[prev.access]) byPath.set(e.path, e);
  }
  const roots: ToolRoot[] = [];
  const deny: string[] = [];
  for (const e of byPath.values()) {
    if (e.access === 'deny') deny.push(e.path);
    else roots.push({ path: e.path, access: e.access, label: e.label });
  }
  const hash = stableHash({
    profile: profileHash(input.profile),
    roots: roots.map((r) => [r.path, r.access]),
    deny,
  });
  return {
    roots,
    deny,
    profile: { id: input.profile.id, hash },
    network: input.profile.network,
    requiresSubstrate: input.profile.requiresSubstrate ?? null,
  };
}

type ProfileRow = typeof schema.permissionProfile.$inferSelect;

export function profileFromRow(r: ProfileRow): PermissionProfile {
  const p: PermissionProfile = {
    id: r.id,
    name: r.name,
    builtin: false,
    source: r.source,
    filesystem: JSON.parse(r.fsRulesJson) as PermissionProfile['filesystem'],
    network: JSON.parse(r.networkJson) as NetworkBlock,
    requiresSubstrate: r.requiresSubstrate ?? null,
  };
  if (r.extends) p.extends = r.extends;
  return p;
}

/** Built-in profiles plus the account's own (and managed ones, which have no account). */
export async function allPermissionProfiles(
  db: NovaDatabase,
  accountId: string,
): Promise<PermissionProfile[]> {
  const t = schema.permissionProfile;
  const rows = await db.orm
    .select()
    .from(t)
    .where(or(eq(t.accountId, accountId), and(isNull(t.accountId), eq(t.source, 'managed'))));
  return [...BUILTIN_PROFILES, ...rows.map(profileFromRow)];
}

/**
 * The flattened profile for a setting value (a profile id or name). An unknown or broken profile
 * falls back to `read-only` (fail closed), reported through `fallback`.
 */
export async function loadPermissionProfile(
  db: NovaDatabase,
  accountId: string,
  nameOrId: string,
): Promise<{ profile: PermissionProfile; fallback: string | null }> {
  const all = await allPermissionProfiles(db, accountId);
  const lookup = (id: string) => all.find((p) => p.id === id);
  const found = lookup(nameOrId) ?? all.find((p) => p.name === nameOrId);
  const readOnly = BUILTIN_PROFILES[0]!;
  if (!found) return { profile: readOnly, fallback: `unknown permission profile "${nameOrId}"` };
  try {
    return { profile: flattenProfile(found, lookup), fallback: null };
  } catch (err) {
    return { profile: readOnly, fallback: err instanceof Error ? err.message : String(err) };
  }
}
