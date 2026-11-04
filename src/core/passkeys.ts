// Passkeys on the hub's own screen (Insertion #3 T2). A request from this computer's console proves
// only that some program here sent it; a tier-3 approval there is confirmed with a passkey, so a
// person is present. Only public keys are kept.
//
// The checks are the broker's (src/broker/policy.ts Approvals and checkAssertion), ported line for
// line: core may not import broker code (tests/core/broker-boundary.test.ts), and the broker imports
// only Node and its own files. tests/core/console-passkeys.test.ts holds the two to the same answers.
//
// Owner decisions (2026-11-03):
//  - the first passkey is taken on trust, once; adding, replacing or removing one needs an existing
//    passkey; setup is complete only with two; the last one can't be removed (add the new one first);
//  - until a passkey exists, tier 3 on the console says "No passkey yet" and nothing tier-3 runs
//    (enforced in a later change, once setup is in the app).
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { canonicalJson } from './mesh/wire.ts';
import type { Route, Who } from './api.ts';
import type { Db } from './db.ts';
import { CoreError } from './errors.ts';

export const PASSKEYS_COMPLETE = 2;
const REGISTRATION_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;
// As the broker's: five minutes, single use, three open at once, thirty an hour.
export const APPROVAL_MS = 5 * 60_000;
const OPEN_MAX = 3;
const PER_HOUR = 30;

export interface ApprovalIn { id?: unknown; digest?: unknown; credential_id?: unknown; authenticator_data?: unknown; client_data_json?: unknown; signature?: unknown }
interface Key { public_key: string; rp_id: string; origins: string[]; sign_count: number }
export const digestOf = (action: unknown) => createHash('sha256').update(canonicalJson(action)).digest('hex');
export const challengeBytes = (id: string, digest: string) => createHash('sha256').update(`${id}|${digest}|`).digest();
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Row { id: string; name: string; public_key: string; rp_id: string; origins: string; sign_count: number; created_at: string }
export interface PasskeyView { id: string; name: string; created_at: string }
export interface PasskeysState { count: number; complete: boolean; first_enrolled_at: string | null; passkeys: PasskeyView[] }

const b64u = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(s) && s.length > 0 ? Buffer.from(s, 'base64url') : null);
const b64 = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? Buffer.from(s, 'base64') : null);
const CRED_ID = /^[A-Za-z0-9_-]{16,256}$/;

// A passkey works on a name, never an address: WebAuthn refuses an IP as its relying party, so the
// console must be opened at localhost for passkeys.
export function consoleOrigin(origin: unknown): { origin: string; rp_id: string } | null {
  if (typeof origin !== 'string') return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname !== 'localhost' || u.origin !== origin) return null;
  return { origin: u.origin, rp_id: 'localhost' };
}

export class ConsolePasskeys {
  #db: Db;
  #now: () => Date;
  #pending = new Map<string, { digest: string; expires: number; used: boolean }>();
  #issued: number[] = [];
  #registrations = new Map<string, { challenge: Buffer; expires: number; needs: boolean }>();

  constructor(o: { db: Db; now?: () => Date }) {
    this.#db = o.db;
    this.#now = o.now ?? (() => new Date());
  }

  #rows(): Row[] { return this.#db.all<Row>('SELECT * FROM console_passkey ORDER BY created_at, id'); }

