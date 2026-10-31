// The supervisor driver (docs/plans/M10-orchestration.md, Point 1; docs/plans/M10e.md): the
// supervisor, generalised from one child to many. The console is one service (`nova-console`) and
// keeps its own deploy path: the supervisor's tests, sandbox on a copy of the home, smoke probes,
// switch, canary and rollback, unchanged. Every other service is a plain program kept running by the
// console's own rules: a crash is restarted after a wait that doubles, three within a minute and it
// is held; health is polled, and failed health restarts it.
//
// A version of a service is a slot, <dir>/services/<service>/<version>/: its definition and its
// program, installed once from a file: address and checked by SHA-256. Slots are never edited: a new
// version is a new slot. The stages (ADR Point 4), each at its tier:
//   apply   installed and started alongside the live version on loopback ports of its own, with no
//           traffic (tier 1); its contract tests and health, three passes in a row. A version that
//           fails them is never offered.
//   switch  the stable port (a forwarder on 127.0.0.1 owned by the supervisor) is pointed at it,
//           then a canary window of health probes. A failure points it back by itself (tier 1).
//           Then the old version is stopped and its slot kept for the soak; failed health or a crash
//           loop in that time goes back in one step (tier 1), with nothing installed or downloaded.
//           After the soak the old slot is removed and the record says so.
//   rollback  the kept version again, in one step.
// Services get none of the supervisor's environment: their own PATH, a HOME of their own, and the
// ports they were given (PORT, and NOVA_PORT_<NAME> per named port). Each runs as the leader of its
// own process group, and the whole group is ended with it.
import { createHash } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSOLE, platformKey, promotionTier, type ServiceDefinition, type ServiceDriver, type ServiceOutcome, type ServicePlan, type ServicePlanStep, type ServiceSay, type ServiceStatus, type ServiceVersionStatus, type ServiceVersionView, type SupervisorProblem } from '../core/index.ts';
import { CrashWindow } from './crashes.ts';
import { ServerProcess } from './server.ts';

type Say = ServiceSay;
type Outcome = ServiceOutcome;
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVICE = /^[a-z][a-z0-9-]{0,52}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Health must pass this many times in a row before a version is offered.
export const HEALTH_PASSES = 3;

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
  changed?: () => void;
  platform?: string;
}

interface VersionRec { version: string; status: ServiceVersionStatus; since: string; said: string | null; sha256: string | null }
interface Rec {
  service: string;
  live: string | null;
  previous: string | null;
  soak_until: string | null;
  held: { reason: string; at: string } | null;
  health: { ok: boolean | null; checked_at: string | null; said: string | null };
  versions: VersionRec[];
  history: { at: string; version: string; outcome: string; said: string }[];
  // The processes running for it when this was written: a supervisor that was killed leaves them,
  // and the next one ends them before it starts its own.
  procs?: { pid: number; version: string }[];
}
interface Instance { version: string; proc: ServerProcess; ports: Record<string, number>; state: string }
interface Runtime {
  live: Instance | null;
  alongside: Instance | null;
  forwarders: Map<string, Forwarder>;
  crashes: CrashWindow;
  failing: number;
  busy: boolean;
  healthTimer: ReturnType<typeof setInterval> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  soakTimer: ReturnType<typeof setTimeout> | null;
}

