// The runtime agent (ADR-3, M4 plan §2): the part of the device agent that changes often. The boot
// agent starts it as a child under Node's permission model: it may read <device home>/runtime and
// <device home>/state, write only state, and nothing else: no network, no child processes, no
// addons, no node:sqlite, no boot folder (runtimeCommand in boot.ts has the whole list, and why).
// It never sees a private key or a session token: it asks the boot agent, over IPC, to make the
// few hub calls it needs (heartbeat, inbox), and the boot agent makes them with its session.
//
// What it does: heartbeats, so the hub shows this computer Online; and flushes the offline queue to
// the hub's inbox, in order, settling each item only once the hub has answered it. M10h: it decides
// what to do with the native workloads the hub assigns (rollout.ts) and asks the boot agent for one
// of its five verbs, over IPC; it reports what happened in its heartbeat. It starts nothing itself.
// When the hub can't be reached it says so to the boot agent, which looks for the hub (or a promoted
// standby) and sends a new session when it finds one; until then everything waits in the queue.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { itemBytes, Queue, type QueueResult } from './queue.ts';
import { readAssignments, Rollout } from './rollout.ts';
import type { VerbResult, WorkloadState, WorkloadVerb } from './workloads.ts';

// What one inbox call carries at most: under the boot agent's limit for a call (900 kB) and the
// hub's for a request (1 MB), with room for the envelope.
export const MAX_BATCH_BYTES = 768 * 1024;

// The boot agent says the hub is reachable, and where. No token: that stays with the boot agent.
export interface SessionMessage {
  type: 'session';
  hub_url: string;
  device_id: string;
  expires_at: string;
  version: string;
  capabilities: string[];
  // What the computer can run models on (src/core/models/hardware.ts), read by the boot agent.
  hardware?: unknown;
  heartbeat_ms?: number;
  tick_ms?: number;
  // What is installed and running (M10h), from the boot agent.
  workloads?: WorkloadState[];
}
export interface CallAnswer { type: 'answer'; id: number; status?: number; body?: unknown; error?: string }
// The boot agent's answer to a verb, with what is installed and running now.
export interface VerbAnswer extends VerbResult { type: 'verb_answer'; id: number }
// The power verb's answer, and how long since a person last used this machine (read by the boot
// agent, sent before each heartbeat's answer; null when it can't tell).
export interface PowerAnswer { type: 'power_answer'; id: number; ok: boolean; said: string }
export type ToRuntime = SessionMessage | { type: 'stop' } | { type: 'flush' } | CallAnswer | VerbAnswer | PowerAnswer | { type: 'workloads'; state: WorkloadState[] } | { type: 'idle'; ms: number | null };
export type FromRuntime =
  | { type: 'ready' }
  | { type: 'unreachable'; detail: string }
  | { type: 'unauthorized'; detail: string }
  | { type: 'update'; version: string }
  | { type: 'heartbeat'; at: string; epoch: number }
  | { type: 'call'; id: number; method: 'POST'; path: string; body: unknown }
  // One of the boot agent's five verbs (M10h): a verb, a service and a version, and nothing else.
  | { type: 'verb'; id: number; verb: WorkloadVerb; service: string; version: string }
  // The sixth verb (the WoL ADR): hold, release or sleep, about this machine, and nothing else.
  | { type: 'power'; id: number; verb: 'power'; action: 'hold' | 'release' | 'sleep' };

// The sleep policy's count (the WoL ADR, "Who enforces it"): Nova's side is idle while every answer
// says `hold` false, the person's while the OS reports no input; both for `sleep_after_min` minutes,
// then the runtime asks for `power sleep`, once. A gap in the steps (the machine slept, or the hub
// was away) starts the count again, and so does "Never sleep" or an idle time Nova can't read.
// The hub's answer's `power`, kept to what it may say; anything else is no policy at all (an older
// hub sends none, and the machine is never slept by Nova).
export function readPower(v: unknown): { sleep_after_min: 15 | 30 | 60 | 120 | null; hold: boolean } | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.hold !== 'boolean' || !(p.sleep_after_min === null || [15, 30, 60, 120].includes(p.sleep_after_min as number))) return null;
  return { sleep_after_min: p.sleep_after_min as 15 | 30 | 60 | 120 | null, hold: p.hold };
}

