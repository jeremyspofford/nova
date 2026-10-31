// Infrastructure through chat (M10d, docs/plans/M10d.md). An infrastructure project is a folder of
// the person's with a plan/apply tool's configuration, a monthly budget and a price sheet. A run on it
// is a chain of Work Ledger tasks for the `infra` worker, each made only once the one before is
// verified done:
//
//   plan (tier 1: changes nothing; the saved plan, priced) → apply (tier 3, every time: it spends or
//   destroys; only a plan inside the budget is ever offered, the budget is checked again as it runs,
//   and a checkpoint is taken first)
//
// Built on what exists: the ledger's tiers, privacy gate, commit points and recovery; checkpoints;
// the vault (provider secrets, handed to the tool's process only); log problems and the trigger
// engine's messages for alerts; runLines and children.ts for every process.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, PRIVACY_MODES, type Brief, type Evidence, type PrivacyMode, type Report, type Tier } from '../envelope.ts';
import { checkFolder } from '../computer/policy.ts';
import { addSecretValue } from '../log.ts';
import { tail } from '../providers/cli.ts';
import { Redactor } from '../browser/logins.ts';
import { openTofu, toolEnv, type PlanApplyTool, type ResourceChange, type ToolContext } from './tool.ts';
import { priceChanges, usd, validateBudget, validatePrices, verdict, type Level, type PriceSheet, type PricedChange, type Verdict } from './budget.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task, TaskInput } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Vault } from '../vault.ts';
import type { Egress } from '../workers.ts';

export const INFRA_WORKER = 'infra';
export const CONFIRMATION_SYSTEM = 'nova-infra';
export const STEPS = ['plan', 'apply'] as const;
export type Step = (typeof STEPS)[number];
export const RUN_STATES = ['planning', 'review', 'applying', 'applied', 'nothing', 'over_budget', 'unpriced', 'failed', 'declined', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];
const ENDED: readonly RunState[] = ['applied', 'nothing', 'over_budget', 'unpriced', 'failed', 'declined', 'cancelled'];
const OPEN: readonly RunState[] = ['planning', 'review', 'applying'];
const TIER: Record<Step, Tier> = { plan: 1, apply: 3 };
const PLAN_FILE = 'plan.tfplan';
const STATE_FILE = 'terraform.tfstate';
const MAX_PLAN_TEXT = 1024 * 1024;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RANK: Record<Level, number> = { ok: 0, warn: 1, over: 2 };

interface ProjectRow { id: string; name: string; folder: string; tool: string; budget_cents: number; prices: string; secrets: string; egress: Egress; alert_level: Level; created_at: string; updated_at: string }
interface RunRow {
  id: string; project_id: string; title: string; destroy: number; privacy_mode: PrivacyMode; session_id: string | null; state: RunState; reason: string | null;
  plan_sha: string | null; plan_text: string | null; changes: string | null; delta_cents: number | null; verdict: string | null; checkpoint: string | null; state_before: string | null;
  apply_out: string | null; tasks: string; created_at: string; updated_at: string;
}
interface ResourceRow { project_id: string; address: string; type: string; monthly_cents: number; run_id: string; created_at: string; updated_at: string }
interface TaskRef { step: Step; id: string }
interface Changes { resources: ResourceChange[]; priced: PricedChange[]; unpriced: string[] }
type Reporter = (status: Report['status'], summary: string, more?: Partial<Report>) => Report;

