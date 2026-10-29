// The trigger engine (NOVA-SPEC §4, CONTRACTS §6). Everything that starts work or contact without
// the person asking right then comes from a rule in a visible registry, and every firing is a
// record: what came in (by hash), how it was triaged and why, and the task or message it made.
// Every proactive message traces to one of these records.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CoreError } from './errors.ts';
import { sha256 } from './workspace.ts';
import { CronError, describeCron, lastRun, nextRun, parseCron, wallOf } from '../cron.js';
import type { Db } from './db.ts';
import type { Log } from './log.ts';
import type { Ledger, Task, TaskInput } from './ledger.ts';
import type { Decisions, Inputs, RulesProvider, TemplateDef, Templates } from './decide.ts';

export const RULE_CLASSES = ['proactive', 'event', 'heartbeat'] as const;
export type RuleClass = (typeof RULE_CLASSES)[number];
export type TriggerClass = 'reactive' | RuleClass;
export const DECISIONS = ['act', 'queue', 'silent', 'drop'] as const;
export type TriageDecision = (typeof DECISIONS)[number];

export type Action = { kind: 'task'; task: Omit<TaskInput, 'origin'> } | { kind: 'message'; text: string };

export interface RuleInput {
  name: string;
  class: RuleClass;
  hook?: string;          // event: the webhook's name, /api/v1/hooks/<hook>
  cron?: string;          // heartbeat
  action: Action;
  dedup_window_s?: number;
  cooldown_s?: number;
}

