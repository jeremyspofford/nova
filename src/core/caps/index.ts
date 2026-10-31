// Hard caps on autonomy cost (Amendment 2026-10-31-B Part 5). Tiers gate actions; this caps the
// cumulative spend of autonomous work: per task and per day, in iterations (weighted tool steps),
// tokens and, where priced, dollars. A loop detector makes repeated near-identical tool calls count
// faster, so a stuck loop dies in a few steps. The agent loop (Era 2's runner) asks a Meter before
// each model call and each tool step; hitting a ceiling stops the run with plain words, and the
// chat-run worker offers the resume as a new approval. See docs/plans/cost-caps.md.
//
// Spend is kept as JSON lines under the home, workers/spend/<YYYY-MM>.jsonl (one line per model
// call, tool step or reported usage): no migration; `workers/` is one of Nova's own home entries,
// and the agent's write_file can't reach it. Prices are the model manager's table (profile
// models.prices), read, not copied; local models cost nothing; what can't be priced can't be kept
// inside a dollar ceiling (M10d's rule): such tokens are shown as unpriced, and only the token
// ceilings hold them.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import type { Route } from '../api.ts';

export const SPEND_DIR = join('workers', 'spend');
export const WHATS = ['iterations', 'tokens', 'usd'] as const;
export type What = (typeof WHATS)[number];
export interface Ceilings { iterations: number | null; tokens: number | null; usd: number | null }
export interface Limits { task: Ceilings; day: Ceilings }

// Conservative by default (the plan says why): a run is at most 8 tool steps per reply today, so
// 24 weighted steps is reached only by repetition or resumes; ~90k tokens is a long 8-step run.
export const DEFAULT_LIMITS: Limits = {
  task: { iterations: 24, tokens: 150_000, usd: 0.5 },
  day: { iterations: 300, tokens: 1_500_000, usd: 5 },
};

// The loop detector: within the run's last WINDOW tool calls, a call whose signature has been seen
// k times already counts 1 + 2k iterations, at most MAX_WEIGHT.
export const LOOP = { window: 10, maxWeight: 9 } as const;

// Characters per token, for a model that reports no usage.
export const CHARS_PER_TOKEN = 4;

export interface Spend { iterations: number; tokens_in: number; tokens_out: number; estimated_tokens: number; usd: number; unpriced_tokens: number }
const zero = (): Spend => ({ iterations: 0, tokens_in: 0, tokens_out: 0, estimated_tokens: 0, usd: 0, unpriced_tokens: 0 });
const tokensOf = (s: Spend) => s.tokens_in + s.tokens_out;

export interface Stop {
  scope: 'task' | 'day';
  what: What;
  limit: number | null;
  spent: Spend;
  loop: boolean;
  words: string;
}

interface Line {
  at: string;
  day: string;
  kind: 'model' | 'step' | 'report';
  task_id: string | null;
  session_id: string | null;
  provider?: string;
  model?: string;
  where?: string;
  tokens_in?: number;
  tokens_out?: number;
  estimated?: boolean;
  usd?: number | null;
  weight?: number;
  tool?: string;
}

// A tool call's signature: its name and arguments with keys sorted, strings trimmed, whitespace
// collapsed and case folded, and every run of digits as #: "page 2" and "page 3" are near-identical.
export function signature(name: string, args: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\d+/g, '#');
    if (typeof v === 'number') return '#';
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return `${name}:${JSON.stringify(norm(args ?? {}))}`;
}

