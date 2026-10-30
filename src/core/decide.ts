// System 1 of the decision stack (ADR-7, CONTRACTS §3): typed answers to recurring decisions,
// asked through a versioned template. System 1 never writes anything the person reads and never
// acts alone: an unsure or out-of-schema answer escalates. Templates are authored on a cache miss
// only, and a new one is activated through a ledger task whose dry runs Nova re-runs itself.
import { CoreError } from './errors.ts';
import { permits, stricter, type Egress, type Worker } from './workers.ts';
import { ENVELOPE_VERSION, type Brief, type PrivacyMode, type Report } from './envelope.ts';
import type { Db } from './db.ts';
import type { Ledger, Task } from './ledger.ts';
import type { Log } from './log.ts';
import type { Verifier } from './verify.ts';

export const INPUT_TYPES = ['string', 'number', 'boolean'] as const;
export type InputType = (typeof INPUT_TYPES)[number];
export type InputValue = string | number | boolean;
export type Inputs = Record<string, InputValue>;

// Noul is Jev's yes/no type: the answer is one calibrated probability in [0, 1] that the answer is
// yes. It has no separate confidence: the probability is the certainty, and 0.5 is the least
// certain an answer can be.
export type Question =
  | { id: string; type: 'choice'; options: string[] }
  | { id: string; type: 'score'; min: number; max: number }
  | { id: string; type: 'noul' };
export const QUESTION_TYPES = ['choice', 'score', 'noul'] as const;

// How certain a Noul answer is, from 0 (p = 0.5) to 1 (p = 0 or 1).
export const noulCertainty = (p: number): number => Math.abs(p - 0.5) * 2;

export interface TemplateDef {
  template_id: string;
  version: number;
  situation: string;
  inputs: Record<string, InputType>;
  questions: Question[];
  escalation: { confidence_floor: number };
}

export type TemplateState = 'draft' | 'active' | 'retired';
export type Answer = string | number;

export interface DryRunCase { inputs: Record<string, unknown>; expect?: Record<string, Answer> }

export interface Template extends TemplateDef {
  stats: { uses: number; agreed: number; disagreed: number };
  state: TemplateState;
  dry_runs: DryRunCase[];
  activation_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Decision {
  template_id: string;
  version: number;
  answers: Record<string, Answer>;
  confidence: number;
  provider: string;
  escalate: boolean;
  // For logs and receipts only, never shown to the person as Nova speaking.
  why: string;
}

export interface DecisionProvider {
  id: string;
  egress: Egress;
  // The question types this provider can answer; a template with any other type is not sent to it.
  questionTypes: readonly Question['type'][];
  decide(t: Template, inputs: Record<string, unknown>): Promise<Decision>;
  // Whether it can answer this template now (a model provider with no model assigned can't); not
  // asked when false. Absent means always.
  ready?(t: Template): boolean;
}

export const UNKNOWN = 'unknown';
const MAX_OPTIONS = 255;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Schema check, listing every problem.
export function validateTemplate(input: unknown): TemplateDef {
  const errors: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); return ok; };
  if (!need(isObj(input), 'a template must be an object')) throw new CoreError('validation', "This template doesn't match the decision template contract.", errors);
  const t = input as Obj;
  need(isStr(t.template_id) && /^[a-z0-9][a-z0-9._-]*$/.test(t.template_id), 'template_id must be lowercase letters, digits, dots, dashes or underscores');
  need(Number.isInteger(t.version) && (t.version as number) >= 1, 'version must be a whole number from 1');
  need(isStr(t.situation), 'situation is required: what is being decided, in plain words');
  if (need(isObj(t.inputs), 'inputs must be an object of name → type')) {
    for (const [k, v] of Object.entries(t.inputs as Obj)) need(INPUT_TYPES.includes(v as InputType), `inputs.${k} must be one of ${INPUT_TYPES.join(', ')}`);
  }
  if (need(Array.isArray(t.questions) && t.questions.length > 0, 'questions must be a non-empty list')) {
    const ids = new Set<string>();
    (t.questions as unknown[]).forEach((q, i) => {
      const at = `questions[${i}]`;
      if (!need(isObj(q) && isStr(q.id), `${at}.id is required`)) return;
      const x = q as Obj;
      need(!ids.has(x.id as string), `${at}.id "${x.id}" is used twice`);
      ids.add(x.id as string);
      if (x.type === 'choice') {
        if (!need(Array.isArray(x.options) && x.options.every(isStr), `${at}.options must be a list of strings`)) return;
        const options = x.options as string[];
        need(options.length >= 1 && options.length <= MAX_OPTIONS, `${at} must have 1 to ${MAX_OPTIONS} options`);
        need(new Set(options).size === options.length, `${at}.options must not repeat`);
        need(options.includes(UNKNOWN), `${at} must offer "${UNKNOWN}", so there is always a way to say it doesn't fit`);
      } else if (x.type === 'score') {
        if (need(isNum(x.min) && isNum(x.max), `${at}.min and max must be numbers`)) need((x.min as number) < (x.max as number), `${at}.min must be below max`);
      } else if (x.type === 'noul') {
        need(x.options === undefined && x.min === undefined && x.max === undefined, `${at} is a yes/no probability; it takes no options, min or max`);
      } else {
        need(false, `${at}.type must be choice, score or noul`);
      }
    });
  }
  const floor = isObj(t.escalation) ? t.escalation.confidence_floor : undefined;
  need(isNum(floor) && floor >= 0 && floor <= 1, 'escalation.confidence_floor must be a number from 0 to 1');
  if (errors.length) throw new CoreError('validation', "This template doesn't match the decision template contract.", errors);
  const { template_id, version, situation, inputs, questions, escalation } = t as unknown as TemplateDef;
  return { template_id, version, situation, inputs, questions, escalation: { confidence_floor: escalation.confidence_floor } };
}