export interface Rule {
  id: string;
  name: string;
  class: RuleClass;
  source: string;
  cron: string | null;
  schedule: string | null;
  hook_path: string | null;
  action: Action;
  dedup_window_s: number;
  cooldown_s: number;
  paused: boolean;
  last_due_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Triage { decision: TriageDecision; reason: string; model: { provider: string; template_id: string; version: number } | null }

export interface TriggerRecord {
  trigger_id: string;
  rule_id: string | null;
  class: TriggerClass;
  source: string;
  payload_ref: string | null;
  triage: Triage;
  dedup_key: string | null;
  claim_key: string | null;
  cooldown_until: string | null;
  ledger_task_id: string | null;
  message_id: string | null;
  at: string;
}

export interface Message { id: string; at: string; text: string; trigger_id: string; delivered_at: string | null; read_at: string | null }

export interface Policy { quiet_hours?: { start: string; end: string }; proactive_off?: string[] }

// Triage, as a System 1 template. It ships active; its local rule is below.
export const TRIAGE: TemplateDef = {
  template_id: 'triage',
  version: 1,
  situation: 'Something fired a trigger. Decide whether Nova acts on it now, holds it, keeps quiet, or drops it.',
  inputs: { class: 'string', action: 'string', quiet_hours: 'boolean', category_off: 'boolean' },
  questions: [{ id: 'decision', type: 'choice', options: ['act', 'queue', 'silent', 'drop', 'unknown'] }],
  escalation: { confidence_floor: 0.6 },
};

// System 1.5 for triage: the person's policy, applied as plain rules. Also the fallback when the
// template is missing.
export function triageRule(i: Inputs): { answers: { decision: TriageDecision }; confidence: number; why: string } {
  if (i.category_off) return { answers: { decision: 'drop' }, confidence: 1, why: 'Turned off in your settings.' };
  if (i.quiet_hours && i.action === 'message') return { answers: { decision: 'queue' }, confidence: 1, why: 'Quiet hours: the message waits until they end.' };
  return { answers: { decision: 'act' }, confidence: 1, why: 'Nothing in your settings holds it back.' };
}

const HOOK_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CATCH_UP_MS = 6 * 3_600_000;
const DEFAULT_DEDUP_S = 600;

type Row = Record<string, string | number | null>;
const parse = <T>(s: unknown): T => (typeof s === 'string' ? JSON.parse(s) : null) as T;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const minutes = (hhmm: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function toRule(r: Row): Rule {
  const source = r.source as string;
  return {
    id: r.id as string,
    name: r.name as string,
    class: r.class as RuleClass,
    source,
    cron: r.cron as string | null,
    schedule: r.cron ? describeCron(r.cron as string) : null,
    hook_path: source.startsWith('webhook:') ? `/api/v1/hooks/${source.slice('webhook:'.length)}` : null,
    action: parse(r.action),
    dedup_window_s: r.dedup_window_s as number,
    cooldown_s: r.cooldown_s as number,
    paused: r.paused === 1,
    last_due_at: r.last_due_at as string | null,
    created_by: r.created_by as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

const toTrigger = (r: Row): TriggerRecord => ({ ...(r as unknown as TriggerRecord), triage: parse(r.triage) });

export interface TriggersOptions {
  db: Db;
  log: Log;
  ledger: Ledger;
  templates: Templates;
  rules: RulesProvider;
  decisions: Decisions;
  policy: () => Policy;
  timezone: () => string;
  now?: () => Date;
}

// A firing without a rule in the registry (an Era 2 schedule file is its own rule) brings its own
// action and a name for it; it is recorded, triaged and traced like any other.
export interface FireInput { class: TriggerClass; source: string; rule?: string; payload: unknown; dedup_key?: string; claim_key?: string; action?: Action; name?: string }

export class Triggers extends EventEmitter {
  #db: Db;
  #log: Log;
  #ledger: Ledger;
  #decisions: Decisions;
  #policy: () => Policy;
  #timezone: () => string;
  #now: () => Date;

  constructor(o: TriggersOptions) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.#ledger = o.ledger;
    this.#decisions = o.decisions;
    this.#policy = o.policy;
    this.#timezone = o.timezone;
    this.#now = o.now ?? (() => new Date());
    o.templates.builtIn(TRIAGE);
    if (!o.rules.has(TRIAGE.template_id)) o.rules.add(TRIAGE.template_id, triageRule);
  }

  // ---- the registry ----------------------------------------------------------

  // The webhook token is returned here and nowhere else; only its hash is kept.
  createRule(input: RuleInput, by: string): { rule: Rule; token: string } {
    const v = this.#checkRule(input, null);
    const id = randomUUID();
    const at = this.#now().toISOString();
    let token = '';
    let source = 'nova';
    if (v.class === 'event') {
      const hook = input.hook;
      if (!isStr(hook) || !HOOK_NAME.test(hook)) throw new CoreError('validation', 'An event rule needs a hook name: lowercase letters, digits and dashes.');
      source = `webhook:${hook}`;
      if (this.#db.get('SELECT 1 FROM trigger_rule WHERE source = ?', source)) throw new CoreError('conflict', `There is already a webhook called ${hook}.`);
      token = randomBytes(32).toString('base64url');
    } else if (v.class === 'heartbeat') {
      source = 'cron';
    }
    this.#db.tx(() => {
      this.#db.run(
        `INSERT INTO trigger_rule (id, name, class, source, cron, action, dedup_window_s, cooldown_s, hook_token_hash, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, v.name, v.class, source, v.cron, JSON.stringify(v.action), v.dedup_window_s, v.cooldown_s, token ? sha256(token) : null, by, at, at,
      );
      this.#ruleEvent(id, 'created', { name: v.name, class: v.class, source, by });
    });
    return { rule: this.rule(id), token };
  }

  updateRule(id: string, patch: Partial<Omit<RuleInput, 'class' | 'hook'>>): Rule {
    const r = this.rule(id);
    const v = this.#checkRule({ ...r, cron: r.cron ?? undefined, ...patch, class: r.class } as RuleInput, r);
    const changed = (['name', 'cron', 'action', 'dedup_window_s', 'cooldown_s'] as const).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(r[k]));
    if (!changed.length) return r;
    this.#db.tx(() => {
      this.#db.run('UPDATE trigger_rule SET name = ?, cron = ?, action = ?, dedup_window_s = ?, cooldown_s = ?, updated_at = ? WHERE id = ?',
        v.name, v.cron, JSON.stringify(v.action), v.dedup_window_s, v.cooldown_s, this.#now().toISOString(), id);
      this.#ruleEvent(id, 'updated', { changed });
    });
    return this.rule(id);
  }

  pause(id: string): Rule {
    return this.#setPaused(id, true);
  }

  // A resumed heartbeat starts from now: it does not catch up on the time it was paused.
  resume(id: string): Rule {
    return this.#setPaused(id, false);
  }

  deleteRule(id: string): void {
    const r = this.rule(id);
    this.#db.tx(() => {
      this.#db.run('DELETE FROM trigger_rule WHERE id = ?', id);
      this.#ruleEvent(id, 'deleted', { name: r.name, source: r.source });
    });
  }

  rule(id: string): Rule {
    const row = this.#db.get<Row>('SELECT * FROM trigger_rule WHERE id = ?', id);
    if (!row) throw new CoreError('not_found', `No trigger rule ${id}.`);
    return toRule(row);
  }

  listRules(): Rule[] {
    return this.#db.all<Row>('SELECT * FROM trigger_rule ORDER BY created_at, rowid').map(toRule);
  }

  ruleEvents(id: string): { seq: number; at: string; kind: string; detail: unknown }[] {
    return this.#db.all<Row>('SELECT * FROM trigger_rule_event WHERE rule_id = ? ORDER BY seq', id)
      .map((e) => ({ seq: e.seq as number, at: e.at as string, kind: e.kind as string, detail: parse(e.detail) }));
  }

  // ---- firing ----------------------------------------------------------------

  async hook(name: string, token: string | undefined, payload: unknown, dedupKey?: string): Promise<TriggerRecord> {
    const row = this.#db.get<Row>(`SELECT * FROM trigger_rule WHERE class = 'event' AND source = ?`, `webhook:${name}`);
    if (!row) throw new CoreError('not_found', `There is no webhook called ${name}.`);
    const want = Buffer.from(String(row.hook_token_hash ?? ''), 'hex');
    const got = Buffer.from(sha256(token ?? ''), 'hex');
    if (!token || want.length !== got.length || !timingSafeEqual(want, got)) {
      this.#log.warn('triggers', 'A webhook call had a missing or wrong token.', { hook: name });
      throw new CoreError('forbidden', 'That webhook token isn’t right.');
    }
    return (await this.fire({ class: 'event', source: row.source as string, rule: row.id as string, payload, ...(dedupKey ? { dedup_key: dedupKey } : {}) }))!;
  }

  // Runs a proactive or heartbeat rule now, as the person asked.
  async fireRule(id: string, payload: unknown = {}): Promise<TriggerRecord> {
    const r = this.rule(id);
    if (r.class === 'event') throw new CoreError('validation', 'An event rule fires when its webhook is called.');
    return (await this.fire({ class: r.class, source: r.source, rule: r.id, payload }))!;
  }

  // The pipeline: record → dedup → cooldown → triage → act → cooldown → emit. Returns null only
  // when a claim key was already taken (that due time already ran).
  async fire(input: FireInput): Promise<TriggerRecord | null> {
    const at = this.#now();
    const trigger_id = randomUUID();
    const payload_ref = sha256(JSON.stringify(input.payload ?? null));
    const dedup_key = input.dedup_key ?? (input.class === 'heartbeat' ? null : payload_ref);
    const rule = input.rule ? this.rule(input.rule) : null;

    // 1. Record. A claim key that is already taken means this due time already ran.
    this.#db.run(
      `INSERT INTO trigger (trigger_id, rule_id, class, source, payload_ref, dedup_key, claim_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (claim_key) DO NOTHING`,
      trigger_id, rule?.id ?? null, input.class, input.source, payload_ref, dedup_key, input.claim_key ?? null, at.toISOString(),
    );
    if (!this.#db.get('SELECT 1 FROM trigger WHERE trigger_id = ?', trigger_id)) return null;

    if (rule?.paused) return this.#settle(trigger_id, { decision: 'drop', reason: 'The rule is paused, so nothing was done.', model: null });

    // 2. Dedup: the same fact again within the window.
    if (rule && dedup_key && rule.dedup_window_s > 0) {
      const earlier = this.#db.get<{ trigger_id: string }>(
        `SELECT trigger_id FROM trigger WHERE rule_id = ? AND dedup_key = ? AND at >= ? AND rowid < (SELECT rowid FROM trigger WHERE trigger_id = ?) ORDER BY rowid LIMIT 1`,
        rule.id, dedup_key, new Date(at.getTime() - rule.dedup_window_s * 1000).toISOString(), trigger_id,
      );
      if (earlier) return this.#settle(trigger_id, { decision: 'drop', reason: `Same as trigger ${earlier.trigger_id}.`, model: null });
    }

    // 3. Cooldown.
    if (rule) {
      const until = this.#db.get<{ u: string | null }>('SELECT MAX(cooldown_until) AS u FROM trigger WHERE rule_id = ? AND trigger_id != ?', rule.id, trigger_id)?.u;
      if (until && until > at.toISOString()) return this.#settle(trigger_id, { decision: 'silent', reason: `Cooling down until ${until}.`, model: null });
    }

    // 4. Triage, through System 1 when the template is there, else the same rules directly.
    const action = rule?.action ?? input.action ?? null;
    const name = rule?.name ?? input.name ?? input.source;
    const policy = this.#policy();
    const off = Array.isArray(policy.proactive_off) ? policy.proactive_off.map((x) => String(x).toLowerCase()) : [];
    const inputs: Inputs = {
      class: input.class,
      action: action?.kind ?? 'none',
      quiet_hours: this.#quiet(at),
      category_off: off.includes(input.class) || ((!!rule || !!input.name) && off.includes(name.toLowerCase())),
    };
    let triage: Triage;
    const d = await this.#decisions.decide(TRIAGE.template_id, inputs);
    if (!d) {
      const r = triageRule(inputs);
      triage = { decision: r.answers.decision, reason: r.why, model: null };
    } else {
      const model = { provider: d.provider, template_id: d.template_id, version: d.version };
      triage = d.escalate
        ? { decision: 'queue', reason: 'Not sure this should happen on its own, so it waits for you.', model }
        : { decision: d.answers.decision as TriageDecision, reason: d.why, model };
    }

    // 5. Act.
    let ledger_task_id: string | null = null;
    let message: Message | null = null;
    if (action && (triage.decision === 'act' || triage.decision === 'queue')) {
      if (action.kind === 'task') {
        const open = rule && input.class === 'event' ? this.#openTask(rule, at) : null;
        if (open) {
          ledger_task_id = open.id;
          triage = { ...triage, decision: 'queue', reason: `Added to "${open.title}".` };
        } else {
          try {
            const tier = triage.decision === 'queue' ? Math.max(action.task.approval_tier ?? 1, 2) as 2 | 3 : action.task.approval_tier;
            const task = this.#ledger.create({ ...action.task, ...(tier !== undefined ? { approval_tier: tier } : {}), origin: { kind: 'trigger', ref: trigger_id }, idempotency_key: `trigger:${trigger_id}` });
            ledger_task_id = task.id;
          } catch (e) {
            const why = `Nova couldn't start the task for "${name}": ${(e as Error).message}`;
            this.#log.problem('triggers', why, { detail: (e as Error).stack });
            triage = { ...triage, decision: 'drop', reason: why };
          }
        }
      } else {
        message = this.#message(trigger_id, action.text, triage.decision === 'act' ? at : null);
      }
    }

    // 6. Cooldown starts when the rule did something.
    const acted = ledger_task_id !== null || message !== null;
    const cooldown_until = rule && acted && rule.cooldown_s > 0 ? new Date(at.getTime() + rule.cooldown_s * 1000).toISOString() : null;
    this.#db.run('UPDATE trigger SET ledger_task_id = ?, message_id = ?, cooldown_until = ? WHERE trigger_id = ?', ledger_task_id, message?.id ?? null, cooldown_until, trigger_id);
    const record = this.#settle(trigger_id, triage);
    if (message?.delivered_at) this.emit('message', message);
    return record;
  }

  // A request the person made directly. It acts by definition; the record links the work to it.
  reactive(task: Task, source = 'api'): TriggerRecord {
    const trigger_id = randomUUID();
    this.#db.run(
      `INSERT INTO trigger (trigger_id, rule_id, class, source, payload_ref, ledger_task_id, at) VALUES (?, NULL, 'reactive', ?, ?, ?, ?)`,
      trigger_id, source, sha256(JSON.stringify({ task_id: task.id })), task.id, this.#now().toISOString(),
    );
    return this.#settle(trigger_id, { decision: 'act', reason: 'You asked for it.', model: null });
  }

