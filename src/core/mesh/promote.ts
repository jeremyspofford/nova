// Which node is hub (ADR-11: the hub is a role, not a box), and how that changes.
//  - A hub records every change (sync.ts), serves its log to the standby, watches the standby's
//    lag, and checks its roster peers: if one of them is hub at a higher epoch, this node was
//    replaced while it was away, so it steps down (fencing) instead of acting as a second hub.
//  - A standby copies the hub (replica.ts) and refuses every change, saying which node is hub.
//  - Promotion makes a standby the hub: the epoch goes up by one, it signs a new roster with its
//    own key (the one devices pinned as the standby's), starts the scheduler, triggers and workers,
//    recovers the ledger, and records the promotion as a verified ledger task.
import { EventEmitter } from 'node:events';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Route } from '../api.ts';
import { TERMINAL, type LanedWorker, type Ledger, type Task } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Brief } from '../envelope.ts';
import type { Access } from './access.ts';
import type { Device, Devices } from './devices.ts';
import type { MeshIdentity } from './identity.ts';
import { ask, readRole, Replica, SYNC_AAD, writeRole, type RoleFile, type SyncPayload } from './replica.ts';
import type { SyncLog } from './sync.ts';
import { verifyRoster, type SignedRoster } from './wire.ts';

export type NodeRole = 'hub' | 'standby';
export const FENCE_EVERY_MS = 30_000;
export const CONFIRMATION_SYSTEM = 'nova-mesh';
const LAG_EVERY_MS = 15_000;

// What this node is, decided before anything else writes: the mesh state once there is one, else
// the role file, else hub. A standby doesn't record its own writes in the sync log (it copies the
// hub's entries instead), so this runs right after the migrations.
export function nodeRole(db: Db, home: string): { role: NodeRole; file: RoleFile | null } {
  const file = readRole(home);
  const state = db.get<{ role: NodeRole }>('SELECT role FROM mesh_state WHERE id = 1');
  const role: NodeRole = state?.role ?? (file?.role === 'standby' ? 'standby' : 'hub');
  db.run('UPDATE sync_state SET logging = ? WHERE id = 1', role === 'hub' ? 1 : 0);
  return { role, file };
}

export interface MeshRoleOptions {
  db: Db; log: Log; home: string; now: () => Date; publicUrl: () => string | null;
  identity: MeshIdentity; devices: Devices; access: Access; sync: SyncLog; ledger: Ledger; verifier: Verifier;
  file: RoleFile | null;
  // Turns the hub's own work on or off: the heartbeat (triggers) and, through events, Era 2's scheduler.
  becameHub: () => { requeued: string[]; reverified: string[] };
  becameStandby: () => void;
  forgotten: (records: Record<string, unknown>[]) => void;
  failoverAfterS: () => number | null;
}

export class MeshRole extends EventEmitter {
  #o: MeshRoleOptions;
  #file: RoleFile | null;
  #replica: Replica | null = null;
  #fence: ReturnType<typeof setInterval> | null = null;
  #lag: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #started = false;
  #promoting: Promise<unknown> | null = null;

  constructor(o: MeshRoleOptions) {
    super();
    this.#o = o;
    this.#file = o.file;
    // A standby that has never started knows its place from its role file.
    if (!o.db.get('SELECT 1 FROM mesh_state WHERE id = 1') && o.file?.role === 'standby') {
      o.db.run(`INSERT INTO mesh_state (id, epoch, role, hub_id, standby_id, updated_at) VALUES (1, ?, 'standby', ?, ?, ?)`, o.file.epoch, o.file.hub.id, o.file.device_id, o.now().toISOString());
    }
    o.ledger.workers.set(this.worker.id, this.worker);
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    // A newly approved standby starts from nothing, whatever an earlier one acknowledged.
    o.devices.on('change', (c: { action: string; device: Device }) => {
      if (c.action === 'approved' && c.device.kind === 'standby') o.sync.resetAck();
    });
  }

  role(): NodeRole {
    return this.#o.devices.state().role;
  }

