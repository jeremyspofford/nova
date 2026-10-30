// Enrollment (CONTRACTS §5): one protocol, three front doors (QR, hub address + code, one-line
// command). The person makes a code on a device they trust; the joining device sends its public
// keys with the code and a commitment to a nonce; the hub answers with its own nonce; the device
// reveals; both screens show the same six digits; the person approves on the hub (tier 3). Only
// that approval creates a device record.
//
// The code is kept only as a salted hash. Between the join and the reveal the hub also holds it in
// memory, because the digits are computed over it; it is spent by then, and a restart forgets it
// (the request then expires).
import { EventEmitter } from 'node:events';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { MeshIdentity } from './identity.ts';
import { SlidingWindowLimiter } from './limiter.ts';
import { cleanName, KINDS, type Device, type Devices, type Kind } from './devices.ts';
import {
  PAIRING_CODE_TTL_MS, ed25519PublicKey, freshTime, keyFingerprint, newPairingCode, newPairingNonce, normalizePairingCode,
  pairingCodeHash, pairingCommitment, pairingConfirmationV2, revealMessage, sameDigest, statusMessage, verifyDeviceSignature, x25519PublicKey,
  x25519Statement, type SignedRoster,
} from './wire.ts';

// A request must be revealed soon after the join, and approved within ten minutes of the reveal.
export const JOIN_REVEAL_TTL_MS = 2 * 60_000;
export const JOIN_APPROVE_TTL_MS = 10 * 60_000;

export type JoinState = 'pending' | 'approved' | 'denied' | 'expired';

interface RequestRow {
  id: string; pairing_id: string; public_key: string; x25519_public_key: string; fingerprint: string; name: string; platform: string; kind: Kind;
  capabilities: string; address: string | null; commitment: string; hub_nonce: string; device_nonce: string | null; confirmation: string | null;
  state: JoinState; reason: string | null; last_time: number; device_id: string | null; created_at: string; revealed_at: string | null;
  decided_at: string | null; decided_by: string | null; expires_at: string;
}

// What the approval prompt shows: who is asking, what for, and the digits to compare.
export interface JoinRequest {
  id: string; name: string; platform: string; kind: Kind; capabilities: string[]; fingerprint: string;
  confirmation: string | null; state: JoinState; reason: string | null; device_id: string | null;
  created_at: string; revealed_at: string | null; decided_at: string | null; expires_at: string;
}

const view = (r: RequestRow): JoinRequest => ({
  id: r.id, name: r.name, platform: r.platform, kind: r.kind, capabilities: JSON.parse(r.capabilities) as string[], fingerprint: r.fingerprint,
  confirmation: r.confirmation, state: r.state, reason: r.reason, device_id: r.device_id,
  created_at: r.created_at, revealed_at: r.revealed_at, decided_at: r.decided_at, expires_at: r.expires_at,
});

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

export interface Pairing { pairing_id: string; code: string; expires_at: string; url: string; command: string; hub_url: string; hub_fingerprint: string }

export class Enrollment extends EventEmitter {
  #db: Db;
  #log: Log;
  #devices: Devices;
  #identity: MeshIdentity;
  #now: () => Date;
  #publicUrl: () => string | null;
  // Spent codes, by request, only until the reveal.
  #codes = new Map<string, { code: string; until: number }>();
  // Per client address: any public enrollment call, status polls, and wrong codes. New codes are
  // limited for the whole hub.
  readonly limits: Record<'calls' | 'polls' | 'guesses' | 'pairings', SlidingWindowLimiter>;
  #reported = new Map<string, number>();

