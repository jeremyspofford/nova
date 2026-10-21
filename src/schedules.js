// Schedules: work Nova does on its own at set times. Each one is a markdown
// file in the home's schedules/: front matter says when (a five-field cron in
// the person's timezone) and where the report goes; the body is what to do,
// written as instructions. Nova ships a few in schedules/ to set up with a
// time; the person or Nova (with the person's OK) can write others.
//
// Every run is appended to schedules/runs.jsonl: when it was due, when it ran,
// whether it worked, and where its report went.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronError, describeCron, nextRun, parseCron, timeOfDay } from './cron.js';
import { parseFrontMatter, slug } from './skills.js';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_PROMPT = 8000;
const DAYS = { every: '*', weekdays: '1-5', weekends: '0,6' };

export class ScheduleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const line = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const yes = (v) => /^(true|yes|on)$/i.test(String(v ?? '').trim());

// "Thursday, October 22 at 7:00 AM", in the person's timezone.
export function formatWhen(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const day = d.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' });
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${day} at ${timeOfDay(Number(p.hour) % 24, Number(p.minute))}`;
}

function serialize(s) {
  const head = [`name: ${line(s.name)}`];
  if (s.about) head.push(`about: ${line(s.about)}`);
  head.push(`cron: ${line(s.cron)}`, `deliver: ${line(s.deliver || 'main')}`);
  if (s.once) head.push('once: true');
  if (s.paused) head.push('paused: true');
  return `---\n${head.join('\n')}\n---\n\n${String(s.prompt).trim()}\n`;
}

export class Schedules {
  constructor(root, home, timezone) {
    this.shipped = join(root, 'schedules');
    this.dir = join(home, 'schedules');
    this.log = join(this.dir, 'runs.jsonl');
    this.timezone = timezone;
  }

  read(dir, id) {
    const path = join(dir, `${id}.md`);
    if (!ID.test(id) || !existsSync(path)) return null;
    const { meta, body } = parseFrontMatter(readFileSync(path, 'utf8'));
    const s = {
      id,
      name: meta.name || id,
      about: meta.about || '',
      cron: meta.cron || '',
      deliver: meta.deliver || 'main',
      once: yes(meta.once),
      paused: yes(meta.paused),
      prompt: body,
      changed: statSync(path).mtime.toISOString(),
    };
    try {
      parseCron(s.cron);
      s.when = s.once ? `Once, on ${formatWhen(nextRun(s.cron, new Date(), this.timezone), this.timezone)}` : describeCron(s.cron);
    } catch (e) { s.error = `Nova can't read when this runs: ${e.message}`; s.when = ''; }
    if (!s.error && !s.prompt) s.error = 'This schedule has no instructions, so it has nothing to do.';
    return s;
  }

  readAll(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => this.read(dir, f.slice(0, -3))).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  list() { return this.readAll(this.dir); }
  get(id) { return this.read(this.dir, String(id)); }

  // Shipped schedules that aren't set up yet.
  available() {
    const have = new Set(this.list().map((s) => s.id));
    return this.readAll(this.shipped).filter((s) => !have.has(s.id));
  }

  next(s, after = new Date()) {
    if (s.error || s.paused) return null;
    return nextRun(s.cron, after, this.timezone);
  }

  // Check a schedule Nova was asked to set, and say exactly what it will be.
  plan(args = {}, { from = 'main' } = {}) {
    const name = line(args.name);
    if (!name) throw new ScheduleError('A schedule needs a name, such as "Morning digest".');
    const id = args.id ? String(args.id).trim().toLowerCase() : slug(name);
    if (!ID.test(id)) throw new ScheduleError(`“${args.id ?? name}” can't be used as a schedule id.`);
    const existing = this.get(id);
    if (existing && !args.id) throw new ScheduleError(`There's already a schedule called ${existing.name} (id ${id}). To change it, pass "id": "${id}"; to add another, give it a different name.`);
    if (args.id && !existing) throw new ScheduleError(`There's no schedule with the id ${id}. Leave out "id" to set up a new one.`);
    let cron;
    try { cron = parseCron(args.cron).expr; } catch (e) { throw new ScheduleError(e instanceof CronError ? e.message : 'That schedule time is not valid.'); }
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new ScheduleError('A schedule needs instructions: what Nova should do each time it runs.');
    if (prompt.length > MAX_PROMPT) throw new ScheduleError(`The instructions are too long (${prompt.length} characters; the limit is ${MAX_PROMPT}).`);
    // Reports go where the schedule was asked for, or to the main conversation.
    const deliver = args.deliver === 'main' || from === 'main' ? 'main' : args.deliver === undefined && existing ? existing.deliver : from;
    const next = nextRun(cron, new Date(), this.timezone);
    if (!next) throw new ScheduleError(`${cron} never happens, so it would never run.`);
    const once = args.once === true || yes(args.once);
    return {
      id, name, cron, prompt, deliver, once,
      about: existing?.about ?? '',
      paused: false,
      when: once ? `Once, on ${formatWhen(next, this.timezone)}` : describeCron(cron),
      next: formatWhen(next, this.timezone),
      replaces: existing ? existing.name : null,
    };
  }

  set(args, opts) {
    const plan = this.plan(args, opts);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${plan.id}.md`), serialize(plan));
    return { ...this.get(plan.id), next: plan.next };
  }

  // A shipped schedule, set up at a time the person picked.
  setup(id, { time = '07:00', days = 'every' } = {}) {
    const s = this.read(this.shipped, String(id));
    if (!s) throw new ScheduleError('That schedule is no longer offered.', 404);
    if (this.get(s.id)) throw new ScheduleError(`${s.name} is already set up.`, 409);
    const m = String(time).match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ScheduleError('Pick a time of day, such as 7:00 AM.');
    if (!DAYS[days]) throw new ScheduleError('Pick every day, weekdays or weekends.');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${s.id}.md`), serialize({ ...s, cron: `${Number(m[2])} ${Number(m[1])} * * ${DAYS[days]}`, paused: false }));
    return this.get(s.id);
  }

  setPaused(id, paused) {
    const s = this.get(id);
    if (!s) throw new ScheduleError('That schedule is gone. It may have been removed.', 404);
    writeFileSync(join(this.dir, `${s.id}.md`), serialize({ ...s, paused }));
    return this.get(s.id);
  }

  // The file's text, so Undo can put it back exactly.
  remove(id) {
    const s = this.get(id);
    if (!s) throw new ScheduleError('That schedule is already gone.', 404);
    const path = join(this.dir, `${s.id}.md`);
    const text = readFileSync(path, 'utf8');
    rmSync(path);
    return { ...s, text };
  }

  restore(id, text) {
    if (!ID.test(String(id)) || typeof text !== 'string' || !text.trim()) throw new ScheduleError('Nothing to put back.');
    if (this.get(id)) throw new ScheduleError('A schedule with that name is already there.', 409);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${id}.md`), text);
    return this.get(id);
  }

  // ---- runs ------------------------------------------------------------------

  record(run) {
    mkdirSync(this.dir, { recursive: true });
    const entry = { ts: new Date().toISOString(), ...run };
    appendFileSync(this.log, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  runs() {
    if (!existsSync(this.log)) return [];
    const out = [];
    for (const l of readFileSync(this.log, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* a torn last line */ }
    }
    return out;
  }

  // schedule id → its latest run (or missed run).
  latest() {
    const out = new Map();
    for (const r of this.runs()) out.set(r.schedule, r);
    return out;
  }
}