// How many iterations the next call counts, given the run's earlier calls (their signatures).
export function weightOf(sig: string, earlier: readonly string[]): number {
  const k = earlier.slice(-LOOP.window).filter((s) => s === sig).length;
  return Math.min(1 + 2 * k, LOOP.maxWeight);
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const usd = (x: number) => `$${x.toFixed(2)}`;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function spentWords(s: Spend): string {
  const tok = tokensOf(s);
  const est = s.estimated_tokens ? (s.estimated_tokens >= tok ? ' (estimated)' : ` (${n(s.estimated_tokens)} of them estimated)`) : '';
  return `${n(s.iterations)} ${s.iterations === 1 ? 'step' : 'steps'}, ${n(tok)} tokens${est}, ${usd(s.usd)}${s.unpriced_tokens ? ` plus ${n(s.unpriced_tokens)} tokens Nova has no price for` : ''}`;
}

function limitWords(what: What, v: number | null): string {
  if (v === null) return 'no ceiling';
  return what === 'usd' ? usd(v) : what === 'tokens' ? `${n(v)} tokens` : `${n(v)} steps`;
}

export interface CapsOptions {
  home: string;
  profile: { get<T>(section: 'policy' | 'models', key: string): T | undefined; set(section: 'policy', key: string, value: unknown, source: 'settings'): void };
  timezone?: () => string;
  now?: () => Date;
}

export class Caps {
  readonly dir: string;
  #o: CapsOptions;
  #days = new Map<string, Spend>(); // day → tasks' spend (capped work only), from the month file

  constructor(o: CapsOptions) {
    this.#o = o;
    this.dir = join(o.home, SPEND_DIR);
  }

  #now(): Date { return this.#o.now?.() ?? new Date(); }

  // The day in the person's timezone (YYYY-MM-DD), and its month.
  dayOf(at: Date = this.#now()): string {
    const tz = this.#o.timezone?.() || 'UTC';
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); } catch { return at.toISOString().slice(0, 10); }
  }

  // ---- limits ------------------------------------------------------------------------------------

  limits(): Limits {
    const set = this.#o.profile.get<Partial<Record<'task' | 'day', Partial<Ceilings>>>>('policy', 'caps') ?? {};
    return { task: { ...DEFAULT_LIMITS.task, ...set.task }, day: { ...DEFAULT_LIMITS.day, ...set.day } };
  }

  // {task?: {iterations?, tokens?, usd?}, day?: {…}}: a positive number, or null for no ceiling.
  setLimits(body: unknown): Limits {
    if (!isObj(body)) throw new CoreError('validation', 'Send {task?, day?}, each with iterations, tokens or usd.');
    const cur = this.#o.profile.get<Record<string, Record<string, number | null>>>('policy', 'caps') ?? {};
    const next: Record<string, Record<string, number | null>> = { task: { ...cur.task }, day: { ...cur.day } };
    for (const [scope, v] of Object.entries(body)) {
      if (scope !== 'task' && scope !== 'day') throw new CoreError('validation', `There is no ceiling “${scope}”: it is task or day.`);
      if (!isObj(v)) throw new CoreError('validation', `${scope} is {iterations?, tokens?, usd?}.`);
      for (const [what, x] of Object.entries(v)) {
        if (!(WHATS as readonly string[]).includes(what)) throw new CoreError('validation', `A ${scope} ceiling is on iterations, tokens or usd, not “${what}”.`);
        if (x !== null && (typeof x !== 'number' || !Number.isFinite(x) || x <= 0)) throw new CoreError('validation', `The ${scope} ceiling on ${what} is a number above zero, or null for none.`);
        if (x !== null && what !== 'usd' && !Number.isInteger(x)) throw new CoreError('validation', `The ${scope} ceiling on ${what} is a whole number.`);
        next[scope]![what] = x as number | null;
      }
    }
    this.#o.profile.set('policy', 'caps', next, 'settings');
    return this.limits();
  }

  // ---- prices ------------------------------------------------------------------------------------

  // Dollars for a call, or null when it can't be priced. Local work costs nothing.
  price(model: string, where: string, tokens_in: number, tokens_out: number, reported?: number | null): number | null {
    if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
    if (where !== 'remote') return 0;
    const t = this.#o.profile.get<Record<string, { usd_per_mtok_in?: number; usd_per_mtok_out?: number }>>('models', 'prices') ?? {};
    const p = Object.hasOwn(t, model) ? t[model] : undefined;
    if (!p || typeof p.usd_per_mtok_in !== 'number' || typeof p.usd_per_mtok_out !== 'number') return null;
    return (tokens_in * p.usd_per_mtok_in + tokens_out * p.usd_per_mtok_out) / 1e6;
  }

  priced(model: string, where: string): boolean {
    return this.price(model, where, 0, 0) !== null;
  }

  // ---- the store ---------------------------------------------------------------------------------

  #file(month: string): string { return join(this.dir, `${month}.jsonl`); }

  #lines(month: string): Line[] {
    let text = '';
    try { text = readFileSync(this.#file(month), 'utf8'); } catch { return []; }
    return text.split('\n').flatMap((l) => { if (!l) return []; try { return [JSON.parse(l) as Line]; } catch { return []; } });
  }

  #append(l: Omit<Line, 'at' | 'day'>): Line {
    const at = this.#now();
    const line: Line = { at: at.toISOString(), day: this.dayOf(at), ...l };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.#file(line.day.slice(0, 7)), `${JSON.stringify(line)}\n`);
    const d = this.#days.get(line.day);
    if (d && line.task_id) add(d, line);
    return line;
  }

  // What tasks spent on a day (the person's own conversations aren't counted against the day).
  day(dayKey: string = this.dayOf()): Spend {
    let d = this.#days.get(dayKey);
    if (!d) {
      d = zero();
      for (const l of this.#lines(dayKey.slice(0, 7))) if (l.day === dayKey && l.task_id) add(d, l);
      this.#days.clear();
      this.#days.set(dayKey, d);
    }
    return { ...d };
  }

  // Month to date, per provider and model: tokens (with how many were estimated) and dollars
  // (with the tokens Nova couldn't price). Every model call counts here, conversations included.
  month(monthKey: string = this.dayOf().slice(0, 7)) {
    const by = new Map<string, { provider: string; model: string; where: string; calls: number } & Spend>();
    for (const l of this.#lines(monthKey)) {
      if (l.kind === 'step') continue;
      const key = `${l.provider}\0${l.model}`;
      const e = by.get(key) ?? { provider: l.provider ?? '?', model: l.model ?? '?', where: l.where ?? '?', calls: 0, ...zero() };
      e.calls++;
      add(e, l);
      by.set(key, e);
    }
    const providers = [...by.values()].sort((a, b) => tokensOf(b) - tokensOf(a));
    const total = providers.reduce((t, p) => { for (const k of Object.keys(t) as (keyof Spend)[]) t[k] += p[k]; return t; }, zero());
    return { month: monthKey, providers, total, words: `This month: ${n(tokensOf(total))} tokens${total.estimated_tokens ? ` (${n(total.estimated_tokens)} estimated)` : ''}, ${usd(total.usd)}${total.unpriced_tokens ? `, and ${n(total.unpriced_tokens)} tokens with no price` : ''}.` };
  }

  // Usage a provider task reported after the fact (Claude Code, Codex, Relay): counted toward the
  // day and the month. (Not capped live: those agents run their own loops.)
  report(o: { task_id: string; provider: string; model: string; where: string; tokens_in?: number; tokens_out?: number; cost_usd?: number | null }): void {
    const ti = Math.max(0, Math.round(o.tokens_in ?? 0));
    const to = Math.max(0, Math.round(o.tokens_out ?? 0));
    if (!ti && !to && !o.cost_usd) return;
    this.#append({ kind: 'report', task_id: o.task_id, session_id: null, provider: o.provider, model: o.model, where: o.where, tokens_in: ti, tokens_out: to, estimated: false, usd: this.price(o.model, o.where, ti, to, o.cost_usd ?? null) });
  }

  // The view for Settings and Health.
  view() {
    const today = this.dayOf();
    return { limits: this.limits(), defaults: DEFAULT_LIMITS, day: today, today: this.day(today), month: this.month(today.slice(0, 7)) };
  }

  meter(o: { task_id: string | null; session_id: string; capped: boolean }): Meter {
    return new Meter(this, o, (l) => this.#append(l));
  }
}

function add(s: Spend, l: Line): void {
  if (l.kind === 'step') { s.iterations += l.weight ?? 1; return; }
  const t = (l.tokens_in ?? 0) + (l.tokens_out ?? 0);
  s.tokens_in += l.tokens_in ?? 0;
  s.tokens_out += l.tokens_out ?? 0;
  if (l.estimated) s.estimated_tokens += t;
  if (typeof l.usd === 'number') s.usd += l.usd;
  else s.unpriced_tokens += t;
}

// One run segment of a task (a run, or a resume of it): its own allowance against the task's
// ceilings, and the day's ceilings across every task. A meter that isn't capped (a person's own
// conversation) only records.
export class Meter {
  readonly spent: Spend = zero();
  #caps: Caps;
  #o: { task_id: string | null; session_id: string; capped: boolean };
  #append: (l: Omit<Line, 'at' | 'day'>) => Line;
  #sigs: string[] = [];
  #loop = false;

  constructor(caps: Caps, o: { task_id: string | null; session_id: string; capped: boolean }, append: (l: Omit<Line, 'at' | 'day'>) => Line) {
    this.#caps = caps;
    this.#o = o;
    this.#append = append;
  }

  get capped(): boolean { return this.#o.capped; }

  #stop(scope: 'task' | 'day', what: What, limit: number | null, spentNow: Spend, extra = ''): Stop {
    const l = this.#caps.limits();
    const which = limitWords(what, limit);
    const head = scope === 'task' ? `Stopped at this task’s ceiling: ${which}.` : `Stopped at today’s ceiling for all tasks: ${which}.`;
    const loop = this.#loop && what === 'iterations' ? ' The same tool call kept repeating, so each repeat counted extra: it looked stuck in a loop.' : '';
    const spent = scope === 'task' ? `This task spent ${spentWords(this.spent)}.` : `Today’s tasks spent ${spentWords(spentNow)}; this one, ${spentWords(this.spent)}.`;
    const resume = scope === 'task'
      ? `Resuming waits for your OK in Tasks; it gets a fresh allowance (${limitWords('iterations', l.task.iterations)}, ${limitWords('tokens', l.task.tokens)}, ${limitWords('usd', l.task.usd)}), and today’s ceiling still holds.`
      : 'Resuming waits for your OK in Tasks, and runs once there is room under today’s ceiling (it starts again at midnight); the ceilings are in Settings.';
    return { scope, what, limit, spent: { ...(scope === 'task' ? this.spent : spentNow) }, loop: !!loop, words: [head, loop.trim(), extra, spent, resume].filter(Boolean).join(' ') };
  }

  // Before a model call. Dollars are capped where priced only (the amendment's "where priced"): a
  // model off the devices with no price is held by the token ceilings, and its tokens are shown as
  // unpriced. `next` (what is about to be called) is for the record.
  check(_next?: { model: string; where: string }): Stop | null {
    if (!this.#o.capped) return null;
    const l = this.#caps.limits();
    const day = this.#caps.day();
    for (const what of ['tokens', 'usd'] as const) {
      const lim = l.task[what];
      if (lim !== null && (what === 'tokens' ? tokensOf(this.spent) : this.spent.usd) >= lim) return this.#stop('task', what, lim, this.spent);
      const dl = l.day[what];
      if (dl !== null && (what === 'tokens' ? tokensOf(day) : day.usd) >= dl) return this.#stop('day', what, dl, day);
    }
    if (l.day.iterations !== null && day.iterations >= l.day.iterations) return this.#stop('day', 'iterations', l.day.iterations, day);
    return null;
  }

  // After a model call: its usage as reported, or estimated from the characters sent and received.
  model(o: { provider: string; model: string; where: string; usage?: { tokens_in?: number; tokens_out?: number; cost_usd?: number } | null; sent: number; received: number }): void {
    const reported = typeof o.usage?.tokens_in === 'number' || typeof o.usage?.tokens_out === 'number';
    const ti = reported ? Math.max(0, Math.round(o.usage!.tokens_in ?? 0)) : Math.ceil(o.sent / CHARS_PER_TOKEN);
    const to = reported ? Math.max(0, Math.round(o.usage!.tokens_out ?? 0)) : Math.ceil(o.received / CHARS_PER_TOKEN);
    const line = this.#append({ kind: 'model', task_id: this.#o.task_id, session_id: this.#o.session_id, provider: o.provider, model: o.model, where: o.where, tokens_in: ti, tokens_out: to, estimated: !reported, usd: this.#caps.price(o.model, o.where, ti, to, o.usage?.cost_usd ?? null) });
    add(this.spent, line);
  }

  // A tool call the model asked for, before it runs: counted (weighted when it repeats) and refused
  // when counting it goes past a ceiling.
  step(call: { name: string; args: unknown }): Stop | null {
    const sig = signature(call.name, call.args);
    const weight = weightOf(sig, this.#sigs);
    this.#sigs.push(sig);
    if (weight > 1) this.#loop = true;
    if (this.#o.capped) {
      const l = this.#caps.limits();
      if (l.task.iterations !== null && this.spent.iterations + weight > l.task.iterations) {
        return this.#stop('task', 'iterations', l.task.iterations, this.spent, `The next step (${call.name}) would have made it ${n(this.spent.iterations + weight)}.`);
      }
      const day = this.#caps.day();
      if (l.day.iterations !== null && day.iterations + weight > l.day.iterations) return this.#stop('day', 'iterations', l.day.iterations, day);
    }
    const line = this.#append({ kind: 'step', task_id: this.#o.task_id, session_id: this.#o.session_id, weight, tool: call.name });
    add(this.spent, line);
    return null;
  }
}

// The routes, ready for the composition root to wire (docs/plans/cost-caps.md, NOTES).
export function capsRoutes(caps: Caps): Route[] {
  return [
    { method: 'GET', path: '/caps', summary: 'Ceilings on autonomous work (per task and per day: steps, tokens, dollars where priced), what tasks spent today, and this month’s spend per provider and model.', handle: () => caps.view() },
    { method: 'PUT', path: '/caps/limits', summary: 'Change the ceilings: {task?, day?}, each {iterations?, tokens?, usd?} as a number above zero, or null for none.', body: '{task?, day?}', handle: ({ body }) => ({ limits: caps.setLimits(body), view: caps.view() }) },
  ];
}
