// The capture carrier (M10h; docs/builder-packet/nova-capture-data-path-design-2026-10-31.md): how a
// spoke's capture reaches the hub. Part of the boot agent, because the boot agent already holds the
// device's key and its session with the hub; the runtime never sees either, and has no part in this.
//
// It moves data and starts nothing: there is no child_process here (a test reads this file), and it
// talks to two places only, the hub over the boot agent's own session, and the capture workload's
// loopback port, which it takes from the live version's hub-signed manifest (workloads.ts
// liveCapture; never a copy running alongside or as a shadow). So the boot agent's five verbs stay
// five (Decision 1): moving data isn't one of them.
//
// What it does, each tick:
//   1. asks the hub what this device may capture and sync (`/mesh/capture/plan`): the kinds that are
//      on, each from when; whether sync is allowed (local-only with a cloud hub: not); what waits;
//   2. pulls the live capture workload's derived events (Screenpipe's text and transcripts, never
//      its images or audio) for the kinds that are on, after their consent, private windows dropped
//      here, and queues them in capture/outbox/ numbered by this device's sequence (not the clock:
//      spoke clocks lie). A full queue pauses the pull and says so; the workload keeps its own store,
//      so nothing is lost;
//   3. sends what is queued in sequence order, in batches whose manifest is signed with this
//      device's key; drops each item only once the hub has answered it (store and forward: offline,
//      everything waits, and goes when the hub is back, once);
//   4. carries out tombstones (deleting the item from the queue and from the workload's store) and
//      acknowledges each, signed;
//   5. sends a raw item the person asked for, signed and checksummed, and nothing else raw.
// Capture off: nothing is pulled, and the capture workload is stopped.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  captureBatchMessage, captureItemDigest, rawManifestMessage, sha256Hex, signMessage, tombstoneAckMessage,
  type CaptureBatchManifest, type DeviceKeys, type RawManifest,
} from '../core/mesh/wire.ts';

export const MAX_QUEUE = 10_000;
export const BATCH_ITEMS = 100;
// A batch is kept well under what the hub takes in one request (1 MB).
const BATCH_BYTES = 600 * 1024;
const RAW_BYTES = 640 * 1024;
const SOURCE = 'screenpipe-adapter';

export interface Res { status: number; body: any }
export interface CapturePlan {
  // kind → from when it may be taken (its consent).
  kinds: Record<string, string>;
  sync: { allowed: boolean; why: string | null };
  tombstones: number;
  raw: number;
}
export interface CarrierItem { id: string; seq: number; kind: string; at: string; ended_at: string | null; app: string | null; window_title: string | null; url: string | null; text: string | null }
interface Meta { next_seq: number; watermark: string | null; seen: string[]; forgotten: string[]; acked_seq: number; synced_to: string | null; plan: CapturePlan | null }
export interface CarrierStatus { queued: number; paused: string | null; acked_seq: number; synced_to: string | null; last_error: string | null; plan: CapturePlan | null }

export interface CarrierOptions {
  home: string;
  deviceId: () => string;
  deviceName: () => string;
  keys: DeviceKeys;
  // A hub call over the boot agent's session; null when there is no session.
  hub: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Res | null>;
  // The live capture workload, if one runs.
  capture: () => { port: number; kinds: string[] } | null;
  // Capture was turned off on this device: stop the capture workload.
  stopCapture: (why: string) => Promise<unknown>;
  say?: (line: string) => void;
  maxQueue?: number;
  now?: () => Date;
}

export class Carrier {
  readonly dir: string;
  #o: CarrierOptions;
  #outbox: string;
  #meta: Meta;
  #busy = false;
  #paused: string | null = null;
  #lastError: string | null = null;
  #saidPause = '';

