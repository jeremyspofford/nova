// Native workloads on this device (M10h; the orchestration ADR, Point 6 and Decision 1): the boot
// agent's side. It does five things with a workload and nothing else:
//   install  fetch the hub-signed manifest itself, verify it, download every file it pins and check
//            each SHA-256, into a slot of its own for that version;
//   start    verify the slot again, then start the manifest's own command (argv, no shell) in its own
//            process group, with none of this agent's environment, under a watchdog;
//   stop     end it;
//   switch   make a version live: the old live one stops, its slot kept for one step back;
//   probe    GET the manifest's health path on 127.0.0.1, on the port this agent gave that copy.
// A verb request is {verb, service, version} and nothing more: the command, its arguments, its
// environment and its ports are all in the manifest the hub signed, never in a request. The runtime
// agent decides which verbs to ask for (src/device/rollout.ts) and reports; it can't start anything.
//
// Folders, under the device home (the runtime may read or write none of them):
//   workloads/<service>/state.json      {live, previous}
//   workloads/<service>/v/<version>/    the files, exactly as pinned, and manifest.json (as signed)
//   workloads/<service>/data/           the live version's state, kept across versions
//   workloads/<service>/scratch/        a copy started alongside (or as a shadow) works here, fresh
//   workloads/<service>/home/           HOME and TMPDIR for its processes
// This file ships with the device agent alone: it imports only the wire format and its neighbours.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { sha256Hex, verifyDeviceSignature, workloadManifestMessage, type SignedWorkload, type WorkloadManifest } from '../core/mesh/wire.ts';
import { assignmentAllowed } from './trust.ts';
import { Watchdog, type ChildLike } from './watchdog.ts';

export const WORKLOAD_VERBS = Object.freeze(['install', 'start', 'stop', 'switch', 'probe'] as const);
export type WorkloadVerb = (typeof WORKLOAD_VERBS)[number];
export interface VerbRequest { verb: WorkloadVerb; service: string; version: string }
// The OS permissions that make a workload a capture workload: it may run only on a capture source,
// and only while capture is on there.
export const CAPTURE_PERMISSIONS: readonly string[] = Object.freeze(['screen-recording', 'microphone', 'accessibility']);
// The interpreters a command may name before its own file: Nova's own Node, and nothing else (the
// hub's validator says the same, services/definition.ts INTERPRETERS).
const INTERPRETERS = new Set(['node']);
const SERVICE = /^[a-z][a-z0-9-]{0,52}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_FILES = new Set(['manifest.json', 'state.json']);
const SHA = /^[0-9a-f]{64}$/;
const HEALTH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@\/?%-]*$/;

export type Verdict<T = undefined> = { ok: true; value: T } | { ok: false; reason: string };

// A request from the runtime, checked before anything else: one of the five verbs, a service and a
// version, and not one key more.
export function checkVerbRequest(input: unknown): Verdict<VerbRequest> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'A workload request is {verb, service, version}.' };
  const r = input as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !['verb', 'service', 'version'].includes(k));
  if (extra.length) return { ok: false, reason: `A workload request carries only a verb, a service and a version; ${extra.map((k) => JSON.stringify(k)).join(', ')} isn’t taken. What runs, with which arguments and on which port, is in the manifest the hub signed.` };
  if (typeof r.verb !== 'string' || !(WORKLOAD_VERBS as readonly string[]).includes(r.verb)) {
    return { ok: false, reason: `${JSON.stringify(r.verb ?? null)} isn’t one of the five things the device agent does with a workload (${WORKLOAD_VERBS.join(', ')}), so it was refused.` };
  }
  if (typeof r.service !== 'string' || !SERVICE.test(r.service)) return { ok: false, reason: 'service is a service’s name: lowercase letters, digits and dashes.' };
  if (typeof r.version !== 'string' || !VERSION.test(r.version)) return { ok: false, reason: 'version is letters, digits, dots, dashes or underscores.' };
  return { ok: true, value: { verb: r.verb as WorkloadVerb, service: r.service, version: r.version } };
}

