// The Work Ledger, v1 (WORK-LEDGER-AND-VERIFICATION). Every unit of work is a task with a brief,
// an owner and a state; every state change is an appended event. A task never just disappears:
// it ends done, failed or cancelled, with a reason. "Done" is reachable only through verification.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CoreError } from './errors.ts';
import { ENVELOPE_VERSION, validateBrief, validateReport, type Brief, type ContextRef, type EvidenceRequirement, type PrivacyMode, type Report, type Tier } from './envelope.ts';
import { effectsOf, egressOf, permits, type Worker } from './workers.ts';
import type { Db } from './db.ts';
import type { Log } from './log.ts';
import type { Verification, Verifier } from './verify.ts';

export const STATES = ['queued', 'active', 'waiting', 'verifying', 'done', 'failed', 'cancelled'] as const;
export type State = (typeof STATES)[number];
export const TERMINAL: readonly State[] = ['done', 'failed', 'cancelled'];

const MOVES: Record<State, State[]> = {
  queued: ['active', 'waiting', 'cancelled'],
  // waiting → active: a running worker that asked for the person carries on once they're done.
  waiting: ['queued', 'cancelled', 'failed', 'active'],
  active: ['verifying', 'waiting', 'failed', 'queued', 'cancelled'],
  // verifying → waiting: evidence that didn't hold up for work that may already have happened.
  verifying: ['done', 'queued', 'failed', 'waiting'],
  done: [],
  failed: [],
  cancelled: [],
};

export const canMove = (from: State, to: State): boolean => MOVES[from].includes(to);

export const VISIBILITY = ['silent', 'handling', 'attention'] as const;
export type Visibility = (typeof VISIBILITY)[number];
// `device`: asked for by a paired computer's agent (ref: the device id), through its queue.
export interface Origin { kind: 'user' | 'setup' | 'trigger' | 'device'; ref?: string }

export interface TaskInput {
  title: string;
  owner: string;
  goal: string;
  origin: Origin;
  evidence_required: EvidenceRequirement[];
  privacy_mode?: PrivacyMode;
  approval_tier?: Tier;
  context_refs?: ContextRef[];
  constraints?: Brief['constraints'];
  inputs?: Record<string, unknown>;
  idempotency_key?: string;
  parent_id?: string;
  user_visibility?: Visibility;
}