export interface IdleState { since: number | null; asked: boolean; last: number | null }
export function idleStep(s: IdleState, i: { now: number; sleep_after_min: number | null; hold: boolean; os_idle_ms: number | null }): IdleState & { sleep: boolean } {
  const gap = s.last !== null && i.now - s.last > 5 * 60_000;
  if (i.sleep_after_min === null || i.hold || i.os_idle_ms === null) return { since: null, asked: false, last: i.now, sleep: false };
  const since = s.since === null || gap ? i.now : s.since;
  const asked = gap ? false : s.asked;
  const limit = i.sleep_after_min * 60_000;
  const due = !asked && i.now - since >= limit && i.os_idle_ms >= limit;
  return { since, asked: asked || due, last: i.now, sleep: due };
}

class Unreachable extends Error {}
class Unauthorized extends Error {}

export class Runtime {
  readonly home: string;
  readonly queue: Queue;
  #send: (m: FromRuntime) => void;
  #session: SessionMessage | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  #busy = false;
  #offline = false;
  #status: Record<string, unknown> = {};
  #stopped = false;
  #calls = new Map<number, (a: CallAnswer) => void>();
  #verbs = new Map<number, (a: VerbAnswer) => void>();
  #nextCall = 1;
  #workloads: WorkloadState[] = [];
  readonly rollout: Rollout;
  // The sleep policy: the hub's latest `power`, the OS idle time, the count, and whether this runtime
  // asked the boot agent to hold the machine awake.
  #power: { sleep_after_min: number | null; hold: boolean } | null = null;
  #osIdle: number | null = null;
  #idle: IdleState = { since: null, asked: false, last: null };
  #holding = false;
  #powers = new Map<number, (a: PowerAnswer) => void>();
  #clock: () => number;

