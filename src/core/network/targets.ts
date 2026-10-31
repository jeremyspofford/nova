// Network targets (M10d, docs/plans/M10d.md), behind an adapter (ADR-8): something whose configuration
// Nova may change (a router, DNS, a firewall, a tailnet's policy). One adapter, `http-config`: the
// configuration as JSON at an address, read with GET and its ETag, written with PUT and If-Match, a
// bearer token from the vault. Plain http only to this machine: a token never crosses a network in
// clear. Redirects aren't followed (they would carry the token elsewhere).
//
// Also here, pure: the JSON merge patch a change is (RFC 7386), the masking of every value under a
// key that looks secret, and the canonical text the snapshot's hash and the diff are taken over.
import { createHash } from 'node:crypto';
import { CoreError } from '../errors.ts';
import { hostEgress, loopbackName } from '../browser/plan.ts';
import type { Egress } from '../workers.ts';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Config = { [k: string]: Json };
// `text`: the configuration's own bytes, as the target sent them: a revert writes exactly these back
// (review of PR #241, S7).
export interface Read { config: Config; version: string; text: string }

export interface NetworkTarget {
  read(signal?: AbortSignal): Promise<Read>;
  // Writes `body` (JSON text) only if the target is still at `ifVersion`; returns the new version, or
  // '' when the target gives none with its answer.
  write(body: string, ifVersion: string, signal?: AbortSignal): Promise<{ version: string }>;
}

export const KINDS = ['router', 'dns', 'firewall', 'tailnet'] as const;
export type Kind = (typeof KINDS)[number];
export const ADAPTERS = ['http-config'] as const;
const MAX_BYTES = 1024 * 1024;

// A key whose value is a secret: never shown, never set from chat. It fails closed (review of PR #241,
// S2): anything that names a password, a key, a token, a community string, a certificate, a hash or a
// seed counts, so a public key is masked too.
export const SECRET_KEY = /pass|pwd|secret|psk|pre[_-]?shared|priv|token|credential|community|cert|salt|hash|seed|cookie|session|otp|\bpin\b|auth|key$|^key|_key|key_|keys?\b/i;
// A value that looks like a secret whatever its key: a PEM block, a long base64 or hex string, a
// crypt(3) hash.
const SECRET_VALUE = /^-----BEGIN |^[A-Za-z0-9+/_-]{32,}={0,2}$|^[0-9a-f]{32,}$|^\$(1|2[abxy]?|5|6|y|argon2(id?|d))\$/i;
export const secretValue = (v: unknown): boolean => typeof v === 'string' && SECRET_VALUE.test(v.trim());
export const MASK = '[secret]';

const isObj = (v: unknown): v is Config => typeof v === 'object' && v !== null && !Array.isArray(v);

// Canonical text: two-space JSON, keys in the target's own order, a newline at the end.
export const pretty = (c: Json) => `${JSON.stringify(c, null, 2)}\n`;
export const digest = (c: Json) => createHash('sha256').update(pretty(c)).digest('hex');

// RFC 7386: an object patch merges, null deletes, anything else replaces.
export function mergePatch(target: Json, patch: Json): Json {
  if (!isObj(patch)) return patch;
  const out: Config = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k] ?? null, v);
  }
  return out;
}

// Every value under a secret-looking key, and every secret-looking value, masked (whatever it holds: a
// string, an object, a list). Deeper than 40 levels, everything is masked.
export function mask(c: Json, depth = 0): Json {
  if (depth > 40) return MASK;
  if (Array.isArray(c)) return c.map((v) => mask(v, depth + 1));
  if (secretValue(c)) return MASK;
  if (!isObj(c)) return c;
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && v !== '' ? MASK : mask(v, depth + 1)]));
}

const join = (at: string, k: string | number) => (typeof k === 'number' ? `${at}[${k}]` : at ? `${at}.${k}` : k);