// Why this command doesn't start one of the manifest's own files, or null when it does: the file
// itself (`name` or `./name`), or Nova's Node with the file as its script and nothing before it.
export function commandProblem(command: unknown, files: readonly string[]): string | null {
  if (!Array.isArray(command) || !command.length || !command.every((w) => typeof w === 'string' && w.length > 0 && w.length < 4096 && !w.includes('\0'))) return 'Its command isn’t a list of words.';
  const own = (w: string | undefined) => !!w && files.some((f) => w === f || w === `./${f}`);
  const [first, second] = command as string[];
  if (INTERPRETERS.has(first!)) return own(second) ? null : `With ${first}, the next word must be one of the manifest’s own files; it is ${JSON.stringify(second ?? '')}.`;
  return own(first) ? null : `Its command starts ${JSON.stringify(first)}, which isn’t one of the manifest’s own files: the device agent starts only what the hub signed.`;
}

const isCapture = (m: Pick<WorkloadManifest, 'capture' | 'os_permissions'>) => m.capture !== null || m.os_permissions.some((p) => CAPTURE_PERMISSIONS.includes(p));

// A signed workload, checked: a key this device pinned for signing (`pinned`) signed exactly this
// manifest, for this device and platform; its files are plain names pinned by SHA-256; its command
// starts one of them; this device's roles allow it. Pure: nothing is fetched or written.
export function verifyWorkload(input: unknown, o: { pinned: readonly string[]; deviceId: string; platform: string; purposes: readonly string[] | undefined; service?: string; version?: string }): Verdict<WorkloadManifest> {
  const s = input as Partial<SignedWorkload> | null;
  if (!s || typeof s !== 'object' || !s.manifest || typeof s.manifest !== 'object') return { ok: false, reason: 'The download isn’t a workload manifest.' };
  if (typeof s.signature !== 'string' || !s.signature || typeof s.signer !== 'string' || !s.signer) return { ok: false, reason: 'It isn’t signed: the device agent runs only workloads the hub signed.' };
  if (!o.pinned.includes(s.signer)) return { ok: false, reason: 'It was signed by a key this device didn’t pin.' };
  let ok = false;
  try { ok = verifyDeviceSignature(s.signer, workloadManifestMessage(s.manifest), s.signature); } catch { ok = false; }
  if (!ok) return { ok: false, reason: 'Its signature doesn’t match its manifest.' };
  const m = s.manifest;
  if (m.v !== 1) return { ok: false, reason: 'It is a manifest version this agent doesn’t know.' };
  if (o.service !== undefined && m.service !== o.service) return { ok: false, reason: `It is a manifest for ${m.service}, not ${o.service}.` };
  if (o.version !== undefined && m.version !== o.version) return { ok: false, reason: `It is a manifest for version ${m.version}, not ${o.version}.` };
  if (typeof m.service !== 'string' || !SERVICE.test(m.service) || typeof m.version !== 'string' || !VERSION.test(m.version)) return { ok: false, reason: 'Its service or version isn’t one Nova uses.' };
  if (m.device_id !== o.deviceId) return { ok: false, reason: 'It was signed for another device.' };
  if (m.platform !== o.platform) return { ok: false, reason: `It is for ${m.platform}, and this device is ${o.platform}.` };
  if (!m.files || typeof m.files !== 'object') return { ok: false, reason: 'It pins no files.' };
  const names = Object.keys(m.files);
  if (!names.length) return { ok: false, reason: 'It pins no files.' };
  for (const n of names) {
    if (!FILE.test(n) || RESERVED_FILES.has(n)) return { ok: false, reason: `It carries a file it shouldn’t (${n}).` };
    if (typeof m.files[n] !== 'string' || !SHA.test(m.files[n]!)) return { ok: false, reason: `${n} isn’t pinned by a SHA-256.` };
  }
  const why = commandProblem(m.command, names);
  if (why) return { ok: false, reason: why };
  if (!Array.isArray(m.ports) || !m.ports.every((p) => p && typeof p.name === 'string' && /^[a-z][a-z0-9-]{0,14}$/.test(p.name) && Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65_535)) return { ok: false, reason: 'Its ports aren’t ones Nova uses (named, 1024 to 65535).' };
  if (!m.health || typeof m.health.http !== 'string' || !HEALTH.test(m.health.http)) return { ok: false, reason: 'Its health check isn’t a path.' };
  if (!m.ports.length) return { ok: false, reason: 'Its health check needs a port, and it has none.' };
  if (!['full', 'shadow', 'copy', 'none'].includes(m.alongside)) return { ok: false, reason: 'Its alongside isn’t one Nova knows.' };
  if (!Array.isArray(m.roles) || !m.roles.every((r) => typeof r === 'string') || !Array.isArray(m.os_permissions) || !m.os_permissions.every((r) => typeof r === 'string')) return { ok: false, reason: 'Its roles or permissions aren’t lists.' };
  // A capture workload runs only on a capture source: the manifest must say so itself.
  if (isCapture(m) && !m.roles.includes('capture-source')) return { ok: false, reason: `${m.service} captures (it asks for ${m.os_permissions.join(', ') || 'capture'}), but isn’t placed by the capture-source role.` };
  if (m.capture !== null && (typeof m.capture !== 'object' || m.capture.adapter !== 'screenpipe' || !Array.isArray(m.capture.kinds))) return { ok: false, reason: 'Its capture adapter isn’t one this agent reads.' };
  // A capture workload never runs twice (the ADR: shadow only once two copies are shown to run side by
  // side on that OS): a copy alongside would capture too, outside what the carrier reads and forgets.
  if (isCapture(m) && m.alongside !== 'none') return { ok: false, reason: `${m.service} captures, so it can’t run next to its live version (alongside must be none).` };
  const roles = assignmentAllowed(o.purposes, { service: m.service, roles: m.roles });
  if (!roles.ok) return { ok: false, reason: roles.reason };
  return { ok: true, value: m };
}

