// Helpers: Nova's subagents. A helper takes one self-contained piece of work
// off a conversation and does it in the background, in a session of its own
// (kind "helper", kept in sessions/ like any other and left out of the list).
// Each helper is a Work Ledger task for the chat-run worker (src/chat-run.js).
//
// Its context is scoped: the brief, who the person is, and the files Nova
// passed along; not the conversation, memory or schedules. It can't ask the
// person anything, so what needs an OK is declined, as in scheduled runs. Its
// final message comes back to the conversation that asked, as a handoff.
//
// Up to three work at once; more wait their turn (in the ledger, so they still
// run after a restart). If Nova stops while one is working, the conversation
// hears so when Nova starts again.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inHome } from './home.js';
import { reduce, titleFrom } from '../ui/js/reduce.js';
import { WORKER, begun, openTasks } from './chat-run.js';

const MAX_TASK = 8000;
const MAX_FILES = 5;
const MAX_FILE = 20_000;
const PRIVATE = ['connectors', 'sessions'];

export class HelperError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Helpers extends EventEmitter {
  constructor({ runner, store, ledger = null, max = 3 }) {
    super();
    Object.assign(this, { runner, store, ledger, max });
    this.worker = null; // the chat-run worker, set when it binds
  }

  // The delegate tool. Returns at once; the work is a Work Ledger task for the chat-run worker.
  spawn({ title, task, files = [], parent, turn = null }) {
    const brief = String(task ?? '').trim();
    if (!brief) throw new HelperError('A helper needs a task: what to do, and what to report back.');
    if (brief.length > MAX_TASK) throw new HelperError(`The task is too long (${brief.length} characters; the limit is ${MAX_TASK}). Put the details in a file and pass it in "files".`);
    if (!Array.isArray(files)) throw new HelperError('"files" must be a list of paths in your home.');
    if (files.length > MAX_FILES) throw new HelperError(`A helper can take up to ${MAX_FILES} files.`);
    const passed = files.map((p) => this.readFile(p));
    const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || titleFrom(brief, 48);
    const run = this.store.newId();
    const waits = this.tasks().filter((t) => t.state === 'queued' || t.state === 'active').length >= this.max;
    // Work started inside a ledger task belongs under it; otherwise the person asked for it.
    const from = parent && this.store.exists(parent) ? this.store.read(parent)[0] : null;
    let up = null;
    try { up = from?.task ? this.ledger.get(from.task) : null; } catch { /* that task is gone */ }
    let t;
    try {
      t = this.ledger.create({
        title: name, owner: WORKER, goal: brief,
        origin: up ? up.origin : { kind: 'user', ref: `session:${parent}${turn ? `/${turn}` : ''}` },
        ...(up ? { parent_id: up.id } : {}),
        evidence_required: [{ kind: 'confirmation', note: 'The report is in the conversation that asked.' }],
        context_refs: passed.map((f) => ({ kind: 'file', ref: `~/${f.path}`, sha256: createHash('sha256').update(f.text).digest('hex') })),
        inputs: { kind: 'helper', run, title: name, parent, ...(turn ? { turn } : {}), files: passed },
      });
    } catch (e) {
      throw new HelperError(e.message);
    }
    this.runner.record(run, { type: 'session', id: run, title: name, kind: 'helper', parent, ...(turn ? { turn } : {}), files: passed.map((f) => f.path), task: t.id, v: 1 });
    this.emit('change');
    return { run, title: name, queued: waits, task: t.id };
  }

