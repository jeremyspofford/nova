// The scheduler: checks the schedules every half minute and queues what's due.
// Each run is Work Ledger work: a heartbeat trigger record plus a task for the
// chat-run worker (src/chat-run.js), which runs one scheduled run at a time.
// A run is a conversation of its own (kind "run", kept in sessions/ like any
// other and left out of the list) where Nova works unattended; its final
// message is handed off as a report to the main conversation, or to the
// conversation the schedule was set up in. A run waiting for the person's OK
// steps aside, so the schedules behind it aren't held up.
//
// Nova only runs while it's running. When it starts, a run missed in the last
// six hours runs late, once; anything older is recorded as missed. Runs still
// queued when Nova stopped are in the ledger, and run when it starts again.
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { lastRun, nextRun } from './cron.js';
import { WORKER, begun, headline, openTasks } from './chat-run.js';

const CATCH_UP = 6 * 3600_000;
const LATE = 2 * 60_000;

export class Scheduler extends EventEmitter {
  constructor({ schedules, runner, store, timezone, ledger = null, triggers = null, now = () => new Date() }) {
    super();
    Object.assign(this, { schedules, runner, store, timezone, ledger, triggers, now });
    this.next = new Map();    // id → { cron, at }
    this.pending = new Set(); // ids being queued right now
    this.max = 1;             // scheduled runs at once (the chat-run lane)
    this.busy = Promise.resolve();
  }

  start(every = 30_000) {
    this.timer = setInterval(() => this.tick(), every);
    this.timer.unref?.();
    this.tick();
  }

  stop() { clearInterval(this.timer); }

  tick(now = this.now()) {
    const latest = this.schedules.latest();
    const seen = new Set();
    for (const s of this.schedules.list()) {
      seen.add(s.id);
      if (s.error || s.paused) { this.next.delete(s.id); continue; }
      const known = this.next.get(s.id);
      if (!known || known.cron !== s.cron) {
        // First sight of this schedule (or a new time): catch up on the run
        // missed since it last ran, or since the file was last written.
        const last = latest.get(s.id);
        const since = new Date(Math.max(Date.parse(s.changed), Date.parse(last?.due ?? 0) || 0));
        const missed = lastRun(s.cron, since, now, this.timezone);
        if (missed) this.due(s, missed, now);
        this.next.set(s.id, { cron: s.cron, at: nextRun(s.cron, now, this.timezone) });
        continue;
      }
      if (known.at && known.at <= now) {
        this.due(s, known.at, now);
        known.at = nextRun(s.cron, now, this.timezone);
      }
    }
    for (const id of this.next.keys()) if (!seen.has(id)) this.next.delete(id);
    return this.busy;
  }

  due(s, at, now) {
    if (now - at > CATCH_UP) {
      this.schedules.record({ schedule: s.id, name: s.name, due: at.toISOString(), missed: true });
      this.emit('change');
      return;
    }
    this.enqueue(s.id, { due: at, late: now - at > LATE });
  }

  // Run a schedule now, whatever its time. Returns false if it's already waiting.
  runNow(id) {
    const s = this.schedules.get(id);
    if (!s) return false;
    return this.enqueue(s.id, { due: this.now(), manual: true });
  }

  // Queues one run as Work Ledger work: a heartbeat trigger record (source schedule:<id>), and
  // through it a chat-run task. Each due time is claimed once, so a second tick, or a restart
  // with the run still queued, can't run it twice. Returns false if it's already on its way.
  enqueue(id, how) {
    const s = this.schedules.get(id);
    if (!s || s.error || this.pending.has(id) || this.open(id)) return false;
    this.pending.add(id);
    this.emit('change');
    const queued = this.queueRun(s, how)
      .catch((e) => this.schedules.record({ schedule: s.id, name: s.name, due: how.due.toISOString(), ok: false, error: e.message }))
      .finally(() => { this.pending.delete(id); this.emit('change'); });
    this.busy = this.busy.then(() => queued);
    return true;
  }

  async queueRun(s, { due, late = false, manual = false }) {
    const run = this.store.newId();
    const inputs = {
      kind: 'schedule', schedule: s.id, name: s.name, run, due: due.toISOString(), deliver: s.deliver,
      ...(late ? { late: true } : {}), ...(manual ? { manual: true } : {}),
    };
    const t = await this.triggers.fire({
      class: 'heartbeat', source: `schedule:${s.id}`, name: s.name, payload: { due: inputs.due, ...(manual ? { manual: true } : {}) },
      ...(manual ? {} : { claim_key: `schedule:${s.id}@${inputs.due}` }),
      action: {
        kind: 'task',
        task: {
          title: s.name, owner: WORKER,
          goal: `Do the scheduled work "${s.name}" on its own, as its instructions say, and hand the report to ${s.deliver === 'main' ? 'the main conversation' : 'the conversation it was set up in'}.`,
          evidence_required: [{ kind: 'confirmation', note: 'The report is in the conversation it is for.' }],
          context_refs: [{ kind: 'file', ref: `~/schedules/${s.id}.md`, sha256: createHash('sha256').update(s.prompt).digest('hex') }],
          inputs,
        },
      },
    });
    if (!t) return null; // this due time was already claimed
    if (!t.ledger_task_id) await this.notRun(s, inputs, t);
    return t;
  }