  constructor(o: CarrierOptions) {
    this.#o = o;
    this.dir = join(o.home, 'capture');
    this.#outbox = join(this.dir, 'outbox');
    for (const d of [this.dir, this.#outbox]) mkdirSync(d, { recursive: true, mode: 0o700 });
    this.#meta = { next_seq: 1, watermark: null, seen: [], forgotten: [], acked_seq: 0, synced_to: null, plan: null, ...(read<Partial<Meta>>(join(this.dir, 'meta.json')) ?? {}) };
  }

  // Whether capture is on for this device, as the hub last said (kept across restarts, so a device
  // that can't reach its hub keeps capturing what was on: local capture doesn't need the network).
  captureOn(): boolean {
    return Object.keys(this.#meta.plan?.kinds ?? {}).length > 0;
  }

  status(): CarrierStatus {
    return { queued: this.#names().length, paused: this.#paused, acked_seq: this.#meta.acked_seq, synced_to: this.#meta.synced_to, last_error: this.#lastError, plan: this.#meta.plan };
  }

  queued(): CarrierItem[] {
    return this.#names().map((n) => read<CarrierItem>(join(this.#outbox, n))).filter((i): i is CarrierItem => !!i);
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const plan = await this.#plan();
      if (!this.captureOn()) {
        await this.#o.stopCapture('capture is off on this device.');
      } else {
        await this.#pull();
      }
      if (plan) {
        await this.#tombstones(plan);
        await this.#raw(plan);
        await this.#send(plan);
      }
    } catch (e) {
      this.#lastError = (e as Error).message;
    } finally {
      this.#save();
      this.#busy = false;
    }
  }

  // ---- 1. the plan --------------------------------------------------------------------------------

  async #plan(): Promise<CapturePlan | null> {
    const r = await this.#o.hub('GET', '/api/v1/mesh/capture/plan').catch(() => null);
    if (!r || r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
    const b = r.body as Partial<CapturePlan>;
    const kinds: Record<string, string> = {};
    if (b.kinds && typeof b.kinds === 'object') for (const [k, v] of Object.entries(b.kinds)) if (/^[a-z-]{1,20}$/.test(k) && typeof v === 'string' && !Number.isNaN(Date.parse(v))) kinds[k] = new Date(v).toISOString();
    const plan: CapturePlan = {
      kinds, sync: { allowed: b.sync?.allowed === true, why: typeof b.sync?.why === 'string' ? b.sync.why.slice(0, 300) : null },
      tombstones: Number(b.tombstones) || 0, raw: Number(b.raw) || 0,
    };
    this.#meta.plan = plan;
    return plan;
  }

  // ---- 2. the pull ---------------------------------------------------------------------------------

  async #pull(): Promise<void> {
    const cap = this.#o.capture();
    if (!cap) return;
    const kinds = this.#meta.plan?.kinds ?? {};
    const max = this.#o.maxQueue ?? MAX_QUEUE;
    let count = this.#names().length;
    if (count >= max) return this.#pause(`The capture queue is full (${count} items waiting for the hub), so taking more is paused. Nothing is lost: the capture program keeps its own store until there is room.`);
    const since = this.#meta.watermark;
    const items = await this.#search(cap.port, since);
    const seen = new Set(this.#meta.seen);
    const forgotten = new Set(this.#meta.forgotten);
    let newest = since;
    // Oldest first, so the sequence follows the order they were captured in.
    for (const it of items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
      if (count >= max) { this.#pause(`The capture queue is full (${count} items waiting for the hub), so taking more is paused. Nothing is lost: the capture program keeps its own store until there is room.`); break; }
      if (!newest || it.at > newest) newest = it.at;
      if (seen.has(it.id) || forgotten.has(it.id)) continue;
      seen.add(it.id);
      const from = kinds[it.kind];
      // Off, or captured before it was turned on: never queued, never sent.
      if (!from || it.at < from || it.private) continue;
      const item: CarrierItem = { id: it.id, seq: this.#meta.next_seq++, kind: it.kind, at: it.at, ended_at: it.ended_at, app: it.app, window_title: it.window_title, url: it.url, text: it.text };
      write(join(this.#outbox, `${String(item.seq).padStart(12, '0')}.json`), item);
      count++;
    }
    if (count < max) this.#paused = this.#paused?.startsWith('The capture queue is full') ? null : this.#paused;
    // The watermark stops a second before the newest, so items sharing its second are read again
    // (and recognised by their id) rather than missed.
    if (newest) this.#meta.watermark = new Date(Math.max(0, Date.parse(newest) - 1000)).toISOString();
    this.#meta.seen = [...seen].slice(-5000);
  }

  // Screenpipe's /search, newest first, a page at a time. Its text and transcripts only.
  async #search(port: number, since: string | null): Promise<Array<Omit<CarrierItem, 'seq'> & { private: boolean }>> {
    const out: Array<Omit<CarrierItem, 'seq'> & { private: boolean }> = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const q = new URLSearchParams({ content_type: 'all', limit: '200', offset: String(offset), ...(since ? { start_time: since } : {}) });
      let body: { data?: Array<{ type?: string; content?: Record<string, unknown> }> };
      try {
        const r = await fetch(`http://127.0.0.1:${port}/search?${q}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return out;
        body = await r.json() as typeof body;
      } catch { return out; }
      const page = Array.isArray(body.data) ? body.data : [];
      for (const d of page) {
        const c = d.content ?? {};
        const at = typeof c.timestamp === 'string' && !Number.isNaN(Date.parse(c.timestamp)) ? new Date(c.timestamp).toISOString() : null;
        if (!at) continue;
        const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 20_000) : null);
        if (d.type === 'OCR') out.push({ id: `screenpipe:ocr:${c.frame_id}`, kind: 'screen', at, ended_at: null, app: str(c.app_name), window_title: str(c.window_name), url: str(c.browser_url), text: str(c.text), private: c.private === true });
        else if (d.type === 'Audio') out.push({ id: `screenpipe:audio:${c.chunk_id}`, kind: 'audio', at, ended_at: null, app: null, window_title: null, url: null, text: str(c.transcription), private: false });
      }
      if (page.length < 200) break;
    }
    return out;
  }

  // ---- 3. the send ---------------------------------------------------------------------------------

  async #send(plan: CapturePlan): Promise<void> {
    if (!plan.sync.allowed) {
      const queued = this.#names().length;
      this.#pause(plan.sync.why ?? 'The hub says capture can’t be sent to it now, so it waits here.');
      await this.#o.hub('POST', '/api/v1/mesh/capture/status', { queued, paused: this.#paused }).catch(() => null);
      return;
    }
    if (this.#paused && !this.#paused.startsWith('The capture queue is full')) this.#paused = null;
    for (let round = 0; round < 50; round++) {
      const names = this.#names();
      if (!names.length) break;
      const items: CarrierItem[] = [];
      let bytes = 0;
      for (const n of names.slice(0, BATCH_ITEMS)) {
        const i = read<CarrierItem>(join(this.#outbox, n));
        if (!i) { rmSync(join(this.#outbox, n), { force: true }); continue; }
        const size = Buffer.byteLength(JSON.stringify(i));
        if (items.length && bytes + size > BATCH_BYTES) break;
        items.push(i);
        bytes += size;
      }
      if (!items.length) break;
      const manifest: CaptureBatchManifest = {
        v: 1, batch_id: randomUUID(), device_id: this.#o.deviceId(), device_name: this.#o.deviceName(), source: SOURCE,
        seq_from: items[0]!.seq, seq_to: items[items.length - 1]!.seq,
        items: items.map((i) => ({ id: i.id, seq: i.seq, sha256: captureItemDigest(i) })),
        queued: names.length - items.length, sent_at: (this.#o.now?.() ?? new Date()).toISOString(),
      };
      const signature = signMessage(this.#o.keys.ed25519.privateKey, captureBatchMessage(manifest));
      const r = await this.#o.hub('POST', '/api/v1/mesh/capture/batch', { manifest, signature, items }).catch((e: Error) => { this.#lastError = e.message; return null; });
      // No answer: everything stays queued, and goes again (the hub takes each item once).
      if (!r) return;
      if (r.status !== 200) { this.#lastError = `The hub refused a capture batch (${r.status}): ${typeof r.body?.error === 'string' ? r.body.error : ''}`.trim(); return; }
      const answered = new Set<string>(Array.isArray(r.body?.results) ? (r.body.results as { id?: unknown }[]).map((x) => String(x.id)) : []);
      for (const i of items) {
        if (!answered.has(i.id)) continue;
        rmSync(join(this.#outbox, `${String(i.seq).padStart(12, '0')}.json`), { force: true });
        this.#meta.acked_seq = Math.max(this.#meta.acked_seq, i.seq);
        if (!this.#meta.synced_to || i.at > this.#meta.synced_to) this.#meta.synced_to = i.at;
      }
      this.#lastError = null;
      this.#save();
    }
  }

  // ---- 4. tombstones ---------------------------------------------------------------------------------

  async #tombstones(plan: CapturePlan): Promise<void> {
    if (!plan.tombstones) return;
    const r = await this.#o.hub('GET', '/api/v1/mesh/capture/tombstones').catch(() => null);
    if (!r || r.status !== 200 || !Array.isArray(r.body?.tombstones)) return;
    for (const t of r.body.tombstones as { id?: unknown; items?: unknown }[]) {
      if (typeof t.id !== 'string' || !Array.isArray(t.items)) continue;
      const ids = (t.items as unknown[]).filter((x): x is string => typeof x === 'string' && x.length < 200);
      // From the queue, if it is still waiting here.
      for (const i of this.queued()) if (ids.includes(i.id)) rmSync(join(this.#outbox, `${String(i.seq).padStart(12, '0')}.json`), { force: true });
      // From the capture program's own store: derived and raw. Without it running, the store can't
      // be reached, so the tombstone waits, unacknowledged, and the hub's report says so.
      const cap = this.#o.capture();
      if (!cap) continue;
      const native = ids.map((id) => id.split(':').pop()!);
      let ok = false;
      try {
        const d = await fetch(`http://127.0.0.1:${cap.port}/__delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: native }), signal: AbortSignal.timeout(5000) });
        ok = d.ok;
      } catch { ok = false; }
      if (!ok) continue;
      this.#meta.forgotten = [...new Set([...this.#meta.forgotten, ...ids])].slice(-5000);
      const signature = signMessage(this.#o.keys.ed25519.privateKey, tombstoneAckMessage(this.#o.deviceId(), t.id, ids));
      await this.#o.hub('POST', `/api/v1/mesh/capture/tombstones/${encodeURIComponent(t.id)}/ack`, { removed: ids, signature }).catch(() => null);
      this.#o.say?.(`Deleted ${ids.length} captured item${ids.length === 1 ? '' : 's'} here, as the hub asked, and told it so.`);
    }
  }

  // ---- 5. raw ------------------------------------------------------------------------------------------

  async #raw(plan: CapturePlan): Promise<void> {
    if (!plan.raw) return;
    const cap = this.#o.capture();
    if (!cap) return;
    const r = await this.#o.hub('GET', '/api/v1/mesh/capture/raw').catch(() => null);
    if (!r || r.status !== 200 || !Array.isArray(r.body?.requests)) return;
    for (const q of r.body.requests as { id?: unknown; item?: unknown }[]) {
      if (typeof q.id !== 'string' || typeof q.item !== 'string' || !/^screenpipe:ocr:[A-Za-z0-9_-]{1,64}$/.test(q.item)) continue;
      let data: Buffer;
      try {
        const f = await fetch(`http://127.0.0.1:${cap.port}/frames/${encodeURIComponent(q.item.split(':').pop()!)}`, { signal: AbortSignal.timeout(10_000) });
        if (!f.ok) continue;
        data = Buffer.from(await f.arrayBuffer());
      } catch { continue; }
      if (data.length > RAW_BYTES) { this.#o.say?.(`A raw item the hub asked for is ${Math.ceil(data.length / 1024)} KB, more than one request carries; it wasn’t sent.`); continue; }
      const manifest: RawManifest = { v: 1, request_id: q.id, device_id: this.#o.deviceId(), item: q.item, sha256: sha256Hex(data), size: data.length, sent_at: new Date().toISOString() };
      const signature = signMessage(this.#o.keys.ed25519.privateKey, rawManifestMessage(manifest));
      await this.#o.hub('POST', `/api/v1/mesh/capture/raw/${encodeURIComponent(q.id)}`, { manifest, signature, data: data.toString('base64') }).catch(() => null);
    }
  }

  // ---- internals ---------------------------------------------------------------------------------------

  #pause(why: string): void {
    this.#paused = why;
    if (this.#saidPause !== why) this.#o.say?.(why);
    this.#saidPause = why;
  }

  #names(): string[] {
    try { return readdirSync(this.#outbox).filter((n) => /^\d{12}\.json$/.test(n)).sort(); } catch { return []; }
  }

  #save(): void {
    write(join(this.dir, 'meta.json'), this.#meta);
  }
}

function read<T>(file: string): T | null {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : null; } catch { return null; }
}

function write(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
