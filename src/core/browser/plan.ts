// What a browser task is (M5 plan §3): a plan of steps (navigate, fill, click, select, wait, read,
// and a step a person must do), the hosts it may reach, and what the final page must show. The plan
// comes from the brief's inputs, chosen by a provider or written by hand; nothing a page says ever
// changes it. Pure, so it is unit-tested without a browser.
import { CoreError } from '../errors.ts';
import { CARD_FIELD, PAY_PATH, PAY_TOKENS, PAY_WORDS, looksLikeCard, parseMoney } from './copilot.ts';
import type { Egress } from '../workers.ts';

// `commits`: this is the step that makes the task's outside effect happen (sends the form, places
// the order). Nova writes it down before the step runs, so after a failure it knows whether that
// point was ever passed (ledger.ts, `commit_point`).
//
// Nova Browser (M10b) adds:
// - `target`: an element found by the accessibility tree, by its role and accessible name, beside
//   a CSS `selector` (DOM). One or the other.
// - `intent`: what the step means to do, in plain words; Nova checks the element against it.
// - `expect`: where the page must be after an acting step (a URL part, a selector that shows).
// - `login`: a sign-in from the vault, typed by the worker into the named fields at the moment of
//   use. The step names fields, never values.
// - `checkout`: reads the itemised lines and the total, checks them, and is where Nova stops: it
//   names the pay control so that nothing may ever click it.
export interface Target { role: string; name: string }
export interface Expect { url?: string; shows?: string }
interface Acting { selector?: string; target?: Target; intent?: string; expect?: Expect; label?: string; timeout_ms?: number; commits?: boolean }
export type Step =
  | { do: 'navigate'; url: string; label?: string; commits?: boolean }
  | ({ do: 'fill'; value: string } & Acting)
  | ({ do: 'click' } & Acting)
  | ({ do: 'select'; value: string } & Acting)
  | { do: 'wait'; selector: string; label?: string; timeout_ms?: number }
  | { do: 'read'; selector: string; expect?: string; label?: string; timeout_ms?: number }
  // A step only a person may do (a sign-in, a challenge): the worker asks for a takeover and
  // waits. `done_when`: a selector that shows on the page once the step is done.
  | { do: 'person'; why: string; done_when?: string; label?: string }
  | { do: 'login'; username: string; password: string; submit: string; done_when?: string; label?: string; timeout_ms?: number }
  | { do: 'checkout'; lines: string; total: string; pay: string; quoted?: string; label?: string; timeout_ms?: number };

export const STEP_KINDS = ['navigate', 'fill', 'click', 'select', 'wait', 'read', 'person', 'login', 'checkout'] as const;

// `profile`: Nova's own persistent profile (the default), or a throwaway one for this task alone.
// `learn`: the name a flow that ends verified is kept under, as a site template (flows.ts).
// `flow`: the learnt site template whose steps this plan is (expanded by the worker).
export interface Plan {
  allowed_hosts: string[];
  steps: Step[];
  // What the final page must show, checked by Nova itself (`url` evidence). `url`: the page to
  // fetch again, inside the allowed hosts; by default, the page the plan ended on.
  verify?: { url?: string; expect: string[] };
  profile?: 'nova' | 'fresh';
  learn?: string;
  flow?: { name: string; version: number; site: string };
}

const MAX_STEPS = 100;
const MAX_HOSTS = 20;
const isStr = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// "host", "host:port", "*.host" or "*.host:port"; lower case; IPv6 in brackets. Also the syntax of
// a Nova Computer workspace's declared hosts (computer/policy.ts).
export const HOST = /^(\*\.)?(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;

export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '');
}

// Where a URL goes: scheme, host (lower case, brackets kept for IPv6) and port (explicit or the
// scheme's default). Null for anything that isn't http(s) or ws(s).
export function target(url: string): { scheme: string; host: string; port: number } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'ws', 'wss'].includes(scheme)) return null;
  const port = u.port ? Number(u.port) : scheme === 'https' || scheme === 'wss' ? 443 : 80;
  return { scheme, host: normalizeHost(u.hostname), port };
}