  // Triage held it back, or the ledger refused it (local-only with a model in the cloud): the
  // conversation it reports to hears why, and the run is recorded.
  async notRun(s, inputs, t) {
    const target = this.target(s.deliver);
    const handoff = {
      type: 'handoff', id: randomUUID().slice(0, 8), schedule: s.id, name: s.name, ok: false, due: inputs.due, trigger: t.trigger_id,
      ...(inputs.late ? { late: true } : {}), ...(inputs.manual ? { manual: true } : {}),
      text: `${s.name} didn't run. ${t.triage.reason}`,
    };
    await this.runner.deliver(target, handoff);
    this.schedules.record({ schedule: s.id, name: s.name, due: inputs.due, ok: false, error: t.triage.reason, delivered: target, handoff: handoff.id, trigger: t.trigger_id,
      ...(inputs.late ? { late: true } : {}), ...(inputs.manual ? { manual: true } : {}) });
    this.emit('ran', { schedule: s.id, target, handoff: handoff.id });
  }

  target(deliver) {
    return deliver && deliver !== 'main' && this.store.exists(deliver) ? deliver : 'main';
  }

  // ---- state, read from the ledger ---------------------------------------------

  tasks() { return openTasks(this.ledger, 'schedule'); }
  open(id) { return this.tasks().some((t) => t.brief.inputs.schedule === id); }

  // One schedule's run on its way: queued (not started), running, or waiting for the person.
  status(id) {
    for (const t of this.tasks()) {
      const i = t.brief.inputs;
      if (i.schedule !== id) continue;
      if (!begun(this.store, i.run)) return { queued: true, due: i.due, task: t.id };
      const started = this.store.read(i.run)[0]?.ts ?? t.updated_at;
      const waiting = t.state === 'waiting' || !!this.runner.liveState(i.run)?.approval;
      return { running: { id, run: i.run, started, task: t.id, ...(waiting ? { waiting: true } : {}) } };
    }
    return {};
  }

  // Runs not started yet, oldest first.
  get queue() {
    return this.tasks().filter((t) => !begun(this.store, t.brief.inputs.run))
      .map((t) => ({ id: t.brief.inputs.schedule, due: new Date(t.brief.inputs.due), run: t.brief.inputs.run, task: t.id }));
  }

  get running() {
    const t = this.tasks().find((x) => x.state === 'active' && begun(this.store, x.brief.inputs.run));
    return t ? this.status(t.brief.inputs.schedule).running : null;
  }

  // Runs that stepped aside to wait for the person's answer.
  get waiting() {
    return new Map(this.tasks().filter((t) => t.state === 'waiting' && begun(this.store, t.brief.inputs.run))
      .map((t) => [t.brief.inputs.schedule, this.status(t.brief.inputs.schedule).running]));
  }

  // ---- the chat-run kind ----------------------------------------------------------

  title(inputs) { return inputs.name; }

  // Starts the run with the schedule as it is now. Returns why not, if it can't.
  begin(inputs, brief) {
    const s = this.schedules.get(inputs.schedule);
    if (!s || s.error) return `${inputs.name} was removed or can't be read any more, so it didn't run.`;
    const { runner } = this;
    runner.record(inputs.run, { type: 'session', id: inputs.run, title: s.name, kind: 'run', schedule: s.id, due: inputs.due, task: brief.task_id, v: 1 });
    runner.send(inputs.run, s.prompt, { unattended: { id: s.id, name: s.name, due: new Date(inputs.due), late: !!inputs.late }, privacy: brief.privacy_mode });
    this.emit('change');
    return null;
  }

  handoff(inputs, { ok, text, failure }) {
    const target = this.target(this.schedules.get(inputs.schedule)?.deliver ?? inputs.deliver);
    return {
      target,
      handoff: {
        schedule: inputs.schedule, name: inputs.name, run: inputs.run, ok, due: inputs.due,
        ...(inputs.late ? { late: true } : {}), ...(inputs.manual ? { manual: true } : {}),
        text: ok ? text : `${inputs.name} didn't finish. ${failure}`,
      },
    };
  }

  after(inputs, handoff, target, { ok, text, failure }, task) {
    this.schedules.record({
      schedule: inputs.schedule, name: inputs.name, run: inputs.run, due: inputs.due,
      started: this.store.exists(inputs.run) ? this.store.read(inputs.run)[0]?.ts : undefined, finished: new Date().toISOString(),
      ok, ...(inputs.late ? { late: true } : {}), ...(inputs.manual ? { manual: true } : {}), ...(ok ? { summary: headline(text) } : { error: failure }),
      delivered: target, handoff: handoff.id, task,
    });
    const s = this.schedules.get(inputs.schedule);
    if (s?.once) this.schedules.remove(s.id);
    this.emit('ran', { schedule: inputs.schedule, target, handoff: handoff.id });
    this.emit('change');
  }
}
