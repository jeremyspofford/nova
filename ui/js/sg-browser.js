// Nova's browser, design-first (2026-11-09): starting a browser task and the flows library, as
// compositions for the owner's reaction, before any wiring. Styleguide only: the app never loads
// this file, nothing here is sent anywhere, and every control is a specimen (a checkbox ticks; Run,
// Approve, Take over and the passkey say they are a demo).
//
// Drawn from the real model (src/core/browser/, docs/plans/M10b.md). A browser task is a Work Ledger
// task owned by the browser worker whose brief is a step plan: the hosts it may reach
// (allowed_hosts, up to 20; anything else is refused and recorded), its steps (navigate, fill, click,
// select, wait, read, a step for a person, login, checkout, and the account steps), the page that
// shows it worked (verify), and a profile: Nova's own, which keeps cookies between tasks and runs
// one task at a time, or a throwaway one. Tiers (plan.ts minTierOf): a plan that only reads asks
// nothing; one that signs in with a saved sign-in, types, chooses or clicks on its own sites is act
// and report (1, owner ruling 2026-11-09; it asked first, 2, before); a checkout or an account
// change asks every time (3, {confirm: true}, with a passkey on Nova's own screen), signed in or
// not, and so does forgetting a site. A sign-in is one per site,
// saved in the vault under browser/login/<host>/ and typed by the worker only into a page on that
// host, over https (plain http only to this machine), at the moment of use; its value is never
// shown. While a task runs there is a live picture (JPEG frames over server-sent events) that
// anyone may watch; only Nova's own screen and devices allowed to approve may pause, stop, take over
// and hand back. Nova stops at a checkout's itemised total and never presses pay. A finished task
// keeps a screenshot, a fresh read of the verify page and its steps; a failed one, the backend's
// words. A flow is a site template learnt from a task that asked to learn its steps and ended
// verified: GET /browser/flows lists its id, version, state, step count and uses, never its steps.
// There is no route to edit or retire one, no planner that turns words into steps, and chat starts
// only account changes (account_change). Those gaps are drawn as gaps, not as controls.
// The door proposed: a category in Settings › What Nova works with, beside Nova's computer. Its CSS
// is ui/styles/compositions.css (.bw-*, and the .au-* panes it shares with the Automations
// compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS, passkeyAction, passkeyConfirm, takeoverState } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const BW_FRAMES = [
  ['door', 'The door at rest: Settings › What Nova works with › Nova’s browser, Chromium found, three flows, three sites, nothing running', 'detail'],
  ['door-empty', 'Nothing yet: no flow learnt, no site kept, no task run', 'detail'],
  ['no-chromium', 'Can’t run here: no Chromium on this machine (the backend’s words)', 'detail'],
  ['start', 'Starting a task from a flow: the sites it may visit, the sign-in it uses, its profile, and what it will ask', 'detail'],
  ['start-words', 'Asking in your own words: not possible yet, said plainly, with what does work today', 'detail'],
  ['approve', 'A task waiting for your OK before it runs: a checkout flow asks every time (tier 3)', 'detail'],
  ['running', 'A task running: its live picture, the step it is on, and Take over, Pause and Stop', 'detail'],
  ['needs-you', 'A task waiting for you mid-run: a CAPTCHA only a person may solve', 'detail'],
  ['done', 'A finished task: stopped at the checkout, its evidence, and what it refused', 'detail'],
  ['failed', 'A failed task: no sign-in saved for the site, in the backend’s words', 'detail'],
  ['flows', 'The flows library with one flow open: its shape, Run it, and what can’t be done to it yet', 'detail'],
  ['flows-empty', 'No flows yet, and how one is learnt today', 'detail'],
  ['sites', 'Sites and sign-ins: what Nova’s browser keeps per site, with one open', 'detail'],
  ['forget-confirm', 'Forgetting a site asks every time (tier 3): its cookies and storage, and its sign-in if you say', 'detail'],
];
const paneOf = (s) => BW_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';
const DOOR = new Set(['door', 'door-empty', 'no-chromium']);