export interface RunningView { version: string; role: 'live' | 'alongside' | 'shadow'; ports: Record<string, number>; since: string; failed: string | null }
export interface WorkloadState {
  service: string;
  live: string | null;
  previous: string | null;
  installed: string[];
  running: RunningView[];
  capture: boolean;
  capture_on: boolean;
}
// refused: it can't be done, however often it is asked (unsigned, a wrong hash, a role it doesn't hold);
// waiting: not now, for a reason that may pass (capture is off there; it starts at its switch).
export interface VerbResult { ok: boolean; said: string; refused?: boolean; waiting?: boolean; state: WorkloadState[] }

export interface WorkloadsOptions {
  home: string;
  deviceId: () => string;
  platform: string;
  // The keys a workload may be signed by (trust.ts bundleKeys: the hub's and the standby's).
  pinned: () => string[];
  purposes: () => string[] | undefined;
  // Over this agent's own session with the hub; never from the runtime.
  fetchManifest: (service: string, version: string) => Promise<unknown>;
  fetchFile: (service: string, version: string, name: string) => Promise<Buffer>;
  // Whether any capture source of this device is on (the hub's word, kept by the carrier).
  captureOn: () => boolean;
  // Boot's own record of the hub's grants; rechecked when queued verbs execute and before spawn.
  authorize?: (request: VerbRequest) => boolean;
  say?: (line: string) => void;
  // The user it runs as: never root (tests stand in for it).
  uid?: () => number | null;
  backoffMs?: number;
  probeTimeoutMs?: number;
}

interface Instance { service: string; version: string; role: RunningView['role']; ports: Record<string, number>; since: string; failed: string | null; watchdog: Watchdog<ChildLike> }
interface ServiceState { live: string | null; previous: string | null }

