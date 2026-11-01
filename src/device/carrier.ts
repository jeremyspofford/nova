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
// The pull's time windows: at most 10 minutes, at least a second; a window is read in up to 25 pages
// of 200.
const WINDOW_MS = 10 * 60_000;
const MIN_WINDOW_MS = 1000;
// How far back each pull reads again, for items reported late (as the hub's own Screenpipe adapter does).
const LOOKBACK_MS = 5 * 60_000;
const PAGE = 200;
const PAGES = 25;
// screenpipe:ocr:17 → {type: 'ocr', id: '17'}: the capture program's own name for it.
const nativeOf = (id: string) => { const [, type = '', native = ''] = id.split(':'); return { type, id: native }; };

export interface Res { status: number; body: any }
export interface CapturePlan {
  // kind → from when it may be taken (its consent).
  kinds: Record<string, string>;
  sync: { allowed: boolean; why: string | null };
  tombstones: number;
  raw: number;
  raw_allowed: boolean;
}
export interface CarrierItem { id: string; seq: number; kind: string; at: string; ended_at: string | null; app: string | null; window_title: string | null; url: string | null; text: string | null }
interface Meta { next_seq: number; watermark: string | null; window?: number; seen: string[]; forgotten: string[]; discard: string[]; acked_seq: number; synced_to: string | null; plan: CapturePlan | null }
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
  // Whether a capture workload is installed here. Without one, and with nothing queued, a tick does
  // nothing at all (no call to the hub).
  active?: () => boolean;
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
  // Why taking more is paused (the queue is full), and why sending waits (the hub says it may not be
  // sent now): either, both, or neither, each said.
  #full: string | null = null;
  #held: string | null = null;
  get #paused(): string | null { return [this.#full, this.#held].filter(Boolean).join(' ') || null; }
  #lastError: string | null = null;
  #saidPause = '';
  #saidStatus = '';

  constructor(o: CarrierOptions) {
    this.#o = o;
    this.dir = join(o.home, 'capture');
    this.#outbox = join(this.dir, 'outbox');
    for (const d of [this.dir, this.#outbox]) mkdirSync(d, { recursive: true, mode: 0o700 });
    this.#meta = { next_seq: 1, watermark: null, seen: [], forgotten: [], discard: [], acked_seq: 0, synced_to: null, plan: null, ...(read<Partial<Meta>>(join(this.dir, 'meta.json')) ?? {}) };
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
    if (this.#o.active && !this.#o.active() && !this.#names().length && !this.captureOn() && !this.#meta.discard.length) return;
    this.#busy = true;
    try {
      const plan = await this.#plan();
      await this.#discard();
      if (!this.captureOn()) {
        await this.#o.stopCapture('capture is off on this device.');
      } else {
        await this.#pull();
      }
      if (plan) {
        await this.#tombstones(plan);
        await this.#raw(plan);
        // Raw work can await local I/O while privacy changes. A failed refresh holds the queue;
        // offline pulling above still follows the last consent saved on this device.
        const sending = await this.#plan();
        if (sending) await this.#send(sending);
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
      tombstones: Number(b.tombstones) || 0, raw: Number(b.raw) || 0, raw_allowed: b.raw_allowed === true,
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
    const full = () => this.#pause('full', `The capture queue is full (${count} items waiting for the hub), so taking more is paused. Nothing is lost: the capture program keeps its own store until there is room.`);
    if (count >= max) return full();
    const seen = new Set(this.#meta.seen);
    const forgotten = new Set(this.#meta.forgotten);
    // Captured while its kind was off (another kind was on, so the program ran): deleted where it was
    // captured, never queued or sent.
    const discard = new Set(this.#meta.discard);
    // From the watermark (or the first consent), forward in time windows, each read whole before the
    // watermark passes it: a window that comes back incomplete (an error, or more than one read
    // holds) is made smaller and read again; nothing is skipped.
    const firstConsent = Object.values(kinds).sort()[0] ?? null;
    // A few minutes back from the watermark each time, for items the program reports late (a
    // transcript finishes after its audio began); what was seen is recognised by its id.
    const back = this.#meta.watermark ? new Date(Math.max(Date.parse(this.#meta.watermark) - LOOKBACK_MS, firstConsent ? Date.parse(firstConsent) : 0)).toISOString() : null;
    let from = back ?? firstConsent;
    if (!from) return;
    let windowMs = this.#meta.window ?? WINDOW_MS;
    const now = (this.#o.now?.() ?? new Date()).getTime();
    let stopped = false;
    for (let round = 0; round < 40 && !stopped; round++) {
      const fromMs = Date.parse(from);
      if (!(fromMs < now)) break;
      const toMs = Math.min(fromMs + windowMs, now);
      const r = await this.#search(cap.port, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
      if (r.failed) break;
      if (!r.complete) {
        if (windowMs <= MIN_WINDOW_MS) { this.#lastError = 'More was captured in one second than one read holds; the rest is read on the next pass.'; break; }
        windowMs = Math.max(MIN_WINDOW_MS, Math.floor(windowMs / 4));
        continue;
      }
      // Oldest first, so the sequence follows the order they were captured in.
      for (const it of r.items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
        if (seen.has(it.id) || forgotten.has(it.id)) continue;
        if (count >= max) {
          // Full: the watermark stops just before what wasn't taken, so it is read again later.
          this.#meta.watermark = new Date(Math.max(0, Date.parse(it.at) - 1)).toISOString();
          stopped = true;
          full();
          break;
        }
        seen.add(it.id);
        const since = kinds[it.kind];
        if (!since || it.at < since) { discard.add(it.id); continue; }
        // A private window never leaves this device.
        if (it.private) continue;
        const item: CarrierItem = { id: it.id, seq: this.#meta.next_seq++, kind: it.kind, at: it.at, ended_at: it.ended_at, app: it.app, window_title: it.window_title, url: it.url, text: it.text };
        write(join(this.#outbox, `${String(item.seq).padStart(12, '0')}.json`), item);
        count++;
      }
      if (stopped) break;
      // Read whole: the watermark moves to the window's end, less a little overlap (items sharing
      // that instant are read again and recognised by their id).
      const overlap = Math.min(1000, Math.floor(windowMs / 2));
      this.#meta.watermark = new Date(Math.max(fromMs, toMs - overlap)).toISOString();
      from = this.#meta.watermark;
      if (toMs >= now) break;
      windowMs = Math.min(WINDOW_MS, windowMs * 2);
    }
    this.#meta.window = windowMs;
    if (!stopped && count < max) this.#full = null;
    this.#meta.seen = [...seen].slice(-20_000);
    this.#meta.discard = [...discard];
    // Save pending privacy deletion before its I/O; a restart must not turn seen into forgotten work.
    this.#save();
    await this.#discard();
  }

  async #discard(): Promise<void> {
    if (!this.#meta.discard.length) return;
    const cap = this.#o.capture();
    if (!cap || !(await this.#delete(cap.port, this.#meta.discard.map(nativeOf)))) {
      this.#lastError = `Couldn’t delete ${this.#meta.discard.length} captured item(s) whose source was off. Deletion is pending and will be retried.`;
      this.#o.say?.(this.#lastError);
      return;
    }
    this.#meta.discard = [];
    this.#lastError = null;
    this.#save();
  }

  // Screenpipe's /search for one time window, newest first, a page at a time: its text and
  // transcripts only. `complete` only when the window was read to its end.
  async #search(port: number, start: string, end: string): Promise<{ items: Array<Omit<CarrierItem, 'seq'> & { private: boolean }>; complete: boolean; failed: boolean }> {
    const items: Array<Omit<CarrierItem, 'seq'> & { private: boolean }> = [];
    for (let page = 0; page < PAGES; page++) {
      const q = new URLSearchParams({ content_type: 'all', limit: String(PAGE), offset: String(page * PAGE), start_time: start, end_time: end });
      let body: { data?: Array<{ type?: string; content?: Record<string, unknown> }> };
      try {
        const r = await fetch(`http://127.0.0.1:${port}/search?${q}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return { items, complete: false, failed: true };
        body = await r.json() as typeof body;
      } catch { return { items, complete: false, failed: true }; }
      const data = Array.isArray(body.data) ? body.data : [];
      for (const d of data) {
        const c = d.content ?? {};
        const at = typeof c.timestamp === 'string' && !Number.isNaN(Date.parse(c.timestamp)) ? new Date(c.timestamp).toISOString() : null;
        if (!at) continue;
        const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 20_000) : null);
        if (d.type === 'OCR') items.push({ id: `screenpipe:ocr:${c.frame_id}`, kind: 'screen', at, ended_at: null, app: str(c.app_name), window_title: str(c.window_name), url: str(c.browser_url), text: str(c.text), private: c.private === true });
        else if (d.type === 'Audio') items.push({ id: `screenpipe:audio:${c.chunk_id}`, kind: 'audio', at, ended_at: null, app: null, window_title: null, url: null, text: str(c.transcription), private: false });
      }
      if (data.length < PAGE) return { items, complete: true, failed: false };
    }
    return { items, complete: false, failed: false };
  }

  // Deletes items from the capture program's own store, by their type and its own id (frames and
  // audio chunks are numbered apart). The stand-in's call; real Screenpipe's is to be checked.
  async #delete(port: number, items: { type: string; id: string }[]): Promise<boolean> {
    try {
      const d = await fetch(`http://127.0.0.1:${port}/__delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }), signal: AbortSignal.timeout(5000) });
      return d.ok;
    } catch { return false; }
  }

  // ---- 3. the send ---------------------------------------------------------------------------------

  async #send(plan: CapturePlan): Promise<void> {
    if (!plan.sync.allowed) {
      const queued = this.#names().length;
      this.#pause('held', plan.sync.why ?? 'The hub says capture can’t be sent to it now, so it waits here.');
      // What waits is said (a count and why, no content), when it changes.
      const said = `${queued}|${this.#paused}`;
      if (said !== this.#saidStatus) {
        const r = await this.#o.hub('POST', '/api/v1/mesh/capture/status', { queued, paused: this.#paused }).catch(() => null);
        if (r?.status === 200) this.#saidStatus = said;
      }
      return;
    }
    this.#held = null;
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
      if (!this.#meta.discard.length) this.#lastError = null;
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
      if (!(await this.#delete(cap.port, ids.map(nativeOf)))) continue;
      this.#meta.forgotten = [...new Set([...this.#meta.forgotten, ...ids])].slice(-5000);
      const signature = signMessage(this.#o.keys.ed25519.privateKey, tombstoneAckMessage(this.#o.deviceId(), t.id, ids));
      await this.#o.hub('POST', `/api/v1/mesh/capture/tombstones/${encodeURIComponent(t.id)}/ack`, { removed: ids, signature }).catch(() => null);
      this.#o.say?.(`Deleted ${ids.length} captured item${ids.length === 1 ? '' : 's'} here, as the hub asked, and told it so.`);
    }
  }

  // ---- 5. raw ------------------------------------------------------------------------------------------

  async #raw(plan: CapturePlan): Promise<void> {
    if (!plan.raw || !plan.raw_allowed || !plan.sync.allowed) return;
    const cap = this.#o.capture();
    if (!cap) return;
    const r = await this.#o.hub('GET', '/api/v1/mesh/capture/raw').catch(() => null);
    if (!r || r.status !== 200 || !Array.isArray(r.body?.requests)) return;
    for (const q of r.body.requests as { id?: unknown; item?: unknown }[]) {
      if (typeof q.id !== 'string' || typeof q.item !== 'string' || !/^screenpipe:ocr:[A-Za-z0-9_-]{1,64}$/.test(q.item)) continue;
      const before = await this.#plan();
      if (!before?.raw_allowed || !before.sync.allowed) return;
      let data: Buffer;
      try {
        const f = await fetch(`http://127.0.0.1:${cap.port}/frames/${encodeURIComponent(q.item.split(':').pop()!)}`, { signal: AbortSignal.timeout(10_000) });
        if (!f.ok) continue;
        data = Buffer.from(await f.arrayBuffer());
      } catch { continue; }
      if (data.length > RAW_BYTES) { this.#o.say?.(`A raw item the hub asked for is ${Math.ceil(data.length / 1024)} KB, more than one request carries; it wasn’t sent.`); continue; }
      const after = await this.#plan();
      if (!after?.raw_allowed || !after.sync.allowed) return;
      const manifest: RawManifest = { v: 1, request_id: q.id, device_id: this.#o.deviceId(), item: q.item, sha256: sha256Hex(data), size: data.length, sent_at: new Date().toISOString() };
      const signature = signMessage(this.#o.keys.ed25519.privateKey, rawManifestMessage(manifest));
      await this.#o.hub('POST', `/api/v1/mesh/capture/raw/${encodeURIComponent(q.id)}`, { manifest, signature, data: data.toString('base64') }).catch(() => null);
    }
  }

  // ---- internals ---------------------------------------------------------------------------------------

  #pause(which: 'full' | 'held', why: string): void {
    if (which === 'full') this.#full = why;
    else this.#held = why;
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
