// The supervisor (NOVA-SPEC §7, M7 plan §2): it runs the Nova server as its child and keeps it
// running. A crash is restarted after a wait that doubles each time; three crashes within a minute
// put it in safe mode: the server is held, the reason written down (in the database as a problem
// with its playbook, in the state file, and on a small page at Nova's address), and the last good
// release offered. Health is checked on a schedule; a server that stops answering is restarted.
//
// Code releases go through it (ADR-9): a tagged release's tests, a sandbox start on a copy of the
// home, smoke probes, the switch, then a canary window on the live home that rolls back to the
// previous slot by itself when health fails. Deploying is tier 3: an explicit confirmation on the
// command line, or the API from the hub's own screen. Going back across a database upgrade
// restores the pre-upgrade backup only when nothing was written since; otherwise it refuses, says
// why, and keeps the newer release running with the problem open. It never loses data silently.
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createNet, type Server as NetServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyHome, restoreBackup, smoke, startSandbox, type DeployStage, type ProbeLine, type ReleaseSlot, type SupervisorProblem, type SupervisorState } from '../core/index.ts';
import { runningPid } from '../home.js';
import { ServerProcess } from './server.ts';
import { Slots, VERSION, carryProblems, mark, preMigrationBackup, problemsSince, recordProblem, sandboxable, schemaVersion, writesSince } from './releases.ts';

// The code the supervisor was started from, when no release is current.
export const BASE = 'base';

export interface Timings {
  backoffMs: number;
  maxBackoffMs: number;
  crashes: number;
  windowMs: number;
  healthEveryMs: number;
  healthFailures: number;
  readyMs: number;
  canaryMs: number;
  probeEveryMs: number;
  testsMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  backoffMs: 1000, maxBackoffMs: 30_000, crashes: 3, windowMs: 60_000,
  healthEveryMs: 30_000, healthFailures: 3, readyMs: 60_000,
  canaryMs: 120_000, probeEveryMs: 5000, testsMs: 30 * 60_000,
};
// A canary has a floor: at least this long, and at least two probes in it.
export const MIN_CANARY_MS = 2000;

export interface SupervisorOptions {
  dir: string;
  home: string;
  repo: string;
  base: string;
  // The server's environment. NOVA_HOME is set from `home`; the supervisor adds its own link.
  env: Record<string, string>;
  // The release's test suite, run in its slot with a scratch HOME.
  tests: string[];
  timings?: Partial<Timings>;
  echo?: (s: string) => void;
  log?: (s: string) => void;
}

type Say = (line: string) => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

export class Supervisor {
  readonly o: SupervisorOptions;
  readonly t: Timings;
  readonly slots: Slots;
  readonly stateFile: string;
  state: SupervisorState;
  server: ServerProcess | null = null;
  #crashes: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  #deploying = false;
  #closed = false;
  #pending: SupervisorProblem[] = [];
  #control: NetServer | null = null;
  #page: HttpServer | null = null;
  #checking = false;

  constructor(o: SupervisorOptions) {
    this.o = o;
    const t = { ...DEFAULT_TIMINGS, ...o.timings };
    t.canaryMs = Math.max(t.canaryMs, MIN_CANARY_MS);
    t.probeEveryMs = Math.min(t.probeEveryMs, t.canaryMs / 2);
    this.t = t;
    this.slots = new Slots({ dir: o.dir, repo: o.repo });
    this.stateFile = join(o.dir, 'state.json');
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.state = this.#load();
  }

  // ---- running ----------------------------------------------------------------------------------