// Whether the task's declared hosts let it reach this URL. A host without a port allows any port;
// "*.example.test" allows its subdomains (not itself).
export function allowed(url: string, hosts: readonly string[]): boolean {
  const t = target(url);
  if (!t) return false;
  return hosts.some((raw) => {
    const h = normalizeHost(raw);
    const m = (h.startsWith('[') ? /^(\[[^\]]+\])(?::(\d{1,5}))?$/ : /^([^:]+)(?::(\d{1,5}))?$/).exec(h);
    if (!m) return false;
    const name = m[1]!;
    const port = m[2] ? Number(m[2]) : null;
    if (port !== null && port !== t.port) return false;
    if (name.startsWith('*.')) return t.host.endsWith(name.slice(1)) && t.host !== name.slice(2);
    return t.host === name;
  });
}

// The host:port a URL reaches, for the record of what was blocked (no path or query: those can
// carry what a page tried to send).
export function hostOf(url: string): string {
  const t = target(url);
  if (!t) {
    try { return new URL(url).protocol.replace(/:$/, '') || 'unknown'; } catch { return 'unknown'; }
  }
  return `${t.host}:${t.port}`;
}

// ---- Nova itself -------------------------------------------------------------------------------
// The browser runs on the hub, so whatever it asks of the hub's own listeners comes from this
// machine, and loopback from this machine is the console. A browser task never reaches them,
// whatever it declares. `ports`: the console's and the mesh listener's; `hosts`: this machine's
// own addresses and names (its interfaces, its host name, the mesh address's name).
export interface Hub { ports: readonly number[]; hosts: readonly string[] }
export const NO_HUB: Hub = { ports: [], hosts: [] };

// A host as an address: no brackets, and an IPv4-mapped IPv6 address as the IPv4 one.
function bareHost(h: string): string {
  const b = normalizeHost(h).replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(b);
  if (mapped) {
    const n = (parseInt(mapped[1]!, 16) << 16 | parseInt(mapped[2]!, 16)) >>> 0;
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return b.replace(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/, '$1');
}

// Names and addresses that are always this machine, whatever the network says.
export function loopbackName(h: string): boolean {
  const b = bareHost(h);
  return b === 'localhost' || b.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b) || b === '::1' || b === '0.0.0.0' || b === '::';
}

export function thisMachine(host: string, hub: Hub): boolean {
  const b = bareHost(host.replace(/^\*\./, ''));
  return loopbackName(b) || hub.hosts.some((x) => bareHost(x) === b);
}

// Whether a URL would reach one of Nova's own listeners.
export function reachesHub(url: string, hub: Hub): boolean {
  const t = target(url);
  return !!t && hub.ports.includes(t.port) && thisMachine(t.host, hub);
}

export const HUB_REFUSAL = 'Nova’s own address: a browser task never reaches Nova itself.';

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