// The paths in a patch that would set or delete a secret, inside lists too (review of PR #241, B1),
// or set a secret-looking value under any key; a patch with any is refused.
export function secretPaths(patch: Json, at = '', depth = 0): string[] {
  if (depth > 40) return [at || '(the patch)'];
  if (Array.isArray(patch)) return patch.flatMap((v, i) => secretPaths(v, join(at, i), depth + 1));
  if (secretValue(patch)) return [at || '(the patch)'];
  if (!isObj(patch)) return [];
  return Object.entries(patch).flatMap(([k, v]) => (SECRET_KEY.test(k) ? [join(at, k)] : secretPaths(v, join(at, k), depth + 1)));
}

// Where a secret value differs between two configurations: under a secret-looking key, or a
// secret-looking value on either side, at any depth, lists included. A change with any is never
// offered, since the diff can't show it (review of PR #241, B1).
export function secretChanges(a: Json | undefined, b: Json | undefined, at = '', depth = 0, secret = false, out: string[] = []): string[] {
  if (out.length >= 20) return out;
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (secret || secretValue(a) || secretValue(b) || depth > 40) { if (!same) out.push(at || '(the whole configuration)'); return out; }
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) secretChanges(x[i], y[i], join(at, i), depth + 1, false, out);
    return out;
  }
  if (isObj(a) || isObj(b)) {
    const x = isObj(a) ? a : {};
    const y = isObj(b) ? b : {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) secretChanges(x[k], y[k], join(at, k), depth + 1, SECRET_KEY.test(k), out);
  }
  return out;
}

// The patch's shape, for the record: its keys, every value replaced. The patch itself is sealed in
// Nova's own folder (review of PR #241, B1).
export function shape(c: Json, depth = 0): Json {
  if (depth > 40) return '…';
  if (Array.isArray(c)) return c.map((v) => shape(v, depth + 1));
  if (isObj(c)) return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, shape(v, depth + 1)]));
  return c === null ? null : '…';
}

// A path's segments, and the value there (undefined when absent).
type Seg = string | number;
export function leafPaths(a: Json | undefined, b: Json | undefined, at: Seg[] = [], out: Seg[][] = []): Seg[][] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leafPaths(a[k], b[k], [...at, k], out);
    return out;
  }
  out.push(at);
  return out;
}
export const showPath = (p: Seg[]) => p.reduce<string>((s, k) => join(s, k), '') || '(the whole configuration)';
export function valueAt(c: Json | undefined, p: Seg[]): Json | undefined {
  let v: Json | undefined = c;
  for (const k of p) {
    if (typeof k === 'number' ? !Array.isArray(v) : !isObj(v)) return undefined;
    v = (v as Record<string | number, Json>)[k as never];
  }
  return v;
}
// A configuration with some paths taken out: the fields the target sets itself on each write.
export function without(c: Json, paths: Seg[][]): Json {
  const copy = JSON.parse(JSON.stringify(c)) as Json;
  for (const p of paths) {
    if (!p.length) continue;
    const parent = valueAt(copy, p.slice(0, -1));
    const k = p[p.length - 1]!;
    if (isObj(parent) && typeof k === 'string') delete parent[k];
  }
  return copy;
}

// Numbers JSON can't carry exactly through a parse and a write (integers past 2^53, 1500.0, 1e3,
// -0): Nova refuses to change such a configuration rather than rewrite them (review of PR #241, S7).
export function inexactNumbers(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < 5; i++) {
    const ch = text[i]!;
    if (ch === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; continue; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) continue;
      if (JSON.stringify(JSON.parse(m[0])) !== m[0]) out.push(m[0]);
      i += m[0].length - 1;
    }
  }
  return out;
}

// The leaf paths whose values differ, for a sentence ("firewall.rules, dns.upstream").
export function changedPaths(a: Json, b: Json, at = '', depth = 0, out: string[] = []): string[] {
  if (out.length >= 50) return out;
  if (isObj(a) && isObj(b) && depth < 3) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) changedPaths(a[k] ?? null, b[k] ?? null, at ? `${at}.${k}` : k, depth + 1, out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at || '(the whole configuration)');
  return out;
}

