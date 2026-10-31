// The device registry (CONTRACTS §5): every device that was approved, this hub included, with its
// trust; device sessions; this node's place in the mesh; and the roster devices pin. Revoking a
// device ends its sessions at once and is announced, so whoever holds its open streams closes them.
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { MeshIdentity } from './identity.ts';
import { freshTime, keyFingerprint, sessionMessage, signRoster, verifyDeviceSignature, type Roster, type RosterMember, type SignedRoster } from './wire.ts';

export const KINDS = ['browser', 'phone', 'computer', 'standby'] as const;
export type Kind = (typeof KINDS)[number];
export type Role = 'client' | 'spoke' | 'standby' | 'hub';
export type Trust = 'trusted' | 'revoked';
// A person's own clients are `client`; computers are spokes; a standby is the standby.
export const ROLE_OF: Record<Kind, Role> = { browser: 'client', phone: 'client', computer: 'spoke', standby: 'standby' };

export const SESSION_TTL_MS = 12 * 60 * 60_000;
// A device counts as online if it was heard from this recently (or has a stream open).
export const ONLINE_WINDOW_MS = 2 * 60_000;
const TOUCH_EVERY_MS = 30_000;

export interface Device {
  id: string;
  name: string;
  platform: string;
  kind: Kind;
  role: Role;
  public_key: string;
  x25519_public_key: string;
  fingerprint: string;
  capabilities: string[];
  trust: Trust;
  can_approve: boolean;
  address: string | null;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_seen: string | null;
}

interface Row extends Omit<Device, 'capabilities' | 'can_approve'> { capabilities: string; can_approve: number }

export interface MeshState { epoch: number; role: 'hub' | 'standby'; hub_id: string | null; standby_id: string | null; updated_at: string }

export interface NewDevice { name: string; platform: string; kind: Kind; public_key: string; x25519_public_key: string; capabilities: string[]; address?: string | null }

const fromRow = (r: Row): Device => ({ ...r, capabilities: JSON.parse(r.capabilities) as string[], can_approve: r.can_approve === 1 });
const tokenHash = (token: string) => createHash('sha256').update(`nova-session\0${token}`, 'utf8').digest('hex');

export function cleanName(v: unknown, what = 'name'): string {
  // Control characters out, spaces collapsed: a name is shown on other screens.
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new CoreError('validation', `A ${what} is required.`);
  if (s.length > 60) throw new CoreError('validation', `A ${what} can be up to 60 characters.`);
  return s;
}

export class Devices extends EventEmitter {
  readonly identity: MeshIdentity;
  #db: Db;
  #log: Log;
  #now: () => Date;
  #publicUrl: () => string | null;
  #touched = new Map<string, number>();