// Where a declared host's data would go: this machine and private or mesh addresses are local;
// anything else is remote, every name included, so local-only never reaches the internet by
// assumption.
export function hostEgress(raw: string): Egress {
  const h = normalizeHost(raw).replace(/^\*\./, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  // A name proves nothing about where it leads (a .local or .home.arpa name can be answered from
  // anywhere), so only addresses count, and localhost, which Chromium never looks up.
  if (h === 'localhost' || h.endsWith('.localhost')) return 'local';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return PRIVATE_V4.some((r) => r.test(h)) ? 'local' : 'remote';
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return 'local';
  return 'remote';
}

// Steps that can change something outside: typing into a page, choosing, clicking, signing in,
// and a step the person does by hand. A plan with any of them may have sent something by the time
// it fails.
const ACTING: readonly Step['do'][] = ['fill', 'select', 'click', 'person', 'login'];
export const hasEffects = (p: Pick<Plan, 'steps'>): boolean => p.steps.some((s) => ACTING.includes(s.do));
// Steps that send something on Nova's own initiative (typing, choosing, clicking, signing in):
// sending or sharing data outside asks first (NOVA-SPEC §6, tier 2). A person's own step is theirs.
export const sends = (p: Pick<Plan, 'steps'>): boolean => p.steps.some((s) => s.do === 'fill' || s.do === 'select' || s.do === 'click' || s.do === 'login');
// Whether the plan marks the step where its outside effect happens.
export const marksCommit = (p: Pick<Plan, 'steps'>): boolean => p.steps.some((s) => 'commits' in s && s.commits === true);
export const hasCheckout = (p: Pick<Plan, 'steps'>): boolean => p.steps.some((s) => s.do === 'checkout');
// The least tier a plan runs at: checkout (and so payment) is tier 3, always; sending is tier 2.
export const minTierOf = (p: Pick<Plan, 'steps'>): 0 | 2 | 3 => (hasCheckout(p) ? 3 : sends(p) ? 2 : 0);

export function planEgress(p: Plan): Egress {
  return p.allowed_hosts.some((h) => hostEgress(h) === 'remote') ? 'remote' : 'local';
}

export const PAY_REFUSAL = 'Paying is tier 3 and always yours: Nova fills the cart, shows the itemised total and stops. It never presses pay.';
export const FLOW_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function payPath(url: string): boolean {
  try { return PAY_PATH.test(new URL(url).pathname); } catch { return false; }
}

// A fill, select or click names its element by a CSS selector or by an accessibility target
// (role and accessible name), and may say what it means to do and where the page must be after.
function acting(s: Record<string, unknown>, at: string, need: (ok: boolean, msg: string) => boolean): void {
  const hasSel = s.selector !== undefined;
  const hasTarget = s.target !== undefined;
  if (!need(hasSel !== hasTarget, `${at} needs a selector or a target (role and name), one of them`)) return;
  if (hasSel) need(isStr(s.selector, 500), `${at}.selector must be a CSS selector`);
  if (hasTarget) need(isObj(s.target) && isStr(s.target.role, 40) && isStr(s.target.name, 200) && Object.keys(s.target).length === 2, `${at}.target must be {role, name}: the element’s accessibility role and accessible name`);
  if (s.intent !== undefined) need(isStr(s.intent, 200), `${at}.intent must say, in a few words, what the step means to do`);
  if (s.expect !== undefined) {
    const e = isObj(s.expect) ? s.expect : null;
    need(!!e && (e.url !== undefined || e.shows !== undefined) && (e.url === undefined || isStr(e.url, 500)) && (e.shows === undefined || isStr(e.shows, 500)) && Object.keys(e).every((k) => k === 'url' || k === 'shows'),
      `${at}.expect is {url?, shows?}: part of the address the page must be at after the step, and a selector that must show`);
  }
}

// The plan in a brief's inputs, checked; every problem is listed.
export function validatePlan(inputs: unknown, hub: Hub = NO_HUB): Plan {
  const errors: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); return ok; };
  const o = (typeof inputs === 'object' && inputs !== null ? inputs : {}) as Record<string, unknown>;
  const hosts = o.allowed_hosts;
  if (need(Array.isArray(hosts) && hosts.length > 0 && hosts.length <= MAX_HOSTS, `inputs.allowed_hosts must list the hosts this task may reach (1 to ${MAX_HOSTS})`)) {
    (hosts as unknown[]).forEach((h, i) => {
      if (!need(typeof h === 'string' && HOST.test(normalizeHost(h)), `inputs.allowed_hosts[${i}] must be a host name, host:port or *.host`)) return;
      const n = normalizeHost(h as string);
      const m = (n.startsWith('[') || n.startsWith('*.[') ? /^(.*\])(?::(\d{1,5}))?$/ : /^([^:]+)(?::(\d{1,5}))?$/).exec(n);
      if (!m || !thisMachine(m[1]!, hub)) return;
      // This machine without a port would take in Nova's own ports too, and Chromium sends
      // what it sends to a declared host straight there (WebSockets included, which no
      // interception sees), so the port must be named.
      if (need(m[2] !== undefined, `inputs.allowed_hosts[${i}] is this machine (${m[1]}): name the port, like ${m[1]}:8080. Nova’s own ports are never open to a browser task.`)) {
        need(!hub.ports.includes(Number(m[2])), `inputs.allowed_hosts[${i}] is ${HUB_REFUSAL}`);
      }
    });
  }
  const steps = o.steps;
  if (need(Array.isArray(steps) && steps.length > 0 && steps.length <= MAX_STEPS, `inputs.steps must be a list of 1 to ${MAX_STEPS} steps`)) {
    const list = steps as unknown[];
    const checkouts = list.map((raw, i) => ((raw as Record<string, unknown>)?.do === 'checkout' ? i : -1)).filter((i) => i >= 0);
    need(checkouts.length <= 1, 'inputs.steps may have one checkout step at most: it is where Nova stops');
    const at0 = checkouts[0] ?? -1;
    const paySel = at0 >= 0 ? (list[at0] as Record<string, unknown>).pay : undefined;
    list.forEach((raw, i) => {
      const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const at = `inputs.steps[${i}]`;
      if (!need(STEP_KINDS.includes(s.do as never), `${at}.do must be one of ${STEP_KINDS.join(', ')}`)) return;
      if (s.label !== undefined) need(isStr(s.label, 200), `${at}.label must be a short text`);
      if (s.commits !== undefined) need(typeof s.commits === 'boolean' && ['navigate', 'fill', 'select', 'click'].includes(s.do as string), `${at}.commits is true or false, on a navigate, fill, select or click step`);
      if (s.timeout_ms !== undefined) need(Number.isInteger(s.timeout_ms) && (s.timeout_ms as number) >= 100 && (s.timeout_ms as number) <= 600_000, `${at}.timeout_ms must be 100 to 600000`);
      // Nothing after the checkout but a read or a wait: it is where Nova stops.
      if (at0 >= 0 && i > at0) need(s.do === 'read' || s.do === 'wait', `${at} comes after the checkout step, where Nova stops: only a read or a wait may follow it`);
      switch (s.do) {
        case 'navigate':
          if (need(isStr(s.url), `${at}.url is required`)) {
            need(target(s.url as string)?.scheme === 'http' || target(s.url as string)?.scheme === 'https', `${at}.url must be an http(s) address`);
            if (Array.isArray(hosts)) need(allowed(s.url as string, hosts.filter((h): h is string => typeof h === 'string')), `${at}.url is outside the allowed hosts (${hostOf(s.url as string)})`);
            need(!reachesHub(s.url as string, hub), `${at}.url is ${HUB_REFUSAL}`);
            need(!payPath(s.url as string), `${at}.url is a pay address. ${PAY_REFUSAL}`);
          }
          break;
        case 'fill': case 'select': case 'click': {
          acting(s, at, need);
          if (s.do !== 'click') need(typeof s.value === 'string' && s.value.length <= 10_000, `${at}.value must be text`);
          const sel = typeof s.selector === 'string' ? s.selector : '';
          const name = isObj(s.target) && typeof s.target.name === 'string' ? s.target.name : '';
          if (s.do === 'click') {
            const words = [name, typeof s.label === 'string' ? s.label : '', typeof s.intent === 'string' ? s.intent : ''];
            need(!(sel && paySel !== undefined && sel.trim() === String(paySel).trim()), `${at} clicks the checkout’s pay control (${sel}). ${PAY_REFUSAL}`);
            need(!PAY_TOKENS.test(sel) && !words.some((w) => PAY_WORDS.test(w)), `${at} would pay or place an order. ${PAY_REFUSAL}`);
          } else {
            need(!CARD_FIELD.test(sel) && !CARD_FIELD.test(name), `${at} would type card details. Nova never types card details; paying is yours.`);
            need(!(typeof s.value === 'string' && looksLikeCard(s.value)), `${at}.value looks like a card number. Nova never types card details; paying is yours.`);
          }
          break;
        }
        case 'wait':
          need(isStr(s.selector, 500), `${at}.selector is required`);
          break;
        case 'read':
          need(isStr(s.selector, 500), `${at}.selector is required`);
          if (s.expect !== undefined) need(isStr(s.expect, 2000), `${at}.expect must be text`);
          break;
        case 'person':
          need(isStr(s.why, 500), `${at}.why must say, in plain words, what the person needs to do`);
          if (s.done_when !== undefined) need(isStr(s.done_when, 500), `${at}.done_when must be a selector`);
          break;
        case 'login':
          for (const k of ['username', 'password', 'submit'] as const) need(isStr(s[k], 500), `${at}.${k} must be the selector of the ${k === 'submit' ? 'sign-in button' : `${k} field`}`);
          need(!['value', 'values', 'username_value', 'password_value', 'secret', 'credentials'].some((k) => k in s), `${at} names the fields, never a value: the sign-in comes from the vault at the moment of use (save it in Settings › Connections, never in a plan or a chat)`);
          if (s.done_when !== undefined) need(isStr(s.done_when, 500), `${at}.done_when must be a selector`);
          break;
        case 'checkout':
          for (const k of ['lines', 'total'] as const) need(isStr(s[k], 500), `${at}.${k} must be the selector of the ${k === 'lines' ? 'itemised lines' : 'total'}`);
          need(isStr(s.pay, 500), `${at}.pay must be the selector of the pay control, so that nothing may click it`);
          if (s.quoted !== undefined) need((typeof s.quoted === 'string' || typeof s.quoted === 'number') && parseMoney(String(s.quoted)) !== null, `${at}.quoted must be the price quoted, like "12.50"`);
          break;
      }
    });
  }
  if (o.profile !== undefined) need(o.profile === 'nova' || o.profile === 'fresh', 'inputs.profile is "nova" (Nova’s own browser profile, the default) or "fresh" (a throwaway one)');
  if (o.learn !== undefined) need(typeof o.learn === 'string' && FLOW_NAME.test(o.learn), 'inputs.learn must be a short name for the flow: lowercase letters, digits and dashes');
  if (o.verify !== undefined) {
    const v = (typeof o.verify === 'object' && o.verify !== null ? o.verify : {}) as Record<string, unknown>;
    need(Array.isArray(v.expect) && v.expect.length > 0 && v.expect.length <= 20 && v.expect.every((x) => isStr(x, 2000)), 'inputs.verify.expect must list the text the final page must show');
    if (v.url !== undefined && need(isStr(v.url), 'inputs.verify.url must be an address') && Array.isArray(hosts)) {
      need(allowed(v.url as string, hosts.filter((h): h is string => typeof h === 'string')), `inputs.verify.url is outside the allowed hosts (${hostOf(v.url as string)})`);
      need(!reachesHub(v.url as string, hub), `inputs.verify.url is ${HUB_REFUSAL}`);
    }
  }
  if (errors.length) throw new CoreError('validation', 'This browser plan can’t run.', errors);
  const list2 = (steps as Step[]).map((x) => ('quoted' in x && typeof x.quoted === 'number' ? { ...x, quoted: String(x.quoted) } : x)) as Step[];
  return {
    allowed_hosts: (hosts as string[]).map(normalizeHost), steps: list2, ...(o.verify ? { verify: o.verify as Plan['verify'] } : {}),
    profile: o.profile === 'fresh' ? 'fresh' : 'nova',
    ...(typeof o.learn === 'string' ? { learn: o.learn } : {}),
    ...(isObj(o.flow) ? { flow: o.flow as Plan['flow'] } : {}),
  };
}

