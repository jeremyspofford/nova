// The capture data path, the hub's side (M10h; docs/builder-packet/nova-capture-data-path-design-2026-
// 10-31.md, adopted by the orchestration ADR's "Resolved: the capture data path"). A spoke's device
// agent (src/device/carrier.ts) sends derived capture here; raw stays on the spoke.
//   plan        what this device may capture (the kinds that are on, each from its consent), whether
//               sync to this hub is allowed (local-only mode with a cloud hub: not), what waits for it
//   batch       a batch with a manifest signed by the device's key: verified against the enrolled
//               device record and the session before anything is stored; each item taken in once,
//               through Capture.ingest (consent, exclusions, Nova's own rules, screening), with its
//               provenance; every item answered, so the device drops exactly what was answered
//   status      what waits on a device that can't send (its queue, why it is paused)
//   tombstones  a forget of something a device holds goes to it; its signed acknowledgement is what
//               lets the forget say "deleted everywhere"
//   raw         one raw item the person asked for, with a reason: a Work Ledger task, the item sent
//               signed and checksummed, checked by Nova itself
// A refused manifest (an unknown or revoked device, another device's, a bad signature or checksum)
// stores nothing and is logged.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Route } from '../api.ts';
import type { Ledger, Task } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Brief, PrivacyMode } from '../envelope.ts';
import type { Worker } from '../workers.ts';
import type { Device, Devices } from '../mesh/devices.ts';
import {
  canonicalJson, captureBatchMessage, captureItemDigest, rawManifestMessage, sha256Hex, tombstoneAckMessage, verifyDeviceSignature,
  type CaptureBatchManifest, type RawManifest,
} from '../mesh/wire.ts';
import type { Capture } from './capture.ts';
import { KINDS, type Kind } from './rules.ts';

export const RAW_CONFIRMATION = 'nova-capture-raw';
export const MAX_BATCH_ITEMS = 200;
const MAX_RAW_BYTES = 700 * 1024;
const REFUSAL_EVERY_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface CaptureSyncOptions {
  db: Db;
  log: Log;
  home: string;
  now: () => Date;
  capture: Capture;
  devices: Devices;
  ledger: Ledger;
  verifier: Verifier;
  hubId: () => string;
  // Where this hub runs: on one of the person's own machines, or a cloud site (NOVA_MESH_SITE).
  site: () => 'home' | 'cloud';
  privacy: () => PrivacyMode;
  timezone: () => string;
  // How long a raw fetch waits for the device before it says the device didn't send it.
  rawWaitMs?: number;
}

interface TombRow { id: string; device_id: string; items: string; events: string; issued_at: string; acked_at: string | null; removed: string | null }
interface RawRow { id: string; task_id: string | null; device_id: string; event_id: string; item: string; reason: string; state: 'asked' | 'arrived' | 'failed'; sha256: string | null; size: number | null; signature: string | null; asked_at: string; done_at: string | null }
interface SyncRow { device_id: string; acked_seq: number; synced_to: string | null; queued: number; paused: string | null; at: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = <T>(s: string | null, f: T): T => { if (!s) return f; try { return JSON.parse(s) as T; } catch { return f; } };

export class CaptureSync {
  #o: CaptureSyncOptions;
  #refused = new Map<string, number>();
  #arrived = new Map<string, () => void>();

  readonly worker: Worker;

