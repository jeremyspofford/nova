// The chat-run worker: Era 2's scheduled runs and helpers, as Work Ledger tasks. The ledger is
// the one record of that background work: it queues it, runs it, survives restarts, and only
// marks it done once Nova has checked the report reached its conversation.
//
// Each task's brief says what kind of run it is (inputs.kind: schedule or helper) and the
// session it runs in (inputs.run). The kinds themselves (the Scheduler and Helpers) say how to
// start a run and where its report goes; this file does the rest:
//
// - A run waiting for the person's OK steps aside: the task reports blocked and waits, its place
//   in the queue goes to the next one, and it comes back when the run finishes.
// - The report is handed off once (a rerun finds it already delivered), and the evidence is a
//   confirmation Nova checks itself by reading the conversation it went to.
// - A run that was going when Nova stopped is not run again (its steps may have changed things);
//   the conversation hears it didn't finish.
import { randomUUID } from 'node:crypto';
import { ENVELOPE_VERSION, TERMINAL, permits } from './core/index.ts';
import { reduce } from '../ui/js/reduce.js';
import { lastRunTurn } from './runner.js';

export const WORKER = 'chat-run';
export const SYSTEM = 'nova-sessions';
const OPEN = ['queued', 'active', 'waiting', 'verifying'];
const RANK = { 'local-only': 0, 'local-preferred': 1, 'cloud-allowed': 2 };
export const stricter = (a, b) => ((RANK[a] ?? 0) <= (RANK[b] ?? 0) ? a : b);

// A report's first line, as plain words.
export const headline = (text) => {
  const first = String(text ?? '').split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim() ?? '';
  return first.length > 140 ? `${first.slice(0, 138).replace(/\s+\S*$/, '')}…` : first;
};

