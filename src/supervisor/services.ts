// The supervisor driver (docs/plans/M10-orchestration.md, Point 1; docs/plans/M10e.md): the
// supervisor, generalised from one child to many. The console is one service (`nova-console`) and
// keeps its own deploy path: the supervisor's tests, sandbox on a copy of the home, smoke probes,
// switch, canary and rollback, unchanged. Every other service is a plain program kept running by the
// console's own rules: a crash, or failed health, is restarted after a wait that doubles; three
// within a minute and it is held; health is polled.
//
// A version of a service is a slot, <dir>/services/<service>/versions/<version>/: its definition and,
// in bin/, its program, installed once from a file: address and checked by SHA-256. Slots are never
// edited: a new version is a new slot. What runs is the pinned program and nothing else (the
// definition's command rule, definition.ts), checked again at every start: a regular file in the
// slot, with the pinned SHA-256. The stages (ADR Point 4), each at its tier:
//   apply   installed and started alongside the live version on loopback ports of its own, with no
//           traffic (tier 1); its contract tests and health, three passes in a row. A version that
//           fails them is never offered, and its slot is removed.
//   switch  the stable ports (forwarders on 127.0.0.1 owned by the supervisor) are pointed at it,
//           then a canary window of health probes. Nothing the live version serves is touched until
//           the new one has started and passed; any failure points them back (tier 1), and says so
//           truthfully: if the old version doesn't start again either, the service is held.
//           Then the old version is stopped and its slot kept for the soak; failed health or a
//           crash loop in that time goes back in one step (tier 1), with nothing installed. After the
//           soak the old slot is removed and the record says so.
//   rollback  the kept version again, in one step.
//   recover   a held service's live version started again, on the person's word.
// One change to a service at a time: every change, restart and soak end waits its turn in the
// service's queue, so none is refused or dropped for running into another.
//
// Services get none of the supervisor's environment: their own PATH, a HOME of their own, and the
// ports they were given (PORT, and NOVA_PORT_<NAME> per named port). Each runs as the leader of its
// own process group, ended whole with it. A supervisor killed outright leaves them running; the next
// one ends them, knowing each process by its pid and start time (Linux). A process that leaves its
// group (setsid) is outside all of this.
import { createHash } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSOLE, commandProblem, platformKey, programName, promotionTier, type ProgramArtifact, type ServiceDefinition, type ServiceDriver, type ServiceOutcome, type ServicePlan, type ServicePlanStep, type ServiceSay, type ServiceStatus, type ServiceVersionStatus, type ServiceVersionView, type SupervisorProblem } from '../core/index.ts';
import { CrashWindow } from './crashes.ts';
import { bootId, hasProc, same, stat, type ProcId } from './procs.ts';
import { ServerProcess } from './server.ts';

type Say = ServiceSay;
type Outcome = ServiceOutcome;
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVICE = /^[a-z][a-z0-9-]{0,52}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Health must pass this many times in a row before a version is offered.
export const HEALTH_PASSES = 3;
// The largest program installed: anything bigger is refused before it is read.
export const MAX_PROGRAM_BYTES = 256 * 1024 * 1024;
// The longest wait one timer can hold (setTimeout's limit is 2^31 - 1 ms); longer ones are chained.
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface DriverTimings {
  backoffMs: number;
  maxBackoffMs: number;
  crashes: number;
  windowMs: number;
  healthFailures: number;
  readyMs: number;
  canaryMs: number;
  probeEveryMs: number;
  // Set: every service is checked this often, whatever its definition says (tests).
  healthEveryMs?: number;
  // Set: the longest single timer (tests of long soaks).
  maxTimerMs?: number;
}

// What the driver asks of the supervisor for the console, whose deploy path is its own.
export interface ConsoleHooks {
  definition(): ServiceDefinition;
  status(): ServiceStatus;
  // Makes the release's slot from its tag (the console's alongside start is part of its deploy).
  prepare(version: string): Promise<Outcome>;
  deploy(version: string, say: Say): Promise<Outcome>;
  rollback(o: { auto: boolean; reason: string }, say: Say): Promise<Outcome>;
}

export interface SupervisorDriverOptions {
  dir: string;
  timings: DriverTimings;
  console: ConsoleHooks;
  problem: (p: SupervisorProblem) => void;
  log?: (line: string) => void;
  echo?: (s: string) => void;
  // This hub's device id, so a definition pinned to it runs here.
  hubId?: () => string | null;
  // The ports Nova uses itself (the console's, the device door's), from its configuration.
  reserved?: () => { port: number; what: string }[];
  changed?: () => void;
  platform?: string;
}

interface VersionRec { version: string; status: ServiceVersionStatus; since: string; said: string | null; sha256: string | null }
// A process the driver started, as a later supervisor can know it: the leader (its pid is the
// group's number) and the members seen in its group, each by pid and start time.
interface ProcRec { version: string; pgid: number; start: number | null; members: ProcId[] }
interface Rec {
  service: string;
  live: string | null;
  previous: string | null;
  soak_until: string | null;
  held: { reason: string; at: string } | null;
  health: { ok: boolean | null; checked_at: string | null; said: string | null };
  versions: VersionRec[];
  history: { at: string; version: string; outcome: string; said: string }[];
  // What was running when this was written, and on which boot.
  procs?: ProcRec[];
  boot?: string | null;
}
interface Instance { service: string; version: string; proc: ServerProcess; ports: Record<string, number>; state: string; members: ProcId[]; watched?: boolean }
interface Runtime {
  live: Instance | null;
  alongside: Instance | null;
  // The stable ports, by number.
  forwarders: Map<number, Forwarder>;
  crashes: CrashWindow;
  failing: number;
  checking: boolean;
  busy: boolean;
  queue: Promise<unknown>;
  healthTimer: ReturnType<typeof setInterval> | null;
  healthEvery: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  soakTimer: ReturnType<typeof setTimeout> | null;
}

export class SupervisorDriver implements ServiceDriver {
  readonly name = 'supervisor';
  readonly o: SupervisorDriverOptions;
  readonly file: string;
  #recs = new Map<string, Rec>();
  #rt = new Map<string, Runtime>();
  // Every instance running now, from the moment it is spawned.
  #running = new Set<Instance>();
  #closed = false;

  constructor(o: SupervisorDriverOptions) {
    this.o = o;
    this.file = join(o.dir, 'services.json');
    mkdirSync(join(o.dir, 'services'), { recursive: true, mode: 0o700 });
    this.#load();
  }

  available(): Outcome {
    return { ok: true, said: 'The supervisor runs services as plain programs on this hub. It needs nothing else.' };
  }

  // ---- the plan ------------------------------------------------------------------------------------