  // The heartbeat. Each due time is claimed once (rule:<id>@<due>), so overlapping ticks or a
  // second process can't run it twice. Runs missed within 6 hours catch up once; older ones are
  // recorded as dropped. Held messages go out once quiet hours end.
  async tick(now: Date = this.#now()): Promise<TriggerRecord[]> {
    const out: TriggerRecord[] = [];
    if (!this.#quiet(now)) {
      for (const m of this.#db.all<Message>('SELECT * FROM message WHERE delivered_at IS NULL ORDER BY at')) {
        this.#db.run('UPDATE message SET delivered_at = ? WHERE id = ?', now.toISOString(), m.id);
        this.emit('message', this.#getMessage(m.id));
      }
    }
    const tz = this.#timezone();
    const cutoff = new Date(now.getTime() - CATCH_UP_MS);
    for (const rule of this.listRules()) {
      if (rule.class !== 'heartbeat' || rule.paused || !rule.cron) continue;
      const since = new Date(rule.last_due_at ?? rule.created_at);
      let handled: Date | null = null;
      if (since < cutoff) {
        const missed = nextRun(rule.cron, since, tz);
        if (missed && missed <= cutoff) {
          const t = await this.#missed(rule, missed);
          if (t) out.push(t);
          handled = cutoff;
        }
      }
      const due = lastRun(rule.cron, since < cutoff ? cutoff : since, now, tz);
      if (due) {
        const t = await this.fire({ class: 'heartbeat', source: rule.source, rule: rule.id, payload: { due: due.toISOString() }, claim_key: `rule:${rule.id}@${due.toISOString()}` });
        if (t) out.push(t);
        handled = due;
      }
      if (handled) this.#db.run('UPDATE trigger_rule SET last_due_at = ? WHERE id = ?', handled.toISOString(), rule.id);
    }
    return out;
  }

  list(opts: { rule?: string; limit?: number } = {}): TriggerRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = opts.rule
      ? this.#db.all<Row>('SELECT * FROM trigger WHERE rule_id = ? ORDER BY rowid DESC LIMIT ?', opts.rule, limit)
      : this.#db.all<Row>('SELECT * FROM trigger ORDER BY rowid DESC LIMIT ?', limit);
    return rows.map(toTrigger);
  }