// What GET /browser says (chromium.ts findChromium).
const CHROMIUM = 'Chromium at /usr/bin/chromium.';
const NO_CHROMIUM = 'Browser work is unavailable: Nova found no Chromium on this machine. Install Chromium, or set NOVA_CHROMIUM to its path.';

// Flows, as GET /browser/flows returns them (template_id, version, state, steps, uses, created_at).
const FLOWS = [
  { name: 'reorder-paper', site: 'shop.example.com', version: 2, state: 'active', steps: 7, uses: 5, made: 'Nov 3', checkout: true },
  { name: 'order-status', site: 'shop.example.com', version: 1, state: 'active', steps: 4, uses: 2, made: 'Oct 30', checkout: false },
  { name: 'renew-books', site: 'library.example.org', version: 1, state: 'draft', steps: 6, uses: 0, made: 'today, 08:40', checkout: false },
];
const PAPER = FLOWS[0];
const templateId = (f) => `browser-site.${f.site}.${f.name}`;
// Sites, as GET /browser/sites returns them (site, login, first_at, last_at). Never a value.
const SITES = [
  { site: 'shop.example.com', login: true, first: 'Oct 28', last: 'today, 14:02' },
  { site: 'library.example.org', login: true, first: 'Nov 1', last: 'Nov 6' },
  { site: 'news.example.net', login: false, first: 'Nov 2', last: 'Nov 2' },
];
// Browser tasks (GET /tasks, owner browser) and the live session (GET /browser/tasks/{id}).
const TASKS = {
  run: { id: '7a1c40e2', title: 'Reorder the printer paper', at: '14:02', state: 'Running · step 3 of 7' },
  wait: { id: '7a1c40e2', title: 'Reorder the printer paper', at: '14:02', state: 'Needs you' },
  ok: { id: '7a1c40e2', title: 'Reorder the printer paper', at: '14:02', state: 'Waiting for your OK' },
  done: { id: '7a1c40e2', title: 'Reorder the printer paper', at: '14:09', state: 'Done' },
  status: { id: 'c3e9f105', title: 'Check the order status', at: 'Nov 8', state: 'Done' },
  fail: { id: '5d20b7aa', title: 'Check the parcel on parcels.example.com', at: '11:20', state: 'Failed' },
};
const VIEW = (mode, o = {}) => ({ live: true, mode, url: 'https://shop.example.com/checkout/address', step: { n: 3, of: 7, what: 'fill in the delivery address' }, asked: null, holder: null, blocked: [{ host: 'ads.example.net', count: 4 }], ...o });
const CAPTCHA = 'This page wants a CAPTCHA solved. Nova never solves one: take over, do it, then hand back.';
const NO_LOGIN = 'There is no sign-in saved for parcels.example.com. Save one in Settings › Connections › Site sign-ins (never in chat), then try again.';
const DONE = 'Went through 7 steps on shop.example.com. Stopped at the checkout: 2 lines, total $41.98. Paying is yours: Nova never presses pay. Followed the flow “reorder-paper” v2, checking each step. Refused 1 host the task didn’t declare: ads.example.net.';

// ---- the words: the model in plain language ------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-bw-icon="${state}" data-bw-size="${size}" aria-hidden="true"></span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
const LEDE = 'Nova’s own browser works through web pages for you, only on the sites a task names. You can watch any task, and pause, stop or take it over.';
const SIGN_IN = 'Nova types it only into a page on that site, over https, when a step signs in. It is never shown, here or in chat.';
const ACTS_ONLY = 'Anyone of yours can watch. Only Nova’s own screen, or a device you’ve allowed to approve, can pause, stop or take over.';
const flowState = (f) => (f.state === 'active' ? 'Ready' : f.state === 'draft' ? 'Being checked' : 'Retired');
const tierWords = (f) => (f.checkout ? 'Every time (tier 3): it ends at a checkout' : 'Not first (tier 1): it signs in, types and clicks on its own site, and reports what it did');
// Using a saved sign-in (owner ruling 2026-11-09): it doesn't make a task ask first by itself.
const SIGN_IN_TIER = 'Signing in with it doesn’t make a task ask first: a task that only signs in, types and clicks on its own sites runs and reports (tier 1). A checkout or an account change still asks every time.';