  state(): PasskeysState {
    const rows = this.#rows();
    return { count: rows.length, complete: rows.length >= PASSKEYS_COMPLETE, first_enrolled_at: rows[0]?.created_at ?? null, passkeys: rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at })) };
  }

  #keys(): Record<string, Key> {
    return Object.fromEntries(this.#rows().map((r) => [r.id, { public_key: r.public_key, rp_id: r.rp_id, origins: JSON.parse(r.origins) as string[], sign_count: r.sign_count }]));
  }

  // A challenge for one exact action, to be signed with a registered passkey.
  challenge(action: Record<string, unknown>, what: string) {
    if (!this.#rows().length) throw new CoreError('conflict', 'No passkey yet: add one on Nova’s own screen first.');
    const t = this.#now().getTime();
    for (const [k, p] of this.#pending) if (p.used || p.expires < t - APPROVAL_MS) this.#pending.delete(k);
    this.#issued = this.#issued.filter((x) => x > t - 3600_000);
    const open = [...this.#pending.values()].filter((p) => !p.used && p.expires > t).length;
    if (open >= OPEN_MAX || this.#issued.length >= PER_HOUR) throw new CoreError('too_many', 'Too many tries. Wait a minute, then try again.');
    const id = `ap_${randomBytes(12).toString('hex')}`;
    const digest = digestOf(action);
    this.#pending.set(id, { digest, expires: t + APPROVAL_MS, used: false });
    this.#issued.push(t);
    return { id, digest, what, expires_at: new Date(t + APPROVAL_MS).toISOString(), challenge: challengeBytes(id, digest).toString('base64url'), allow: this.#rows().map((r) => r.id) };
  }

  // Whether `approval` confirms exactly `action` with a registered passkey. Single use.
  verify(action: Record<string, unknown>, approval: unknown): string | null {
    const a = (approval && typeof approval === 'object' ? approval : {}) as ApprovalIn;
    if (typeof a.id !== 'string' || typeof a.digest !== 'string') return 'no approval';
    const p = this.#pending.get(a.id);
    if (!p) return 'unknown or already used';
    if (p.used) return 'already used';
    if (p.expires <= this.#now().getTime()) { this.#pending.delete(a.id); return 'expired'; }
    const digest = digestOf(action);
    if (!eq(a.digest, p.digest) || !eq(digest, p.digest)) return 'made for another action';
    const why = checkAssertion(a, challengeBytes(a.id, digest), this.#keys(), (id, n) => this.#db.run('UPDATE console_passkey SET sign_count = ? WHERE id = ?', n, id));
    if (why) return why;
    p.used = true;
    return null;
  }

  // Starting to add one: a fresh registration challenge, and, once any passkey exists, an approval
  // challenge the person signs with an existing one first.
  options(origin: unknown) {
    const o = consoleOrigin(origin);
    if (!o) throw new CoreError('validation', 'Open Nova at http://localhost on this computer to use a passkey: a passkey works on a name, not an address.');
    const rows = this.#rows();
    if (rows.length >= MAX_PASSKEYS) throw new CoreError('conflict', `Nova keeps up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
    const id = `rg_${randomBytes(12).toString('hex')}`;
    const challenge = randomBytes(32);
    const t = this.#now().getTime();
    for (const [k, v] of this.#registrations) if (v.expires < t) this.#registrations.delete(k);
    this.#registrations.set(id, { challenge, expires: t + REGISTRATION_MS, needs: rows.length > 0 });
    return {
      registration: id,
      challenge: challenge.toString('base64url'),
      rp: { id: o.rp_id, name: 'Nova' },
      user: { id: Buffer.from('nova-console').toString('base64url'), name: 'Nova’s own screen', displayName: 'Nova’s own screen' },
      exclude: rows.map((r) => r.id),
      ...(rows.length ? { approval: this.challenge({ op: 'add-passkey', registration: id }, 'Add a passkey for tier-3 actions') } : {}),
    };
  }

  add(body: Record<string, unknown>, origin: unknown): PasskeysState {
    const o = consoleOrigin(origin);
    if (!o) throw new CoreError('validation', 'Open Nova at http://localhost on this computer to use a passkey.');
    const reg = typeof body.registration === 'string' ? this.#registrations.get(body.registration) : undefined;
    if (!reg || reg.expires < this.#now().getTime()) throw new CoreError('conflict', 'This request ran out of time before it was confirmed, so no passkey was added. Ask again for a fresh one.');
    this.#registrations.delete(body.registration as string);
    if (reg.needs || this.#rows().length) {
      const why = this.verify({ op: 'add-passkey', registration: body.registration }, body.approval);
      if (why) throw new CoreError('forbidden', `Adding a passkey needs one you already have: ${why}.`);
    }
    const id = typeof body.credential_id === 'string' && CRED_ID.test(body.credential_id) ? body.credential_id : null;
    const cdj = b64u(body.client_data_json);
    const auth = b64u(body.authenticator_data);
    const spki = b64(body.public_key);
    if (!id || !cdj || !auth || !spki || auth.length < 55) throw new CoreError('validation', 'That isn’t a passkey Nova can add.');
    let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
    try { cd = JSON.parse(cdj.toString('utf8')); } catch { throw new CoreError('validation', 'That isn’t a passkey Nova can add.'); }
    if (cd.type !== 'webauthn.create' || cd.challenge !== reg.challenge.toString('base64url')) throw new CoreError('validation', 'That passkey was made for another request.');
    if (cd.origin !== o.origin || cd.crossOrigin) throw new CoreError('validation', 'That passkey was made on another page.');
    if (!auth.subarray(0, 32).equals(createHash('sha256').update(o.rp_id).digest())) throw new CoreError('validation', 'That passkey was made for another site.');
    const flags = auth[32]!;
    if (!(flags & 0x01) || !(flags & 0x04) || !(flags & 0x40)) throw new CoreError('validation', 'A passkey here needs your presence and verification (a fingerprint, face, PIN or screen lock).');
    // The credential the authenticator data names is the one being added.
    const idLen = auth.readUInt16BE(53);
    if (auth.length < 55 + idLen || !auth.subarray(55, 55 + idLen).equals(Buffer.from(id, 'base64url'))) throw new CoreError('validation', 'That passkey’s details don’t match.');
    let key;
    try { key = createPublicKey({ key: spki, format: 'der', type: 'spki' }); } catch { throw new CoreError('validation', 'That passkey’s public key can’t be read.'); }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new CoreError('validation', 'Nova accepts passkeys that sign with ES256 (P-256).');
    if (this.#db.get('SELECT 1 FROM console_passkey WHERE id = ?', id)) throw new CoreError('conflict', 'That passkey is already added.');
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : `Passkey ${this.#rows().length + 1}`;
    this.#db.run('INSERT INTO console_passkey (id, name, public_key, rp_id, origins, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, name, spki.toString('base64'), o.rp_id, JSON.stringify([o.origin]), auth.readUInt32BE(33), this.#now().toISOString());
    return this.state();
  }

  removeChallenge(id: string) { return this.challenge({ op: 'remove-passkey', id }, 'Remove a passkey'); }

  remove(id: string, approval: unknown): PasskeysState {
    const rows = this.#rows();
    if (!rows.some((r) => r.id === id)) throw new CoreError('not_found', 'There is no such passkey.');
    if (rows.length === 1) throw new CoreError('conflict', 'This is your only passkey. Add the new one first, then remove this one.');
    const why = this.verify({ op: 'remove-passkey', id }, approval);
    if (why) throw new CoreError('forbidden', `Removing a passkey needs one you already have: ${why}.`);
    this.#db.run('DELETE FROM console_passkey WHERE id = ?', id);
    return this.state();
  }

  routes(): Route[] {
    const only = (who: Who) => { if (who.principal.kind !== 'console') throw new CoreError('forbidden', 'Passkeys are managed on the hub’s own screen only.'); };
    return [
      { method: 'GET', path: '/security/passkeys', summary: 'The passkeys that confirm tier-3 actions on this screen: how many, since when, and whether setup is complete (two).', handle: ({ who }) => { only(who); return this.state(); } },
      { method: 'POST', path: '/security/passkeys/options', summary: 'Start adding a passkey: a registration challenge, and an approval challenge to sign with an existing passkey when one exists.', handle: ({ who, headers }) => { only(who); return this.options(headers.origin); } },
      { method: 'POST', path: '/security/passkeys', summary: 'Add a passkey: its public key and WebAuthn creation data; after the first, an approval from an existing passkey.', body: '{registration, credential_id, public_key, authenticator_data, client_data_json, name?, approval?}', status: 201, handle: ({ who, body, headers }) => { only(who); return this.add(body, headers.origin); } },
      { method: 'POST', path: '/security/passkeys/{id}/remove-challenge', summary: 'An approval challenge for removing a passkey, to sign with one you keep.', handle: ({ who, params }) => { only(who); return this.removeChallenge(params.id!); } },
      { method: 'DELETE', path: '/security/passkeys/{id}', summary: 'Remove a passkey, with an approval from an existing one. The last passkey can’t be removed.', body: '{approval}', handle: ({ who, params, body }) => { only(who); return this.remove(params.id!, body.approval); } },
    ];
  }
}

// The broker's checkAssertion (src/broker/policy.ts): the same checks, in the same order.
export function checkAssertion(a: ApprovalIn, challenge: Buffer, keys: Record<string, Key>, onCount: (id: string, n: number) => void): string | null {
  const id = typeof a.credential_id === 'string' ? a.credential_id : '';
  const pk = Object.hasOwn(keys, id) ? keys[id] : undefined;
  if (!pk) return 'not a passkey added on Nova’s own screen';
  const auth = b64u(a.authenticator_data);
  const cdj = b64u(a.client_data_json);
  const sig = b64u(a.signature);
  if (!auth || !cdj || !sig || auth.length < 37) return 'not a WebAuthn assertion';
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { cd = JSON.parse(cdj.toString('utf8')); } catch { return 'client data isn’t JSON'; }
  if (cd.type !== 'webauthn.get') return 'not an assertion';
  if (cd.challenge !== challenge.toString('base64url')) return 'signed for another challenge';
  if (typeof cd.origin !== 'string' || !pk.origins.includes(cd.origin) || cd.crossOrigin) return 'signed on an origin this passkey wasn’t added for';
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