  get(id: string): TriggerRecord {
    const row = this.#db.get<Row>('SELECT * FROM trigger WHERE trigger_id = ?', id);
    if (!row) throw new CoreError('not_found', `No trigger ${id}.`);
    return toTrigger(row);
  }

  // Delivered messages by default; `held` are the ones waiting for quiet hours to end.
  messages(opts: { state?: 'delivered' | 'held' } = {}): Message[] {
    const where = opts.state === 'held' ? 'delivered_at IS NULL' : 'delivered_at IS NOT NULL';
    return this.#db.all<Message>(`SELECT * FROM message WHERE ${where} ORDER BY at DESC, rowid DESC LIMIT 200`);
  }

  read(id: string): Message {
    const m = this.#getMessage(id);
    if (!m.read_at) this.#db.run('UPDATE message SET read_at = ? WHERE id = ?', this.#now().toISOString(), id);
    return this.#getMessage(id);
  }

  counts(): { rules: number; paused: number; triggers: number; held: number; unread: number } {
    const n = (sql: string) => this.#db.get<{ n: number }>(sql)?.n ?? 0;
    return {
      rules: n('SELECT COUNT(*) AS n FROM trigger_rule'),
      paused: n('SELECT COUNT(*) AS n FROM trigger_rule WHERE paused = 1'),
      triggers: n('SELECT COUNT(*) AS n FROM trigger'),
      held: n('SELECT COUNT(*) AS n FROM message WHERE delivered_at IS NULL'),
      unread: n('SELECT COUNT(*) AS n FROM message WHERE delivered_at IS NOT NULL AND read_at IS NULL'),
    };
  }

