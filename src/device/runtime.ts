// The runtime agent (ADR-3, M4 plan §2): the part of the device agent that changes often. The boot
// agent starts it as a child under Node's permission model: it may read <device home>/runtime and
// <device home>/state, write only state, and nothing else: no network, no child processes, no
// addons, no node:sqlite, no boot folder (runtimeCommand in boot.ts has the whole list, and why).
// It never sees a private key or a session token: it asks the boot agent, over IPC, to make the
// few hub calls it needs (heartbeat, inbox), and the boot agent makes them with its session.
//
// What it does: heartbeats, so the hub shows this computer Online; and flushes the offline queue to
// the hub's inbox, in order, settling each item only once the hub has answered it. When the hub
// can't be reached it says so to the boot agent, which looks for the hub (or a promoted standby)
// and sends a new session when it finds one; until then everything waits in the queue.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { itemBytes, Queue, type QueueResult } from './queue.ts';

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
  heartbeat_ms?: number;
  tick_ms?: number;
}
export interface CallAnswer { type: 'answer'; id: number; status?: number; body?: unknown; error?: string }
export type ToRuntime = SessionMessage | { type: 'stop' } | { type: 'flush' } | CallAnswer;
export type FromRuntime =
  | { type: 'ready' }
  | { type: 'unreachable'; detail: string }
  | { type: 'unauthorized'; detail: string }
  | { type: 'update'; version: string }
  | { type: 'heartbeat'; at: string; epoch: number }
  | { type: 'call'; id: number; method: 'POST'; path: string; body: unknown };

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
  #nextCall = 1;

  constructor(home: string, send: (m: FromRuntime) => void) {
    this.home = home;
    this.#send = send;
    mkdirSync(join(home, 'state'), { recursive: true });
    this.queue = new Queue(join(home, 'state', 'queue'));
  }

  receive(m: ToRuntime): void {
    if (m.type === 'stop') return this.stop();
    if (m.type === 'flush') { void this.flush(); return; }
    if (m.type === 'answer') { this.#calls.get(m.id)?.(m); return; }
    if (m.type !== 'session') return;
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
      const r = await this.#call('POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: s.capabilities, version: s.version, runtime_version: s.version, safe_mode: false }) as { epoch: number; runtime?: { version?: string } };
      const at = new Date().toISOString();
      this.#write({ last_heartbeat_at: at, epoch: r.epoch, last_error: null });
      this.#send({ type: 'heartbeat', at, epoch: r.epoch });
      if (r.runtime?.version && r.runtime.version !== s.version) this.#send({ type: 'update', version: r.runtime.version });
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
    this.queue.close();
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
