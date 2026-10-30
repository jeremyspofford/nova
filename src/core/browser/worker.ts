// The browser worker (M5 plan §3): a ledger Worker whose briefs are step plans, run in a fresh
// Chromium held to the task's declared hosts, with takeover by the person. It keeps the live
// sessions, so the API can show them, hand them over and take them back.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Evidence, type Report } from '../envelope.ts';
import { Sse } from '../api.ts';
import type { Ledger, LanedWorker } from '../ledger.ts';
import type { Log } from '../log.ts';
import { findChromium, type Found } from './chromium.ts';
import { FINAL_READ, SCREENSHOT, refOf, refetch, squash, taskDir, type FinalRead, type Read } from './evidence.ts';
import { NO_HUB, allowed, describe, hostOf, planEgress, validatePlan, type Hub, type Plan, type Step } from './plan.ts';
import { INPUT_KEYS, Session, type Holder, type Input, type SessionView } from './session.ts';

export const BROWSER_WORKER = 'browser';
const STEP_TIMEOUT_MS = 15_000;

// `hub`: where Nova itself listens, which no browser task may reach (plan.ts).
export interface BrowserOptions { home: string; log: Log; now?: () => Date; env?: NodeJS.ProcessEnv; hub?: () => Hub }

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sel = (s: string) => JSON.stringify(s);