// Inputs must be exactly what the template declares, with the declared types.
export function checkInputs(t: TemplateDef, inputs: Record<string, unknown>): Inputs {
  const errors: string[] = [];
  for (const [k, type] of Object.entries(t.inputs)) if (typeof inputs[k] !== type) errors.push(`${k} must be a ${type}`);
  for (const k of Object.keys(inputs)) if (!(k in t.inputs)) errors.push(`${k} is not an input of ${t.template_id}`);
  if (errors.length) throw new CoreError('validation', `These inputs don't fit the template ${t.template_id}: ${errors.join('; ')}.`, errors);
  return inputs as Inputs;
}

// Out-of-schema answers become "unknown" (choice), drop to the minimum (score) or to 0.5, the least
// certain probability (noul); any of these escalates the decision.
function normalize(t: TemplateDef, raw: Record<string, unknown>): { answers: Record<string, Answer>; clean: boolean } {
  const answers: Record<string, Answer> = {};
  let clean = true;
  for (const q of t.questions) {
    const a = raw[q.id];
    if (q.type === 'choice') {
      const ok = typeof a === 'string' && q.options.includes(a);
      answers[q.id] = ok ? a : UNKNOWN;
      if (!ok || a === UNKNOWN) clean = false;
    } else if (q.type === 'noul') {
      const ok = isNum(a) && a >= 0 && a <= 1;
      answers[q.id] = ok ? a : 0.5;
      if (!ok) clean = false;
    } else {
      const ok = isNum(a) && a >= q.min && a <= q.max;
      answers[q.id] = ok ? a : q.min;
      if (!ok) clean = false;
    }
  }
  return { answers, clean };
}