export class SupervisorDriver implements ServiceDriver {
  readonly name = 'supervisor';
  readonly o: SupervisorDriverOptions;
  readonly file: string;
  #recs = new Map<string, Rec>();
  #rt = new Map<string, Runtime>();
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
    if (def.secrets.length) refused.push('It needs secrets. Handing vault secrets to a service the supervisor runs isn’t built yet.');
    const pl = def.placement;
    const hub = this.o.hubId?.() ?? null;
    if (pl.mode === 'pinned' && pl.device !== 'hub' && pl.device !== hub) refused.push(`It is pinned to ${pl.device}. The supervisor driver runs services on this hub; other devices come with device roles and native workloads.`);
    if (pl.mode === 'floating' && (pl.replicas ?? 1) > 1) refused.push(`It asks for ${pl.replicas} replicas, one per device, and this hub is the only device that can run it now.`);
    const mem = def.resources?.memory_mb;
    if (mem !== undefined && mem * 1024 * 1024 > totalmem()) refused.push(`It needs ${mem} MB of memory, more than this computer has (${Math.round(totalmem() / 1024 / 1024)} MB).`);
    for (const p of def.ports) {
      const other = [...this.#recs.values()].find((r) => r.service !== def.service && r.live && this.#def(r.service, r.live)?.ports.some((q) => q.port === p.port));
      if (other) refused.push(`Its port ${p.port} (${p.name}) is ${other.service}’s.`);
    }
    if (refused.length) return { ...base, ok: false, refused, steps: [] };
    const tests = def.contract_tests.map((t) => `GET ${t.slice('http:'.length)}`);
    const stable = def.ports.map((p) => `${p.name} 127.0.0.1:${p.port}`).join(', ');
    const steps: ServicePlanStep[] = [
      { step: 'install', said: `Copy ${basename(fileURLToPath(prog!.url))} from its file: address into a slot of its own for ${def.version}, checking its SHA-256 (${prog!.sha256.slice(0, 12)}…). Nothing is downloaded.` },
      { step: 'alongside', said: ALONGSIDE_WORDS[def.alongside] },
      { step: 'tests', said: tests.length ? `Contract tests on its own port: ${tests.join(', ')}, each answering 2xx${def.alongside === 'none' ? ', run once it has started at the switch' : ''}.` : 'It has no contract tests.' },
      { step: 'health', said: `GET ${def.health.http} answers 2xx ${HEALTH_PASSES} times in a row.` },
      { step: 'approval', said: tier === 3 ? 'Promotion is confirmed every time (tier 3).' : 'Promotion asks first (tier 2).' },
      { step: 'canary', said: `Point the stable port${def.ports.length === 1 ? '' : 's'} (${stable}) at it, then watch its health. A failure points ${def.ports.length === 1 ? 'it' : 'them'} back by itself.` },
      { step: 'promote', said: `Stop the old version and keep its slot ${def.soak_s === undefined ? 'until the next promotion' : `for ${def.soak_s} s`}. A failure in that time goes back in one step, with nothing installed.` },
    ];
    return { ...base, ok: true, refused: [], steps };
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
      const step = (name: string, ok: boolean, said: string) => { say(`${ok ? '✓' : '✗'} ${name}: ${said}`); this.#say(`${def.service} ${def.version} · ${name}: ${said}`); };
      const fail = async (name: string, said: string, inst: Instance | null): Promise<Outcome> => {
        step(name, false, said);
        if (inst) await this.#stopInstance(inst);
        if (rt.alongside === inst) rt.alongside = null;
        this.#version(rec, def.version, 'failed', said);
        this.#history(rec, def.version, 'stopped', said);
        this.o.problem({ source: 'supervisor', playbook: 'service-stopped', subject: `${def.service}@${def.version}`, said: `${def.service} ${def.version} didn’t pass its ${name === 'tests' ? 'contract tests' : name}, so it was never offered. ${rec.live ? `${rec.live} keeps running.` : 'Nothing else changed.'}`, detail: said });
        return { ok: false, said: `Stopped at ${name}: ${said}` };
      };
      // Install: the slot, made once and checked to be exactly this definition and program.
      const inst = this.#install(def);
      if (!inst.ok) return fail('install', inst.said, null);
      this.#version(rec, def.version, 'installed', inst.said, inst.sha256);
      step('install', true, inst.said);
      // A version already started alongside is replaced by this run.
      if (rt.alongside) { await this.#stopInstance(rt.alongside); rt.alongside = null; }
      if (def.alongside === 'none') {
        this.#version(rec, def.version, 'ready', 'It can’t run twice: it starts at the switch, where its contract tests and health run before it is kept.');
        step('alongside', true, 'It can’t run next to the live version, so it starts only at the switch.');
        return { ok: true, said: `${def.service} ${def.version} is installed and ready to promote; its checks run at the switch.` };
      }
      const state = def.alongside === 'full' ? this.#stateDir(def) : this.#scratchState(def);
      const started = await this.#startInstance(def, state);
      if (!started.ok) return fail('alongside', started.said, null);
      rt.alongside = started.inst;
      this.#version(rec, def.version, 'alongside', `Running next to the live version on port ${Object.values(started.inst.ports).join(', ')}, with no traffic.`);
      step('alongside', true, `Started on ${Object.entries(started.inst.ports).map(([n, p]) => `${n} ${p}`).join(', ')} (${def.alongside}), with no traffic.`);
      const tests = await this.#contract(def, started.inst);
      if (!tests.ok) return fail('tests', tests.said, started.inst);
      step('tests', true, tests.said);
      const health = await this.#healthPasses(def, started.inst);
      if (!health.ok) return fail('health', health.said, started.inst);
      step('health', true, health.said);
      // Run on a copy of its state, it stops now: at the switch it starts on the real one.
      if (def.alongside !== 'full') { await this.#stopInstance(started.inst); rt.alongside = null; }
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
      // The stable ports first: one in use by something else stops the switch before anything moves.
      for (const p of def.ports) {
        const r = await this.#forwarder(rt, p.name, p.port);
        if (!r.ok) { step('switch', false, r.said); return { ok: false, said: r.said }; }
      }
      // One writer: a version that can't run twice, or ran on a copy, starts once the old one stops.
      const oneWriter = def.alongside === 'none' || def.alongside === 'copy';
      let next = rt.alongside && rt.alongside.version === version && rt.alongside.proc.alive ? rt.alongside : null;
      rt.alongside = null;
      const old = rt.live;
      if (oneWriter && old) { rt.live = null; await this.#stopInstance(old); }
      if (!next) {
        const started = await this.#startInstance(def, this.#stateDir(def));
        if (!started.ok) {
          step('switch', false, started.said);
          if (oneWriter && old && fromDef) await this.#restore(rec, rt, fromDef);
          this.#version(rec, version, 'failed', started.said);
          return { ok: false, said: `${version} didn’t start: ${started.said} ${from ? `${from} is running again.` : ''}`.trim() };
        }
        next = started.inst;
      }
      if (def.alongside === 'none') {
        const tests = await this.#contract(def, next);
        const health = tests.ok ? await this.#healthPasses(def, next) : tests;
        if (!health.ok) {
          step('tests', false, health.said);
          await this.#stopInstance(next);
          if (old && fromDef) await this.#restore(rec, rt, fromDef);
          this.#version(rec, version, 'failed', health.said);
          this.o.problem({ source: 'supervisor', playbook: 'service-stopped', subject: `${service}@${version}`, said: `${service} ${version} didn’t pass its checks at the switch, so ${from ?? 'nothing'} ${from ? 'is running again' : 'runs'}.`, detail: health.said });
          return { ok: false, said: `Stopped at tests: ${health.said}` };
        }
      }
      // Traffic moves.
      for (const p of def.ports) rt.forwarders.get(p.name)!.target = next.ports[p.name] ?? null;
      rt.live = next;
      this.#watch(service, next);
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
        const alive = next.proc.alive;
        const h = alive ? await this.#health(def, next) : { ok: false, said: `It stopped: ${next.proc.tail(5) || 'no last words'}` };
        if (!h.ok) {
          step('canary', false, h.said);
          // Back by itself (tier 1): the old version again, from its slot.
          rt.live = null;
          await this.#stopInstance(next);
          if (fromDef) {
            if (old?.proc.alive) {
              rt.live = old;
              for (const p of fromDef.ports) { const f = await this.#forwarder(rt, p.name, p.port); if (f.ok) rt.forwarders.get(p.name)!.target = old.ports[p.name] ?? null; }
            } else await this.#restore(rec, rt, fromDef);
          } else for (const f of rt.forwarders.values()) f.target = null;
          rec.live = from;
          this.#version(rec, version, 'rolled_back', h.said);
          this.#history(rec, version, 'rolled back', `Its health failed in the canary window: ${h.said}`);
          this.o.problem({ source: 'supervisor', playbook: 'service-rolled-back', subject: `${service}@${version}`, said: `${service} ${version} was rolled back by itself: its health failed in the canary window. ${from ? `${from} is running again.` : 'Nothing else was running.'}`, detail: h.said });
          return { ok: false, said: `Rolled back: ${h.said}` };
        }
      }
      step('canary', true, `${n} probes over ${Math.round(this.o.timings.canaryMs / 1000)} s, all healthy.`);
      // Promoted: the old version stops, its slot kept for the soak. A version kept from before goes.
      if (old && old !== next) { if (rt.live !== old) await this.#stopInstance(old); }
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

  // ---- rollback: the kept version, in one step --------------------------------------------------------

  async rollback(service: string, o: { auto: boolean; reason: string }, say: Say = () => {}): Promise<Outcome> {
    if (service === CONSOLE) return this.o.console.rollback(o, say);
    return this.#exclusive(service, (rec, rt) => this.#rollback(rec, rt, o, say));
  }

  async #rollback(rec: Rec, rt: Runtime, o: { auto: boolean; reason: string }, say: Say = () => {}): Promise<Outcome> {
    const service = rec.service;
    const cur = rec.live;
    const target = rec.previous;
    const def = target ? this.#def(service, target) : null;
    if (!target || !def) return { ok: false, said: `${service} has no previous version kept to go back to.` };
    if (rt.live) { const l = rt.live; rt.live = null; await this.#stopInstance(l); }
    this.#clearSoak(rt);
    const back = await this.#restore(rec, rt, def);
    if (!back.ok) {
      const reason = `Going back to ${target} didn’t start it either: ${back.said}`;
      this.#hold(rec, rt, reason, '');
      say(`✗ rollback: ${reason}`);
      return { ok: false, said: `${reason} ${service} is held.` };
    }
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

  // The kept version started from its slot and given the stable ports.
  async #restore(rec: Rec, rt: Runtime, def: ServiceDefinition): Promise<Outcome> {
    const started = await this.#startInstance(def, this.#stateDir(def));
    if (!started.ok) return { ok: false, said: started.said };
    rt.live = started.inst;
    for (const p of def.ports) { const f = await this.#forwarder(rt, p.name, p.port); if (f.ok) rt.forwarders.get(p.name)!.target = started.inst.ports[p.name] ?? null; }
    rec.live = def.version;
    rec.held = null;
    rt.failing = 0;
    this.#watch(rec.service, started.inst);
    return { ok: true, said: `${def.version} is running.` };
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
      for (const [name, f] of rt?.forwarders ?? []) stable[name] = f.port;
      const versions: ServiceVersionView[] = rec.versions.map((v) => {
        const i = running.get(v.version);
        return { version: v.version, status: v.status, since: v.since, said: v.said, ports: i && i.proc.alive ? i.ports : null, pid: i && i.proc.alive ? i.proc.pid : null };
      });
      out.push({ service: rec.service, driver: this.name, live: rec.live, previous: rec.previous, soak_until: rec.soak_until, held: rec.held, health: rec.health, stable, versions, history: rec.history });
    }
    return out;
  }

  // ---- running ----------------------------------------------------------------------------------------

  // After the supervisor starts: every live service that isn't held runs again, and soaks go on.
  async resume(): Promise<void> {
    for (const rec of this.#recs.values()) this.#endLeftovers(rec);
    for (const rec of this.#recs.values()) {
      if (!rec.live || rec.held) continue;
      const def = this.#def(rec.service, rec.live);
      const rt = this.#runtime(rec.service);
      if (!def) { this.#hold(rec, rt, `The slot for ${rec.live} is missing, so it can’t start.`, ''); continue; }
      const r = await this.#restore(rec, rt, def);
      if (!r.ok) { this.#hold(rec, rt, `It didn’t start with the supervisor: ${r.said}`, ''); continue; }
      this.#armSoak(rec.service);
    }
    this.#save();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const rt of this.#rt.values()) {
      if (rt.healthTimer) clearInterval(rt.healthTimer);
      if (rt.restartTimer) clearTimeout(rt.restartTimer);
      this.#clearSoak(rt);
      for (const i of [rt.live, rt.alongside]) if (i) await this.#stopInstance(i);
      rt.live = null;
      rt.alongside = null;
      for (const f of rt.forwarders.values()) await f.close();
      rt.forwarders.clear();
    }
    this.#save();
  }

  // The pids of every process the driver runs now (for checks that none is left behind).
  pids(): number[] {
    return [...this.#rt.values()].flatMap((rt) => [rt.live, rt.alongside]).flatMap((i) => (i?.proc.pid ? [i.proc.pid] : []));
  }

  #watch(service: string, inst: Instance): void {
    inst.proc.once('exit', (e: { code: number | null; signal: string | null; expected: boolean }) => {
      const rt = this.#rt.get(service);
      if (e.expected || this.#closed || !rt || rt.live !== inst || rt.busy) return;
      void this.#crashed(service, inst, e);
    });
    const rt = this.#runtime(service);
    if (!rt.healthTimer) {
      const def = this.#def(service, inst.version)!;
      const every = this.o.timings.healthEveryMs ?? def.health.every_s * 1000;
      rt.healthTimer = setInterval(() => { void this.#healthCheck(service); }, every);
      rt.healthTimer.unref?.();
    }
  }

  async #crashed(service: string, inst: Instance, e: { code: number | null; signal: string | null }): Promise<void> {
    const rec = this.#recs.get(service)!;
    const rt = this.#runtime(service);
    await inst.proc.stop(0);
    rt.live = null;
    const how = e.signal ? `was stopped by ${e.signal}` : `exited with code ${e.code}`;
    rt.crashes.record();
    if (rt.crashes.tooMany) {
      // In its soak, a crash loop goes back to the kept version in one step.
      if (rec.previous) {
        await this.#exclusive(service, (r, t) => this.#rollback(r, t, { auto: true, reason: `${service} ${rec.live} stopped ${rt.crashes.count} times within ${Math.round(this.o.timings.windowMs / 1000)} s (the last time it ${how}).` }));
        return;
      }
      this.#hold(rec, rt, `${service} stopped ${rt.crashes.count} times within ${Math.round(this.o.timings.windowMs / 1000)} s (the last time it ${how}), so the supervisor stopped restarting it.`, inst.proc.tail(15));
      return;
    }
    const wait = rt.crashes.wait();
    this.#say(`${service} ${how}. Starting it again in ${(wait / 1000).toFixed(1)} s.`);
    this.o.problem({ source: 'supervisor', playbook: 'service-crashed', subject: service, said: `${service} stopped unexpectedly (it ${how}) and the supervisor started it again.`, detail: inst.proc.tail(15), repairs: [{ name: 'restart-service', ok: true, said: `Started again after ${(wait / 1000).toFixed(1)} s.` }] });
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      if (this.#closed || rt.live || !rec.live) return;
      const def = this.#def(service, rec.live);
      if (def) void this.#exclusive(service, (r, t) => this.#restore(r, t, def)).then((r) => { if (!r.ok) this.#hold(rec, rt, `It didn’t start again: ${r.said}`, ''); });
    }, wait);
    this.#save();
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
    if (!rec || !rt || rt.busy || this.#closed || !rt.live || !rec.live || rec.held) return;
    const def = this.#def(service, rec.live);
    if (!def) return;
    const inst = rt.live;
    const h = await this.#health(def, inst);
    rec.health = { ok: h.ok, checked_at: nowIso(), said: h.said };
    if (h.ok) { rt.failing = 0; this.#save(); return; }
    rt.failing++;
    if (rt.failing < this.o.timings.healthFailures || rt.busy || rt.live !== inst) { this.#save(); return; }
    const n = rt.failing;
    rt.failing = 0;
    // In its soak, failed health goes back to the kept version in one step (tier 1).
    if (rec.previous) {
      await this.#exclusive(service, (r, t) => this.#rollback(r, t, { auto: true, reason: `${service} ${rec.live} failed ${n} health checks in a row during its soak (${h.said}).` }));
      return;
    }
    this.#say(`${service} hasn’t answered ${n} health checks in a row. Restarting it.`);
    const r = await this.#exclusive(service, async (r2, t) => { if (t.live) { const l = t.live; t.live = null; await this.#stopInstance(l, 3000); } return this.#restore(r2, t, def); });
    this.o.problem({ source: 'supervisor', playbook: 'service-crashed', subject: service, said: `${service} stopped answering its health checks (${n} in a row), so the supervisor restarted it.`, detail: h.said, repairs: [{ name: 'restart-service', ok: r.ok, said: r.said }] });
    if (!r.ok) this.#hold(rec, rt, `It stopped answering and didn’t start again: ${r.said}`, '');
  }

  // ---- the soak ---------------------------------------------------------------------------------------

  #armSoak(service: string): void {
    const rec = this.#recs.get(service)!;
    const rt = this.#runtime(service);
    this.#clearSoak(rt);
    if (!rec.previous || !rec.soak_until) return;
    const left = Date.parse(rec.soak_until) - Date.now();
    const end = () => {
      rt.soakTimer = null;
      if (this.#closed || !rec.previous) return;
      const kept = rec.previous;
      rec.previous = null;
      rec.soak_until = null;
      this.#removeSlot(rec, kept, `Its soak ended with ${rec.live} healthy, so its slot was removed.`);
      this.#history(rec, rec.live ?? kept, 'soaked', `${rec.live} passed its soak; ${kept} was removed.`);
      this.#save();
    };
    if (left <= 0) { end(); return; }
    rt.soakTimer = setTimeout(end, left);
  }

  #clearSoak(rt: Runtime): void {
    if (rt.soakTimer) clearTimeout(rt.soakTimer);
    rt.soakTimer = null;
  }

  #removeSlot(rec: Rec, version: string, said: string): void {
    rmSync(this.#slot(rec.service, version), { recursive: true, force: true });
    rmSync(join(this.o.dir, 'services', rec.service, 'scratch', version), { recursive: true, force: true });
    this.#version(rec, version, 'removed', said);
  }

  // ---- instances ---------------------------------------------------------------------------------------

  async #startInstance(def: ServiceDefinition, state: string): Promise<{ ok: true; inst: Instance } | { ok: false; said: string }> {
    const prog = def.artifact.program?.[this.o.platform ?? platformKey()];
    if (!prog) return { ok: false, said: 'It has no program for this computer.' };
    const slot = this.#slot(def.service, def.version);
    if (!existsSync(join(slot, 'definition.json'))) return { ok: false, said: `Its slot isn’t there (${def.version}).` };
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
    const [cmd, ...args] = prog.command;
    const argv = [cmd === 'node' ? process.execPath : cmd!.includes('/') && !cmd!.startsWith('/') ? join(slot, cmd!) : cmd!, ...args];
    const proc = new ServerProcess({ root: slot, env, argv, group: true, echo: (s) => this.o.echo?.(`[${def.service} ${def.version}] ${s}`) });
    const inst: Instance = { version: def.version, proc, ports, state };
    const end = Date.now() + this.o.timings.readyMs;
    while (Date.now() < end) {
      if (!proc.alive) { await proc.stop(0); return { ok: false, said: `It stopped as it started${proc.proc.exitCode !== null ? ` (code ${proc.proc.exitCode})` : ''}: ${proc.tail(5) || 'no last words'}` }; }
      if ((await this.#health(def, inst)).ok) { proc.markReady(first ? ports[first.name]! : 0); return { ok: true, inst }; }
      await sleep(100);
    }
    await this.#stopInstance(inst, 2000);
    return { ok: false, said: `Its health didn’t answer within ${Math.round(this.o.timings.readyMs / 1000)} s: ${proc.tail(5) || 'no output'}` };
  }

  async #stopInstance(inst: Instance, graceMs = 5000): Promise<void> {
    await inst.proc.stop(graceMs);
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
  // that is there already must be exactly this definition and program, or nothing is installed.
  #install(def: ServiceDefinition): { ok: true; said: string; sha256: string } | { ok: false; said: string } {
    const prog = def.artifact.program?.[this.o.platform ?? platformKey()];
    if (!prog) return { ok: false, said: 'It has no program for this computer.' };
    let src: string;
    try { src = fileURLToPath(prog.url); } catch { return { ok: false, said: `${prog.url} isn’t a file on this computer.` }; }
    let bytes: Buffer;
    try { bytes = readFileSync(src); } catch (e) { return { ok: false, said: `Its program couldn’t be read at ${prog.url}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}.` }; }
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== prog.sha256) return { ok: false, said: `Its program’s SHA-256 is ${sha.slice(0, 12)}…, not the ${prog.sha256.slice(0, 12)}… its definition pins. Nothing was installed.` };
    const slot = this.#slot(def.service, def.version);
    const name = basename(src);
    const text = `${JSON.stringify(def, null, 2)}\n`;
    if (existsSync(slot)) {
      const same = readOr(join(slot, 'definition.json')) === text && existsSync(join(slot, name)) && createHash('sha256').update(readFileSync(join(slot, name))).digest('hex') === sha;
      if (same) return { ok: true, said: `Its slot for ${def.version} is there already, checked: the same definition and program.`, sha256: sha };
      return { ok: false, said: `${def.service} ${def.version} is installed already with a different definition or program. Slots are never changed: a new version is a new slot.` };
    }
    const tmp = `${slot}.part-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, name), bytes, { mode: 0o600 });
    chmodSync(join(tmp, name), statSync(src).mode & 0o755);
    writeFileSync(join(tmp, 'definition.json'), text, { mode: 0o600 });
    mkdirSync(join(slot, '..'), { recursive: true, mode: 0o700 });
    renameSync(tmp, slot);
    return { ok: true, said: `Installed ${name} (SHA-256 ${sha.slice(0, 12)}…, as pinned) in its slot for ${def.version}.`, sha256: sha };
  }

  // ---- records -------------------------------------------------------------------------------------------

  #runtime(service: string): Runtime {
    let rt = this.#rt.get(service);
    if (!rt) {
      rt = { live: null, alongside: null, forwarders: new Map(), crashes: new CrashWindow(this.o.timings), failing: 0, busy: false, healthTimer: null, restartTimer: null, soakTimer: null };
      this.#rt.set(service, rt);
    }
    return rt;
  }

  // One change to a service at a time.
  async #exclusive(service: string, fn: (rec: Rec, rt: Runtime) => Promise<Outcome>, create = false): Promise<Outcome> {
    if (!SERVICE.test(service)) return { ok: false, said: `${service} isn’t a service’s name.` };
    let rec = this.#recs.get(service);
    if (!rec && !create) return { ok: false, said: `The supervisor runs no service named ${service}.` };
    const rt = this.#runtime(service);
    if (rt.busy) return { ok: false, said: `A change to ${service} is already running.` };
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
  }

  async #forwarder(rt: Runtime, name: string, port: number): Promise<Outcome> {
    const f = rt.forwarders.get(name);
    if (f && f.port === port) return { ok: true, said: 'open' };
    if (f) { await f.close(); rt.forwarders.delete(name); }
    const next = new Forwarder(port);
    const r = await next.listen();
    if (!r.ok) return r;
    rt.forwarders.set(name, next);
    return r;
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
  // group. Ended here, whole groups, but only a process that is still one of ours: its working
  // folder is that version's slot (read from /proc, so on Linux; elsewhere it is left, and said).
  #endLeftovers(rec: Rec): void {
    for (const p of rec.procs ?? []) {
      if (!Number.isInteger(p.pid) || p.pid <= 1 || !VERSION.test(p.version)) continue;
      let cwd: string | null = null;
      try { cwd = readlinkSync(`/proc/${p.pid}/cwd`); } catch { /* gone, or no /proc */ }
      if (cwd === this.#slot(rec.service, p.version)) {
        try { process.kill(-p.pid, 'SIGKILL'); } catch { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
        this.#say(`${rec.service} ${p.version} (process ${p.pid}) was still running from a supervisor that stopped without ending it; it was ended.`);
      } else if (cwd === null && process.platform !== 'linux' && pidAlive(p.pid)) {
        this.#say(`${rec.service} ${p.version} may still be running as process ${p.pid} from before; it wasn’t ended, as it can’t be told apart from another program here.`);
      }
    }
    rec.procs = [];
  }

  #save(): void {
    for (const rec of this.#recs.values()) {
      const rt = this.#rt.get(rec.service);
      rec.procs = [rt?.live, rt?.alongside].flatMap((i) => (i?.proc.pid && i.proc.alive ? [{ pid: i.proc.pid, version: i.version }] : []));
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
  full: 'Start it next to the live version, on loopback ports of its own, with no traffic (full).',
  shadow: 'Start it next to the live version on a scratch copy of its state; what it writes is thrown away (shadow).',
  copy: 'Start it on a copy of its state, with no traffic, then stop it: at the switch it starts on the real state (copy).',
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

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readOr(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// The stable port: on 127.0.0.1, owned by the supervisor, carrying each connection to whichever
// version is live. Moving it is the switch; nothing listens there while a service is held.
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
      const s = createServer((client) => {
        const target = this.target;
        if (!target) { client.destroy(); return; }
        const up = connect(target, '127.0.0.1');
        // Either side gone, both go: a client kept alive to a version that stopped connects again,
        // to the live one.
        for (const x of [client, up]) {
          this.#sockets.add(x);
          x.once('close', () => { this.#sockets.delete(x); client.destroy(); up.destroy(); });
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