export function validatePatch(v: unknown): Config {
  if (!isObj(v) || !Object.keys(v).length) throw new CoreError('validation', 'patch is a JSON merge patch of the configuration: an object of what changes ({"firewall": {"allow_ssh": false}}; null removes a key).');
  if (Buffer.byteLength(JSON.stringify(v)) > 64 * 1024) throw new CoreError('validation', 'patch is at most 64 KB.');
  const secret = secretPaths(v as Json);
  if (secret.length) throw new CoreError('validation', `The patch sets ${secret.join(', ')}: secrets aren’t changed from chat. Change a password or a key on the device itself, or in the vault.`);
  return v as Config;
}

// A target's address: http(s), plain http only to this machine.
export function checkUrl(raw: unknown): URL {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw new CoreError('validation', 'url is the full address of the target’s configuration, like https://192.168.1.1/api/config.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CoreError('validation', 'url is an http(s) address.');
  if (u.username || u.password) throw new CoreError('validation', 'url carries no sign-in; the token goes into the vault.');
  if (u.protocol === 'http:' && !loopbackName(u.hostname)) throw new CoreError('validation', `${u.host} is plain http: Nova never sends a target’s token over plain http, except to this machine itself. Use https.`);
  return u;
}

export const urlEgress = (u: string): Egress => { try { return hostEgress(new URL(u).hostname); } catch { return 'remote'; } };

export function httpConfig(o: { url: string; token: () => string | null; timeoutMs?: number }): NetworkTarget {
  const u = checkUrl(o.url);
  const auth = () => {
    const t = o.token();
    if (!t) throw new CoreError('conflict', 'The target’s token isn’t in the vault yet. Save it with PUT /network/targets/{id}/token (never in chat).');
    return `Bearer ${t}`;
  };
  const call = async (init: RequestInit, signal?: AbortSignal) => {
    const s = AbortSignal.any([AbortSignal.timeout(o.timeoutMs ?? 15_000), ...(signal ? [signal] : [])]);
    let res: Response;
    try { res = await fetch(u, { ...init, redirect: 'error', signal: s, headers: { ...(init.headers as Record<string, string> ?? {}), authorization: auth() } }); } catch (e) {
      if (signal?.aborted) throw e;
      throw new CoreError('conflict', `Nova couldn’t reach ${u.host}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new CoreError('conflict', `${u.host} answered with more than ${MAX_BYTES / 1024} KB.`);
    return { res, text };
  };
  const etag = (res: Response) => (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
  return {
    async read(signal) {
      const { res, text } = await call({ method: 'GET' }, signal);
      if (res.status === 401 || res.status === 403) throw new CoreError('conflict', `${u.host} refused the token (${res.status}).`);
      if (!res.ok) throw new CoreError('conflict', `${u.host} answered ${res.status} to a read of its configuration.`);
      let config: unknown;
      try { config = JSON.parse(text); } catch { throw new CoreError('conflict', `${u.host}’s configuration isn’t JSON.`); }
      if (!isObj(config)) throw new CoreError('conflict', `${u.host}’s configuration isn’t a JSON object.`);
      const version = etag(res);
      if (!version) throw new CoreError('conflict', `${u.host} gives no version (ETag) with its configuration, so Nova can’t change it safely.`);
      return { config, version, text };
    },
    async write(body, ifVersion, signal) {
      const { res } = await call({ method: 'PUT', body, headers: { 'content-type': 'application/json', 'if-match': `"${ifVersion}"` } }, signal);
      if (res.status === 412) throw new CoreError('conflict', `${u.host}’s configuration changed since Nova read it, so Nova wrote nothing.`);
      if (!res.ok) throw new CoreError('conflict', `${u.host} answered ${res.status} to the change.`);
      return { version: etag(res) };
    },
  };
}