  plan(def: ServiceDefinition): ServicePlan {
    const tier = promotionTier(def);
    const base = { driver: this.name, service: def.service, version: def.version, tier, where: 'this hub' };
    if (def.service === CONSOLE) return { ...base, ok: true, refused: [], steps: consoleSteps(def) };
    const refused: string[] = [];
    const plat = this.o.platform ?? platformKey();
    const prog = def.artifact.program?.[plat];
    if (!prog) {
      refused.push(def.artifact.program
        ? `It has no program for this computer (${plat}).`
        : 'It comes only as a container image. The supervisor driver runs plain programs; running container services under the supervisor isn’t built yet.');
    } else if (!prog.url.startsWith('file://')) refused.push('Its program is at a web address. The supervisor driver installs programs from a file on this computer (file:); downloading signed programs comes with native workloads.');
    // What runs is the pinned program and nothing else, checked here too, whoever hands the driver
    // a definition.
    if (prog) {
      const name = programName(prog.url);
      const why = name ? commandProblem(prog.command, name) : 'Its program’s address names no file Nova would install.';
      if (why) refused.push(why);
    }
    if (def.secrets.length) refused.push('It needs secrets. Handing vault secrets to a service the supervisor runs isn’t built yet.');
    const pl = def.placement;
    const hub = this.o.hubId?.() ?? null;
    if (pl.mode === 'pinned' && pl.device !== 'hub' && pl.device !== hub) refused.push(`It is pinned to ${pl.device}. The supervisor driver runs services on this hub; other devices come with device roles and native workloads.`);
    if (pl.mode === 'floating' && (pl.replicas ?? 1) > 1) refused.push(`It asks for ${pl.replicas} replicas, one per device, and this hub is the only device that can run it now.`);
    const mem = def.resources?.memory_mb;
    if (mem !== undefined && mem * 1024 * 1024 > totalmem()) refused.push(`It needs ${mem} MB of memory, more than this computer has (${Math.round(totalmem() / 1024 / 1024)} MB).`);
    const reserved = this.o.reserved?.() ?? [];
    for (const p of def.ports) {
      const mine = reserved.find((r) => r.port === p.port);
      if (mine) refused.push(`Its port ${p.port} (${p.name}) is ${mine.what}.`);
      const other = [...this.#recs.values()].find((r) => r.service !== def.service && r.live && this.#def(r.service, r.live)?.ports.some((q) => q.port === p.port));
      if (other) refused.push(`Its port ${p.port} (${p.name}) is ${other.service}’s.`);
    }
    if (refused.length) return { ...base, ok: false, refused: [...new Set(refused)], steps: [] };
    const command = this.#argv(def, prog!);
    const tests = def.contract_tests.map((t) => `GET ${t.slice('http:'.length)}`);
    const stable = def.ports.map((p) => `${p.name} 127.0.0.1:${p.port}`).join(', ');
    const steps: ServicePlanStep[] = [
      { step: 'install', said: `Copy ${programName(prog!.url)} from its file: address into a slot of its own for ${def.version}, checking its SHA-256 (${prog!.sha256.slice(0, 12)}…). Nothing is downloaded.` },
      { step: 'alongside', said: `${ALONGSIDE_WORDS[def.alongside]} It runs exactly: ${command ? command.map((w) => JSON.stringify(w)).join(' ') : '(nothing: its command is refused)'}` },
      { step: 'tests', said: tests.length ? `Contract tests on its own port: ${tests.join(', ')}, each answering 2xx${def.alongside === 'none' ? ', run once it has started at the switch' : ''}.` : 'It has no contract tests.' },
      { step: 'health', said: `GET ${def.health.http} answers 2xx ${HEALTH_PASSES} times in a row.` },
      { step: 'approval', said: tier === 3 ? 'Promotion is confirmed every time (tier 3).' : 'Promotion asks first (tier 2).' },
      { step: 'canary', said: `Point the stable port${def.ports.length === 1 ? '' : 's'} (${stable}) at it, then watch its health. A failure points ${def.ports.length === 1 ? 'it' : 'them'} back by itself.` },
      { step: 'promote', said: `Stop the old version and keep its slot ${def.soak_s === undefined ? 'until the next promotion' : `for ${def.soak_s} s`}. A failure in that time goes back in one step, with nothing installed.` },
    ];
    return { ...base, ok: true, refused: [], steps, ...(command ? { command } : {}) };
  }

  // The argv the supervisor runs: the pinned program in the slot, alone or as Nova's Node's script.
  #argv(def: ServiceDefinition, prog: ProgramArtifact): string[] | null {
    const name = programName(prog.url);
    if (!name) return null;
    const exe = join(this.#slot(def.service, def.version), 'bin', name);
    const [first, ...rest] = prog.command;
    if (first === 'node') return [process.execPath, exe, ...rest.slice(1)];
    return [exe, ...rest];
  }

  // ---- apply: installed and started alongside, never given traffic -------------------------------

  async apply(def: ServiceDefinition, say: Say = () => {}): Promise<Outcome> {
    const plan = this.plan(def);
    if (!plan.ok) return { ok: false, said: plan.refused.join(' ') };
    if (def.service === CONSOLE) {
      const r = await this.o.console.prepare(def.version);
      say(`${r.ok ? '✓' : '✗'} prepare: ${r.said}`);
      return r;
    }
    return this.#exclusive(def.service, async (rec, rt) => {
      if (rec.live === def.version) return { ok: false, said: `${def.service} ${def.version} is already live.` };
      if (rec.previous === def.version) return { ok: false, said: `${def.service} ${def.version} is the version kept to go back to: roll back to it instead.` };
      const step = (name: string, ok: boolean, said: string) => { say(`${ok ? '✓' : '✗'} ${name}: ${said}`); this.#say(`${def.service} ${def.version} · ${name}: ${said}`); };
      const fail = async (name: string, said: string, inst: Instance | null): Promise<Outcome> => {
        step(name, false, said);
        if (inst) await this.#stopInstance(inst);
        if (rt.alongside === inst) rt.alongside = null;
        // A version that never passed was never offered: its slot goes, so its name can be used again.
        if (name !== 'install') this.#removeSlot(rec, def.version, said, 'failed');
        else this.#version(rec, def.version, 'failed', said);
        this.#history(rec, def.version, 'stopped', said);
        this.o.problem({ source: 'supervisor', playbook: 'service-stopped', subject: `${def.service}@${def.version}`, said: `${def.service} ${def.version} didn’t pass its ${name === 'tests' ? 'contract tests' : name}, so it was never offered. ${rec.live ? `${rec.live} keeps running.` : 'Nothing else changed.'}`, detail: said });
        return { ok: false, said: `Stopped at ${name}: ${said}` };
      };
      // Install: the slot, made once and checked to be exactly this definition and program.
      const inst = await this.#install(def);
      if (!inst.ok) return fail('install', inst.said, null);
      this.#version(rec, def.version, 'installed', inst.said, inst.sha256);
      step('install', true, inst.said);
      // A version already started alongside is replaced by this run.
      if (rt.alongside) { const a = rt.alongside; rt.alongside = null; await this.#stopInstance(a); }
      if (def.alongside === 'none') {
        this.#version(rec, def.version, 'ready', 'It can’t run twice: it starts at the switch, where its contract tests and health run before it is kept.');
        step('alongside', true, 'It can’t run next to the live version, so it starts only at the switch.');
        return { ok: true, said: `${def.service} ${def.version} is installed and ready to promote; its checks run at the switch.` };
      }
      const state = def.alongside === 'full' ? this.#stateDir(def) : this.#scratchState(def);
      const started = await this.#startInstance(def, state);
      if (!started.ok) return fail('alongside', started.said, null);
      rt.alongside = started.inst;
      this.#watch(def.service, started.inst);
      this.#version(rec, def.version, 'alongside', `Running next to the live version on port ${Object.values(started.inst.ports).join(', ')}, with no traffic.`);
      step('alongside', true, `Started on ${Object.entries(started.inst.ports).map(([n, p]) => `${n} ${p}`).join(', ')} (${def.alongside}), with no traffic.`);
      const tests = await this.#contract(def, started.inst);
      if (!tests.ok) return fail('tests', tests.said, started.inst);
      step('tests', true, tests.said);
      const health = await this.#healthPasses(def, started.inst);
      if (!health.ok) return fail('health', health.said, started.inst);
      step('health', true, health.said);
      // Run on a copy of its state, it stops now: at the switch it starts on the real one.
      if (def.alongside !== 'full') { rt.alongside = null; await this.#stopInstance(started.inst); }
      this.#version(rec, def.version, 'ready', `Passed its contract tests and health${def.alongside === 'full' ? ', and is running alongside with no traffic' : ''}.`);
      this.#history(rec, def.version, 'ready', 'Passed its contract tests and health. It waits for promotion.');
      return { ok: true, said: `${def.service} ${def.version} passed its contract tests and health, and is ready to promote.` };
    }, true);
  }

  // ---- switch: traffic moves, a canary, then the soak --------------------------------------------

  async switch(service: string, version: string, say: Say = () => {}): Promise<Outcome> {
    if (service === CONSOLE) return this.o.console.deploy(version, say);
    return this.#exclusive(service, async (rec, rt) => {
      const def = this.#def(service, version);
      const v = rec.versions.find((x) => x.version === version);
      // Only a version that passed is ever offered, whoever asks.
      if (!def || v?.status !== 'ready') return { ok: false, said: `${service} ${version} isn’t ready to promote: only a version that passed its contract tests and health takes traffic.` };
      const from = rec.live;
      const fromDef = from ? this.#def(service, from) : null;
      const step = (name: string, ok: boolean, said: string) => { say(`${ok ? '✓' : '✗'} ${name}: ${said}`); this.#say(`${service} ${version} · ${name}: ${said}`); };
      // New stable port numbers are opened first, pointing nowhere: one held by something else stops
      // the switch before anything moves. Numbers the live version uses are left as they are.
      const opened: number[] = [];
      for (const p of def.ports) {
        if (rt.forwarders.has(p.port)) continue;
        const f = new Forwarder(p.port);
        const r = await f.listen();
        if (!r.ok) {
          for (const n of opened) { await rt.forwarders.get(n)?.close(); rt.forwarders.delete(n); }
          step('switch', false, r.said);
          return { ok: false, said: `${r.said} Nothing moved.` };
        }
        rt.forwarders.set(p.port, f);
        opened.push(p.port);
      }
      const back = (stage: string, said: string, next: Instance | null) => this.#backFromSwitch(rec, rt, { version, from, fromDef, old, next, opened, stage, said, say: step });
      // One writer: a version that can't run twice, or ran on a copy, starts once the old one stops.
      const oneWriter = def.alongside !== 'full';
      let next = rt.alongside && rt.alongside.version === version && rt.alongside.proc.alive ? rt.alongside : null;
      if (rt.alongside && rt.alongside !== next) await this.#stopInstance(rt.alongside);
      rt.alongside = null;
      const old = rt.live;
      if (oneWriter && old) {
        rt.live = null;
        this.#point(rt, fromDef, null);
        await this.#stopInstance(old);
      }
      if (!next) {
        const started = await this.#startInstance(def, this.#stateDir(def));
        if (!started.ok) return back('switch', `${version} didn’t start: ${started.said}`, null);
        next = started.inst;
      }
      if (def.alongside === 'none') {
        const tests = await this.#contract(def, next);
        const health = tests.ok ? await this.#healthPasses(def, next) : tests;
        if (!health.ok) return back('tests', `${version} didn’t pass its checks at the switch: ${health.said}`, next);
      }
      // Traffic moves.
      rt.live = next;
      this.#watch(service, next);
      this.#point(rt, def, next);
      rec.live = version;
      rec.held = null;
      this.#version(rec, version, 'live', 'Taking traffic: its canary window is running.');
      step('switch', true, `The stable port${def.ports.length === 1 ? '' : 's'} now point${def.ports.length === 1 ? 's' : ''} at ${version}.`);
      // The canary: health on the new version, probe by probe, at least two.
      const until = Date.now() + this.o.timings.canaryMs;
      let n = 0;
      while (Date.now() < until || n < 2) {
        await sleep(this.o.timings.probeEveryMs);
        n++;
        const h = next.proc.alive ? await this.#health(def, next) : { ok: false, said: `It stopped: ${next.proc.tail(5) || 'no last words'}` };
        if (!h.ok) return back('canary', `Its health failed in the canary window: ${h.said}`, next);
      }
      step('canary', true, `${n} probes over ${Math.round(this.o.timings.canaryMs / 1000)} s, all healthy.`);
      // Promoted: the old version stops, its slot kept for the soak. A version kept from before goes.
      if (old && old !== next && old.proc.alive) await this.#stopInstance(old);
      for (const [num, f] of rt.forwarders) if (!def.ports.some((p) => p.port === num)) { await f.close(); rt.forwarders.delete(num); }
      if (rec.previous && rec.previous !== from && rec.previous !== version) this.#removeSlot(rec, rec.previous, `Replaced by ${from} as the version kept to go back to.`);
      rec.previous = from;
      this.#clearSoak(rt);
      rec.soak_until = from && def.soak_s !== undefined ? new Date(Date.now() + def.soak_s * 1000).toISOString() : null;
      if (from) this.#version(rec, from, 'kept', rec.soak_until ? `Kept, stopped, until ${rec.soak_until}, to go back to in one step.` : 'Kept, stopped, until the next promotion, to go back to in one step.');
      this.#armSoak(service);
      rt.crashes.reset();
      rt.failing = 0;
      this.#version(rec, version, 'live', 'Live.');
      this.#history(rec, version, 'promoted', `Passed its canary.${from ? ` ${from} is kept ${rec.soak_until ? `until ${rec.soak_until}` : 'until the next promotion'}.` : ''}`);
      step('promote', true, `${version} is live${from ? `; ${from} is kept to go back to` : ''}.`);
      return { ok: true, said: `${service} ${version} is live.` };
    });
  }

  // A switch that failed, at any stage, puts back what the live version had: its process (still
  // running, or started again from its slot) and its stable ports. What it says is what is true: if
  // the old version doesn't start again, the service is held, with a problem, and it says so.
  async #backFromSwitch(rec: Rec, rt: Runtime, o: { version: string; from: string | null; fromDef: ServiceDefinition | null; old: Instance | null; next: Instance | null; opened: number[]; stage: string; said: string; say: (name: string, ok: boolean, said: string) => void }): Promise<Outcome> {
    const service = rec.service;
    o.say(o.stage, false, o.said);
    if (o.next) { if (rt.live === o.next) rt.live = null; await this.#stopInstance(o.next); }
    // Ports only the new version asked for are closed again.
    for (const n of o.opened) if (!o.fromDef?.ports.some((p) => p.port === n)) { await rt.forwarders.get(n)?.close(); rt.forwarders.delete(n); }
    const failed: ServiceVersionStatus = o.stage === 'canary' ? 'rolled_back' : 'failed';
    this.#version(rec, o.version, failed, o.said);
    this.#history(rec, o.version, o.stage === 'canary' ? 'rolled back' : 'stopped', o.said);
    let outcome: string;
    let ok = false;
    if (!o.from || !o.fromDef) {
      this.#point(rt, null, null);
      for (const [n, f] of rt.forwarders) { await f.close(); rt.forwarders.delete(n); }
      rec.live = null;
      outcome = 'Nothing else was running.';
      ok = true;
    } else if (o.old?.proc.alive) {
      rt.live = o.old;
      this.#point(rt, o.fromDef, o.old);
      rec.live = o.from;
      outcome = `${o.from} kept running and answers on its stable port${o.fromDef.ports.length === 1 ? '' : 's'}.`;
      ok = true;
    } else {
      rec.live = o.from;
      const r = await this.#restore(rec, rt, o.fromDef);
      if (r.ok) { outcome = `${o.from} is running again and answers on its stable port${o.fromDef.ports.length === 1 ? '' : 's'}.`; ok = true; }
      else {
        outcome = `${o.from} didn’t start again either (${r.said}), so nothing serves ${service}: it is held.`;
        this.#hold(rec, rt, `After ${o.version} failed at the switch, ${o.from} didn’t start again: ${r.said}`, '');
      }
    }
    const auto = o.stage === 'canary';
    this.o.problem({
      source: 'supervisor', playbook: auto ? 'service-rolled-back' : 'service-stopped', subject: `${service}@${o.version}`,
      said: `${service} ${o.version} ${auto ? 'was rolled back by itself: its health failed in the canary window' : `didn’t pass the switch (${o.stage})`}. ${outcome}`, detail: o.said,
    });
    o.say('rollback', ok, outcome);
    return { ok: false, said: `${auto ? 'Rolled back' : `Stopped at ${o.stage}`}: ${o.said} ${outcome}` };
  }

  // ---- rollback: the kept version, in one step --------------------------------------------------------

  async rollback(service: string, o: { auto: boolean; reason: string }, say: Say = () => {}): Promise<Outcome> {
    if (service === CONSOLE) return this.o.console.rollback(o, say);
    return this.#exclusive(service, (rec, rt) => this.#rollback(rec, rt, o, say));
  }

  async #rollback(rec: Rec, rt: Runtime, o: { auto: boolean; reason: string }, say: Say = () => {}): Promise<Outcome> {
    const service = rec.service;
    // The soak's end can't take the kept slot from under a rollback.
    this.#clearSoak(rt);
    const cur = rec.live;
    const target = rec.previous;
    const def = target ? this.#def(service, target) : null;
    if (!target || !def) { this.#armSoak(service); return { ok: false, said: `${service} has no previous version kept to go back to.` }; }
    if (rt.live) { const l = rt.live; rt.live = null; await this.#stopInstance(l); }
    rec.live = target;
    const back = await this.#restore(rec, rt, def);
    if (!back.ok) {
      const reason = `Going back to ${target} didn’t start it either: ${back.said}`;
      rec.previous = null;
      rec.soak_until = null;
      if (cur) this.#version(rec, cur, 'rolled_back', o.reason);
      this.#hold(rec, rt, reason, '');
      say(`✗ rollback: ${reason}`);
      return { ok: false, said: `${reason} Nothing serves ${service}: it is held.` };
    }
    for (const [num, f] of rt.forwarders) if (!def.ports.some((p) => p.port === num)) { await f.close(); rt.forwarders.delete(num); }
    rec.previous = null;
    rec.soak_until = null;
    rt.crashes.reset();
    if (cur) this.#version(rec, cur, 'rolled_back', o.reason);
    this.#version(rec, target, 'live', 'Live again.');
    this.#history(rec, target, o.auto ? 'rolled back' : 'went back', `${o.reason}${cur ? ` (from ${cur})` : ''}`);
    say(`✓ rollback: ${target} is running again.`);
    this.#say(`${service}: back to ${target} (${o.reason})`);
    if (o.auto) this.o.problem({ source: 'supervisor', playbook: 'service-rolled-back', subject: `${service}@${cur}`, said: `${service} ${cur} was rolled back by itself: ${o.reason} ${target} is running again, from the slot kept for it.`, detail: o.reason });
    return { ok: true, said: `${o.auto ? `Rolled back: ${o.reason} ` : ''}${service} ${target} is running again.` };
  }

  // ---- recover: a held service started again, on the person's word -----------------------------------

  // Tier 1: it starts the version that was approved and live, nothing new; the person asked for it.
  async recover(service: string, say: Say = () => {}): Promise<Outcome> {
    if (service === CONSOLE) return { ok: false, said: 'The console recovers with node src/supervisor/main.ts recover.' };
    return this.#exclusive(service, async (rec, rt) => {
      if (!rec.live) return { ok: false, said: `${service} has no live version to start again: deploy and promote one.` };
      if (rt.live?.proc.alive && !rec.held) return { ok: false, said: `${service} ${rec.live} is running.` };
      const def = this.#def(service, rec.live);
      if (!def) return { ok: false, said: `The slot for ${service} ${rec.live} isn’t there, so it can’t start.` };
      if (rt.restartTimer) { clearTimeout(rt.restartTimer); rt.restartTimer = null; }
      if (rt.live) { const l = rt.live; rt.live = null; await this.#stopInstance(l); }
      rt.crashes.reset();
      const r = await this.#restore(rec, rt, def);
      if (!r.ok) { this.#hold(rec, rt, `It didn’t start when asked to recover: ${r.said}`, ''); say(`✗ recover: ${r.said}`); return { ok: false, said: `${service} ${rec.live} didn’t start: ${r.said} It is still held.` }; }
      rec.held = null;
      this.#version(rec, rec.live, 'live', 'Live again, recovered.');
      this.#history(rec, rec.live, 'recovered', 'Started again on the person’s word.');
      this.#armSoak(service);
      say(`✓ recover: ${rec.live} is running again.`);
      return { ok: true, said: `${service} ${rec.live} is running again.` };
    });
  }

  // The live version started from its slot and given the stable ports. Not ok when it doesn't start,
  // or a stable port can't be had: then nothing of it is left running.
  async #restore(rec: Rec, rt: Runtime, def: ServiceDefinition): Promise<Outcome> {
    const started = await this.#startInstance(def, this.#stateDir(def));
    if (!started.ok) return { ok: false, said: started.said };
    for (const p of def.ports) {
      if (rt.forwarders.has(p.port)) continue;
      const f = new Forwarder(p.port);
      const r = await f.listen();
      if (!r.ok) { await this.#stopInstance(started.inst); return { ok: false, said: r.said }; }
      rt.forwarders.set(p.port, f);
    }
    rt.live = started.inst;
    this.#point(rt, def, started.inst);
    rec.live = def.version;
    rec.held = null;
    rt.failing = 0;
    this.#watch(rec.service, started.inst);
    return { ok: true, said: `${def.version} is running.` };
  }

  // Points the stable ports `def` names at `inst` (null: at nothing, so connections are refused).
  #point(rt: Runtime, def: ServiceDefinition | null, inst: Instance | null): void {
    if (!def) { for (const f of rt.forwarders.values()) f.target = null; return; }
    for (const p of def.ports) { const f = rt.forwarders.get(p.port); if (f) f.target = inst?.ports[p.name] ?? null; }
  }

  // ---- status ------------------------------------------------------------------------------------------

  status(service?: string): ServiceStatus[] {
    const out: ServiceStatus[] = [];
    if (!service || service === CONSOLE) out.push(this.o.console.status());
    for (const rec of this.#recs.values()) {
      if (service && rec.service !== service) continue;
      const rt = this.#rt.get(rec.service);
      const running = new Map<string, Instance>();
      if (rt?.live) running.set(rt.live.version, rt.live);
      if (rt?.alongside) running.set(rt.alongside.version, rt.alongside);
      const stable: Record<string, number> = {};
      const liveDef = rec.live ? this.#def(rec.service, rec.live) : null;
      for (const p of liveDef?.ports ?? []) if (rt?.forwarders.has(p.port)) stable[p.name] = p.port;
      const versions: ServiceVersionView[] = rec.versions.map((v) => {
        const i = running.get(v.version);
        return { version: v.version, status: v.status, since: v.since, said: v.said, ports: i && i.proc.alive ? i.ports : null, pid: i && i.proc.alive ? i.proc.pid : null };
      });
      out.push({ service: rec.service, driver: this.name, live: rec.live, previous: rec.previous, soak_until: rec.soak_until, held: rec.held, health: rec.health, stable, versions, history: rec.history });
    }
    return out;
  }

  // ---- running ----------------------------------------------------------------------------------------

  // After the supervisor starts: what a killed supervisor left is ended, then every live service that
  // isn't held runs again, and soaks go on.
  async resume(): Promise<void> {
    for (const rec of this.#recs.values()) this.#endLeftovers(rec);
    for (const rec of this.#recs.values()) {
      if (!rec.live || rec.held) continue;
      await this.#exclusive(rec.service, async (r, rt) => {
        const def = this.#def(r.service, r.live!);
        if (!def) { this.#hold(r, rt, `The slot for ${r.live} is missing, so it can’t start.`, ''); return { ok: false, said: 'missing' }; }
        const out = await this.#restore(r, rt, def);
        if (!out.ok) { this.#hold(r, rt, `It didn’t start with the supervisor: ${out.said}`, ''); return out; }
        this.#armSoak(r.service);
        return out;
      });
    }
    this.#save();
  }

  async close(): Promise<void> {
    this.#closed = true;
    // What is running finishes its turn (a canary, say), then everything stops.
    await Promise.all([...this.#rt.values()].map((rt) => rt.queue));
    for (const rt of this.#rt.values()) {
      if (rt.healthTimer) clearInterval(rt.healthTimer);
      if (rt.restartTimer) clearTimeout(rt.restartTimer);
      this.#clearSoak(rt);
      rt.live = null;
      rt.alongside = null;
      for (const f of rt.forwarders.values()) await f.close();
      rt.forwarders.clear();
    }
    for (const i of [...this.#running]) await this.#stopInstance(i);
    this.#save();
  }

  // The pids of every process the driver runs now (for checks that none is left behind).
  pids(): number[] {
    return [...this.#running].flatMap((i) => (i.proc.pid && i.proc.alive ? [i.proc.pid] : []));
  }

  // Watches an instance: it is a crash only if it was live (or alongside, ready to promote) when it
  // stopped, and a crash is never dropped: it is counted at once and dealt with in the service's turn.
  #watch(service: string, inst: Instance): void {
    if (this.#runtime(service).live === inst) this.#armHealth(service, inst.version);
    if (inst.watched) return;
    inst.watched = true;
    inst.proc.once('exit', (e: { code: number | null; signal: string | null; expected: boolean }) => {
      this.#running.delete(inst);
      this.#save();
      const rt = this.#rt.get(service);
      if (e.expected || this.#closed || !rt) return;
      const how = e.signal ? `was stopped by ${e.signal}` : `exited with code ${e.code}`;
      if (rt.alongside === inst) {
        rt.alongside = null;
        void this.#exclusive(service, async (rec) => {
          const v = rec.versions.find((x) => x.version === inst.version);
          if (v?.status === 'ready') {
            const said = `It stopped by itself while running alongside (it ${how}), so it is no longer offered. Deploy it again to try once more.`;
            this.#removeSlot(rec, inst.version, said, 'failed');
            this.o.problem({ source: 'supervisor', playbook: 'service-stopped', subject: `${service}@${inst.version}`, said: `${service} ${inst.version} stopped by itself while running alongside, so it is no longer offered. ${rec.live ? `${rec.live} keeps running.` : ''}`.trim(), detail: inst.proc.tail(15) });
          }
          return { ok: true, said: '' };
        });
        return;
      }
      if (rt.live !== inst) return;
      rt.live = null;
      // Nothing answers on the stable ports while it is down: connections are refused, not hung.
      for (const f of rt.forwarders.values()) f.target = null;
      rt.crashes.record();
      void this.#exclusive(service, (rec, rt2) => this.#afterCrash(rec, rt2, inst, how));
    });
  }

  // The health loop runs at the live version's own interval.
  #armHealth(service: string, version: string): void {
    const rt = this.#runtime(service);
    const def = this.#def(service, version);
    const every = this.o.timings.healthEveryMs ?? (def ? def.health.every_s * 1000 : 30_000);
    if (rt.healthTimer && rt.healthEvery === every) return;
    if (rt.healthTimer) clearInterval(rt.healthTimer);
    rt.healthEvery = every;
    rt.healthTimer = setInterval(() => { void this.#healthCheck(service); }, every);
    rt.healthTimer.unref?.();
  }

  async #afterCrash(rec: Rec, rt: Runtime, inst: Instance, how: string): Promise<Outcome> {
    // Something else already started a version, or it was held or went back meanwhile.
    if (rt.live || rec.held || rec.live !== inst.version) return { ok: true, said: '' };
    await inst.proc.stop(0);
    const service = rec.service;
    if (rt.crashes.tooMany) {
      const reason = `${service} ${rec.live} stopped ${rt.crashes.count} times within ${Math.round(this.o.timings.windowMs / 1000)} s (the last time it ${how})`;
      // In its soak, a crash loop goes back to the kept version in one step.
      if (rec.previous) return this.#rollback(rec, rt, { auto: true, reason: `${reason}.` });
      this.#hold(rec, rt, `${reason}, so the supervisor stopped restarting it.`, inst.proc.tail(15));
      return { ok: false, said: 'held' };
    }
    const wait = rt.crashes.wait();
    this.#say(`${service} ${how}. Starting it again in ${(wait / 1000).toFixed(1)} s.`);
    this.o.problem({ source: 'supervisor', playbook: 'service-crashed', subject: service, said: `${service} stopped unexpectedly (it ${how}) and the supervisor started it again.`, detail: inst.proc.tail(15), repairs: [{ name: 'restart-service', ok: true, said: `Started again after ${(wait / 1000).toFixed(1)} s.` }] });
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      void this.#exclusive(service, (r, t) => this.#restartLive(r, t, null, 'It didn’t start again'));
    }, wait);
    return { ok: true, said: '' };
  }

  // The live version started again (after a crash, or failed health): in the service's turn, and only
  // if nothing changed meanwhile.
  async #restartLive(rec: Rec, rt: Runtime, inst: Instance | null, failWords: string): Promise<Outcome> {
    if (this.#closed || rec.held || !rec.live) return { ok: true, said: '' };
    if (inst ? rt.live !== inst : rt.live) return { ok: true, said: '' };
    if (rt.live) { const l = rt.live; rt.live = null; await this.#stopInstance(l, 3000); }
    const def = this.#def(rec.service, rec.live);
    if (!def) { this.#hold(rec, rt, `${failWords}: its slot is missing.`, ''); return { ok: false, said: 'missing' }; }
    const r = await this.#restore(rec, rt, def);
    if (!r.ok) this.#hold(rec, rt, `${failWords}: ${r.said}`, '');
    return r;
  }

  #hold(rec: Rec, rt: Runtime, reason: string, output: string): void {
    rec.held = { reason, at: nowIso() };
    for (const f of rt.forwarders.values()) f.target = null;
    this.#history(rec, rec.live ?? '-', 'held', reason);
    this.#say(`${rec.service} is held: ${reason}`);
    this.o.problem({ source: 'supervisor', playbook: 'service-held', subject: rec.service, said: `${rec.service} is held: ${reason}`, detail: output });
    this.#save();
  }

  async #healthCheck(service: string): Promise<void> {
    const rec = this.#recs.get(service);
    const rt = this.#rt.get(service);
    if (!rec || !rt || rt.busy || rt.checking || this.#closed || !rt.live || !rec.live || rec.held) return;
    const def = this.#def(service, rec.live);
    if (!def) return;
    const inst = rt.live;
    rt.checking = true;
    let h: Outcome;
    try { h = await this.#health(def, inst); } finally { rt.checking = false; }
    // Who is in its group now, for a later supervisor.
    inst.members = inst.proc.groupMembers();
    rec.health = { ok: h.ok, checked_at: nowIso(), said: h.said };
    if (h.ok) { rt.failing = 0; this.#save(); return; }
    rt.failing++;
    if (rt.failing < this.o.timings.healthFailures || rt.busy || rt.live !== inst) { this.#save(); return; }
    const n = rt.failing;
    rt.failing = 0;
    // A restart for failed health counts toward holding, like a crash.
    rt.crashes.record();
    void this.#exclusive(service, async (r, t) => {
      if (t.live !== inst) return { ok: true, said: '' };
      // In its soak, failed health goes back to the kept version in one step (tier 1).
      if (r.previous) return this.#rollback(r, t, { auto: true, reason: `${service} ${r.live} failed ${n} health checks in a row during its soak (${h.said}).` });
      if (t.crashes.tooMany) {
        t.live = null;
        await this.#stopInstance(inst, 3000);
        this.#hold(r, t, `${service} ${r.live} was restarted or stopped ${t.crashes.count} times within ${Math.round(this.o.timings.windowMs / 1000)} s (the last time for ${n} failed health checks in a row: ${h.said}), so the supervisor stopped restarting it.`, '');
        return { ok: false, said: 'held' };
      }
      this.#say(`${service} hasn’t answered ${n} health checks in a row. Restarting it.`);
      const out = await this.#restartLive(r, t, inst, 'It stopped answering and didn’t start again');
      this.o.problem({ source: 'supervisor', playbook: 'service-crashed', subject: service, said: `${service} stopped answering its health checks (${n} in a row), so the supervisor restarted it.`, detail: h.said, repairs: [{ name: 'restart-service', ok: out.ok, said: out.said }] });
      return out;
    });
  }

  // ---- the soak ---------------------------------------------------------------------------------------

  // The soak's end, in the service's turn. A wait longer than one timer holds is chained.
  #armSoak(service: string): void {
    const rec = this.#recs.get(service)!;
    const rt = this.#runtime(service);
    this.#clearSoak(rt);
    if (!rec.previous || !rec.soak_until) return;
    const kept = rec.previous;
    const until = Date.parse(rec.soak_until);
    const max = this.o.timings.maxTimerMs ?? MAX_TIMER_MS;
    // In the service's turn: a rollback (or a new promotion) that got there first has ended this
    // soak already, and the kept slot is left alone.
    const end = () => {
      rt.soakTimer = null;
      if (this.#closed) return;
      void this.#exclusive(service, async (r) => {
        if (r.previous !== kept) return { ok: true, said: '' };
        r.previous = null;
        r.soak_until = null;
        this.#removeSlot(r, kept, `Its soak ended with ${r.live} healthy, so its slot was removed.`);
        this.#history(r, r.live ?? kept, 'soaked', `${r.live} passed its soak; ${kept} was removed.`);
        return { ok: true, said: '' };
      });
    };
    // A wait longer than one timer holds is a chain of timers.
    const arm = () => {
      const left = until - Date.now();
      if (left > max) rt.soakTimer = setTimeout(() => { rt.soakTimer = null; if (!this.#closed) arm(); }, max);
      else rt.soakTimer = setTimeout(end, Math.max(0, left));
    };
    arm();
  }

  #clearSoak(rt: Runtime): void {
    if (rt.soakTimer) clearTimeout(rt.soakTimer);
    rt.soakTimer = null;
  }

  #removeSlot(rec: Rec, version: string, said: string, status: ServiceVersionStatus = 'removed'): void {
    rmSync(this.#slot(rec.service, version), { recursive: true, force: true });
    rmSync(join(this.o.dir, 'services', rec.service, 'scratch', version), { recursive: true, force: true });
    this.#version(rec, version, status, said);
  }

  // ---- instances ---------------------------------------------------------------------------------------

  // A port found free can be taken by another program before the service binds it: a start that
  // ends at once is tried again on new ports, twice at most.
  async #startInstance(def: ServiceDefinition, state: string): Promise<{ ok: true; inst: Instance } | { ok: false; said: string }> {
    let r = await this.#startOnce(def, state);
    for (let i = 0; i < 2 && !r.ok && r.early; i++) r = await this.#startOnce(def, state);
    return r.ok ? r : { ok: false, said: r.said };
  }

  async #startOnce(def: ServiceDefinition, state: string): Promise<{ ok: true; inst: Instance } | { ok: false; said: string; early?: boolean }> {
    const prog = def.artifact.program?.[this.o.platform ?? platformKey()];
    if (!prog) return { ok: false, said: 'It has no program for this computer.' };
    const slot = this.#slot(def.service, def.version);
    if (!existsSync(join(slot, 'definition.json'))) return { ok: false, said: `Its slot isn’t there (${def.version}).` };
    const argv = this.#argv(def, prog);
    if (!argv) return { ok: false, said: 'Its command is refused.' };
    // What runs is the pinned program: a regular file in this slot, with the pinned SHA-256.
    const exe = join(slot, 'bin', programName(prog.url)!);
    const check = await this.#verify(exe, join(slot, 'bin'), prog.sha256);
    if (!check.ok) return { ok: false, said: `${check.said} It wasn’t started.` };
    const ports: Record<string, number> = {};
    for (const p of def.ports) ports[p.name] = await freePort();
    const home = join(this.o.dir, 'services', def.service, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, TZ: process.env.TZ ?? 'UTC', LANG: process.env.LANG ?? 'C.UTF-8',
      NOVA_SERVICE: def.service, NOVA_SERVICE_VERSION: def.version, NOVA_SERVICE_STATE: state,
    };
    const first = def.ports[0];
    if (first) env.PORT = String(ports[first.name]);
    for (const p of def.ports) env[`NOVA_PORT_${p.name.toUpperCase().replace(/-/g, '_')}`] = String(ports[p.name]);
    const proc = new ServerProcess({ root: join(slot, 'bin'), env, argv, group: true, echo: (s) => this.o.echo?.(`[${def.service} ${def.version}] ${s}`) });
    const inst: Instance = { service: def.service, version: def.version, proc, ports, state, members: [] };
    // Recorded the moment it exists, so a supervisor killed now still leaves a record of it.
    if (proc.pid) { this.#running.add(inst); proc.once('exit', () => { this.#running.delete(inst); }); this.#save(); }
    const end = Date.now() + this.o.timings.readyMs;
    while (Date.now() < end) {
      if (!proc.alive) { await proc.stop(0); return { ok: false, early: true, said: `It stopped as it started${proc.proc.exitCode !== null ? ` (code ${proc.proc.exitCode})` : ''}: ${proc.tail(5) || 'no last words'}` }; }
      if ((await this.#health(def, inst)).ok) {
        proc.markReady(first ? ports[first.name]! : 0);
        inst.members = proc.groupMembers();
        this.#save();
        return { ok: true, inst };
      }
      await sleep(100);
    }
    await this.#stopInstance(inst, 2000);
    return { ok: false, said: `Its health didn’t answer within ${Math.round(this.o.timings.readyMs / 1000)} s: ${proc.tail(5) || 'no output'}` };
  }

  // The file is a regular file (not a link, a pipe or a device), inside `dir` once every link is
  // resolved, and its bytes are the pinned ones.
  async #verify(file: string, dir: string, sha256: string): Promise<Outcome> {
    try {
      const st = await lstat(file);
      if (!st.isFile()) return { ok: false, said: 'The installed program isn’t a regular file any more.' };
      const [real, root] = await Promise.all([realpath(file), realpath(dir)]);
      if (!real.startsWith(`${root}/`)) return { ok: false, said: 'The installed program is outside its slot.' };
      const sha = createHash('sha256').update(await readFile(file)).digest('hex');
      if (sha !== sha256) return { ok: false, said: `The installed program’s SHA-256 is ${sha.slice(0, 12)}…, not the pinned ${sha256.slice(0, 12)}…: it was changed.` };
      return { ok: true, said: 'verified' };
    } catch (e) {
      return { ok: false, said: `The installed program can’t be checked: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}.` };
    }
  }

  async #stopInstance(inst: Instance, graceMs = 5000): Promise<void> {
    await inst.proc.stop(graceMs);
    this.#running.delete(inst);
  }

  async #health(def: ServiceDefinition, inst: Instance): Promise<Outcome> {
    const port = def.ports[0] ? inst.ports[def.ports[0].name] : undefined;
    if (!port) return { ok: false, said: 'It has no port to check.' };
    return get(port, def.health.http);
  }

  async #healthPasses(def: ServiceDefinition, inst: Instance): Promise<Outcome> {
    for (let i = 1; i <= HEALTH_PASSES; i++) {
      if (!inst.proc.alive) return { ok: false, said: `It stopped: ${inst.proc.tail(5) || 'no last words'}` };
      const h = await this.#health(def, inst);
      if (!h.ok) return { ok: false, said: `Health check ${i} of ${HEALTH_PASSES} failed: ${h.said}` };
      if (i < HEALTH_PASSES) await sleep(Math.min(this.o.timings.probeEveryMs, 1000));
    }
    return { ok: true, said: `GET ${def.health.http} answered ${HEALTH_PASSES} times in a row.` };
  }

  async #contract(def: ServiceDefinition, inst: Instance): Promise<Outcome> {
    const port = def.ports[0] ? inst.ports[def.ports[0].name] : undefined;
    if (!def.contract_tests.length) return { ok: true, said: 'It has no contract tests.' };
    if (!port) return { ok: false, said: 'It has no port to test.' };
    const failed: string[] = [];
    for (const t of def.contract_tests) {
      const r = await get(port, t.slice('http:'.length));
      if (!r.ok) failed.push(`${t}: ${r.said}`);
    }
    return failed.length ? { ok: false, said: failed.join('; ') } : { ok: true, said: `${def.contract_tests.length} passed: ${def.contract_tests.join(', ')}.` };
  }

  // ---- slots ---------------------------------------------------------------------------------------------

  #slot(service: string, version: string): string {
    if (!SERVICE.test(service) || !VERSION.test(version)) throw new Error(`${service} ${version} isn’t a service’s name and version.`);
    return join(this.o.dir, 'services', service, 'versions', version);
  }

