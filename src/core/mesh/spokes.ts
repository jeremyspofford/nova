// The hub's side of a computer's device agent (M4 plan §2): heartbeats, the inbox its offline queue
// flushes into, the config a device may change, problems it reports, the signed runtime bundle,
// and the challenge a node answers so an agent knows it is talking to a key it pinned.
//
// The inbox takes every item exactly once, keyed by (device, idempotency key), in the same
// transaction as what the item does, so a crash between the two can't take an item in twice or
// lose it. The conflict rules (LOCAL-FIRST-AND-DEVICE-MESH §4):
//  - config is server-wins: a change made against an older version is rejected and reported;
//  - memory is merged with provenance (recorded_by device:<id>);
//  - a ledger entry is never lost: a task request becomes a task, or a refusal kept with its reason
//    and the request itself.
import { EventEmitter } from 'node:events';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Device, Devices } from './devices.ts';
import type { MeshIdentity } from './identity.ts';
import { helloProofMessage } from './wire.ts';
import { runtimeBundle, type RuntimeBundle } from './agent.ts';

// Its tables, device_inbox and device_heartbeat, are migration 0007's.

export const INBOX_KINDS = ['event', 'task_request', 'memory_note', 'config_change', 'capture_event'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxStatus = 'accepted' | 'refused' | 'rejected';
export interface InboxResult { key: string; kind: InboxKind | string; status: InboxStatus; duplicate: boolean; reason?: string; ref?: string; version?: string | null }

// The profile sections a device agent may change. Privacy, appearance and setup stay with the
// person's own screens: a computer that was paired for its capabilities shouldn't loosen privacy.
export const DEVICE_CONFIG_SECTIONS = ['identity', 'user', 'tuning', 'policy'] as const;

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{16,128}$/;
export const MAX_BATCH = 100;
const REPORT_EVERY_MS = 10 * 60_000;

export interface AgentState { version: string | null; runtime_version: string | null; safe_mode: boolean; at: string }

// What an item becomes is up to the core (index.ts): it owns the ledger, memory and profile.
export interface InboxEffects {
  task(device: Device, key: string, body: Record<string, unknown>): { id: string };
  memory(device: Device, body: Record<string, unknown>): { id: string };
  config: {
    read(section: string, key: string): { value: unknown; version: string } | null;
    write(section: string, key: string, value: unknown): string;
  };
  // A captured event (M6a): kept (ref, the event's id), not kept with the reason (consent off,
  // paused, private, excluded), or refused when it can't be read.
  capture?(device: Device, key: string, body: Record<string, unknown>): { ref?: string; reason?: string; refused?: boolean };
}

interface InboxRow { key: string; kind: string; status: InboxStatus; reason: string | null; ref: string | null }

export class Spokes extends EventEmitter {
  #db: Db;
  #log: Log;
  #devices: Devices;
  #identity: MeshIdentity;
  #now: () => Date;
  #version: string;
  #effects: InboxEffects;
  #bundle: RuntimeBundle | null = null;
  #reported = new Map<string, number>();
  #restart = new Set<string>();

  constructor(o: { db: Db; log: Log; devices: Devices; identity: MeshIdentity; now: () => Date; version: string; effects: InboxEffects }) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.#devices = o.devices;
    this.#identity = o.identity;
    this.#now = o.now;
    this.#version = o.version;
    this.#effects = o.effects;
  }

  // ---- heartbeat -------------------------------------------------------------------------------

  // A device agent says it is alive: last_seen now (not throttled, so Online is exact), its
  // capabilities, versions and whether it is in safe mode. Entering safe mode is a problem.
  heartbeat(device: Device, body: Record<string, unknown>): { ok: true; epoch: number; runtime: { version: string }; restart_runtime?: true } {
    const at = this.#now().toISOString();
    const caps = body.capabilities;
    if (caps !== undefined && (!Array.isArray(caps) || caps.length > 32 || !caps.every((c) => typeof c === 'string' && /^[a-z][a-z0-9._-]{0,39}$/.test(c)))) {
      throw new CoreError('validation', 'capabilities must be up to 32 short names.');
    }
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
    const safe = body.safe_mode === true;
    const before = this.agent(device.id);
    this.#db.tx(() => {
      this.#db.run(`UPDATE device SET last_seen = ?${caps ? ', capabilities = ?' : ''} WHERE id = ? AND trust = 'trusted'`, ...(caps ? [at, JSON.stringify(caps), device.id] : [at, device.id]));
      this.#db.run(
        `INSERT INTO device_heartbeat (device_id, version, runtime_version, safe_mode, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET version = excluded.version, runtime_version = excluded.runtime_version, safe_mode = excluded.safe_mode, at = excluded.at`,
        device.id, text(body.version), text(body.runtime_version), safe ? 1 : 0, at,
      );
    });
    if (safe && !before?.safe_mode) {
      this.#log.problem('mesh', `The device agent on “${device.name}” stopped its runtime after it crashed three times in a minute, and is in safe mode. It will try again when a new runtime arrives, or when you run its recover command.`);
    }
    if (!before || before.safe_mode !== safe || caps) this.emit('change', this.#devices.get(device.id));
    // What it can run models on (M6b): the model manager checks and keeps it.
    if (body.hardware !== undefined) this.emit('hardware', this.#devices.get(device.id), body.hardware);
    // A restart asked for by a repair playbook (M7b) goes out once, with this reply.
    const restart = safe && this.#restart.delete(device.id);
    return { ok: true, epoch: this.#devices.state().epoch, runtime: { version: this.runtime().manifest.version }, ...(restart ? { restart_runtime: true } : {}) };
  }

  // Asks a computer's boot agent, at its next heartbeat in safe mode, to start its runtime again
  // (it reinstalls it from this node and leaves safe mode; three more crashes put it back). True
  // when this is a new ask, false when one is already waiting to go out.
  restartRuntime(id: string): boolean {
    if (this.#restart.has(id)) return false;
    this.#restart.add(id);
    return true;
  }

  agent(id: string): AgentState | null {
    const r = this.#db.get<{ version: string | null; runtime_version: string | null; safe_mode: number; at: string }>('SELECT version, runtime_version, safe_mode, at FROM device_heartbeat WHERE device_id = ?', id);
    return r ? { version: r.version, runtime_version: r.runtime_version, safe_mode: r.safe_mode === 1, at: r.at } : null;
  }

  // ---- what a device reports ---------------------------------------------------------------------

  // Something the person should know about (a runtime update the agent refused, for one). The same
  // report from the same device is a problem once every ten minutes.
  report(device: Device, body: Record<string, unknown>): { ok: true } {
    const what = typeof body.problem === 'string' ? body.problem : '';
    const detail = typeof body.detail === 'string' ? body.detail.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
    const messages: Record<string, string> = {
      runtime_update_refused: `The device agent on “${device.name}” refused a runtime update because it couldn’t verify it${detail ? `: ${detail}` : '.'} Its current runtime keeps running. If this keeps happening, something between it and Nova may be changing what it downloads.`,
      runtime_install_failed: `The device agent on “${device.name}” couldn’t install a runtime${detail ? `: ${detail}` : '.'}`,
    };
    const message = messages[what];
    if (!message) throw new CoreError('validation', `problem must be one of ${Object.keys(messages).join(', ')}.`);
    const k = `${device.id}|${what}`;
    const now = this.#now().getTime();
    if (now - (this.#reported.get(k) ?? -Infinity) >= REPORT_EVERY_MS) {
      this.#reported.set(k, now);
      this.#log.problem('mesh', message);
    }
    return { ok: true };
  }

  // ---- the inbox ----------------------------------------------------------------------------------

  // A batch from a device's queue, in the order the device made them. Each item is answered: taken
  // in now, refused or rejected now (with the reason), or a duplicate of one already answered (with
  // that answer again, so a device whose connection dropped before the reply learns it).
  inbox(device: Device, body: Record<string, unknown>): { results: InboxResult[] } {
    const items = body.items;
    if (!Array.isArray(items) || !items.length) throw new CoreError('validation', 'Send items: a list of {key, kind, body, created_at?}.');
    if (items.length > MAX_BATCH) throw new CoreError('validation', `Send at most ${MAX_BATCH} items at a time.`);
    const problems: string[] = [];
    items.forEach((it, i) => {
      const item = (typeof it === 'object' && it !== null ? it : {}) as Record<string, unknown>;
      if (typeof item.key !== 'string' || !KEY.test(item.key)) problems.push(`items[${i}].key must be 8–100 letters, digits or ._:-`);
      if (typeof item.body !== 'object' || item.body === null || Array.isArray(item.body)) problems.push(`items[${i}].body must be an object.`);
    });
    if (problems.length) throw new CoreError('validation', 'Those items can’t be taken in.', problems);
    return { results: (items as Record<string, unknown>[]).map((it) => this.#take(device, it)) };
  }

  #take(device: Device, it: Record<string, unknown>): InboxResult {
    const key = it.key as string;
    const kind = String(it.kind);
    const body = it.body as Record<string, unknown>;
    const createdAt = typeof it.created_at === 'string' && !Number.isNaN(Date.parse(it.created_at)) ? new Date(it.created_at).toISOString() : null;
    return this.#db.tx(() => {
      const seen = this.#db.get<InboxRow>('SELECT key, kind, status, reason, ref FROM device_inbox WHERE device_id = ? AND key = ?', device.id, key);
      if (seen) return { key, kind: seen.kind, status: seen.status, duplicate: true, ...(seen.reason ? { reason: seen.reason } : {}), ...(seen.ref ? { ref: seen.ref } : {}) };
      const at = this.#now().toISOString();
      const keep = (status: InboxStatus, o: { reason?: string; ref?: string; body?: unknown; version?: string | null } = {}): InboxResult => {
        this.#db.run(
          'INSERT INTO device_inbox (device_id, key, kind, status, reason, ref, body, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          device.id, key, INBOX_KINDS.includes(kind as InboxKind) ? kind : 'event', status, o.reason ?? null, o.ref ?? null, o.body === undefined ? null : JSON.stringify(o.body), createdAt, at,
        );
        return { key, kind, status, duplicate: false, ...(o.reason ? { reason: o.reason } : {}), ...(o.ref ? { ref: o.ref } : {}), ...(o.version !== undefined ? { version: o.version } : {}) };
      };
      const refusal = (e: unknown) => (e instanceof CoreError ? [e.message, ...e.details].join(' ') : 'Nova couldn’t take this in.');
      switch (kind) {
        case 'event': {
          const name = typeof body.name === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(body.name) ? body.name : null;
          if (!name) return keep('refused', { reason: 'An event needs a name: a short lowercase word.' });
          const r = keep('accepted', { ref: name, body: { name, data: body.data ?? null } });
          this.emit('event', { device_id: device.id, name, data: body.data ?? null, key, created_at: createdAt });
          return r;
        }
        case 'task_request': {
          // A refused request is kept whole, with why, so it is never lost. What the item does runs
          // in its own savepoint: if it fails part-way, none of it stays, so "refused" is true.
          try {
            return keep('accepted', { ref: this.#db.tx(() => this.#effects.task(device, key, body)).id });
          } catch (e) {
            const reason = refusal(e);
            this.#log.problem('mesh', `A task asked for by “${device.name}” wasn’t created: ${reason}`);
            return keep('refused', { reason, body });
          }
        }
        case 'memory_note': {
          // Only the new memory's id is kept here, never its words, so forgetting it is complete.
          try {
            return keep('accepted', { ref: this.#db.tx(() => this.#effects.memory(device, body)).id });
          } catch (e) {
            return keep('refused', { reason: refusal(e) });
          }
        }
        case 'capture_event': {
          // Only the event's id is kept here, never what it captured, so forgetting it is complete;
          // one that isn't kept (no consent, paused, private, excluded) is still taken in once.
          if (!this.#effects.capture) return keep('refused', { reason: 'This hub doesn’t take capture.' });
          try {
            const r = this.#db.tx(() => this.#effects.capture!(device, key, body));
            return r.refused ? keep('refused', { reason: r.reason ?? 'Nova couldn’t read this.' }) : keep('accepted', { ...(r.ref ? { ref: r.ref } : {}), ...(r.reason ? { reason: r.reason } : {}) });
          } catch (e) {
            return keep('refused', { reason: refusal(e) });
          }
        }
        case 'config_change': {
          const section = String(body.section ?? '');
          const ck = String(body.key ?? '');
          if (!(DEVICE_CONFIG_SECTIONS as readonly string[]).includes(section) || !/^[a-z][a-z0-9_.-]{0,63}$/.test(ck)) {
            return keep('refused', { reason: `A device can change ${DEVICE_CONFIG_SECTIONS.join(', ')} settings only, by section and key.` });
          }
          if (body.value === undefined) return keep('refused', { reason: 'A config change needs a value.' });
          const base = body.base_version === null || typeof body.base_version === 'string' ? body.base_version : undefined;
          if (base === undefined) return keep('refused', { reason: 'A config change needs base_version: the version it was made against, or null for a new setting.' });
          const current = this.#effects.config.read(section, ck);
          const ref = `${section}.${ck}`;
          // Server wins: the hub's copy changed since the device read it, so the device's change is
          // the stale one.
          if ((current?.version ?? null) !== base) {
            const reason = `${ref} changed on the hub after this device read it, so the hub’s value stands.`;
            this.#log.problem('mesh', `A settings change from “${device.name}” to ${ref} was older than the hub’s and wasn’t applied. The hub’s value stands; change it again if you still want to.`);
            return keep('rejected', { reason, ref, version: current?.version ?? null });
          }
          try {
            const version = this.#db.tx(() => this.#effects.config.write(section, ck, body.value));
            return keep('accepted', { ref, version });
          } catch (e) {
            return keep('refused', { reason: refusal(e), ref });
          }
        }
        default:
          return keep('refused', { reason: `kind must be one of ${INBOX_KINDS.join(', ')}.` });
      }
    });
  }

  // What a device sent that was refused or rejected, newest first, for the person.
  refusals(deviceId?: string): Array<InboxRow & { device_id: string; received_at: string; body: unknown }> {
    const rows = this.#db.all<InboxRow & { device_id: string; received_at: string; body: string | null }>(
      `SELECT device_id, key, kind, status, reason, ref, body, received_at FROM device_inbox WHERE status != 'accepted'${deviceId ? ' AND device_id = ?' : ''} ORDER BY received_at DESC LIMIT 200`,
      ...(deviceId ? [deviceId] : []),
    );
    return rows.map((r) => ({ ...r, body: r.body ? JSON.parse(r.body) : null }));
  }

  // ---- what this node proves ---------------------------------------------------------------------

  proof(challenge: unknown): { id: string; role: string; epoch: number; public_key: string; signature: string } {
    if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) throw new CoreError('validation', 'challenge must be 16–128 base64url characters.');
    const s = this.#devices.state();
    const claim = { id: this.#identity.id, role: s.role, epoch: s.epoch, public_key: this.#identity.publicKey };
    return { ...claim, signature: this.#identity.sign(helloProofMessage(challenge, claim)) };
  }

  // The runtime agent, signed by this node. Built once per process: the files don't change under a
  // running hub, and a promoted standby signs its own.
  runtime(): RuntimeBundle {
    // Signed again when the epoch changes (this node became hub), so it orders after any bundle
    // the hub before it signed.
    const epoch = this.#devices.state().epoch;
    if (this.#bundle?.manifest.epoch !== epoch) this.#bundle = runtimeBundle(this.#version, (m) => this.#identity.sign(m), this.#identity.publicKey, { epoch, issued_at: this.#now().toISOString() });
    return this.#bundle;
  }
}
