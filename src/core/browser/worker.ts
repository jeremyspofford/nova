// The browser worker (M5 plan §3, M10b plan): a ledger Worker whose briefs are step plans, run in
// Nova's own Chromium held to the task's declared hosts, with the person in control (watch, pause,
// stop, take over). It keeps the live sessions, so the API can show them, hand them over and take
// them back.
//
// Nova Browser (M10b) adds, all in this one worker: Nova's own persistent profile, elements found by
// the accessibility tree, sign-ins from the vault typed at the moment of use, the Noul co-pilot
// beside Nova's own ground truth at every acting step, site templates learnt from a flow that
// succeeded, and the checkout stop: Nova never presses pay.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Evidence, type Report, type Tier } from '../envelope.ts';
import { Sse } from '../api.ts';
import type { Ledger, LanedWorker, Task, TaskInput } from '../ledger.ts';
import type { Log } from '../log.ts';
import type { Db } from '../db.ts';
import type { Decisions, RulesProvider, Template, Templates } from '../decide.ts';
import { findChromium, sweepProfiles, type Found } from './chromium.ts';
import { FINAL_READ, SCREENSHOT, refOf, refetch, squash, taskDir, type FinalRead, type Read } from './evidence.ts';
import {
  NO_HUB, PAY_REFUSAL, allowed, describe, hasEffects, hostEgress, hostOf, marksCommit, minTierOf, planEgress, validateBrowserBrief, validatePlan, whereOf,
  type Hub, type Plan, type Step,
} from './plan.ts';
import { INPUT_KEYS, Session, type Holder, type Input, type Locator, type SessionOptions, type SessionView } from './session.ts';
import {
  BAD, COPILOT_QUESTIONS, QUESTION_WORDS, STEP_TEMPLATE, checkTotals, clip, intentMatches, isPayControl, judge, obstacles, showMoney, upsells,
  type CopilotQuestion, type Totals,
} from './copilot.ts';
import { CHECKOUT_READ, CLICK, ELEMENT_FACTS, FILL, MASK, PAGE_FACTS, SECRET, SELECT, type ElementFacts, type PageFacts } from './facts.ts';
import { FLOW_PREFIX, FLOW_RULE, dryRuns, flowDef, flowTemplateId, markerOf, stepsOf, type LearntStep } from './flows.ts';
import { LOGIN_PREFIX, Redactor, loginHost, loginName, siteHost } from './logins.ts';
import { profileDir } from './profile.ts';

export const BROWSER_WORKER = 'browser';
const STEP_TIMEOUT_MS = 15_000;

// `hub`: where Nova itself listens, which no browser task may reach (plan.ts).
// `launch`: how a browser is started; a stand-in in tests.
// screen: the ingest gate (Amendment 2026-10-30-C Part 3). Each page read is screened as it is
// taken, so its verdict is kept with it before any model step could ever read it.
// `locate`: a vision fallback (M10b): finds a click target in a screenshot when neither the DOM nor
// the accessibility tree could. None ships; a step done that way is marked as a fallback.
export interface BrowserOptions {
  home: string; log: Log; now?: () => Date; env?: NodeJS.ProcessEnv; hub?: () => Hub; launch?: SessionOptions['launch'];
  screen?: (r: { text: string; origin: string; ref: string }) => Promise<{ id: string; verdict: string }>;
  locate?: (png: Buffer, what: string) => Promise<{ x: number; y: number } | null>;
}

// What the rest of the core gives Nova Browser once it exists (index.ts): the vault (sign-ins), the
// decision stack (the co-pilot and site templates), the full ingest screen, and its own records.
export interface Screened { id: string; verdict: string; flags: { kind: string; level: string }[]; extract: string }
export interface Wired {
  db: Db;
  vault: { get(name: string): string | null; list(prefix?: string): string[]; put(name: string, value: string): string; delete(name: string): boolean };
  templates: Templates;
  rules: RulesProvider;
  decisions: Decisions;
  screen: (text: string, origin: string, ref: string) => Promise<Screened>;
  // Whether the local sorting model can answer the co-pilot now, and which provider is it.
  copilotReady: () => boolean;
  providerId: string;
}

// A page read's screen, failing closed: a screen that is missing or throws leaves the read marked
// blocked (no screen id), never with no verdict.
export type ReadScreen = (r: { text: string; origin: string; ref: string }) => Promise<{ id: string; verdict: string }>;
export async function screenRead(screen: ReadScreen | undefined, text: string, url: string): Promise<{ id: string | null; verdict: string; error?: string }> {
  if (!screen) return { id: null, verdict: 'block', error: 'Nova couldn’t screen this read.' };
  try {
    const r = await screen({ text, origin: hostOf(url), ref: url });
    return { id: r.id, verdict: r.verdict };
  } catch (e) {
    return { id: null, verdict: 'block', error: `Nova couldn’t screen this read: ${(e as Error).message}` };
  }
}

const sel = (s: string) => JSON.stringify(s);
// Flags of the ingest checks that mean a dialog is trying to give instructions.
const INSTRUCTING = new Set(['instructions', 'protocol_tags', 'hidden_instructions', 'hidden_protocol']);

// A step stopped by Nova's own checks: the run fails, saying why.
class Stop extends Error {}

interface ReadRec { selector: string; text: string; screen?: { id: string | null; verdict: string; error?: string } }
interface StepRec { n: number; do: Step['do']; what: string; via?: 'dom' | 'a11y' | 'vision'; fallback?: boolean; url?: string }
interface Run {
  id: string; s: Session; plan: Plan; red: Redactor;
  reads: ReadRec[]; records: StepRec[]; learnt: LearntStep[];
  flow: { template: Template; steps: LearntStep[] } | null;
  checkout: (Totals & { url: string }) | null;
  dialogs: Set<string>; blocked: number;
  upsells: Map<string, 'flagged' | 'kept' | 'declined'>;
  copilot: { asked: number; answered: number };
}

