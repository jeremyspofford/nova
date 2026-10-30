// The governed change pipeline (ADR-9, M7 plan §1). A change to Nova — an extension, a design
// system, a setting, a decision template, a trigger-rule pack — is one versioned record that moves
// through fixed stages, each a ledger event with its evidence:
//
//   sandbox → tests → health → release → approval → canary → promote (or roll back by itself)
//
// Two ledger tasks carry it: "Check" (the sandbox, tests, health gates and the release; it never
// asks anyone, and a change that fails it is never offered for approval) and "Ship" (made only once
// Check is verified, at the change's tier: the person's OK, then the canary, then promotion; or the
// previous version restored, the task ending Failed with the probe's reason). The running instance
// is never edited until a change has passed every gate before it, and the gates themselves
// (gates.ts) are core and can't be changed by a change.
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Evidence, type Report, type Tier } from '../envelope.ts';
import { canonicalJson } from '../mesh/wire.ts';
import { validatePackage } from '../design.ts';
import { CANARY_PROBES, GATES, KINDS, MIN_CANARY_S, MIN_PROBE_RUNS, SANDBOX_PROBES, STAGES, weakens, type ChangeKind, type Stage } from './gates.ts';
import { KIND_OPS, type Check, type Live, type Snapshot } from './kinds.ts';
import { localGet, runProbe, type Get, type ProbeResult, type RouteLike } from './probes.ts';
import { Sandbox } from './sandbox.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Route } from '../api.ts';

export const CONFIRMATION_SYSTEM = 'nova-changes';
export const STATES = ['checking', 'stopped', 'waiting', 'canary', 'live', 'rolled_back', 'refused', 'declined', 'replaced', 'broken'] as const;
export type ChangeState = (typeof STATES)[number];
const IN_FLIGHT: readonly ChangeState[] = ['checking', 'waiting', 'canary'];
// How often the canary's probes run on the hub's own clock.
export const PROBE_EVERY_MS = 60_000;

export interface StageEntry { status: 'passed' | 'failed' | 'running'; at: string; summary: string; evidence: unknown }
export interface CanaryRun { at: string; results: ProbeResult[] }
export interface Canary { scope: string; device: string | null; started_at: string; window_s: number; ends_at: string; probes: string[]; runs: CanaryRun[]; baseline: { problem_id: number; healthy: string[] } }

export interface ChangeRecord {
  id: string; kind: ChangeKind; target: string; title: string; version: string; content_hash: string;
  artifact: Record<string, unknown>; proposed_by: string; author: string | null; tier: Tier;
  stage: Stage | 'proposed' | 'refused'; state: ChangeState; reason: string | null;
  stages: Partial<Record<Stage, StageEntry>>; canary: Canary | null; previous: Snapshot | null;
  release: { dir: string; files: { path: string; sha256: string }[]; commit: string | null; history: string } | null;
  check_task_id: string | null; ship_task_id: string | null; rollback_task_id: string | null;
  created_at: string; updated_at: string;
}

export interface Proposal { kind: unknown; artifact: unknown; canary?: unknown; [k: string]: unknown }

type Row = Record<string, string | number | null>;
const parse = <T>(s: unknown): T => (typeof s === 'string' ? JSON.parse(s) : null) as T;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const slug = (s: string) => s.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'change';

function toRecord(r: Row): ChangeRecord {
  return {
    ...(r as unknown as ChangeRecord),
    artifact: parse(r.artifact), stages: parse(r.stages) ?? {}, canary: parse(r.canary), previous: parse(r.previous), release: parse(r.release),
  };
}

export interface ChangesOptions {
  db: Db; log: Log; ledger: Ledger; verifier: Verifier; home: string; live: Live;
  // The core's routes, for probes that read them, and its health.
  routes: () => RouteLike[];
  health: () => { ok: boolean; checks: Record<string, { ok: boolean }> };
  // The hub's own device: where a design system's canary shows by default.
  hubDevice: () => string;
  privacy: () => 'local-only' | 'local-preferred' | 'cloud-allowed';
  now: () => Date;
  // This process is itself a sandbox: it answers the sandbox routes and takes no changes.
  sandbox?: boolean;
  // Canary windows on the test clock (NOVA_TEST_CLOCK): only POST /changes/tick moves them.
  testClock?: boolean;
  // The server a sandbox runs (tests may point elsewhere).
  server?: string;
}

export class Changes extends EventEmitter {
  readonly worker: LanedWorker;
  #o: ChangesOptions;
  #db: Db;
  #clock: Date | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<unknown> | null = null;
  #waiters = new Map<string, (r: { ok: boolean; why: string }) => void>();
  #get: Get;

