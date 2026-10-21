// Helpers: Nova's subagents. A helper takes one self-contained piece of work
// off a conversation and does it in the background, in a session of its own
// (kind "helper", kept in sessions/ like any other and left out of the list).
//
// Its context is scoped: the brief, who the person is, and the files Nova
// passed along; not the conversation, memory or schedules. It can't ask the
// person anything, so what needs an OK is declined, as in scheduled runs. Its
// final message comes back to the conversation that asked, as a handoff.
//
// Up to three work at once; more wait their turn. If Nova stops while one is
// working, the conversation hears so when Nova starts again.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inHome } from './home.js';
import { reduce, titleFrom } from '../ui/js/reduce.js';

const MAX_TASK = 8000;
const MAX_FILES = 5;
const MAX_FILE = 20_000;
const PRIVATE = ['connectors', 'sessions'];

export class HelperError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Helpers extends EventEmitter {
  constructor({ runner, store, max = 3 }) {
    super();
    Object.assign(this, { runner, store, max });
    this.queue = [];          // jobs waiting for a free helper
    this.running = new Map(); // run id → { run, title, parent, started }
  }

  // The delegate tool. Returns at once; the work happens in the background.
  spawn({ title, task, files = [], parent, turn = null }) {
    const brief = String(task ?? '').trim();
    if (!brief) throw new HelperError('A helper needs a task: what to do, and what to report back.');
    if (brief.length > MAX_TASK) throw new HelperError(`The task is too long (${brief.length} characters; the limit is ${MAX_TASK}). Put the details in a file and pass it in "files".`);
    if (!Array.isArray(files)) throw new HelperError('"files" must be a list of paths in your home.');
    if (files.length > MAX_FILES) throw new HelperError(`A helper can take up to ${MAX_FILES} files.`);
    const passed = files.map((p) => this.readFile(p));
    const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || titleFrom(brief, 48);
    const run = this.store.newId();
    this.runner.record(run, { type: 'session', id: run, title: name, kind: 'helper', parent, ...(turn ? { turn } : {}), files: passed.map((f) => f.path), v: 1 });
    const job = { run, title: name, task: brief, files: passed, parent, queued: new Date().toISOString() };
    this.queue.push(job);
    const waits = this.running.size >= this.max;
    this.emit('change');
    this.pump();
    return { run, title: name, queued: waits };
  }

  readFile(path) {
    const abs = inHome(this.runner.config.home, path);
    const rel = relative(this.runner.config.home, abs);
    if (PRIVATE.some((d) => rel === d || rel.startsWith(`${d}${sep}`))) throw new HelperError(`${path} can't be passed to a helper.`);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw new HelperError(`There's no file at ${path} to pass along.`);
    const text = readFileSync(abs, 'utf8');
    return { path: rel.split(sep).join('/'), text: text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n[truncated: the file is ${text.length} characters]` : text };
  }

  pump() {
    while (this.running.size < this.max && this.queue.length) {
      const job = this.queue.shift();
      this.running.set(job.run, { run: job.run, title: job.title, parent: job.parent, started: new Date().toISOString() });
      this.execute(job)
        .catch((e) => console.error(`Helper ${job.run} failed to report:`, e))
        .finally(() => { this.running.delete(job.run); this.emit('change'); this.pump(); });
    }
  }

  async execute(job) {
    const { runner } = this;
    runner.send(job.run, job.task, { helper: { title: job.title, files: job.files } });
    this.emit('change');
    await runner.idle(job.run);
    await this.hand(job, this.outcome(job));
  }

  outcome({ run, title }) {
    const r = this.runner.report(run);
    return r.ok ? { ok: true, text: r.text } : r.stopped ? { stopped: true } : { text: `${title} didn't finish. ${r.failure}` };
  }

  // The report goes back to the conversation that asked, or to the main one
  // if that conversation is gone.
  async hand(job, { ok = false, text = '', stopped = false }) {
    const target = this.store.exists(job.parent) ? job.parent : 'main';
    const handoff = {
      type: 'handoff', id: randomUUID().slice(0, 8), helper: job.run, name: job.title, run: job.run, ok,
      ...(stopped ? { stopped: true } : {}), text: stopped ? 'You stopped this helper before it finished.' : text,
    };
    await this.runner.deliver(target, handoff);
    this.runner.record(job.run, { type: 'delivered', to: target, handoff: handoff.id });
    this.emit('ran', { target, handoff: handoff.id });
    // Then Nova says what the report means, under it, as the person asked.
    if (ok && !stopped) this.runner.followUp(target, handoff.id).catch(() => {});
  }

  // Stop one, working or waiting. Returns false if it isn't either.
  stop(run) {
    const waiting = this.queue.findIndex((j) => j.run === run);
    if (waiting >= 0) {
      const [job] = this.queue.splice(waiting, 1);
      this.emit('change');
      this.hand(job, { stopped: true }).catch(() => {});
      return true;
    }
    return this.running.has(run) && this.runner.stop(run);
  }

  // The same brief and files again, for a helper that failed or was stopped.
  retry(run) {
    if (!this.store.exists(run)) throw new HelperError('That helper is gone.', 404);
    const events = this.store.read(run);
    const meta = events[0];
    if (meta?.kind !== 'helper') throw new HelperError('That isn\'t a helper.', 404);
    const task = events.find((e) => e.type === 'user')?.text ?? this.queue.find((j) => j.run === run)?.task;
    if (!task) throw new HelperError('That helper never got its brief, so there is nothing to run again.', 409);
    return this.spawn({ title: meta.title, task, files: (meta.files ?? []).filter((p) => existsSync(join(this.runner.config.home, p))), parent: meta.parent, turn: meta.turn });
  }

  // What's working and waiting, for the Activity view.
  now() {
    return {
      running: [...this.running.values()],
      queued: this.queue.map(({ run, title, parent, queued }) => ({ run, title, parent, queued })),
    };
  }

  // Helpers that were working when Nova last stopped never reported. Tell
  // their conversations, so nothing waits forever. Only recent logs are read.
  async recover(days = 3) {
    const dir = this.store.dir;
    if (!existsSync(dir)) return 0;
    const since = Date.now() - days * 86_400_000;
    let told = 0;
    for (const f of readdirSync(dir)) {
      const id = f.slice(0, -6);
      if (!f.endsWith('.jsonl') || id === 'main' || this.running.has(id) || statSync(join(dir, f)).mtimeMs < since) continue;
      let events;
      try { events = this.store.read(id); } catch { continue; }
      const meta = events[0];
      if (meta?.kind !== 'helper' || events.some((e) => e.type === 'delivered')) continue;
      const job = { run: id, title: meta.title, parent: meta.parent };
      const turn = reduce(events).turns[0];
      // Finished, with only the delivery lost: hand over what it wrote.
      await this.hand(job, turn && turn.state !== 'open' ? this.outcome(job) : { text: `${meta.title} didn't finish: Nova stopped before it was done.` });
      told++;
    }
    return told;
  }
}
