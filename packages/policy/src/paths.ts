// Filesystem access under a permission profile and the protected paths (FR-190, docs/12 §7.1-
// §7.2). Pure and string-based: callers canonicalize first (realpath, symlinks resolved); the
// engine only accepts absolute paths without `.` or `..` segments and denies anything else.
// Protection compares case-insensitively and ignores Windows trailing dots/spaces and stream
// suffixes, so `.GIT`, `.git.` and `.git::$DATA` are all `.git` (stricter on every platform).
import type { FsContext, FsEntry } from './types.ts';

/** Inside a writable root these stay read-only (relative to the root, at any depth). */
export const READ_ONLY_LOCATIONS: readonly (readonly string[])[] = [
  ['.git'],
  ['.nova'],
  ['.agents'],
  // Shell startup files (docs/12 §7.2).
  ['.bashrc'],
  ['.bash_profile'],
  ['.bash_login'],
  ['.bash_logout'],
  ['.profile'],
  ['.zshrc'],
  ['.zshenv'],
  ['.zprofile'],
  ['.zlogin'],
  ['.zlogout'],
  ['.kshrc'],
  ['.cshrc'],
  ['.tcshrc'],
  ['.config', 'fish'],
  ['microsoft.powershell_profile.ps1'],
  ['profile.ps1'],
  ['documents', 'powershell'],
  ['documents', 'windowspowershell'],
];

/**
 * Credential locations: denied for reading and writing wherever they appear in a path (docs/12
 * §7.2): SSH, GPG, Git and netrc credentials, cloud CLI folders, package-manager credentials,
 * browser profiles, keychains and credential stores. `*` at the end of a segment is a prefix.
 */
export const CREDENTIAL_LOCATIONS: readonly (readonly string[])[] = [
  ['.ssh'],
  ['.gnupg'],
  ['.git-credentials'],
  ['.netrc'],
  ['_netrc'],
  ['.aws'],
  ['.azure'],
  ['.config', 'gcloud'],
  ['.config', 'gh'],
  ['.kube'],
  ['.npmrc'],
  ['.pypirc'],
  ['.cargo', 'credentials*'],
  ['.docker', 'config.json'],
  ['.password-store'],
  ['.local', 'share', 'keyrings'],
  ['library', 'keychains'],
  ['.mozilla'],
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'bravesoftware'],
  ['library', 'application support', 'google', 'chrome'],
  ['library', 'application support', 'firefox'],
  ['library', 'safari'],
  ['appdata', 'local', 'google', 'chrome', 'user data'],
  ['appdata', 'roaming', 'mozilla'],
  ['appdata', 'local', 'microsoft', 'credentials'],
  ['appdata', 'roaming', 'microsoft', 'credentials'],
  ['appdata', 'roaming', 'microsoft', 'protect'],
];

export type PathAccess = 'write' | 'read' | 'none' | 'deny';

export interface PathCheck {
  access: PathAccess;
  /** Why access is limited ('' when the root grants it plainly). */
  reason: string;
}

/**
 * The canonical form of an absolute path (`/a/b`, `C:/a`, `//server/share/a`), or null when the
 * path is relative, contains `.`/`..` segments or a NUL byte.
 */
export function canonicalPath(p: string): string | null {
  if (p.length === 0 || p.includes('\0')) return null;
  let s = p.replace(/\\/g, '/');
  let prefix = '';
  const drive = /^([A-Za-z]):(\/|$)/.exec(s);
  if (drive) {
    prefix = `${drive[1]!.toUpperCase()}:`;
    s = s.slice(2);
  } else if (s.startsWith('//')) {
    prefix = '/';
    s = s.slice(1);
  } else if (!s.startsWith('/')) {
    return null;
  }
  const segs = s.split('/').filter((x) => x !== '');
  if (segs.some((x) => x === '.' || x === '..')) return null;
  return `${prefix}/${segs.join('/')}`;
}