// Whether what the brief asks for can prove the plan done. A `url` requirement is proven by
// what the page shows, so it needs `verify.expect`. A plan with outside effects must be proven by
// Nova's own read of a page the plan names (`verify.url`): a screenshot can't show a form arrived,
// and the page the plan ends on is the page's to choose.
export function checkProof(plan: Plan, required: readonly { kind: string }[]): string[] {
  const out: string[] = [];
  const wantsUrl = required.some((r) => r?.kind === 'url');
  if (wantsUrl && !plan.verify) out.push('A url requirement can’t be proven without inputs.verify.expect: the text the final page must show.');
  if (hasEffects(plan)) {
    if (!wantsUrl) out.push('This plan types, chooses, clicks or hands the page to you, so add {kind: "url"} to evidence_required: a screenshot alone can’t show it happened.');
    if (!plan.verify?.url) out.push('inputs.verify.url must name the page that shows it happened (Nova fetches it again itself, inside the allowed hosts), with inputs.verify.expect saying what it must show.');
  }
  return out;
}

// The plan in a brief, checked, and whether the brief can prove it done; every problem is listed.
export function validateBrowserBrief(brief: { inputs?: unknown; evidence_required?: readonly { kind: string }[] }, hub: Hub = NO_HUB): Plan {
  const plan = validatePlan(brief.inputs, hub);
  const problems = checkProof(plan, brief.evidence_required ?? []);
  if (problems.length) throw new CoreError('validation', 'This browser plan can’t be proven done.', problems);
  return plan;
}

// One step in plain words, for progress and the ledger.
export function describe(s: Step): string {
  if (s.label) return s.label;
  switch (s.do) {
    case 'navigate': { const t = target(s.url); return `Open ${t ? `${t.host}${new URL(s.url).pathname}` : s.url}`; }
    case 'fill': return `Fill in ${whereOf(s)}`;
    case 'select': return `Choose “${s.value}” in ${whereOf(s)}`;
    case 'click': return `Click ${whereOf(s)}`;
    case 'wait': return `Wait for ${s.selector}`;
    case 'read': return `Read ${s.selector}`;
    case 'person': return s.why;
    case 'login': return 'Sign in with the saved sign-in for this site';
    case 'checkout': return 'Read the itemised total, and stop before paying';
  }
}

// Where an acting step's element is, in words.
export function whereOf(s: Step): string {
  if ('target' in s && s.target) return `the ${s.target.role} “${s.target.name}”`;
  if ('selector' in s && typeof s.selector === 'string') return s.selector;
  return '';
}
