// Matching helpers for policy rules. String-based on purpose: the engine is pure, so callers
// pass already-canonicalized paths (see @nova/security realpathLenient).

/** Glob over dotted names: `*` matches within a segment run of non-dots, `**` matches anything. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^.]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${re}$`).test(value);
}

/** Host match: exact, or `*.example.com` for any subdomain (not the apex). Case-insensitive. */
export function hostMatch(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

/** `child` is `parent` or inside it, for POSIX or Windows-style absolute paths. */
export function isWithinPath(parent: string, child: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const a = norm(parent);
  const b = norm(child);
  if (b.split('/').includes('..')) return false;
  return b === a || b.startsWith(a === '/' ? '/' : `${a}/`);
}