  // Why this node refuses changes, or null when it is the hub.
  replica(): { reason: string; hub: { id: string | null; name: string | null; url: string | null }; demoted: boolean } | null {
    const s = this.#o.devices.state();
    if (s.role === 'hub') return null;
    const hub = s.hub_id ? this.#o.devices.find(s.hub_id) : null;
    const name = hub?.name ?? this.#file?.hub.name ?? null;
    const url = (this.#file && this.#file.hub.id === s.hub_id ? this.#file.hub.url : null) ?? hub?.address ?? null;
    const label = `${name ? `“${name}”` : 'another node'}${url ? ` at ${url}` : ''}`;
    // The role file is the enrollment; a hub that stepped down has none of its own.
    const demoted = !this.#file || this.#file.device_id !== this.#o.identity.id;
    const reason = demoted
      ? `This node isn’t the hub any more: ${label} became the hub (epoch ${s.epoch}) while it was away, so this one only reads. ${label} is the hub.`
      : `This is the standby; ${label} is the hub.`;
    return { reason, hub: { id: s.hub_id, name, url }, demoted };
  }

  status() {
    const s = this.#o.devices.state();
    if (s.role === 'hub') {
      const standby = s.standby_id ? this.#o.devices.find(s.standby_id) : null;
      return { role: s.role, epoch: s.epoch, standby: standby && standby.trust === 'trusted' ? { id: standby.id, name: standby.name, address: standby.address, lag: this.lag() } : null, replica: null };
    }
    return { role: s.role, epoch: s.epoch, standby: null, replica: { ...this.replica()!, sync: this.#replica?.status() ?? null } };
  }

  // The standby's lag, measured from when it was approved at the earliest.
  lag() {
    const s = this.#o.devices.state();
    const standby = s.standby_id ? this.#o.devices.find(s.standby_id) : null;
    const lag = this.#o.sync.lag();
    const since = standby?.approved_at ? Math.round((this.#o.now().getTime() - Date.parse(standby.approved_at)) / 1000) : lag.seconds;
    const seconds = Math.min(lag.seconds, Math.max(0, since));
    return { ...lag, seconds, behind: lag.rows > 0 && seconds > 60 };
  }

  // ---- running ----------------------------------------------------------------------------------

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    if (this.role() === 'hub') this.#startHub();
    else this.#startStandby();
  }

  #startHub(): void {
    this.#o.sync.setLogging(true);
    this.#o.sync.startJournal();
    this.#fence ??= setInterval(() => { void this.fence().catch(() => {}); }, FENCE_EVERY_MS);
    this.#fence.unref();
    this.#lag ??= setInterval(() => this.#watchLag(), LAG_EVERY_MS);
    this.#lag.unref();
  }

  #stopHub(): void {
    this.#o.sync.stopJournal();
    if (this.#fence) clearInterval(this.#fence);
    if (this.#lag) clearInterval(this.#lag);
    this.#fence = this.#lag = null;
  }

  #startStandby(): void {
    this.#o.sync.setLogging(false);
    const file = this.#file;
    // A hub that stepped down has no hub of its own to copy until it is enrolled again.
    if (!file || file.role !== 'standby' || file.device_id !== this.#o.identity.id) return;
    this.#replica = new Replica({
      sync: this.#o.sync, identity: this.#o.identity, log: this.#o.log, now: this.#o.now, role: () => this.#file!,
      hubName: () => this.replica()?.hub.name ?? null,
      epoch: () => this.#o.devices.state().epoch,
      seenEpoch: (epoch) => this.#o.db.run('UPDATE mesh_state SET epoch = ?, updated_at = ? WHERE id = 1 AND epoch < ?', epoch, this.#o.now().toISOString(), epoch),
      forgotten: this.#o.forgotten, failoverAfterS: this.#o.failoverAfterS,
      ...(process.env.NOVA_SYNC_WAIT_S ? { waitS: Number(process.env.NOVA_SYNC_WAIT_S) } : {}),
    });
    this.#replica.on('applied', (a) => this.emit('applied', a));
    this.#replica.on('failover', (f: { down_s: number; error: string }) => {
      this.#o.log.problem('mesh', `The hub was unreachable for ${f.down_s} s, so this standby is making itself the hub, as you set it to (mesh.auto_failover_after_s).`, { detail: f.error });
      void this.promote({ confirm: true, by: 'nova', auto: true }).catch((e) => this.#o.log.problem('mesh', 'The standby couldn’t make itself the hub.', { detail: (e as Error)?.stack ?? String(e) }));
    });
    this.#replica.start();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopHub();
    await this.#replica?.stop();
  }

  // ---- the hub: serving the standby ---------------------------------------------------------------

  #watchLag(): void {
    try {
      if (this.role() !== 'hub' || !this.#o.devices.state().standby_id) return;
      const lag = this.lag();
      const was = this.#o.db.get<{ behind_since: string | null }>('SELECT behind_since FROM sync_state WHERE id = 1')!.behind_since;
      if (lag.behind && !was) {
        this.#o.db.run('UPDATE sync_state SET behind_since = ? WHERE id = 1', this.#o.now().toISOString());
        const standby = this.#o.devices.find(this.#o.devices.state().standby_id!);
        this.#o.log.problem('sync', `The standby${standby ? ` “${standby.name}”` : ''} has fallen behind: ${lag.rows} ${lag.rows === 1 ? 'change' : 'changes'} not copied yet, the oldest ${lag.seconds} s old. If the hub failed now, those would be missing.`);
      } else if (!lag.behind && was) this.#o.db.run('UPDATE sync_state SET behind_since = NULL WHERE id = 1');
    } catch { /* closing */ }
  }

  async #serve(device: Device, afterRaw: string | null, waitRaw: string | null): Promise<unknown> {
    const s = this.#o.devices.state();
    if (s.role !== 'hub') throw new CoreError('conflict', this.replica()!.reason);
    if (device.id !== s.standby_id) throw new CoreError('forbidden', 'This device isn’t the standby.');
    const after = Number(afterRaw ?? 0);
    const wait = Math.min(Math.max(Number(waitRaw ?? 0), 0), 25);
    if (!Number.isInteger(after) || after < 0 || !Number.isFinite(wait)) throw new CoreError('validation', 'after must be a whole number of 0 or more; wait, seconds up to 25.');
    // A long poll: answer as soon as there is something new, or after `wait` seconds with nothing.
    const until = Date.now() + wait * 1000;
    while (!this.#closed && Date.now() < until && this.#o.sync.head() <= after) await new Promise((r) => setTimeout(r, 150));
    if (this.#closed) throw new CoreError('conflict', 'Nova is stopping.');
    const payload: SyncPayload = { v: 1, hub_id: this.#o.identity.id, standby_id: device.id, epoch: this.#o.devices.state().epoch, after, ...this.#o.sync.batch(after) };
    const sealed = this.#o.identity.seal(device.x25519_public_key, Buffer.from(JSON.stringify(payload), 'utf8'), SYNC_AAD(device.id, after));
    return { hub_id: payload.hub_id, epoch: payload.epoch, sealed: sealed.toString('base64url') };
  }

  // ---- fencing --------------------------------------------------------------------------------------

  // Asks every roster peer who is hub. If one is hub at a higher epoch, with a roster signed by the
  // key this node has for it, this node was replaced and steps down. Peers that don't answer are
  // left alone: an unreachable peer is not proof of anything.
  async fence(): Promise<{ demoted: boolean; checked: string[] }> {
    const checked: string[] = [];
    if (this.role() !== 'hub' || this.#closed) return { demoted: false, checked };
    const me = this.#o.identity.id;
    const peers = new Map<string, string>();
    for (const d of this.#o.devices.list()) if (d.id !== me && d.trust === 'trusted' && d.address) peers.set(d.address.replace(/\/+$/, ''), d.id);
    if (this.#file && this.#file.hub.id !== me) peers.set(this.#file.hub.url, this.#file.hub.id);
    const answers = await Promise.all([...peers.keys()].map(async (url) => {
      checked.push(url);
      try { return { url, res: await ask(`${url}/api/v1/mesh/hello`, { timeoutMs: 3000 }) }; } catch { return null; }
    }));
    for (const a of answers) {
      if (!a || a.res.status !== 200 || this.role() !== 'hub') continue;
      const h = a.res.body as { id?: string; role?: string; epoch?: number; name?: string; roster?: SignedRoster };
      const mine = this.#o.devices.state().epoch;
      if (h?.role !== 'hub' || !Number.isInteger(h.epoch) || h.epoch! <= mine || typeof h.id !== 'string') continue;
      const peer = this.#o.devices.find(h.id);
      const r = h.roster?.roster;
      // Only a node this hub already trusted, proving it with its own key, can take the role.
      if (!peer || peer.trust !== 'trusted' || !r || r.epoch !== h.epoch || r.hub.id !== peer.id || r.hub.public_key !== peer.public_key || !verifyRoster(h.roster!, [peer.public_key])) {
        this.#o.log.problem('mesh', `${a.url} says it is the hub at epoch ${h.epoch}, but couldn’t prove it with a key this hub trusts, so this hub carries on.`);
        continue;
      }
      this.demote(peer, h.epoch!, a.url);
      return { demoted: true, checked };
    }
    return { demoted: false, checked };
  }

  // Steps down: stops recording and running, refuses changes, ends every device session.
  demote(hub: Device, epoch: number, url: string): void {
    const at = this.#o.now().toISOString();
    this.#o.db.tx(() => {
      this.#o.sync.setLogging(false);
      this.#o.db.run(`UPDATE mesh_state SET role = 'standby', epoch = ?, hub_id = ?, standby_id = ?, updated_at = ? WHERE id = 1`, epoch, hub.id, this.#o.identity.id, at);
      this.#o.db.run('DELETE FROM device_session');
    });
    this.#stopHub();
    this.#o.becameStandby();
    for (const d of this.#o.devices.list()) this.#o.access.close(d.id);
    const why = `“${hub.name}” at ${url} became the hub (epoch ${epoch}) while this node was away. This node stepped down so there is only one hub: it reads, but refuses changes, and every device session here has ended.`;
    this.#o.log.problem('mesh', why);
    this.emit('demoted', { hub: hub.id, epoch, reason: why });
    this.emit('change', this.status());
  }

  // ---- promotion ------------------------------------------------------------------------------------

  async promote(o: { confirm: boolean; by: string; auto?: boolean }): Promise<{ epoch: number; roster: SignedRoster; task: Task; recovered: { requeued: string[]; reverified: string[] } }> {
    if (!o.confirm) throw new CoreError('validation', 'Making this node the hub needs an explicit confirmation: send confirm: true.');
    if (this.#promoting) throw new CoreError('conflict', 'This node is already becoming the hub.');
    const s = this.#o.devices.state();
    if (s.role === 'hub') throw new CoreError('conflict', 'This node is already the hub.');
    // A hub that stepped down has stopped copying anything: it would bring back old data.
    if (this.replica()?.demoted) throw new CoreError('conflict', `${this.replica()!.reason} It has no copy of the hub’s latest data, so it can’t take over. Enroll it again as the standby first.`);
    const me = this.#o.identity.id;
    const self = this.#o.devices.find(me);
    // It signs the new roster with its identity key; devices accept that only if it is the key they
    // pinned for the standby, the one in the registry.
    if (!self || self.trust !== 'trusted' || self.public_key !== this.#o.identity.publicKey) {
      throw new CoreError('conflict', self ? 'This standby’s key isn’t the one the hub approved, so devices wouldn’t accept it as hub. Enroll it again.' : 'This standby hasn’t copied the hub’s device registry yet, so devices wouldn’t know it. Wait until it has synced.');
    }
    const work = (async () => {
      await this.#replica?.stop();
      this.#replica = null;
      const epoch = s.epoch + 1;
      const at = this.#o.now().toISOString();
      const previous = s.hub_id;
      this.#o.db.tx(() => {
        this.#o.sync.setLogging(true);
        this.#o.db.run(`UPDATE mesh_state SET epoch = ?, role = 'hub', hub_id = ?, standby_id = NULL, updated_at = ? WHERE id = 1`, epoch, me, at);
        this.#o.db.run(`UPDATE device SET role = 'hub' WHERE id = ?`, me);
        // The old hub is still the person's computer, trusted as before, but not hub or standby.
        if (previous && previous !== me) this.#o.db.run(`UPDATE device SET role = 'spoke' WHERE id = ? AND role = 'hub'`, previous);
      });
      if (this.#file) {
        this.#file = { ...this.#file, role: 'hub', epoch, promoted_at: at };
        writeRole(this.#o.home, this.#file);
      }
      const roster = this.#o.devices.roster();
      this.#o.sync.resetAck();
      this.#startHub();
      const recovered = this.#o.becameHub();
      const how = o.auto ? 'automatically, after the hub was unreachable' : 'by you, on its own screen';
      this.#o.log.info('mesh', 'Standby promoted to hub.', { epoch, previous, by: o.by, auto: !!o.auto });
      const task = this.#o.ledger.create({
        title: 'Standby promoted to hub', owner: this.worker.id, origin: o.auto ? { kind: 'trigger', ref: 'mesh:auto-failover' } : { kind: 'user', ref: 'mesh:promote' },
        goal: `Make this node the hub at epoch ${epoch} (promoted ${how}), with a roster signed by its own key.`,
        evidence_required: [{ kind: 'confirmation', note: 'This node is hub at the new epoch, and the roster is signed by its key.' }],
        privacy_mode: 'local-only', approval_tier: 0, idempotency_key: `mesh:promote:${me}:${epoch}`, user_visibility: 'attention',
        inputs: { epoch, roster, previous_hub: previous, by: o.by, auto: !!o.auto, requeued: recovered.requeued.length },
      });
      this.emit('promoted', { epoch, roster, task: task.id, auto: !!o.auto });
      this.emit('change', this.status());
      // The record runs in its own lane, so recovered work doesn't hold it up; give it a moment.
      for (let i = 0; i < 100 && !TERMINAL.includes(this.#o.ledger.get(task.id).state); i++) await new Promise((r) => setTimeout(r, 20));
      return { epoch, roster, task: this.#o.ledger.get(task.id), recovered };
    })();
    this.#promoting = work;
    try { return await work; } finally { this.#promoting = null; }
  }

  // The worker that carries the promotion's ledger task: it reports what is now true, and the
  // verifier checks that for itself (#confirm).
  readonly worker: LanedWorker = {
    id: 'mesh', name: 'Device mesh', about: 'Records changes of hub: who is hub, at which epoch, under which roster.', egress: 'none', evidence: ['confirmation'],
    health: () => ({ ok: true }),
    lane: () => ({ key: 'mesh', max: 1 }),
    run: async (brief: Brief) => {
      const epoch = Number(brief.inputs?.epoch);
      const s = this.#o.devices.state();
      return {
        envelope: '1', task_id: brief.task_id, status: s.role === 'hub' && s.epoch === epoch ? 'done' : 'failed',
        summary: s.role === 'hub' && s.epoch === epoch ? `This node is the hub now, at epoch ${epoch}, with a roster signed by its own key.` : `This node isn’t hub at epoch ${epoch}.`,
        evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `epoch-${epoch}` }],
        artifacts: [], blockers: [], usage: { duration_ms: 0 }, follow_up_suggestions: [],
      };
    },
  };

  #confirm(e: { kind: string; system?: string; id?: string }, brief: Brief): { ok: boolean; why: string } {
    const epoch = Number(brief.inputs?.epoch);
    const signed = brief.inputs?.roster as SignedRoster | undefined;
    const s = this.#o.devices.state();
    if (e.id !== `epoch-${epoch}`) return { ok: false, why: `The confirmation names ${e.id}, not epoch ${epoch}.` };
    if (s.role !== 'hub' || s.hub_id !== this.#o.identity.id || s.epoch < epoch) return { ok: false, why: `Nova looked at its own mesh state: it is ${s.role} at epoch ${s.epoch}.` };
    if (!signed || signed.roster?.epoch !== epoch || signed.roster.hub.id !== this.#o.identity.id || !verifyRoster(signed, [this.#o.identity.publicKey])) {
      return { ok: false, why: 'The roster isn’t signed by this node’s key for that epoch.' };
    }
    return { ok: true, why: `Nova read its own mesh state: hub at epoch ${s.epoch}. The roster for epoch ${epoch} names this node as hub and is signed by its key (${this.#o.identity.fingerprint.slice(0, 9)}…).` };
  }

  // ---- routes ---------------------------------------------------------------------------------------

  routes(): Route[] {
    return [
      {
        method: 'GET', path: '/mesh/sync', access: 'sync',
        summary: 'The standby pulls the hub’s sync log after ?after=<seq>: a long poll (?wait= seconds, up to 25), sealed to the standby’s X25519 key.',
        handle: ({ query, who }) => {
          if (who.principal.kind !== 'device') throw new CoreError('forbidden', 'Only the standby pulls the sync log.');
          return this.#serve(who.principal.device, query.get('after'), query.get('wait'));
        },
      },
      {
        method: 'POST', path: '/mesh/sync/ack', access: 'sync', summary: 'The standby says how far it has applied the log; the hub shows its lag on Health.', body: '{seq}',
        handle: ({ body, who }) => {
          const s = this.#o.devices.state();
          if (who.principal.kind !== 'device' || who.principal.device.id !== s.standby_id) throw new CoreError('forbidden', 'Only the standby acknowledges the sync log.');
          if (s.role !== 'hub') throw new CoreError('conflict', this.replica()!.reason);
          this.#o.sync.ack(Number(body.seq));
          this.#watchLag();
          return this.lag();
        },
      },
      {
        method: 'POST', path: '/mesh/promote', access: 'approver', body: '{confirm}',
        summary: 'Make this standby the hub (tier 3: needs {confirm: true}). The epoch goes up, it signs a new roster, and it starts running work.',
        handle: async ({ body, who }) => {
          const r = await this.promote({ confirm: body.confirm === true, by: who.principal.kind === 'device' ? `device:${who.principal.device.id}` : who.principal.kind });
          return { epoch: r.epoch, roster: r.roster, task: r.task, recovered: r.recovered };
        },
      },
    ];
  }
}

export { readRole, writeRole };