  #stateDir(def: ServiceDefinition): string {
    return join(this.o.dir, 'services', def.service, 'state', def.state?.volume ?? 'default');
  }

  // A copy of its state, for a version run alongside on a copy (copy) or whose output is thrown away (shadow).
  #scratchState(def: ServiceDefinition): string {
    const dir = join(this.o.dir, 'services', def.service, 'scratch', def.version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const real = this.#stateDir(def);
    if (existsSync(real)) cpSync(real, dir, { recursive: true });
    return dir;
  }

  #def(service: string, version: string): ServiceDefinition | null {
    try { return JSON.parse(readFileSync(join(this.#slot(service, version), 'definition.json'), 'utf8')) as ServiceDefinition; } catch { return null; }
  }

  // The slot, made once: the program copied from its file: address and checked by SHA-256. A slot
  // that is there already must be exactly this definition and program, or nothing is installed. The
  // source must be a regular file (never a link, a pipe or a device) no bigger than the limit, and it
  // is read without holding up the supervisor.
  async #install(def: ServiceDefinition): Promise<{ ok: true; said: string; sha256: string } | { ok: false; said: string }> {
    const prog = def.artifact.program?.[this.o.platform ?? platformKey()];
    if (!prog) return { ok: false, said: 'It has no program for this computer.' };
    const name = programName(prog.url);
    if (!name) return { ok: false, said: 'Its program’s address names no file Nova would install.' };
    let src: string;
    try { src = fileURLToPath(prog.url); } catch { return { ok: false, said: `${prog.url} isn’t a file on this computer.` }; }
    let bytes: Buffer;
    let mode: number;
    try {
      const st = await lstat(src);
      if (!st.isFile()) return { ok: false, said: `Its program at ${prog.url} isn’t a regular file (a link, a pipe or a device is never installed).` };
      if (st.size > MAX_PROGRAM_BYTES) return { ok: false, said: `Its program is ${Math.round(st.size / 1024 / 1024)} MB, more than the ${MAX_PROGRAM_BYTES / 1024 / 1024} MB Nova installs.` };
      mode = st.mode;
      bytes = await readFile(src);
      if (bytes.length > MAX_PROGRAM_BYTES) return { ok: false, said: 'Its program grew past the limit while it was read.' };
    } catch (e) { return { ok: false, said: `Its program couldn’t be read at ${prog.url}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}.` }; }
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== prog.sha256) return { ok: false, said: `Its program’s SHA-256 is ${sha.slice(0, 12)}…, not the ${prog.sha256.slice(0, 12)}… its definition pins. Nothing was installed.` };
    const slot = this.#slot(def.service, def.version);
    const text = `${JSON.stringify(def, null, 2)}\n`;
    if (existsSync(slot)) {
      const same = readOr(join(slot, 'definition.json')) === text && (await this.#verify(join(slot, 'bin', name), join(slot, 'bin'), sha)).ok;
      if (same) return { ok: true, said: `Its slot for ${def.version} is there already, checked: the same definition and program.`, sha256: sha };
      return { ok: false, said: `${def.service} ${def.version} is installed already with a different definition or program. Slots are never changed: a new version is a new slot.` };
    }
    const tmp = `${slot}.part-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, 'bin'), { recursive: true, mode: 0o700 });
    await writeFile(join(tmp, 'bin', name), bytes, { mode: 0o600 });
    await chmod(join(tmp, 'bin', name), mode & 0o755);
    await writeFile(join(tmp, 'definition.json'), text, { mode: 0o600 });
    mkdirSync(join(slot, '..'), { recursive: true, mode: 0o700 });
    renameSync(tmp, slot);
    return { ok: true, said: `Installed ${name} (SHA-256 ${sha.slice(0, 12)}…, as pinned) in its slot for ${def.version}.`, sha256: sha };
  }

  // ---- records -------------------------------------------------------------------------------------------

  #runtime(service: string): Runtime {
    let rt = this.#rt.get(service);
    if (!rt) {
      rt = { live: null, alongside: null, forwarders: new Map(), crashes: new CrashWindow(this.o.timings), failing: 0, checking: false, busy: false, queue: Promise.resolve(), healthTimer: null, healthEvery: 0, restartTimer: null, soakTimer: null };
      this.#rt.set(service, rt);
    }
    return rt;
  }

  // One change to a service at a time: each waits its turn in the service's queue.
  async #exclusive(service: string, fn: (rec: Rec, rt: Runtime) => Promise<Outcome>, create = false): Promise<Outcome> {
    if (!SERVICE.test(service)) return { ok: false, said: `${service} isn’t a service’s name.` };
    if (!this.#recs.has(service) && !create) return { ok: false, said: `The supervisor runs no service named ${service}.` };
    const rt = this.#runtime(service);
    const run = rt.queue.then(async (): Promise<Outcome> => {
      if (this.#closed) return { ok: false, said: 'The supervisor is stopping.' };
      let rec = this.#recs.get(service);
      if (!rec) {
        rec = { service, live: null, previous: null, soak_until: null, held: null, health: { ok: null, checked_at: null, said: null }, versions: [], history: [] };
        this.#recs.set(service, rec);
      }
      rt.busy = true;
      try {
        return await fn(rec, rt);
      } catch (e) {
        return { ok: false, said: `It stopped: ${(e as Error).message}` };
      } finally {
        rt.busy = false;
        this.#save();
      }
    });
    rt.queue = run.catch(() => {});
    return run;
  }

  #version(rec: Rec, version: string, status: ServiceVersionStatus, said: string | null, sha256?: string): void {
    const i = rec.versions.findIndex((v) => v.version === version);
    const v: VersionRec = { version, status, since: nowIso(), said, sha256: sha256 ?? rec.versions[i]?.sha256 ?? null };
    if (i < 0) rec.versions.push(v);
    else rec.versions[i] = v;
    this.#save();
  }

  #history(rec: Rec, version: string, outcome: string, said: string): void {
    rec.history = [{ at: nowIso(), version, outcome, said }, ...rec.history].slice(0, 50);
  }

  #say(line: string): void {
    this.o.log?.(`[supervisor] ${line}\n`);
  }

  #load(): void {
    try {
      const all = JSON.parse(readFileSync(this.file, 'utf8')) as { v: number; services: Rec[] };
      if (all.v !== 1) return;
      for (const r of all.services ?? []) if (SERVICE.test(r.service)) this.#recs.set(r.service, r);
    } catch { /* none yet */ }
  }

  // A supervisor that was killed (not stopped) leaves its services running, each in its own process
  // group. Ended here, but only what is certainly still one of ours, on this same boot: a recorded
  // process whose pid and start time both still match. If the leader or any recorded member is
  // still there, the group's number is still that group's (it can't be reused while a member lives),
  // and the whole group is ended. Without /proc (not Linux), nothing can be told apart: it is left,
  // and said.
  #endLeftovers(rec: Rec): void {
    const boot = bootId();
    for (const p of rec.procs ?? []) {
      if (!Number.isInteger(p.pgid) || p.pgid <= 1 || !VERSION.test(p.version)) continue;
      if (!hasProc || !boot || rec.boot !== boot || p.start === null) {
        if (!hasProc) this.#say(`${rec.service} ${p.version} may still be running as process group ${p.pgid} from before; it wasn’t ended, as it can’t be told apart from another program here.`);
        continue;
      }
      const leader = same({ pid: p.pgid, start: p.start });
      const mates = (p.members ?? []).filter((m) => same(m));
      if (!leader && !mates.length) continue;
      if (leader || mates.some((m) => stat(m.pid)?.pgrp === p.pgid)) try { process.kill(-p.pgid, 'SIGKILL'); } catch { /* gone */ }
      for (const m of mates) if (same(m)) try { process.kill(m.pid, 'SIGKILL'); } catch { /* gone */ }
      this.#say(`${rec.service} ${p.version} (process group ${p.pgid}) was still running from a supervisor that stopped without ending it; it was ended.`);
    }
    rec.procs = [];
  }

  #save(): void {
    const boot = bootId();
    for (const rec of this.#recs.values()) {
      rec.boot = boot;
      rec.procs = [...this.#running].filter((i) => i.service === rec.service && i.proc.pid && i.proc.alive)
        .map((i) => ({ version: i.version, pgid: i.proc.pid!, start: i.proc.identity?.start ?? null, members: i.members }));
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, services: [...this.#recs.values()] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.o.changed?.();
  }

  // Every service the driver has a record of (its slots on disk, for checks).
  slots(service: string): string[] {
    const d = join(this.o.dir, 'services', service, 'versions');
    return existsSync(d) ? readdirSync(d).filter((v) => VERSION.test(v)) : [];
  }
}

const ALONGSIDE_WORDS: Record<ServiceDefinition['alongside'], string> = {
  full: 'Start it next to the live version, on loopback ports of its own, with no traffic (full); after the switch both run on the real state until the old one stops.',
  shadow: 'Start it next to the live version on a scratch copy of its state, thrown away after (shadow); at the switch the old one stops first, so only one ever runs on the real state.',
  copy: 'Start it on a copy of its state, with no traffic, then stop it: at the switch the old one stops first and it starts on the real state (copy).',
  none: 'It can’t run twice: it starts only at the switch, once the old version has stopped (none).',
};

function consoleSteps(def: ServiceDefinition): ServicePlanStep[] {
  return [
    { step: 'prepare', said: `A slot of Nova’s repository at the tag ${def.version}.` },
    { step: 'tests', said: 'The release’s own test suite, in its slot, with a scratch home.' },
    { step: 'sandbox', said: 'It starts on a copy of your home, with no work, no network peers and no secrets (copy).' },
    { step: 'smoke', said: 'The smoke probes, on the sandbox.' },
    { step: 'approval', said: 'Deploying changes Nova itself: confirmed every time, by typing the version (tier 3).' },
    { step: 'switch', said: 'A checkpoint of the stopped home, then it runs on your home.' },
    { step: 'canary', said: 'Health on the live home, probe by probe; a failure goes back by itself, with no data lost.' },
    { step: 'promote', said: 'The release before it is kept to go back to.' },
  ];
}

// A GET on loopback that must answer 2xx.
async function get(port: number, path: string): Promise<Outcome> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
    await r.body?.cancel().catch(() => {});
    return r.ok ? { ok: true, said: `${path} answered ${r.status}.` } : { ok: false, said: `${path} answered ${r.status}.` };
  } catch (e) {
    return { ok: false, said: `${path} didn’t answer: ${(e as Error).message}` };
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function readOr(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// The stable port: on 127.0.0.1, owned by the supervisor, carrying each connection to whichever
// version is live. Moving it is the switch. While nothing is live behind it (held, or between a
// crash and its restart), it still listens and closes each connection at once, so a client is told
// rather than left waiting. A client that half-closes (sends its request, then ends its side) still
// gets its answer: each side's end is passed on, and only an error (a reset) ends both at once.
export class Forwarder {
  readonly port: number;
  target: number | null = null;
  #server: Server | null = null;
  #sockets = new Set<Socket>();

  constructor(port: number) {
    this.port = port;
  }

  listen(): Promise<Outcome> {
    return new Promise((resolve) => {
      const s = createServer({ allowHalfOpen: true }, (client) => {
        const target = this.target;
        if (!target) { client.destroy(); return; }
        const up = connect({ port: target, host: '127.0.0.1', allowHalfOpen: true });
        for (const x of [client, up]) {
          this.#sockets.add(x);
          x.once('close', () => this.#sockets.delete(x));
          // A reset on either side ends the other at once.
          x.on('error', () => { client.destroy(); up.destroy(); });
        }
        client.pipe(up);
        up.pipe(client);
      });
      s.once('error', (e) => resolve({ ok: false, said: `Port ${this.port} on 127.0.0.1 can’t be used: ${(e as NodeJS.ErrnoException).code ?? e.message}. Something else holds it.` }));
      s.listen(this.port, '127.0.0.1', () => { this.#server = s; resolve({ ok: true, said: `Listening on 127.0.0.1:${this.port}.` }); });
    });
  }

  close(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    for (const x of this.#sockets) x.destroy();
    return new Promise((r) => (s ? s.close(() => r()) : r()));
  }
}