  constructor(o: { db: Db; log: Log; identity: MeshIdentity; now: () => Date; publicUrl: () => string | null }) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.identity = o.identity;
    this.#now = o.now;
    this.#publicUrl = o.publicUrl;
  }

  // This node is in its own registry, as the hub, and the mesh state names it, from the first start.
  ensureHub(): void {
    const at = this.#now().toISOString();
    const id = this.identity.id;
    this.#db.tx(() => {
      if (!this.#db.get('SELECT 1 FROM device WHERE id = ?', id)) {
        this.#db.run(
          `INSERT INTO device (id, name, platform, kind, role, public_key, x25519_public_key, fingerprint, capabilities, trust, can_approve, created_at, approved_at, last_seen)
           VALUES (?, 'Hub', ?, 'computer', 'hub', ?, ?, ?, '[]', 'trusted', 1, ?, ?, ?)`,
          id, process.platform, this.identity.publicKey, this.identity.x25519PublicKey, this.identity.fingerprint, at, at, at,
        );
      }
      this.#db.run(`INSERT OR IGNORE INTO mesh_state (id, epoch, role, hub_id, standby_id, updated_at) VALUES (1, 1, 'hub', ?, NULL, ?)`, id, at);
    });
  }

  state(): MeshState {
    return this.#db.get<MeshState>('SELECT epoch, role, hub_id, standby_id, updated_at FROM mesh_state WHERE id = 1')!;
  }

  list(): Device[] {
    return this.#db.all<Row>(`SELECT * FROM device ORDER BY role = 'hub' DESC, trust = 'trusted' DESC, COALESCE(approved_at, created_at)`).map(fromRow);
  }

  find(id: string): Device | null {
    const r = this.#db.get<Row>('SELECT * FROM device WHERE id = ?', id);
    return r ? fromRow(r) : null;
  }

  get(id: string): Device {
    const d = this.find(id);
    if (!d) throw new CoreError('not_found', 'There is no such device.');
    return d;
  }

  byKey(publicKey: string): Device | null {
    const r = this.#db.get<Row>('SELECT * FROM device WHERE public_key = ?', publicKey);
    return r ? fromRow(r) : null;
  }

  // Only enrollment calls this, after the person approved.
  add(d: NewDevice, by: string): Device {
    const at = this.#now().toISOString();
    const id = crypto.randomUUID();
    this.#db.run(
      `INSERT INTO device (id, name, platform, kind, role, public_key, x25519_public_key, fingerprint, capabilities, trust, can_approve, address, created_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'trusted', 0, ?, ?, ?)`,
      id, d.name, d.platform, d.kind, ROLE_OF[d.kind], d.public_key, d.x25519_public_key, keyFingerprint(d.public_key), JSON.stringify(d.capabilities), d.kind === 'standby' ? d.address ?? null : null, at, at,
    );
    if (d.kind === 'standby') this.#db.run('UPDATE mesh_state SET standby_id = ?, updated_at = ? WHERE id = 1', id, at);
    const device = this.get(id);
    this.#log.info('mesh', 'Device approved.', { device: id, kind: d.kind, by });
    this.emit('change', { action: 'approved', device });
    return device;
  }

  rename(id: string, name: unknown): Device {
    const d = this.get(id);
    this.#db.run('UPDATE device SET name = ? WHERE id = ?', cleanName(name), d.id);
    const device = this.get(id);
    this.emit('change', { action: 'renamed', device });
    return device;
  }

  // Letting a device approve new ones is a permissions change: tier 3, confirmed every time.
  setCanApprove(id: string, value: unknown, confirm: boolean): Device {
    const d = this.get(id);
    if (typeof value !== 'boolean') throw new CoreError('validation', 'can_approve must be true or false.');
    if (!confirm) throw new CoreError('validation', 'Changing who can approve new devices needs an explicit confirmation: send confirm: true.');
    if (d.role === 'hub') throw new CoreError('conflict', 'The hub always approves its own devices.');
    if (d.trust !== 'trusted') throw new CoreError('conflict', 'That device was revoked.');
    if (value && d.role !== 'client') throw new CoreError('validation', 'Only a phone or browser you use can approve new devices.');
    this.#db.run('UPDATE device SET can_approve = ? WHERE id = ?', value ? 1 : 0, d.id);
    const device = this.get(id);
    this.#log.info('mesh', value ? 'Device may approve new devices.' : 'Device may no longer approve new devices.', { device: id });
    this.emit('change', { action: 'can_approve', device });
    return device;
  }

  // Tier 3. The device's sessions end now, its open streams are closed by whoever holds them
  // (the 'revoked' event), and its key can never start a session or enroll again.
  revoke(id: string, o: { confirm: boolean; reason?: unknown; by: string }): Device {
    const d = this.get(id);
    if (!o.confirm) throw new CoreError('validation', 'Revoking a device needs an explicit confirmation: send confirm: true.');
    if (d.role === 'hub') throw new CoreError('conflict', 'This is the hub; it can’t revoke itself.');
    if (d.trust === 'revoked') throw new CoreError('conflict', 'That device was already revoked.');
    const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 200) : 'Revoked by you.';
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run(`UPDATE device SET trust = 'revoked', can_approve = 0, revoked_at = ?, revoked_reason = ? WHERE id = ?`, at, reason, d.id);
      this.#db.run('DELETE FROM device_session WHERE device_id = ?', d.id);
      this.#db.run('UPDATE mesh_state SET standby_id = NULL, updated_at = ? WHERE id = 1 AND standby_id = ?', at, d.id);
    });
    const device = this.get(id);
    this.#log.info('mesh', 'Device revoked.', { device: id, by: o.by });
    this.emit('revoked', device);
    this.emit('change', { action: 'revoked', device });
    return device;
  }

  // After this hub's keys were replaced (replaceIdentityKeys): its own record takes the new keys,
  // and the epoch goes up so the roster it now signs supersedes any signed with the old key.
  // Computers and the standby pinned the old key and would believe a roster signed with it, so
  // they are revoked and must be added again. Phones and browsers keep their sessions: they never
  // take a roster on trust after pairing.
  rekeyHub(by: string): { epoch: number; revoked: Device[] } {
    const id = this.identity.id;
    const hub = this.get(id);
    if (hub.role !== 'hub' || this.state().role !== 'hub') throw new CoreError('conflict', 'This node isn’t the hub, so its keys aren’t the ones devices trust. Enroll a standby again with a new home instead.');
    const pinned = this.list().filter((d) => d.trust === 'trusted' && d.role !== 'hub' && (d.kind === 'computer' || d.kind === 'standby'));
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run('UPDATE device SET public_key = ?, x25519_public_key = ?, fingerprint = ? WHERE id = ?', this.identity.publicKey, this.identity.x25519PublicKey, this.identity.fingerprint, id);
      this.#db.run('UPDATE mesh_state SET epoch = epoch + 1, updated_at = ? WHERE id = 1', at);
    });
    const revoked = pinned.map((d) => this.revoke(d.id, { confirm: true, reason: 'The hub’s keys were replaced. Add it again.', by }));
    this.#log.info('mesh', 'The hub’s keys were replaced.', { epoch: this.state().epoch, revoked: revoked.length, by });
    this.emit('change', { action: 'rekeyed', device: this.get(id) });
    return { epoch: this.state().epoch, revoked };
  }

  // Heard from now. Written at most every 30 s per device. Every call is also a `heard` event, before
  // the throttle: a request a trusted device's session just made (M10d's dead-man's switch listens).
  touch(id: string): void {
    this.emit('heard', id);
    const now = this.#now().getTime();
    if (now - (this.#touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.#touched.set(id, now);
    this.#db.run(`UPDATE device SET last_seen = ? WHERE id = ? AND trust = 'trusted'`, new Date(now).toISOString(), id);
  }

  // ---- sessions ------------------------------------------------------------------------------

  // A trusted device proves it holds its key by signing `nova-session-v1.<id>.<time>` with a time
  // within a minute of the hub's. Each signed request starts one session only. A token is returned
  // once; only its hash is kept.
  startSession(body: Record<string, unknown>): { token: string; device: Device; expires_at: string } {
    const refused = () => new CoreError('unauthorized', 'This device can’t start a session. If it was revoked, it needs to be added again with a new key.');
    const id = body.device_id;
    const time = body.time;
    const signature = body.signature;
    if (typeof id !== 'string' || typeof time !== 'number' || typeof signature !== 'string') throw new CoreError('validation', 'Send device_id, time (Unix seconds) and signature.');
    const nowMs = this.#now().getTime();
    const nowS = Math.floor(nowMs / 1000);
    if (!freshTime(time, nowS)) throw new CoreError('unauthorized', 'The signed time is too far from the hub’s clock. Check the device’s clock.');
    const d = this.find(id);
    if (!d || d.trust !== 'trusted' || d.role === 'hub' || !verifyDeviceSignature(d.public_key, sessionMessage(id, time), signature)) throw refused();
    const token = `nvs_${randomBytes(32).toString('base64url')}`;
    const at = new Date(nowMs).toISOString();
    const expires = new Date(nowMs + SESSION_TTL_MS).toISOString();
    this.#db.tx(() => {
      // Spent in the database, not in memory, so a restart doesn't make a request fresh again.
      this.#db.run('DELETE FROM session_signature WHERE until < ?', at);
      if (this.#db.get('SELECT 1 FROM session_signature WHERE device_id = ? AND time = ?', id, time)) throw new CoreError('unauthorized', 'That signed request was already used. Sign a new one.');
      this.#db.run('INSERT INTO session_signature (device_id, time, until) VALUES (?, ?, ?)', id, time, new Date(nowMs + 2 * 60_000 + 1000).toISOString());
      this.#db.run('DELETE FROM device_session WHERE expires_at <= ?', at);
      this.#db.run('INSERT INTO device_session (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash(token), id, at, expires);
      this.#db.run('UPDATE device SET last_seen = ? WHERE id = ?', at, id);
    });
    this.#touched.set(id, nowMs);
    return { token, device: this.get(id), expires_at: expires };
  }

  // The trusted device a token belongs to, or null (unknown, expired, or revoked).
  sessionDevice(token: string): Device | null {
    if (!/^nvs_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const r = this.#db.get<Row>(
      `SELECT d.* FROM device_session s JOIN device d ON d.id = s.device_id WHERE s.token_hash = ? AND s.expires_at > ? AND d.trust = 'trusted'`,
      tokenHash(token), this.#now().toISOString(),
    );
    return r ? fromRow(r) : null;
  }

  // ---- the roster -----------------------------------------------------------------------------

  // Who the hub and the standby are, signed by this node's identity key.
  roster(): SignedRoster {
    const s = this.state();
    const member = (id: string | null, url: string | null): RosterMember | null => {
      const d = id ? this.find(id) : null;
      return d && d.trust === 'trusted' ? { id: d.id, url, public_key: d.public_key, x25519_public_key: d.x25519_public_key } : null;
    };
    const hub = member(s.hub_id, this.#publicUrl());
    if (!hub) throw new CoreError('conflict', 'This node doesn’t know which node is hub.');
    const standbyId = s.standby_id;
    const standby = member(standbyId, standbyId ? this.find(standbyId)?.address ?? null : null);
    const roster: Roster = { epoch: s.epoch, hub, ...(standby ? { standby } : {}), issued_at: this.#now().toISOString() };
    return signRoster(roster, this.identity.signer());
  }

  counts(): { trusted: number; revoked: number } {
    const rows = this.#db.all<{ trust: Trust; n: number }>(`SELECT trust, COUNT(*) AS n FROM device WHERE role != 'hub' GROUP BY trust`);
    return { trusted: rows.find((r) => r.trust === 'trusted')?.n ?? 0, revoked: rows.find((r) => r.trust === 'revoked')?.n ?? 0 };
  }
}
