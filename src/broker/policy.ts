// Policy on the broker's own authority (§6–§7): approvals, flood control and rate caps.
//
// An approval: the broker issues a challenge (a random id, the digest of the canonical action, an
// expiry of 5 minutes, single use). The caller calls again with the answer. The broker recomputes
// the digest from the call it is actually given, so an approval made for one action never covers
// another (another target, another scope, another ref).
//  - passkey: a WebAuthn assertion (ES256, user verification) over sha256(id | digest), from a
//    passkey registered with the broker at vault setup. The client computes the digest from what
//    it shows; what the person approves is what the broker does.
//  - core: where no passkey is registered, the approval is relayed by core (the way tier-3
//    confirmations work today). The broker still checks the digest, the expiry, single use and
//    every binding rule; the approval's authenticity rests on core, and Settings says so.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { canonical, type Card, type Challenge } from './protocol.ts';
import type { Passkey } from './store.ts';

export const APPROVAL_MS = 5 * 60_000;
export const PENDING_PER_TASK = 3;
export const APPROVALS_PER_HOUR = 30;
export const USES_PER_REF_HOUR = 3600;

export const digestOf = (action: unknown) => createHash('sha256').update(canonical(action)).digest('hex');
export const challengeBytes = (id: string, digest: string) => createHash('sha256').update(`${id}|${digest}`).digest();

interface Pending { digest: string; expires: number; used: boolean; task: string | null; passkey: boolean }
export interface ApprovalIn { id?: unknown; digest?: unknown; mode?: unknown; credential_id?: unknown; authenticator_data?: unknown; client_data_json?: unknown; signature?: unknown }

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Approvals {
  #pending = new Map<string, Pending>();
  #issued: number[] = [];
  #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }

  #sweep() {
    const t = this.#now();
    for (const [id, p] of this.#pending) if (p.used || p.expires < t - APPROVAL_MS) this.#pending.delete(id);
    this.#issued = this.#issued.filter((x) => x > t - 3600_000);
  }

  // Flood control: a few pending per task, a cap per hour. Beyond that, null (refused: rate).
  issue(action: unknown, card: Omit<Card, 'expires_at'>, task: string | null, passkey: boolean): Challenge | null {
    this.#sweep();
    const t = this.#now();
    const open = [...this.#pending.values()].filter((p) => !p.used && p.expires > t && p.task === task).length;
    if (open >= PENDING_PER_TASK || this.#issued.length >= APPROVALS_PER_HOUR) return null;
    const id = `ap_${randomBytes(12).toString('hex')}`;
    const digest = digestOf(action);
    const expires = t + APPROVAL_MS;
    this.#pending.set(id, { digest, expires, used: false, task, passkey });
    this.#issued.push(t);
    const expires_at = new Date(expires).toISOString();
    return { id, digest, expires_at, card: { ...card, expires_at } as Card, tier: card.tier };
  }

  // Checks an approval against the action the broker is about to do. Single use: a valid approval
  // is spent here, and a replay is refused.
  check(a: ApprovalIn, action: unknown, passkeys: Record<string, Passkey>, onCount: (id: string, n: number) => void): { ok: true; id: string } | { ok: false; why: string } {
    if (!a || typeof a.id !== 'string' || typeof a.digest !== 'string') return { ok: false, why: 'no approval id' };
    const p = this.#pending.get(a.id);
    if (!p) return { ok: false, why: 'unknown or already used' };
    if (p.used) return { ok: false, why: 'already used' };
    if (p.expires <= this.#now()) { this.#pending.delete(a.id); return { ok: false, why: 'expired' }; }
    const digest = digestOf(action);
    if (!eq(a.digest, p.digest) || !eq(digest, p.digest)) return { ok: false, why: 'made for another action' };
    if (a.mode === 'passkey') {
      const why = checkAssertion(a, challengeBytes(a.id, digest), passkeys, onCount);
      if (why) return { ok: false, why };
    } else if (a.mode !== 'core' || p.passkey) return { ok: false, why: p.passkey ? 'this action needs your passkey' : 'not an approval mode' };
    p.used = true;
    return { ok: true, id: a.id };
  }

  clear() { this.#pending.clear(); }
}

// ---- WebAuthn (ES256) ---------------------------------------------------------------------------

const b64u = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(s) ? Buffer.from(s, 'base64url') : null);

export function checkAssertion(a: ApprovalIn, challenge: Buffer, passkeys: Record<string, Passkey>, onCount: (id: string, n: number) => void): string | null {
  const id = typeof a.credential_id === 'string' ? a.credential_id : '';
  const pk = Object.hasOwn(passkeys, id) ? passkeys[id] : undefined;
  if (!pk) return 'not a passkey registered with the broker';
  const auth = b64u(a.authenticator_data);
  const cdj = b64u(a.client_data_json);
  const sig = b64u(a.signature);
  if (!auth || !cdj || !sig || auth.length < 37) return 'not a WebAuthn assertion';
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { cd = JSON.parse(cdj.toString('utf8')); } catch { return 'client data isn’t JSON'; }
  if (cd.type !== 'webauthn.get') return 'not an assertion';
  if (cd.challenge !== challenge.toString('base64url')) return 'signed for another challenge';
  if (typeof cd.origin !== 'string' || !pk.origins.includes(cd.origin) || cd.crossOrigin) return 'signed on an origin this passkey wasn’t registered for';
  if (!auth.subarray(0, 32).equals(createHash('sha256').update(pk.rp_id).digest())) return 'signed for another relying party';
  const flags = auth[32]!;
  if (!(flags & 0x01) || !(flags & 0x04)) return 'user presence and verification are required';
  const count = auth.readUInt32BE(33);
  if ((count !== 0 || pk.sign_count !== 0) && count <= pk.sign_count) return 'a replayed or cloned authenticator (its counter went back)';
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(pk.public_key, 'base64'), format: 'der', type: 'spki' });
    ok = verify('sha256', Buffer.concat([auth, createHash('sha256').update(cdj).digest()]), key, sig);
  } catch { ok = false; }
  if (!ok) return 'the signature doesn’t verify';
  if (count) onCount(id, count);
  return null;
}

