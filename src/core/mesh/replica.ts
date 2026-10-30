// The standby (M4 plan §3): a Nova with a home of its own that copies the hub, so it can take over.
// It learns that it is a standby from <home>/mesh/role.json, written when it enrolled
// (`boot.ts join … --kind standby --nova-home <dir>`). While it is a standby it runs nothing of
// its own: no scheduler, triggers, workers or chat. It pulls the hub's sync log, sealed to its own
// key, applies each batch in one transaction, and tells the hub how far it got.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { Log } from '../log.ts';
import type { MeshIdentity } from './identity.ts';
import { sessionMessage, type SignedRoster } from './wire.ts';
import type { LogRow, SyncLog } from './sync.ts';

// ---- role.json ---------------------------------------------------------------------------------

// What this node knows about its enrollment as a standby. Written by the boot agent when it
// enrolls a standby (M4b), or by hand in tests; rewritten here on promotion. The reader takes the
// fields below and ignores anything else, so the writer can add to it.
//
//   {
//     "version": 1,
//     "role": "standby",                       // "hub" once promoted
//     "device_id": "<this node's id in the hub's registry>",
//     "hub": { "id", "url", "public_key", "x25519_public_key", "name"?, "fingerprint"? },
//     "epoch": 1,                              // the roster's epoch when it enrolled
//     "roster": { "roster": {…}, "signature": "…" }   // optional: the signed roster it was given
//   }
//
// Also accepted: `hub_url` at the top level, `id` for `device_id`, and the hub's keys, url and the
// epoch taken from `roster` when `hub` doesn't carry them. The standby must have enrolled with the
// keys in <home>/mesh/identity.json (loadIdentity makes them), since it signs sessions and, once
// promoted, rosters with them.
export interface RoleFile {
  version: 1;
  role: 'standby' | 'hub';
  device_id: string;
  hub: { id: string; url: string; public_key: string; x25519_public_key: string; name?: string; fingerprint?: string };
  epoch: number;
  roster?: SignedRoster;
  promoted_at?: string;
}

