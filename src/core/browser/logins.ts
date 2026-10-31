// Sign-ins for Nova Browser (M10b plan, "Logins"). The person saves them in Settings or through the
// API, never in chat; they live in the vault under the host they were saved for, and only the
// browser worker reads them, at the moment it types them into a page on that very host. The
// redactor holds every value a session used, and everything Nova writes from that session passes
// through it.
import { CoreError } from '../errors.ts';
import { HOST, normalizeHost } from './plan.ts';

export const LOGIN_PREFIX = 'browser/login/';
export type LoginPart = 'username' | 'password';

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

// The host a vault name was saved for, or null.
export function loginHost(name: string): string | null {
  const m = /^browser\/login\/([^/]+)\/(username|password)$/.exec(name);
  if (!m) return null;
  return m[1]!.replace(/_(\d{1,5})$/, ':$1');
}

// Every value a session used, masked wherever it appears in what Nova writes. Values shorter than
// three characters aren't masked: they'd mask ordinary words.
export class Redactor {
  #values = new Set<string>();

  add(v: string | null | undefined): void {
    if (typeof v === 'string' && v.length >= 3) this.#values.add(v);
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