// ---- rate caps ----------------------------------------------------------------------------------

export class Rates {
  #hits = new Map<string, number[]>();
  #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  take(key: string, perHour: number): boolean {
    const t = this.#now();
    const xs = (this.#hits.get(key) ?? []).filter((x) => x > t - 3600_000);
    if (xs.length >= perHour) { this.#hits.set(key, xs); return false; }
    xs.push(t);
    this.#hits.set(key, xs);
    return true;
  }
}

// Generated values: the CSPRNG under a per-site policy (24 characters by default, as M10d's
// generatePassword has), with rejection sampling so every character is equally likely.
export const DEFAULT_POLICY = { length: 24, alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%' };
export function generate(policy: { length: number; alphabet: string } = DEFAULT_POLICY): Buffer {
  const { length, alphabet } = policy;
  if (!Number.isInteger(length) || length < 16 || length > 128 || typeof alphabet !== 'string' || !/^[\x21-\x7e]+$/.test(alphabet) || new Set(alphabet).size < 16 || alphabet.length > 256) throw new Error('a generation policy is 16–128 characters from at least 16 distinct ones');
  const chars = [...new Set(alphabet)];
  const out = Buffer.alloc(length);
  const limit = 256 - (256 % chars.length);
  for (let i = 0; i < length;) {
    for (const b of randomBytes(length * 2)) {
      if (b >= limit) continue;
      out[i++] = chars[b % chars.length]!.charCodeAt(0);
      if (i === length) break;
    }
  }
  return out;
}

// Health flags, worked out in memory at unlock; never stored, never logged (§8).
export function weak(v: Buffer): boolean {
  const s = v.toString('utf8');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  return s.length < 12 || (s.length < 20 && classes < 3);
}
