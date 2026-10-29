// What Nova is doing and did, for the Activity view: a timeline derived from
// the session logs and the Work Ledger, with nothing stored of its own. Work
// waiting its turn is read from the ledger's queued tasks.
//
// Each reply, scheduled run and helper is one entry. Its steps are what Nova
// actually did, in order: the skills it followed, what it read, searched and
// changed, what it asked the person and what they said, and what it kept in
// memory. Tool output stays in the logs; this is the story, not the dump.
//
// Days are the person's days (the configured timezone). A page covers a week;
// `before` asks for the week before a day.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reduce } from '../ui/js/reduce.js';
import { begun, openTasks } from './chat-run.js';

const DAY = 86_400_000;
const ARG_KEYS = ['path', 'url', 'command', 'query', 'name', 'id', 'title'];
const cache = new Map(); // file → { mtimeMs, size, session }

const formats = new Map(); // making a formatter costs more than using one
const dayOf = (iso, timezone) => {
  if (!formats.has(timezone)) formats.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return formats.get(timezone).format(new Date(iso));
};
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const clip = (t, n) => { const one = String(t ?? '').replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : one; };

function readSession(store, id) {
  const file = store.path(id);
  const { mtimeMs, size } = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.session;
  const session = reduce(store.read(id), id);
  cache.set(file, { mtimeMs, size, session });
  return session;
}

// Only what a step's words need; the rest stays in the log.
const slim = (args = {}) => Object.fromEntries(ARG_KEYS.filter((k) => typeof args[k] === 'string').map((k) => [k, clip(args[k], 200)]));

function steps(turn) {
  const out = [];
  for (const it of turn.items) {
    if (it.kind === 'skill') out.push({ kind: 'skill', id: it.id, name: it.name });
    if (it.kind === 'tool' && !(it.name === 'use_skill' && it.result?.ok)) {
      out.push({
        kind: 'tool', id: it.id, name: it.name, args: slim(it.args), ts: it.ts, needsApproval: it.needsApproval,
        approval: it.approval, result: it.result ? { ok: it.result.ok, summary: it.result.summary, link: it.result.link } : null,
      });
    }
    if (it.kind === 'memory') {
      const ok = it.ops.filter((o) => o.ok && !o.existing);
      const kept = ok.filter((o) => o.op !== 'forget').length;
      const forgot = ok.filter((o) => o.op === 'forget').length;
      if (kept || forgot) out.push({ kind: 'memory', kept, forgot });
    }
    if (it.kind === 'error') out.push({ kind: 'error', message: it.message });
  }
  return out;
}

// Work Ledger tasks of one chat-run kind whose run hasn't started.
export const notStarted = (ledger, store, kind) => openTasks(ledger, kind).filter((t) => !begun(store, t.brief.inputs.run));