  readFile(path) {
    const abs = inHome(this.runner.config.home, path);
    const rel = relative(this.runner.config.home, abs);
    if (PRIVATE.some((d) => rel === d || rel.startsWith(`${d}${sep}`))) throw new HelperError(`${path} can't be passed to a helper.`);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw new HelperError(`There's no file at ${path} to pass along.`);
    const text = readFileSync(abs, 'utf8');
    return { path: rel.split(sep).join('/'), text: text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n[truncated: the file is ${text.length} characters]` : text };
  }

  // ---- state, read from the ledger ---------------------------------------------

  tasks() { return openTasks(this.ledger, 'helper'); }
  taskFor(run) { return this.tasks().find((t) => t.brief.inputs.run === run) ?? null; }

  // Helpers at work, including any waiting for the person's OK: run id → { run, title, parent, started }.
  get running() {
    const out = new Map();
    for (const t of this.tasks()) {
      const i = t.brief.inputs;
      if (!begun(this.store, i.run)) continue;
      if (t.state === 'waiting' && !this.runner.active.has(i.run)) continue;
      out.set(i.run, { run: i.run, title: i.title, parent: i.parent, started: this.store.read(i.run).find((e) => e.type === 'user')?.ts ?? t.updated_at, task: t.id });
    }
    return out;
  }

  // Helpers waiting their turn (or waiting on local capacity), oldest first.
  get queue() {
    return this.tasks().filter((t) => !begun(this.store, t.brief.inputs.run))
      .map((t) => ({ run: t.brief.inputs.run, title: t.brief.inputs.title, parent: t.brief.inputs.parent, queued: t.created_at, task: t.id }));
  }

  // Stop one, working or waiting. Returns false if it isn't either.
  stop(run) {
    const t = this.taskFor(run);
    if (!t) return false;
    const live = this.runner.active.has(run);
    this.ledger.cancel(t.id, 'You stopped this helper before it finished.');
    // A run in progress stops, and its report (stopped) is handed over as it ends.
    if (live) this.runner.stop(run);
    else this.worker.settle(t.id, t.brief.inputs, { ok: false, text: '', stopped: true }).catch(() => {});
    this.emit('change');
    return true;
  }

  // The same brief and files again, for a helper that failed or was stopped.
  retry(run) {
    if (!this.store.exists(run)) throw new HelperError('That helper is gone.', 404);
    const events = this.store.read(run);
    const meta = events[0];
    if (meta?.kind !== 'helper') throw new HelperError('That isn\'t a helper.', 404);
    let task = events.find((e) => e.type === 'user')?.text;
    try { task ??= meta.task ? this.ledger.get(meta.task).brief.goal : undefined; } catch { /* that task is gone */ }
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

  // ---- the chat-run kind ----------------------------------------------------------

  title(inputs) { return inputs.title; }

  begin(inputs, brief) {
    if (!this.store.exists(inputs.run)) {
      this.runner.record(inputs.run, { type: 'session', id: inputs.run, title: inputs.title, kind: 'helper', parent: inputs.parent, ...(inputs.turn ? { turn: inputs.turn } : {}), files: (inputs.files ?? []).map((f) => f.path), task: brief.task_id, v: 1 });
    }
    this.runner.send(inputs.run, brief.goal, { helper: { title: inputs.title, files: inputs.files ?? [] }, privacy: brief.privacy_mode });
    this.emit('change');
    return null;
  }

  // The report goes back to the conversation that asked, or to the main one if that one is gone.
  handoff(inputs, { ok = false, text = '', failure = '', stopped = false, interrupted = false }) {
    const target = this.store.exists(inputs.parent) ? inputs.parent : 'main';
    const said = stopped ? 'You stopped this helper before it finished.'
      : ok ? text
        : interrupted ? `${inputs.title} didn't finish: ${failure}`
          : `${inputs.title} didn't finish. ${failure}`;
    return { target, handoff: { helper: inputs.run, name: inputs.title, run: inputs.run, ok: ok && !stopped, ...(stopped ? { stopped: true } : {}), text: said } };
  }

  after(inputs, handoff, target, { ok, stopped }) {
    this.emit('ran', { target, handoff: handoff.id });
    this.emit('change');
    // Then Nova says what the report means, under it, as the person asked.
    if (ok && !stopped) this.runner.followUp(target, handoff.id).catch(() => {});
  }

  // Helper logs from before the ledger (no task in their first line) whose report was lost when
  // Nova stopped: tell their conversations, so nothing waits forever. Only recent logs are read.
  // Helpers with a task are the ledger's: it runs them on start, or hands over that they didn't finish.
  async recover(days = 3) {
    const dir = this.store.dir;
    if (!existsSync(dir)) return 0;
    const since = Date.now() - days * 86_400_000;
    let told = 0;
    for (const f of readdirSync(dir)) {
      const id = f.slice(0, -6);
      if (!f.endsWith('.jsonl') || id === 'main' || this.runner.active.has(id) || statSync(join(dir, f)).mtimeMs < since) continue;
      let events;
      try { events = this.store.read(id); } catch { continue; }
      const meta = events[0];
      if (meta?.kind !== 'helper' || meta.task || events.some((e) => e.type === 'delivered')) continue;
      const inputs = { kind: 'helper', run: id, title: meta.title, parent: meta.parent };
      const turn = reduce(events).turns[0];
      // Finished, with only the delivery lost: hand over what it wrote.
      const out = turn && turn.state !== 'open' ? this.runner.report(id) : { ok: false, failure: 'Nova stopped before it was done.', interrupted: true };
      await this.worker.settle(null, inputs, out);
      told++;
    }
    return told;
  }
}