export class Browser extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  readonly worker: LanedWorker;
  #o: BrowserOptions;
  #now: () => Date;
  #ledger: Ledger | null = null;
  #stopping = false;

  constructor(o: BrowserOptions) {
    super();
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    const self = this;
    this.worker = {
      id: BROWSER_WORKER,
      name: 'Browser',
      about: 'Works through web pages in a browser of its own: opens, fills, clicks and reads, only on the hosts a task declares. You can take over at any time; it asks for you at a step only a person may do.',
      // The most it could reach; each task's own reach comes from its declared hosts.
      egress: 'remote',
      evidence: ['screenshot', 'url'],
      // A person may take a while over their step.
      timeoutMs: 60 * 60_000,
      lane: () => ({ key: 'browser', max: 2 }),
      egressFor: (brief: Brief) => planEgress(validatePlan(brief.inputs, self.#hub())),
      health: () => {
        const f = self.chromium();
        return { ok: f.path !== null || f.from === 'none', detail: f.path ? `${f.detail}${self.#sandbox() ? '' : ' Chromium’s own sandbox is off (NOVA_CHROMIUM_SANDBOX=0).'}` : f.detail };
      },
      run: (brief: Brief, signal: AbortSignal) => self.#run(brief, signal),
    };
  }

  bind(ledger: Ledger): void { this.#ledger = ledger; }

  chromium(): Found { return findChromium(this.#o.env ?? process.env); }

  #hub(): Hub {
    try { return this.#o.hub?.() ?? NO_HUB; } catch { return NO_HUB; }
  }

  #sandbox(): boolean {
    const env = this.#o.env ?? process.env;
    return env.NOVA_CHROMIUM_SANDBOX !== '0' && process.getuid?.() !== 0;
  }

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

  // ---- running a plan ------------------------------------------------------------------------

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = Date.now();
    const id = brief.task_id;
    const report = (status: Report['status'], summary: string, extra: Partial<Report> = {}): Report => ({
      envelope: ENVELOPE_VERSION, task_id: id, status, summary, evidence: [], artifacts: [], blockers: [], follow_up_suggestions: [],
      usage: { duration_ms: Date.now() - started }, ...extra,
    });
    let plan: Plan;
    try { plan = validatePlan(brief.inputs, this.#hub()); } catch (e) {
      return report('failed', `The browser plan can’t run: ${e instanceof CoreError ? e.details.join('; ') : (e as Error).message}`);
    }
    const found = this.chromium();
    if (!found.path) return report('failed', found.detail);

    this.sessions.get(id)?.close('replaced');
    const s = new Session({ taskId: id, chromium: found.path, hosts: plan.allowed_hosts, sandbox: this.#sandbox(), now: this.#now, hub: () => this.#hub() });
    this.sessions.set(id, s);
    this.#follow(s);
    const stop = () => { void s.close(signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'the task ran out of time' : 'the task was stopped'); };
    signal.addEventListener('abort', stop, { once: true });
    const dir = taskDir(this.#o.home, id);
    const reads: { selector: string; text: string }[] = [];
    let personSteps = 0;
    try {
      await s.open();
      for (const [i, step] of plan.steps.entries()) {
        await s.gate();
        s.step = { n: i + 1, of: plan.steps.length, what: describe(step) };
        s.emit('change');
        this.#note(id, 'step', s.step);
        if (step.do === 'person') personSteps++;
        await this.#step(s, step, plan, reads);
      }
      // Nothing more happens while the person has the browser, not even the screenshot.
      await s.gate();
      s.mode = 'finishing';
      s.step = null;
      s.emit('change');
      mkdirSync(dir, { recursive: true });
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
      writeFileSync(join(dir, FINAL_READ), JSON.stringify(record, null, 2));
      if (reads.length) writeFileSync(join(dir, 'reads.json'), JSON.stringify(reads, null, 2));
      const evidence: Evidence[] = [{ kind: 'screenshot', ref: refOf(id, SCREENSHOT) }];
      if (/^https?:/.test(verifyUrl)) evidence.push({ kind: 'url', url: verifyUrl });
      // What the pages and the person were refused; the browser's own calls home are in the
      // task's record but not worth a line here.
      const blocked = [...s.blocked.values()].filter((b) => b.via !== 'proxy');
      const host = (() => { try { return new URL(finalUrl).host; } catch { return finalUrl; } })();
      const summary = [
        `Went through ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} on ${host}${personSteps ? `; you did ${personSteps === 1 ? 'one' : personSteps} of them` : ''}.`,
        blocked.length ? `Refused ${blocked.length} host${blocked.length === 1 ? '' : 's'} the task didn’t declare: ${blocked.map((b) => b.host).join(', ')}.` : '',
      ].filter(Boolean).join(' ');
      return report('done', summary, {
        evidence,
        artifacts: [
          { kind: 'screenshot', ref: refOf(id, SCREENSHOT), sha256: createHash('sha256').update(png).digest('hex') },
          { kind: 'final-read', ref: refOf(id, FINAL_READ) },
          ...(reads.length ? [{ kind: 'reads', ref: refOf(id, 'reads.json') }] : []),
        ],
      });
    } catch (e) {
      // A cancel or a timeout is the ledger's to record. When Nova stops, nothing is recorded:
      // the task is still running as far as the ledger knows, and the next start runs it again.
      if (this.#stopping) return new Promise<never>(() => {});
      if (signal.aborted) throw signal.reason;
      return report('failed', (e as Error).message, { blockers: [...s.blocked.keys()].map((h) => `Refused ${h}`) });
    } finally {
      signal.removeEventListener('abort', stop);
      await s.close();
      if (this.sessions.get(id) === s) this.sessions.delete(id);
    }
  }

  async #step(s: Session, step: Step, plan: Plan, reads: { selector: string; text: string }[]): Promise<void> {
    const id = s.taskId;
    switch (step.do) {
      case 'navigate':
        if (!allowed(step.url, plan.allowed_hosts)) {
          s.refusedByPlan(step.url);
          throw new Error(`The plan asked to open ${hostOf(step.url)}, which this task may not reach.`);
        }
        await s.navigate(step.url);
        return;
      case 'fill':
      case 'select': {
        await this.#find(s, step.selector, step.timeout_ms);
        await s.gate();
        const r = await s.evaluate<string>(step.do === 'fill' ? fillJs(step.selector, step.value) : selectJs(step.selector, step.value));
        if (r !== 'ok') throw new Error(stepProblem(step, r));
        return;
      }
      case 'click': {
        await this.#find(s, step.selector, step.timeout_ms);
        await s.gate();
        const r = await s.evaluate<string>(`(() => { const el = document.querySelector(${sel(step.selector)}); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok'; })()`);
        if (r !== 'ok') throw new Error(stepProblem(step, r));
        await s.settle();
        return;
      }
      case 'wait':
        await this.#find(s, step.selector, step.timeout_ms);
        return;
      case 'read': {
        await this.#find(s, step.selector, step.timeout_ms);
        await s.gate();
        // Page text is data: it is kept and compared, never followed.
        const text = await s.evaluate<string>(`(() => { const el = document.querySelector(${sel(step.selector)}); return el ? (el.innerText ?? el.textContent ?? '') : ''; })()`);
        reads.push({ selector: step.selector, text: clip(text, 2000) });
        if (step.expect && !squash(text).includes(squash(step.expect))) throw new Error(`${step.selector} reads “${clip(squash(text), 80)}”, not “${step.expect}”.`);
        return;
      }
      case 'person':
        for (let round = 0; ; round++) {
          const why = round === 0 ? step.why : `That step isn’t finished yet. ${step.why}`;
          this.#ledger?.needsPerson(id, `Needs you: ${why}`);
          await s.needPerson(why);
          this.#ledger?.personDone(id, 'You handed back. Nova carries on from where you left the page.');
          if (!step.done_when) return;
          await s.settle(5000);
          if (await s.evaluate<boolean>(`!!document.querySelector(${sel(step.done_when)})`).catch(() => false)) return;
          if (round >= 4) throw new Error(`The step for a person still isn’t done after ${round + 1} hand-backs: ${step.why}`);
        }
    }
  }

  // Waits for a selector. The time the person holds the browser doesn't count against the step.
  async #find(s: Session, selector: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
    let deadline = Date.now() + timeoutMs;
    for (;;) {
      deadline += await s.gate();
      const found = await s.evaluate<boolean>(`!!document.querySelector(${sel(selector)})`).catch((e: Error) => {
        if (/not a valid selector|SyntaxError/i.test(e.message)) throw new Error(`${selector} isn’t a selector Nova can use.`);
        return false;
      });
      if (found) return;
      if (Date.now() > deadline) throw new Error(`Nothing on ${hostOf(s.url)} matches ${selector}, after ${Math.round(timeoutMs / 1000)} s.`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // The session's moments, into the task's record and onto the event stream.
  #follow(s: Session): void {
    const id = s.taskId;
    const by = (h: Holder) => ({ by: h.key, who: h.label });
    s.on('takeover_started', (e: { holder: Holder; requested: boolean; asked: string | null }) => {
      this.#note(id, 'takeover_started', { ...by(e.holder), requested: e.requested, ...(e.asked ? { asked: e.asked } : {}), step: s.step?.n ?? null, url: s.url });
    });
    s.on('takeover_ended', (e: { holder: Holder; duration_ms: number; how: string }) => {
      this.#note(id, 'takeover_ended', { ...by(e.holder), duration_ms: e.duration_ms, how: e.how, url: s.url });
    });
    s.on('blocked', (b: { host: string; by: string; via: string; kind: string }) => this.#note(id, 'blocked_request', b));
    s.on('popup', () => this.#note(id, 'popup_closed', { reason: 'A page opened a second window; Nova closed it.' }));
    s.on('change', () => this.emit('change', s.view()));
  }

  #note(id: string, kind: string, detail: unknown): void {
    try { this.#ledger?.note(id, kind, detail); } catch (e) { this.#o.log.warn('browser', `Couldn’t record ${kind} for a task.`, { task: id, detail: (e as Error).message }); }
  }

  async close(): Promise<void> {
    this.#stopping = true;
    await Promise.all([...this.sessions.values()].map((s) => s.close('Nova is stopping')));
  }
}

function fillJs(selector: string, value: string): string {
  return `(() => {
  const el = document.querySelector(${sel(selector)});
  if (!el) return 'missing';
  if (el.disabled || el.readOnly) return 'disabled';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  if (!proto) { if (el.isContentEditable) { el.focus(); el.textContent = ${sel(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; } return 'not-a-field'; }
  el.scrollIntoView({ block: 'center' });
  el.focus();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${sel(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;
}

function selectJs(selector: string, value: string): string {
  return `(() => {
  const el = document.querySelector(${sel(selector)});
  if (!el) return 'missing';
  if (!(el instanceof HTMLSelectElement)) return 'not-a-list';
  if (el.disabled) return 'disabled';
  const want = ${sel(value)};
  const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => o.text.trim() === want);
  if (!opt) return 'no-option';
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;
}

function stepProblem(step: Step, code: string): string {
  const what = 'selector' in step ? step.selector : '';
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