export interface Task {
  id: string;
  title: string;
  origin: Origin;
  state: State;
  reason: string | null;
  owner: string;
  brief: Brief;
  report: Report | null;
  verification: Verification | null;
  privacy_mode: PrivacyMode;
  approval_tier: Tier;
  approved_at: string | null;
  cost: Record<string, number>;
  parent_id: string | null;
  user_visibility: Visibility;
  idempotency_key: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskEvent { seq: number; task_id: string; at: string; kind: string; from_state: State | null; to_state: State | null; detail: unknown }

type Row = Record<string, string | number | null>;
const parse = <T>(s: unknown): T => (typeof s === 'string' ? JSON.parse(s) : null) as T;

function toTask(r: Row): Task {
  return {
    ...(r as unknown as Task),
    origin: parse(r.origin),
    brief: parse(r.brief),
    report: parse(r.report),
    verification: parse(r.verification),
    cost: parse(r.cost),
  };
}

// Where a task waits its turn. Tasks in one lane run side by side up to `max`; a worker that
// names no lane shares the default one, which runs one task at a time.
export interface Lane { key: string; max: number }
// `minTier`: the least approval a task for this worker needs, whatever the caller asked for (a
// provider whose brief declares a test command for Nova to run asks first: tier 2, M5a).
// `internal`: a worker whose tasks only its own module makes (the change pipeline, the foundry).
// Anyone else asking — the API, a device, a connector, a trigger — is refused with `why`, so a
// brief can't be forged to drive it past the person's OK.
// `uncancellable`: why a running task can't be cancelled now (it is part way through a step that
// can't be stopped half done, such as moving a branch), or null. A cancel then is refused, so the
// record never says "cancelled" over work that went ahead.
export type LanedWorker = Worker & { lane?(brief: Brief): Lane; minTier?(input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier; internal?: { key: symbol; why: string }; uncancellable?(t: Task): string | null };
const DEFAULT_LANE: Lane = { key: 'default', max: 1 };

export interface LedgerOptions {
  db: Db;
  log: Log;
  verifier: Verifier;
  workers: LanedWorker[];
  defaultPrivacy: () => PrivacyMode;
  now?: () => Date;
  maxAttempts?: number;
  timeoutMs?: number;
}

export class Ledger extends EventEmitter {
  readonly workers: Map<string, LanedWorker>;
  #db: Db;
  #log: Log;
  #verifier: Verifier;
  #now: () => Date;
  #defaultPrivacy: () => PrivacyMode;
  #maxAttempts: number;
  #timeoutMs: number;
  #pumping: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #dirty = false;
  #running = new Map<string, AbortController>();
  // Nova is about to restart: nothing new starts, and what was running is left for the next start.
  #halted = false;
  #inflight = new Map<string, { lane: string; done: Promise<void> }>();

  constructor(o: LedgerOptions) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.#verifier = o.verifier;
    this.workers = new Map(o.workers.map((w) => [w.id, w]));
    this.#now = o.now ?? (() => new Date());
    this.#defaultPrivacy = o.defaultPrivacy;
    this.#maxAttempts = o.maxAttempts ?? 3;
    this.#timeoutMs = o.timeoutMs ?? 10 * 60_000;
  }

  // `as`: the key of an internal worker, from the module that owns it.
  create(input: TaskInput, o: { as?: symbol } = {}): Task {
    // Before the idempotency look-up too: a forged key mustn't even read back the real task.
    const closed = this.closed(input?.owner);
    if (closed && o.as !== this.workers.get(input.owner)!.internal!.key) throw new CoreError('forbidden', closed);
    const key = input.idempotency_key ?? randomUUID();
    const existing = this.#db.get<Row>('SELECT * FROM task WHERE idempotency_key = ?', key);
    if (existing) return toTask(existing);

    if (typeof input.title !== 'string' || !input.title.trim()) throw new CoreError('validation', 'A task needs a title, in plain words.');
    const worker = this.workers.get(input.owner);
    if (!worker) throw new CoreError('validation', `There is no worker called "${input.owner}".`, [`Workers: ${[...this.workers.keys()].join(', ')}`]);
    if (!Array.isArray(input.evidence_required) || !input.evidence_required.length) {
      throw new CoreError('validation', 'A task must say what evidence will prove it done. "Done" without evidence is not done.');
    }
    // Otherwise any existing file with a known hash would pass as proof.
    if (input.evidence_required.some((r) => r?.kind === 'read_back' && !r.target)) {
      throw new CoreError('validation', 'A read-back requirement must name the file to read back.');
    }
    const mode = input.privacy_mode ?? this.#defaultPrivacy();
    if (input.parent_id !== undefined && !this.#db.get('SELECT 1 FROM task WHERE id = ?', input.parent_id)) throw new CoreError('validation', `No parent task ${input.parent_id}.`);
    if (input.user_visibility !== undefined && !VISIBILITY.includes(input.user_visibility)) throw new CoreError('validation', `user_visibility must be one of ${VISIBILITY.join(', ')}.`);
    const id = randomUUID();
    const brief = validateBrief({
      envelope: ENVELOPE_VERSION,
      task_id: id,
      goal: input.goal,
      context_refs: input.context_refs ?? [],
      constraints: input.constraints ?? {},
      privacy_mode: mode,
      approval_tier: Math.max(input.approval_tier ?? 1, worker.minTier?.(input) ?? 0) as Tier,
      evidence_required: input.evidence_required,
      idempotency_key: key,
      ...(input.inputs ? { inputs: input.inputs } : {}),
    });
    // Where this brief's data would go; a worker whose reach depends on the brief says so, and
    // refuses a brief it could never run.
    if (!permits(mode, egressOf(worker, brief))) {
      throw new CoreError('validation', `${worker.name} sends data off your devices, and this task is ${mode}. Pick a worker that keeps it local.`);
    }
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run(
        `INSERT INTO task (id, title, origin, state, reason, owner, brief, privacy_mode, approval_tier, parent_id, user_visibility, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.title.trim(), JSON.stringify(input.origin), worker.id, JSON.stringify(brief), brief.privacy_mode, brief.approval_tier,
        input.parent_id ?? null, input.user_visibility ?? 'handling', key, at, at,
      );
      this.#event(id, 'created', null, 'queued', { owner: worker.id, privacy_mode: brief.privacy_mode, approval_tier: brief.approval_tier });
    });
    const gated = this.#gate(this.get(id));
    this.emit('task', gated);
    void this.pump();
    return gated;
  }

  // Why nobody but its own module may give this worker a task, or null when anyone may.
  closed(owner: unknown): string | null {
    return typeof owner === 'string' ? this.workers.get(owner)?.internal?.why ?? null : null;
  }

  get(id: string): Task {
    const row = this.#db.get<Row>('SELECT * FROM task WHERE id = ?', id);
    if (!row) throw new CoreError('not_found', `No task ${id}.`);
    return toTask(row);
  }

  list(opts: { state?: State; limit?: number } = {}): Task[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = opts.state
      ? this.#db.all<Row>('SELECT * FROM task WHERE state = ? ORDER BY created_at DESC LIMIT ?', opts.state, limit)
      : this.#db.all<Row>('SELECT * FROM task ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map(toTask);
  }

  events(id: string): TaskEvent[] {
    this.get(id);
    return this.#db.all<Row>('SELECT * FROM task_event WHERE task_id = ? ORDER BY seq', id).map((e) => ({ ...(e as unknown as TaskEvent), detail: parse(e.detail) }));
  }

  // Tier 2 asks first; tier 3 needs an explicit confirmation every time (NOVA-SPEC §6).
  approve(id: string, opts: { confirm?: boolean } = {}): Task {
    const t = this.get(id);
    if (t.approved_at) return t;
    if (t.state !== 'waiting' || t.approval_tier < 2) throw new CoreError('conflict', 'This task is not waiting for approval.');
    if (t.approval_tier === 3 && opts.confirm !== true) throw new CoreError('validation', 'This is a tier-3 task: approving it needs an explicit confirmation.');
    this.#db.run('UPDATE task SET approved_at = ? WHERE id = ?', this.#now().toISOString(), id);
    this.#event(id, 'approved', null, null, { tier: t.approval_tier });
    const next = this.#gate(this.get(id));
    void this.pump();
    return next;
  }

  // The person asks for another go at a task that is waiting on something other than approval
  // (blocked, partly done, or out of local capacity).
  // A worker that stepped aside (a blocked report) and is ready again uses it too, with its reason.
  retry(id: string, reason = 'Trying again, as you asked.'): Task {
    const t = this.get(id);
    // Its worker is still running and waiting for the person (needsPerson): running it a second
    // time would race the first.
    if (this.#running.has(id)) throw new CoreError('conflict', 'This task is still running: it is waiting for you to do a step. Open it to take over.');
    if (t.state !== 'waiting' || (t.approval_tier >= 2 && !t.approved_at)) throw new CoreError('conflict', "This task isn't waiting for a retry.");
    this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, id);
    // Running work with outside effects again is a new decision: the OK given for the first run
    // doesn't cover it, so a task that needs one asks again before it runs.
    const w = this.workers.get(t.owner);
    const reapprove = t.attempts > 0 && t.approval_tier >= 2 && !!w && effectsOf(w, t.brief) === 'external';
    if (reapprove) this.#db.run('UPDATE task SET approved_at = NULL WHERE id = ?', id);
    const next = this.#move(id, 'queued', reason, 'retried', reapprove ? { asks_again: true } : undefined);
    const gated = reapprove ? this.#gate(next) : next;
    void this.pump();
    return gated;
  }

  // A running worker needs the person for a step only they may do (a sign-in, a challenge): the
  // task waits, flagged for them, while the worker keeps running. `personDone` takes it back.
  needsPerson(id: string, why: string): Task {
    const t = this.get(id);
    if (!this.#running.has(id) || (t.state !== 'active' && t.state !== 'waiting')) throw new CoreError('conflict', 'Only a running task can ask for you.');
    this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, id);
    return this.#move(id, 'waiting', why, 'needs_person');
  }

  personDone(id: string, why: string): Task {
    const t = this.get(id);
    if (!this.#running.has(id) || t.state !== 'waiting') return t;
    this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, id);
    return this.#move(id, 'active', why, 'person_done');
  }

  // A running worker says its work never started this time: the service it hands work to turned it
  // away before anything existed (Relay's runtime_busy). Written down now; if the worker's report is
  // `blocked`, the ledger gives the dispatch back, so it isn't counted as an attempt. A done or
  // failed report is counted whatever was said here.
  notStarted(id: string, why: string): void {
    const t = this.get(id);
    if (!this.#running.has(id)) throw new CoreError('conflict', 'Only a running task can say its work never started.');
    this.#event(id, 'not_started', null, null, { why: String(why).slice(0, 300), attempt: t.attempts });
  }

  // What the worker said about this dispatch never starting (a not_started event since the last
  // dispatch), or null.
  #claimedNotStarted(id: string): string | null {
    const since = this.#db.get<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM task_event WHERE task_id = ? AND kind = 'dispatched'`, id)?.seq ?? 0;
    const row = this.#db.get<{ detail: string | null }>(`SELECT detail FROM task_event WHERE task_id = ? AND kind = 'not_started' AND seq > ? ORDER BY seq DESC LIMIT 1`, id, since);
    return row ? parse<{ why?: string }>(row.detail)?.why ?? 'The work never started' : null;
  }

  // The dispatch didn't count: its attempt is given back, and the record says so in plain words.
  #giveBack(id: string, why: string): void {
    this.#db.tx(() => {
      this.#db.run('UPDATE task SET attempts = MAX(attempts - 1, 0) WHERE id = ?', id);
      this.#event(id, 'attempt_returned', null, null, { reason: `${why.trim().replace(/[.;\s]+$/, '')}; this didn’t count as an attempt.`, attempts: this.get(id).attempts });
    });
  }

  // A running worker is about to do the thing that has the task's outside effect (a step flagged
  // `commits`). Written down first, so after a failure the ledger knows whether that point was
  // ever passed in this attempt.
  committing(id: string, what: string): void {
    const t = this.get(id);
    if (!this.#running.has(id)) throw new CoreError('conflict', 'Only a running task can pass its commit point.');
    this.#event(id, 'commit_point', null, null, { what, attempt: t.attempts });
  }

  // Something a worker wants in the task's record that isn't a change of state (a takeover, a
  // request it refused). It is appended like every other event.
  note(id: string, kind: string, detail?: unknown): void {
    const t = this.get(id);
    this.#event(id, kind, null, null, detail);
    this.emit('note', { task: t, kind, detail });
  }

  cancel(id: string, reason = 'Cancelled.'): Task {
    const t = this.get(id);
    if (TERMINAL.includes(t.state)) throw new CoreError('conflict', `This task is already ${t.state}.`);
    let no: string | null = null;
    try { no = this.workers.get(t.owner)?.uncancellable?.(t) ?? null; } catch { /* it can't say: cancellable */ }
    if (no) throw new CoreError('conflict', no);
    this.#running.get(id)?.abort(new Error('cancelled'));
    return this.#move(id, 'cancelled', reason, 'cancelled');
  }

  // After a restart: work that was running goes back in the queue under the same idempotency
  // key, and a report that was waiting on verification is verified now.
  recover(): { requeued: string[]; reverified: string[] } {
    const requeued: string[] = [];
    const reverified: string[] = [];
    for (const found of this.list({ state: 'active', limit: 500 })) {
      // A worker that said its work never started, and then Nova stopped: that dispatch isn't counted.
      const unstarted = this.#claimedNotStarted(found.id);
      if (unstarted) this.#giveBack(found.id, unstarted);
      const t = unstarted ? this.get(found.id) : found;
      if (!this.#mayRerun(t)) {
        this.#hold(t.id, 'Nova restarted while this was running', 'recovered');
        continue;
      }
      if (t.attempts >= this.#maxAttempts) {
        this.#fail(t.id, `Nova restarted while this was running, ${t.attempts} times. Not trying again.`, undefined, 'recovered');
        continue;
      }
      this.#requeue(t, 'Nova restarted while this was running. It will run again.', 'recovered');
      requeued.push(t.id);
    }
    // A worker that was waiting for the person (needsPerson) was running too; what it had open is
    // gone, so it starts again from the beginning.
    for (const t of this.list({ state: 'waiting', limit: 500 })) {
      const last = this.#db.get<{ kind: string }>('SELECT kind FROM task_event WHERE task_id = ? AND to_state IS NOT NULL ORDER BY seq DESC LIMIT 1', t.id);
      if (last?.kind !== 'needs_person') continue;
      if (!this.#mayRerun(t)) {
        this.#hold(t.id, 'Nova restarted while this waited for you', 'recovered');
        continue;
      }
      if (t.attempts >= this.#maxAttempts) {
        this.#fail(t.id, `Nova restarted while this waited for you, ${t.attempts} times. Not trying again.`, undefined, 'recovered');
        continue;
      }
      this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, t.id);
      this.#requeue(t, 'Nova restarted while this waited for you. It starts again from the beginning.', 'recovered');
      requeued.push(t.id);
    }
    for (const t of this.list({ state: 'verifying', limit: 500 })) {
      if (t.report) this.#verifyAndSettle(t.id, t.report);
      else if (!this.#mayRerun(t)) this.#hold(t.id, 'Nova restarted before the report arrived', 'recovered');
      else this.#move(t.id, 'queued', 'Nova restarted before the report arrived. It will run again.', 'recovered');
      reverified.push(t.id);
    }
    void this.pump();
    return { requeued, reverified };
  }

  // Run queued tasks, oldest first. Each lane runs up to its limit at once; a full lane doesn't
  // hold up the others. Calling it while it runs wakes it to look at the queue again.
  pump(): Promise<void> {
    if (this.#pumping) {
      this.#dirty = true;
      this.#wake?.();
      return this.#pumping;
    }
    const run = (async () => {
      // Yield first, so `#pumping` is set before the loop can finish and clear it.
      await null;
      try {
        for (;;) {
          this.#dirty = false;
          // No limit: a full lane with many queued tasks must not hide the tasks of other lanes.
          for (const row of this.#halted ? [] : this.#db.all<Row>(`SELECT * FROM task WHERE state = 'queued' ORDER BY created_at, rowid`)) {
            const t = toTask(row);
            if (this.#inflight.has(t.id)) continue;
            const lane = this.#lane(t);
            if ([...this.#inflight.values()].filter((x) => x.lane === lane.key).length >= lane.max) continue;
            const done = this.#runOne(t)
              .catch((e) => { this.#log.problem('ledger', 'The Work Ledger stumbled while running a task.', { detail: (e as Error)?.stack ?? String(e), taskId: t.id }); })
              .finally(() => { this.#inflight.delete(t.id); });
            this.#inflight.set(t.id, { lane: lane.key, done });
          }
          if (this.#dirty) continue;
          if (!this.#inflight.size) break;
          const woken = new Promise<void>((r) => { this.#wake = r; });
          await Promise.race([woken, ...[...this.#inflight.values()].map((x) => x.done)]);
          this.#wake = null;
        }
      } finally {
        this.#pumping = null;
        this.#wake = null;
      }
    })();
    this.#pumping = run;
    return run;
  }

  #lane(t: Task): Lane {
    const w = this.workers.get(t.owner);
    try {
      const l = w?.lane?.(t.brief);
      if (l && typeof l.key === 'string' && Number.isInteger(l.max) && l.max >= 1) return { key: `${w!.id}:${l.key}`, max: l.max };
    } catch { /* a worker whose lane can't be worked out runs in the default lane */ }
    return DEFAULT_LANE;
  }

  // Before Nova restarts in place: every running task is stopped (its worker's signal), nothing
  // more is started, and the stopped tasks stay as they were, for the next start's recovery.
  halt(reason = 'Nova is restarting.'): string[] {
    this.#halted = true;
    const ids = [...this.#running.keys()];
    for (const ac of this.#running.values()) ac.abort(new Error(reason));
    return ids;
  }

  // Resolves when nothing is running or queued.
  async idle(): Promise<void> {
    while (this.#pumping) await this.#pumping;
  }

  counts(): Record<State, number> {
    const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
    for (const r of this.#db.all<{ state: State; n: number }>('SELECT state, COUNT(*) AS n FROM task GROUP BY state')) out[r.state] = r.n;
    return out;
  }

  // Approval and privacy are checked before anything runs, and again after anything changes.
  #gate(t: Task): Task {
    if (t.state !== 'queued' && t.state !== 'waiting') return t;
    const worker = this.workers.get(t.owner);
    let wait: string | null = null;
    if (!worker) wait = `The worker "${t.owner}" isn't available.`;
    else if (!permits(t.privacy_mode, (() => { try { return egressOf(worker, t.brief); } catch { return 'remote'; } })())) wait = `Waiting on local capacity: ${worker.name} would send this off your devices, and this task is local-only.`;
    else if (t.approval_tier >= 2 && !t.approved_at) wait = 'Needs your OK before it runs.';
    if (wait && (t.state !== 'waiting' || t.reason !== wait)) {
      this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
      return this.#move(t.id, 'waiting', wait, 'gated');
    }
    if (!wait && t.state === 'waiting') return this.#move(t.id, 'queued', null, 'released');
    return t;
  }

  async #runOne(t: Task): Promise<void> {
    const gated = this.#gate(t);
    if (gated.state !== 'queued') return;
    const worker = this.workers.get(t.owner)!;
    this.#db.run('UPDATE task SET attempts = attempts + 1 WHERE id = ?', t.id);
    this.#move(t.id, 'active', `${worker.name} is on it.`, 'dispatched', { attempt: t.attempts + 1 });
    const ac = new AbortController();
    this.#running.set(t.id, ac);
    const limit = worker.timeoutMs ?? this.#timeoutMs;
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(limit)]);
    // A worker that ignores the signal must not hold the queue: whichever comes first wins.
    const stopped = new Promise<never>((_, fail) => {
      if (signal.aborted) fail(signal.reason);
      signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    });
    let raw: unknown;
    try {
      raw = await Promise.race([worker.run(t.brief, signal), stopped]);
    } catch (e) {
      this.#running.delete(t.id);
      if (this.#halted) return;
      if (this.get(t.id).state === 'cancelled') return;
      if (signal.aborted && (e as Error)?.name === 'TimeoutError') {
        return this.#retryOrFail(t.id, `${worker.name} took longer than ${Math.round(limit / 1000)} s.`, undefined, 'timed_out');
      }
      return this.#retryOrFail(t.id, `${worker.name} stopped with an error: ${(e as Error).message}`, (e as Error).stack);
    }
    stopped.catch(() => {});
    this.#running.delete(t.id);
    if (this.get(t.id).state === 'cancelled') return;
    // A worker that asked for the person and then finished without saying they were done.
    if (this.get(t.id).state === 'waiting') this.#move(t.id, 'active', `${worker.name} is on it.`, 'person_done');

    let report: Report;
    try {
      report = validateReport(raw, t.brief);
    } catch (e) {
      const details = e instanceof CoreError ? e.details.join('; ') : String(e);
      return this.#retryOrFail(t.id, `${worker.name} sent back a report Nova couldn't read.`, details);
    }
    const cost = { duration_ms: Math.round(report.usage.duration_ms), ...(report.usage.cost_usd ? { cost_usd: report.usage.cost_usd } : {}) };
    this.#db.run('UPDATE task SET report = ?, cost = ? WHERE id = ?', JSON.stringify(report), JSON.stringify(cost), t.id);
    this.#event(t.id, 'reported', null, null, { status: report.status, summary: report.summary });

    if (report.status === 'failed') return this.#fail(t.id, `${worker.name} couldn't do it: ${report.summary}`);
    if (report.status === 'blocked' || report.status === 'partial') {
      // Only a blocked report can say the work never started; then the dispatch is given back.
      const unstarted = report.status === 'blocked' ? this.#claimedNotStarted(t.id) : null;
      if (unstarted) this.#giveBack(t.id, unstarted);
      this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
      const why = report.status === 'blocked' ? `Blocked: ${report.blockers.join('; ') || report.summary}` : `Partly done: ${report.summary}`;
      this.#move(t.id, 'waiting', why, report.status);
      return;
    }
    this.#move(t.id, 'verifying', 'Checking the evidence.', 'verifying');
    this.#verifyAndSettle(t.id, report);
  }

  #verifyAndSettle(id: string, report: Report): void {
    const t = this.get(id);
    const v = this.#verifier.verify(t.brief, report);
    this.#db.run('UPDATE task SET verification = ? WHERE id = ?', JSON.stringify(v), id);
    if (v.ok) {
      this.#move(id, 'done', report.summary, 'verified', { checks: v.checks.map((c) => c.why) });
      return;
    }
    const why = v.checks.filter((c) => !c.ok).map((c) => c.why).join(' ');
    // What didn't match, kept with the event: for work that may already have happened, it is
    // what the person checks before choosing to retry.
    const discrepancy = v.checks.filter((c) => !c.ok).map((c) => ({ kind: c.requirement.kind, why: c.why }));
    this.#retryOrFail(id, `The evidence didn't hold up: ${why}`, undefined, 'verification_failed', { discrepancy });
  }

  #retryOrFail(id: string, why: string, detail?: string, kind = 'attempt_failed', extra?: Record<string, unknown>): void {
    const t = this.get(id);
    if (!this.#mayRerun(t)) {
      this.#hold(id, why, kind, { ...(detail ? { detail } : {}), ...extra });
      return;
    }
    if (t.attempts < this.#maxAttempts) {
      this.#log.warn('ledger', why, { task: id, attempt: t.attempts, detail });
      this.#requeue(t, `${why} Trying again (attempt ${t.attempts + 1} of ${this.#maxAttempts}).`, kind, { detail });
      return;
    }
    this.#fail(id, `${why} Gave up after ${t.attempts} attempts.`, detail, kind);
  }

  // Whether a task that stopped after it was dispatched may run again by itself. Work with outside
  // effects may not: it may already have happened, and only the person can tell. The exception is
  // a brief that marks where its effect happens (`commits`): if this attempt never got there,
  // nothing has happened yet. That decision is written down either way.
  #mayRerun(t: Task): boolean {
    const w = this.workers.get(t.owner);
    if (!w || effectsOf(w, t.brief) !== 'external') return true;
    let marked = false;
    try { marked = w.commits?.(t.brief) === true; } catch { /* it can't say: as if unmarked */ }
    if (!marked) return false;
    const since = this.#db.get<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM task_event WHERE task_id = ? AND kind = 'dispatched'`, t.id)?.seq ?? 0;
    const passed = this.#db.get<{ detail: string | null }>(`SELECT detail FROM task_event WHERE task_id = ? AND kind = 'commit_point' AND seq > ? ORDER BY seq LIMIT 1`, t.id, since);
    const what = passed ? parse<{ what?: string }>(passed.detail)?.what : null;
    this.#event(t.id, 'rerun_decision', null, null, passed
      ? { rerun: false, why: `It got as far as “${what ?? 'the step that sends it'}”, so it may already have happened.` }
      : { rerun: true, why: 'It stopped before the step that has the outside effect, so nothing has happened yet; it may run again.' });
    return !passed;
  }

  // Work that may already have happened waits for the person: Needs you, with what went wrong, and
  // only their retry (or cancel) moves it on.
  #hold(id: string, why: string, kind: string, detail?: Record<string, unknown>): void {
    const reason = `May already have happened: ${why.trim().replace(/[.\s]+$/, '')}. Check, then retry or cancel.`;
    this.#log.warn('ledger', reason, { task: id });
    this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, id);
    this.#move(id, 'waiting', reason, kind, { ...detail, held: true });
  }

  // Tier 3 is confirmed every time it runs (NOVA-SPEC §6), so a rerun asks again.
  #requeue(t: Task, reason: string, kind: string, detail?: unknown): void {
    if (t.approval_tier === 3) this.#db.run('UPDATE task SET approved_at = NULL WHERE id = ?', t.id);
    this.#move(t.id, 'queued', reason, kind, detail);
  }

  #fail(id: string, why: string, detail?: string, kind = 'failed'): void {
    this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, id);
    this.#move(id, 'failed', why, kind, detail ? { detail } : undefined);
    this.#log.problem('ledger', `A task failed: ${this.get(id).title}. ${why}`, { detail, taskId: id });
  }

  #move(id: string, to: State, reason: string | null, kind: string, detail?: unknown): Task {
    const t = this.get(id);
    if (t.state !== to && !canMove(t.state, to)) throw new CoreError('conflict', `A ${t.state} task can't become ${to}.`);
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run('UPDATE task SET state = ?, reason = ?, updated_at = ?, completed_at = ? WHERE id = ?', to, reason, at, TERMINAL.includes(to) ? at : null, id);
      this.#event(id, kind, t.state, to, { reason, ...(detail && typeof detail === 'object' ? detail : {}) });
    });
    const next = this.get(id);
    this.emit('task', next);
    return next;
  }

  #event(id: string, kind: string, from: State | null, to: State | null, detail?: unknown): void {
    this.#db.run('INSERT INTO task_event (task_id, at, kind, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)', id, this.#now().toISOString(), kind, from, to, detail === undefined ? null : JSON.stringify(detail));
  }
}