export function buildActivity({ store, runner, ledger, schedules, timezone, before = null, days = 7, now = new Date() }) {
  const end = before ?? addDays(dayOf(now.toISOString(), timezone), 1); // exclusive
  const start = addDays(end, -days);
  const since = Date.parse(`${start}T00:00:00Z`) - DAY; // any timezone's start of that day
  const live = (id) => runner.liveState(id);

  // Which conversation each helper and schedule reported to, by name.
  const titles = new Map([['main', 'Main conversation'], ...store.list().map((s) => [s.id, s.title])]);
  const runs = new Map();
  for (const r of schedules.runs()) if (r.run) runs.set(r.run, r);

  const entries = [];
  let oldest = null;
  const dir = store.dir;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
  for (const f of files) {
    const id = f.slice(0, -6);
    const made = id.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (made && (!oldest || made < oldest)) oldest = made;
    let mtimeMs;
    try { ({ mtimeMs } = statSync(join(dir, f))); } catch { continue; }
    if (mtimeMs < since) continue;
    let s;
    try { s = readSession(store, id); } catch { continue; }
    const l = live(id);
    for (const t of s.turns) {
      if (t.kind === 'handoff' || !t.ts) continue;
      const day = dayOf(t.ts, timezone);
      if (day < start || day >= end) continue;
      const isLive = l && l.turn === t.id;
      const state = t.state === 'open' ? (isLive ? (l.approval ? 'waiting' : 'working') : 'interrupted') : t.state === 'error' ? 'failed' : t.state;
      const e = { id: `${id}:${t.id}`, session: id, turn: t.id, day, started: t.ts, ended: t.endedAt, state, steps: steps(t) };
      if (s.kind === 'run') {
        const r = runs.get(id);
        Object.assign(e, { kind: 'schedule', title: s.title, schedule: s.schedule, late: !!r?.late, manual: !!r?.manual,
          report: r?.handoff ? { to: r.delivered, toTitle: titles.get(r.delivered) ?? 'a conversation', handoff: r.handoff } : null });
      } else if (s.kind === 'helper') {
        Object.assign(e, { kind: 'helper', title: s.title, brief: clip(t.text, 280), parent: s.parent, parentTitle: titles.get(s.parent) ?? 'a conversation',
          report: s.delivered ? { to: s.delivered.to, toTitle: titles.get(s.delivered.to) ?? 'a conversation', handoff: s.delivered.handoff } : null });
      } else {
        Object.assign(e, { kind: 'reply', title: s.kind === 'main' ? 'Main conversation' : s.title, text: clip(t.text, 140), first: t === s.turns[0] });
        if (t.followup) e.followup = s.turns.find((x) => x.id === t.followup)?.name ?? 'a helper';
      }
      if (isLive && l.approval) e.approval = l.approval;
      entries.push(e);
      if (e.kind !== 'reply') break; // a run or a helper is one piece of work
    }
  }

  // Runs that never happened: Nova wasn't running, too long ago to catch up.
  for (const r of schedules.runs()) {
    if (!r.missed) continue;
    const day = dayOf(r.due, timezone);
    if (day < start || day >= end) continue;
    entries.push({ id: `missed:${r.schedule}:${r.due}`, kind: 'schedule', missed: true, title: r.name, schedule: r.schedule, day, started: r.due, state: 'missed', steps: [] });
  }

  // Helpers and scheduled runs that haven't started yet: Work Ledger tasks still waiting their turn.
  const waiting = [
    ...notStarted(ledger, store, 'helper').map((t) => {
      const q = t.brief.inputs;
      return { id: `queued:${q.run}`, kind: 'helper', title: q.title, session: q.run, parent: q.parent, parentTitle: titles.get(q.parent) ?? 'a conversation', started: t.created_at, state: 'queued', steps: [], task: t.id };
    }),
    ...notStarted(ledger, store, 'schedule').map((t) => {
      const q = t.brief.inputs;
      return { id: `queued:${q.schedule}`, kind: 'schedule', title: schedules.get(q.schedule)?.name ?? q.name, schedule: q.schedule, started: q.due, state: 'queued', steps: [], task: t.id };
    }),
  ];

  entries.sort((a, b) => b.started.localeCompare(a.started));
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  const current = entries.filter((e) => e.state === 'working' || e.state === 'waiting');
  return {
    now: [...current, ...waiting],
    days: [...byDay].map(([day, list]) => ({ day, summary: summarize(list), entries: list })),
    more: !!oldest && oldest < start,
    before: start,
    timezone,
  };
}

// One day in numbers, for a sentence under its date.
export function summarize(list) {
  const n = { replies: 0, schedules: 0, helpers: 0, missed: 0, asked: 0, allowed: 0, declined: 0, onOwn: 0, notAsked: 0, kept: 0 };
  for (const e of list) {
    if (e.missed) n.missed++;
    else if (e.kind === 'reply') n.replies++;
    else if (e.kind === 'schedule') n.schedules++;
    else n.helpers++;
    for (const s of e.steps) {
      if (s.kind === 'memory') n.kept += s.kept;
      if (s.kind !== 'tool' || !s.approval) continue;
      if (s.approval.auto) s.approval.decision === 'deny' ? n.notAsked++ : n.onOwn++;
      else { n.asked++; s.approval.decision === 'deny' ? n.declined++ : n.allowed++; }
    }
  }
  return n;
}