  // ---- inside ----------------------------------------------------------------

  async #missed(rule: Rule, due: Date): Promise<TriggerRecord | null> {
    const trigger_id = randomUUID();
    this.#db.run(
      `INSERT INTO trigger (trigger_id, rule_id, class, source, payload_ref, claim_key, at) VALUES (?, ?, 'heartbeat', ?, ?, ?, ?) ON CONFLICT (claim_key) DO NOTHING`,
      trigger_id, rule.id, rule.source, sha256(JSON.stringify({ due: due.toISOString() })), `rule:${rule.id}@${due.toISOString()}`, this.#now().toISOString(),
    );
    if (!this.#db.get('SELECT 1 FROM trigger WHERE trigger_id = ?', trigger_id)) return null;
    return this.#settle(trigger_id, { decision: 'drop', reason: 'Missed while Nova was off.', model: null });
  }

  #settle(trigger_id: string, triage: Triage): TriggerRecord {
    this.#db.run('UPDATE trigger SET triage = ? WHERE trigger_id = ?', JSON.stringify(triage), trigger_id);
    const record = this.get(trigger_id);
    this.emit('trigger', record);
    return record;
  }

  // Batching: an event joins an open task from the same rule started within the dedup window.
  #openTask(rule: Rule, at: Date): { id: string; title: string } | null {
    if (rule.dedup_window_s <= 0) return null;
    return this.#db.get<{ id: string; title: string }>(
      `SELECT k.id, k.title FROM trigger t JOIN task k ON k.id = t.ledger_task_id
       WHERE t.rule_id = ? AND k.state IN ('queued', 'waiting') AND t.at >= ? ORDER BY t.rowid DESC LIMIT 1`,
      rule.id, new Date(at.getTime() - rule.dedup_window_s * 1000).toISOString(),
    ) ?? null;
  }

  #message(trigger_id: string, text: string, deliveredAt: Date | null): Message {
    const id = randomUUID();
    this.#db.run('INSERT INTO message (id, at, text, trigger_id, delivered_at) VALUES (?, ?, ?, ?, ?)', id, this.#now().toISOString(), text, trigger_id, deliveredAt?.toISOString() ?? null);
    return this.#getMessage(id);
  }

  #getMessage(id: string): Message {
    const m = this.#db.get<Message>('SELECT * FROM message WHERE id = ?', id);
    if (!m) throw new CoreError('not_found', `No message ${id}.`);
    return m;
  }

  // Quiet hours are wall-clock times in the person's timezone, and may run past midnight.
  #quiet(at: Date): boolean {
    const q = this.#policy().quiet_hours;
    if (!isObj(q)) return false;
    const start = minutes(String(q.start));
    const end = minutes(String(q.end));
    if (start === null || end === null || start === end) return false;
    const m = Math.floor(wallOf(at.getTime(), this.#timezone()) / 60_000) % 1440;
    return start < end ? m >= start && m < end : m >= start || m < end;
  }

  #setPaused(id: string, paused: boolean): Rule {
    const r = this.rule(id);
    if (r.paused === paused) return r;
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run('UPDATE trigger_rule SET paused = ?, updated_at = ? WHERE id = ?', paused ? 1 : 0, at, id);
      if (!paused && r.class === 'heartbeat') this.#db.run('UPDATE trigger_rule SET last_due_at = ? WHERE id = ?', at, id);
      this.#ruleEvent(id, paused ? 'paused' : 'resumed', null);
    });
    return this.rule(id);
  }

  #checkRule(input: RuleInput, existing: Rule | null): { name: string; class: RuleClass; cron: string | null; action: Action; dedup_window_s: number; cooldown_s: number } {
    if (!isObj(input)) throw new CoreError('validation', 'A rule must be an object.');
    if (!isStr(input.name)) throw new CoreError('validation', 'A rule needs a name, in plain words.');
    if (!RULE_CLASSES.includes(input.class)) throw new CoreError('validation', `class must be one of ${RULE_CLASSES.join(', ')}.`);
    let cron: string | null = null;
    if (input.class === 'heartbeat') {
      try {
        cron = parseCron(input.cron).expr;
      } catch (e) {
        if (e instanceof CronError) throw new CoreError('validation', e.message);
        throw e;
      }
    }
    const action = input.action as unknown;
    if (!isObj(action)) throw new CoreError('validation', 'A rule needs an action: {kind: "task", task} or {kind: "message", text}.');
    if (action.kind === 'message') {
      if (!isStr(action.text)) throw new CoreError('validation', 'A message action needs the text to send.');
    } else if (action.kind === 'task') {
      const t = action.task;
      if (!isObj(t) || !isStr(t.title) || !isStr(t.goal)) throw new CoreError('validation', 'A task action needs a task with a title and a goal.');
      if ('origin' in t) throw new CoreError('validation', 'A task action can’t set its own origin; it is always the trigger.');
      if (!isStr(t.owner) || !this.#ledger.workers.has(t.owner)) throw new CoreError('validation', `There is no worker called "${String(t.owner)}".`);
      if (!Array.isArray(t.evidence_required) || !t.evidence_required.length) throw new CoreError('validation', 'A task action must say what evidence will prove it done.');
    } else {
      throw new CoreError('validation', 'A rule needs an action: {kind: "task", task} or {kind: "message", text}.');
    }
    const seconds = (v: unknown, name: string, fallback: number) => {
      if (v === undefined) return fallback;
      if (!Number.isInteger(v) || (v as number) < 0) throw new CoreError('validation', `${name} must be a whole number of seconds, 0 or more.`);
      return v as number;
    };
    return {
      name: input.name.trim(),
      class: input.class,
      cron,
      action: action as Action,
      dedup_window_s: seconds(input.dedup_window_s, 'dedup_window_s', existing?.dedup_window_s ?? DEFAULT_DEDUP_S),
      cooldown_s: seconds(input.cooldown_s, 'cooldown_s', existing?.cooldown_s ?? 0),
    };
  }

  #ruleEvent(rule_id: string, kind: string, detail: unknown): void {
    this.#db.run('INSERT INTO trigger_rule_event (rule_id, at, kind, detail) VALUES (?, ?, ?, ?)', rule_id, this.#now().toISOString(), kind, detail === null ? null : JSON.stringify(detail));
  }
}