  constructor(o: ChangesOptions) {
    super();
    this.#o = o;
    this.#db = o.db;
    this.#get = localGet(o.routes, { principal: { kind: 'console' }, listener: 'console', address: 'console' });
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e) => this.#confirm(e));
    const self = this;
    this.worker = {
      id: 'changes',
      name: 'The change pipeline',
      about: 'Tries a change in a sandbox, tests it, releases it, and ships it through a canary or puts back what was there.',
      egress: 'none',
      evidence: ['confirmation'],
      health: () => ({ ok: true }),
      // A canary runs as long as its window; nothing else waits on it.
      timeoutMs: (GATES.max_canary_s + 3600) * 1000,
      lane: (brief) => ({ key: String(brief.inputs?.change_id ?? 'change'), max: 1 }),
      // Running a step again picks up where the record says it stands.
      effects: () => 'idempotent',
      run: (brief, signal) => self.#run(brief, signal),
    };
    // The ledger verifies Check; only then is the change offered at its tier.
    o.ledger.on('task', (t: Task) => {
      if (t.owner !== this.worker.id) return;
      const step = t.brief.inputs?.step;
      const id = String(t.brief.inputs?.change_id ?? '');
      try {
        if (step === 'check' && t.state === 'done') this.#offer(id);
        if (step === 'ship' && t.state === 'cancelled') this.#declined(id, t.reason);
      } catch (e) { o.log.problem('changes', 'Nova couldn’t move a change on after its task finished.', { detail: (e as Error)?.stack ?? String(e), taskId: t.id }); }
    });
  }

  now(): Date {
    return this.#clock ?? this.#o.now();
  }

  // ---- reading ----------------------------------------------------------------------------------

  get(id: string): ChangeRecord {
    const row = this.#db.get<Row>('SELECT * FROM change_record WHERE id = ?', id);
    if (!row) throw new CoreError('not_found', `No change ${id}.`);
    return toRecord(row);
  }

  list(limit = 100): ChangeRecord[] {
    return this.#db.all<Row>('SELECT * FROM change_record ORDER BY created_at DESC, rowid DESC LIMIT ?', Math.min(Math.max(limit, 1), 500)).map(toRecord);
  }

  // What the person sees: the status in Nova's one vocabulary, in plain words.
  view(c: ChangeRecord) {
    const { artifact: _a, previous: _p, ...rest } = c;
    const ops = KIND_OPS[c.kind];
    let asks: string[] = [];
    try { asks = ops.asks(c.artifact); } catch { /* shown as stored */ }
    const prev = this.#liveBefore(c);
    return {
      ...rest,
      // Rolled back by the person is their decision, not a failure.
      status: c.state === 'rolled_back' && c.reason?.startsWith('You rolled') ? 'Quiet' : STATUS[c.state],
      words: this.#words(c),
      asks,
      previous_version: prev?.version ?? null,
      needs_ok: c.state === 'waiting',
      can_roll_back: c.state === 'canary' || (c.state === 'live' && this.#latestLive(c.target)?.id === c.id),
      stages_in_order: STAGES.map((s) => ({ stage: s, ...(c.stages[s] ?? { status: 'pending' }) })),
    };
  }

  // For /health: a change Nova couldn't put back is the one thing here that isn't healthy.
  health() {
    const counts = Object.fromEntries(this.#db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM change_record GROUP BY state').map((r) => [r.state, r.n]));
    const broken = counts.broken ?? 0;
    return { ok: broken === 0, counts, ...(broken ? { detail: `${broken} change${broken === 1 ? '' : 's'} couldn’t be rolled back; see Settings › Changes.` } : {}) };
  }

  overview() {
    const changes = this.list().map((c) => this.view(c));
    // One standout: the change that waits for the person, the highest tier first.
    // The list is newest first, so among equals the last is the one that has waited longest.
    const waiting = changes.map((c, i) => ({ c, i })).filter((x) => x.c.needs_ok).sort((a, b) => b.c.tier - a.c.tier || a.c.created_at.localeCompare(b.c.created_at) || b.i - a.i);
    return { changes, standout: waiting[0]?.c.id ?? null, gates: GATES };
  }

  // ---- proposing ----------------------------------------------------------------------------------

  // `by`: person, foundry or provider:<id>. Anything the foundry or a provider proposed is a
  // self-modification deploy: tier 3, confirmed every time (NOVA-SPEC §6).
  propose(p: Proposal, o: { by?: string; author?: string | null } = {}): ChangeRecord {
    if (this.#o.sandbox) throw new CoreError('conflict', 'This is a sandbox copy of Nova: it doesn’t take changes.');
    if (!isObj(p)) throw new CoreError('validation', 'A change is {kind, artifact, canary?}.');
    const kind = p.kind as ChangeKind;
    if (!KINDS.includes(kind)) throw new CoreError('validation', `kind must be one of ${KINDS.join(', ')}.`);
    if (!isObj(p.artifact)) throw new CoreError('validation', 'artifact is the change itself: an object.');
    const by = o.by ?? 'person';
    if (!/^(person|foundry|provider:[a-z0-9][a-z0-9._-]{0,63})$/.test(by)) throw new CoreError('validation', 'proposed_by is person, foundry or provider:<id>.');
    const ops = KIND_OPS[kind];
    const artifact = p.artifact;
    const weak = weakens(kind, p, artifact);
    let shape: { target: string; title: string; version: string };
    try { shape = ops.shape(artifact); } catch (e) {
      if (!weak) throw e;
      shape = { target: `${kind}:unknown`, title: `A ${kind} change`, version: '0.0.0' };
    }
    const at = this.now().toISOString();
    const id = randomUUID();
    const hash = sha256(canonicalJson(artifact));
    if (weak) {
      // Kept, so the attempt is on the record; nothing of it ran.
      this.#insert({ id, kind, ...shape, hash, artifact, by, author: o.author ?? null, tier: 3, stage: 'refused', state: 'refused', reason: weak, at });
      this.#o.log.warn('changes', `Refused a change that tried to weaken a gate: ${weak}`, { change: id });
      this.emit('change', { id, state: 'refused' });
      throw new CoreError('forbidden', `Refused: ${weak}`, [id]);
    }
    const busy = this.#db.get<{ id: string; title: string; state: string }>(`SELECT id, title, state FROM change_record WHERE target = ? AND state IN (${IN_FLIGHT.map(() => '?').join(', ')}) LIMIT 1`, shape.target, ...IN_FLIGHT);
    if (busy) throw new CoreError('conflict', `“${busy.title}” is already on its way through the pipeline (${busy.state}). One change at a time per thing it changes.`);
    const tier = Math.max(ops.tier(artifact, this.#o.live), by === 'person' ? 1 : 3) as Tier;
    const window = isObj(p.canary) && Number.isInteger(p.canary.window_s) ? p.canary.window_s as number : MIN_CANARY_S[kind];
    const device = isObj(p.canary) && typeof p.canary.device_id === 'string' ? p.canary.device_id : null;
    this.#insert({ id, kind, ...shape, hash, artifact, by, author: o.author ?? null, tier, stage: 'proposed', state: 'checking', reason: 'Checking it in a sandbox.', at, canary: { window_s: window, device } });
    const task = this.#o.ledger.create({
      title: `Check “${shape.title}” v${shape.version}`,
      owner: this.worker.id,
      goal: `Try ${shape.title} v${shape.version} on a sandbox copy of Nova: its tests, Nova’s checks and the health gates pass, and it is released as a version.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'confirmation', note: 'released' }],
      inputs: { change_id: id, step: 'check' },
      privacy_mode: 'local-only',
      approval_tier: 0,
      idempotency_key: `change:${id}:check`,
    });
    this.#update(id, { check_task_id: task.id });
    this.emit('change', { id, state: 'checking' });
    return this.get(id);
  }

  // ---- the person's part ------------------------------------------------------------------------

  // The OK a waiting change asks for. Tier 3 needs {confirm: true}, every time.
  ship(id: string, o: { confirm?: boolean } = {}): ChangeRecord {
    const c = this.get(id);
    if (!c.ship_task_id) throw new CoreError('conflict', `“${c.title}” hasn’t passed ${this.#nextGate(c)} yet. A change can’t skip a stage.`);
    if (c.state !== 'waiting') throw new CoreError('conflict', `“${c.title}” isn’t waiting for an OK (${STATUS[c.state]}).`);
    this.#o.ledger.approve(c.ship_task_id, { confirm: o.confirm === true });
    return this.get(id);
  }

  // Not now: the waiting change goes no further; nothing of it went live.
  decline(id: string): ChangeRecord {
    const c = this.get(id);
    if (c.state !== 'waiting' || !c.ship_task_id) throw new CoreError('conflict', `“${c.title}” isn’t waiting for an OK.`);
    this.#o.ledger.cancel(c.ship_task_id, 'You said not now.');
    return this.get(id);
  }

  // Rolling back a live change by hand is always available, at tier 2: {confirm: true} is the
  // person's OK, given on the screen that asked.
  rollback(id: string, o: { confirm?: boolean } = {}): ChangeRecord {
    const c = this.get(id);
    if (c.state === 'live' && this.#latestLive(c.target)?.id !== c.id) throw new CoreError('conflict', `A newer change to ${c.title} is live; roll that one back instead.`);
    if (c.state !== 'live' && c.state !== 'canary') throw new CoreError('conflict', `“${c.title}” isn’t live, so there’s nothing to roll back.`);
    if (o.confirm !== true) throw new CoreError('validation', `Rolling back “${c.title}” puts back ${this.#liveBefore(c) ? `v${this.#liveBefore(c)!.version}` : 'how it was before'}. It needs your OK: send confirm: true.`);
    const task = this.#o.ledger.create({
      title: `Roll back “${c.title}” v${c.version}`,
      owner: this.worker.id,
      goal: `${c.title} is as it was before v${c.version}, and nothing else changed.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'confirmation', note: 'rolled back' }],
      inputs: { change_id: id, step: 'rollback' },
      privacy_mode: 'local-only',
      approval_tier: 2,
      idempotency_key: `change:${id}:rollback:${randomUUID()}`,
    });
    this.#update(id, { rollback_task_id: task.id });
    this.#o.ledger.approve(task.id);
    return this.get(id);
  }

  // Moves a change into a stage, refusing any that would skip one. The pipeline only ever calls it
  // in order; anything else asking is refused the same way.
  enter(id: string, stage: Stage, entry: Omit<StageEntry, 'at'> & { at?: string }): ChangeRecord {
    const c = this.get(id);
    const i = STAGES.indexOf(stage);
    if (i < 0) throw new CoreError('validation', `There is no stage called ${stage}.`);
    const missing = STAGES.slice(0, i).find((s) => c.stages[s]?.status !== 'passed');
    if (missing) throw new CoreError('conflict', `“${c.title}” can’t enter ${stage}: ${missing} hasn’t passed. A change can’t skip a stage.`);
    if (c.state === 'refused' || c.state === 'stopped') throw new CoreError('conflict', `“${c.title}” was ${c.state}; it goes no further.`);
    const e: StageEntry = { status: entry.status, at: entry.at ?? this.now().toISOString(), summary: entry.summary, evidence: entry.evidence };
    const stages = { ...c.stages, [stage]: e };
    this.#update(id, { stages: JSON.stringify(stages), stage });
    // Every stage is a ledger event with its evidence, on the task doing it.
    const task = i <= STAGES.indexOf('release') ? c.check_task_id : stage === 'promote' || stage === 'canary' || stage === 'approval' ? c.ship_task_id : null;
    if (task) { try { this.#o.ledger.note(task, 'stage', { stage, ...e }); } catch { /* the record keeps it */ } }
    this.emit('change', { id, state: c.state, stage });
    return this.get(id);
  }

  // ---- the clock ----------------------------------------------------------------------------------

  start(): void {
    if (this.#o.sandbox || this.#o.testClock || this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch((e) => this.#o.log.problem('changes', 'The canary’s probes couldn’t run.', { detail: (e as Error)?.stack ?? String(e) })); }, PROBE_EVERY_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // Runs every canary's probes now; a failure rolls that change back, and a window that has run
  // its course with every probe passing at least MIN_PROBE_RUNS times is promoted. `at` sets the
  // test clock (NOVA_TEST_CLOCK), which only moves forward.
  async tick(at?: Date): Promise<{ id: string; state: ChangeState; why: string }[]> {
    if (at) {
      if (Number.isNaN(at.getTime())) throw new CoreError('validation', 'now must be an ISO time.');
      if (!this.#clock || at > this.#clock) this.#clock = at;
    }
    while (this.#ticking) await this.#ticking;
    const run = (async () => {
      const out: { id: string; state: ChangeState; why: string }[] = [];
      for (const c of this.list(500).filter((x) => x.state === 'canary' && x.canary?.started_at)) out.push(await this.#watch(c));
      return out;
    })();
    this.#ticking = run;
    try { return await run; } finally { this.#ticking = null; }
  }

  // ---- routes -------------------------------------------------------------------------------------

  routes(): Route[] {
    const r: Route[] = [
      { method: 'GET', path: '/changes', summary: 'Every change through the pipeline, newest first: its stage, status in plain words, and the one waiting for you (standout).', handle: () => this.overview() },
      { method: 'GET', path: '/changes/gates', summary: 'The pipeline’s gates: the stages in order, the shortest canary per kind, the probe sets. Core: no change can alter them.', handle: () => GATES },
      {
        method: 'POST', path: '/changes', status: 201, summary: 'Propose a change: it is tried in a sandbox, tested, released, then offered at its tier.',
        body: '{kind: extension | design-system | config | template | trigger-rules, artifact, canary?: {window_s?, device_id?}, proposed_by?: provider:<id>}',
        handle: ({ body }) => this.view(this.propose(body as Proposal, { by: typeof body.proposed_by === 'string' && body.proposed_by.startsWith('provider:') ? body.proposed_by : 'person' })),
      },
      { method: 'GET', path: '/changes/{id}', summary: 'One change: every stage with its evidence, the canary’s probe runs, what it asks for, what it replaces.', handle: ({ params }) => ({ ...this.view(this.get(params.id!)), artifact: this.get(params.id!).artifact }) },
      { method: 'POST', path: '/changes/{id}/ship', summary: 'Ship it: the OK a waiting change asks for, after its sandbox evidence. Tier 3 needs {confirm: true}, every time.', body: '{confirm?}', handle: ({ params, body }) => this.view(this.ship(params.id!, { confirm: body.confirm === true })) },
      { method: 'POST', path: '/changes/{id}/decline', summary: 'Not now: the waiting change goes no further.', handle: ({ params }) => this.view(this.decline(params.id!)) },
      { method: 'POST', path: '/changes/{id}/rollback', summary: 'Roll back a live change (or one in its canary) by hand: tier 2, {confirm: true}. What was there before comes back; nothing else changes.', body: '{confirm}', handle: ({ params, body }) => this.view(this.rollback(params.id!, { confirm: body.confirm === true })) },
    ];
    if (this.#o.testClock) {
      r.push({
        method: 'POST', path: '/changes/tick', summary: 'Test only: run the canaries’ probes as if it were the given time.', body: '{now?}',
        handle: async ({ body }) => this.tick(body.now === undefined ? undefined : new Date(String(body.now))),
      });
    }
    if (this.#o.sandbox) {
      // Only a sandbox answers these: the parent applies and tests a change here, never live.
      r.push(
        {
          method: 'POST', path: '/changes/sandbox/apply', summary: 'Sandbox only: apply a change to this copy, for everyone.', body: '{kind, artifact, change_id}',
          handle: async ({ body }) => {
            const ops = KIND_OPS[body.kind as ChangeKind];
            if (!ops || !isObj(body.artifact)) throw new CoreError('validation', 'kind and artifact are required.');
            await ops.apply(body.artifact, this.#o.live, { scope: 'full', device: null, by: `change:${String(body.change_id)}` });
            return { applied: true };
          },
        },
        {
          method: 'POST', path: '/changes/sandbox/test', summary: 'Sandbox only: the change’s own tests and Nova’s checks, on this copy.', body: '{kind, artifact}',
          handle: async ({ body }) => {
            const ops = KIND_OPS[body.kind as ChangeKind];
            if (!ops || !isObj(body.artifact)) throw new CoreError('validation', 'kind and artifact are required.');
            return { checks: await ops.test(body.artifact, this.#o.live) };
          },
        },
      );
    }
    return r;
  }

  // ---- the work -----------------------------------------------------------------------------------

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    const report = (status: Report['status'], summary: string, evidence: Evidence[] = []): Report => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence, artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
      usage: { duration_ms: Math.round(performance.now() - started) },
    });
    const id = String(brief.inputs?.change_id ?? '');
    let c: ChangeRecord;
    try { c = this.get(id); } catch (e) { return report('failed', (e as Error).message); }
    const step = brief.inputs?.step;
    if (step === 'check') return this.#check(c, signal, report);
    if (step === 'ship') return this.#ship(c, brief, signal, report);
    if (step === 'rollback') return this.#rollbackStep(c, report);
    return report('failed', `There is no step called ${String(step)}.`);
  }

  // Stages 1–4. Any failure stops the change where it is, with the reason; it is never offered.
  async #check(c: ChangeRecord, signal: AbortSignal, report: (s: Report['status'], m: string, e?: Evidence[]) => Report): Promise<Report> {
    if (c.state !== 'checking') return c.state === 'stopped' ? report('failed', c.reason ?? 'It stopped.') : report('done', 'Already released.', [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${c.id}@released` }]);
    const ops = KIND_OPS[c.kind];
    const stop = (stage: Stage, why: string, evidence: unknown) => {
      this.enter(c.id, stage, { status: 'failed', summary: why, evidence });
      this.#update(c.id, { state: 'stopped', reason: `Stopped at ${stage}: ${why}` });
      this.emit('change', { id: c.id, state: 'stopped' });
      return report('failed', `Stopped at ${stage}: ${why} It won’t be offered for approval.`);
    };
    // Contract checks first: they need no sandbox, and are part of the tests stage's evidence.
    const contract = ops.contract(c.artifact, this.#o.privacy(), this.#o.live);
    const healthLive = this.#o.health();
    const sandbox = new Sandbox(join(this.#o.home, 'workers', 'changes', c.id));
    try {
      // 1. Sandbox.
      let info;
      try {
        info = await sandbox.start({ db: this.#db, liveHome: this.#o.home, files: this.#neededFiles(c), timezone: this.#o.live.timezone(), signal, ...(this.#o.server ? { server: this.#o.server } : {}) });
      } catch (e) { return stop('sandbox', `Nova couldn’t start a sandbox copy: ${(e as Error).message}`, { output: sandbox.output().slice(-2000) }); }
      const applied = await sandbox.call('POST', '/changes/sandbox/apply', { kind: c.kind, artifact: c.artifact, change_id: c.id });
      const sandboxEvidence = { home: `workers/changes/${c.id}/home`, pid: info.pid, port: info.port, snapshot_bytes: info.snapshot_bytes, started_ms: info.started_ms, copied: info.copied, applied: applied.status === 200 };
      if (applied.status !== 200) {
        const why = isObj(applied.body) && typeof applied.body.error === 'string' ? `${applied.body.error}${Array.isArray(applied.body.details) ? ` ${applied.body.details.join(' ')}` : ''}` : `the sandbox answered ${applied.status}`;
        // A change that can't even be applied fails its own tests: the contract says why.
        const failing = contract.find((x) => !x.ok);
        this.enter(c.id, 'sandbox', { status: 'passed', summary: `A sandbox copy of Nova started (${Math.round(info.snapshot_bytes / 1024)} KB snapshot); the change couldn’t be applied to it.`, evidence: sandboxEvidence });
        return stop('tests', failing ? failing.why : `It couldn’t be applied in the sandbox: ${why}`, { contract, apply: why });
      }
      this.enter(c.id, 'sandbox', { status: 'passed', summary: `Applied to a sandbox copy of Nova (snapshot ${Math.round(info.snapshot_bytes / 1024)} KB, started in ${info.started_ms} ms).`, evidence: sandboxEvidence });
      if (signal.aborted) throw signal.reason;

      // 2. Tests: the change's own, the contract checks, and Nova's checks on the sandbox.
      const own = await sandbox.call('POST', '/changes/sandbox/test', { kind: c.kind, artifact: c.artifact });
      const ownChecks: Check[] = own.status === 200 && isObj(own.body) && Array.isArray(own.body.checks) ? own.body.checks as Check[] : [{ name: 'tests', ok: false, why: `The sandbox couldn’t run its tests (${own.status}).` }];
      const tests = [...contract, ...ownChecks];
      const failed = tests.filter((x) => !x.ok);
      if (failed.length) return stop('tests', failed.map((x) => x.why).join(' '), { contract, own: ownChecks });
      this.enter(c.id, 'tests', { status: 'passed', summary: `${tests.length} checks passed: contract (${contract.length}) and its own tests with Nova’s checks (${ownChecks.length}).`, evidence: { contract, own: ownChecks } });

      // 3. Health gates: /health, the fixed core probes, and the change's own probe.
      const probes = await this.#sandboxProbes(sandbox, healthLive, ops.probe(c.artifact));
      const bad = probes.filter((x) => !x.ok);
      if (bad.length) return stop('health', bad.map((x) => x.why).join(' '), { probes });
      this.enter(c.id, 'health', { status: 'passed', summary: `Health and ${probes.length - 1} smoke probes passed on the sandbox.`, evidence: { probes } });
    } finally {
      await sandbox.stop();
    }

    // 4. Versioned release: the artifact and its hash, in the home's change history.
    const release = this.#release(this.get(c.id));
    this.#update(c.id, { release: JSON.stringify(release) });
    this.enter(c.id, 'release', { status: 'passed', summary: `Released v${c.version} (${c.content_hash.slice(0, 12)}…)${release.commit ? `, committed as ${release.commit.slice(0, 10)}` : ''}. ${release.history}`, evidence: release });
    return report('done', `“${c.title}” v${c.version} passed the sandbox, its tests and the health gates, and is released.`, [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${c.id}@released` }]);
  }

  async #sandboxProbes(sandbox: Sandbox, live: { checks: Record<string, { ok: boolean }> }, own: ReturnType<typeof KIND_OPS['config']['probe']>): Promise<ProbeResult[]> {
    const out: ProbeResult[] = [];
    const say = (name: string, ok: boolean, why: string) => out.push({ name, ok, why });
    const errorOf = (b: unknown) => (isObj(b) && typeof b.error === 'string' ? b.error : JSON.stringify(b)?.slice(0, 120));
    for (const p of SANDBOX_PROBES) {
      try {
        if (p === 'health') {
          const h = await sandbox.call('GET', '/health');
          const checks = isObj(h.body) && isObj(h.body.checks) ? h.body.checks as Record<string, { ok: boolean }> : {};
          // Everything that is healthy live must be healthy on the copy with the change in it.
          const worse = Object.entries(live.checks).filter(([k, v]) => v.ok && SANDBOX_HEALTH.includes(k) && checks[k]?.ok !== true).map(([k]) => k);
          say('health', h.status === 200 && !worse.length, h.status !== 200 ? `/health answered ${h.status}.` : worse.length ? `On the sandbox, ${worse.join(', ')} ${worse.length === 1 ? 'is' : 'are'} not healthy.` : '/health: every part that is healthy live is healthy with the change.');
        } else if (p === 'setup') {
          const s = await sandbox.call('GET', '/setup');
          say('setup', s.status === 200 && isObj(s.body) && typeof s.body.done === 'boolean', s.status === 200 ? `Setup answers (${isObj(s.body) && s.body.done ? 'done' : 'not finished'}).` : `/setup answered ${s.status}.`);
        } else if (p === 'ledger') {
          const t = await sandbox.call('POST', '/tasks', { title: 'Sandbox probe: write a file', owner: 'workspace', goal: 'A file is written and read back.', evidence_required: [{ kind: 'read_back', target: 'workspace:nova-probe.txt' }], inputs: { action: 'write', path: 'nova-probe.txt', content: 'probe' }, privacy_mode: 'local-only', approval_tier: 0 });
          const tid = isObj(t.body) ? String(t.body.id) : '';
          let state = '';
          for (let i = 0; i < 200 && t.status === 201; i++) {
            const got = (await sandbox.call('GET', `/tasks/${tid}`)).body;
            state = isObj(got) ? String(got.state) : '';
            if (['done', 'failed', 'cancelled'].includes(state)) break;
            await new Promise((r) => setTimeout(r, 25));
          }
          say('ledger', state === 'done', state === 'done' ? 'A ledger task ran and was verified.' : `A ledger task ended ${state || `unmade (${errorOf(t.body)})`}.`);
        } else if (p === 'memory') {
          const words = `sandbox probe ${randomUUID().slice(0, 8)}`;
          const m = await sandbox.call('POST', '/memory', { kind: 'fact', content: words });
          const found = await sandbox.call('GET', `/memory/search?q=${encodeURIComponent(words)}`);
          const hit = JSON.stringify(found.body).includes(words);
          const gone = m.status === 201 && isObj(m.body) ? (await sandbox.call('DELETE', `/memory/${String(m.body.id)}`)).status === 200 : false;
          say('memory', m.status === 201 && hit && gone, m.status !== 201 ? `Remembering failed: ${errorOf(m.body)}` : !hit ? 'A memory wasn’t found again.' : !gone ? 'A memory couldn’t be forgotten.' : 'Remembered, found and forgotten.');
        } else if (p === 'approval') {
          const t = await sandbox.call('POST', '/tasks', { title: 'Sandbox probe: needs an OK', owner: 'workspace', goal: 'It waits for an OK.', evidence_required: [{ kind: 'read_back', target: 'workspace:nova-probe-ok.txt' }], inputs: { action: 'write', path: 'nova-probe-ok.txt', content: 'ok' }, privacy_mode: 'local-only', approval_tier: 2 });
          const ok = t.status === 201 && isObj(t.body) && t.body.state === 'waiting' && /Needs your OK/.test(String(t.body.reason));
          if (t.status === 201 && isObj(t.body)) await sandbox.call('POST', `/tasks/${String(t.body.id)}/cancel`, { reason: 'Probe done.' });
          say('approval', ok, ok ? 'A tier-2 task waited for an OK.' : `A tier-2 task didn’t wait for an OK: ${errorOf(t.body)}`);
        } else if (p === 'privacy') {
          const t = await sandbox.call('POST', '/tasks', { title: 'Sandbox probe: privacy', owner: 'browser', goal: 'Refused: it would leave the devices.', privacy_mode: 'local-only', evidence_required: [{ kind: 'url' }], inputs: { allowed_hosts: ['example.com'], steps: [{ do: 'navigate', url: 'https://example.com/' }], verify: { expect: ['Example'] } } });
          const refused = t.status === 400 && /off your devices/.test(errorOf(t.body) ?? '');
          say('privacy', refused, refused ? 'A local-only task that would leave the devices was refused.' : `A local-only task that would leave the devices wasn’t refused (${t.status}).`);
        }
      } catch (e) {
        say(p, false, `${p}: ${(e as Error).message}`);
      }
    }
    if (own) out.push(await runProbe(own, (path) => sandbox.call('GET', path)));
    return out;
  }

  // What a sandbox needs besides the database: an extension's own folder.
  #neededFiles(c: ChangeRecord): string[] {
    if (c.kind !== 'extension') return [];
    const id = String((c.artifact.manifest as Record<string, unknown>).id);
    return existsSync(join(this.#o.home, 'extensions', id)) ? [`extensions/${id}`] : [];
  }

  // The release: files in the home's change history (changes/<target>/<version>-<id>/), committed
  // when the home keeps history. Files only: the artifact passed the privacy check, so it holds no
  // secret values; the previous version's release stays where it is.
  #release(c: ChangeRecord): NonNullable<ChangeRecord['release']> {
    const rel = `changes/${slug(c.target)}/${slug(c.version)}-${c.id.slice(0, 8)}`;
    const dir = join(this.#o.home, rel);
    mkdirSync(dir, { recursive: true });
    const before = this.#liveBefore(c);
    const files: Record<string, string> = {
      'artifact.json': canonicalJson(c.artifact),
      'change.json': `${JSON.stringify({ id: c.id, kind: c.kind, target: c.target, title: c.title, version: c.version, content_hash: c.content_hash, proposed_by: c.proposed_by, author: c.author, tier: c.tier, replaces: before ? { id: before.id, version: before.version } : null, created_at: c.created_at }, null, 2)}\n`,
      'evidence.json': `${JSON.stringify(c.stages, null, 2)}\n`,
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const out = { dir: rel, files: Object.entries(files).map(([path, text]) => ({ path: `${rel}/${path}`, sha256: sha256(text) })), commit: null as string | null, history: '' };
    if (!existsSync(join(this.#o.home, '.git'))) { out.history = 'This home keeps no git history, so the files are its record.'; return out; }
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', this.#o.home, ...args], { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      git('add', '--', rel);
      git('-c', 'user.name=Nova', '-c', 'user.email=nova@localhost', 'commit', '-q', '-m', `Nova: release ${c.title} v${c.version} (${c.kind})`, '--', rel);
      out.commit = git('rev-parse', 'HEAD');
      out.history = 'Committed to the home’s change history.';
    } catch (e) {
      out.history = `The files are written; git couldn’t commit them (${((e as Error).message.split('\n')[0] ?? '').slice(0, 120)}).`;
    }
    return out;
  }

  // Check is verified: the change is offered at its tier, with the sandbox evidence.
  #offer(id: string): void {
    const c = this.get(id);
    if (c.ship_task_id || c.state !== 'checking') return;
    const task = this.#o.ledger.create({
      title: `Ship “${c.title}” v${c.version}`,
      owner: this.worker.id,
      goal: `${c.title} v${c.version} goes live: first in a canary (${this.#scopeWords(c)}) with its probes over ${Math.round((c.canary?.window_s ?? MIN_CANARY_S[c.kind]) / 60)} minutes, then for everyone; or what was there before comes back by itself.`,
      origin: { kind: 'user' },
      context_refs: [{ kind: 'task', ref: c.check_task_id! }],
      evidence_required: [{ kind: 'confirmation', note: 'live' }],
      inputs: { change_id: id, step: 'ship' },
      privacy_mode: 'local-only',
      approval_tier: c.tier,
      idempotency_key: `change:${id}:ship`,
    });
    const waiting = task.state === 'waiting';
    this.#update(id, { ship_task_id: task.id, state: waiting ? 'waiting' : 'canary', reason: waiting ? (c.tier === 3 ? 'Waiting for your OK. It changes Nova itself, so it is confirmed every time.' : 'Waiting for your OK.') : 'Going live in a canary.' });
    this.emit('change', { id, state: waiting ? 'waiting' : 'canary' });
  }

  #declined(id: string, why: string | null): void {
    const c = this.get(id);
    if (c.state !== 'waiting') return;
    this.#update(id, { state: 'declined', reason: why ?? 'Not now.' });
    this.emit('change', { id, state: 'declined' });
  }

  // Stages 5–7.
  async #ship(c: ChangeRecord, brief: Brief, signal: AbortSignal, report: (s: Report['status'], m: string, e?: Evidence[]) => Report): Promise<Report> {
    if (c.state === 'live') return report('done', `“${c.title}” v${c.version} is live.`, [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${c.id}@live` }]);
    if (c.state === 'rolled_back') return report('failed', c.reason ?? 'It was rolled back.');
    if (c.state !== 'waiting' && c.state !== 'canary') return report('failed', `“${c.title}” is ${STATUS[c.state]}; it can’t ship.`);
    const ops = KIND_OPS[c.kind];
    const task = this.#o.ledger.get(brief.task_id);
    if (c.stages.approval?.status !== 'passed') {
      const sandboxed = STAGES.slice(0, 4).map((s) => `${s}: ${c.stages[s]?.summary ?? ''}`);
      this.enter(c.id, 'approval', {
        status: 'passed',
        summary: c.tier >= 2 ? `OK’d at tier ${c.tier}${c.tier === 3 ? ', confirmed' : ''}, after the sandbox evidence.` : `Tier ${c.tier}: Nova acts and reports.`,
        evidence: { tier: c.tier, approved_at: task.approved_at, confirmed: c.tier === 3, proposed_by: c.proposed_by, shown: sandboxed },
      });
    }
    let cur = this.get(c.id);
    if (!cur.canary?.started_at) {
      // What is live now is kept before anything changes: a rollback puts exactly this back.
      const previous = cur.previous ?? ops.snapshot(cur.artifact, this.#o.live);
      const device = cur.kind === 'design-system' ? cur.canary?.device ?? this.#o.hubDevice() : null;
      const start = this.now();
      const window = cur.canary?.window_s ?? MIN_CANARY_S[cur.kind];
      const health = this.#o.health();
      const canary: Canary = {
        scope: this.#scopeWords(cur), device, started_at: start.toISOString(), window_s: window, ends_at: new Date(start.getTime() + window * 1000).toISOString(),
        probes: [...CANARY_PROBES.filter((p) => p !== 'own' || ops.probe(cur.artifact))], runs: [],
        baseline: { problem_id: this.#db.get<{ m: number | null }>('SELECT MAX(id) AS m FROM problem')?.m ?? 0, healthy: Object.entries(health.checks).filter(([, v]) => v.ok).map(([k]) => k) },
      };
      this.#update(c.id, { previous: JSON.stringify(previous), canary: JSON.stringify(canary), state: 'canary', reason: `In its canary until ${canary.ends_at}.` });
      try {
        await ops.apply(cur.artifact, this.#o.live, { scope: 'canary', device, by: `change:${cur.id}` });
      } catch (e) {
        const why = `It couldn’t go live: ${(e as Error).message}`;
        await this.#rollback(this.get(c.id), why, 'auto');
        return report('failed', `${why} What was there before is back.`);
      }
      this.enter(c.id, 'canary', { status: 'running', summary: `Live on ${canary.scope} until ${canary.ends_at}; probes: ${canary.probes.join(', ')}.`, evidence: { scope: canary.scope, window_s: window, probes: canary.probes } });
      this.#update(c.id, { state: 'canary' });
      this.emit('change', { id: c.id, state: 'canary' });
      cur = this.get(c.id);
    }
    // The canary is watched by the clock (tick); this task waits for its outcome.
    const outcome = await new Promise<{ ok: boolean; why: string }>((resolve, reject) => {
      const now = this.get(c.id);
      if (now.state === 'live') return resolve({ ok: true, why: 'Promoted.' });
      if (now.state === 'rolled_back' || now.state === 'broken') return resolve({ ok: false, why: now.reason ?? 'Rolled back.' });
      this.#waiters.set(c.id, resolve);
      signal.addEventListener('abort', () => {
        this.#waiters.delete(c.id);
        // Stopped mid-canary (cancelled, or out of time): what was there before comes back.
        void this.#rollback(this.get(c.id), 'The canary was stopped before it finished.', 'auto').finally(() => reject(signal.reason));
      }, { once: true });
    });
    if (outcome.ok) return report('done', `“${c.title}” v${c.version} passed its canary and is live for everyone.`, [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${c.id}@live` }]);
    return report('failed', outcome.why);
  }

  async #rollbackStep(c: ChangeRecord, report: (s: Report['status'], m: string, e?: Evidence[]) => Report): Promise<Report> {
    if (c.state === 'rolled_back') return report('done', `“${c.title}” is rolled back.`, [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${c.id}@rolled_back` }]);
    if (c.state !== 'live' && c.state !== 'canary') return report('failed', `“${c.title}” isn’t live.`);
    await this.#rollback(c, 'You rolled it back.', 'manual');
    const after = this.get(c.id);
    if (after.state !== 'rolled_back') return report('failed', after.reason ?? 'Nova couldn’t put back what was there before.');
    return report('done', `“${c.title}” v${c.version} is rolled back; ${this.#liveBefore(c) ? `v${this.#liveBefore(c)!.version}` : 'how it was before'} is back, and nothing else changed.`, [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${c.id}@rolled_back` }]);
  }

  // One look at a canary: every probe, then promote, roll back, or keep watching.
  async #watch(c: ChangeRecord): Promise<{ id: string; state: ChangeState; why: string }> {
    const canary = c.canary!;
    const results = await this.#canaryProbes(c);
    const run: CanaryRun = { at: this.now().toISOString(), results };
    const runs = [...canary.runs, run].slice(-50);
    this.#update(c.id, { canary: JSON.stringify({ ...canary, runs }) });
    const failed = results.find((r) => !r.ok);
    if (failed) {
      await this.#rollback(this.get(c.id), `The canary’s probe failed: ${failed.why}`, 'auto');
      return { id: c.id, state: 'rolled_back', why: failed.why };
    }
    const passes = runs.filter((r) => r.results.every((x) => x.ok)).length;
    if (this.now() >= new Date(canary.ends_at) && passes >= MIN_PROBE_RUNS) {
      await this.#promote(this.get(c.id), passes);
      return { id: c.id, state: this.get(c.id).state, why: 'Promoted.' };
    }
    this.emit('change', { id: c.id, state: 'canary' });
    return { id: c.id, state: 'canary', why: `Probes passing (${passes} run${passes === 1 ? '' : 's'}).` };
  }

  async #canaryProbes(c: ChangeRecord): Promise<ProbeResult[]> {
    const canary = c.canary!;
    const ops = KIND_OPS[c.kind];
    const out: ProbeResult[] = [];
    // Health: whatever was healthy when the canary began still is.
    const h = this.#o.health();
    const worse = canary.baseline.healthy.filter((k) => h.checks[k]?.ok !== true);
    out.push({ name: 'health', ok: !worse.length, why: worse.length ? `Since the change, ${worse.join(', ')} ${worse.length === 1 ? 'is' : 'are'} not healthy.` : 'Everything that was healthy still is.' });
    // Problems opened since the change, in the area it touched.
    const area = ops.area(c.artifact);
    const opened = this.#db.all<{ id: number; source: string; message: string }>('SELECT id, source, message FROM problem WHERE id > ? ORDER BY id', canary.baseline.problem_id)
      .filter((p) => area.includes(p.source));
    out.push({ name: 'problems', ok: !opened.length, why: opened.length ? `A problem opened since the change: ${opened[0]!.message}` : 'No problems opened since the change.' });
    out.push(this.#errors(c));
    const own = ops.probe(c.artifact);
    if (own) out.push(await runProbe(own, this.#get));
    return out;
  }

  // The error rate on the touched area, per kind.
  #errors(c: ChangeRecord): ProbeResult {
    const since = c.canary!.started_at;
    if (c.kind === 'trigger-rules') {
      const pack = (c.artifact.pack as { id: string }).id;
      const rows = this.#db.all<{ triage: string | null; state: string | null }>(
        `SELECT t.triage, k.state FROM trigger t JOIN trigger_rule r ON r.id = t.rule_id LEFT JOIN task k ON k.id = t.ledger_task_id WHERE r.created_by = ? AND t.at >= ?`, `changes:${pack}`, since);
      const broken = rows.filter((r) => (r.triage ?? '').includes('couldn') || r.state === 'failed');
      return { name: 'errors', ok: !broken.length, why: broken.length ? `${broken.length} of ${rows.length} of its firings went wrong since the change.` : `${rows.length} firing${rows.length === 1 ? '' : 's'} since the change, none went wrong.` };
    }
    if (c.kind === 'design-system') {
      const id = String((c.artifact.manifest as Record<string, unknown>).id);
      const device = c.canary!.device;
      const shown = this.#o.live.design.active(device).id;
      const installed = this.#o.live.extensions.list().find((x) => x.id === id);
      const v = installed ? validatePackage(installed.manifest) : { ok: false, problems: ['it isn’t installed'] };
      if (shown !== id) return { name: 'errors', ok: false, why: `The canary device shows ${shown}, not ${id}.` };
      return { name: 'errors', ok: v.ok, why: v.ok ? 'The canary device shows it, and its contrast holds in every mode.' : `Its live check failed: ${v.problems[0]}` };
    }
    if (c.kind === 'template') {
      const d = c.artifact.template as { template_id: string; version: number };
      const failed = this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE owner = 'templates' AND state = 'failed' AND updated_at >= ? AND brief LIKE ?`, since, `%"template_id":"${d.template_id}"%`)?.n ?? 0;
      return { name: 'errors', ok: failed === 0, why: failed ? `${failed} of its checks failed since the change.` : 'Its checks hold.' };
    }
    if (c.kind === 'extension') {
      const id = String((c.artifact.manifest as Record<string, unknown>).id);
      const x = this.#o.live.extensions.list().find((e) => e.id === id);
      return { name: 'errors', ok: x?.state === 'enabled', why: x?.state === 'enabled' ? 'It is enabled and in place.' : `It is ${x?.state ?? 'gone'}.` };
    }
    return { name: 'errors', ok: true, why: 'Nothing has gone wrong in its area.' };
  }

  async #promote(c: ChangeRecord, passes: number): Promise<void> {
    await KIND_OPS[c.kind].promote(c.artifact, this.#o.live, { device: c.canary?.device ?? null });
    const canary = c.canary!;
    this.enter(c.id, 'canary', { status: 'passed', at: canary.started_at, summary: `Every probe passed ${passes} times over ${Math.round(canary.window_s / 60)} minutes on ${canary.scope}.`, evidence: { runs: canary.runs.length, last: canary.runs.at(-1) ?? null } });
    this.enter(c.id, 'promote', { status: 'passed', summary: `Live for everyone at ${this.now().toISOString()}.`, evidence: { at: this.now().toISOString() } });
    // The version it replaced stays on the record, as replaced.
    this.#db.run(`UPDATE change_record SET state = 'replaced', reason = ?, updated_at = ? WHERE target = ? AND state = 'live' AND id != ?`, `Replaced by v${c.version}.`, this.now().toISOString(), c.target, c.id);
    this.#update(c.id, { state: 'live', reason: `Live since ${this.now().toISOString()}.` });
    this.emit('change', { id: c.id, state: 'live' });
    this.#waiters.get(c.id)?.({ ok: true, why: 'Promoted.' });
    this.#waiters.delete(c.id);
  }

  // Puts back what was live before this change, and only that. Automatic: the Ship task ends
  // Failed with the probe's reason, which the ledger opens as a problem in plain words.
  async #rollback(c: ChangeRecord, why: string, how: 'auto' | 'manual'): Promise<void> {
    if (c.state === 'rolled_back') return;
    const ops = KIND_OPS[c.kind];
    const prev = c.previous;
    const before = this.#liveBefore(c);
    const back = before ? `v${before.version}` : 'what was there before';
    const Back = before ? `Version ${before.version} is back` : 'What was there before is back';
    try {
      if (prev) await ops.restore(prev, c.artifact, this.#o.live);
    } catch (e) {
      this.#update(c.id, { state: 'broken', reason: `Nova couldn’t put back ${back}: ${(e as Error).message}` });
      this.#o.log.problem('changes', `Nova couldn’t roll back “${c.title}” v${c.version}: ${(e as Error).message}. Check ${c.title} by hand.`, { ...(c.ship_task_id ? { taskId: c.ship_task_id } : {}) });
      this.emit('change', { id: c.id, state: 'broken' });
      this.#waiters.get(c.id)?.({ ok: false, why: `${why} Nova couldn’t put back ${back}.` });
      this.#waiters.delete(c.id);
      return;
    }
    const reason = how === 'auto' ? `Rolled back by itself: ${why} ${Back}.` : `You rolled it back; ${back} is back.`;
    if (c.state === 'canary' && c.canary?.started_at) {
      this.enter(c.id, 'canary', { status: 'failed', at: c.canary.started_at, summary: how === 'auto' ? why : 'Rolled back by hand during its canary.', evidence: { runs: c.canary.runs.length, last: c.canary.runs.at(-1) ?? null } });
    }
    this.#update(c.id, { state: 'rolled_back', reason });
    // What it had replaced is what is live again.
    if (before && c.state === 'live') this.#update(before.id, { state: 'live', reason: `Live again: v${c.version} was rolled back.` });
    this.emit('change', { id: c.id, state: 'rolled_back' });
    this.#waiters.get(c.id)?.({ ok: false, why: `Nova rolled back “${c.title}” v${c.version}: ${why} ${Back}, as it was.` });
    this.#waiters.delete(c.id);
  }

  // ---- inside -------------------------------------------------------------------------------------

  #confirm(e: Evidence): { ok: boolean; why: string } {
    if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
    const [id, what] = e.id.split('@');
    let c: ChangeRecord;
    try { c = this.get(id ?? ''); } catch { return { ok: false, why: `There is no change ${id}.` }; }
    if (what === 'released') {
      const missing = STAGES.slice(0, 4).find((s) => c.stages[s]?.status !== 'passed');
      if (missing) return { ok: false, why: `Nova read the change itself: ${missing} hasn’t passed.` };
      // The released artifact, read from the home and hashed again by Nova.
      const file = c.release ? join(this.#o.home, c.release.dir, 'artifact.json') : '';
      const text = file && existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (text === null) return { ok: false, why: 'Nova looked for the release files and they aren’t there.' };
      if (sha256(text) !== c.content_hash) return { ok: false, why: 'The released artifact doesn’t match the change’s hash.' };
      return { ok: true, why: `Nova read the release itself: every stage before approval passed, and ${c.release!.dir}/artifact.json hashes to ${c.content_hash.slice(0, 12)}…, as recorded.` };
    }
    if (what === 'live') return c.state === 'live' && c.stages.promote?.status === 'passed' ? { ok: true, why: `Nova read the change itself: live since ${c.stages.promote.at}, its canary passed.` } : { ok: false, why: `Nova read the change itself: it is ${c.state}.` };
    if (what === 'rolled_back') return c.state === 'rolled_back' ? { ok: true, why: 'Nova read the change itself: it is rolled back.' } : { ok: false, why: `Nova read the change itself: it is ${c.state}.` };
    if (what === 'proposed') {
      return c.proposed_by === 'person' ? { ok: false, why: 'That change was proposed by the person, not written here.' }
        : { ok: true, why: `Nova read the change itself: “${c.title}” v${c.version} is in the pipeline (${c.state}), proposed by the ${c.proposed_by}, at tier ${c.tier}.` };
    }
    return { ok: false, why: `Nova can’t confirm “${what}” for a change.` };
  }

  #nextGate(c: ChangeRecord): string {
    return STAGES.find((s) => c.stages[s]?.status !== 'passed') ?? 'its checks';
  }

  #scopeWords(c: ChangeRecord): string {
    if (c.kind === 'design-system') return 'one device';
    if (c.kind === 'trigger-rules') return 'its first firings';
    if (c.kind === 'extension') return 'its first use, enabled for the window';
    if (c.kind === 'config') return 'a watch window';
    return 'its first decisions';
  }

  // The change that was live for this target before this one, if any.
  #liveBefore(c: ChangeRecord): { id: string; version: string } | null {
    return this.#db.get<{ id: string; version: string }>(`SELECT id, version FROM change_record WHERE target = ? AND created_at <= ? AND id != ? AND state IN ('live', 'replaced') ORDER BY created_at DESC, rowid DESC LIMIT 1`, c.target, c.created_at, c.id) ?? null;
  }

  #latestLive(target: string): { id: string } | null {
    return this.#db.get<{ id: string }>(`SELECT id FROM change_record WHERE target = ? AND state = 'live' ORDER BY created_at DESC, rowid DESC LIMIT 1`, target) ?? null;
  }

  #words(c: ChangeRecord): string {
    switch (c.state) {
      case 'checking': return `Checking it: ${STAGES.find((s) => !c.stages[s]) ?? 'release'}.`;
      case 'waiting': return c.tier === 3 ? 'Ready. It changes Nova itself, so it waits for your OK, every time.' : 'Ready. It waits for your OK.';
      case 'canary': {
        const runs = c.canary?.runs.length ?? 0;
        return c.canary?.started_at ? `Live on ${c.canary.scope} until ${c.canary.ends_at}. Probes run ${runs} time${runs === 1 ? '' : 's'} so far, all passing.` : 'Going live in a canary.';
      }
      default: return c.reason ?? STATUS[c.state];
    }
  }

  #insert(r: { id: string; kind: ChangeKind; target: string; title: string; version: string; hash: string; artifact: unknown; by: string; author: string | null; tier: number; stage: string; state: ChangeState; reason: string; at: string; canary?: { window_s: number; device: string | null } }): void {
    this.#db.run(
      `INSERT INTO change_record (id, kind, target, title, version, content_hash, artifact, proposed_by, author, tier, stage, state, reason, stages, canary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      r.id, r.kind, r.target, r.title, r.version, r.hash, JSON.stringify(r.artifact), r.by, r.author, r.tier, r.stage, r.state, r.reason, r.canary ? JSON.stringify(r.canary) : null, r.at, r.at,
    );
  }

  #update(id: string, set: Record<string, string | number | null>): void {
    const keys = Object.keys(set);
    this.#db.run(`UPDATE change_record SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => set[k]!), this.now().toISOString(), id);
  }
}

// What /health checks a sandbox must keep healthy (the parts that don't depend on running hub work).
const SANDBOX_HEALTH = ['database', 'ledger', 'extensions', 'design', 'triggers', 'problems', 'memory', 'receipts'];

// Nova's one status vocabulary (DESIGN-SYSTEM §1).
export const STATUS: Record<ChangeState, string> = {
  checking: 'Working', stopped: 'Failed', waiting: 'Needs you', canary: 'Working', live: 'Verified',
  rolled_back: 'Failed', refused: 'Failed', declined: 'Quiet', replaced: 'Quiet', broken: 'Failed',
};