// Open chat-run tasks of one kind, oldest first.
export function openTasks(ledger, kind) {
  if (!ledger) return [];
  return OPEN.flatMap((state) => ledger.list({ state, limit: 500 }))
    .filter((t) => t.owner === WORKER && t.brief.inputs?.kind === kind)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Whether a run has started: its conversation has the instructions in it.
export const begun = (store, run) => store.exists(run) && store.read(run).some((e) => e.type === 'user');

export class ChatRun {
  constructor({ program = 'the model command', egress = 'remote', privacy = () => 'local-only' } = {}) {
    this.id = WORKER;
    this.name = `Nova's chat model (${program})`;
    this.about = 'Does scheduled work and helpers on its own, each in a conversation of its own, and hands the report to the conversation it is for.';
    this.egress = egress;
    // An unattended run can take a while (several model calls, commands that ask first).
    this.timeoutMs = 60 * 60_000;
    this.evidence = ['confirmation'];
    this.privacy = privacy;
    this.kinds = {};
    this.settling = new Map(); // run → the delivery in progress
  }

  bind({ runner, store, ledger, kinds }) {
    Object.assign(this, { runner, store, ledger, kinds });
    for (const k of Object.values(kinds)) k.worker = this;
    // Each run that stepped aside listens for its task until the ledger has settled it.
    ledger.setMaxListeners(Math.max(ledger.getMaxListeners(), 100));
  }

  health() {
    return this.runner ? { ok: true } : { ok: false, detail: 'The chat-run worker isn’t connected to the conversations yet.' };
  }

  // Each kind has its own place in the queue: scheduled runs one at a time, helpers a few at once.
  lane(brief) {
    const kind = brief.inputs?.kind;
    return { key: kind ?? 'other', max: this.kinds[kind]?.max ?? 1 };
  }

  async run(brief, signal) {
    const started = Date.now();
    const inputs = brief.inputs ?? {};
    const kind = this.kinds[inputs.kind];
    if (!kind || !this.runner) throw new Error(`Nova doesn't know how to run "${inputs.kind}" work here.`);
    const title = kind.title(inputs);
    const report = (status, summary, extra = {}) => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [],
      artifacts: [{ kind: 'session', ref: inputs.run }], blockers: [], usage: { duration_ms: Date.now() - started }, follow_up_suggestions: [], ...extra,
    });
    const finish = (h) => (h.ok
      ? report('done', headline(h.text) || `${title}: report delivered.`, { evidence: [{ kind: 'confirmation', system: SYSTEM, id: h.id }] })
      : report('failed', h.text));

    // Already handed off (Nova stopped between delivering it and reporting): the same report again.
    const delivered = this.delivered(inputs.run, brief.task_id);
    if (delivered) return finish(delivered);

    const live = this.runner.active.has(inputs.run);
    // Cost caps: the runner meters this run against this task's ceilings.
    this.runner.runTasks?.set(inputs.run, brief.task_id);
    // A resume (offered after a cost ceiling, run once the person said yes): a new turn in the
    // same conversation, started once, through the kind's own begin.
    const resuming = !!inputs.resume && !live && begun(this.store, inputs.run) && !this.store.read(inputs.run).some((e) => e.type === 'resumed' && e.task === brief.task_id);
    if (resuming) {
      const mode = stricter(brief.privacy_mode, this.privacy());
      if (!permits(mode, this.egress)) {
        return report('blocked', `${title} is waiting on local capacity.`, { blockers: [`Waiting on local capacity: ${this.name} would send this off your devices, and your privacy setting is ${mode}.`] });
      }
      this.runner.record(inputs.run, { type: 'resumed', task: brief.task_id, of: inputs.resume });
      const why = kind.begin(inputs, brief, mode);
      if (why) {
        this.ledger.cancel(brief.task_id, why);
        return report('failed', why);
      }
    } else if (!begun(this.store, inputs.run)) {
      // The task's privacy mode, and never looser than the person's setting right now.
      const mode = stricter(brief.privacy_mode, this.privacy());
      if (!permits(mode, this.egress)) {
        return report('blocked', `${title} is waiting on local capacity.`, { blockers: [`Waiting on local capacity: ${this.name} would send this off your devices, and your privacy setting is ${mode}.`] });
      }
      const why = kind.begin(inputs, brief, mode);
      if (why) {
        this.ledger.cancel(brief.task_id, why);
        return report('failed', why);
      }
    } else if (!live) {
      // It was going when Nova stopped. Its steps may have changed things, so it isn't run again.
      const out = this.outcome(inputs.run);
      const h = await this.settle(brief.task_id, inputs, out, brief.privacy_mode);
      this.offerResume(brief, inputs, title);
      return finish(h);
    }

    const stop = () => this.runner.stop(inputs.run);
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (await this.asks(inputs.run)) {
        this.later(brief.task_id, inputs);
        return report('blocked', `${title} is waiting for your OK on a step.`, { blockers: ['Waiting for your OK on a step.'] });
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
    const out = this.outcome(inputs.run);
    const h = await this.settle(brief.task_id, inputs, out, brief.privacy_mode);
    this.offerResume(brief, inputs, title);
    // The person stopped the run: the task is cancelled, not failed. (When the ledger stopped it,
    // by cancelling or on its time limit, the ledger has already settled the task.)
    if (out.stopped && !signal.aborted && !TERMINAL.includes(this.ledger.get(brief.task_id).state)) this.ledger.cancel(brief.task_id, h.text);
    return finish(h);
  }

  // True as soon as the run waits for the person's answer, false if it finishes first.
  asks(run) {
    if (this.runner.liveState(run)?.approval) return Promise.resolve(true);
    return new Promise((resolve) => {
      const on = (id, live) => { if (id === run && live?.approval) { this.runner.off('live', on); resolve(true); } };
      this.runner.on('live', on);
      this.runner.idle(run).then(() => { this.runner.off('live', on); resolve(false); });
    });
  }

  // After a restart, a run that was waiting for the person's OK has no live run behind it any
  // more, and nothing would ever release it. Requeue it; run() then finds it begun but not live
  // and reports it as interrupted, which frees its schedule.
  recover() {
    const requeued = [];
    for (const t of this.ledger.list({ state: 'waiting', limit: 500 })) {
      if (t.owner !== this.id || !/waiting for your OK on a step/i.test(t.reason ?? '')) continue;
      if (this.runner.active.has(t.brief.inputs?.run)) continue;
      this.ledger.retry(t.id, 'Nova restarted while this waited for your OK.');
      requeued.push(t.id);
    }
    return requeued;
  }

  // After stepping aside: once the run finishes, the task goes back in the queue to hand off its
  // report; if it was cancelled meanwhile, the report (stopped) is handed off here.
  later(id, inputs) {
    this.runner.idle(inputs.run)
      .then(() => this.settled(id))
      .then((t) => {
        if (t.state === 'waiting') this.ledger.retry(id, 'The run finished after waiting for you; handing over its report.');
        else if (t.state === 'cancelled') return this.settle(id, inputs, this.outcome(inputs.run), t.privacy_mode ?? null);
      })
      .catch((e) => this.problem?.(`Nova couldn't pick up a task again after it waited for you.`, { detail: e?.stack ?? String(e), taskId: id }));
  }

  // Resolves with the task once the ledger has finished handling the worker's last report.
  settled(id) {
    return new Promise((resolve) => {
      const check = (t) => {
        if (t.id !== id || t.state === 'active' || t.state === 'verifying') return false;
        this.ledger.off('task', check);
        resolve(t);
        return true;
      };
      if (!check(this.ledger.get(id))) this.ledger.on('task', check);
    });
  }

  // A run stopped at a cost ceiling (Amendment 2026-10-31-B Part 5): the resume is offered as a new
  // task that waits for the person's OK (tier 2). Approved, it continues the same conversation
  // with a fresh allowance; cancelled, nothing runs. Offered once per stopped task.
  offerResume(brief, inputs, title) {
    const turn = this.store.exists(inputs.run) ? lastRunTurn(reduce(this.store.read(inputs.run))) : null;
    const stop = turn?.items.find((i) => i.kind === 'error' && String(i.detail ?? '').startsWith('cost_ceiling:'));
    if (!stop) return null;
    const t = this.ledger.get(brief.task_id);
    try {
      return this.ledger.create({
        title: `Resume: ${title}`, owner: WORKER, origin: t.origin, approval_tier: 2, privacy_mode: brief.privacy_mode,
        goal: `Resume "${title}" where it stopped at its cost ceiling, with a fresh allowance. ${stop.message}`,
        evidence_required: brief.evidence_required, context_refs: brief.context_refs ?? [],
        inputs: { ...inputs, resume: brief.task_id }, idempotency_key: `resume:${brief.task_id}`, parent_id: brief.task_id,
      });
    } catch (e) {
      this.problem?.(`Nova couldn't offer to resume ${title} after its cost ceiling.`, { detail: e?.stack ?? String(e), taskId: brief.task_id });
      return null;
    }
  }

  // What the run came to, from its log: { ok, text, failure, stopped, interrupted }.
  outcome(run) {
    const turn = this.store.exists(run) ? lastRunTurn(reduce(this.store.read(run))) : null;
    if (turn?.state === 'open' && !this.runner.active.has(run)) return { ok: false, text: '', failure: 'Nova stopped before it was done.', stopped: false, interrupted: true };
    return this.runner.report(run);
  }

  // The report this task handed off (a resumed run's conversation also holds the stopped one's).
  delivered(run, task = null) {
    if (!this.store.exists(run)) return null;
    const d = this.store.read(run).findLast((e) => e.type === 'delivered' && (!task || !e.task || e.task === task));
    if (!d) return null;
    const h = this.store.exists(d.to) ? this.store.read(d.to).find((e) => e.type === 'handoff' && e.id === d.handoff) : null;
    return { id: d.handoff, to: d.to, ok: d.ok ?? h?.ok ?? false, text: h?.text ?? '' };
  }

  // Hands the report to its conversation, once.
  settle(task, inputs, outcome, privacy = null) {
    const busy = this.settling.get(inputs.run);
    if (busy) return busy;
    const p = (async () => {
      const done = this.delivered(inputs.run, task);
      if (done) return done;
      const kind = this.kinds[inputs.kind];
      const { target, handoff } = kind.handoff(inputs, outcome);
      // A run that read outside content hands over its taint, and a screened form of its report
      // for the conversation's model (the ingest gate); the person still reads the report as written.
      const gate = await this.runner.screenReport?.(inputs.run, handoff, { privacy, task_id: task }) ?? {};
      const h = { type: 'handoff', id: randomUUID().slice(0, 8), ...handoff, ...gate, task };
      await this.runner.deliver(target, h);
      if (this.store.exists(inputs.run)) this.runner.record(inputs.run, { type: 'delivered', to: target, handoff: h.id, ok: h.ok, task });
      await kind.after?.(inputs, h, target, outcome, task);
      return { id: h.id, to: target, ok: h.ok, text: h.text };
    })().finally(() => this.settling.delete(inputs.run));
    this.settling.set(inputs.run, p);
    return p;
  }

  // The `nova-sessions` confirmation checker. Nova reads the conversation the report went to
  // itself: the report must be there, and must belong to this task.
  confirm(e, brief) {
    if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
    const run = brief.inputs?.run;
    if (!this.store || !this.store.exists(run)) return { ok: false, why: 'Nova can’t find the conversation this work ran in.' };
    const d = this.store.read(run).findLast((x) => x.type === 'delivered' && x.handoff === e.id);
    if (!d) return { ok: false, why: `The run’s log doesn’t say report ${e.id} was handed over.` };
    const where = d.to === 'main' ? 'the main conversation' : `conversation ${d.to}`;
    if (!this.store.exists(d.to)) return { ok: false, why: `Nova looked for ${where} and it isn’t there.` };
    const h = this.store.read(d.to).find((x) => x.type === 'handoff' && x.id === e.id);
    if (!h) return { ok: false, why: `Nova read ${where} itself and report ${e.id} isn’t in it.` };
    if (h.task !== brief.task_id) return { ok: false, why: `Report ${e.id} in ${where} belongs to other work.` };
    return { ok: true, why: `Nova read ${where} itself: report ${e.id} is there, handed over at ${h.ts}.` };
  }
}