export class Workloads {
  readonly root: string;
  #o: WorkloadsOptions;
  #running = new Map<string, Instance>();
  #queues = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(o: WorkloadsOptions) {
    this.#o = o;
    this.root = join(o.home, 'workloads');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    this.#endLeftovers();
  }

  // A boot agent that was killed (not stopped) leaves its workloads' process groups running. The next
  // one ends them before it starts anything, so the runtime's decisions start from what is true. A pid
  // is ended only when its command line still names one of this home's slots (Linux: /proc), so a pid
  // reused by another program is left alone. Without /proc they are left (the plan's limits say so).
  #endLeftovers(): void {
    let names: string[] = [];
    try { names = readdirSync(this.root).filter((n) => SERVICE.test(n)); } catch { return; }
    for (const service of names) {
      const file = join(this.root, service, 'running.json');
      let pids: { pid: number; slot: string }[] = [];
      try { pids = JSON.parse(readFileSync(file, 'utf8')) as typeof pids; } catch { continue; }
      for (const r of Array.isArray(pids) ? pids : []) {
        if (!Number.isInteger(r.pid) || r.pid <= 1 || typeof r.slot !== 'string' || !r.slot.startsWith(this.root)) continue;
        let cmd = '';
        try { cmd = readFileSync(`/proc/${r.pid}/cmdline`, 'utf8'); } catch { continue; }
        if (!cmd.includes(r.slot)) continue;
        try { process.kill(-r.pid, 'SIGKILL'); } catch { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
        this.#say(`Ended ${service}’s process ${r.pid}, left running by an agent that stopped without ending it.`);
      }
      rmSync(file, { force: true });
    }
  }

  #recordPids(service: string): void {
    const list = [...this.#running.values()].filter((i) => i.service === service && i.watchdog.child?.pid).map((i) => ({ pid: i.watchdog.child!.pid!, slot: this.#slot(service, i.version) }));
    const file = join(this.root, service, 'running.json');
    try { writeFileSync(`${file}.tmp`, JSON.stringify(list), { mode: 0o600 }); renameSync(`${file}.tmp`, file); } catch { /* best effort */ }
  }

  // The roles this device holds changed: what they no longer allow stops now (its slot stays).
  async recheck(): Promise<string[]> {
    const stopped: string[] = [];
    for (const i of [...this.#running.values()]) {
      const v = this.#verifiedSlot(i.service, i.version);
      if (v.ok) continue;
      await this.#end(i);
      stopped.push(`${i.service} ${i.version}`);
      this.#say(`Stopped ${i.service} ${i.version}: ${v.reason}`);
    }
    return stopped;
  }

  // The one way in: a request is checked, then run, one at a time per service.
  async perform(input: unknown): Promise<VerbResult> {
    const c = checkVerbRequest(input);
    if (!c.ok) {
      this.#say(`Refused a workload request: ${c.reason}`);
      return { ok: false, refused: true, said: c.reason, state: this.state() };
    }
    const { verb, service, version } = c.value;
    const prev = this.#queues.get(service) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async (): Promise<VerbResult> => {
      if (this.#closed) return { ok: false, said: 'The device agent is stopping.', state: this.state() };
      if (this.#o.authorize && !this.#o.authorize(c.value)) return {
        ok: false, refused: true, said: 'The hub has not authorized this workload verb for that version. Installing a signed program does not promote it.', state: this.state(),
      };
      try {
        // Exactly these five, by name: there is no other way in.
        const r = verb === 'install' ? await this.#install(service, version)
          : verb === 'start' ? await this.#start(service, version)
          : verb === 'stop' ? await this.#stop(service, version)
          : verb === 'switch' ? await this.#switch(service, version)
          : await this.#probe(service, version);
        return { ...r, state: this.state() };
      } catch (e) {
        return { ok: false, said: `${verb} ${service} ${version} failed: ${(e as Error).message}`, state: this.state() };
      }
    });
    this.#queues.set(service, run);
    return run;
  }

  // What is installed and running, for the runtime's decisions and its heartbeat.
  state(): WorkloadState[] {
    const out: WorkloadState[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.root).filter((n) => SERVICE.test(n)).sort(); } catch { /* none yet */ }
    for (const service of names) {
      const st = this.#state(service);
      const installed = this.#installed(service);
      const manifest = st.live ? this.#manifest(service, st.live) : installed.length ? this.#manifest(service, installed[installed.length - 1]!) : null;
      out.push({
        service, live: st.live, previous: st.previous, installed,
        running: [...this.#running.values()].filter((i) => i.service === service).map((i) => ({ version: i.version, role: i.role, ports: i.ports, since: i.since, failed: i.failed })),
        capture: manifest ? isCapture(manifest) : false, capture_on: this.#o.captureOn(),
      });
    }
    return out;
  }

  // The capture kinds an installed capture workload offers, as heartbeat capabilities.
  captureCapabilities(): string[] {
    const kinds = new Set<string>();
    for (const s of this.state()) {
      const v = s.live ?? s.installed[s.installed.length - 1];
      const m = v ? this.#manifest(s.service, v) : null;
      for (const k of m?.capture?.kinds ?? []) kinds.add(`capture.${k}`);
    }
    return [...kinds].sort();
  }

  // Where the live capture workload answers, for the carrier: the live copy only, never one started
  // alongside or as a shadow (a shadow's output is never read).
  liveCapture(): { service: string; version: string; port: number; kinds: string[] } | null {
    for (const i of this.#running.values()) {
      if (i.role !== 'live' || i.failed) continue;
      const m = this.#manifest(i.service, i.version);
      if (!m?.capture) continue;
      const port = i.ports[m.ports[0]!.name];
      if (port) return { service: i.service, version: i.version, port, kinds: [...m.capture.kinds] };
    }
    return null;
  }

  // Capture was turned off on this device: every capture workload stops (its slot stays).
  async stopCapture(why: string): Promise<string[]> {
    const stopped: string[] = [];
    for (const i of [...this.#running.values()]) {
      const m = this.#manifest(i.service, i.version);
      if (!m || !isCapture(m)) continue;
      await this.#end(i);
      stopped.push(`${i.service} ${i.version}`);
    }
    if (stopped.length) this.#say(`Stopped ${stopped.join(', ')}: ${why}`);
    return stopped;
  }

  // Nothing starts once closed: a verb in progress (a switch, say) finishes first, then everything ends.
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#queues.values()]);
    await Promise.all([...this.#running.values()].map((i) => this.#end(i)));
  }

  // ---- the five ------------------------------------------------------------------------------------

  async #install(service: string, version: string): Promise<Omit<VerbResult, 'state'>> {
    const have = this.#verifiedSlot(service, version);
    if (have.ok) return { ok: true, said: `${service} ${version} is installed already, checked.` };
    let signed: unknown;
    try { signed = await this.#o.fetchManifest(service, version); } catch (e) { return { ok: false, said: `Couldn’t fetch the manifest of ${service} ${version}: ${(e as Error).message}` }; }
    const v = verifyWorkload(signed, this.#verifyOptions(service, version));
    if (!v.ok) return this.#refuse(service, version, v.reason);
    const m = v.value;
    const slot = this.#slot(service, version);
    const next = `${slot}.next`;
    rmSync(next, { recursive: true, force: true });
    mkdirSync(next, { recursive: true, mode: 0o700 });
    for (const [name, sha] of Object.entries(m.files)) {
      let bytes: Buffer;
      try { bytes = await this.#o.fetchFile(service, version, name); } catch (e) { rmSync(next, { recursive: true, force: true }); return { ok: false, said: `Couldn’t download ${name}: ${(e as Error).message}` }; }
      const got = sha256Hex(bytes);
      if (got !== sha) { rmSync(next, { recursive: true, force: true }); return this.#refuse(service, version, `${name} doesn’t match its hash (it is ${got.slice(0, 12)}…, the manifest pins ${sha.slice(0, 12)}…). Nothing was installed.`); }
      // Exactly the bytes that were pinned: never changed, never signed again by Nova.
      writeFileSync(join(next, name), bytes, { mode: 0o700 });
    }
    writeFileSync(join(next, 'manifest.json'), `${JSON.stringify(signed)}\n`, { mode: 0o600 });
    rmSync(slot, { recursive: true, force: true });
    mkdirSync(join(this.root, service, 'v'), { recursive: true, mode: 0o700 });
    renameSync(next, slot);
    this.#prune(service, version);
    this.#say(`Installed ${service} ${version}, signed by the hub; every file matches its pinned hash.`);
    return { ok: true, said: `Installed ${service} ${version}: signed by the hub, every file as pinned.` };
  }

  async #start(service: string, version: string, as?: RunningView['role']): Promise<Omit<VerbResult, 'state'>> {
    const key = `${service}@${version}`;
    const running = this.#running.get(key);
    if (running && !running.failed) return { ok: true, said: `${service} ${version} is running already.` };
    if (running) await this.#end(running);
    const v = this.#verifiedSlot(service, version);
    if (!v.ok) return this.#refuse(service, version, v.reason);
    const m = v.value;
    const st = this.#state(service);
    const role: RunningView['role'] = as ?? (st.live === version ? 'live' : m.alongside === 'shadow' ? 'shadow' : m.alongside === 'full' ? 'alongside' : 'live');
    if (!as && role === 'live' && st.live !== version) return { ok: false, waiting: true, said: `${service} ${version} can’t run next to the live version (alongside: ${m.alongside}): it starts when it is switched to.` };
    if ((this.#o.uid?.() ?? process.getuid?.() ?? null) === 0) return this.#refuse(service, version, 'This agent is running as root, and it never runs a workload as root. Run it as your own user.');
    if (isCapture(m) && !this.#o.captureOn()) return { ok: false, waiting: true, said: `${service} ${version} wasn’t started: capture is off on this device. Deploying it didn’t turn capture on; turning on one of its capture sources on the hub does.` };
    const ports: Record<string, number> = {};
    for (const p of m.ports) ports[p.name] = role === 'live' ? p.port : await freePort();
    const dir = join(this.root, service);
    const state = role === 'live' ? join(dir, 'data') : join(dir, 'scratch', version);
    if (role !== 'live') rmSync(state, { recursive: true, force: true });
    for (const d of [state, join(dir, 'home')]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const slot = this.#slot(service, version);
    const [first, ...rest] = m.command;
    const file = INTERPRETERS.has(first!) ? process.execPath : join(slot, first!.replace(/^\.\//, ''));
    const args = INTERPRETERS.has(first!) ? [join(slot, rest[0]!.replace(/^\.\//, '')), ...rest.slice(1)] : rest;
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin', HOME: join(dir, 'home'), TMPDIR: join(dir, 'home'), TZ: process.env.TZ ?? 'UTC', LANG: 'C.UTF-8',
      NOVA_SERVICE: service, NOVA_SERVICE_VERSION: version, NOVA_SERVICE_STATE: state,
      PORT: String(ports[m.ports[0]!.name]),
      ...Object.fromEntries(m.ports.map((p) => [`NOVA_PORT_${p.name.toUpperCase().replace(/-/g, '_')}`, String(ports[p.name])])),
      ...(role === 'shadow' ? { NOVA_SHADOW: '1' } : {}),
    };
    // Closing (shut down, revoked) while this verb waited: nothing new starts.
    if (this.#closed) return { ok: false, said: 'The device agent is stopping, so nothing new starts.' };
    if (this.#o.authorize && !this.#o.authorize({ verb: role === 'live' ? 'switch' : 'start', service, version })) return this.#refuse(service, version, 'The hub has not authorized this workload to start in that role.');
    const inst: Instance = {
      service, version, role, ports, since: new Date().toISOString(), failed: null,
      watchdog: new Watchdog<ChildLike>({
        start: () => group(spawn(file, args, { cwd: slot, env, stdio: 'ignore', detached: true }), (e) => { inst.failed = `It couldn’t be started: ${e.message}`; this.#say(`${service} ${version}: ${inst.failed}`); }),
        backoffMs: this.#o.backoffMs ?? 500, maxBackoffMs: 30_000,
      }),
    };
    inst.watchdog.on('safe_mode', () => { inst.failed = 'It stopped three times in a minute, so the device agent stopped trying.'; this.#say(`${service} ${version}: ${inst.failed}`); });
    inst.watchdog.on('start', () => this.#recordPids(service));
    this.#running.set(key, inst);
    inst.watchdog.run();
    this.#say(`Started ${service} ${version}${role === 'live' ? '' : ` ${role === 'shadow' ? 'as a shadow (its output is never read)' : 'alongside the live version'}`} on 127.0.0.1:${env.PORT}.`);
    return { ok: true, said: `Started ${service} ${version} (${role}).` };
  }

  async #stop(service: string, version: string): Promise<Omit<VerbResult, 'state'>> {
    const i = this.#running.get(`${service}@${version}`);
    if (!i) return { ok: true, said: `${service} ${version} isn’t running.` };
    await this.#end(i);
    return { ok: true, said: `Stopped ${service} ${version}.` };
  }

  async #switch(service: string, version: string): Promise<Omit<VerbResult, 'state'>> {
    const v = this.#verifiedSlot(service, version);
    if (!v.ok) return this.#refuse(service, version, v.reason);
    const st = this.#state(service);
    const old = st.live;
    if (old === version) {
      const running = this.#running.get(`${service}@${version}`);
      return running && !running.failed ? { ok: true, said: `${service} ${version} is live already.` } : this.#start(service, version, 'live');
    }
    // The copy that ran alongside (or as a shadow) stops: the live one runs on the stable ports.
    const along = this.#running.get(`${service}@${version}`);
    if (along) await this.#end(along);
    const was = old ? this.#running.get(`${service}@${old}`) : undefined;
    if (was) await this.#end(was);
    const back = old && st.previous === version;
    this.#setState(service, { live: version, previous: old });
    const started = await this.#start(service, version, 'live');
    if (!started.ok && !started.waiting) {
      // It didn't start at all: the old one goes back, as it was.
      this.#setState(service, st);
      if (old) await this.#start(service, old, 'live');
      return { ok: false, said: `${service} ${version} didn’t start, so ${old ?? 'nothing'} stays live: ${started.said}` };
    }
    const kept = old ? ` ${old} is kept, stopped, for one step back.` : '';
    return { ok: true, said: `${back ? 'Went back to' : 'Switched to'} ${service} ${version}${back ? ' from the kept slot: nothing was downloaded' : ''}.${kept}${started.ok ? '' : ` ${started.said}`}` };
  }

  async #probe(service: string, version: string): Promise<Omit<VerbResult, 'state'>> {
    const i = this.#running.get(`${service}@${version}`);
    if (!i) return { ok: false, said: `${service} ${version} isn’t running, so it has no health to check.` };
    if (i.failed) return { ok: false, said: i.failed };
    const m = this.#manifest(service, version);
    if (!m) return { ok: false, said: `${service} ${version} has no manifest.` };
    const port = i.ports[m.ports[0]!.name];
    try {
      const r = await fetch(`http://127.0.0.1:${port}${m.health.http}`, { signal: AbortSignal.timeout(this.#o.probeTimeoutMs ?? 2000) });
      await r.arrayBuffer().catch(() => {});
      return r.ok ? { ok: true, said: `${service} ${version} answered its health check.` } : { ok: false, said: `${service} ${version} answered its health check with ${r.status}.` };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return { ok: false, said: `${service} ${version} didn’t answer its health check (${cause ?? (e as Error).message}).` };
    }
  }

  // ---- internals ------------------------------------------------------------------------------------

  #verifyOptions(service: string, version: string) {
    return { pinned: this.#o.pinned(), deviceId: this.#o.deviceId(), platform: this.#o.platform, purposes: this.#o.purposes(), service, version };
  }

  // The slot as installed, checked again: the manifest's signature with the keys pinned now, this
  // device's roles now, and every file's hash. Run before every start and switch.
  #verifiedSlot(service: string, version: string): Verdict<WorkloadManifest> {
    const slot = this.#slot(service, version);
    if (!existsSync(join(slot, 'manifest.json'))) return { ok: false, reason: `${service} ${version} isn’t installed.` };
    let signed: unknown;
    try { signed = JSON.parse(readFileSync(join(slot, 'manifest.json'), 'utf8')); } catch { return { ok: false, reason: `${service} ${version}’s manifest can’t be read.` }; }
    const v = verifyWorkload(signed, this.#verifyOptions(service, version));
    if (!v.ok) return v;
    for (const [name, sha] of Object.entries(v.value.files)) {
      let got = '';
      try { got = sha256Hex(readFileSync(join(slot, name))); } catch { return { ok: false, reason: `${name} is missing from ${service} ${version}’s slot.` }; }
      if (got !== sha) return { ok: false, reason: `${name} in ${service} ${version}’s slot changed after it was installed (its hash no longer matches), so it wasn’t run.` };
    }
    return v;
  }

  #refuse(service: string, version: string, reason: string): Omit<VerbResult, 'state'> {
    this.#say(`Refused ${service} ${version}: ${reason}`);
    return { ok: false, refused: true, said: `Refused ${service} ${version}: ${reason}` };
  }

  #slot(service: string, version: string): string { return join(this.root, service, 'v', version); }

  #manifest(service: string, version: string): WorkloadManifest | null {
    try { return (JSON.parse(readFileSync(join(this.#slot(service, version), 'manifest.json'), 'utf8')) as SignedWorkload).manifest; } catch { return null; }
  }

  #installed(service: string): string[] {
    try { return readdirSync(join(this.root, service, 'v')).filter((v) => VERSION.test(v) && existsSync(join(this.#slot(service, v), 'manifest.json'))).sort(); } catch { return []; }
  }

  #state(service: string): ServiceState {
    try {
      const s = JSON.parse(readFileSync(join(this.root, service, 'state.json'), 'utf8')) as ServiceState;
      return { live: typeof s.live === 'string' ? s.live : null, previous: typeof s.previous === 'string' ? s.previous : null };
    } catch { return { live: null, previous: null }; }
  }

  #setState(service: string, s: ServiceState): void {
    const file = join(this.root, service, 'state.json');
    mkdirSync(join(this.root, service), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(s)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  // Slots kept: the live version, the one kept for one step back, and the one just installed.
  #prune(service: string, keep: string): void {
    const st = this.#state(service);
    const running = new Set([...this.#running.values()].filter((i) => i.service === service).map((i) => i.version));
    for (const v of this.#installed(service)) {
      if (v === keep || v === st.live || v === st.previous || running.has(v)) continue;
      rmSync(this.#slot(service, v), { recursive: true, force: true });
    }
  }

  async #end(i: Instance): Promise<void> {
    this.#running.delete(`${i.service}@${i.version}`);
    await i.watchdog.stop('SIGTERM', 3000);
    this.#recordPids(i.service);
    // A copy that ran alongside or as a shadow leaves nothing behind (for capture: nothing it captured).
    if (i.role !== 'live') rmSync(join(this.root, i.service, 'scratch', i.version), { recursive: true, force: true });
  }

  #say(line: string): void { this.#o.say?.(line); }
}

// A child in its own process group: stopping it stops everything it started.
function group(c: ChildProcess, failed: (e: Error) => void): ChildLike {
  // A program that can't be started at all (gone, not executable) says so here, never as a crash
  // of this agent.
  c.on('error', failed);
  return {
    get pid() { return c.pid; },
    on: (event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void) => c.on(event, fn),
    kill: (signal?: NodeJS.Signals) => {
      try { if (c.pid) { process.kill(-c.pid, signal ?? 'SIGTERM'); return true; } } catch { /* the group is gone */ }
      return c.kill(signal);
    },
  };
}

// A port on 127.0.0.1 nothing is using now, for a copy started alongside.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

// This device's platform as a definition names it. NOVA_DEVICE_PLATFORM is a stand-in for tests
// (a Linux test machine standing in for a Mac or a Windows computer).
export function devicePlatformKey(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.NOVA_DEVICE_PLATFORM;
  return s && /^(linux|darwin|win32)-(x64|arm64)$/.test(s) ? s : `${process.platform}-${process.arch}`;
}