export interface InfraOptions {
  db: Db; log: Log; home: string; ledger: Ledger; verifier: Verifier; vault: Vault;
  privacy: () => PrivacyMode;
  // An automatic checkpoint of Nova's home (Checkpoints.auto); throws when it can't be taken, and
  // then nothing is applied.
  checkpoint: (reason: string) => { id: string };
  // Telling the person (the trigger engine's proactive message): a plan to review, an alert, an apply.
  notify?: (key: string, text: string) => void;
  // The PATH the tool is looked up on and runs with (tests put the stand-in on one of their own).
  path?: () => string;
  tool?: PlanApplyTool;
  // Whose home folder a project may never be (os.homedir() unless a test says).
  userHome?: string;
  timeoutS?: number;
  now?: () => Date;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n = 80) => { const t = s.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const parse = <T>(s: string | null): T | null => (s ? JSON.parse(s) as T : null);
const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const signed = (c: number) => `${c < 0 ? '−' : '+'}${usd(Math.abs(c))}`;

export class Infra {
  readonly worker: LanedWorker;
  readonly dir: string;
  readonly tool: PlanApplyTool;
  #o: InfraOptions;
  #now: () => Date;
  #key = Symbol('infra');

  constructor(o: InfraOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.dir = join(o.home, 'workers', 'infra');
    this.tool = o.tool ?? openTofu({ path: () => this.#path() });
    const self = this;
    this.worker = {
      id: INFRA_WORKER,
      name: 'Infrastructure',
      about: 'Plans and applies infrastructure with OpenTofu in a project you registered: the plan runs by itself and changes nothing; Nova shows it to you in full, priced against the project’s budget, and applies it only when you confirm, after a checkpoint. A plan over budget, or one it can’t price, is never offered.',
      egress: 'remote',
      evidence: ['confirmation'],
      timeoutMs: 60 * 60_000,
      lane: (brief: Brief) => ({ key: `project:${String(brief.inputs?.project_id ?? '')}`, max: 1 }),
      egressFor: (brief: Brief): Egress => {
        const p = self.#o.db.get<ProjectRow>('SELECT * FROM infra_project WHERE id = ?', String(brief.inputs?.project_id ?? ''));
        return p ? p.egress : 'remote';
      },
      minTier: (input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier => TIER[input.inputs?.step as Step] ?? 3,
      // An apply changes what exists outside, and may have by the time it stops: it never runs again
      // by itself once it passed its commit point.
      effects: (brief: Brief) => (brief.inputs?.step === 'apply' ? 'external' : 'none'),
      commits: (brief: Brief) => brief.inputs?.step === 'apply',
      internal: { key: this.#key, why: 'Only Nova’s infrastructure runs make their own tasks. Ask for a plan in chat, or start one with POST /infra/runs.' },
      health: () => (self.tool.where() ? { ok: true, detail: `${self.tool.name} is on this computer.` } : { ok: true, detail: `${self.tool.name} isn’t on this computer; infrastructure runs can’t plan until it is.` }),
      run: (brief: Brief, signal: AbortSignal) => self.#run(brief, signal),
    };
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    o.ledger.on('task', (t: Task) => {
      if (t.owner !== INFRA_WORKER) return;
      try { this.#advance(t); } catch (e) { o.log.problem('infra', `Nova couldn’t take an infrastructure run to its next step: ${(e as Error).message}`, { detail: (e as Error).stack, taskId: t.id }); }
    });
  }

  #path(): string { return this.#o.path?.() ?? process.env.PATH ?? ''; }

  // ---- projects ------------------------------------------------------------------------------------

  // The person registers a project (the API; never chat): its folder, budget, price sheet and the
  // names of its provider secrets. The values go in with setSecret.
  createProject(body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    if (!name || name.length > 60) throw new CoreError('validation', 'name is the project’s name, 1 to 60 characters.');
    const folder = checkFolder(body.folder, { home: this.#o.home, userHome: this.#o.userHome ?? homedir() });
    let entries: string[] = [];
    try { entries = readdirSync(folder); } catch { /* checked below */ }
    if (!entries.some((f) => f.endsWith('.tf') || f.endsWith('.tf.json'))) throw new CoreError('validation', `${folder} has no OpenTofu configuration (.tf or .tf.json files).`);
    const budget = validateBudget(body.budget_usd_month);
    const prices = validatePrices(body.prices);
    const secrets = body.secrets === undefined ? [] : body.secrets;
    if (!Array.isArray(secrets) || secrets.length > 20 || !secrets.every((s) => typeof s === 'string' && ENV_NAME.test(s))) {
      throw new CoreError('validation', 'secrets lists the names of the environment variables the provider reads its credentials from, like ["CLOUD_TOKEN"] (capital letters, digits and underscores). Their values go into the vault with PUT /infra/projects/{id}/secrets/{NAME}, never in chat.');
    }
    const egress = body.egress === undefined ? 'remote' : body.egress;
    if (egress !== 'local' && egress !== 'remote') throw new CoreError('validation', 'egress is where the provider’s calls go: "remote" (a cloud, the default) or "local" (a provider on your own network).');
    if (body.tool !== undefined && body.tool !== this.tool.id) throw new CoreError('validation', `tool is ${this.tool.id}, the plan/apply tool Nova speaks.`);
    if (this.#o.db.get('SELECT 1 FROM infra_project WHERE folder = ?', folder)) throw new CoreError('conflict', `${folder} is already a project.`);
    const id = `p${randomBytes(5).toString('hex')}`;
    const at = this.#now().toISOString();
    this.#o.db.run(
      'INSERT INTO infra_project (id, name, folder, tool, budget_cents, prices, secrets, egress, alert_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, folder, this.tool.id, budget, JSON.stringify(prices), JSON.stringify([...new Set(secrets as string[])]), egress, 'ok', at, at,
    );
    this.#o.log.info('infra', 'Infrastructure project registered.', { project: id });
    return this.project(id);
  }

  // A new budget or price sheet, from the person.
  updateProject(id: string, body: Record<string, unknown>) {
    const p = this.#project(id);
    const budget = body.budget_usd_month === undefined ? p.budget_cents : validateBudget(body.budget_usd_month);
    const prices = body.prices === undefined ? parse<PriceSheet>(p.prices)! : validatePrices(body.prices);
    this.#o.db.run('UPDATE infra_project SET budget_cents = ?, prices = ?, updated_at = ? WHERE id = ?', budget, JSON.stringify(prices), this.#now().toISOString(), id);
    this.sweep();
    return this.project(id);
  }

  setSecret(id: string, name: string, value: unknown): { project: string; name: string; stored: true } {
    const p = this.#project(id);
    if (!ENV_NAME.test(name) || !parse<string[]>(p.secrets)!.includes(name)) throw new CoreError('validation', `${name} isn’t one of this project’s secrets (${parse<string[]>(p.secrets)!.join(', ') || 'it has none'}).`);
    if (typeof value !== 'string' || !value.trim() || value.length > 10_000) throw new CoreError('validation', 'value is the secret itself (1 to 10000 characters).');
    this.#o.vault.put(this.#secretName(id, name), value.trim());
    return { project: id, name, stored: true };
  }

  #secretName(project: string, env: string): string { return `infra/${project}/${env}`; }

  #project(id: string): ProjectRow {
    const p = this.#o.db.get<ProjectRow>('SELECT * FROM infra_project WHERE id = ?', id);
    if (!p) throw new CoreError('not_found', `There is no infrastructure project ${id}.`);
    return p;
  }

  #resources(projectId: string): ResourceRow[] {
    return this.#o.db.all<ResourceRow>('SELECT * FROM infra_resource WHERE project_id = ? ORDER BY address', projectId);
  }

  #total(projectId: string): number { return this.#resources(projectId).reduce((s, r) => s + r.monthly_cents, 0); }

  project(id: string) {
    const p = this.#project(id);
    const resources = this.#resources(id);
    const total = resources.reduce((s, r) => s + r.monthly_cents, 0);
    const v = verdict(total, 0, p.budget_cents);
    const secrets = parse<string[]>(p.secrets)!;
    return {
      id: p.id, name: p.name, folder: p.folder, tool: p.tool, egress: p.egress, budget_usd_month: p.budget_cents / 100, prices: parse<PriceSheet>(p.prices),
      secrets: secrets.map((s) => ({ name: s, stored: this.#o.vault.has(this.#secretName(p.id, s)) })),
      resources: resources.map((r) => ({ address: r.address, type: r.type, monthly_usd: r.monthly_cents / 100, since: r.created_at, run_id: r.run_id,
        budget: `in project “${p.name}”: ${v.words}`, alert: `Nova alerts at 80 % of the budget and stops any plan that would go over.` })),
      monthly_usd: total / 100, level: v.level, words: v.words, alert_level: p.alert_level, created_at: p.created_at,
    };
  }

  // ---- runs -------------------------------------------------------------------------------------------

  // A run on a project and its first task, the plan (tier 1). Throws in plain words.
  start(input: Record<string, unknown>, o: { session?: string | null; origin?: TaskInput['origin'] } = {}) {
    const ref = typeof input.project === 'string' ? input.project.trim() : '';
    const p = this.#o.db.get<ProjectRow>('SELECT * FROM infra_project WHERE id = ? OR name = ? ORDER BY created_at LIMIT 1', ref, ref);
    if (!p) throw new CoreError('validation', `There is no infrastructure project “${ref}”. ${this.#projectNames()}`);
    if (!this.tool.where()) throw new CoreError('conflict', `${this.tool.name} isn’t on this computer (no tofu on PATH). Nova doesn’t install it.`);
    const open = this.#o.db.get<RunRow>(`SELECT * FROM infra_run WHERE project_id = ? AND state IN (${OPEN.map(() => '?').join(', ')})`, p.id, ...OPEN);
    if (open) throw new CoreError('conflict', `Run ${open.id} on “${p.name}” is still open (${open.state}); one run at a time on a project.`);
    const destroy = input.destroy === true;
    const privacy = input.privacy_mode === undefined ? this.#o.privacy() : input.privacy_mode;
    if (!PRIVACY_MODES.includes(privacy as PrivacyMode)) throw new CoreError('validation', `privacy_mode is one of ${PRIVACY_MODES.join(', ')}.`);
    const id = `i${randomBytes(5).toString('hex')}`;
    const at = this.#now().toISOString();
    const title = destroy ? `Destroy everything in ${p.name}` : `Bring ${p.name} up to its configuration`;
    this.#o.db.run(
      `INSERT INTO infra_run (id, project_id, title, destroy, privacy_mode, session_id, state, tasks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planning', '[]', ?, ?)`,
      id, p.id, title, destroy ? 1 : 0, privacy as PrivacyMode, o.session ?? null, at, at,
    );
    let task: Task;
    try { task = this.#make(this.#run_(id), 'plan', o.origin ?? { kind: 'user' }); } catch (e) {
      this.#o.db.run('DELETE FROM infra_run WHERE id = ?', id);
      throw e;
    }
    return { run: this.view(id), task };
  }

  #projectNames(): string {
    const names = this.#o.db.all<{ name: string }>('SELECT name FROM infra_project ORDER BY created_at').map((r) => r.name);
    return names.length ? `Projects: ${names.join(', ')}.` : 'No project is registered yet: the person registers one (its folder, budget and prices) with POST /infra/projects.';
  }

  #run_(id: string): RunRow {
    const r = this.#o.db.get<RunRow>('SELECT * FROM infra_run WHERE id = ?', id);
    if (!r) throw new CoreError('not_found', `There is no infrastructure run ${id}.`);
    return r;
  }

  #make(r: RunRow, step: Step, origin: TaskInput['origin'] = { kind: 'user' }): Task {
    const p = this.#project(r.project_id);
    const tasks = parse<TaskRef[]>(r.tasks) ?? [];
    const v = parse<Verdict>(r.verdict);
    const t = this.#o.ledger.create({
      title: step === 'plan' ? `Plan: ${r.title}` : `Apply: ${r.title}`,
      owner: INFRA_WORKER,
      goal: step === 'plan'
        ? `Run ${this.tool.name}’s plan for “${p.name}” (${p.folder})${r.destroy ? ', destroying everything in it' : ''}, and price it against the project’s budget. Nothing is changed.`
        : `Apply the reviewed plan for “${p.name}” (sha256 ${String(r.plan_sha).slice(0, 12)}…): ${signed(r.delta_cents ?? 0)} a month, ${v?.words ?? ''}. Nova takes a checkpoint first.`,
      origin, evidence_required: [{ kind: 'confirmation', note: step === 'plan' ? 'the saved plan, as Nova recorded it' : 'Nova reads the tool’s state back' }],
      privacy_mode: r.privacy_mode, approval_tier: TIER[step],
      inputs: { step, run_id: r.id, project_id: p.id, destroy: r.destroy === 1, ...(step === 'apply' ? { plan_sha: r.plan_sha } : {}) },
      idempotency_key: `infra:${r.id}:${step}`,
      ...(tasks[0] ? { parent_id: tasks[0].id } : {}),
    }, { as: this.#key });
    if (!tasks.some((x) => x.id === t.id)) {
      tasks.push({ step, id: t.id });
      this.#o.db.run('UPDATE infra_run SET tasks = ?, updated_at = ? WHERE id = ?', JSON.stringify(tasks), this.#now().toISOString(), r.id);
    }
    return t;
  }

  #set(id: string, f: Partial<Pick<RunRow, 'state' | 'reason' | 'plan_sha' | 'plan_text' | 'changes' | 'delta_cents' | 'verdict' | 'checkpoint' | 'state_before' | 'apply_out'>>): void {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    this.#o.db.run(`UPDATE infra_run SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (f[k] ?? null) as string | number | null), this.#now().toISOString(), id);
  }

  #tell(key: string, text: string): void {
    try { this.#o.notify?.(key, text); } catch { /* the run's record says it too */ }
  }

  // An alert: a problem (Problems, health) and a message to the person.
  #alert(key: string, text: string, taskId?: string): void {
    this.#o.log.problem('infra', text, taskId ? { taskId } : {});
    this.#tell(key, text);
  }

  #advance(t: Task): void {
    const step = t.brief.inputs?.step as Step;
    const r = this.#o.db.get<RunRow>('SELECT * FROM infra_run WHERE id = ?', String(t.brief.inputs?.run_id ?? ''));
    if (!r || ENDED.includes(r.state)) return;
    const p = this.#project(r.project_id);
    if (t.state === 'done') {
      if (step === 'plan') {
        const ch = parse<Changes>(r.changes);
        const v = parse<Verdict>(r.verdict);
        if (!ch || !v) return;
        if (!ch.priced.length) {
          this.#set(r.id, { state: 'nothing', reason: `No changes: “${p.name}” already matches its configuration.` });
          this.#drop(r.id);
          return;
        }
        if (ch.unpriced.length) {
          const why = `Nova can’t price ${ch.unpriced.join(', ')} from the price sheet of “${p.name}”, so it can’t keep the plan inside the budget. Nothing was applied, and Nova won’t offer it until the price sheet has it.`;
          this.#set(r.id, { state: 'unpriced', reason: why });
          this.#alert(`infra:${r.id}:unpriced`, `Budget guardrail: ${why}`, t.id);
          this.#drop(r.id);
          return;
        }
        if (v.blocks) {
          const why = `The plan for “${p.name}” would cost ${signed(r.delta_cents ?? 0)} a month, taking it to ${v.words}: over budget. Nova applied nothing and won’t offer it. Lower the plan, or raise the budget yourself.`;
          this.#set(r.id, { state: 'over_budget', reason: why });
          this.#alert(`infra:${r.id}:over`, `Budget alert: ${why}`, t.id);
          this.#drop(r.id);
          return;
        }
        this.#set(r.id, { state: 'review', reason: `Ready for you: the plan in full, ${signed(r.delta_cents ?? 0)} a month (${v.words}). Nova applies it only when you confirm.` });
        this.#make(this.#run_(r.id), 'apply');
        // Past 80 %: the ask says so, and the person is told; once applied, the project's own level
        // raises the alert (#level).
        if (v.level === 'warn') this.#tell(`infra:${r.id}:warn`, `Budget alert: applying the plan for “${p.name}” would take it to ${v.words}, past 80 %. Nova still asks before it applies.`);
        this.#tell(`infra:${r.id}:review`, `The plan for “${p.name}” is ready for you to review: ${this.#counts(ch.priced)}, ${signed(r.delta_cents ?? 0)} a month (${v.words}). Nova applies it only when you confirm, in Tasks.`);
      } else if (step === 'apply') {
        const total = this.#total(p.id);
        const v = verdict(total, 0, p.budget_cents);
        this.#set(r.id, { state: 'applied', reason: `Applied. “${p.name}” now costs ${usd(total)} a month by its price sheet (${v.words}).` });
        this.#drop(r.id, { keepState: true });
        this.#tell(`infra:${r.id}:applied`, `Applied the plan for “${p.name}”: ${this.#counts(parse<Changes>(r.changes)?.priced ?? [])}. It now costs ${v.words}. A checkpoint from just before is in Settings › Checkpoints.`);
        this.#level(p, v);
      }
      return;
    }
    if (t.state === 'failed') {
      this.#set(r.id, { state: 'failed', reason: t.reason });
      this.#drop(r.id, { keepState: step === 'apply' });
      this.#tell(`infra:${r.id}:failed`, `The ${step} for “${p.name}” stopped: ${clip(t.reason ?? 'it failed', 400)}`);
      return;
    }
    if (t.state === 'cancelled') {
      // An apply cancelled after it started may have changed things: it isn't "declined".
      const started = step === 'apply' && r.state === 'applying';
      const declined = step === 'apply' && !started;
      this.#set(r.id, { state: declined ? 'declined' : 'cancelled', reason: declined ? `You didn’t apply it. Nothing in “${p.name}” changed.` : started ? `Cancelled after the apply had started: check what OpenTofu’s state says for “${p.name}”.` : `Cancelled: ${t.reason ?? ''}`.trim() });
      this.#drop(r.id);
    }
  }

  #counts(lines: PricedChange[]): string {
    const n = (a: string) => lines.filter((l) => l.action === a).length;
    const parts = [n('create') && `${n('create')} to add`, n('update') && `${n('update')} to change`, n('replace') && `${n('replace')} to replace`, n('delete') && `${n('delete')} to destroy`].filter(Boolean);
    return parts.length ? parts.join(', ') : 'no changes';
  }

  // The level a project's month is at; an alert when it rises (once per level).
  #level(p: ProjectRow, v: Verdict): void {
    const now = this.#project(p.id);
    if (RANK[v.level] > RANK[now.alert_level]) {
      this.#alert(`infra:${p.id}:level:${v.level}:${v.projected_cents}`, v.level === 'over'
        ? `Budget alert: “${p.name}” is over its budget: ${v.words}. Nova won’t apply any plan that adds to it.`
        : `Budget alert: “${p.name}” is past 80 % of its budget: ${v.words}.`);
    }
    if (v.level !== now.alert_level) this.#o.db.run('UPDATE infra_project SET alert_level = ?, updated_at = ? WHERE id = ?', v.level, this.#now().toISOString(), p.id);
  }

  // On the heartbeat: every project's recorded resources against its budget as it is now.
  sweep(): void {
    for (const p of this.#o.db.all<ProjectRow>('SELECT * FROM infra_project')) {
      try { this.#level(p, verdict(this.#total(p.id), 0, p.budget_cents)); } catch (e) { this.#o.log.warn('infra', 'Nova couldn’t check a project’s budget.', { project: p.id, error: (e as Error).message }); }
    }
  }

  // ---- running a step ------------------------------------------------------------------------------

  #runDir(id: string): string { return join(this.dir, 'runs', id); }

  // A run's own files go when it ends; the copy of the state from before an apply stays.
  #drop(id: string, o: { keepState?: boolean } = {}): void {
    const dir = this.#runDir(id);
    try {
      rmSync(join(dir, PLAN_FILE), { force: true });
      if (!o.keepState) rmSync(dir, { recursive: true, force: true });
    } catch (e) { this.#o.log.warn('infra', 'Nova couldn’t tidy a run’s folder.', { run: id, error: (e as Error).message }); }
  }

  // The tool's context: the project's folder, its secrets from the vault in its environment only,
  // and a redactor holding every one of them.
  #context(p: ProjectRow, signal?: AbortSignal): ToolContext {
    const red = new Redactor();
    const secrets: Record<string, string> = {};
    for (const name of parse<string[]>(p.secrets)!) {
      const v = this.#o.vault.get(this.#secretName(p.id, name));
      if (v === null) throw new CoreError('conflict', `${name} isn’t in the vault yet. Save it with PUT /infra/projects/${p.id}/secrets/${name} (never in chat), then plan again.`);
      secrets[name] = v;
      red.add(v);
      addSecretValue(v);
    }
    return { dir: p.folder, env: toolEnv({ path: this.#path(), home: join(this.dir, 'tool-home'), secrets }), red, ...(signal ? { signal } : {}), timeoutMs: (this.#o.timeoutS ?? 900) * 1000 };
  }

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    let red: Redactor | null = null;
    const report: Reporter = (status, summary, more = {}) => {
      const out: Report = {
        envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
        ...more, usage: { duration_ms: Math.round(performance.now() - started) },
      };
      return red ? red.value(out) : out;
    };
    const step = brief.inputs?.step as Step;
    const r = this.#o.db.get<RunRow>('SELECT * FROM infra_run WHERE id = ?', String(brief.inputs?.run_id ?? ''));
    if (!r) return report('failed', 'This infrastructure run isn’t in Nova’s record any more.');
    if (ENDED.includes(r.state)) return report('failed', `This run has ended (${r.state}).`);
    try {
      const p = this.#project(r.project_id);
      if (!existsSync(p.folder)) return report('failed', `The project’s folder ${p.folder} isn’t there any more.`);
      const c = this.#context(p, signal);
      red = c.red;
      if (step === 'plan') return await this.#plan(r, p, c, report);
      if (step === 'apply') return await this.#apply(r, p, c, brief, report);
      return report('failed', `There is no infrastructure step called “${String(step)}”.`);
    } catch (e) {
      if (signal.aborted) throw e;
      return report('failed', (e as Error).message);
    }
  }

  async #plan(r: RunRow, p: ProjectRow, c: ToolContext, report: Reporter): Promise<Report> {
    const dir = this.#runDir(r.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, PLAN_FILE);
    rmSync(file, { force: true });
    await this.tool.init(c);
    await this.tool.plan(c, file, { destroy: r.destroy === 1 });
    if (!existsSync(file)) return report('failed', `${this.tool.name} made no saved plan.`);
    chmodSync(file, 0o600);
    const shown = await this.tool.showPlan(c, file);
    const sha = sha256File(file);
    const current = new Map(this.#resources(p.id).map((x) => [x.address, x.monthly_cents]));
    const priced = priceChanges(shown.changes, parse<PriceSheet>(p.prices)!, current);
    const v = verdict(this.#total(p.id), priced.delta_cents, p.budget_cents);
    const text = shown.text.length > MAX_PLAN_TEXT ? `${shown.text.slice(0, MAX_PLAN_TEXT)}\n… (the plan goes on)\n` : shown.text;
    const changes: Changes = { resources: shown.changes, priced: priced.lines, unpriced: priced.unpriced };
    this.#set(r.id, { plan_sha: sha, plan_text: c.red.text(text), changes: JSON.stringify(c.red.value(changes)), delta_cents: priced.delta_cents, verdict: JSON.stringify(v) });
    const what = priced.lines.length ? this.#counts(priced.lines) : 'no changes';
    const money = priced.unpriced.length ? `Nova can’t price ${priced.unpriced.join(', ')}.` : `${signed(priced.delta_cents)} a month: ${v.words}.`;
    return report('done', `${this.tool.name} planned “${p.name}”: ${what}. ${money} Nothing was changed.`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `plan:${r.id}:${sha}` }],
      artifacts: [{ kind: 'infra-plan', ref: `infra:${r.id}`, sha256: sha }],
    });
  }

  async #apply(r: RunRow, p: ProjectRow, c: ToolContext, brief: Brief, report: Reporter): Promise<Report> {
    if (r.state !== 'review' && r.state !== 'applying') return report('failed', `This run isn’t waiting to be applied (it is ${r.state}).`);
    const file = join(this.#runDir(r.id), PLAN_FILE);
    const want = String(brief.inputs?.plan_sha ?? '');
    if (!r.plan_sha || want !== r.plan_sha || !existsSync(file) || sha256File(file) !== r.plan_sha) return report('failed', 'The saved plan isn’t the one you reviewed any more, so Nova applied nothing.');
    // The budget again, now: another apply may have run, or the person changed the budget or the
    // price sheet since the review.
    const ch = parse<Changes>(r.changes)!;
    const current = new Map(this.#resources(p.id).map((x) => [x.address, x.monthly_cents]));
    const priced = priceChanges(ch.resources, parse<PriceSheet>(p.prices)!, current);
    if (priced.unpriced.length) {
      this.#alert(`infra:${r.id}:unpriced-at-apply`, `Budget guardrail: Nova can’t price ${priced.unpriced.join(', ')} any more, so it didn’t apply the plan for “${p.name}”.`, brief.task_id);
      return report('failed', `Nova can’t price ${priced.unpriced.join(', ')} any more, so it applied nothing.`);
    }
    const v = verdict(this.#total(p.id), priced.delta_cents, p.budget_cents);
    if (v.blocks) {
      this.#alert(`infra:${r.id}:over-at-apply`, `Budget alert: applying the plan for “${p.name}” now would take it to ${v.words}, over budget. Nova applied nothing.`, brief.task_id);
      return report('failed', `Applying it now would take “${p.name}” to ${v.words}: over budget. Nova applied nothing.`);
    }
    this.#set(r.id, { state: 'applying' });
    // The checkpoint first: Nova's home, and a copy of the tool's state as it is now. No checkpoint,
    // no apply.
    let cp: { id: string };
    try { cp = this.#o.checkpoint(`Before applying the infrastructure plan for “${p.name}” (run ${r.id})`); } catch (e) {
      return report('failed', `Nova couldn’t take a checkpoint before the apply, so it applied nothing: ${(e as Error).message}`);
    }
    const before = join(p.folder, STATE_FILE);
    let stateSha = 'none: the state isn’t in the project’s folder';
    if (existsSync(before)) {
      const copy = join(this.#runDir(r.id), 'state-before.tfstate');
      copyFileSync(before, copy);
      chmodSync(copy, 0o600);
      stateSha = sha256File(copy);
    }
    this.#set(r.id, { checkpoint: cp.id, state_before: stateSha });
    this.#o.ledger.committing(brief.task_id, 'apply the reviewed plan');
    const ran = await this.tool.apply(c, file);
    this.#set(r.id, { apply_out: tail(`${ran.out}\n${ran.err}`.trim(), 60, 8000) });
    if (ran.code !== 0) return report('failed', `${this.tool.name}’s apply failed (exit ${ran.code ?? 'none'}): ${tail(`${ran.err}\n${ran.out}`.trim(), 6, 800)}`);
    // What exists now, read back from the tool's state: each resource Nova provisioned is recorded
    // with its monthly price, under the project's budget.
    const state = await this.tool.state(c);
    const there = new Set(state.map((s) => s.address));
    const at = this.#now().toISOString();
    this.#o.db.tx(() => {
      for (const l of priced.lines) {
        if (l.action === 'delete') { this.#o.db.run('DELETE FROM infra_resource WHERE project_id = ? AND address = ?', p.id, l.address); continue; }
        if (!there.has(l.address)) continue;
        this.#o.db.run(
          `INSERT INTO infra_resource (project_id, address, type, monthly_cents, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, address) DO UPDATE SET type = excluded.type, monthly_cents = excluded.monthly_cents, run_id = excluded.run_id, updated_at = excluded.updated_at`,
          p.id, l.address, l.type, l.after_cents ?? 0, r.id, at, at,
        );
      }
    });
    return report('done', `${this.tool.name} applied the reviewed plan for “${p.name}”: ${this.#counts(priced.lines)}. A checkpoint was taken first (${cp.id}).`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `apply:${r.id}` }],
    });
  }

  // ---- evidence ----------------------------------------------------------------------------------------

  #confirm(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
    const [what, runId, ref] = e.id.split(':');
    const r = this.#o.db.get<RunRow>('SELECT * FROM infra_run WHERE id = ?', runId ?? '');
    if (!r || runId !== brief.inputs?.run_id) return { ok: false, why: 'That confirmation is for another infrastructure run.' };
    try {
      if (what === 'plan') {
        const file = join(this.#runDir(r.id), PLAN_FILE);
        if (!ref || ref !== r.plan_sha || !existsSync(file)) return { ok: false, why: 'Nova has no saved plan by that hash for this run.' };
        const actual = sha256File(file);
        if (actual !== ref) return { ok: false, why: `The saved plan’s sha256 is ${actual.slice(0, 12)}…, not the ${ref.slice(0, 12)}… recorded.` };
        return { ok: true, why: `Nova read its saved plan itself: sha256 ${actual.slice(0, 12)}…, as recorded.` };
      }
      if (what === 'apply') {
        const p = this.#project(r.project_id);
        const c = this.#context(p);
        const state = this.tool.stateSync(c);
        const there = new Set(state.map((s) => s.address));
        const lines = parse<Changes>(r.changes)?.priced ?? [];
        const missing = lines.filter((l) => l.action !== 'delete' && !there.has(l.address)).map((l) => l.address);
        const left = lines.filter((l) => l.action === 'delete' && there.has(l.address)).map((l) => l.address);
        if (missing.length || left.length) return { ok: false, why: `Nova read ${this.tool.name}’s state: ${[missing.length ? `${missing.join(', ')} isn’t there` : '', left.length ? `${left.join(', ')} is still there` : ''].filter(Boolean).join('; ')}.` };
        return { ok: true, why: `Nova read ${this.tool.name}’s state itself: ${plural(lines.length, 'planned change')}, each as planned (${plural(state.length, 'resource')} in the state now).` };
      }
    } catch (err) {
      return { ok: false, why: (err as Error).message };
    }
    return { ok: false, why: `Nova doesn’t know an infrastructure confirmation called “${what}”.` };
  }

  // ---- what callers see ----------------------------------------------------------------------------

  list() {
    return {
      tool: { id: this.tool.id, name: this.tool.name, installed: !!this.tool.where() },
      projects: this.#o.db.all<ProjectRow>('SELECT * FROM infra_project ORDER BY created_at').map((p) => this.project(p.id)),
      runs: this.#o.db.all<RunRow>('SELECT * FROM infra_run ORDER BY created_at DESC LIMIT 100').map((r) => this.#summary(r)),
    };
  }

  #summary(r: RunRow) {
    const p = this.#project(r.project_id);
    const tasks = (parse<TaskRef[]>(r.tasks) ?? []).map((x) => {
      let t: Task | null = null;
      try { t = this.#o.ledger.get(x.id); } catch { /* gone */ }
      return { ...x, state: t?.state ?? 'gone', reason: t?.reason ?? null, approval_tier: t?.approval_tier ?? TIER[x.step] };
    });
    return { id: r.id, title: r.title, project: { id: p.id, name: p.name }, destroy: r.destroy === 1, state: r.state, reason: r.reason, session_id: r.session_id, tasks, created_at: r.created_at, updated_at: r.updated_at };
  }

  // One run: everything the person reviews before the apply.
  view(id: string) {
    const r = this.#run_(id);
    const p = this.#project(r.project_id);
    const ch = parse<Changes>(r.changes);
    const v = parse<Verdict>(r.verdict);
    return {
      ...this.#summary(r), folder: p.folder, plan_sha: r.plan_sha, plan_text: r.plan_text,
      changes: (ch?.priced ?? []).map((l) => ({ address: l.address, type: l.type, action: l.action, monthly_usd_before: l.before_cents === null ? null : l.before_cents / 100, monthly_usd_after: l.after_cents === null ? null : l.after_cents / 100, delta_usd: l.delta_cents / 100 })),
      unpriced: ch?.unpriced ?? [], delta_usd: r.delta_cents === null ? null : r.delta_cents / 100,
      budget: v ? { level: v.level, words: v.words, monthly_usd_now: v.current_cents / 100, monthly_usd_after: v.projected_cents / 100, budget_usd: v.budget_cents / 100 } : null,
      checkpoint: r.checkpoint, state_before: r.state_before, apply_out: r.apply_out,
      apply: r.plan_sha ? `Applying runs ${this.tool.name}’s apply of exactly this saved plan (sha256 ${r.plan_sha.slice(0, 12)}…) in ${p.folder}, after a checkpoint. It may spend money, or destroy what it lists; it can’t be undone by Nova.` : null,
    };
  }

  runOf(taskId: string): string | null {
    let t: Task;
    try { t = this.#o.ledger.get(taskId); } catch { return null; }
    return t.owner === INFRA_WORKER ? String(t.brief.inputs?.run_id ?? '') || null : null;
  }

  // The person says no to the apply: its task is cancelled (the run then ends, declined).
  decline(id: string) {
    const r = this.#run_(id);
    const apply = (parse<TaskRef[]>(r.tasks) ?? []).filter((x) => x.step === 'apply').at(-1);
    const t = apply ? this.#o.ledger.get(apply.id) : null;
    if (!t || ['done', 'failed', 'cancelled'].includes(t.state) || r.state !== 'review') throw new CoreError('conflict', 'This run isn’t waiting for you to apply it.');
    this.#o.ledger.cancel(t.id, 'You didn’t apply it.');
    return this.view(id);
  }

  // After a restart: a step settled while Nova was stopped is followed by its next one now.
  recover(): void {
    for (const r of this.#o.db.all<RunRow>(`SELECT * FROM infra_run WHERE state IN (${OPEN.map(() => '?').join(', ')})`, ...OPEN)) {
      const last = (parse<TaskRef[]>(r.tasks) ?? []).at(-1);
      if (!last) continue;
      try { this.#advance(this.#o.ledger.get(last.id)); } catch (e) { this.#o.log.warn('infra', 'Nova couldn’t pick an infrastructure run up again after a restart.', { run: r.id, error: (e as Error).message }); }
    }
  }
}
