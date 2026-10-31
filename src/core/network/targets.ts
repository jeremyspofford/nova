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
export interface Read { config: Config; version: string }

export interface NetworkTarget {
  read(signal?: AbortSignal): Promise<Read>;
  // Writes only if the target is still at `ifVersion`; returns the new version.
  write(config: Config, ifVersion: string, signal?: AbortSignal): Promise<{ version: string }>;
}

export const KINDS = ['router', 'dns', 'firewall', 'tailnet'] as const;
export type Kind = (typeof KINDS)[number];
export const ADAPTERS = ['http-config'] as const;
const MAX_BYTES = 1024 * 1024;

// A key whose value is a secret: never shown, never set from chat.
export const SECRET_KEY = /(pass(word|wd|phrase)?|secret|psk|pre[_-]?shared|private[_-]?key|api[_-]?key|token|auth[_-]?key|credential|wpa[_-]?key)/i;
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

// Every value under a secret-looking key, masked (whatever it holds: a string, an object, a list).
export function mask(c: Json, depth = 0): Json {
  if (depth > 40) return c;
  if (Array.isArray(c)) return c.map((v) => mask(v, depth + 1));
  if (!isObj(c)) return c;
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && v !== '' ? MASK : mask(v, depth + 1)]));
}

// The paths in a patch that would set or delete a secret; a patch with any is refused.
export function secretPaths(patch: Json, at = '', depth = 0): string[] {
  if (!isObj(patch) || depth > 40) return [];
  return Object.entries(patch).flatMap(([k, v]) => {
    const p = at ? `${at}.${k}` : k;
    return SECRET_KEY.test(k) ? [p] : secretPaths(v, p, depth + 1);
  });
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
      return { config, version };
    },
    async write(config, ifVersion, signal) {
      const { res } = await call({ method: 'PUT', body: JSON.stringify(config), headers: { 'content-type': 'application/json', 'if-match': `"${ifVersion}"` } }, signal);
      if (res.status === 412) throw new CoreError('conflict', `${u.host}’s configuration changed since Nova read it, so Nova wrote nothing.`);
      if (!res.ok) throw new CoreError('conflict', `${u.host} answered ${res.status} to the change.`);
      return { version: etag(res) };
    },
  };
}