  constructor(home: string, send: (m: FromRuntime) => void, o: { now?: () => number } = {}) {
    this.home = home;
    this.#send = send;
    this.#clock = o.now ?? Date.now;
    mkdirSync(join(home, 'state'), { recursive: true });
    this.queue = new Queue(join(home, 'state', 'queue'));
    this.rollout = new Rollout({ verb: (verb, service, version) => this.#verb(verb, service, version), file: join(home, 'state', 'rollout.json') });
  }

  receive(m: ToRuntime): void {
    if (m.type === 'stop') return this.stop();
    if (m.type === 'flush') { void this.flush(); return; }
    if (m.type === 'answer') { this.#calls.get(m.id)?.(m); return; }
    if (m.type === 'verb_answer') { this.#verbs.get(m.id)?.(m); return; }
    if (m.type === 'power_answer') { this.#powers.get(m.id)?.(m); return; }
    if (m.type === 'idle') { this.#osIdle = typeof m.ms === 'number' && m.ms >= 0 ? m.ms : null; return; }
    if (m.type === 'workloads') { if (Array.isArray(m.state)) this.#workloads = m.state; return; }
    if (m.type !== 'session') return;
    if (Array.isArray(m.workloads)) this.#workloads = m.workloads;
    const first = !this.#session;
    this.#session = m;
    this.#offline = false;
    this.#write({ hub_url: m.hub_url, version: m.version, session_expires_at: m.expires_at });
    if (first) {
      this.#timers.push(setInterval(() => void this.heartbeat(), m.heartbeat_ms ?? 30_000));
      this.#timers.push(setInterval(() => void this.flush(), m.tick_ms ?? 2_000));
    }
    void this.heartbeat().then(() => this.flush());
  }

  async heartbeat(): Promise<void> {
    const s = this.#session;
    if (!s || this.#offline || this.#stopped) return;
    try {
      const reports = this.rollout.reports();
      const r = await this.#call('POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: s.capabilities, version: s.version, runtime_version: s.version, safe_mode: false, ...(s.hardware ? { hardware: s.hardware } : {}), ...(reports.length ? { workloads: reports } : {}) }) as { epoch: number; runtime?: { version?: string }; workloads?: unknown; power?: unknown };
      this.#power = readPower(r.power);
      void this.#powerStep();
      const at = new Date().toISOString();
      this.#write({ last_heartbeat_at: at, epoch: r.epoch, last_error: null });
      this.#send({ type: 'heartbeat', at, epoch: r.epoch });
      if (r.runtime?.version && r.runtime.version !== s.version) this.#send({ type: 'update', version: r.runtime.version });
      // What the hub assigns: decided here, carried out by the boot agent's verbs, reported next time.
      const assigned = readAssignments(r.workloads);
      if (assigned.length) void this.rollout.step(assigned, this.#workloads).catch((e: Error) => this.#write({ last_error: `workloads: ${e.message}` }));
    } catch (e) {
      this.#trouble(e);
    }
  }

  // Sends what is waiting, oldest first, a batch at a time, until nothing is left or the hub can't
  // be reached. An item is settled only when the hub's answer has arrived.
  async flush(): Promise<void> {
    if (this.#busy || !this.#session || this.#offline || this.#stopped) return;
    this.#busy = true;
    try {
      for (;;) {
        const waiting = this.queue.pending(50);
        if (!waiting.length) break;
        // As many as fit in one call, oldest first. One that can never fit (queued by an older
        // agent, before items had a size limit) is refused here, so it can't hold up the rest.
        const items: typeof waiting = [];
        let bytes = 0;
        for (const i of waiting) {
          const size = itemBytes(i);
          if (size > MAX_BATCH_BYTES) {
            if (items.length) break;
            this.queue.settle([{ key: i.key, status: 'refused', reason: `It is too big to send: ${Math.ceil(size / 1024)} KB, more than the hub takes in one request. It was never sent.` }], { local: true });
            continue;
          }
          if (items.length && bytes + size > MAX_BATCH_BYTES) break;
          items.push(i);
          bytes += size;
        }
        if (!items.length) continue;
        const r = await this.#call('POST', '/api/v1/mesh/inbox', { items: items.map((i) => ({ key: i.key, kind: i.kind, body: i.body, created_at: i.created_at })) }) as { results: QueueResult[] };
        this.queue.settle(r.results);
        this.#write({ last_flush_at: new Date().toISOString(), queue: this.queue.counts(), last_error: null });
      }
    } catch (e) {
      this.#trouble(e);
    } finally {
      this.#busy = false;
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const [id, done] of [...this.#calls]) done({ type: 'answer', id, error: 'The runtime is stopping.' });
    for (const [id, done] of [...this.#verbs]) done({ type: 'verb_answer', id, ok: false, said: 'The runtime is stopping.', state: this.#workloads });
    for (const [id, done] of [...this.#powers]) done({ type: 'power_answer', id, ok: false, said: 'The runtime is stopping.' });
  }

  #trouble(e: unknown): void {
    const detail = (e as Error)?.message ?? String(e);
    this.#write({ last_error: detail, queue: this.queue.counts() });
    if (e instanceof Unauthorized) {
      // The session ended or the device was revoked; the boot agent finds out which.
      this.#offline = true;
      this.#send({ type: 'unauthorized', detail });
    } else if (e instanceof Unreachable) {
      this.#offline = true;
      this.#send({ type: 'unreachable', detail });
    }
  }

  // A hub call, made by the boot agent with its session; the answer comes back over IPC.
  async #call(method: 'POST', path: string, body: unknown): Promise<unknown> {
    const s = this.#session!;
    const id = this.#nextCall++;
    const a = await new Promise<CallAnswer>((resolve) => {
      const t = setTimeout(() => { this.#calls.delete(id); resolve({ type: 'answer', id, error: 'the boot agent didn’t answer in time' }); }, 30_000);
      this.#calls.set(id, (m) => { clearTimeout(t); this.#calls.delete(id); resolve(m); });
      this.#send({ type: 'call', id, method, path, body });
    });
    if (a.error !== undefined || typeof a.status !== 'number') throw new Unreachable(`The hub at ${s.hub_url} can’t be reached (${a.error ?? 'no answer'}).`);
    if (a.status === 401) throw new Unauthorized('The hub ended this device’s session.');
    // A hub that is up but not answering as a hub (a 5xx, a fenced or demoted node) counts as
    // unreachable: the boot agent looks for the hub again.
    if (a.status >= 500 || a.status === 409 || a.status === 421) throw new Unreachable(`The hub at ${s.hub_url} answered ${a.status}.`);
    if (a.status < 200 || a.status >= 300) throw new Error(`The hub refused ${method} ${path} (${a.status}): ${JSON.stringify(a.body ?? null).slice(0, 200)}`);
    return a.body ?? null;
  }

  // After each heartbeat: hold the machine awake while the hub says so, let it go when it stops, and
  // ask to sleep once both idle counts reach the policy (idleStep).
  async #powerStep(): Promise<void> {
    const p = this.#power;
    const hold = p?.hold === true;
    if (hold !== this.#holding) {
      const a = await this.#powerVerb(hold ? 'hold' : 'release');
      if (a.ok) this.#holding = hold;
    }
    const step = idleStep(this.#idle, { now: this.#clock(), sleep_after_min: p?.sleep_after_min ?? null, hold, os_idle_ms: this.#osIdle });
    const { sleep, ...state } = step;
    this.#idle = state;
    if (sleep) {
      const a = await this.#powerVerb('sleep');
      this.#write({ last_power: { action: 'sleep', ok: a.ok, said: a.said, at: new Date(this.#clock()).toISOString() } });
    }
  }

  // The sixth verb: asked, never done here.
  #powerVerb(action: 'hold' | 'release' | 'sleep'): Promise<PowerAnswer> {
    const id = this.#nextCall++;
    return new Promise<PowerAnswer>((resolve) => {
      if (this.#stopped) return resolve({ type: 'power_answer', id, ok: false, said: 'The runtime is stopping.' });
      const t = setTimeout(() => { this.#powers.delete(id); resolve({ type: 'power_answer', id, ok: false, said: 'The boot agent didn’t answer in time.' }); }, 60_000);
      this.#powers.set(id, (m) => { clearTimeout(t); this.#powers.delete(id); resolve(m); });
      this.#send({ type: 'power', id, verb: 'power', action });
    });
  }

  // One of the boot agent's five verbs: asked, never done here. The answer carries what is installed
  // and running now.
  #verb(verb: WorkloadVerb, service: string, version: string): Promise<VerbResult> {
    const id = this.#nextCall++;
    return new Promise<VerbResult>((resolve) => {
      if (this.#stopped) return resolve({ ok: false, said: 'The runtime is stopping.', state: this.#workloads });
      const t = setTimeout(() => { this.#verbs.delete(id); resolve({ ok: false, said: 'The boot agent didn’t answer in time.', state: this.#workloads }); }, 120_000);
      this.#verbs.set(id, (m) => { clearTimeout(t); this.#verbs.delete(id); if (Array.isArray(m.state)) this.#workloads = m.state; resolve({ ok: m.ok, said: m.said, ...(m.refused ? { refused: true } : {}), state: this.#workloads }); });
      this.#send({ type: 'verb', id, verb, service, version });
    });
  }

  // state/runtime.json: what the boot agent's `status` command shows. Written whole, then moved.
  #write(patch: Record<string, unknown>): void {
    this.#status = { ...this.#status, pid: process.pid, ...patch, updated_at: new Date().toISOString() };
    const file = join(this.home, 'state', 'runtime.json');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#status, null, 2)}\n`);
    renameSync(tmp, file);
  }
}

// Started by the boot agent: `node --permission … <home>/runtime/runtime.ts <home>`, with IPC.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && typeof process.send === 'function') {
  const home = process.argv[2];
  if (!home) {
    console.error('The runtime agent is started by the boot agent, with the device home.');
    process.exit(2);
  }
  const rt = new Runtime(home, (m) => process.send?.(m));
  process.on('message', (m: ToRuntime) => {
    rt.receive(m);
    if (m.type === 'stop') process.exit(0);
  });
  // The boot agent went away: so does the runtime. It never runs on its own.
  process.on('disconnect', () => { rt.stop(); process.exit(0); });
  process.send({ type: 'ready' } satisfies FromRuntime);
}