  async run(): Promise<void> {
    const other = runningPid(this.o.home);
    if (other) throw new Error(`A Nova server is already running this home (process ${other}). Stop it first: the supervisor starts its own.`);
    const pidFile = join(this.o.dir, 'supervisor.pid');
    const prev = Number(readOr(pidFile, '0'));
    if (prev && prev !== process.pid && alive(prev)) throw new Error(`Another supervisor (process ${prev}) is already running with ${this.o.dir}.`);
    writeFileSync(pidFile, String(process.pid));
    await this.#listen();
    this.state.pid = process.pid;
    // Releases on disk are the truth for which one is current.
    const cur = this.slots.current();
    this.state.releases.current = cur && this.slots.list().includes(cur) ? cur : BASE;
    if (this.state.mode === 'safe_mode' && this.state.safe_mode) {
      this.#say(`Nova is held in safe mode: ${this.state.safe_mode.reason} Run “recover” or “rollback”.`);
      await this.#openPage();
    } else {
      this.#start();
    }
    this.#healthTimer = setInterval(() => { void this.#healthCheck(); }, this.t.healthEveryMs);
    this.#save();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    await this.#stopServer();
    await this.#closePage();
    await new Promise<void>((r) => (this.#control ? this.#control.close(() => r()) : r()));
    rmSync(join(this.o.dir, 'control.sock'), { force: true });
    rmSync(join(this.o.dir, 'supervisor.pid'), { force: true });
    if (this.state.mode !== 'safe_mode') this.state.mode = 'stopped';
    this.#save();
  }

  codeRoot(version: string | null = this.state.releases.current): string {
    return !version || version === BASE ? this.o.base : this.slots.path(version);
  }

  #start(): void {
    if (this.#closed) return;
    const root = this.codeRoot();
    const s = new ServerProcess({
      root,
      env: { ...this.o.env, NOVA_HOME: this.o.home, NOVA_SUPERVISED: '1', NOVA_SUPERVISOR_STATE: this.stateFile },
      ...(this.o.echo ? { echo: this.o.echo } : {}),
    });
    this.server = s;
    this.state.mode = this.#deploying ? 'deploying' : 'starting';
    this.state.server = { ...this.state.server, pid: s.pid, port: null, started_at: nowIso(), code: root };
    this.#save();
    s.on('ready', (port: number) => {
      this.state.server.port = port;
      if (!this.#deploying) this.state.mode = 'running';
      this.state.health.failing = 0;
      this.#save();
      // Problems wait until the server can take them (its core is listening on the channel).
      for (const p of this.#pending.splice(0)) s.send({ nova: 'problem', ...p });
    });
    s.on('message', (m: unknown) => { void this.#onMessage(s, m); });
    s.on('exit', (e: { code: number | null; signal: string | null; expected: boolean }) => {
      if (this.server === s) this.server = null;
      this.state.server.last_exit = { code: e.code, signal: e.signal, at: nowIso() };
      this.state.server.pid = null;
      this.#save();
      if (e.expected || this.#closed || this.#deploying) return;
      this.#crashed(s, e);
    });
  }

  #crashed(s: ServerProcess, e: { code: number | null; signal: string | null }): void {
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((x) => now - x < this.t.windowMs), now];
    const how = e.signal ? `was stopped by ${e.signal}` : `exited with code ${e.code}`;
    const tail = s.tail(15);
    if (this.#crashes.length >= this.t.crashes) {
      void this.#enterSafeMode(`Nova stopped ${this.#crashes.length} times within ${Math.round(this.t.windowMs / 1000)} s (the last time it ${how}), so the supervisor stopped restarting it.`, tail);
      return;
    }
    const wait = Math.min(this.t.maxBackoffMs, this.t.backoffMs * 2 ** (this.#crashes.length - 1));
    this.state.mode = 'restarting';
    this.state.server.restarts++;
    this.#save();
    this.#say(`Nova ${how}. Starting it again in ${(wait / 1000).toFixed(1)} s.`);
    this.#restartTimer = setTimeout(() => { this.#restartTimer = null; this.#start(); }, wait);
    this.#problem({
      source: 'supervisor', playbook: 'server-crashed',
      said: `Nova stopped unexpectedly (it ${how}) and the supervisor started it again.`,
      detail: tail, repairs: [{ name: 'restart-server', ok: true, said: `Started again after ${(wait / 1000).toFixed(1)} s.` }],
    });
  }

  async #enterSafeMode(reason: string, output: string): Promise<void> {
    await this.#stopServer();
    const lastGood = this.state.releases.last_good;
    this.state.mode = 'safe_mode';
    this.state.safe_mode = { reason, at: nowIso(), last_good: lastGood, output };
    this.#save();
    const offer = lastGood && lastGood !== this.state.releases.current ? ` The last good release is ${lastGood}: node src/supervisor/main.ts rollback goes back to it.` : '';
    // What was waiting for a server that won't come goes into the database now.
    for (const p of this.#pending.splice(0)) recordProblem(this.o.home, p);
    recordProblem(this.o.home, { source: 'supervisor', playbook: 'safe-mode', said: `Nova is held in safe mode: ${reason}${offer}`, detail: output });
    this.#say(`Safe mode: ${reason}${offer}`);
    await this.#openPage();
  }

  // Leaves safe mode on the person's word: starts Nova again from the current release.
  async recover(): Promise<{ ok: boolean; said: string }> {
    if (this.state.mode !== 'safe_mode') return { ok: false, said: 'Nova isn’t in safe mode.' };
    await this.#closePage();
    this.#crashes = [];
    this.state.safe_mode = null;
    this.#start();
    const port = await this.server?.ready(this.t.readyMs);
    return port ? { ok: true, said: `Nova is running again on port ${port}.` } : { ok: false, said: 'Nova didn’t start; it may go back to safe mode.' };
  }

  async restart(why = 'as asked', graceMs?: number): Promise<{ ok: boolean; said: string }> {
    if (this.#deploying) return { ok: false, said: 'A deploy is running; it restarts Nova itself.' };
    await this.#stopServer(graceMs);
    this.#start();
    const port = await this.server?.ready(this.t.readyMs);
    return port ? { ok: true, said: `Nova was restarted (${why}) and answers on port ${port}.` } : { ok: false, said: 'Nova didn’t come back after the restart.' };
  }

  async #stopServer(graceMs?: number): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await s.stop(graceMs);
  }

  // ---- health -----------------------------------------------------------------------------------

  async #healthCheck(): Promise<void> {
    if (this.#checking || this.#deploying || this.#closed || this.state.mode !== 'running' || !this.server?.port) return;
    this.#checking = true;
    try {
      const r = await this.#health(this.server.port);
      this.state.health.last_check_at = nowIso();
      if (r.answered) {
        this.state.health = { ...this.state.health, last_ok_at: nowIso(), failing: 0, said: r.said };
      } else {
        this.state.health.failing++;
        this.state.health.said = r.said;
        if (this.state.health.failing >= this.t.healthFailures) {
          const n = this.state.health.failing;
          this.#say(`Nova hasn’t answered ${n} health checks in a row. Restarting it.`);
          // A process that doesn't answer may not take SIGTERM either: a short grace, then SIGKILL.
          const out = await this.restart('it stopped answering', 3000);
          this.#problem({ source: 'supervisor', playbook: 'server-unresponsive', said: `Nova stopped answering its health checks (${n} in a row), so the supervisor restarted it.`, detail: r.said, repairs: [{ name: 'restart-server', ok: out.ok, said: out.said }] });
        }
      }
      this.#save();
    } finally {
      this.#checking = false;
    }
  }

  async #health(port: number): Promise<{ answered: boolean; ok: boolean; failing: { name: string; detail: string }[]; said: string }> {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(Math.min(5000, Math.max(1000, this.t.healthEveryMs))) });
      const body = await r.json() as { ok?: boolean; checks?: Record<string, { ok: boolean; detail?: string }> };
      const failing = Object.entries(body.checks ?? {}).filter(([, c]) => !c.ok).map(([name, c]) => ({ name, detail: c.detail ?? 'not ok' }));
      return { answered: true, ok: r.status === 200 && body.ok === true, failing, said: failing.length ? failing.map((f) => `${f.name}: ${f.detail}`).join('; ') : 'Healthy.' };
    } catch (e) {
      return { answered: false, ok: false, failing: [], said: `No answer from Nova: ${(e as Error).message}` };
    }
  }

  // ---- problems ---------------------------------------------------------------------------------

  // Told to the running server (stored and shown like any problem), or kept until one is ready.
  #problem(p: SupervisorProblem): void {
    if (this.server?.port && this.server.send({ nova: 'problem', ...p })) return;
    if (this.server || this.#restartTimer || this.#deploying) { this.#pending.push(p); return; }
    // No server is coming (safe mode, stopped): straight into the database, so it is there.
    recordProblem(this.o.home, p);
  }

  #say(line: string): void {
    this.o.log?.(`[supervisor] ${line}\n`);
  }

  // ---- the server's requests (the console's API) -----------------------------------------------

  async #onMessage(s: ServerProcess, m: unknown): Promise<void> {
    const msg = m as { nova?: string; id?: string; type?: string; version?: string };
    if (msg?.nova !== 'request' || typeof msg.id !== 'string') return;
    const reply = (ok: boolean, said: string) => s.send({ nova: 'reply', id: msg.id, ok, said });
    if (msg.type === 'deploy') {
      if (typeof msg.version !== 'string' || !VERSION.test(msg.version) || msg.version === BASE) return void reply(false, 'That isn’t a release’s tag.');
      if (this.#deploying) return void reply(false, 'A deploy is already running.');
      if (!(await this.slots.commit(msg.version))) return void reply(false, `There is no release tagged ${msg.version}.`);
      reply(true, `Deploying ${msg.version}: its tests, a sandbox start on a copy of your home, smoke probes, the switch, then a canary window. Nova restarts during the switch.`);
      void this.deploy(msg.version).catch((e) => this.#say(`The deploy stopped: ${(e as Error).message}`));
    } else if (msg.type === 'rollback') {
      if (this.#deploying) return void reply(false, 'A deploy is running; it rolls back by itself if its canary fails.');
      const target = this.state.releases.previous;
      if (!target) return void reply(false, 'There is no previous release to go back to.');
      reply(true, `Going back to ${target === BASE ? 'the code the supervisor started from' : target}. Nova restarts.`);
      void this.rollback({ auto: false, reason: 'You asked to go back.', target });
    } else if (msg.type === 'restart') {
      reply(true, 'Restarting Nova.');
      void this.restart('a repair playbook asked');
    } else reply(false, 'The supervisor doesn’t do that.');
  }

  // ---- deploying ---------------------------------------------------------------------------------

  async deploy(version: string, say: Say = () => {}): Promise<{ ok: boolean; said: string }> {
    if (this.#deploying) return { ok: false, said: 'A deploy is already running.' };
    if (!VERSION.test(version) || version === BASE) return { ok: false, said: 'That isn’t a release’s tag.' };
    if (version === this.state.releases.current) return { ok: false, said: `${version} is already running.` };
    this.#deploying = true;
    const from = this.state.releases.current ?? BASE;
    this.state.deploy = { version, from, started_at: nowIso(), stage: 'prepare', stages: [], canary: null, outcome: 'running' };
    this.state.mode = 'deploying';
    this.#save();
    const stage = (name: DeployStage['stage'], ok: boolean, said: string) => {
      this.state.deploy!.stage = name;
      this.state.deploy!.stages.push({ stage: name, ok, at: nowIso(), said });
      this.#save();
      say(`${ok ? '✓' : '✗'} ${name}: ${said}`);
      this.#say(`deploy ${version} · ${name}: ${said}`);
    };
    const stopped = (name: DeployStage['stage'], said: string) => {
      stage(name, false, said);
      this.state.deploy!.outcome = 'stopped';
      this.#history(version, from, 'stopped', said);
      this.#slot(version, { status: 'failed' });
      this.#problem({ source: 'supervisor', playbook: 'release-stopped', subject: version, said: `Release ${version} didn’t pass its ${name === 'tests' ? 'tests' : name === 'smoke' ? 'smoke probes' : name === 'sandbox' ? 'sandbox start' : 'checks'}, so Nova kept running ${from === BASE ? 'what it had' : from}.`, detail: said });
      return { ok: false, said: `Stopped at ${name}: ${said}` };
    };
    try {
      // 1. The slot: a worktree of the tag's commit.
      let slot: { path: string; commit: string };
      try { slot = await this.slots.ensure(version); } catch (e) { return stopped('prepare', (e as Error).message); }
      if (!sandboxable(slot.path)) return stopped('prepare', 'This release is from before Nova could run a release in a sandbox, so it can’t go through the pipeline.');
      this.#slot(version, { commit: slot.commit, status: 'ready' });
      stage('prepare', true, `Release ${version} is commit ${slot.commit.slice(0, 12)}.`);

      // 2. Its own tests.
      const tests = await this.#runTests(slot.path);
      if (!tests.ok) return stopped('tests', tests.said);
      stage('tests', true, tests.said);

      // 3–4. A sandbox start on a copy of the home, and the smoke probes. What already fails on
      // the live home (a backup drive unplugged) is no fault of the release.
      const baseline = this.server?.port ? (await this.#health(this.server.port)).failing.map((f) => f.name) : [];
      const scratch = mkdtempSync(join(tmpdir(), 'nova-sandbox-'));
      try {
        const home = join(scratch, 'home');
        copyHome(this.o.home, home);
        let sb: Awaited<ReturnType<typeof startSandbox>>;
        try { sb = await startSandbox({ root: slot.path, home, timeoutMs: this.t.readyMs }); } catch (e) { return stopped('sandbox', (e as Error).message); }
        stage('sandbox', true, 'It started on a copy of your home, with no work, no network peers and no secrets.');
        let probes: Awaited<ReturnType<typeof smoke>>;
        try { probes = await smoke(sb.base, { ignore: ['vault', ...baseline] }); } finally { await sb.stop(); }
        const bad = probes.filter((p) => !p.ok);
        if (bad.length) return stopped('smoke', bad.map((p) => `${p.name}: ${p.said}`).join(' '));
        stage('smoke', true, `${probes.length} probes passed: ${probes.map((p) => p.name).join(', ')}.`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }

      // 5. The switch.
      const pre = schemaVersion(this.o.home);
      const t0 = Date.now();
      await this.#stopServer();
      this.slots.point(version);
      this.state.releases.current = version;
      this.#start();
      const port = await this.server?.ready(this.t.readyMs);
      const post = schemaVersion(this.o.home);
      const migration = post > pre ? { from: pre, to: post, backup: preMigrationBackup(this.o.home, pre, t0), mark: mark(this.o.home) } : null;
      this.#slot(version, { migration });
      if (!port) {
        stage('switch', false, `It didn’t start on your home: ${this.#lastWords()}`);
        return await this.rollback({ auto: true, reason: `Release ${version} didn’t start on your home.`, target: from, say });
      }
      stage('switch', true, `Running ${version} on your home${migration ? `; the database was upgraded from ${pre} to ${post}, with the backup from before kept` : ''}.`);

      // 6. The canary window: health on the live home, probe by probe.
      const until = Date.now() + this.t.canaryMs;
      this.state.deploy!.stage = 'canary';
      this.state.deploy!.canary = { until: new Date(until).toISOString(), probes: [] };
      this.#save();
      let n = 0;
      while (Date.now() < until || n < 2) {
        await sleep(this.t.probeEveryMs);
        const p = await this.#canaryProbe(baseline);
        n++;
        this.state.deploy!.canary!.probes.push(p);
        this.#save();
        if (!p.ok) {
          stage('canary', false, p.said);
          return await this.rollback({ auto: true, reason: p.said, target: from, say });
        }
      }
      stage('canary', true, `${n} probes over ${Math.round(this.t.canaryMs / 1000)} s, all healthy.`);

      // 7. Promoted: this is the release now, and the one before it is kept to go back to.
      this.state.releases.previous = from;
      this.state.releases.last_good = version;
      this.#slot(version, { status: 'live' });
      if (from !== BASE) this.#slot(from, { status: 'previous' });
      this.state.deploy!.outcome = 'promoted';
      this.state.mode = 'running';
      this.#crashes = [];
      stage('promote', true, `${version} is live; ${from === BASE ? 'the code the supervisor started from' : from} is kept to go back to.`);
      this.#history(version, from, 'promoted', 'Passed its tests, the sandbox, the smoke probes and the canary.');
      return { ok: true, said: `${version} is live.` };
    } finally {
      this.#deploying = false;
      if (this.state.mode === 'deploying') this.state.mode = this.server ? 'running' : 'stopped';
      this.#save();
    }
  }

  async #canaryProbe(baseline: string[]): Promise<ProbeLine> {
    const at = nowIso();
    const s = this.server;
    if (!s || !s.alive) return { at, ok: false, said: `Nova stopped during the canary window: ${this.#lastWords()}` };
    if (!s.port) return { at, ok: false, said: 'Nova isn’t listening.' };
    const h = await this.#health(s.port);
    if (!h.answered) return { at, ok: false, said: h.said };
    const fresh = h.failing.filter((f) => !baseline.includes(f.name));
    if (fresh.length) return { at, ok: false, said: `Health failed: ${fresh.map((f) => `${f.name}: ${f.detail}`).join('; ')}` };
    return { at, ok: true, said: baseline.length && h.failing.length ? `Healthy, apart from what already failed before (${h.failing.map((f) => f.name).join(', ')}).` : 'Healthy.' };
  }

  #lastWords(): string {
    const tail = this.server?.tail(8) ?? '';
    const code = this.state.server.last_exit;
    return `${code ? `it ${code.signal ? `was stopped by ${code.signal}` : `exited with code ${code.code}`}` : 'no answer'}${tail ? `. Its last words:\n${tail}` : ''}`;
  }

  // The release's own test suite, in its slot, with a scratch HOME so no test can reach a real home.
  async #runTests(root: string): Promise<{ ok: boolean; said: string }> {
    const [cmd, ...args] = this.o.tests;
    if (!cmd) return { ok: true, said: 'No test command is set.' };
    // Dev dependencies: the slot borrows the base checkout's, when its lockfile is the same.
    const nm = join(root, 'node_modules');
    if (!existsSync(nm) && existsSync(join(this.o.base, 'node_modules')) && readOr(join(root, 'package-lock.json'), 'a') === readOr(join(this.o.base, 'package-lock.json'), 'b')) {
      try { symlinkSync(join(this.o.base, 'node_modules'), nm); } catch { /* the tests say what's missing */ }
    }
    const scratch = mkdtempSync(join(tmpdir(), 'nova-release-tests-'));
    const out: string[] = [];
    try {
      const code = await new Promise<number | null>((resolve) => {
        const p = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: scratch, TZ: 'UTC', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        p.stdout!.on('data', (d) => out.push(String(d)));
        p.stderr!.on('data', (d) => out.push(String(d)));
        const timer = setTimeout(() => { out.push(`\nStopped after ${Math.round(this.t.testsMs / 1000)} s.`); p.kill('SIGKILL'); }, this.t.testsMs);
        p.on('error', (e) => { out.push(e.message); });
        p.on('close', (c) => { clearTimeout(timer); resolve(c); });
      });
      const text = out.join('');
      const counts = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(text);
      if (code === 0) return { ok: true, said: counts ? `${counts[1]} tests passed (${this.o.tests.join(' ')}).` : `${this.o.tests.join(' ')} passed.` };
      return { ok: false, said: `${this.o.tests.join(' ')} failed${counts ? ` (${counts[2]} of ${Number(counts[1]) + Number(counts[2])} tests)` : ''}:\n${text.trim().split('\n').slice(-25).join('\n')}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---- going back ---------------------------------------------------------------------------------

  async rollback(o: { auto: boolean; reason: string; target: string | null; say?: Say }): Promise<{ ok: boolean; said: string }> {
    const say = o.say ?? (() => {});
    const cur = this.state.releases.current ?? BASE;
    const target = o.target;
    if (!target) return { ok: false, said: 'There is no previous release to go back to.' };
    const name = (v: string) => (v === BASE ? 'the code the supervisor started from' : v);
    const step = (ok: boolean, said: string) => {
      if (this.state.deploy && this.state.deploy.outcome === 'running') this.state.deploy.stages.push({ stage: 'rollback', ok, at: nowIso(), said });
      this.#save();
      say(`${ok ? '✓' : '✗'} rollback: ${said}`);
      this.#say(`rollback ${cur} → ${target}: ${said}`);
    };
    const wasDeploying = this.#deploying;
    this.#deploying = true;
    try {
      await this.#stopServer();
      const mig = this.state.releases.slots.find((s) => s.version === cur)?.migration ?? null;
      if (mig) {
        // Back across a database upgrade: only with nothing written since, from the backup taken
        // before it. Otherwise the newer release keeps running, and the person is told why.
        const w = writesSince(this.o.home, mig.mark);
        const n = Object.values(w).reduce((a, b) => a + b, 0);
        const missing = !mig.backup || !existsSync(mig.backup);
        if (n > 0 || missing) {
          const why = n > 0
            ? `Going back to ${name(target)} would lose ${n} change${n === 1 ? '' : 's'} written since ${cur} upgraded the database (${Object.entries(w).map(([t, k]) => `${k} in ${t}`).join(', ')}).`
            : `The backup taken before ${cur} upgraded the database isn’t there any more.`;
          this.#start();
          await this.server?.ready(this.t.readyMs);
          step(false, `${why} Nova kept ${cur} running.`);
          if (this.state.deploy?.outcome === 'running') this.state.deploy.outcome = 'refused';
          this.#history(cur, target, 'rollback refused', why);
          this.#problem({ source: 'supervisor', playbook: 'rollback-refused', subject: cur, said: `Nova couldn’t go back to ${name(target)}: ${why} It kept ${cur} running${o.auto ? `, though its canary failed (${o.reason})` : ''}.`, detail: o.reason });
          return { ok: false, said: `${why} Nova kept ${cur} running.` };
        }
        const carried = problemsSince(this.o.home, mig.mark.problem);
        restoreBackup(join(this.o.home, 'nova.db'), mig.backup!);
        carryProblems(this.o.home, carried);
        step(true, `Restored the database from before ${cur} upgraded it (nothing had been written since).`);
      }
      this.slots.point(target === BASE ? null : target);
      this.state.releases.current = target;
      this.#start();
      const port = await this.server?.ready(this.t.readyMs);
      if (!port) {
        step(false, `${name(target)} didn’t start either.`);
        await this.#enterSafeMode(`Going back to ${name(target)} after ${o.reason} didn’t start either.`, this.server?.tail(15) ?? '');
        return { ok: false, said: 'Neither release would start; Nova is held in safe mode.' };
      }
      this.#slot(cur, { status: o.auto ? 'rolled_back' : 'ready' });
      if (target !== BASE) this.#slot(target, { status: 'live' });
      this.state.releases.previous = null;
      this.state.releases.last_good = target;
      step(true, `${name(target)} is running again.`);
      if (this.state.deploy?.outcome === 'running') this.state.deploy.outcome = 'rolled_back';
      this.state.mode = 'running';
      this.#history(cur, target, o.auto ? 'rolled back' : 'went back', o.reason);
      if (o.auto) this.#problem({ source: 'supervisor', playbook: 'release-rolled-back', subject: cur, said: `Release ${cur} was rolled back by itself: its health failed in the canary window. ${name(target)} is running again, with your data as it was.`, detail: o.reason });
      return { ok: true, said: `${o.auto ? `Rolled back: ${o.reason} ` : ''}${name(target)} is running again.` };
    } finally {
      this.#deploying = wasDeploying;
      // On its own (not inside a deploy, whose end says), it leaves Nova running unless held.
      if (!wasDeploying && this.state.mode === 'deploying') this.state.mode = this.server ? 'running' : 'stopped';
      this.#save();
    }
  }

  // ---- the state file ------------------------------------------------------------------------------

  #load(): SupervisorState {
    const fresh: SupervisorState = {
      v: 1, pid: process.pid, mode: 'starting', since: nowIso(),
      server: { pid: null, port: null, started_at: null, restarts: 0, last_exit: null, code: this.o.base },
      safe_mode: null, health: { last_check_at: null, last_ok_at: null, failing: 0, said: null },
      releases: { current: BASE, previous: null, last_good: null, slots: [] }, deploy: null, history: [],
    };
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as SupervisorState;
      if (s.v !== 1) return fresh;
      // What carries over from the last run: releases, history, and safe mode (held until the
      // person says otherwise). A deploy cut short by a stop is said so.
      if (s.deploy?.outcome === 'running') s.deploy.outcome = 'stopped';
      return { ...fresh, releases: s.releases, history: s.history ?? [], deploy: s.deploy, safe_mode: s.safe_mode, mode: s.mode === 'safe_mode' ? 'safe_mode' : 'starting' };
    } catch {
      return fresh;
    }
  }

  #save(): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  #slot(version: string, patch: Partial<ReleaseSlot>): void {
    if (version === BASE) return;
    const list = this.state.releases.slots;
    const i = list.findIndex((s) => s.version === version);
    if (i < 0) list.push({ version, commit: null, created_at: nowIso(), status: 'ready', ...patch });
    else list[i] = { ...list[i]!, ...patch };
    this.#save();
  }

  #history(version: string, from: string | null, outcome: string, said: string): void {
    this.state.history = [{ version, from, at: nowIso(), outcome, said }, ...this.state.history].slice(0, 50);
    this.#save();
  }

  // ---- the control socket (the command line) --------------------------------------------------------

  async #listen(): Promise<void> {
    const path = join(this.o.dir, 'control.sock');
    rmSync(path, { force: true });
    this.#control = createNet((sock) => this.#serve(sock));
    await new Promise<void>((resolve, reject) => { this.#control!.once('error', reject); this.#control!.listen(path, () => resolve()); });
    chmodSync(path, 0o600);
  }

  #serve(sock: Socket): void {
    let buf = '';
    sock.on('data', (d) => {
      buf += String(d);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req: { cmd?: string; version?: string; confirm?: unknown };
      try { req = JSON.parse(line); } catch { sock.end(`${JSON.stringify({ done: true, ok: false, said: 'Not a request.' })}\n`); return; }
      const say: Say = (l) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ said: l })}\n`); };
      const end = (r: { ok: boolean; said: string }) => { if (!sock.destroyed) sock.end(`${JSON.stringify({ done: true, ...r })}\n`); };
      void (async () => {
        if (req.cmd === 'status') return end({ ok: true, said: JSON.stringify(this.state) });
        if (req.cmd === 'deploy') {
          if (req.confirm !== true) return end({ ok: false, said: 'Deploying needs your explicit confirmation every time.' });
          return end(await this.deploy(String(req.version ?? ''), say));
        }
        if (req.cmd === 'rollback') {
          if (req.confirm !== true) return end({ ok: false, said: 'Going back needs your confirmation.' });
          if (this.#deploying) return end({ ok: false, said: 'A deploy is running; it rolls back by itself if its canary fails.' });
          const target = this.state.mode === 'safe_mode' ? (this.state.safe_mode?.last_good && this.state.safe_mode.last_good !== this.state.releases.current ? this.state.safe_mode.last_good : this.state.releases.previous) : this.state.releases.previous;
          if (this.state.mode === 'safe_mode') { await this.#closePage(); this.state.safe_mode = null; this.#crashes = []; }
          return end(await this.rollback({ auto: false, reason: 'You asked to go back.', target, say }));
        }
        if (req.cmd === 'recover') return end(await this.recover());
        if (req.cmd === 'restart') return end(await this.restart());
        end({ ok: false, said: `The supervisor doesn’t know “${req.cmd}”.` });
      })().catch((e) => end({ ok: false, said: (e as Error).message }));
    });
    sock.on('error', () => {});
  }

  // ---- safe mode's page ------------------------------------------------------------------------------

  // While held, Nova's address still answers: the reason, and what to run. Loopback only.
  async #openPage(): Promise<void> {
    const port = this.state.server.port ?? (Number(this.o.env.NOVA_PORT) > 0 ? Number(this.o.env.NOVA_PORT) : null);
    if (!port || this.#page) return;
    const sm = () => this.state.safe_mode;
    this.#page = createHttp((req, res) => {
      const s = sm();
      if (req.url?.startsWith('/api/')) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, safe_mode: s, said: 'Nova is held in safe mode by its supervisor.' }));
        return;
      }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(safePage(s));
    });
    await new Promise<void>((resolve) => {
      this.#page!.once('error', () => { this.#page = null; resolve(); });
      this.#page!.listen(port, '127.0.0.1', () => resolve());
    });
  }

  async #closePage(): Promise<void> {
    const p = this.#page;
    this.#page = null;
    if (p) await new Promise<void>((r) => { p.close(() => r()); p.closeAllConnections?.(); });
  }
}

// The safe-mode page uses the design system's tokens like every page, with a plain fallback when
// the stylesheet can't be had (the server that serves it is the one held).
function safePage(s: SupervisorState['safe_mode']): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nova is in safe mode</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:40rem;background:var(--bg-base,Canvas);color:var(--text-primary,CanvasText)}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}</style></head>
<body><main><h1>Nova is in safe mode</h1><p>${esc(s?.reason ?? 'Nova is held by its supervisor.')}</p>
<p>Nothing is lost: your data is as Nova left it. To go on, run one of these on this computer:</p>
<ul>${s?.last_good ? `<li><code>node src/supervisor/main.ts rollback</code>: go back to ${esc(s.last_good)}, the last release that worked.</li>` : ''}<li><code>node src/supervisor/main.ts recover</code>: start it again once the cause is fixed.</li></ul>
${s?.output ? `<details><summary>What Nova said last</summary><pre>${esc(s.output)}</pre></details>` : ''}</main></body></html>`;
}

function readOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