export const ROLE_FILE = join('mesh', 'role.json');

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The role file in <home>/mesh/role.json, or null when there isn't one. A file that says standby
// but can't say who the hub is stops Nova from starting: running as a hub instead would be worse.
export function readRole(home: string): RoleFile | null {
  const file = join(home, ROLE_FILE);
  if (!existsSync(file)) return null;
  let raw: Record<string, any>;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} isn’t valid JSON. Enroll this standby again, or remove the file to run as a hub of its own.`); }
  const roster = (raw.roster && typeof raw.roster === 'object' ? raw.roster : null) as SignedRoster | null;
  const rh = (roster?.roster?.hub ?? {}) as Record<string, unknown>;
  const hub = (raw.hub && typeof raw.hub === 'object' ? raw.hub : {}) as Record<string, unknown>;
  const role = String(raw.role ?? raw.kind ?? '').toLowerCase();
  const out = {
    version: 1 as const,
    role: role === 'hub' ? 'hub' as const : 'standby' as const,
    device_id: text(raw.device_id) ?? text(raw.deviceId) ?? text(raw.id),
    hub: {
      id: text(hub.id) ?? text(rh.id),
      url: (text(hub.url) ?? text(raw.hub_url) ?? text(raw.hubUrl) ?? text(rh.url))?.replace(/\/+$/, '') ?? null,
      public_key: text(hub.public_key) ?? text(rh.public_key),
      x25519_public_key: text(hub.x25519_public_key) ?? text(rh.x25519_public_key),
      ...(text(hub.name) ? { name: text(hub.name)! } : {}),
      ...(text(hub.fingerprint) ? { fingerprint: text(hub.fingerprint)! } : {}),
    },
    epoch: Number.isInteger(raw.epoch) ? raw.epoch as number : Number.isInteger(roster?.roster?.epoch) ? roster!.roster.epoch : 1,
    ...(roster ? { roster } : {}),
    ...(text(raw.promoted_at) ? { promoted_at: text(raw.promoted_at)! } : {}),
  };
  if (role !== 'standby' && role !== 'hub') throw new Error(`${file} doesn’t say what this node is (role "standby" or "hub").`);
  const missing = [!out.device_id && 'device_id', !out.hub.id && 'hub.id', !out.hub.url && 'hub.url', !out.hub.public_key && 'hub.public_key', !out.hub.x25519_public_key && 'hub.x25519_public_key'].filter(Boolean);
  if (missing.length) throw new Error(`${file} says this is a standby but is missing ${missing.join(', ')}. Enroll it again.`);
  return out as RoleFile;
}

export function writeRole(home: string, role: RoleFile): void {
  const file = join(home, ROLE_FILE);
  mkdirSync(join(home, 'mesh'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(role, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ---- talking to another node -------------------------------------------------------------------

export interface Answer { status: number; body: any }

// One HTTP(S) request to another node. TLS trust is the system's, plus NOVA_CA_FILE when set (a
// private CA, or the hub's own self-signed certificate).
export function ask(url: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Answer> {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const body = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body));
    const ca = u.protocol === 'https:' && process.env.NOVA_CA_FILE ? readFileSync(process.env.NOVA_CA_FILE) : undefined;
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method: o.method ?? 'GET',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}), ...o.headers },
      timeout: o.timeoutMs ?? 10_000,
      ...(ca ? { ca } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const t = Buffer.concat(parts).toString('utf8');
        let parsed: unknown = t;
        try { parsed = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
        ok({ status: res.statusCode ?? 0, body: parsed });
      });
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`${u.host} didn’t answer in time.`)));
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

// ---- the puller ---------------------------------------------------------------------------------

export const SYNC_AAD = (standbyId: string, after: number) => Buffer.from(`nova-sync-v1|${standbyId}|${after}`, 'utf8');

export interface SyncPayload { v: 1; hub_id: string; standby_id: string; epoch: number; after: number; rows: LogRow[]; upto: number; more: boolean; head: number }

export interface ReplicaStatus {
  hub: { id: string; url: string; name: string | null };
  cursor: number;
  head: number | null;
  last_ok_at: string | null;
  last_error: string | null;
  unreachable_since: string | null;
  refused: string | null;
  running: boolean;
}

// Why the puller gave up on the hub without it being down: the hub refused this standby.
class Refused extends Error {}

export class Replica extends EventEmitter {
  #sync: SyncLog;
  #identity: MeshIdentity;
  #log: Log;
  #now: () => Date;
  #role: () => RoleFile;
  #hubName: () => string | null;
  #epoch: () => number;
  #seenEpoch: (epoch: number) => void;
  #forgotten: (records: Record<string, unknown>[]) => void;
  #failoverAfterS: () => number | null;
  #waitS: number;
  #token: string | null = null;
  #lastTime = 0;
  #running = false;
  #abort: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #lastOk: string | null = null;
  #lastError: string | null = null;
  #unreachableSince: number | null = null;
  #refused: string | null = null;
  #head: number | null = null;
  #reported = false;
  #wake: (() => void) | null = null;

  constructor(o: {
    sync: SyncLog; identity: MeshIdentity; log: Log; now: () => Date; role: () => RoleFile; hubName: () => string | null;
    epoch: () => number; seenEpoch: (epoch: number) => void; forgotten: (records: Record<string, unknown>[]) => void;
    failoverAfterS: () => number | null; waitS?: number;
  }) {
    super();
    this.#sync = o.sync;
    this.#identity = o.identity;
    this.#log = o.log;
    this.#now = o.now;
    this.#role = o.role;
    this.#hubName = o.hubName;
    this.#epoch = o.epoch;
    this.#seenEpoch = o.seenEpoch;
    this.#forgotten = o.forgotten;
    this.#failoverAfterS = o.failoverAfterS;
    this.#waitS = o.waitS ?? 20;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#abort?.abort();
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }

  status(): ReplicaStatus {
    const r = this.#role();
    const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      hub: { id: r.hub.id, url: r.hub.url, name: this.#hubName() },
      cursor: this.#sync.cursor(), head: this.#head, last_ok_at: this.#lastOk, last_error: this.#lastError,
      unreachable_since: at(this.#unreachableSince), refused: this.#refused, running: this.#running,
    };
  }

  // One pull: a session if needed, the next batch, applied, acknowledged. Returns whether there
  // may be more waiting right away.
  async pullOnce(waitS = this.#waitS): Promise<boolean> {
    const role = this.#role();
    if (!this.#token) await this.#session(role);
    const after = this.#sync.cursor();
    const res = await this.#call(`${role.hub.url}/api/v1/mesh/sync?after=${after}&wait=${waitS}`, { timeoutMs: (waitS + 15) * 1000 });
    if (res.status === 401) { this.#token = null; return true; }
    if (res.status === 403 || res.status === 409) throw new Refused(String(res.body?.error ?? `The hub refused (${res.status}).`));
    if (res.status !== 200 || typeof res.body?.sealed !== 'string') throw new Error(`The hub answered ${res.status}.`);
    let payload: SyncPayload;
    try {
      payload = JSON.parse(this.#identity.open(role.hub.x25519_public_key, Buffer.from(res.body.sealed, 'base64url'), SYNC_AAD(role.device_id, after)).toString('utf8'));
    } catch {
      throw new Refused('A sync answer didn’t open with the hub’s key. Something between this standby and the hub may be tampering with it.');
    }
    if (payload.hub_id !== role.hub.id || payload.standby_id !== role.device_id || payload.after !== after) throw new Refused('A sync answer was meant for a different hub or standby.');
    if (payload.epoch < this.#epoch()) throw new Refused(`The node at ${role.hub.url} is at epoch ${payload.epoch}, older than this standby knows (${this.#epoch()}). It isn’t the hub any more.`);
    this.#seenEpoch(payload.epoch);
    const applied = this.#sync.apply(payload, this.#forgotten);
    this.#head = payload.head;
    this.#ok();
    const ack = await this.#call(`${role.hub.url}/api/v1/mesh/sync/ack`, { method: 'POST', body: { seq: this.#sync.cursor() } });
    if (ack.status === 401) this.#token = null;
    if (applied.applied) this.emit('applied', { applied: applied.applied, files: applied.files, cursor: this.#sync.cursor() });
    return payload.more;
  }

  async #run(): Promise<void> {
    let backoff = 500;
    while (this.#running) {
      try {
        await this.pullOnce();
        backoff = 500;
        this.#refused = null;
      } catch (e) {
        if (!this.#running) break;
        const msg = (e as Error).message;
        this.#lastError = msg;
        if (e instanceof Refused) {
          // Not down, so no failover: the person needs to look.
          if (this.#refused !== msg) this.#log.problem('sync', `The standby can’t copy the hub: ${msg}`);
          this.#refused = msg;
          this.#unreachableSince = null;
          await this.#sleep(5000);
          continue;
        }
        // Wall time, not Nova's clock: this is about how long the hub has really been gone.
        this.#unreachableSince ??= Date.now();
        const down = Math.round((Date.now() - this.#unreachableSince) / 1000);
        if (!this.#reported && down >= 60) {
          this.#reported = true;
          this.#log.problem('sync', `The standby hasn’t reached the hub at ${this.#role().hub.url} for a minute: ${msg}`);
        }
        const after = this.#failoverAfterS();
        if (after && down >= after) {
          this.#running = false;
          this.emit('failover', { down_s: down, error: msg });
          break;
        }
        await this.#sleep(backoff);
        backoff = Math.min(backoff * 2, 2000);
      }
    }
  }

  #ok(): void {
    this.#lastOk = this.#now().toISOString();
    this.#lastError = null;
    this.#unreachableSince = null;
    this.#reported = false;
  }

  async #session(role: RoleFile): Promise<void> {
    // Each signed request starts one session only, so the time must move on between them.
    const time = Math.max(Math.floor(this.#now().getTime() / 1000), this.#lastTime + 1);
    this.#lastTime = time;
    const res = await ask(`${role.hub.url}/api/v1/mesh/session`, {
      method: 'POST', headers: { 'x-nova': '1' },
      body: { device_id: role.device_id, time, signature: this.#identity.sign(sessionMessage(role.device_id, time)) },
      ...(this.#abort ? { signal: this.#abort.signal } : {}),
    });
    if (res.status === 401 || res.status === 403) throw new Refused(String(res.body?.error ?? 'The hub won’t start a session for this standby.'));
    if (res.status !== 200 || typeof res.body?.token !== 'string') throw new Error(`The hub answered ${res.status} to a new session.`);
    this.#token = res.body.token;
  }

  #call(url: string, o: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
    this.#abort = new AbortController();
    return ask(url, { ...o, headers: { authorization: `Bearer ${this.#token}`, ...(o.method && o.method !== 'GET' ? { 'x-nova': '1' } : {}) }, signal: this.#abort.signal });
  }

  // A pause that stop() cuts short.
  #sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => { this.#wake = null; r(); }, ms);
      this.#wake = () => { clearTimeout(t); this.#wake = null; r(); };
    });
  }
}