/** `child` is `parent` or inside it (both canonical; exact case). */
export function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** One segment as protection compares it. */
function fold(seg: string): string {
  const s = seg.toLowerCase().replace(/:.*$/, '');
  const trimmed = s.replace(/[. ]+$/, '');
  return trimmed === '' ? s : trimmed;
}

function foldPath(p: string): string {
  return p.split('/').map(fold).join('/');
}

/** Case- and variant-insensitive containment, used for everything that protects. */
export function withinLoose(parent: string, child: string): boolean {
  return within(foldPath(parent), foldPath(child));
}

function segments(p: string): string[] {
  return p.split('/').filter((x) => x !== '');
}

function relSegments(parent: string, child: string): string[] {
  return segments(child.slice(parent.length)).map(fold);
}

function segMatch(want: string, seg: string): boolean {
  return want.endsWith('*') ? seg.startsWith(want.slice(0, -1)) : seg === want;
}

/** Whether any position in `segs` starts one of `locations`. */
export function matchesLocation(
  segs: readonly string[],
  locations: readonly (readonly string[])[],
): string | null {
  for (let i = 0; i < segs.length; i++) {
    for (const loc of locations) {
      if (loc.every((want, j) => segs[i + j] !== undefined && segMatch(want, segs[i + j]!)))
        return loc.join('/');
    }
  }
  return null;
}

const RANK: Record<FsEntry['access'], number> = { read: 1, write: 2, deny: 3 };

/**
 * Resolve what the profile allows for `path` (FR-190): the most specific entry decides (at the
 * same path deny wins over write over read); then the data directory and credential locations
 * are denied and the read-only locations cap a writable root at read.
 */
export function pathAccess(path: string, fs: FsContext): PathCheck {
  const p = canonicalPath(path);
  if (!p) return { access: 'deny', reason: 'the path must be absolute with no . or .. segments' };
  if (fs.dataDir) {
    const data = canonicalPath(fs.dataDir);
    const allowed = (fs.dataDirAllow ?? []).some((a) => {
      const c = canonicalPath(a);
      return c !== null && withinLoose(c, p);
    });
    if (data && withinLoose(data, p) && !allowed)
      return { access: 'deny', reason: 'the Nova data folder is never available to tools' };
  }
  const cred = matchesLocation(segments(p).map(fold), CREDENTIAL_LOCATIONS);
  if (cred) return { access: 'deny', reason: `credential locations (${cred}) are never available` };
  let best: { path: string; access: FsEntry['access'] } | null = null;
  for (const e of fs.entries) {
    const c = canonicalPath(e.path);
    if (!c || !within(c, p)) continue;
    if (
      !best ||
      c.length > best.path.length ||
      (c.length === best.path.length && RANK[e.access] > RANK[best.access])
    )
      best = { path: c, access: e.access };
  }
  if (!best) return { access: 'none', reason: 'the path is outside the folders tools may use' };
  if (best.access === 'deny')
    return { access: 'deny', reason: 'the permission profile denies this path' };
  if (best.access === 'write') {
    const ro = matchesLocation(relSegments(best.path, p), READ_ONLY_LOCATIONS);
    if (ro) return { access: 'read', reason: `${ro} stays read-only` };
  }
  return { access: best.access, reason: '' };
}

/**
 * Deleting or renaming this path would remove a protected location or a whole root (docs/12
 * §7.2: an ancestor of a protected path cannot be swapped out).
 */
export function isProtectedAncestor(path: string, fs: FsContext): boolean {
  const p = canonicalPath(path);
  if (!p) return true;
  const guarded: string[] = [];
  if (fs.dataDir) guarded.push(fs.dataDir);
  if (fs.home) {
    guarded.push(fs.home);
    for (const loc of CREDENTIAL_LOCATIONS) guarded.push(`${fs.home}/${loc.join('/')}`);
  }
  for (const e of fs.entries) guarded.push(e.path);
  return guarded.some((g) => {
    const c = canonicalPath(g);
    return c !== null && withinLoose(p, c);
  });
}
