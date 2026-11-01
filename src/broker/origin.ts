// Targets and origin binding (docs/plans/vault-broker.md §5). Matching is exact on the canonical
// form: no wildcards, no subdomains, no parent domains. The canonical form is computed here, by the
// broker, from what it is given; a target that isn't already canonical-able is refused, never
// repaired into something nearby.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { domainToUnicode } from 'node:url';
import type { Scope, TargetKind } from './protocol.ts';

export const BUILT: ReadonlySet<TargetKind> = new Set(['http', 'process']);
export const KINDS: ReadonlySet<string> = new Set(['web', 'http', 'ws', 'stream', 'process', 'service', 'device']);

const LOOPBACK_NAMES = new Set(['localhost']);
export const isLoopbackHost = (h: string) => LOOPBACK_NAMES.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h === '[::1]';

// An origin, canonical: scheme, lowercase A-label host, port only when not the default. `http` and
// `ws` only for loopback. Anything with a path, query, fragment, credentials, a wildcard or a
// trailing dot is refused.
export function canonicalOrigin(input: unknown, kind: 'web' | 'http' | 'ws' = 'http'): string {
  if (typeof input !== 'string' || input.length > 300 || /[*\s\\]/.test(input)) throw new Error('not an origin');
  let u: URL;
  try { u = new URL(input); } catch { throw new Error('not an origin'); }
  const secure = kind === 'ws' ? 'wss:' : 'https:';
  const plain = kind === 'ws' ? 'ws:' : 'http:';
  if (u.protocol !== secure && u.protocol !== plain) throw new Error(`a ${kind} target is ${secure.slice(0, -1)}`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('an origin has no path, query, fragment or credentials');
  const host = u.hostname;
  if (!host || host.endsWith('.') || host.includes('..')) throw new Error('not a host the broker binds');
  if (u.protocol === plain && !isLoopbackHost(host)) throw new Error(`${plain.slice(0, -1)} is allowed only on this device (loopback)`);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}

export const hostOf = (origin: string) => new URL(origin).hostname;

// A program: an absolute, normal path and the binary's SHA-256.
export function canonicalProcess(path: unknown, sha256: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.length > 500) throw new Error('a program target is an absolute, normal path');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('a program target names its binary’s SHA-256');
  return `${path}#sha256:${sha256}`;
}
export const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export interface TargetIn { kind?: unknown; origin?: unknown; path?: unknown; sha256?: unknown }
export function canonicalTarget(t: TargetIn): { kind: TargetKind; target: string } {
  if (!t || typeof t !== 'object' || typeof t.kind !== 'string' || !KINDS.has(t.kind)) throw new Error('not a target kind');
  const kind = t.kind as TargetKind;
  if (kind === 'web' || kind === 'http' || kind === 'ws') return { kind, target: canonicalOrigin(t.origin, kind) };
  if (kind === 'process') return { kind, target: canonicalProcess(t.path, t.sha256) };
  return { kind, target: `${kind}:${String(t.origin ?? t.path ?? '')}` };
}

// A request path: absolute, no traversal, no second slash at the start (which would name a host),
// no backslash. The scope is checked on the path without its query.
export function requestPath(p: unknown): { path: string; bare: string } {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.length > 2000 || /[\\\s#]/.test(p)) throw new Error('not a request path');
  const bare = p.split('?')[0]!;
  let decoded: string;
  try { decoded = decodeURIComponent(bare); } catch { throw new Error('not a request path'); }
  if (decoded.split('/').some((s) => s === '..' || s === '.') || decoded.includes('\\') || /%2f/i.test(bare)) throw new Error('a request path can’t climb out of its scope');
  return { path: p, bare };
}

export function checkScope(s: unknown): Scope {
  const o = s as Scope;
  if (!o || !Array.isArray(o.methods) || !Array.isArray(o.paths) || !o.methods.length || !o.paths.length || o.methods.length > 10 || o.paths.length > 50) throw new Error('a scope names its methods and path prefixes');
  for (const m of o.methods) if (typeof m !== 'string' || !/^[A-Z]{3,7}$/.test(m)) throw new Error('not a method');
  for (const p of o.paths) { if (typeof p !== 'string' || /[*?]/.test(p)) throw new Error('scope paths are prefixes, without wildcards'); requestPath(p); }
  return { methods: [...o.methods], paths: [...o.paths] };
}

// A path prefix covers itself and what is below it at a segment boundary: /api covers /api and
// /api/x, never /apix.
export const inScope = (s: Scope, method: string, bare: string) =>
  s.methods.includes(method) && s.paths.some((p) => bare === p || (p.endsWith('/') ? bare.startsWith(p) : bare.startsWith(`${p}/`)));

// ---- lookalikes (flags on the bind card, not refusals) ------------------------------------------

const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Han}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u];
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export function lookalikes(origin: string, bound: string[]): { unicode: string | null; flags: string[] } {
  const host = hostOf(origin);
  const uni = domainToUnicode(host);
  const flags: string[] = [];
  for (const label of uni.split('.')) {
    const n = SCRIPTS.filter((r) => r.test(label)).length;
    if (n > 1) flags.push(`mixed scripts in “${label}”`);
  }
  for (const b of bound) {
    let bh: string;
    try { bh = hostOf(b); } catch { continue; }
    if (bh === host) continue;
    if (distance(bh, host) <= 2) flags.push(`close to ${bh}, already bound`);
    if (host.startsWith(`${bh}.`)) flags.push(`starts with ${bh}, already bound, as a label`);
  }
  return { unicode: uni !== host ? uni : null, flags };
}

// ---- addresses (§3 "No network surface") --------------------------------------------------------

export function addressClass(addr: string): 'loopback' | 'private' | 'public' {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    if (a === 127) return 'loopback';
    if (a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return 'private';
    return 'public';
  }
  if (v === 6) {
    const x = addr.toLowerCase();
    if (x === '::1') return 'loopback';
    if (x.startsWith('::ffff:')) return addressClass(x.slice(7));
    if (x === '::' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')) return 'private';
    return 'public';
  }
  return 'private';
}

// The broker suggests a class from the origin (§6): sensitive when unsure.
const SENSITIVE = /(bank|pay|card|credit|finance|invest|broker|trade|wallet|crypto|coin|exchange|mail|admin|console|sso|login|auth|account|vault|password|1password|bitwarden|okta|cloud|aws|azure|gcp|router|github|gitlab)/;
const STANDARD = /(^|\.)(openai\.com|anthropic\.com|groq\.com|mistral\.ai|together\.xyz|openrouter\.ai|deepseek\.com|x\.ai|ollama\.com)$/;
export function suggestClass(origin: string | null, kind: string): 'standard' | 'sensitive' {
  if (!origin) return 'sensitive';
  let host: string;
  try { host = origin.startsWith('/') ? '' : hostOf(origin); } catch { return 'sensitive'; }
  if (SENSITIVE.test(host)) return 'sensitive';
  if (STANDARD.test(host) || isLoopbackHost(host)) return 'standard';
  void kind;
  return 'sensitive';
}
