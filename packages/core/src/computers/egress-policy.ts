// Egress policy evaluation (FR-102, FR-193, docs/12 §8): host patterns, address classes and the
// order of the checks. Pure functions; the proxy (egress-proxy.ts) applies them per request.
//
// Order: mode `off` blocks everything; a deny entry wins over everything else; a host must match
// the allowlist (or a dev-server grant); `limited` allows only GET, HEAD and OPTIONS. DNS is
// resolved only after these checks pass, so a denied name is never even looked up, and the
// resolved address is then checked against the private-address classes and pinned.
import { isIP } from 'node:net';
import { checkHostPattern, NovaError } from '@nova/shared';
import { hostMatch } from '@nova/policy';
import type { EgressBlockCause, EgressMode, EgressPolicy } from './types.ts';

export type AddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'cgnat'
  | 'unique_local'
  | 'multicast'
  | 'unspecified'
  | 'reserved';

/** Methods `limited` mode allows (docs/12 §8). */
export const LIMITED_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

function v4Class(ip: string): AddressClass {
  const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  // IETF protocol assignments, documentation and benchmarking ranges are never real servers.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  return 'public';
}

/** The 8 groups of an IPv6 address, or null when it does not parse. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 part becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0] ?? '');
  const tail = parse(halves[1] ?? '');
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array<number>(Math.max(0, fill)).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff))
    return null;
  return groups;
}

/** The class of an IP address; anything that does not parse is `reserved` (blocked). */
export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '');
  if (family === 4) return v4Class(ip);
  if (family !== 6) return 'reserved';
  const g = v6Groups(ip.replace(/^\[|\]$/g, ''));
  if (!g) return 'reserved';
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = () => `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) return v4Class(embedded());
  if (g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return v4Class(embedded());
  if ((g0 & 0xfe00) === 0xfc00) return 'unique_local';
  if ((g0 & 0xffc0) === 0xfe80) return 'link_local';
  if ((g0 & 0xffc0) === 0xfec0) return 'private';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved';
  if (g.slice(0, 6).every((x) => x === 0)) return 'reserved';
  return 'public';
}

/** Normalize a host for matching: lower case, no trailing dot, no IPv6 brackets. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

/** The first pattern that matches the host, or null. Wildcards cover subdomains only. */
export function matchingPattern(patterns: readonly string[], host: string): string | null {
  const h = normalizeHost(host);
  for (const p of patterns) {
    const n = normalizeHost(p);
    // `*` never matches here: it is rejected when a policy loads.
    if (n === '*') continue;
    if (hostMatch(n, h)) return p;
  }
  return null;
}

/**
 * Validate a policy as it loads (FR-193): a bare `*` or a wildcard that is not the whole
 * leftmost label is a `validation` error, in either list. Returns a normalized copy.
 */
export function validateEgressPolicy(policy: EgressPolicy): EgressPolicy {
  for (const [field, list] of [
    ['allow', policy.allow],
    ['deny', policy.deny],
  ] as const) {
    for (const p of list) {
      const why = checkHostPattern(p);
      if (why) throw new NovaError('validation', why, { details: { field, pattern: p } });
    }
  }
  return {
    mode: policy.mode,
    allow: [...new Set(policy.allow.map(normalizeHost))],
    deny: [...new Set(policy.deny.map(normalizeHost))],
    credentials: [...new Set(policy.credentials)],
    allowLocalBinding: policy.allowLocalBinding,
  };
}

const NARROW: Record<EgressMode, number> = { off: 0, limited: 1, allowlist: 2 };

/** The narrower of two modes: off < limited < allowlist. */
export function narrowMode(a: EgressMode, b: EgressMode): EgressMode {
  return NARROW[a] <= NARROW[b] ? a : b;
}

export interface HostDecision {
  allow: boolean;
  cause: EgressBlockCause | null;
  /** The pattern that decided (allow or deny entry), for the audit. */
  rule: string | null;
  /** Allowed through a dev-server grant (private addresses may then be reached). */
  devServer: boolean;
}

/**
 * Decide a request by host, port and method, before any DNS lookup. `method` is null for an
 * opaque tunnel whose method cannot be seen; `limited` then needs inspection (the caller decides).
 */
export function decideHost(
  policy: EgressPolicy,
  input: { host: string; port: number; method: string | null; devServer: boolean },
): HostDecision {
  const no = (cause: EgressBlockCause, rule: string | null = null): HostDecision => ({
    allow: false,
    cause,
    rule,
    devServer: false,
  });
  if (policy.mode === 'off') return no('policy');
  const denied = matchingPattern(policy.deny, input.host);
  if (denied) return no('denylist', denied);
  const allowed = matchingPattern(policy.allow, input.host);
  const devServer = !allowed && policy.allowLocalBinding && input.devServer;
  if (!allowed && !devServer) return no('allowlist');
  if (
    policy.mode === 'limited' &&
    input.method !== null &&
    !LIMITED_METHODS.includes(input.method.toUpperCase())
  )
    return no('method', allowed);
  return { allow: true, cause: null, rule: allowed ?? 'dev-server', devServer };
}

/** Whether a resolved address may be reached (public, or private under a dev-server grant). */
export function addressAllowed(
  policy: EgressPolicy,
  cls: AddressClass,
  devServerGranted: boolean,
): boolean {
  if (cls === 'public') return true;
  return policy.allowLocalBinding && devServerGranted;
}