function settle(t: TemplateDef, provider: string, raw: { answers?: unknown; confidence?: unknown; escalate?: unknown; why?: unknown }): Decision {
  const { answers, clean } = normalize(t, isObj(raw.answers) ? raw.answers : {});
  const stated = isNum(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0;
  // Noul answers carry their own certainty. A provider's separate confidence counts only for the
  // other question types; with Noul questions alone it is ignored.
  const noul = t.questions.filter((q) => q.type === 'noul').map((q) => noulCertainty(answers[q.id] as number));
  const others = t.questions.some((q) => q.type !== 'noul');
  const confidence = noul.length ? Math.min(...noul, others ? stated : 1) : stated;
  return {
    template_id: t.template_id,
    version: t.version,
    answers,
    confidence,
    provider,
    escalate: raw.escalate === true || !clean || confidence < t.escalation.confidence_floor,
    why: typeof raw.why === 'string' ? raw.why : '',
  };
}

export type Rule = (inputs: Inputs) => { answers: Record<string, Answer>; confidence: number; why: string };

// The local decision provider: deterministic rules per template, no model, no network. A template
// without a rule answers unknown with no confidence, which escalates.
export class RulesProvider implements DecisionProvider {
  readonly id = 'rules';
  readonly egress: Egress = 'none';
  readonly questionTypes = QUESTION_TYPES;
  #rules = new Map<string, Rule>();

  add(templateId: string, rule: Rule): void {
    if (this.#rules.has(templateId)) throw new Error(`There is already a rule for ${templateId}.`);
    this.#rules.set(templateId, rule);
  }

  has(templateId: string): boolean {
    return this.#rules.has(templateId);
  }

  evaluate(t: TemplateDef, inputs: Inputs): Decision {
    const rule = this.#rules.get(t.template_id);
    if (!rule) return settle(t, this.id, { answers: {}, confidence: 0, why: `No local rule for ${t.template_id}.` });
    try {
      return settle(t, this.id, rule(inputs));
    } catch (e) {
      return settle(t, this.id, { answers: {}, confidence: 0, why: `The rule for ${t.template_id} failed: ${(e as Error).message}` });
    }
  }

  async decide(t: Template, inputs: Record<string, unknown>): Promise<Decision> {
    return this.evaluate(t, checkInputs(t, inputs));
  }
}

// Jev (ADR-7) is a hosted typed-decision API. Its wire format needs the owner's account and docs,
// so until then this refuses instead of guessing.
// Jev, the hosted typed-decision API. A stub until the owner decides on an account: it declares
// what Jev answers (including Noul, Jev's yes/no probability) and refuses to run.
export class JevProvider implements DecisionProvider {
  readonly id = 'jev';
  readonly egress: Egress = 'remote';
  readonly questionTypes = QUESTION_TYPES;
  async decide(_t: Template, _inputs: Record<string, unknown>): Promise<Decision> {
    throw new Error('The Jev decision provider is not configured.');
  }
}

export interface DryRunResult { ok: boolean; results: { case: DryRunCase; decision: Decision | null; ok: boolean; why: string }[] }

type Row = Record<string, string | number | null>;
const parse = <T>(s: unknown): T => JSON.parse(s as string) as T;

function toTemplate(r: Row): Template {
  return {
    template_id: r.template_id as string,
    version: r.version as number,
    situation: r.situation as string,
    inputs: parse(r.inputs),
    questions: parse(r.questions),
    escalation: parse(r.escalation),
    stats: { uses: r.uses as number, agreed: r.agreed as number, disagreed: r.disagreed as number },
    state: r.state as TemplateState,
    dry_runs: parse(r.dry_runs),
    activation_task_id: r.activation_task_id as string | null,
    created_by: r.created_by as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

const TEST_PREFIX = 'template:';
const testName = (id: string, version: number) => `${TEST_PREFIX}${id}@${version}`;

export interface TemplatesOptions { db: Db; verifier: Verifier; rules: RulesProvider; now?: () => Date }

// The template store: propose → validate → dry runs → activate (a ledger task) → active.
export class Templates {
  readonly worker: Worker;
  #db: Db;
  #rules: RulesProvider;
  #now: () => Date;
  #ledger: Ledger | null = null;

  constructor(o: TemplatesOptions) {
    this.#db = o.db;
    this.#rules = o.rules;
    this.#now = o.now ?? (() => new Date());
    o.verifier.registerTest(TEST_PREFIX, (e) => {
      if (e.kind !== 'test_result') return { ok: false, why: 'Not a test result.' };
      const m = /^template:(.+)@(\d+)$/.exec(e.name);
      const t = m ? this.version(m[1]!, Number(m[2])) : null;
      if (!t) return { ok: false, why: `There is no template ${e.name.slice(TEST_PREFIX.length)} to re-check.` };
      if (!e.passed) return { ok: false, why: `The report says the dry runs of ${t.template_id} v${t.version} failed.` };
      const run = this.#run(t, t.dry_runs);
      const failed = run.results.filter((r) => !r.ok);
      if (!run.results.length) return { ok: false, why: `${t.template_id} v${t.version} has no dry runs to re-check.` };
      if (failed.length) return { ok: false, why: `Nova re-ran the dry runs itself and ${failed.length} of ${run.results.length} failed: ${failed.map((r) => r.why).join('; ')}` };
      return { ok: true, why: `Nova re-ran ${run.results.length} dry runs of ${t.template_id} v${t.version} itself; all passed.` };
    });
    this.worker = {
      id: 'templates',
      name: 'Decision templates',
      about: 'Runs a decision template’s dry runs before it is used.',
      egress: 'none',
      evidence: ['test_result'],
      health: () => ({ ok: true }),
      run: async (brief: Brief): Promise<Report> => {
        const started = performance.now();
        const { template_id, version } = (brief.inputs ?? {}) as { template_id?: string; version?: number };
        const t = typeof template_id === 'string' && typeof version === 'number' ? this.version(template_id, version) : null;
        const base = { envelope: ENVELOPE_VERSION as typeof ENVELOPE_VERSION, task_id: brief.task_id, artifacts: [], blockers: [], follow_up_suggestions: [] };
        if (!t) return { ...base, status: 'failed', summary: 'There is no such template.', evidence: [], usage: { duration_ms: performance.now() - started } };
        const run = this.#run(t, t.dry_runs);
        const passed = run.ok && run.results.length > 0;
        const failed = run.results.filter((r) => !r.ok);
        return {
          ...base,
          status: passed ? 'done' : 'failed',
          summary: passed ? `All ${run.results.length} dry runs of ${t.template_id} v${t.version} passed.` : `${failed.length} of ${run.results.length} dry runs failed: ${failed.map((r) => r.why).join('; ')}`,
          evidence: [{ kind: 'test_result', name: testName(t.template_id, t.version), passed, output: run.results.map((r) => r.why).join('\n') }],
          usage: { duration_ms: performance.now() - started },
        };
      },
    };
  }

  // Activation finishes when the ledger has verified the task, not when the worker says so.
  bind(ledger: Ledger): void {
    this.#ledger = ledger;
    ledger.on('task', (task: Task) => {
      if (task.owner !== this.worker.id) return;
      const { template_id, version } = (task.brief.inputs ?? {}) as { template_id: string; version: number };
      if (task.state === 'done') this.#activated(task, template_id, version);
      else if (task.state === 'failed' || task.state === 'cancelled') this.#event(template_id, version, 'activation_failed', { task_id: task.id, reason: task.reason });
    });
  }

  get(id: string): Template | null {
    const row = this.#db.get<Row>(`SELECT * FROM decision_template WHERE template_id = ? AND state = 'active'`, id);
    return row ? toTemplate(row) : null;
  }

  version(id: string, version: number): Template | null {
    const row = this.#db.get<Row>('SELECT * FROM decision_template WHERE template_id = ? AND version = ?', id, version);
    return row ? toTemplate(row) : null;
  }

  list(): Template[] {
    return this.#db.all<Row>('SELECT * FROM decision_template ORDER BY template_id, version').map(toTemplate);
  }

  events(id: string): { seq: number; version: number; at: string; kind: string; detail: unknown }[] {
    return this.#db.all<Row>('SELECT * FROM decision_template_event WHERE template_id = ? ORDER BY seq', id)
      .map((e) => ({ seq: e.seq as number, version: e.version as number, at: e.at as string, kind: e.kind as string, detail: e.detail === null ? null : parse(e.detail) }));
  }

  // A template that ships with Nova, tested in its test suite, starts active. Once it exists its
  // state is the person's to change.
  builtIn(def: TemplateDef): Template {
    const t = validateTemplate(def);
    if (!this.version(t.template_id, t.version)) {
      this.#db.tx(() => {
        this.#insert(t, 'active', 'built-in');
        this.#event(t.template_id, t.version, 'built_in', null);
      });
    }
    return this.version(t.template_id, t.version)!;
  }

  propose(def: unknown, by: string): Template {
    const t = validateTemplate(def);
    if (this.version(t.template_id, t.version)) throw new CoreError('conflict', `${t.template_id} v${t.version} already exists. Propose a new version instead.`);
    this.#db.tx(() => {
      this.#insert(t, 'draft', by);
      this.#event(t.template_id, t.version, 'proposed', { by });
    });
    return this.version(t.template_id, t.version)!;
  }

  validate(id: string, version: number): TemplateDef {
    return validateTemplate(this.#need(id, version));
  }

  // Runs the cases against the local provider and keeps them; activation and the verifier re-run them.
  dryRun(id: string, version: number, cases: DryRunCase[]): DryRunResult {
    const t = this.#need(id, version);
    if (t.state !== 'draft') throw new CoreError('conflict', `${id} v${version} is ${t.state}; dry runs are for drafts.`);
    if (!Array.isArray(cases) || !cases.length || !cases.every((c) => isObj(c) && isObj(c.inputs) && (c.expect === undefined || isObj(c.expect)))) {
      throw new CoreError('validation', 'Dry runs must be a non-empty list of {inputs, expect?}.');
    }
    const result = this.#run(t, cases);
    this.#db.tx(() => {
      this.#db.run('UPDATE decision_template SET dry_runs = ?, updated_at = ? WHERE template_id = ? AND version = ?', JSON.stringify(cases), this.#now().toISOString(), id, version);
      this.#event(id, version, 'dry_run', { ok: result.ok, cases: cases.length, failed: result.results.filter((r) => !r.ok).map((r) => r.why) });
    });
    return result;
  }

  // Starts the activation task. The template becomes active only once the ledger has verified it.
  activate(id: string, version: number): Task {
    if (!this.#ledger) throw new Error('The template store is not bound to the ledger.');
    const t = this.#need(id, version);
    if (t.state !== 'draft') throw new CoreError('conflict', `${id} v${version} is ${t.state}, not a draft.`);
    const run = this.#run(t, t.dry_runs);
    if (!run.results.length) throw new CoreError('validation', `Run the dry runs for ${id} v${version} before activating it.`);
    if (!run.ok) throw new CoreError('validation', `The dry runs for ${id} v${version} don't pass yet.`, run.results.filter((r) => !r.ok).map((r) => r.why));
    const task = this.#ledger.create({
      title: `Check the decision template ${id} v${version}`,
      owner: this.worker.id,
      goal: `The dry runs of ${id} v${version} pass, so it can be used.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'test_result', note: testName(id, version) }],
      inputs: { template_id: id, version },
      privacy_mode: 'local-only',
      approval_tier: 0,
      user_visibility: 'silent',
    });
    this.#db.tx(() => {
      this.#db.run('UPDATE decision_template SET activation_task_id = ?, updated_at = ? WHERE template_id = ? AND version = ?', task.id, this.#now().toISOString(), id, version);
      this.#event(id, version, 'activation_started', { task_id: task.id });
    });
    return task;
  }

  retire(id: string, version: number, why: string): Template {
    const t = this.#need(id, version);
    if (t.state === 'retired') return t;
    this.#db.tx(() => {
      this.#db.run(`UPDATE decision_template SET state = 'retired', updated_at = ? WHERE template_id = ? AND version = ?`, this.#now().toISOString(), id, version);
      this.#event(id, version, 'retired', { why });
    });
    return this.version(id, version)!;
  }

  // A rollback (the change pipeline, M7a): `version` is the one in use again, as it was before the
  // change that replaced it, and the version that replaced it is retired with the reason. With no
  // version to go back to, the replacement is retired and the template is simply not in use.
  reinstate(id: string, version: number | null, replaced: number, why: string): void {
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      const t = this.version(id, replaced);
      if (t && t.state !== 'retired') {
        this.#db.run(`UPDATE decision_template SET state = 'retired', updated_at = ? WHERE template_id = ? AND version = ?`, at, id, replaced);
        this.#event(id, replaced, 'retired', { why });
      }
      if (version !== null && this.version(id, version)) {
        this.#db.run(`UPDATE decision_template SET state = 'active', updated_at = ? WHERE template_id = ? AND version = ?`, at, id, version);
        this.#event(id, version, 'reinstated', { why });
      }
    });
  }

  use(id: string, version: number): void {
    this.#db.run('UPDATE decision_template SET uses = uses + 1 WHERE template_id = ? AND version = ?', id, version);
  }

  #activated(task: Task, id: string, version: number): void {
    const t = this.version(id, version);
    if (!t || t.state !== 'draft') return;
    const proof = task.verification?.checks.some((c) => c.ok && c.evidence?.kind === 'test_result' && c.evidence.name === testName(id, version));
    if (!proof) return this.#event(id, version, 'activation_failed', { task_id: task.id, reason: 'The verified evidence was for a different template.' });
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      const current = this.get(id);
      if (current) {
        this.#db.run(`UPDATE decision_template SET state = 'retired', updated_at = ? WHERE template_id = ? AND version = ?`, at, id, current.version);
        this.#event(id, current.version, 'retired', { why: `Replaced by v${version}.` });
      }
      this.#db.run(`UPDATE decision_template SET state = 'active', updated_at = ? WHERE template_id = ? AND version = ?`, at, id, version);
      this.#event(id, version, 'activated', { task_id: task.id });
    });
  }

  #run(t: TemplateDef, cases: DryRunCase[]): DryRunResult {
    const results = cases.map((c, i) => {
      let inputs: Inputs;
      try {
        inputs = checkInputs(t, c.inputs);
      } catch (e) {
        return { case: c, decision: null, ok: false, why: `case ${i + 1}: ${(e as Error).message}` };
      }
      const d = this.#rules.evaluate(t, inputs);
      const wrong = Object.entries(c.expect ?? {}).filter(([q, want]) => d.answers[q] !== want);
      if (wrong.length) return { case: c, decision: d, ok: false, why: `case ${i + 1}: ${wrong.map(([q, want]) => `${q} was ${JSON.stringify(d.answers[q])}, expected ${JSON.stringify(want)}`).join(', ')}` };
      return { case: c, decision: d, ok: true, why: `case ${i + 1}: ok` };
    });
    return { ok: results.every((r) => r.ok), results };
  }

  #need(id: string, version: number): Template {
    const t = this.version(id, version);
    if (!t) throw new CoreError('not_found', `There is no template ${id} v${version}.`);
    return t;
  }

  #insert(t: TemplateDef, state: TemplateState, by: string): void {
    const at = this.#now().toISOString();
    this.#db.run(
      `INSERT INTO decision_template (template_id, version, situation, inputs, questions, escalation, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.template_id, t.version, t.situation, JSON.stringify(t.inputs), JSON.stringify(t.questions), JSON.stringify(t.escalation), state, by, at, at,
    );
  }

  #event(id: string, version: number, kind: string, detail: unknown): void {
    this.#db.run('INSERT INTO decision_template_event (template_id, version, at, kind, detail) VALUES (?, ?, ?, ?, ?)', id, version, this.#now().toISOString(), kind, detail === null ? null : JSON.stringify(detail));
  }
}