// ---- the door: a category in Settings --------------------------------------------------------------

// Settings' categories (settings-ia.js), with Nova's browser proposed under What Nova works with.
const GROUPS = [
  ['You', [['You and Nova', 'Names and how Nova talks to you'], ['Appearance', 'Theme, light and dark, contrast'], ['Privacy and permissions', 'What stays here and what asks first']]],
  ['What Nova works with', [['Connections', 'Accounts and services Nova can reach'], ['Models and providers', 'Local models and outside help'], ['Devices', 'Phones and computers paired with Nova'], ['Capture', 'Sources, consent, and what Nova remembers'], ['browser', '']]],
  ['Keeping Nova safe', [['Security', 'Passkeys that confirm tier-3 actions here'], ['Backups and changes', 'Backup folders, checkpoints, restores and changes']]],
];

function doorMeta(o) {
  if (o.fault) return 'Can’t run on this machine';
  if (o.empty) return 'Ready · no flows or sites yet';
  return `Ready · ${FLOWS.length} flows, ${SITES.length} sites, nothing running`;
}

function categories(id, o) {
  let n = 0;
  const row = ([name, note]) => {
    const mine = name === 'browser';
    const i = n++;
    const label = mine ? 'Nova’s browser' : name;
    return `<li class="bw-cat"><a class="uc-row au-open${mine ? ' is-on' : ''}" href="#${id}-${mine ? 'browser' : `cat-${i}`}"${mine ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(label)}</span><span class="au-meta">${esc(mine ? doorMeta(o) : note)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;
  };
  return `<nav class="au-list" aria-label="Settings categories">${GROUPS.map(([g, cats], gi) => `<h3 class="uc-group" id="${id}-g${gi}">${g}</h3><ul class="bw-list" aria-labelledby="${id}-g${gi}">${cats.map(row).join('')}</ul>`).join('')}</nav>`;
}

function readiness(fault) {
  if (fault) return '<p class="uc-state is-unknown"><span class="uc-dot" aria-hidden="true"></span><span>Can’t run on this machine</span></p>';
  return `<p class="uc-state is-ok"><span class="uc-dot" aria-hidden="true"></span><span>Ready. ${esc(CHROMIUM)}</span></p>`;
}

// A link row into the browser's own pages, from the door.
const door = (id, href, name, meta) => `<li class="bw-item"><a class="uc-row au-open" href="#${id}-${href}"><span class="au-text"><span class="au-name">${esc(name)}</span><span class="au-meta">${esc(meta)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;

function doorPane(id, o) {
  const back = `<a class="uc-row uc-back" href="#${id}-settings"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>`;
  const head = `${back}<h3 class="uc-h" id="${id}-name">Nova’s browser</h3><p class="uc-lede">${LEDE}</p>${readiness(o.fault)}`;
  if (o.fault) {
    return `${head}<div class="bw-said" role="group" aria-labelledby="${id}-said-h"><p class="au-block-head" id="${id}-said-h">What Nova found</p><p class="bw-quote">${esc(NO_CHROMIUM)}</p></div>
<p class="au-note">Nova doesn’t install a browser. Your flows and saved sign-ins are kept; a task asked for meanwhile fails with these words.</p><div class="au-actions"><button type="button" class="btn" data-bw-demo>Check again</button></div>`;
  }
  if (o.empty) {
    return `${head}<h4 class="uc-group au-group-head">Tasks</h4><p class="au-sentence">Nothing has run in Nova’s browser yet.</p>
<p class="au-note">A task starts from a flow Nova has learnt. Until one is learnt, tasks come through the API, or from chat for an account change.</p>
<ul class="bw-list">${door(id, 'flows', 'Flows', 'None learnt yet')}${door(id, 'sites', 'Sites and sign-ins', 'None kept yet: save a sign-in for a site here')}</ul>`;
  }
  return `${head}<div class="au-actions bw-top-acts"><a class="btn primary" href="#${id}-start">Start a task</a></div>
<h4 class="uc-group au-group-head" id="${id}-lib">In Nova’s browser</h4><ul class="bw-list" aria-labelledby="${id}-lib">${door(id, 'tasks', 'Tasks', `Nothing running · last: ${TASKS.status.title}, ${TASKS.status.at}`)}${door(id, 'flows', 'Flows', `${FLOWS.length} learnt · ${FLOWS.filter((f) => f.state === 'active').length} ready to run`)}${door(id, 'sites', 'Sites and sign-ins', `${SITES.length} sites · ${SITES.filter((s) => s.login).length} with a saved sign-in`)}</ul>
<p class="au-note">Each task is a task in Tasks too, with its record.</p>`;
}

// ---- inside: tasks, flows and sites beside the one open --------------------------------------------

function taskRow(id, t, current) {
  return `<li class="bw-item"><a class="uc-row au-open${current ? ' is-on' : ''}" href="#${id}-t-${t.id}"${current ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(t.title)}</span><span class="au-meta">${esc(t.at)}</span></span><span class="au-state">${esc(t.state)}</span></a></li>`;
}
function flowRow(id, f, current) {
  return `<li class="bw-item"><a class="uc-row au-open${current ? ' is-on' : ''}" href="#${id}-f-${f.name}"${current ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(f.name)}</span><span class="au-meta">${esc(f.site)} · v${f.version} · ${f.steps} steps</span></span><span class="au-state">${flowState(f)}</span></a></li>`;
}
function siteRow(id, s, current) {
  return `<li class="bw-item"><a class="uc-row au-open${current ? ' is-on' : ''}" href="#${id}-s-${s.site}"${current ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(s.site)}</span><span class="au-meta">Used ${esc(s.last)}</span></span><span class="au-state">${s.login ? 'Sign-in saved' : 'Kept data'}</span></a></li>`;
}

// The list pane: what's running or waiting, recent tasks, then flows or sites.
function insideList(id, { now = null, recent = [TASKS.status], show = 'tasks', current = '', flows = FLOWS, starting = false } = {}) {
  const tasks = `${now ? `<h3 class="uc-group" id="${id}-now">Now</h3><ul class="bw-list" aria-labelledby="${id}-now">${taskRow(id, now, current === 'now')}</ul>` : ''}
<h3 class="uc-group" id="${id}-recent">Recent tasks</h3><ul class="bw-list" aria-labelledby="${id}-recent">${recent.map((t) => taskRow(id, t, current === t.id)).join('')}</ul>`;
  const lib = show === 'sites'
    ? `<h3 class="uc-group" id="${id}-sl">Sites and sign-ins</h3><ul class="bw-list" aria-labelledby="${id}-sl">${SITES.map((s) => siteRow(id, s, current === s.site)).join('')}</ul>`
    : `<h3 class="uc-group" id="${id}-fl">Flows</h3>${flows.length ? `<ul class="bw-list" aria-labelledby="${id}-fl">${flows.map((f) => flowRow(id, f, current === f.name)).join('')}</ul>` : '<p class="au-intro">None learnt yet.</p>'}`;
  return `<div class="au-list"><p class="au-intro">${esc(CHROMIUM)}</p>${show === 'flows' || show === 'sites' ? '' : tasks}${lib}
<a class="uc-row au-new${starting ? ' is-on' : ''}" href="#${id}-start"${starting ? ' aria-current="true"' : ''}><span class="uc-ic" aria-hidden="true">${icon('plus')}</span><span class="uc-label">Start a task</span></a></div>`;
}

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Nova’s browser</span></a>`;
const kind = (t) => `<p class="bw-kind">${esc(t)}</p>`;

// What a task may reach and use: the facts the plan holds, never a sign-in's value.
function reach(id, { blocked = false } = {}) {
  return facts([
    ['May visit', `${mono(PAPER.site)} only. Anything else a page asks for is refused, and kept in the record.`],
    ['Signs in with', `The sign-in saved for ${mono(PAPER.site)}. ${SIGN_IN}`],
    ['Profile', 'Nova’s own: it keeps this site’s cookies between tasks. Tasks in it run one at a time.'],
    ['Flow', `${mono(PAPER.name)} v${PAPER.version}, ${PAPER.steps} steps, each checked against what it learnt`],
    ...(blocked ? [['Refused so far', `${mono('ads.example.net')} · 4 times`]] : []),
  ]);
}

// ---- starting a task --------------------------------------------------------------------------------

const choice = (name, value, words, on, note = '') => `<label class="uc-choice au-choice"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${words}${note ? ` <span class="uc-faint">${note}</span>` : ''}</span></label>`;

function startForm(id) {
  const opts = FLOWS.map((f) => `<option${f === PAPER ? ' selected' : ''}${f.state !== 'active' ? ' disabled' : ''}>${esc(f.name)} on ${esc(f.site)} · v${f.version}${f.state !== 'active' ? ' (being checked)' : ''}</option>`).join('');
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Start a task</h3>
<div class="au-field"><label class="au-label" for="${id}-flow">Flow</label><select class="uc-input" id="${id}-flow">${opts}</select><p class="au-note">A flow Nova learnt from a task that worked. One still being checked can’t run yet.</p></div>
<div class="au-field"><label class="au-label" for="${id}-hosts">Sites it may visit</label><input class="uc-input bw-mono" id="${id}-hosts" value="shop.example.com" spellcheck="false" autocapitalize="off"><p class="au-note">Up to 20, separated by spaces. ${mono('*.example.com')} covers its subdomains. Anything else is refused.</p></div>
<div class="bw-said" role="group" aria-labelledby="${id}-login-h"><p class="au-block-head" id="${id}-login-h">Signs in with</p><p class="bw-quote">The sign-in saved for shop.example.com: there is one per site, and Nova uses whichever is saved when the step runs.</p><p class="au-note">${SIGN_IN} A step on a site with none saved stops the task.</p></div>
<fieldset class="au-group"><legend class="uc-group">Profile</legend>${choice(`${id}-profile`, 'nova', 'Nova’s own', true, '· stays signed in between tasks; one task at a time')}${choice(`${id}-profile`, 'fresh', 'A throwaway one', false, '· starts empty, for this task alone')}</fieldset>
<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-vurl">The page that shows it worked</label><input class="uc-input bw-mono" id="${id}-vurl" value="https://shop.example.com/checkout" spellcheck="false" autocapitalize="off"></div>
<div class="au-field"><label class="au-label" for="${id}-vtext">What it must show</label><input class="uc-input" id="${id}-vtext" value="Order summary"></div></div>
<p class="au-note">Nova fetches that page again itself at the end and checks the words are there. A flow doesn’t keep these yet, so each run asks.</p>
<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">It will be</h4><p class="au-sentence">Nova follows “reorder-paper” on shop.example.com, signed in, and stops at the checkout’s total.</p><p class="au-note">It asks every time (tier 3), because it ends at a checkout. Paying is yours: Nova never presses pay. It shows in Tasks while it waits for your OK.</p></section>
<div class="au-actions"><button type="submit" class="btn primary" data-bw-demo>Ask to start it</button><button type="button" class="btn quiet">Cancel</button></div></form>
<div class="au-actions bw-aside"><a class="btn quiet" href="#${id}-words">Describe a task in words instead</a></div>`;
}

function startWords(id) {
  return `${back(id)}${kind('Not possible yet')}<h3 class="uc-h" id="${id}-title">Describe a task in your own words</h3>
<p class="au-sentence">Nova can’t turn words into browser steps yet, so there is no box to type them in here.</p>
<div class="bw-said" role="group" aria-labelledby="${id}-today-h"><p class="au-block-head" id="${id}-today-h">What starts a browser task today</p>
<ul class="bw-notes"><li>A flow Nova learnt, from Start a task.</li><li>A step plan sent to ${mono('POST /api/v1/tasks')} with the browser as its worker: the sites, each step by CSS selector or by role and name, and the page that shows it worked.</li><li>From chat, an account change only: a new password, a new account, or two-step sign-in, confirmed in Tasks every time.</li></ul></div>
<p class="au-note">Asking chat to “reorder the paper” today gets no browser task. That needs a planner the backend doesn’t have.</p>
<div class="au-actions"><a class="btn" href="#${id}-start">Start from a flow</a></div>`;
}

// ---- a task's life: waiting for an OK, running, needing you, done, failed ---------------------------

function approve(id) {
  return `${back(id)}${kind('Waiting for your OK')}<h3 class="uc-h" id="${id}-title">${esc(TASKS.ok.title)}</h3>
<p class="au-sentence">Nova will follow “reorder-paper” on shop.example.com, signed in, and stop at the checkout’s total.</p>
${reach(id)}${facts([['Asks', 'Every time (tier 3): it ends at a checkout. Signing in alone wouldn’t ask (tier 1).'], ['Proof', 'A screenshot, and Nova’s own read of https://shop.example.com/checkout showing “Order summary”'], ['Task', `${mono(TASKS.ok.id)} in Tasks`]])}
<form class="au-form bw-confirm" data-sg-inert novalidate aria-label="Approve this task">${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn">Cancel the task</button><button type="button" class="btn quiet">Not now</button></div></form>`;
}

// The live picture: drawn as its frame and words. In the app it is the stream of JPEG frames.
function picture(id, st) {
  return `<figure class="bw-screen" aria-labelledby="${id}-pic-cap"><div class="bw-pic"><p class="bw-pic-url">${mono('shop.example.com/checkout/address')}</p><p class="au-note">The live picture shows here: Nova’s browser as it works, frame by frame.</p></div>
<figcaption class="au-note" id="${id}-pic-cap">${esc(st.line)}</figcaption></figure>`;
}

function running(id) {
  const st = takeoverState(VIEW('working'));
  return `${back(id)}${kind(`Running · since ${TASKS.run.at}`)}<h3 class="uc-h" id="${id}-title">${esc(TASKS.run.title)}</h3>
${picture(id, st)}
<div class="au-actions bw-top-acts"><button type="button" class="btn primary" data-bw-demo>Take over</button><button type="button" class="btn quiet" data-bw-demo>Pause</button><button type="button" class="btn quiet" data-bw-demo>Stop</button><a class="btn quiet" href="#${id}-tasks">Open in Tasks</a></div>
<p class="au-note">${ACTS_ONLY} While you hold it, Nova waits; Hand back and it carries on from the page as you left it.</p>
<h4 class="uc-group au-group-head" id="${id}-reach">What it may reach</h4>${reach(id, { blocked: true })}`;
}

function needsYou(id) {
  const st = takeoverState(VIEW('needs_person', { asked: CAPTCHA, url: 'https://shop.example.com/checkout/verify', step: { n: 5, of: 7, what: 'continue to the checkout' } }));
  return `${back(id)}${kind('Needs you')}<h3 class="uc-h" id="${id}-title">${esc(TASKS.wait.title)}</h3>
<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-ask-h"><div class="au-result-text"><p class="au-block-head" id="${id}-ask-h">Step 5 of 7 waits for you</p><p class="bw-quote">${esc(CAPTCHA)}</p><p class="au-note">Paused, or waiting for you: nothing that isn’t a GET leaves the page. If it is still there after five hand-backs, Nova stops.</p></div><div class="au-actions"><button type="button" class="btn primary" data-bw-demo>Take over</button></div></div>
${picture(id, st)}
<div class="au-actions"><button type="button" class="btn quiet" data-bw-demo>Stop</button><a class="btn quiet" href="#${id}-tasks">Open in Tasks</a></div>
<p class="au-note">${ACTS_ONLY}</p>`;
}

function done(id) {
  return `${back(id)}${kind(`Done · ${TASKS.done.at}`)}<h3 class="uc-h" id="${id}-title">${esc(TASKS.done.title)}</h3>
<p class="au-sentence">Stopped at the checkout: 2 lines, $41.98. Paying is yours.</p>
<div class="bw-said" role="group" aria-labelledby="${id}-said-h"><p class="au-block-head" id="${id}-said-h">What Nova reported</p><p class="bw-quote">${esc(DONE)}</p></div>
<figure class="bw-screen" aria-labelledby="${id}-shot-cap"><div class="bw-pic"><p class="bw-pic-url">${mono('shop.example.com/checkout')}</p><p class="au-note">The screenshot Nova took at the end shows here.</p></div><figcaption class="au-note" id="${id}-shot-cap">Its evidence: the page when it finished. Sign-in values are masked on the page before the picture is taken.</figcaption></figure>
${facts([['Checked', 'Nova fetched https://shop.example.com/checkout again itself: it shows “Order summary”.'], ['Kept', 'The screenshot, that read, the steps it took, and the checkout’s lines'], ['Refused', `${mono('ads.example.net')} · 4 times`]])}
<div class="au-actions"><a class="btn" href="#${id}-shop">Open the checkout yourself</a><a class="btn quiet" href="#${id}-tasks">See the record in Tasks</a></div>`;
}

function failed(id) {
  return `${back(id)}${kind(`Failed · ${TASKS.fail.at}`)}<h3 class="uc-h" id="${id}-title">${esc(TASKS.fail.title)}</h3>
<div class="au-result" role="group" aria-labelledby="${id}-f-h"><div class="au-result-text"><p class="au-block-head" id="${id}-f-h">It stopped at step 2 of 4</p><p class="bw-quote">${esc(NO_LOGIN)}</p></div><div class="au-actions"><a class="btn primary" href="#${id}-sites">Save a sign-in</a></div></div>
<p class="au-note">Nova doesn’t run it again by itself: it may have sent something before it stopped. Once the sign-in is saved, start it again.</p>
${facts([['Kept', 'The steps it took, up to the one that stopped'], ['Task', `${mono(TASKS.fail.id)}, failed, in Tasks`]])}
<div class="au-actions"><a class="btn" href="#${id}-start">Start it again</a></div>`;
}

// ---- the flows library -------------------------------------------------------------------------------

function flow(id, f) {
  return `${back(id)}${kind(`Flow · learnt ${f.made}`)}<h3 class="uc-h" id="${id}-title">${esc(f.name)}</h3>
<p class="au-sentence">${f.steps} steps on ${esc(f.site)}, used ${f.uses} times.</p>
<div class="au-actions bw-top-acts"><a class="btn primary" href="#${id}-start">Run it</a></div>
${facts([['Site', mono(f.site)], ['Version', `${f.version}: each time a task that asked to learn it ends verified, a new version is checked and replaces it`], ['State', `${flowState(f)}: its dry runs passed, checked both ways`], ['Asks', tierWords(f)], ['Kept as', mono(templateId(f))]])}
<div class="bw-said" role="group" aria-labelledby="${id}-gap-h"><p class="au-block-head" id="${id}-gap-h">Not possible yet</p>
<ul class="bw-notes"><li>Seeing its steps: Nova keeps them, but lists only how many.</li><li>Editing a step: there is no way to change a flow except learning it again.</li><li>Deleting or retiring it: Nova can retire a version inside, but nothing here can ask it to.</li></ul></div>
<p class="au-note">No sign-in value is ever part of a flow: Nova won’t keep one whose steps hold one.</p>`;
}

function flowsEmpty(id) {
  return `${back(id)}<h3 class="uc-h" id="${id}-title">Flows</h3><p class="au-sentence">No flows yet.</p>
<p class="au-note">A flow is learnt from a browser task that asks to learn its steps under a name, and ends verified. Nova checks it both ways before it can run.</p>
<p class="au-note">Today that task is asked for through the API (${mono('inputs.learn')}): nothing here or in chat can ask for one yet.</p>`;
}

// ---- sites and sign-ins ------------------------------------------------------------------------------

function site(id) {
  const s = SITES[0];
  return `${back(id)}${kind('Site')}<h3 class="uc-h" id="${id}-title">${esc(s.site)}</h3>
${facts([['Sign-in', `Saved. ${SIGN_IN}`], ['Using it', esc(SIGN_IN_TIER)], ['Kept data', 'Cookies and storage in Nova’s own profile'], ['First used', esc(s.first)], ['Last used', esc(s.last)]])}
<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-rep"><h4 class="uc-group au-group-head" id="${id}-rep">Replace the sign-in</h4>
<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-user">Username</label><input class="uc-input" id="${id}-user" autocomplete="off" spellcheck="false"></div><div class="au-field"><label class="au-label" for="${id}-pass">Password</label><input class="uc-input" id="${id}-pass" type="password" autocomplete="new-password"></div></div>
<p class="au-note">Never type a password into chat; save it here instead. The one saved now isn’t shown.</p>
<div class="au-actions"><button type="submit" class="btn" data-bw-demo>Save the sign-in</button></div></form>
<div class="au-danger"><a class="btn quiet" href="#${id}-forget">Forget this site</a><p class="au-note">Asks every time (tier 3: it deletes data). Its cookies and storage go, and its sign-in too if you say.</p></div>`;
}

function forget(id) {
  return `${back(id)}<form class="au-form bw-confirm" data-sg-inert novalidate aria-labelledby="${id}-title">${kind('Asks every time')}<h3 class="uc-h" id="${id}-title">Forget shop.example.com?</h3>
<p class="au-sentence">Nova deletes the cookies and storage its browser keeps for shop.example.com, so the next task there starts signed out. This can’t be undone.</p>
<label class="uc-choice au-choice"><input type="checkbox" name="login" checked><span>Also delete its saved sign-in</span></label>
<p class="au-note">Not while a task is using Nova’s browser: it says so, and you try again when it has finished. The flows for this site stay.</p>
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Keep it</button></div></form>`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, title, panes, live) {
  const id = `bw-${state}`;
  return `<div class="uc-screen bw" data-bw-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;

export function bwFrame(state) {
  if (DOOR.has(state)) {
    const o = { empty: state === 'door-empty', fault: state === 'no-chromium' };
    return screen(state, 'Settings', pair((id) => categories(id, o), (id) => doorPane(id, o)), 'idle');
  }
  const inside = (right, live, list = {}) => screen(state, 'Nova’s browser', pair((id) => insideList(id, list), right), live);
  if (state === 'start') return inside(startForm, 'idle', { starting: true });
  if (state === 'start-words') return inside(startWords, 'idle', { starting: true });
  if (state === 'approve') return inside(approve, 'needs-you', { now: TASKS.ok, current: 'now' });
  if (state === 'running') return inside(running, 'working', { now: TASKS.run, current: 'now' });
  if (state === 'needs-you') return inside(needsYou, 'needs-you', { now: TASKS.wait, current: 'now' });
  if (state === 'done') return inside(done, 'idle', { recent: [TASKS.done, TASKS.status], current: TASKS.done.id });
  if (state === 'failed') return inside(failed, 'stopped', { recent: [TASKS.fail, TASKS.status], current: TASKS.fail.id });
  if (state === 'flows') return inside((id) => flow(id, PAPER), 'idle', { show: 'flows', current: PAPER.name });
  if (state === 'flows-empty') return inside(flowsEmpty, 'idle', { show: 'flows', flows: [] });
  if (state === 'sites') return inside(site, 'idle', { show: 'sites', current: SITES[0].site });
  if (state === 'forget-confirm') return inside(forget, 'needs-you', { show: 'sites', current: SITES[0].site });
  return bwFrame('door');
}
// The styleguide entry: every frame, each with its full-screen address.
export function bwEntry(wrap) {
  return BW_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=browser-tasks&amp;frame=${s}">Full screen</a>`, bwFrame(s))).join('');
}
export const isBwFrame = (s) => BW_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: the passkey checkbox enables
// its button, and the demo buttons say they are a demo.
export function bindBrowser(root) {
  for (const el of root.querySelectorAll('[data-bw-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.bwIcon, size: Number(el.dataset.bwSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-bw-frame]')) {
    if (frame.dataset.bwBound) continue;
    frame.dataset.bwBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bw-demo], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