  constructor(o: CaptureSyncOptions) {
    this.#o = o;
    this.worker = this.#makeWorker();
    o.ledger.workers.set(this.worker.id, this.worker);
    o.verifier.registerConfirmation(RAW_CONFIRMATION, (e, brief) => this.#confirm(e, brief));
  }

  // ---- the device's plan ---------------------------------------------------------------------------

  // Sync to a cloud hub sends content off the person's machines: in local-only mode it is refused,
  // and waits on the device (the mode wins, as everywhere in Nova).
  syncAllowed(): { allowed: boolean; why: string | null } {
    if (this.#o.site() === 'cloud' && this.#o.privacy() === 'local-only') return { allowed: false, why: 'Nova is in local-only mode and its hub runs in the cloud, so captured words stay on this device, queued, until the hub is one of your own machines again or you change the mode.' };
    return { allowed: true, why: null };
  }

  plan(device: Device): { kinds: Record<string, string>; sync: { allowed: boolean; why: string | null }; tombstones: number; raw: number; raw_allowed: boolean } {
    return {
      kinds: this.#o.capture.deviceKinds(device.id), sync: this.syncAllowed(),
      tombstones: this.#o.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM capture_device_tombstone WHERE device_id = ? AND acked_at IS NULL', device.id)!.n,
      raw: this.#rawAllowed(device) ? this.#o.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM capture_raw_fetch WHERE device_id = ? AND state = 'asked'`, device.id)!.n : 0,
      raw_allowed: this.#rawAllowed(device),
    };
  }

  // ---- a batch -----------------------------------------------------------------------------------

  batch(session: Device, body: Record<string, unknown>): { batch_id: string; acked_to: number; results: { id: string; status: 'kept' | 'duplicate' | 'not_kept'; reason: string | null }[] } {
    const m = body.manifest as CaptureBatchManifest | undefined;
    const items = body.items;
    const refuse = (why: string, who = m && typeof m.device_id === 'string' ? m.device_id : session.id): never => {
      this.#logRefusal(who, session, why);
      throw new CoreError('forbidden', `This capture batch was refused, and nothing in it was kept: ${why}`);
    };
    if (!isObj(m) || typeof body.signature !== 'string' || !Array.isArray(items)) refuse('it isn’t a signed batch ({manifest, signature, items}).');
    const man = m as CaptureBatchManifest;
    if (man.v !== 1 || typeof man.batch_id !== 'string' || !ID.test(man.batch_id) || typeof man.device_id !== 'string' || !Array.isArray(man.items)) refuse('its manifest isn’t one Nova reads.');
    // Whose it says it is: an enrolled device, trusted, and the one whose session sent it.
    const claimed = this.#o.devices.find(man.device_id);
    if (!claimed) refuse(`it names a device Nova doesn’t know (${man.device_id.slice(0, 40)}).`);
    if (claimed!.trust !== 'trusted') refuse(`it is from ${claimed!.name}, which was revoked.`);
    if (claimed!.id !== session.id) refuse(`it says it is from ${claimed!.name}, but came over ${session.name}’s session.`);
    let ok = false;
    try { ok = verifyDeviceSignature(claimed!.public_key, captureBatchMessage(man), body.signature as string); } catch { ok = false; }
    if (!ok) refuse(`its signature isn’t ${claimed!.name}’s key over its manifest.`);
    const list = items as unknown[];
    if (list.length !== man.items.length || !list.length || list.length > MAX_BATCH_ITEMS) refuse(`it lists ${man.items.length} items and carries ${list.length} (at most ${MAX_BATCH_ITEMS}, at least one).`);
    let prev = 0;
    for (const [i, it] of list.entries()) {
      const e = man.items[i]!;
      if (!isObj(it) || !isObj(e) || it.id !== e.id || it.seq !== e.seq || typeof e.id !== 'string' || !ID.test(e.id) || !Number.isSafeInteger(e.seq)) refuse(`item ${i + 1} isn’t the one its manifest lists.`);
      if (captureItemDigest(it) !== e.sha256) refuse(`item ${i + 1}’s checksum doesn’t match its manifest.`);
      if ((e.seq as number) <= prev) refuse('its items aren’t in the device’s sequence order.');
      prev = e.seq as number;
    }
    if (man.seq_from !== man.items[0]!.seq || man.seq_to !== man.items[man.items.length - 1]!.seq) refuse('its sequence range doesn’t match its items.');
    // The mode wins: content sent to a cloud hub in local-only mode isn't kept here.
    const sync = this.syncAllowed();
    if (!sync.allowed) throw new CoreError('conflict', `Not kept: ${sync.why}`);

    const at = this.#o.now().toISOString();
    const results: { id: string; status: 'kept' | 'duplicate' | 'not_kept'; reason: string | null }[] = [];
    let newest: string | null = null;
    this.#o.db.tx(() => {
      this.#o.db.run('INSERT OR IGNORE INTO capture_batch (id, device_id, source, seq_from, seq_to, items, manifest_sha256, signature, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        man.batch_id, session.id, String(man.source).slice(0, 40), man.seq_from, man.seq_to, list.length, sha256Hex(canonicalJson(man)), body.signature as string, at);
      for (const raw of list as Record<string, unknown>[]) {
        const kind = String(raw.kind) as Kind;
        if (!(KINDS as readonly string[]).includes(kind)) { results.push({ id: String(raw.id), status: 'not_kept', reason: `kind must be one of ${KINDS.join(', ')}.` }); continue; }
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        const r = this.#o.capture.fromSpoke(session, {
          external_id: String(raw.id), kind, at: String(raw.at), ended_at: str(raw.ended_at), app: str(raw.app), window_title: str(raw.window_title), url: str(raw.url), text: str(raw.text),
          provenance: {
            path: 'capture-sync', device_id: session.id, device_name: session.name, source: String(man.source).slice(0, 40), seq: raw.seq, batch_id: man.batch_id,
            device_time: str(raw.at), sent_at: str(man.sent_at), verified: 'the device’s Ed25519 key, against its enrolled record',
          },
        });
        results.push({ id: String(raw.id), status: r.status, reason: r.reason });
        const t = str(raw.at);
        if (t && (!newest || t > newest)) newest = t;
      }
      const before = this.#o.db.get<SyncRow>('SELECT * FROM capture_device_sync WHERE device_id = ?', session.id);
      this.#o.db.run(`INSERT INTO capture_device_sync (device_id, acked_seq, synced_to, queued, paused, at) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT (device_id) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq), synced_to = CASE WHEN synced_to IS NULL OR excluded.synced_to > synced_to THEN excluded.synced_to ELSE synced_to END, queued = excluded.queued, paused = NULL, at = excluded.at`,
        session.id, Math.max(before?.acked_seq ?? 0, man.seq_to), newest, Math.max(0, Number(man.queued) || 0), at);
    });
    return { batch_id: man.batch_id, acked_to: man.seq_to, results };
  }

  // A device that can't send says what waits (no content: a count and why).
  status(device: Device, body: Record<string, unknown>): { ok: true } {
    const queued = Math.max(0, Math.min(10_000_000, Number(body.queued) || 0));
    const paused = typeof body.paused === 'string' ? body.paused.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : null;
    const at = this.#o.now().toISOString();
    this.#o.db.run(`INSERT INTO capture_device_sync (device_id, acked_seq, synced_to, queued, paused, at) VALUES (?, 0, NULL, ?, ?, ?)
      ON CONFLICT (device_id) DO UPDATE SET queued = excluded.queued, paused = excluded.paused, at = excluded.at`, device.id, queued, paused, at);
    return { ok: true };
  }

  // Per device: how far its capture has synced, in numbers and in words ("synced to 14:32 · 212 queued").
  lag(): { device_id: string; name: string; acked_seq: number; synced_to: string | null; queued: number; paused: string | null; at: string; said: string }[] {
    return this.#o.db.all<SyncRow>('SELECT * FROM capture_device_sync ORDER BY device_id').map((r) => {
      const name = this.#o.devices.find(r.device_id)?.name ?? r.device_id;
      const time = r.synced_to ? new Intl.DateTimeFormat('en-GB', { timeZone: this.#o.timezone(), hour: '2-digit', minute: '2-digit' }).format(new Date(r.synced_to)) : null;
      const said = `${name} capture: ${time ? `synced to ${time}` : 'nothing synced yet'} · ${r.queued} queued${r.paused ? ` (paused: ${r.paused})` : ''}`;
      return { device_id: r.device_id, name, acked_seq: r.acked_seq, synced_to: r.synced_to, queued: r.queued, paused: r.paused, at: r.at, said };
    });
  }

  // ---- tombstones --------------------------------------------------------------------------------------

  // Capture.forget's hook: one tombstone per device holding what was forgotten.
  issue(rows: { id: string; device_id: string; external_id: string | null }[]): { device_id: string; name: string; tombstone: string; acknowledged: boolean }[] {
    const by = new Map<string, { events: string[]; items: string[] }>();
    for (const r of rows) {
      if (!r.external_id) continue;
      const g = by.get(r.device_id) ?? { events: [], items: [] };
      g.events.push(r.id);
      g.items.push(r.external_id);
      by.set(r.device_id, g);
    }
    const at = this.#o.now().toISOString();
    const out: { device_id: string; name: string; tombstone: string; acknowledged: boolean }[] = [];
    for (const [device, g] of by) {
      const id = randomUUID();
      this.#o.db.run('INSERT INTO capture_device_tombstone (id, device_id, items, events, issued_at) VALUES (?, ?, ?, ?, ?)', id, device, JSON.stringify(g.items), JSON.stringify(g.events), at);
      out.push({ device_id: device, name: this.#o.devices.find(device)?.name ?? device, tombstone: id, acknowledged: false });
    }
    return out;
  }

  tombstonesFor(device: Device): { tombstones: { id: string; items: string[]; issued_at: string }[] } {
    return { tombstones: this.#o.db.all<TombRow>('SELECT * FROM capture_device_tombstone WHERE device_id = ? AND acked_at IS NULL ORDER BY issued_at LIMIT 100', device.id).map((t) => ({ id: t.id, items: parse<string[]>(t.items, []), issued_at: t.issued_at })) };
  }

  ack(device: Device, id: string, body: Record<string, unknown>): { ok: true } {
    const t = this.#o.db.get<TombRow>('SELECT * FROM capture_device_tombstone WHERE id = ?', id);
    if (!t || t.device_id !== device.id) throw new CoreError('not_found', 'There is no such tombstone for this device.');
    const removed = Array.isArray(body.removed) ? (body.removed as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const items = parse<string[]>(t.items, []);
    if (typeof body.signature !== 'string' || !verifyDeviceSignature(device.public_key, tombstoneAckMessage(device.id, id, removed), body.signature)) throw new CoreError('forbidden', 'That acknowledgement isn’t signed by this device’s key.');
    const missing = items.filter((i) => !removed.includes(i));
    if (missing.length) throw new CoreError('conflict', `It says it removed ${items.length - missing.length} of ${items.length}; the tombstone stays until it removes them all.`);
    if (!t.acked_at) this.#o.db.run('UPDATE capture_device_tombstone SET acked_at = ?, removed = ? WHERE id = ?', this.#o.now().toISOString(), JSON.stringify(removed), id);
    return { ok: true };
  }

  // What each forget reached, and whether each holder has confirmed.
  forgets(): { id: string; device_id: string; name: string; events: number; issued_at: string; acknowledged_at: string | null; said: string }[] {
    return this.#o.db.all<TombRow>('SELECT * FROM capture_device_tombstone ORDER BY issued_at DESC LIMIT 200').map((t) => {
      const name = this.#o.devices.find(t.device_id)?.name ?? t.device_id;
      const n = parse<string[]>(t.events, []).length;
      return { id: t.id, device_id: t.device_id, name, events: n, issued_at: t.issued_at, acknowledged_at: t.acked_at, said: t.acked_at ? `Deleted on ${name} too (it confirmed).` : `Deleted here; waiting for ${name} to confirm it deleted its copy.` };
    });
  }

  // ---- raw ----------------------------------------------------------------------------------------------

  // The person asks for one raw item, with a reason: a ledger task names both.
  requestRaw(eventId: string, reason: unknown, by: string): Task {
    const why = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
    if (!why) throw new CoreError('validation', 'Say why you want the original: a raw fetch is recorded with its reason.');
    const e = this.#o.capture.event(eventId);
    const transfer = e.provenance.transfer;
    if (!transfer || e.device.id === this.#o.hubId()) throw new CoreError('conflict', 'That event didn’t come from another device by the capture data path, so there is no original there to fetch.');
    if (!e.provenance.external_id?.startsWith('screenpipe:ocr:')) throw new CoreError('conflict', 'Only a screen capture has an original image to fetch; audio originals stay on the device in this build.');
    if (this.#o.site() === 'cloud') throw new CoreError('conflict', 'This hub runs in the cloud. Fetching an original to a cloud hub needs a per-device opt-in, which isn’t built, so it stays on the device.');
    const device = this.#o.devices.find(e.device.id);
    if (!device || device.trust !== 'trusted') throw new CoreError('conflict', 'The device that captured it isn’t one of your devices any more.');
    const id = randomUUID();
    const at = this.#o.now().toISOString();
    this.#o.db.run(`INSERT INTO capture_raw_fetch (id, device_id, event_id, item, reason, state, asked_at) VALUES (?, ?, ?, ?, ?, 'asked', ?)`, id, device.id, eventId, e.provenance.external_id, why, at);
    const task = this.#o.ledger.create({
      title: `Fetch the original capture from ${device.name}`, owner: this.worker.id, origin: { kind: 'user', ref: `capture:raw:${eventId}` },
      goal: `Bring the original of captured event ${eventId} (${e.provenance.external_id}) from ${device.name} to the hub, because: ${why}`,
      evidence_required: [{ kind: 'confirmation', note: 'The file on the hub matches the checksum the device signed.' }],
      privacy_mode: 'local-only', approval_tier: 0, idempotency_key: `capture:raw:${id}`, user_visibility: 'attention',
      inputs: { fetch_id: id, event_id: eventId, device_id: device.id, item: e.provenance.external_id, reason: why, by },
    });
    this.#o.db.run('UPDATE capture_raw_fetch SET task_id = ? WHERE id = ?', task.id, id);
    return task;
  }

  rawFor(device: Device): { requests: { id: string; item: string; reason: string }[] } {
    if (!this.#rawAllowed(device)) return { requests: [] };
    return { requests: this.#o.db.all<RawRow>(`SELECT * FROM capture_raw_fetch WHERE device_id = ? AND state = 'asked' ORDER BY asked_at LIMIT 10`, device.id).map((r) => ({ id: r.id, item: r.item, reason: r.reason })) };
  }

  rawUpload(device: Device, id: string, body: Record<string, unknown>): { ok: true } {
    const r = this.#o.db.get<RawRow>('SELECT * FROM capture_raw_fetch WHERE id = ?', id);
    if (!r || r.device_id !== device.id) throw new CoreError('not_found', 'Nobody asked this device for that.');
    if (!this.#rawAllowed(device)) throw new CoreError('conflict', 'The original stays on the device: raw transfer needs a home hub and this device’s screen capture consent to still be on.');
    if (r.state !== 'asked') return { ok: true };
    const m = body.manifest as RawManifest | undefined;
    if (!isObj(m) || typeof body.signature !== 'string' || typeof body.data !== 'string') throw new CoreError('validation', 'Send {manifest, signature, data}.');
    if (m.v !== 1 || m.request_id !== id || m.device_id !== device.id || m.item !== r.item) throw new CoreError('forbidden', 'That isn’t the item that was asked for.');
    if (!verifyDeviceSignature(device.public_key, rawManifestMessage(m), body.signature)) { this.#logRefusal(device.id, device, 'a raw item’s signature isn’t its key over its manifest.'); throw new CoreError('forbidden', 'Its signature isn’t this device’s key over its manifest.'); }
    const data = Buffer.from(body.data, 'base64');
    if (data.length > MAX_RAW_BYTES || data.length !== m.size || sha256Hex(data) !== m.sha256) throw new CoreError('forbidden', 'It doesn’t match the checksum and size the device signed.');
    const dir = join(this.#o.home, 'capture', 'raw');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, id);
    writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.#o.db.run(`UPDATE capture_raw_fetch SET state = 'arrived', sha256 = ?, size = ?, signature = ?, done_at = ? WHERE id = ?`, m.sha256, m.size, body.signature, this.#o.now().toISOString(), id);
    this.#arrived.get(id)?.();
    return { ok: true };
  }

  // Permission is live, not a property of the old request. Cloud raw opt-in is not built.
  #rawAllowed(device: Device): boolean {
    return this.#o.site() === 'home' && this.#o.devices.find(device.id)?.trust === 'trusted' && !!this.#o.capture.deviceKinds(device.id).screen;
  }

  // A raw item that came, read back (the person's own reading of the original).
  raw(id: string): { id: string; event_id: string; device_id: string; reason: string; state: string; size: number | null; data: string | null } {
    const r = this.#o.db.get<RawRow>('SELECT * FROM capture_raw_fetch WHERE id = ?', id);
    if (!r) throw new CoreError('not_found', 'There is no such fetch.');
    const file = join(this.#o.home, 'capture', 'raw', id);
    return { id, event_id: r.event_id, device_id: r.device_id, reason: r.reason, state: r.state, size: r.size, data: r.state === 'arrived' && existsSync(file) ? readFileSync(file).toString('base64') : null };
  }

  // Forgetting the event forgets its fetched original too.
  forgetRaw(eventIds: string[]): void {
    for (const id of eventIds) {
      for (const r of this.#o.db.all<{ id: string }>('SELECT id FROM capture_raw_fetch WHERE event_id = ?', id)) rmSync(join(this.#o.home, 'capture', 'raw', r.id), { force: true });
      this.#o.db.run('DELETE FROM capture_raw_fetch WHERE event_id = ?', id);
    }
  }

  #makeWorker(): Worker {
    return {
      id: 'capture-raw', name: 'Capture originals', about: 'Brings one original capture from the device that holds it, when you ask, with your reason.', egress: 'none', evidence: ['confirmation'],
      health: () => ({ ok: true }),
      timeoutMs: (this.#o.rawWaitMs ?? 10 * 60_000) + 10_000,
      run: async (brief: Brief) => {
        const id = String(brief.inputs?.fetch_id ?? '');
        const wait = this.#o.rawWaitMs ?? 10 * 60_000;
        const done = () => this.#o.db.get<RawRow>('SELECT * FROM capture_raw_fetch WHERE id = ?', id)?.state === 'arrived';
        if (!done()) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => { this.#arrived.delete(id); resolve(); }, wait);
            this.#arrived.set(id, () => { clearTimeout(t); this.#arrived.delete(id); resolve(); });
          });
        }
        const r = this.#o.db.get<RawRow>('SELECT * FROM capture_raw_fetch WHERE id = ?', id);
        const name = r ? this.#o.devices.find(r.device_id)?.name ?? 'The device' : 'The device';
        if (!r || r.state !== 'arrived') {
          if (r) this.#o.db.run(`UPDATE capture_raw_fetch SET state = 'failed', done_at = ? WHERE id = ? AND state = 'asked'`, this.#o.now().toISOString(), id);
          return { envelope: '1', task_id: brief.task_id, status: 'blocked', summary: `${name} didn’t send it in time: it may be offline. The derived record is in the capture timeline.`, evidence: [], artifacts: [], blockers: [`${name} didn’t answer.`], usage: { duration_ms: wait }, follow_up_suggestions: [] };
        }
        return {
          envelope: '1', task_id: brief.task_id, status: 'done', summary: `${name} sent the original (${r.size} bytes), signed with its key; Nova checked it against the checksum it signed.`,
          evidence: [{ kind: 'confirmation', system: RAW_CONFIRMATION, id }], artifacts: [], blockers: [], usage: { duration_ms: 0 }, follow_up_suggestions: [],
        };
      },
    };
  }

  #confirm(e: { kind: string; system?: string; id?: string }, brief: Brief): { ok: boolean; why: string } {
    const id = String(brief.inputs?.fetch_id ?? '');
    if (e.id !== id) return { ok: false, why: `The confirmation names ${e.id}, not ${id}.` };
    const r = this.#o.db.get<RawRow>('SELECT * FROM capture_raw_fetch WHERE id = ?', id);
    if (!r || r.state !== 'arrived' || !r.sha256) return { ok: false, why: 'Nothing arrived for it.' };
    const file = join(this.#o.home, 'capture', 'raw', id);
    if (!existsSync(file)) return { ok: false, why: 'Its file isn’t on the hub.' };
    const sha = sha256Hex(readFileSync(file));
    return sha === r.sha256 ? { ok: true, why: `Nova read the file on the hub: ${r.size} bytes, SHA-256 ${sha.slice(0, 12)}…, the checksum the device signed.` } : { ok: false, why: 'The file on the hub doesn’t match the checksum the device signed.' };
  }

  #logRefusal(claimed: string, session: Device, why: string): void {
    this.#o.log.warn('capture', 'A capture transfer was refused.', { session_device: session.id, claimed_device: claimed.slice(0, 64), why });
    const k = `${session.id}|${why}`;
    const now = this.#o.now().getTime();
    if (now - (this.#refused.get(k) ?? -Infinity) < REFUSAL_EVERY_MS) return;
    this.#refused.set(k, now);
    this.#o.log.problem('capture', `Nova refused capture sent over ${session.name}’s connection, and kept none of it: ${why}`);
  }

  // ---- routes --------------------------------------------------------------------------------------

  routes(o: { me: (who: unknown) => Device }): Route[] {
    return [
      { method: 'GET', path: '/mesh/capture/plan', access: 'device', summary: 'What this device may capture (the kinds that are on, each from its consent), whether its capture may be sent here now, and what waits for it (tombstones, raw requests).', handle: ({ who }) => this.plan(o.me(who)) },
      {
        method: 'POST', path: '/mesh/capture/batch', access: 'device', body: '{manifest, signature, items}',
        summary: 'A batch of derived capture, in the device’s sequence order, with a manifest signed by its key. Verified against the enrolled device before anything is kept; each item taken in once and answered.',
        handle: ({ body, who }) => this.batch(o.me(who), body),
      },
      { method: 'POST', path: '/mesh/capture/status', access: 'device', body: '{queued, paused?}', summary: 'What waits on a device that can’t send its capture now, and why.', handle: ({ body, who }) => this.status(o.me(who), body) },
      { method: 'GET', path: '/mesh/capture/tombstones', access: 'device', summary: 'Forgets this device must carry out: its own ids of what to delete.', handle: ({ who }) => this.tombstonesFor(o.me(who)) },
      { method: 'POST', path: '/mesh/capture/tombstones/{id}/ack', access: 'device', body: '{removed, signature}', summary: 'The device removed what a tombstone named, signed by its key.', handle: ({ params, body, who }) => this.ack(o.me(who), params.id!, body) },
      { method: 'GET', path: '/mesh/capture/raw', access: 'device', summary: 'Originals the person asked this device for.', handle: ({ who }) => this.rawFor(o.me(who)) },
      { method: 'POST', path: '/mesh/capture/raw/{id}', access: 'device', body: '{manifest, signature, data}', summary: 'One original, signed and checksummed by the device.', handle: ({ params, body, who }) => this.rawUpload(o.me(who), params.id!, body) },
      { method: 'GET', path: '/capture/devices', summary: 'How far each device’s capture has synced: the last item the hub answered, what waits there, and why it is paused.', handle: () => ({ devices: this.lag(), sync: this.syncAllowed() }) },
      { method: 'GET', path: '/capture/forgets', summary: 'Where each forget of capture from another device reached, and whether that device has confirmed.', handle: () => ({ forgets: this.forgets() }) },
      { method: 'POST', path: '/capture/events/{id}/raw', body: '{reason}', summary: 'Fetch one original capture from the device that holds it, with your reason: a ledger task names the item and the reason.', handle: ({ params, body, who }) => ({ task: this.requestRaw(params.id!, body.reason, (who as { principal: { kind: string } }).principal.kind) }) },
      { method: 'GET', path: '/capture/raw/{id}', summary: 'An original that was fetched, with its reason.', handle: ({ params }) => this.raw(params.id!) },
    ];
  }
}