export interface DecisionsOptions { templates: Templates; providers: DecisionProvider[]; privacy: () => PrivacyMode; log?: Log }

// decide(): the active template, the first provider the privacy mode allows that answers, and the
// escalation rule. Local-only uses only providers whose egress is none or local.
export class Decisions {
  #templates: Templates;
  #providers: DecisionProvider[];
  #privacy: () => PrivacyMode;
  #log: Log | undefined;

  constructor(o: DecisionsOptions) {
    this.#templates = o.templates;
    this.#providers = [...o.providers];
    this.#privacy = o.privacy;
    this.#log = o.log;
  }

  // `first`: asked before the others (the local model provider, M6), which then answer only when it
  // can't.
  register(p: DecisionProvider, o: { first?: boolean } = {}): void {
    if (this.#providers.some((x) => x.id === p.id)) throw new Error(`A decision provider called ${p.id} is already registered.`);
    if (o.first) this.#providers.unshift(p); else this.#providers.push(p);
  }

  providers(): { id: string; egress: Egress }[] {
    return this.#providers.map(({ id, egress }) => ({ id, egress }));
  }

  // null on a cache miss: the caller falls back to System 1.5 rules, never to a made-up schema.
  async decide(templateId: string, inputs: Record<string, unknown>, opts: { privacy_mode?: PrivacyMode } = {}): Promise<Decision | null> {
    const t = this.#templates.get(templateId);
    if (!t) return null;
    checkInputs(t, inputs);
    this.#templates.use(t.template_id, t.version);
    // A caller's mode can only tighten the live setting, never loosen it.
    const mode = opts.privacy_mode ? stricter(opts.privacy_mode, this.#privacy()) : this.#privacy();
    const able = (x: DecisionProvider) => t.questions.every((q) => x.questionTypes.includes(q.type));
    for (const p of this.#providers.filter((x) => permits(mode, x.egress) && able(x) && (x.ready?.(t) ?? true))) {
      try {
        return settle(t, p.id, await p.decide(t, inputs));
      } catch (e) {
        this.#log?.warn('decide', `The decision provider ${p.id} didn't answer.`, { template: t.template_id, error: (e as Error).message });
      }
    }
    return settle(t, 'none', { answers: {}, confidence: 0, why: 'No decision provider allowed in this privacy mode could answer.' });
  }
}
