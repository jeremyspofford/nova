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

const URL_LIKE = /^(https?|wss?):\/\//i;

/**
 * Hosts named by URL arguments (FR-045): every `http(s)` or `ws(s)` URL among the string
 * values of `args`, nested objects and arrays included (bounded), lower-cased and in order of
 * appearance. A plugin tool may reach only hosts its plugin declared, so the engine checks each.
 */
export function urlHosts(args: unknown): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (v: unknown, depth: number) => {
    if (seen++ > 500 || depth > 6) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!URL_LIKE.test(s)) return;
      let host: string;
      try {
        host = new URL(s).hostname.toLowerCase();
      } catch {
        return;
      }
      if (host && !out.includes(host)) out.push(host);
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(args, 0);
  return out;
}

/** A declared host as `hostMatch` compares it: a URL or `host:port` becomes its host name. */
export function hostPattern(declared: string): string {
  let p = declared.trim().toLowerCase();
  if (p.includes('://')) {
    try {
      return new URL(p).hostname;
    } catch {
      p = p.slice(p.indexOf('://') + 3);
    }
  }
  p = p.replace(/[/?#].*$/, '');
  if (!p.startsWith('[')) p = p.replace(/:\d+$/, '');
  return p;
}