  constructor(o: { db: Db; log: Log; devices: Devices; identity: MeshIdentity; now: () => Date; publicUrl: () => string | null }) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.#devices = o.devices;
    this.#identity = o.identity;
    this.#now = o.now;
    this.#publicUrl = o.publicUrl;
    const clock = () => this.#now().getTime();
    this.limits = {
      calls: new SlidingWindowLimiter({ limit: 30, windowMs: 60_000, now: clock }),
      polls: new SlidingWindowLimiter({ limit: 90, windowMs: 60_000, now: clock }),
      guesses: new SlidingWindowLimiter({ limit: 10, windowMs: 5 * 60_000, now: clock }),
      pairings: new SlidingWindowLimiter({ limit: 20, windowMs: 60 * 60_000, now: clock }),
    };
  }

  // Counts one call from `address`; refuses it, plainly, when there were too many. A refusal is
  // recorded as a problem once per address every ten minutes, so a flood is one line, not a flood.
  limit(kind: 'calls' | 'polls', address: string): void {
    if (this.limits[kind].take(address)) return;
    this.#refuse(address, kind === 'polls' ? 'checked on a request to join too often' : 'tried to add a device too many times');
  }

  #refuse(address: string, what: string): never {
    const now = this.#now().getTime();
    if (now - (this.#reported.get(address) ?? -Infinity) > 10 * 60_000) {
      this.#reported.set(address, now);
      this.#log.problem('mesh', `Nova turned away a device at ${address} that ${what}. If that wasn’t you adding a device, someone else may be trying to.`);
    }
    throw new CoreError('too_many', 'Too many tries from this address. Wait a few minutes, then try again.');
  }

  // ---- 1. a code ------------------------------------------------------------------------------

  createPairing(by: string): Pairing {
    const base = this.#publicUrl();
    if (!base) throw new CoreError('conflict', 'Other devices can’t reach this Nova yet. Start it with a mesh address (NOVA_MESH_URL) first; the README says how.');
    if (!this.limits.pairings.take('hub')) throw new CoreError('too_many', 'That’s a lot of new codes in an hour. Wait a while, then make another.');
    const id = crypto.randomUUID();
    const code = newPairingCode();
    const at = this.#now();
    const expires = new Date(at.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    this.#db.run('INSERT INTO pairing (id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', id, pairingCodeHash(id, code), by, at.toISOString(), expires);
    this.#log.info('mesh', 'A pairing code was made.', { pairing: id, by });
    const fp = this.#identity.fingerprint;
    return {
      pairing_id: id, code, expires_at: expires, hub_url: base, hub_fingerprint: fp,
      // In the fragment, so the code never reaches a server log.
      url: `${base}/pair#c=${code}&h=${fp}`,
      command: `curl -fsS ${base}/join.sh | sh -s -- ${code}`,
    };
  }

  // ---- 2. the device asks to join -------------------------------------------------------------

  join(body: Record<string, unknown>, address: string): { request_id: string; pairing_id: string; hub_nonce: string; hub_fingerprint: string } {
    const claims = (typeof body.claims === 'object' && body.claims !== null ? body.claims : {}) as Record<string, unknown>;
    const problems: string[] = [];
    const pk = typeof body.public_key === 'string' ? body.public_key : '';
    const xk = typeof body.x25519_public_key === 'string' ? body.x25519_public_key : '';
    if (!ed25519PublicKey(pk)) problems.push('public_key must be a raw Ed25519 public key, base64url.');
    if (!x25519PublicKey(xk)) problems.push('x25519_public_key must be a raw X25519 public key, base64url.');
    else if (ed25519PublicKey(pk) && !verifyDeviceSignature(pk, x25519Statement(xk), String(body.x25519_sig ?? ''))) problems.push('x25519_sig must be the device key’s signature of its X25519 key.');
    if (typeof body.commitment !== 'string' || !NONCE.test(body.commitment)) problems.push('commitment must be the base64url SHA-256 commitment to the device’s nonce.');
    const kind = claims.kind as Kind;
    if (!KINDS.includes(kind)) problems.push(`claims.kind must be one of ${KINDS.join(', ')}.`);
    let name = '';
    try { name = cleanName(claims.name, 'device name'); } catch (e) { problems.push((e as Error).message); }
    const platform = typeof claims.platform === 'string' ? claims.platform.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
    const caps = claims.capabilities ?? [];
    if (!Array.isArray(caps) || caps.length > 32 || !caps.every((c) => typeof c === 'string' && CAPABILITY.test(c))) problems.push('claims.capabilities must be up to 32 short names.');
    let addr: string | null = null;
    if (kind === 'standby' && claims.address !== undefined) {
      try {
        const u = new URL(String(claims.address));
        if (!['http:', 'https:'].includes(u.protocol) || String(claims.address).length > 200) throw new Error();
        addr = u.origin;
      } catch { problems.push('claims.address must be the standby’s own http(s) address.'); }
    }
    if (problems.length) throw new CoreError('validation', 'That request to join isn’t complete.', problems);

    const code = normalizePairingCode(String(body.code ?? ''));
    const nowMs = this.#now().getTime();
    const at = new Date(nowMs).toISOString();
    const open = code ? this.#db.all<{ id: string; code_hash: string }>('SELECT id, code_hash FROM pairing WHERE used_at IS NULL AND expires_at > ?', at) : [];
    const pairing = code ? open.find((p) => sameDigest(p.code_hash, pairingCodeHash(p.id, code))) : undefined;
    // Wrong, spent and expired codes look the same from outside.
    if (!pairing || !code) {
      if (!this.limits.guesses.take(address)) this.#refuse(address, 'typed too many wrong codes');
      throw new CoreError('validation', 'That code didn’t work.');
    }
    const known = this.#devices.byKey(pk);
    if (known?.trust === 'revoked') throw new CoreError('forbidden', 'This device’s key was revoked, so it can’t join again. Make a new key on the device, then add it again.');
    if (known) throw new CoreError('conflict', 'This device is already paired.');
    if (this.#db.get(`SELECT 1 FROM join_request WHERE public_key = ? AND state = 'pending'`, pk)) throw new CoreError('conflict', 'This device is already asking to join.');

    const id = crypto.randomUUID();
    const hubNonce = newPairingNonce();
    this.#db.tx(() => {
      this.#db.run('UPDATE pairing SET used_at = ? WHERE id = ?', at, pairing.id);
      this.#db.run(
        `INSERT INTO join_request (id, pairing_id, public_key, x25519_public_key, fingerprint, name, platform, kind, capabilities, address, commitment, hub_nonce, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id, pairing.id, pk, xk, keyFingerprint(pk), name, platform, kind, JSON.stringify(caps), addr, body.commitment as string, hubNonce, at, new Date(nowMs + JOIN_REVEAL_TTL_MS).toISOString(),
      );
    });
    this.#codes.set(id, { code, until: nowMs + JOIN_REVEAL_TTL_MS });
    this.#log.info('mesh', 'A device asked to join.', { request: id, kind });
    this.emit('change', view(this.#row(id)!));
    return { request_id: id, pairing_id: pairing.id, hub_nonce: hubNonce, hub_fingerprint: this.#identity.fingerprint };
  }

  // ---- 3. the device reveals its nonce; both sides now know the digits ------------------------

  reveal(id: string, body: Record<string, unknown>): { confirmation: string } {
    const r = this.#live(id);
    if (r.device_nonce) throw new CoreError('conflict', 'This request was already revealed.');
    this.#signed(r, body, revealMessage);
    const nonce = body.device_nonce;
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new CoreError('validation', 'device_nonce must be 32 random bytes, base64url.');
    const at = this.#now().toISOString();
    if (!sameDigest(pairingCommitment(r.public_key, nonce), r.commitment)) {
      this.#decide(r, 'denied', 'The device’s nonce didn’t match what it committed to.', 'hub');
      this.#log.problem('mesh', `A request to join from “${r.name}” was refused because its check didn’t match. If you weren’t adding a device just now, someone else may have tried.`);
      throw new CoreError('validation', 'The confirmation check failed. Start again with a new code.');
    }
    const held = this.#codes.get(r.id);
    this.#codes.delete(r.id);
    if (!held) {
      this.#decide(r, 'expired', 'Nova restarted before the device revealed its nonce.', 'hub');
      throw new CoreError('conflict', 'This request expired. Start again with a new code.');
    }
    const confirmation = pairingConfirmationV2({
      hubFingerprint: this.#identity.fingerprint, pairingId: r.pairing_id, publicKey: r.public_key, code: held.code, deviceNonce: nonce, hubNonce: r.hub_nonce,
    });
    this.#db.run(
      'UPDATE join_request SET device_nonce = ?, confirmation = ?, revealed_at = ?, expires_at = ? WHERE id = ?',
      nonce, confirmation, at, new Date(this.#now().getTime() + JOIN_APPROVE_TTL_MS).toISOString(), r.id,
    );
    this.emit('change', view(this.#row(r.id)!));
    return { confirmation };
  }

  // ---- 5. the device polls, signed, until the person decides ----------------------------------

  status(id: string, query: { time: unknown; signature: unknown }): { state: JoinState; reason?: string; device_id?: string; roster?: SignedRoster } {
    this.sweep();
    const r = this.#row(id);
    if (!r) throw new CoreError('not_found', 'There is no such request.');
    this.#signed(r, query, statusMessage);
    const fresh = this.#row(id)!;
    if (fresh.state === 'approved' && fresh.device_id) return { state: 'approved', device_id: fresh.device_id, roster: this.#devices.roster() };
    return { state: fresh.state, ...(fresh.reason ? { reason: fresh.reason } : {}) };
  }

  // ---- 4. the person decides --------------------------------------------------------------------

  // Waiting for the person: revealed, so the digits can be compared.
  requests(): JoinRequest[] {
    this.sweep();
    return this.#db.all<RequestRow>(`SELECT * FROM join_request WHERE state = 'pending' AND confirmation IS NOT NULL ORDER BY revealed_at`).map(view);
  }

  get(id: string): JoinRequest {
    const r = this.#row(id);
    if (!r) throw new CoreError('not_found', 'There is no such request.');
    return view(r);
  }

  // Tier 3: explicit confirmation every time.
  approve(id: string, o: { confirm: boolean; by: string }): { request: JoinRequest; device: Device } {
    if (!o.confirm) throw new CoreError('validation', 'Adding a device needs an explicit confirmation: send confirm: true.');
    const r = this.#live(id);
    if (!r.confirmation) throw new CoreError('conflict', 'This device hasn’t shown its digits yet, so there is nothing to compare. Wait for them.');
    if (r.kind === 'standby') {
      const s = this.#devices.state().standby_id;
      if (s && this.#devices.find(s)?.trust === 'trusted') throw new CoreError('conflict', 'There is a standby already. Revoke it first; Nova keeps one standby.');
    }
    const device = this.#db.tx(() => {
      const d = this.#devices.add({ name: r.name, platform: r.platform, kind: r.kind, public_key: r.public_key, x25519_public_key: r.x25519_public_key, capabilities: JSON.parse(r.capabilities) as string[], address: r.address }, o.by);
      this.#db.run(`UPDATE join_request SET state = 'approved', device_id = ?, decided_at = ?, decided_by = ? WHERE id = ?`, d.id, this.#now().toISOString(), o.by, r.id);
      return d;
    });
    const request = view(this.#row(r.id)!);
    this.emit('change', request);
    return { request, device };
  }

  deny(id: string, by: string): JoinRequest {
    const r = this.#live(id);
    this.#decide(r, 'denied', 'Denied by you.', by);
    return this.get(id);
  }

  // Requests nobody answered in time expire. One the person could have answered (it was showing its
  // digits) is a problem worth knowing about; one that never got that far is just tidied away.
  sweep(): void {
    const now = this.#now();
    for (const [id, c] of this.#codes) if (c.until <= now.getTime()) this.#codes.delete(id);
    const stale = this.#db.all<RequestRow>(`SELECT * FROM join_request WHERE state = 'pending' AND expires_at <= ?`, now.toISOString());
    for (const r of stale) {
      this.#decide(r, 'expired', r.confirmation ? 'Nobody answered in time.' : 'The device didn’t finish in time.', 'hub');
      if (r.confirmation) this.#log.problem('mesh', `“${r.name}” asked to join and wasn’t answered in time, so the request expired. Make a new code to try again.`);
    }
  }

  // ---- internals --------------------------------------------------------------------------------

  #row(id: string): RequestRow | undefined {
    return this.#db.get<RequestRow>('SELECT * FROM join_request WHERE id = ?', id);
  }

  // A request that is still waiting, or a plain refusal.
  #live(id: string): RequestRow {
    this.sweep();
    const r = this.#row(id);
    if (!r) throw new CoreError('not_found', 'There is no such request.');
    if (r.state !== 'pending') throw new CoreError('conflict', r.state === 'expired' ? 'This request expired. Start again with a new code.' : 'This request was already answered.');
    return r;
  }

  // A device-signed call: the device's key, a fresh time, newer than any accepted before.
  #signed(r: RequestRow, body: { time?: unknown; signature?: unknown }, message: (id: string, t: number) => Buffer): void {
    const time = typeof body.time === 'string' && /^\d+$/.test(body.time) ? Number(body.time) : body.time;
    if (typeof time !== 'number' || !freshTime(time, Math.floor(this.#now().getTime() / 1000))) throw new CoreError('unauthorized', 'The signed time is too far from the hub’s clock. Check the device’s clock.');
    if (!verifyDeviceSignature(r.public_key, message(r.id, time), String(body.signature ?? ''))) throw new CoreError('unauthorized', 'That signature isn’t from the device that asked.');
    if (time <= r.last_time) throw new CoreError('unauthorized', 'That signed request was already used. Sign a new one.');
    this.#db.run('UPDATE join_request SET last_time = ? WHERE id = ? AND last_time < ?', time, r.id, time);
    r.last_time = time;
  }

  #decide(r: RequestRow, state: JoinState, reason: string, by: string): void {
    this.#codes.delete(r.id);
    this.#db.run('UPDATE join_request SET state = ?, reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = ?', state, reason, this.#now().toISOString(), by, r.id, 'pending');
    this.emit('change', view(this.#row(r.id)!));
  }
}

