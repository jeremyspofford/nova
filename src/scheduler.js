// The scheduler: checks the schedules every half minute and runs what's due,
// one run at a time. A run is a conversation of its own (kind "run", kept in
// sessions/ like any other and left out of the list) where Nova works
// unattended; its final message is handed off as a report to the main
// conversation, or to the conversation the schedule was set up in.
//
// Nova only runs while it's running. When it starts, a run missed in the last
// six hours runs late, once; anything older is recorded as missed.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lastRun, nextRun } from './cron.js';

const CATCH_UP = 6 * 3600_000;
// A report's first line, as plain words, for the Schedules view.
const headline = (text) => {
  const first = text.split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim() ?? '';
  return first.length > 140 ? `${first.slice(0, 138).replace(/\s+\S*$/, '')}…` : first;
};
const LATE = 2 * 60_000;

export class Scheduler extends EventEmitter {
  constructor({ schedules, runner, store, timezone, now = () => new Date() }) {
    super();
    Object.assign(this, { schedules, runner, store, timezone, now });
    this.next = new Map();    // id → { cron, at }
    this.queue = [];
    this.running = null;      // { id, run, started }
    this.waiting = new Map(); // id → { id, run, started }: runs waiting for the person's answer
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

  enqueue(id, how) {
    if (this.running?.id === id || this.waiting.has(id) || this.queue.some((q) => q.id === id)) return false;
    this.queue.push({ id, ...how });
    this.emit('change');
    this.busy = this.busy.then(() => this.work());
    return true;
  }

  async work() {
    const job = this.queue.shift();
    if (!job) return;
    const s = this.schedules.get(job.id);
    if (!s || s.error) { this.emit('change'); return; } // removed while it waited
    const failed = (e) => this.schedules.record({ schedule: s.id, name: s.name, due: job.due.toISOString(), ok: false, error: e.message });
    try {
      const { run, started } = this.begin(s, job);
      // A run waiting for the person's answer steps aside, so the schedules
      // behind it aren't held up; it finishes whenever they answer.
      if (await this.asks(run)) {
        this.waiting.set(s.id, this.running);
        this.running = null;
        this.emit('change');
        this.finish(s, job, run, started).catch(failed).finally(() => { this.waiting.delete(s.id); this.emit('change'); });
        return;
      }
      await this.finish(s, job, run, started);
    } catch (e) { failed(e); } finally {
      this.running = null;
      this.emit('change');
    }
  }

  // One unattended run; finish() hands off its report.
  begin(s, { due, late = false }) {
    const { runner, store } = this;
    const run = store.newId();
    const started = new Date();
    this.running = { id: s.id, run, started: started.toISOString() };
    this.emit('change');
    runner.record(run, { type: 'session', id: run, title: s.name, kind: 'run', schedule: s.id, due: due.toISOString(), v: 1 });
    runner.send(run, s.prompt, { unattended: { id: s.id, name: s.name, due, late } });
    return { run, started };
  }

  // True as soon as the run waits for an answer, false if it finishes first.
  asks(run) {
    const { runner } = this;
    return new Promise((resolve) => {
      const on = (id, live) => { if (id === run && live?.approval) { runner.off('live', on); resolve(true); } };
      runner.on('live', on);
      runner.idle(run).then(() => { runner.off('live', on); resolve(false); });
    });
  }

  async finish(s, { due, late = false, manual = false }, run, started) {
    const { runner, store } = this;
    await runner.idle(run);

    const { ok, text: report, failure } = runner.report(run);
    const target = s.deliver !== 'main' && store.exists(s.deliver) ? s.deliver : 'main';
    const handoff = {
      type: 'handoff', id: randomUUID().slice(0, 8), schedule: s.id, name: s.name, run, ok,
      due: due.toISOString(), ...(late ? { late: true } : {}), ...(manual ? { manual: true } : {}),
      text: ok ? report : `${s.name} didn't finish. ${failure}`,
    };
    await runner.deliver(target, handoff);
    this.schedules.record({
      schedule: s.id, name: s.name, run, due: handoff.due, started: started.toISOString(), finished: new Date().toISOString(),
      ok, ...(late ? { late: true } : {}), ...(manual ? { manual: true } : {}), ...(ok ? { summary: headline(report) } : { error: failure }),
      delivered: target, handoff: handoff.id,
    });
    if (s.once && this.schedules.get(s.id)) this.schedules.remove(s.id);
    this.emit('ran', { schedule: s.id, target, handoff: handoff.id });
  }
}