export class Browser extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  readonly worker: LanedWorker;
  #o: BrowserOptions;
  #now: () => Date;
  #ledger: Ledger | null = null;
  #stopping = false;
  #w: Wired | null = null;
  // Nova's own profile is used by one browser at a time (Chromium locks it): a task, or Forget.
  #profileUser: string | null = null;

  constructor(o: BrowserOptions) {
    super();
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    const self = this;
    this.worker = {
      id: BROWSER_WORKER,
      name: 'Browser',
      about: 'Works through web pages in Nova’s own browser: opens, fills, clicks, signs in with a saved sign-in and reads, only on the hosts a task declares. You can watch, pause, stop or take over at any time; it asks for you at a step only a person may do. It never pays.',
      // The most it could reach; each task's own reach comes from its declared hosts.
      egress: 'remote',
      evidence: ['screenshot', 'url'],
      // A person may take a while over their step.
      timeoutMs: 60 * 60_000,
      // Nova's own profile takes one browser at a time; a throwaway profile, two.
      lane: (brief: Brief) => {
        try { return self.#plan(brief.inputs).profile === 'fresh' ? { key: 'browser', max: 2 } : { key: 'browser-profile', max: 1 }; } catch { return { key: 'browser', max: 2 }; }
      },
      egressFor: (brief: Brief) => planEgress(validateBrowserBrief({ ...brief, inputs: self.#expand(brief.inputs) }, self.#hub())),
      // A plan that types, chooses, clicks or hands the page to the person may have sent something
      // by the time it fails, so the ledger never reruns it by itself (workers.ts, Effects).
      effects: (brief: Brief) => (hasEffects(self.#plan(brief.inputs)) ? 'external' : 'none'),
      commits: (brief: Brief) => marksCommit(self.#plan(brief.inputs)),
      // Filling in and sending a form sends data outside: it asks first (NOVA-SPEC §6). Checkout
      // is tier 3, always. A plan that can't run gets no tier here; it is refused when delegated.
      minTier: (input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier => {
        try { return minTierOf(self.#plan(input.inputs)); } catch { return 0; }
      },
      health: () => {
        const f = self.chromium();
        return { ok: f.path !== null || f.from === 'none', detail: f.path ? `${f.detail}${self.#sandbox() ? '' : ' Chromium’s own sandbox is off (NOVA_CHROMIUM_SANDBOX=0).'}` : f.detail };
      },
      run: (brief: Brief, signal: AbortSignal) => self.#run(brief, signal),
    };
  }

  bind(ledger: Ledger): void {
    this.#ledger = ledger;
    // A flow that ended verified is learnt as a site template (flows.ts).
    ledger.on('task', (t: Task) => {
      if (t.owner !== BROWSER_WORKER || t.state !== 'done') return;
      try { this.#learn(t); } catch (e) { this.#o.log.warn('browser', 'Nova couldn’t keep a flow as a site template.', { task: t.id, detail: (e as Error).message }); }
    });
  }

  // The rest of the core, once it exists (index.ts).
  wire(w: Wired): void {
    this.#w = w;
    w.templates.builtIn(STEP_TEMPLATE);
    if (!w.rules.has(`${FLOW_PREFIX}x`)) w.rules.addPrefix(FLOW_PREFIX, FLOW_RULE);
  }

  chromium(): Found { return findChromium(this.#o.env ?? process.env); }

  // Profiles left behind by a browser that never closed (Nova killed, the machine off) go at
  // start: they may hold the person's cookies from a takeover. Ones still in use are kept.
  sweep(): number {
    const gone = sweepProfiles();
    if (gone.length) this.#o.log.info('browser', `Removed ${gone.length} browser profile${gone.length === 1 ? '' : 's'} a browser task left behind.`, { count: gone.length });
    return gone.length;
  }

  #hub(): Hub {
    try { return this.#o.hub?.() ?? NO_HUB; } catch { return NO_HUB; }
  }

  #sandbox(): boolean {
    const env = this.#o.env ?? process.env;
    return env.NOVA_CHROMIUM_SANDBOX !== '0' && process.getuid?.() !== 0;
  }

  // ---- plans and flows ---------------------------------------------------------------------

  // A plan naming a learnt flow gets its steps from that template's version, which must be active.
  #expand(inputs: unknown): unknown {
    const o = (typeof inputs === 'object' && inputs !== null ? inputs : {}) as Record<string, unknown>;
    if (o.flow === undefined) return inputs;
    const f = (typeof o.flow === 'object' && o.flow !== null ? o.flow : {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (o.steps !== undefined) problems.push('inputs.steps: a plan that names a flow takes its steps from the flow’s template');
    if (typeof f.name !== 'string' || typeof f.site !== 'string' || !Number.isInteger(f.version)) problems.push('inputs.flow is {name, site, version}: the learnt flow, its site, and the version to run');
    if (!this.#w) problems.push('Site templates aren’t available here.');
    if (problems.length) throw new CoreError('validation', 'This browser plan can’t run.', problems);
    let id: string;
    try { id = flowTemplateId(f.site as string, f.name as string); } catch (e) { throw new CoreError('validation', 'This browser plan can’t run.', [(e as Error).message]); }
    const t = this.#w!.templates.version(id, f.version as number);
    if (!t || t.state !== 'active') throw new CoreError('validation', 'This browser plan can’t run.', [`There is no active version ${String(f.version)} of the flow “${String(f.name)}” on ${String(f.site)}.`]);
    return { ...o, steps: stepsOf(t).map((x) => x.step), flow: { name: f.name, site: siteHost(f.site as string), version: f.version } };
  }

  #plan(inputs: unknown): Plan { return validatePlan(this.#expand(inputs), this.#hub()); }

  // ---- the API's side --------------------------------------------------------------------

  #session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s || !s.live) throw new CoreError('not_found', 'This task has no browser open right now.');
    return s;
  }

  view(id: string): SessionView | { task_id: string; live: false } {
    const s = this.sessions.get(id);
    return s?.live ? s.view() : { task_id: id, live: false };
  }

  list(): SessionView[] { return [...this.sessions.values()].filter((s) => s.live).map((s) => s.view()); }

  takeOver(id: string, h: Holder): SessionView { return this.#session(id).takeOver(h); }
  handBack(id: string, h: Holder): SessionView { this.#session(id).handBack(h); return this.#session(id).view(); }
  pause(id: string, h: Holder): SessionView { return this.#session(id).pause(h); }
  resume(id: string, h: Holder): SessionView { return this.#session(id).resume(h); }

  // Whoever is `key` may no longer hold a browser: every takeover of theirs ends now.
  release(key: string, how: string): void {
    for (const s of this.sessions.values()) if (s.live && s.holder?.key === key) s.release(how);
  }

  async input(id: string, h: Holder, body: Record<string, unknown>): Promise<{ ok: true }> {
    await this.#session(id).input(h, parseInput(body));
    return { ok: true };
  }

  // The live picture and the session's state, as server-sent events: `state`, then `frame`s.
  frames(id: string): Sse {
    const s = this.#session(id);
    return new Sse((send, closed, end) => {
      send('state', s.view());
      const off = s.watch((f) => send('frame', f));
      const changed = () => send('state', s.view());
      const over = () => { send('state', s.view()); end(); };
      s.on('change', changed);
      s.once('closed', over);
      closed(() => { off(); s.off('change', changed); s.off('closed', over); });
    });
  }

  // ---- sign-ins and sites (M10b) -----------------------------------------------------------

  #wired(): Wired {
    if (!this.#w) throw new CoreError('conflict', 'Nova Browser’s sign-ins aren’t available here.');
    return this.#w;
  }

  // The person saves a sign-in for a site. Values go to the vault and are never shown again.
  saveLogin(host: string, body: Record<string, unknown>): { site: string; saved: true } {
    const w = this.#wired();
    const site = siteHost(host);
    const user = typeof body.username === 'string' ? body.username : '';
    const pass = typeof body.password === 'string' ? body.password : '';
    if (!user || user.length > 500 || !pass || pass.length > 500) throw new CoreError('validation', 'A sign-in needs a username and a password (each at most 500 characters).');
    w.vault.put(loginName(site, 'username'), user);
    w.vault.put(loginName(site, 'password'), pass);
    this.#touch(site, true);
    return { site, saved: true };
  }

  deleteLogin(host: string, confirm: boolean): { site: string; deleted: boolean } {
    const w = this.#wired();
    const site = siteHost(host);
    if (confirm !== true) throw new CoreError('validation', 'Deleting a saved sign-in is tier 3: it needs {confirm: true}, every time.');
    const a = w.vault.delete(loginName(site, 'username'));
    const b = w.vault.delete(loginName(site, 'password'));
    return { site, deleted: a || b };
  }

  // The sites Nova's browser keeps something for: a saved sign-in, or data in its profile. Never a value.
  sites(): { site: string; login: boolean; first_at: string | null; last_at: string | null }[] {
    const w = this.#wired();
    const logins = new Set(w.vault.list(LOGIN_PREFIX).map(loginHost).filter((h): h is string => !!h));
    const rows = w.db.all<{ host: string; first_at: string; last_at: string }>('SELECT host, first_at, last_at FROM browser_site ORDER BY last_at DESC');
    const out: { site: string; login: boolean; first_at: string | null; last_at: string | null }[] = rows.map((r) => ({ site: r.host, login: logins.has(r.host), first_at: r.first_at, last_at: r.last_at }));
    for (const h of logins) if (!out.some((r) => r.site === h)) out.push({ site: h, login: true, first_at: null, last_at: null });
    return out;
  }

  #touch(host: string, login = false): void {
    if (!this.#w) return;
    const at = this.#now().toISOString();
    try {
      this.#w.db.run('INSERT INTO browser_site (host, first_at, last_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET last_at = excluded.last_at', host, at, at);
    } catch (e) { if (!login) this.#o.log.warn('browser', 'Couldn’t record a site Nova’s browser used.', { detail: (e as Error).message }); }
  }

  // Forget a site (tier 3, confirmed every time): its cookies and storage leave Nova's profile, and
  // with `login`, its saved sign-in leaves the vault. Cookies belong to a host name, not a port, so
  // this forgets the name's cookies on every port.
  async forgetSite(host: string, o: { confirm?: unknown; login?: unknown }): Promise<{ site: string; cookies: number; login: boolean }> {
    const w = this.#wired();
    const site = siteHost(host);
    if (o.confirm !== true) throw new CoreError('validation', 'Forgetting a site deletes what Nova’s browser keeps for it: tier 3, it needs {confirm: true}, every time.');
    if (this.#profileUser) throw new CoreError('conflict', 'Nova’s browser is busy with a task. Try again when it has finished.');
    const found = this.chromium();
    let cookies = 0;
    // No profile yet: nothing of the site's to clear, and no browser to start for it.
    if (existsSync(profileDir(this.#o.home))) {
      if (!found.path) throw new CoreError('conflict', `Nova can’t open its browser to forget ${site}: ${found.detail}`);
      this.#profileUser = 'forget';
      const s = new Session({ taskId: 'forget-site', chromium: found.path, hosts: [], sandbox: this.#sandbox(), now: this.#now, hub: () => this.#hub(), profile: profileDir(this.#o.home), ...(this.#o.launch ? { launch: this.#o.launch } : {}) });
      try {
        await s.open();
        cookies = await s.clearSite(site);
      } finally {
        await s.close('forgot a site');
        this.#profileUser = null;
      }
    }
    let login = false;
    if (o.login === true) login = this.deleteLogin(site, true).deleted;
    w.db.run('DELETE FROM browser_site WHERE host = ?', site);
    this.#o.log.info('browser', 'Forgot a site in Nova’s browser.', { site, cookies, login });
    return { site, cookies, login };
  }

  // The learnt site templates, newest first: never their steps' values, only their shape.
  flows(): { template_id: string; version: number; state: string; steps: number; uses: number; created_at: string }[] {
    const w = this.#wired();
    return w.templates.list().filter((t) => t.template_id.startsWith(FLOW_PREFIX))
      .map((t) => ({ template_id: t.template_id, version: t.version, state: t.state, steps: t.dry_runs.filter((c) => c.expect?.next === 'continue').length, uses: t.stats.uses, created_at: t.created_at }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // ---- running a plan ------------------------------------------------------------------------

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = Date.now();
    const id = brief.task_id;
    const red = new Redactor();
    const report = (status: Report['status'], summary: string, extra: Partial<Report> = {}): Report => red.value({
      envelope: ENVELOPE_VERSION, task_id: id, status, summary, evidence: [], artifacts: [], blockers: [], follow_up_suggestions: [],
      usage: { duration_ms: Date.now() - started }, ...extra,
    });
    let plan: Plan;
    try { plan = this.#plan(brief.inputs); } catch (e) {
      return report('failed', `The browser plan can’t run: ${e instanceof CoreError ? e.details.join('; ') || e.message : (e as Error).message}`);
    }
    const found = this.chromium();
    if (!found.path) return report('failed', found.detail);
    const own = plan.profile !== 'fresh';
    if (own && this.#profileUser) return report('failed', 'Nova’s browser is busy. This task will need to run again.');

    this.sessions.get(id)?.close('replaced');
    const s = new Session({
      taskId: id, chromium: found.path, hosts: plan.allowed_hosts, sandbox: this.#sandbox(), now: this.#now, hub: () => this.#hub(),
      ...(own ? { profile: profileDir(this.#o.home) } : {}), ...(this.#o.launch ? { launch: this.#o.launch } : {}),
    });
    s.commits = marksCommit(plan);
    this.sessions.set(id, s);
    if (own) this.#profileUser = id;
    this.#follow(s, red);
    const stop = () => { void s.close(signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'the task ran out of time' : 'the task was stopped'); };
    signal.addEventListener('abort', stop, { once: true });
    const dir = taskDir(this.#o.home, id);
    const run: Run = {
      id, s, plan, red, reads: [], records: [], learnt: [], flow: null, checkout: null, dialogs: new Set(), blocked: 0, upsells: new Map(), copilot: { asked: 0, answered: 0 },
    };
    if (plan.flow && this.#w) {
      const t = this.#w.templates.version(flowTemplateId(plan.flow.site, plan.flow.name), plan.flow.version);
      if (t) { run.flow = { template: t, steps: stepsOf(t) }; this.#w.templates.use(t.template_id, t.version); }
    }
    let personSteps = 0;
    try {
      await s.open();
      for (const [i, step] of plan.steps.entries()) {
        await s.gate();
        s.step = { n: i + 1, of: plan.steps.length, what: red.text(describe(step)) };
        s.emit('change');
        this.#note(id, 'step', s.step);
        if (step.do === 'person') personSteps++;
        if ('commits' in step && step.commits) this.#committing(id, describe(step));
        const rec: StepRec = { n: i + 1, do: step.do, what: red.text(describe(step)) };
        run.records.push(rec);
        await this.#step(run, i, step, rec);
        await this.#after(run, i, step);
        rec.url = s.url;
      }
      // Nothing more happens while the person has the browser, not even the screenshot.
      await s.gate();
      s.mode = 'finishing';
      s.step = null;
      s.emit('change');
      mkdirSync(dir, { recursive: true });
      // Saved values never reach a picture or a read: masked on the page first.
      if (red.size) await s.evaluate<number>(`(${MASK}).call(null, ${JSON.stringify(red.values())})`).catch(() => 0);
      const png = await s.screenshot();
      writeFileSync(join(dir, SCREENSHOT), png);
      const finalUrl = s.url;
      const verifyUrl = plan.verify?.url ?? finalUrl;
      const record: FinalRead = { task_id: id, url: verifyUrl, final_url: finalUrl, at: this.#now().toISOString(), reads: [] };
      // Read afresh, two ways: Nova fetches the page again itself, and reads the final DOM.
      if (allowed(verifyUrl, plan.allowed_hosts)) record.reads.push(await refetch(verifyUrl, plan.allowed_hosts));
      if (verifyUrl === finalUrl) {
        const dom: Read = { source: 'dom', url: finalUrl, text: '' };
        try { dom.text = await s.text(); } catch (e) { dom.error = (e as Error).message; }
        record.reads.push(dom);
      }
      writeFileSync(join(dir, FINAL_READ), JSON.stringify(red.value(record), null, 2));
      if (run.reads.length) writeFileSync(join(dir, 'reads.json'), JSON.stringify(red.value(run.reads), null, 2));
      writeFileSync(join(dir, 'steps.json'), JSON.stringify(red.value(run.records), null, 2));
      if (run.checkout) writeFileSync(join(dir, 'checkout.json'), JSON.stringify(red.value({ ...run.checkout, stopped_before: 'pay', pay_pressed: false }), null, 2));
      if (plan.learn) writeFileSync(join(dir, 'flow.json'), JSON.stringify({ host: plan.flow?.site ?? this.#siteOf(plan), name: plan.learn, steps: run.learnt }, null, 2));
      const evidence: Evidence[] = [{ kind: 'screenshot', ref: refOf(id, SCREENSHOT) }];
      if (/^https?:/.test(verifyUrl)) evidence.push({ kind: 'url', url: verifyUrl });
      // What the pages and the person were refused; the browser's own calls home are in the
      // task's record but not worth a line here.
      const blocked = [...s.blocked.values()].filter((b) => b.via !== 'proxy');
      const host = (() => { try { return new URL(finalUrl).host; } catch { return finalUrl; } })();
      const vision = run.records.filter((r) => r.via === 'vision').length;
      const summary = [
        `Went through ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} on ${host}${personSteps ? `; you did ${personSteps === 1 ? 'one' : personSteps} of them` : ''}.`,
        run.checkout ? `Stopped at the checkout: ${run.checkout.lines.length} line${run.checkout.lines.length === 1 ? '' : 's'}, total ${showMoney(run.checkout.total, run.checkout.currency)}${run.checkout.quoted !== null ? ', as quoted' : ''}. Paying is yours: Nova never presses pay.` : '',
        run.flow ? `Followed the flow “${plan.flow!.name}” v${plan.flow!.version}, checking each step.` : '',
        run.blocked ? `Blocked ${run.blocked === 1 ? 'a dialog' : `${run.blocked} dialogs`} that tried to give instructions; nothing in ${run.blocked === 1 ? 'it' : 'them'} was followed.` : '',
        [...run.upsells.values()].length ? `Flagged ${run.upsells.size === 1 ? 'an extra' : `${run.upsells.size} extras`} already ticked for you.` : '',
        vision ? `${vision === 1 ? 'One step' : `${vision} steps`} found ${vision === 1 ? 'its' : 'their'} element by picture, as a fallback.` : '',
        blocked.length ? `Refused ${blocked.length} host${blocked.length === 1 ? '' : 's'} the task didn’t declare: ${blocked.map((b) => b.host).join(', ')}.` : '',
      ].filter(Boolean).join(' ');
      return report('done', summary, {
        evidence,
        artifacts: [
          { kind: 'screenshot', ref: refOf(id, SCREENSHOT), sha256: createHash('sha256').update(png).digest('hex') },
          { kind: 'final-read', ref: refOf(id, FINAL_READ) },
          { kind: 'steps', ref: refOf(id, 'steps.json') },
          ...(run.reads.length ? [{ kind: 'reads', ref: refOf(id, 'reads.json') }] : []),
          ...(run.checkout ? [{ kind: 'checkout', ref: refOf(id, 'checkout.json') }] : []),
        ],
      });
    } catch (e) {
      // A cancel or a timeout is the ledger's to record. When Nova stops, nothing is recorded:
      // the task is still running as far as the ledger knows, and the next start runs it again.
      if (this.#stopping) return new Promise<never>(() => {});
      if (signal.aborted) throw signal.reason;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'steps.json'), JSON.stringify(red.value(run.records), null, 2));
        if (run.checkout) writeFileSync(join(dir, 'checkout.json'), JSON.stringify(red.value({ ...run.checkout, stopped_before: 'pay', pay_pressed: false }), null, 2));
      } catch { /* the failure is what counts */ }
      return report('failed', (e as Error).message, { blockers: [...s.blocked.keys()].map((h) => `Refused ${h}`) });
    } finally {
      signal.removeEventListener('abort', stop);
      await s.close();
      if (this.sessions.get(id) === s) this.sessions.delete(id);
      if (this.#profileUser === id) this.#profileUser = null;
    }
  }

  #siteOf(plan: Plan): string {
    const nav = plan.steps.find((x) => x.do === 'navigate') as { url: string } | undefined;
    try { return new URL(nav?.url ?? `http://${plan.allowed_hosts[0]}`).host; } catch { return plan.allowed_hosts[0]!; }
  }

  // ---- one step ------------------------------------------------------------------------------

  async #step(run: Run, i: number, step: Step, rec: StepRec): Promise<void> {
    const { s, plan, red } = run;
    const id = s.taskId;
    switch (step.do) {
      case 'navigate':
        if (!allowed(step.url, plan.allowed_hosts)) {
          s.refusedByPlan(step.url);
          throw new Error(`The plan asked to open ${hostOf(step.url)}, which this task may not reach.`);
        }
        await s.navigate(step.url);
        if (plan.profile !== 'fresh') { try { this.#touch(siteHost(new URL(s.url).host)); } catch { /* not a site */ } }
        return;
      case 'fill':
      case 'select':
      case 'click': {
        const loc = locOf(step);
        rec.via = loc.selector ? 'dom' : 'a11y';
        const at = await this.#find(s, loc, step.timeout_ms, step.do === 'click' ? step : null);
        if (at) { rec.via = 'vision'; rec.fallback = true; await this.#visionClick(run, i, step, at); return; }
        const el = await this.#element(s, loc);
        await this.#before(run, i, step, el);
        if (step.do === 'click') {
          const why = el ? isPayControl(el) : null;
          if (why) {
            this.#note(id, 'pay_refused', { step: i + 1, why: clip(red.text(why), 80) });
            throw new Stop(`Nova stopped before ${whereOf(step)}: it is a pay control (${red.text(why)}). ${PAY_REFUSAL}`);
          }
        }
        const fn = step.do === 'fill' ? FILL : step.do === 'select' ? SELECT : CLICK;
        const r = await this.#act(s, loc, fn, step.do === 'click' ? [] : [step.value]);
        if (r === 'covered') throw new Stop(`Something on the page covers ${whereOf(step)}; Nova won’t click through it.${run.blocked ? ' A dialog Nova blocked is open.' : ''}`);
        if (r !== 'ok') throw new Error(stepProblem(step, r));
        if (step.do === 'click') await s.settle();
        return;
      }
      case 'wait':
        await this.#find(s, { selector: step.selector }, step.timeout_ms, null);
        return;
      case 'read': {
        await this.#find(s, { selector: step.selector }, step.timeout_ms, null);
        await s.gate();
        // Page text is data: it is kept and compared, never followed.
        const raw = await s.evaluate<string>(`(() => { const el = document.querySelector(${sel(step.selector)}); return el ? (el.innerText ?? el.textContent ?? '') : ''; })()`);
        const text = red.text(raw);
        run.reads.push({ selector: step.selector, text: clip(text, 2000), screen: await screenRead(this.#o.screen, text, s.url) });
        if (step.expect && !squash(raw).includes(squash(step.expect))) throw new Error(`${step.selector} reads “${clip(squash(text), 80)}”, not “${step.expect}”.`);
        return;
      }
      case 'person':
        for (let round = 0; ; round++) {
          const why = round === 0 ? step.why : `That step isn’t finished yet. ${step.why}`;
          await this.#askPerson(s, why);
          if (!step.done_when) return;
          await s.settle(5000);
          if (await s.evaluate<boolean>(`!!document.querySelector(${sel(step.done_when)})`).catch(() => false)) return;
          if (round >= 4) throw new Error(`The step for a person still isn’t done after ${round + 1} hand-backs: ${step.why}`);
        }
      case 'login':
        await this.#login(run, i, step);
        return;
      case 'checkout':
        await this.#checkout(run, i, step);
        return;
    }
  }

  // The sign-in saved for the host the page is on now, typed into the named fields, then sent.
  async #login(run: Run, i: number, step: Extract<Step, { do: 'login' }>): Promise<void> {
    const { s, red } = run;
    const w = this.#wired();
    let url: URL;
    try { url = new URL(s.url); } catch { throw new Stop('The browser isn’t on a page to sign in to.'); }
    if (url.protocol !== 'https:' && hostEgress(url.host) === 'remote') throw new Stop(`${url.host} isn’t on https: Nova never sends a saved sign-in over plain http to another machine.`);
    let site: string;
    try { site = siteHost(url.host); } catch { throw new Stop('Nova can’t tell which site this page is.'); }
    const user = w.vault.get(loginName(site, 'username'));
    const pass = w.vault.get(loginName(site, 'password'));
    if (!user || !pass) throw new Stop(`There is no sign-in saved for ${site}. Save one in Settings › Connections › Site sign-ins (never in chat), then try again.`);
    red.add(user);
    red.add(pass);
    for (const f of [step.username, step.password, step.submit]) await this.#find(s, { selector: f }, step.timeout_ms, null);
    await this.#before(run, i, step, await this.#element(s, { selector: step.submit }));
    for (const [field, value, part] of [[step.username, user, 'username'], [step.password, pass, 'password']] as const) {
      const r = await s.actOn<string>({ selector: field }, SECRET, [value, url.host, part]);
      if (r === 'wrong-host') throw new Stop('The page moved to another site before Nova signed in; it typed nothing.');
      if (r !== 'ok') throw new Stop(`${field} isn’t a ${part} field Nova will type a saved sign-in into (${r}).`);
    }
    this.#note(run.id, 'signed_in_with', { step: i + 1, site, fields: 2 });
    const submit = await this.#element(s, { selector: step.submit });
    const why = submit ? isPayControl(submit) : null;
    if (why) throw new Stop(`The sign-in button is a pay control (${why}). ${PAY_REFUSAL}`);
    const r = await this.#act(s, { selector: step.submit }, CLICK, []);
    if (r === 'covered') throw new Stop(`Something on the page covers ${step.submit}; Nova won’t click through it.`);
    if (r !== 'ok') throw new Error(stepProblem({ do: 'click', selector: step.submit }, r));
    await s.settle();
    if (step.done_when) await this.#find(s, { selector: step.done_when }, step.timeout_ms ?? 10_000, null).catch(() => { throw new Stop(`The sign-in didn’t go through: ${step.done_when} isn’t on the page.`); });
  }

  // The itemised lines and the total, checked; then Nova stops. The pay control is found, so that the
  // browser refuses whatever its form would send, and never clicked.
  async #checkout(run: Run, i: number, step: Extract<Step, { do: 'checkout' }>): Promise<void> {
    const { s, red } = run;
    await this.#find(s, { selector: step.total }, step.timeout_ms, null);
    await this.#find(s, { selector: step.lines }, step.timeout_ms, null);
    const pay = await this.#element(s, { selector: step.pay });
    if (!pay) throw new Stop(`Nova can’t find the pay control (${step.pay}) on the checkout page, so it can’t be sure what pays: it stopped.`);
    if (pay.formAction) s.addPayTarget(pay.formAction);
    await this.#before(run, i, step, null);
    const read = await s.evaluate<{ lines: string[]; total: string } | null>(`(${CHECKOUT_READ}).call(null, ${sel(step.lines)}, ${sel(step.total)})`).catch(() => null);
    if (!read || !Array.isArray(read.lines)) throw new Stop('Nova couldn’t read the checkout.');
    const t = checkTotals({ lines: read.lines.map((l) => red.text(l)), total: red.text(read.total), quoted: step.quoted ?? null });
    run.checkout = { ...t, lines: t.lines.map((l) => ({ text: clip(l.text, 200), cents: l.cents })), url: s.url };
    if (!t.ok) {
      this.#note(run.id, 'total_mismatch', { step: i + 1, total: showMoney(t.total, t.currency), lines_add_up_to: showMoney(t.sum, t.currency), quoted: t.quoted === null ? null : showMoney(t.quoted, t.currency) });
      throw new Stop(`Nova stopped at the checkout: ${t.problems.join(' ')} Nothing was paid.`);
    }
    this.#note(run.id, 'checkout_reached', { step: i + 1, lines: t.lines.length, total: showMoney(t.total, t.currency), quoted: t.quoted === null ? null : showMoney(t.quoted, t.currency), pay_pressed: false });
  }

  // ---- the co-pilot and the ground truth ---------------------------------------------------------

  // Before an acting step: the element, obstacles, extras ticked for the person, dialogs.
  async #before(run: Run, i: number, step: Step, el: ElementFacts | null): Promise<void> {
    await this.#check(run, i, step, 'before', el);
  }

  async #after(run: Run, i: number, step: Step): Promise<void> {
    if (step.do === 'person' || step.do === 'read' || step.do === 'wait') {
      await this.#dialogsOf(run, null);
      if (run.flow || run.plan.learn) await this.#flowStep(run, i, step, await this.#facts(run.s));
      return;
    }
    await this.#check(run, i, step, 'after', null);
  }

  async #facts(s: Session): Promise<PageFacts | null> {
    const f = await s.evaluate<PageFacts | string | null>(`(${PAGE_FACTS}).call(null)`).catch(() => null);
    return f && typeof f === 'object' && typeof f.url === 'string' ? f : null;
  }

  async #element(s: Session, loc: Locator): Promise<ElementFacts | null> {
    const f = loc.selector
      ? await s.evaluate<ElementFacts | string | null>(`(${ELEMENT_FACTS}).call(document.querySelector(${sel(loc.selector)}))`).catch(() => null)
      : await s.inspect<ElementFacts | null>(loc, ELEMENT_FACTS).catch(() => null);
    return f && typeof f === 'object' && typeof f.tag === 'string' ? f : null;
  }

  // Every dialog the page opened (alert, confirm, prompt) or shows (role=dialog), screened. One that
  // tries to give instructions is blocked: recorded, never followed, never clicked in.
  async #dialogsOf(run: Run, facts: PageFacts | null): Promise<{ injection: boolean | null; extract: string }> {
    const { s, red } = run;
    const all = [...s.takeDialogs().map((d) => ({ kind: `js-${d.type}`, text: d.message })), ...(facts?.dialogs ?? []).map((d) => ({ kind: 'page', text: d.text }))];
    if (!all.length) return { injection: null, extract: '' };
    let injection = false;
    const extracts: string[] = [];
    for (const d of all) {
      const text = red.text(d.text);
      const key = createHash('sha256').update(`${d.kind}\0${text}`).digest('hex');
      const r = await this.#screen(text, s.url);
      const bad = r === null || r.verdict === 'block' || r.flags.some((f) => INSTRUCTING.has(f.kind));
      if (bad) injection = true;
      extracts.push(bad || !r ? 'Nova blocked this dialog: it looked like it was trying to give instructions.' : r.extract);
      if (run.dialogs.has(key)) continue;
      run.dialogs.add(key);
      if (bad) {
        run.blocked++;
        this.#note(run.id, 'dialog_blocked', { kind: d.kind, screen: r?.id ?? null, verdict: r?.verdict ?? 'block', flags: r?.flags.filter((f) => f.level !== 'note').map((f) => f.kind) ?? [], what: 'A dialog on the page looked like it was trying to give instructions. Nova didn’t follow it or click anything in it.' });
      } else {
        this.#note(run.id, 'dialog_seen', { kind: d.kind, screen: r.id, verdict: r.verdict });
      }
    }
    return { injection, extract: extracts.join('\n\n') };
  }

  async #screen(text: string, url: string): Promise<Screened | null> {
    if (!this.#w) return null;
    try { return await this.#w.screen(text, hostOf(url), url); } catch { return null; }
  }

  async #check(run: Run, i: number, step: Step, phase: 'before' | 'after', el: ElementFacts | null): Promise<void> {
    const { s, plan, red } = run;
    let facts = await this.#facts(s);
    if (facts) this.#payForms(s, facts);
    const dialog = await this.#dialogsOf(run, facts);
    // A sign-in form is a wall only when the plan doesn't fill it in itself: no sign-in or fill
    // step follows.
    const loginNext = (step.do === 'login' && phase === 'before') || ((step.do === 'fill' || step.do === 'select') && phase === 'before') || plan.steps.slice(i + 1).some((x) => x.do === 'login' || x.do === 'fill');
    const ob = facts ? obstacles(facts, { loginNext }) : { kind: null, why: '' };
    const extras = facts && (phase === 'before' || step.do === 'navigate') ? upsells(facts.ticked) : [];
    const truth: Record<CopilotQuestion, boolean | null> = {
      element_matches_intent: phase === 'before' && el ? ('target' in step && step.target ? true : 'intent' in step && step.intent ? intentMatches(step.intent, el.name) : null) : null,
      page_changed_as_expected: phase === 'after' ? await this.#expected(s, step, facts) : null,
      obstacle: facts ? ob.kind !== null : null,
      dark_pattern: facts && (phase === 'before' || step.do === 'navigate') ? extras.length > 0 : null,
      total_matches: phase === 'after' && step.do === 'checkout' && run.checkout ? run.checkout.ok : null,
      dialog_injection: dialog.injection,
    };
    const p = await this.#consult(run, phase, step, el, facts, dialog.extract);
    const checks: Record<string, { truth: boolean | null; p: number | null; by: string; answer: boolean | null }> = {};
    const disagree: CopilotQuestion[] = [];
    const modelSays: CopilotQuestion[] = [];
    for (const q of COPILOT_QUESTIONS) {
      const pq = p && typeof p[q] === 'number' ? p[q]! : null;
      if (truth[q] === null && pq === null) continue;
      const j = judge(truth[q], pq);
      checks[q] = { truth: truth[q], p: pq, by: j.by, answer: j.answer };
      if (j.disagree) disagree.push(q);
      else if (j.by === 'co-pilot' && j.answer === BAD[q]) modelSays.push(q);
    }
    if (Object.keys(checks).length) this.#note(run.id, 'copilot', { step: i + 1, phase, model: p !== null, checks });
    if (disagree.length) throw new Stop(`Nova’s own check and its co-pilot disagree about ${disagree.map((q) => QUESTION_WORDS[q]).join(' and ')}, so it stopped this step to be safe. The page itself says ${disagree.map((q) => (truth[q] ? 'yes' : 'no')).join(', ')}.`);
    if (truth.element_matches_intent === false) throw new Stop(`${whereOf(step)} doesn’t look like what the step means to do (“${'intent' in step ? step.intent : ''}”): Nova stopped instead of guessing.`);
    if (truth.page_changed_as_expected === false) throw new Stop(`After “${red.text(describe(step))}”, the page isn’t where the plan expected${'expect' in step && step.expect && typeof step.expect === 'object' ? ` (${[step.expect.url ? `an address with ${step.expect.url}` : '', step.expect.shows ? `${step.expect.shows} showing` : ''].filter(Boolean).join(', ')})` : ''}: Nova stopped.`);
    // Obstacles: a CAPTCHA or a sign-in Nova can't do is the person's; a paywall stops.
    for (let round = 0; facts && ob.kind && round < 5; round++) {
      if (ob.kind === 'paywall') throw new Stop(ob.why);
      this.#note(run.id, ob.kind === 'captcha' ? 'captcha_found' : 'login_wall', { step: i + 1 });
      await this.#askPerson(s, ob.why);
      await s.settle(5000);
      facts = await this.#facts(s);
      const again = facts ? obstacles(facts, { loginNext }) : { kind: null, why: '' };
      if (!again.kind) break;
      if (round === 4) throw new Stop(`${again.why} It is still there after five hand-backs.`);
    }
    // An extra ticked for the person: flagged, and theirs to keep or untick.
    for (const x of extras) {
      // Kept once is the person's answer for it; untick it and have it ticked again on a later
      // page, and they are asked again.
      if (run.upsells.get(x.label) === 'kept') continue;
      run.upsells.set(x.label, 'flagged');
      const amount = x.cents !== null ? showMoney(x.cents) : null;
      this.#note(run.id, 'upsell_flagged', { step: i + 1, adds: amount, what: amount ? `A box on the page was already ticked for you, and it adds ${amount}.` : 'A box on the page was already ticked for you.' });
      await this.#askPerson(s, `A box on this page was already ticked for you${amount ? ` and adds ${amount}` : ''}. Nova won’t keep or untick it for you: take over and untick it if you don’t want it, then hand back.`);
      const now = await this.#facts(s);
      const still = now ? upsells(now.ticked).some((y) => y.label === x.label) : true;
      run.upsells.set(x.label, still ? 'kept' : 'declined');
      this.#note(run.id, still ? 'upsell_kept' : 'upsell_declined', { step: i + 1, adds: amount });
    }
    // Only the model saw a problem, and it is sure: the person decides.
    if (modelSays.length) {
      await this.#askPerson(s, `Nova’s co-pilot is fairly sure something is wrong here (${modelSays.map((q) => QUESTION_WORDS[q]).join('; ')}), and the page itself doesn’t say. Have a look, then hand back to carry on, or stop the task.`);
    }
    if (phase === 'after' && (run.flow || plan.learn)) await this.#flowStep(run, i, step, facts, ob.kind !== null);
  }

  // Where the step should have left the page: the step's `expect`; a navigate's own address.
  async #expected(s: Session, step: Step, facts: PageFacts | null): Promise<boolean | null> {
    // A navigate landed on the host it was sent to (a redirect inside it is fine), as the page
    // itself says.
    if (step.do === 'navigate') {
      if (!facts) return null;
      try { return new URL(facts.url).host === new URL(step.url).host; } catch { return false; }
    }
    const e = 'expect' in step && step.expect && typeof step.expect === 'object' ? step.expect : null;
    if (!e) return null;
    const deadline = Date.now() + 5000;
    for (;;) {
      const urlOk = !e.url || s.url.includes(e.url);
      const shows = !e.shows || await s.evaluate<boolean>(`!!document.querySelector(${sel(e.shows)})`).catch(() => false);
      if (urlOk && shows) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // The local model's six answers, asked only with screened extracts: never raw page text, never a
  // saved value. Null when there is no local sorting model, or it didn't answer in the schema.
  async #consult(run: Run, phase: 'before' | 'after', step: Step, el: ElementFacts | null, facts: PageFacts | null, dialog: string): Promise<Record<string, number> | null> {
    const w = this.#w;
    if (!w) return null;
    let ready = false;
    try { ready = w.copilotReady(); } catch { ready = false; }
    if (!ready) return null;
    const { s, red } = run;
    run.copilot.asked++;
    const screened = async (t: string) => {
      const text = red.text(t).slice(0, 3000);
      if (!text.trim()) return '';
      const r = await this.#screen(text, s.url);
      return r ? red.text(r.extract) : 'Nova couldn’t screen this, so it isn’t shown.';
    };
    const c = run.checkout;
    const inputs = {
      phase, step: red.text(describe(step)), intent: red.text('intent' in step && step.intent ? step.intent : ''),
      element: el ? await screened(el.name) : '', page: facts ? await screened(facts.text) : '', dialog: red.text(dialog),
      totals: c ? `Nova read ${c.lines.length} lines adding up to ${showMoney(c.sum, c.currency)}; the page’s total is ${showMoney(c.total, c.currency)}${c.quoted !== null ? `; the quote was ${showMoney(c.quoted, c.currency)}` : ''}.` : '',
    };
    try {
      const d = await w.decisions.decide(STEP_TEMPLATE.template_id, inputs, { privacy_mode: 'local-only' });
      if (!d || d.provider !== w.providerId || d.escalate) return null;
      run.copilot.answered++;
      return d.answers as Record<string, number>;
    } catch (e) {
      this.#o.log.warn('browser', 'The co-pilot didn’t answer; Nova’s own checks decide alone.', { task: run.id, error: (e as Error).message });
      return null;
    }
  }

  // A learnt flow's step re-checked through its template's rule; a flow being learnt records the
  // step and what the page was like after it.
  async #flowStep(run: Run, i: number, step: Step, facts: PageFacts | null, obstacle = false): Promise<void> {
    const path = facts?.path ?? (() => { try { return new URL(run.s.url).pathname; } catch { return ''; } })();
    const marker = markerOf(run.plan.steps[i + 1]);
    if (run.plan.learn) run.learnt.push({ step, path, marker });
    if (!run.flow || !this.#w) return;
    const want = run.flow.steps[i];
    if (!want) return;
    let seen = !want.marker;
    if (want.marker) {
      const deadline = Date.now() + 5000;
      while (!(seen = await run.s.evaluate<boolean>(`!!document.querySelector(${sel(want.marker)})`).catch(() => false)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
    }
    const t = run.flow.template;
    const d = this.#w.rules.evaluate(t, { step: i, action: JSON.stringify(want.step), expect_path: want.path, seen_path: path, expect_marker: want.marker, marker_seen: seen, obstacle });
    this.#note(run.id, d.answers.next === 'continue' ? 'flow_checked' : 'flow_stopped', { step: i + 1, template: t.template_id, version: t.version, why: d.why });
    if (d.answers.next !== 'continue') throw new Stop(`The site no longer matches the flow “${run.plan.flow!.name}” v${t.version} Nova learnt: ${d.why} It stopped.`);
  }

  // Where each form on the page sends, when it pays: the browser refuses it while Nova drives.
  #payForms(s: Session, facts: PageFacts): void {
    for (const f of facts.pay ?? []) {
      const pays = f.hasCard || f.buttons.some((b) => isPayControl({ ...b, formAction: f.action, formHasCard: f.hasCard }) !== null);
      if (pays) s.addPayTarget(f.action);
    }
  }

  #askPerson = async (s: Session, why: string): Promise<void> => {
    this.#ledger?.needsPerson(s.taskId, `Needs you: ${why}`);
    await s.needPerson(why);
    this.#ledger?.personDone(s.taskId, 'You handed back. Nova carries on from where you left the page.');
  };

  // ---- elements ---------------------------------------------------------------------------------

  // Waits for an element. The time the person holds the browser doesn't count against the step.
  // A click whose element neither the DOM nor the accessibility tree finds may fall back to vision,
  // when a locator is configured: the point it found is returned.
  async #find(s: Session, loc: Locator, timeoutMs = STEP_TIMEOUT_MS, click: Step | null): Promise<{ x: number; y: number } | null> {
    let deadline = Date.now() + timeoutMs;
    for (;;) {
      deadline += await s.gate();
      const found = loc.selector
        ? await s.evaluate<boolean>(`!!document.querySelector(${sel(loc.selector)})`).catch((e: Error) => {
          if (/not a valid selector|SyntaxError/i.test(e.message)) throw new Error(`${loc.selector} isn’t a selector Nova can use.`);
          return false;
        })
        : await s.exists(loc).catch(() => false);
      if (found) return null;
      if (Date.now() > deadline) {
        if (click && this.#o.locate) {
          const at = await this.#o.locate(await s.screenshot(), describe(click)).catch(() => null);
          if (at) return at;
        }
        throw new Error(`Nothing on ${hostOf(s.url)} matches ${loc.selector ?? (loc.target ? `the ${loc.target.role} “${loc.target.name}”` : '')}, after ${Math.round(timeoutMs / 1000)} s.`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Acts on an element: the DOM path for a selector (one expression, as in M5c), the accessibility
  // path for a target (the element itself, by its handle in Nova's world).
  #act(s: Session, loc: Locator, fn: string, args: unknown[]): Promise<string> {
    if (loc.selector) return s.act<string>(`(${fn}).apply(document.querySelector(${sel(loc.selector)}), ${JSON.stringify(args)})`);
    return s.actOn<string>(loc, fn, args);
  }

  // The vision fallback: the point is checked like any click (the element there must not pay), and
  // the step is marked as found by picture.
  async #visionClick(run: Run, i: number, step: Step, at: { x: number; y: number }): Promise<void> {
    const { s } = run;
    const el = await s.evaluate<ElementFacts | null>(`(${ELEMENT_FACTS}).call(document.elementFromPoint(${Number(at.x)}, ${Number(at.y)}))`).catch(() => null);
    await this.#before(run, i, step, el && typeof el === 'object' ? el : null);
    const why = el && typeof el === 'object' ? isPayControl(el) : null;
    if (why) throw new Stop(`Nova stopped: what the picture pointed at is a pay control (${why}). ${PAY_REFUSAL}`);
    this.#note(run.id, 'vision_fallback', { step: i + 1, why: 'Neither the page’s structure nor its accessibility tree had the element; it was found by picture.' });
    await s.clickAt(at.x, at.y);
    await s.settle();
  }

  // ---- learning a flow --------------------------------------------------------------------------

  // A verified task that asked to learn its flow: the next version of its site template, proposed,
  // dry-run and activated through the ledger (decide.ts).
  #learn(t: Task): void {
    const learn = (t.brief.inputs as { learn?: unknown } | undefined)?.learn;
    if (typeof learn !== 'string' || !this.#w || !this.#ledger) return;
    const w = this.#w;
    let raw: { host: string; name: string; steps: LearntStep[] };
    try { raw = JSON.parse(readFileSync(join(taskDir(this.#o.home, t.id), 'flow.json'), 'utf8')); } catch { return; }
    if (!Array.isArray(raw.steps) || !raw.steps.length) return;
    // A saved value is never learnt.
    const red = new Redactor();
    for (const n of w.vault.list(LOGIN_PREFIX)) red.add(w.vault.get(n));
    if (red.has(JSON.stringify(raw.steps))) {
      this.#note(t.id, 'flow_not_learnt', { why: 'A step holds a saved sign-in’s value, so Nova won’t keep it.' });
      return;
    }
    // Whatever was learnt must still be a plan Nova would run.
    try { validatePlan({ allowed_hosts: (t.brief.inputs as { allowed_hosts: string[] }).allowed_hosts, steps: raw.steps.map((x) => x.step) }, this.#hub()); } catch (e) {
      this.#note(t.id, 'flow_not_learnt', { why: e instanceof CoreError ? e.details.join('; ') : (e as Error).message });
      return;
    }
    const id = flowTemplateId(raw.host, learn);
    const version = Math.max(0, ...w.templates.list().filter((x) => x.template_id === id).map((x) => x.version)) + 1;
    w.templates.propose(flowDef(raw.host, learn, version), `browser:${t.id}`);
    const dry = w.templates.dryRun(id, version, dryRuns({ host: raw.host, name: learn, steps: raw.steps }));
    if (!dry.ok) {
      this.#note(t.id, 'flow_not_learnt', { why: dry.results.filter((r) => !r.ok).map((r) => r.why).join('; ') });
      return;
    }
    const task = w.templates.activate(id, version);
    this.#note(t.id, 'flow_learnt', { template_id: id, version, steps: raw.steps.length, activation_task: task.id });
  }

  // ---- the record --------------------------------------------------------------------------------

  // The session's moments, into the task's record and onto the event stream.
  #follow(s: Session, red: Redactor): void {
    const id = s.taskId;
    const by = (h: Holder) => ({ by: h.key, who: h.label });
    s.on('takeover_started', (e: { holder: Holder; requested: boolean; asked: string | null }) => {
      // The person may do anything with the page, the step that sends it included.
      if (s.commits) {
        try { this.#committing(id, `${e.holder.label} took over the browser`); } catch (err) { this.#o.log.warn('browser', 'Couldn’t record a takeover as the task’s commit point.', { task: id, detail: (err as Error).message }); }
      }
      this.#note(id, 'takeover_started', red.value({ ...by(e.holder), requested: e.requested, ...(e.asked ? { asked: e.asked } : {}), step: s.step?.n ?? null, url: s.url }));
    });
    s.on('takeover_ended', (e: { holder: Holder; duration_ms: number; how: string }) => {
      this.#note(id, 'takeover_ended', red.value({ ...by(e.holder), duration_ms: e.duration_ms, how: e.how, url: s.url }));
    });
    s.on('paused', (e: { holder: Holder }) => this.#note(id, 'paused', { ...by(e.holder), step: s.step?.n ?? null }));
    s.on('resumed', (e: { holder: Holder; duration_ms: number }) => this.#note(id, 'resumed', { ...by(e.holder), duration_ms: e.duration_ms }));
    s.on('blocked', (b: { host: string; by: string; via: string; kind: string }) => this.#note(id, 'blocked_request', b));
    s.on('pay_refused', (b: { host: string }) => this.#note(id, 'pay_refused', { host: b.host, why: 'A request that would pay was refused in the browser.' }));
    s.on('popup', () => this.#note(id, 'popup_closed', { reason: 'A page opened a second window; Nova closed it.' }));
    s.on('change', () => this.emit('change', s.view()));
  }

  // Written down before it happens; if it can't be, the step doesn't run.
  #committing(id: string, what: string): void {
    this.#ledger?.committing(id, what);
  }

  #note(id: string, kind: string, detail: unknown): void {
    try { this.#ledger?.note(id, kind, detail); } catch (e) { this.#o.log.warn('browser', `Couldn’t record ${kind} for a task.`, { task: id, detail: (e as Error).message }); }
  }

  async close(): Promise<void> {
    this.#stopping = true;
    await Promise.all([...this.sessions.values()].map((s) => s.close('Nova is stopping')));
  }
}

const locOf = (s: Step): Locator => ('target' in s && s.target ? { target: s.target } : { selector: (s as { selector: string }).selector });

function stepProblem(step: Step, code: string): string {
  const what = whereOf(step);
  switch (code) {
    case 'missing': return `${what} isn’t on the page any more.`;
    case 'disabled': return `${what} can’t be changed right now (it is disabled).`;
    case 'not-a-field': return `${what} isn’t a field Nova can type into.`;
    case 'not-a-list': return `${what} isn’t a list to choose from.`;
    case 'no-option': return `${what} has no choice “${'value' in step ? step.value : ''}”.`;
    default: return `${describe(step)} didn’t work (${code}).`;
  }
}

// What the person's device sends, checked: coordinates are fractions of the picture (0 to 1).
export function parseInput(b: Record<string, unknown>): Input {
  const num = (v: unknown, what: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new CoreError('validation', `${what} must be a number.`);
    return v;
  };
  switch (b.type) {
    case 'click': case 'move': return { type: b.type, x: num(b.x, 'x'), y: num(b.y, 'y') };
    case 'scroll': return { type: 'scroll', x: num(b.x, 'x'), y: num(b.y, 'y'), dx: num(b.dx ?? 0, 'dx'), dy: num(b.dy ?? 0, 'dy') };
    case 'text':
      if (typeof b.text !== 'string' || !b.text || b.text.length > 2000) throw new CoreError('validation', 'text must be 1 to 2000 characters.');
      return { type: 'text', text: b.text };
    case 'key':
      if (typeof b.key !== 'string' || !INPUT_KEYS.includes(b.key)) throw new CoreError('validation', `key must be one of ${INPUT_KEYS.map((k) => (k === ' ' ? 'Space' : k)).join(', ')}.`);
      return { type: 'key', key: b.key };
    default: throw new CoreError('validation', 'type must be click, move, scroll, text or key.');
  }
}
