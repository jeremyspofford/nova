// Sign-ins for Nova Browser (M10b plan, "Logins"). The person saves them in Settings or through the
// API, never in chat; they live in the vault under the host they were saved for, and only the
// browser worker reads them, at the moment it types them into a page on that very host. The
// redactor holds every value a session used, and everything Nova writes from that session passes
// through it.
import { randomInt } from 'node:crypto';
import { CoreError } from '../errors.ts';
import { HOST, normalizeHost } from './plan.ts';

export const LOGIN_PREFIX = 'browser/login/';
// `pending` (M10d): a new password an account step sent, kept aside until the site shows it took.
export type LoginPart = 'username' | 'password' | 'pending';

// A host as a vault path segment: the port's colon isn't allowed there, so it becomes "_"
// (a host name never has one).
const enc = (host: string) => host.replace(/:(\d{1,5})$/, '_$1').replace(/^\[|\]/g, '');

export function siteHost(raw: string): string {
  const h = normalizeHost(String(raw ?? ''));
  if (!h || h.startsWith('*.') || !HOST.test(h) || h.startsWith('[')) throw new CoreError('validation', `“${String(raw)}” isn’t a site Nova can keep a sign-in for: a host, or host:port.`);
  return h;
}

export function loginName(host: string, part: LoginPart): string {
  return `${LOGIN_PREFIX}${enc(siteHost(host))}/${part}`;
}

// A new password, made in Nova's own process for an account step (M10d): 24 characters from the
// letters, the digits and a few symbols sites accept, with at least one of each. It is never shown:
// it goes from here into the page's field and the vault.
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '-_.!@#%+=';
export function generatePassword(length = 24): string {
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const out = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out.join('');
}

// The host a vault name was saved for, or null.
export function loginHost(name: string): string | null {
  const m = /^browser\/login\/([^/]+)\/(username|password)$/.exec(name);
  if (!m) return null;
  return m[1]!.replace(/_(\d{1,5})$/, ':$1');
}

// Why a saved sign-in may not be sent from this page, or null (review of PR #238, 5). Only an http(s)
// web page; plain http only to this machine itself (loopback never leaves it). A private, CGNAT,
// link-local or mesh address is still a network: https or nothing.
export function loginRefusal(pageUrl: string): string | null {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return 'This page isn’t a web page Nova signs in to.'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `This page (${u.protocol}) isn’t a web page Nova signs in to.`;
  if (u.protocol === 'https:') return null;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = h === 'localhost' || h.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::1';
  return loopback ? null : `${u.host} is plain http: Nova never sends a saved sign-in over plain http, except to this machine itself.`;
}

// Every value a session used, masked wherever it appears in what Nova writes. Values shorter than
// three characters aren't masked: they'd mask ordinary words.
export class Redactor {
  #values = new Set<string>();

  // The value, and the forms it travels in (review of PR #241): base64 (and base64url), hex and
  // URL-encoding.
  add(v: string | null | undefined): void {
    if (typeof v !== 'string' || v.length < 3) return;
    this.#values.add(v);
    // Encoded forms of short values would mask ordinary text (a hash, a word): from 8 characters.
    if (v.length < 8) return;
    const b = Buffer.from(v, 'utf8');
    for (const f of [v, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex'), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+')]) {
      if (f.length >= 3) this.#values.add(f);
    }
  }

  get size(): number { return this.#values.size; }

  values(): string[] { return [...this.#values]; }

  has(s: string): boolean {
    for (const v of this.#values) if (String(s).includes(v)) return true;
    return false;
  }

  text(s: string): string {
    let out = String(s ?? '');
    // Longest first, so a value that contains another is masked whole.
    for (const v of [...this.#values].sort((a, b) => b.length - a.length)) if (out.includes(v)) out = out.split(v).join('[redacted]');
    return out;
  }

  value<T>(x: T, depth = 0): T {
    if (typeof x === 'string') return this.text(x) as T;
    if (depth > 8 || x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map((v) => this.value(v, depth + 1)) as T;
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.value(v, depth + 1)])) as T;
  }
}
