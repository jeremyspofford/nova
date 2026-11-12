// The PWA's own surfaces, drawn from the core (/api/v1): Home, the right column, Tasks, Health,
// automation rules, and Settings' identity, privacy, appearance and devices. Era 2's views
// (conversations, Memory, Skills, Schedules, Activity, permissions) stay in app.js and view.js.
import { api, deviceId, request, Unreachable } from './core.js';
import { CHECK_NAMES, ICONS, KIND_WORDS, addDeviceSheet, ago, approvalSheet, briefCard, card, codingSheet, infraSheet, networkSheet, deviceMeshCard, deviceRow, emptyState, evidenceViewer, handlingCard, healthCard, playbookEvents, allowApproveSheet, joinRequestSheet, memoryHighlightCard, pickedRoles, rolesReviewSheet, rolesSheet, proactiveBanner, promoteSheet, promotionSheet, promotionActionSheet, coldPromotionSheet, revokeSheet, settingsRow, status, taskRow, triggerRow, verifiedResultCard, workCosts, diagnosticsDownload } from './components.js';
import { greeting, isOpen, needsApproval, retryLabel, severity, statusOf } from './status.js';
import { escapeHtml as esc } from './markdown.js';
import { closeSheet, layout, liveIcon, openSheet, sheetOpen, toast } from './shell.js';
import { MODES, current as appearance, endPreview, fixContrast, follow, preview, previewingNow, rollback, setMode, syncedId, undoFix, use } from './theme.js';
import { recommend } from './contrast.js';
import { contrastView, undoPlan } from './look.js';
import { openTakeover } from './takeover.js';
import { begin, over, waitingLine } from './wait.js';
import { renderBackupsSettings } from './view.js';
import { showWaiting, waitingUnits } from './skeleton.js';

// What the core has told this page, kept fresh by the event stream.
export const store = {
  tasks: [], problems: [], resolved: [], health: null, version: null, profile: null, identity: null,
  memory: [], rules: [], messages: [], workers: [], reachable: true, stale: false, loaded: false, tried: false,
  // The device mesh: the registry, whether other devices can reach Nova (and who this page is),
  // and devices waiting for an OK.
  devices: [], mesh: null, meshFresh: false, requests: [],
  // Settings › Providers: GET /providers, loaded when Settings opens (M5a).
  providers: null,
  // The recommended chat model’s eval scorecard status, shown before a switch (Amendment B Part 4).
  chatCard: null,
  // Keeping Nova running (M7b): the supervisor, releases, backups, the last drill, playbooks.
  resilience: null,
  caps: null, capsState: 'loading', capsError: '',
  // Which parts have answered at least once, and which haven't and whose last read failed (F-021):
  // a part that never loaded is unknown, never empty. Views draw "couldn't be loaded" with a retry
  // for a failed part, wait for a pending one, and make no claim about either.
  known: new Set(), failed: new Set(),
};
export const partKnown = (p) => store.known.has(p);
export const partFailed = (p) => store.failed.has(p);
const partSettled = (p) => store.known.has(p) || store.failed.has(p);
// One word for where a part stands, for the cards that draw it (components.js partBody): answered,
// never answered and its last read failed, or still on its way. Only 'known' may say empty.
export const partState = (p) => (store.known.has(p) ? 'known' : store.failed.has(p) ? 'failed' : 'pending');

const settle = (p, fallback) => p.catch(() => fallback);
const INITIAL_PARTS = ['tasks', 'problems', 'health', 'profile', 'memory', 'rules', 'messages', 'workers', 'devices', 'mesh', 'requests', 'resilience', 'caps'];
export async function load(parts = INITIAL_PARTS) {
  const capsRead = parts.includes('caps') ? ++capsSequence : 0;
  if (capsRead) { store.capsState = store.caps && ['ready', 'refreshing'].includes(store.capsState) ? 'refreshing' : 'loading'; store.capsError = ''; begin('health-costs'); costsChanged(); }
  // Each part comes back as [value, stale].
  const get1 = (path) => request('GET', path).then((r) => [r.data, r.stale]);
  const get = {
    tasks: () => get1('/tasks?limit=100'),
    problems: () => get1('/problems'),
    health: () => get1('/health'),
    // The running build (commit, build or start time), read when Health opens.
    version: () => get1('/version'),
    caps: () => get1('/caps'),
    resilience: () => get1('/resilience'),
    profile: () => Promise.all([get1('/profile'), get1('/identity')]).then(([a, b]) => [[a[0], b[0]], a[1] || b[1]]),
    memory: () => get1('/memory'),
    rules: () => get1('/triggers/rules'),
    messages: () => get1('/messages'),
    workers: () => get1('/workers'),
    devices: () => get1('/mesh/devices'),
    mesh: () => get1('/mesh/status'),
    // Only the hub's screen and devices allowed to approve can see who is asking.
    requests: () => (store.mesh?.you?.can_approve === false ? Promise.resolve([[], false]) : get1('/mesh/requests')),
  };
  // Each part in is a real unit of the first load: the 10 s words count them (DESIGN-SYSTEM §1).
  let done = 0;
  const counted = (x) => { done++; if (!store.loaded) for (const v of ['home', 'tasks']) waitingUnits(v, done, parts.length); return x; };
  const results = await Promise.all(parts.map((p) => settle(get[p]().then(([v, s]) => [p, v, s]), [p, undefined, false]).then(counted)));
  let any = false;
  let wasStale = false;
  for (const [p, v, s] of results) {
    if (v === undefined) { if (!store.known.has(p)) store.failed.add(p); } else { store.known.add(p); store.failed.delete(p); }
    if (p === 'mesh') store.meshFresh = v !== undefined && !s;
    if (p === 'caps') {
      if (capsRead !== capsSequence) continue; // A newer refresh owns freshness.
      over('health-costs');
      store.capsState = v !== undefined && !s ? 'ready' : 'unavailable';
      store.capsError = s ? 'Work costs were saved earlier. Reconnect and retry before saving limits.' : v === undefined ? 'Work costs could not be read. Retry before saving limits.' : '';
      if (v !== undefined && !s) store.caps = v;
    }
    if (v === undefined || (p === 'caps' && s)) continue;
    any = true;
    wasStale ||= s;
    if (p === 'problems') { store.problems = v.filter((x) => !x.resolved_at); store.resolved = v.filter((x) => x.resolved_at).slice(0, 10); }
    else if (p === 'profile') { store.profile = v[0]; store.identity = v[1].identity; }
    else store[p] = v;
  }
  if (any) store.loaded = true;
  store.tried = true;
  if (store.health) over('health');
  store.stale = wasStale;
  if (parts.some((p) => p === 'devices' || p === 'mesh' || p === 'requests')) window.dispatchEvent(new CustomEvent('nova:devices'));
  // Live means at least one answer came from the server itself, not the offline cache.
  return { any, live: results.some(([, v, s]) => v !== undefined && !s) };
}

// Everything in the one vocabulary's Needs you: an OK to give, a step only the person can do
// (a browser task waiting for a takeover), a task that is stuck without them.
const asksYou = (t) => statusOf(t) === 'needs-you';
export const needsYou = () => store.tasks.filter(asksYou).length + store.messages.filter((m) => m.hold === 'needs_ok').length + store.requests.length;
export const working = () => store.tasks.filter((t) => t.state === 'active' || t.state === 'verifying').length;
// The privacy mode Nova acts under: Local only for an unread profile, the strict default for what
// Nova may do (saveProfile's looser check, voice). Not a fact to show: a surface that names the mode
// asks partKnown('profile') first and names none until then (V-1, V-3).
export const privacy = () => store.profile?.privacy?.default ?? 'local-only';

// ---- this device ---------------------------------------------------------------------------

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iOS Safari alone has navigator.standalone: a capability check, not a device name.
const iosLimits = () => typeof navigator.standalone === 'boolean';
export function thisDevice() {
  return {
    name: standalone() ? 'Nova app' : 'This browser',
    detail: `${layout.layout ?? ''} layout${layout.posture && layout.posture !== 'continuous' ? `, ${layout.posture.replace(/-/g, ' ')}` : ''}`,
    online: store.reachable,
    current: true,
  };
}

// The registry once it has answered; until then (or when its answer was cut off as a page was
// left, which reads as null), this browser alone.
const meshDevices = () => (store.devices?.length ? store.devices : [thisDevice()]);

// ---- Home ---------------------------------------------------------------------------------

// The one severity (status.js severity; ruling D5) every surface reads: the mark and the badge
// (app.js), Home's first line and health card, and Health. `extra`: Era 2's runs waiting for the
// person, which only app.js knows.
export const severityNow = (extra = 0) => severity({ problems: store.problems, known: !store.failed.has('problems'), checks: store.health?.checks ?? null, asking: needsYou() + extra });

// Home's first line, as HTML: the severity in words, the count of what needs the person, and a link
// to Health whenever Health is where the answer is.
const toHealth = '<a class="link" href="/health" data-nav="health">Health</a>';
function summary() {
  const n = needsYou();
  const w = working();
  if (!store.reachable) return esc('Nova isn’t answering right now.');
  const s = severityNow();
  const things = (k) => `${k === 1 ? 'One thing needs' : `${k} things need`} you`;
  if (s.level === 'stopped') return `${esc('Nova is stopped')}${s.needs ? `, and ${esc(things(s.needs).toLowerCase())}` : ''}; it’s in ${toHealth}.`;
  if (s.level === 'needs-you') return `${esc(things(s.needs))}${s.problems || s.lookChecks.length ? `; see ${toHealth}` : ''}.`;
  if (s.level === 'unknown') return `${esc('Nova couldn’t load its problems, so it can’t say nothing needs you')}; ${toHealth} can try again.`;
  if (n) return esc(`${things(n)}.`);
  if (w) return esc(`Nova is working on ${w === 1 ? 'one thing' : `${w} things`}.`);
  return esc('Nothing needs you.');
}

const cardState = () => ({ health: store.health, problems: store.problems, reachable: store.reachable, known: !store.failed.has('problems'), healthFailed: store.failed.has('health') });

const today = (now = new Date()) => now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function renderHome(el, now = new Date()) {
  // Before the first answer, the view waits (skeleton.js): never an empty state that isn't true.
  if (!store.loaded && !store.tried) { if (!el.querySelector('[data-skeleton], .view-waiting')) showWaiting('home', el, 'Loading Home', { total: INITIAL_PARTS.length, done: 0 }); return; }
  const name = store.identity?.address_as ?? store.identity?.user_name ?? '';
  const unread = store.messages.filter((m) => (m.hold === 'needs_ok' || (m.delivered_at && !m.read_at)));
  const asking = store.tasks.filter(asksYou);
  const verified = store.tasks.find((t) => t.state === 'done' && t.verification?.ok);
  const needsCard = asking.length
    ? card({ kind: 'needs-you-card', title: 'Needs you', icon: 'handling', body: `<ul class="task-list">${asking.slice(0, 3).map((t) => taskRow(t, { now })).join('')}</ul>` })
    : '';
  el.innerHTML = `${unread.slice(0, 2).map(proactiveBanner).join('')}
<header class="home-hero">${liveIcon('hero')}
  <h2 class="greeting">${esc(greeting(now, name))}</h2>
  <p class="greeting-sub" data-summary>${esc(today(now))} · ${summary()}</p>
</header>
<div class="home-cards">
  ${needsCard}
  ${briefCard({ known: store.loaded })}
  ${verified ? verifiedResultCard(verified, { now }) : ''}
  <div data-asideable>${handlingCard({ tasks: store.tasks, now, state: partState('tasks') })}</div>
  <div data-asideable>${deviceMeshCard({ devices: meshDevices(), now, state: partState('devices') })}</div>
  ${memoryHighlightCard({ records: store.memory, state: partState('memory') })}
  <div data-asideable>${healthCard(cardState())}</div>
</div>`;
}

// The right column (desktop) or context pane (tablet): three quiet cards. Drawn from the first
// moment, before any part has answered, so each says only what it knows (partState).
export function renderAside(el, now = new Date()) {
  el.innerHTML = `${handlingCard({ tasks: store.tasks, now, state: partState('tasks') })}
${deviceMeshCard({ devices: meshDevices(), now, state: partState('devices') })}
${healthCard(cardState())}`;
}

// ---- Tasks -------------------------------------------------------------------------------

const GROUPS = [
  ['needs-you', 'Needs you'],
  ['working', 'In progress'],
  ['waiting', 'Waiting'],
  ['verified', 'Done and checked'],
  ['failed', 'Didn’t finish'],
  ['quiet', 'Cancelled'],
];

// A part that has never loaded (F-021): said, never drawn as empty, with "Try again" for that part
// alone (app.js retry-part). Its waiting line while it is still on its way (F-023).
export const unloaded = (part, title) => `<div class="empty-state" data-unloaded="${esc(part)}" role="status"><p class="empty-title">${esc(title)}</p><p class="empty-sub">${esc('Nova’s server didn’t give this part, so this page can’t say what is in it.')}</p><button type="button" class="btn" data-action="retry-part" data-part="${esc(part)}">Try again</button></div>`;
const pending = (part, text) => waitingLine(text, { key: `view-${part}` });

// A view’s heading needs no data: it is there while the view waits (walker W-4), and the same
// heading once it is drawn.
// “Nothing is done until Nova has checked the evidence” is backed by the eval claim.verified-only-with-evidence (tests/evals/tasks/claim-backlog.ts).
const TASKS_HEAD = `<header class="view-head"><h2 class="view-title">Tasks</h2>
<p class="view-lede">Everything Nova takes on, in plain words. Nothing is done until Nova has checked the evidence; tap Verified to see it.</p></header>`;
const healthHead = (lede = '') => `<header class="view-head"><h2 class="view-title">Health</h2>${lede ? `
<p class="view-lede">${lede}</p>` : ''}</header>`;

export function renderTasks(el, now = new Date()) {
  if (!store.loaded && !store.tried) { if (!el.querySelector('[data-skeleton], .view-waiting')) showWaiting('tasks', el, 'Loading Tasks', { total: INITIAL_PARTS.length, done: 0, head: TASKS_HEAD }); return; }
  const by = new Map(GROUPS.map(([k]) => [k, []]));
  for (const t of store.tasks) by.get(statusOf(t))?.push(t);
  const groups = GROUPS.filter(([k]) => by.get(k).length).map(([k, title]) => `<section class="panel task-group" aria-labelledby="tg-${k}">
  <h2 class="section-title" id="tg-${k}">${esc(title)}</h2>
  <ul class="task-list">${by.get(k).map((t) => taskRow(t, { now })).join('')}</ul>
</section>`).join('');
  el.innerHTML = `${TASKS_HEAD}
${groups || (partFailed('tasks') ? unloaded('tasks', 'Tasks couldn’t be loaded') : emptyState({ title: 'Nothing needs you', line: 'No tasks yet. When Nova takes something on, it shows here until it’s verified.', action: '<a class="btn" href="/chat" data-nav="chat">Ask Nova to do something</a>' }))}`;
}

// One task in the sheet: the approval when it waits for one, else its evidence and history.
export async function openTask(id) {
  let t;
  let events = [];
  try {
    [t, events] = await Promise.all([api('GET', `/tasks/${encodeURIComponent(id)}`), api('GET', `/tasks/${encodeURIComponent(id)}/events`).catch(() => [])]);
  } catch (e) { toast(e.message); return; }
  if (needsApproval(t)) {
    // A coding run's check or merge (M10c): what was changed, tested and previewed, before the OK.
    const run = t.owner === 'coding' && t.brief?.inputs?.run_id ? await api('GET', `/coding/runs/${encodeURIComponent(t.brief.inputs.run_id)}`).catch(() => null) : null;
    if (run) { openSheet(codingSheet(t, run), { label: 'Needs your OK' }); return; }
    // An infrastructure apply or a network change (M10d): the plan in full, or the diff, first.
    const infra = t.owner === 'infra' && t.brief?.inputs?.step === 'apply' && t.brief?.inputs?.run_id ? await api('GET', `/infra/runs/${encodeURIComponent(t.brief.inputs.run_id)}`).catch(() => null) : null;
    if (infra) { openSheet(infraSheet(t, infra), { label: 'Needs your OK' }); return; }
    const change = t.owner === 'network' && t.brief?.inputs?.change_id ? await api('GET', `/network/changes/${encodeURIComponent(t.brief.inputs.change_id)}`).catch(() => null) : null;
    if (change) { openSheet(networkSheet(t, change), { label: 'Needs your OK' }); return; }
    const worker = store.workers.find((w) => w.id === t.owner) ?? null;
    openSheet(approvalSheet(t, { worker }), { label: 'Needs your OK' });
    return;
  }
  // A provider has finished and Nova asks before running the test on what it wrote. Only a task whose
  // history says so is asked about it (other waiting tasks, a browser waiting for a person, have none).
  const lastAsk = events.findLastIndex((e) => e.kind === 'test_run_asked');
  if (t.state === 'waiting' && lastAsk >= 0 && !events.slice(lastAsk).some((e) => e.kind === 'test_run_approved')) {
    const run = await api('GET', `/providers/tasks/${encodeURIComponent(id)}/test-run`).catch(() => null);
    if (run) {
      const worker = store.workers.find((w) => w.id === t.owner) ?? null;
      openSheet(approvalSheet(t, { worker, run }), { label: 'Needs your OK' });
      return;
    }
  }
  // A browser task with its browser open: the live view, where the person can take over.
  if (t.owner === 'browser' && isOpen(t)) {
    const view = await api('GET', `/browser/tasks/${encodeURIComponent(id)}`).catch(() => null);
    if (view?.live) {
      const you = store.mesh?.you;
      openTakeover(t, view, { me: you && !you.console ? `device:${you.device_id}` : 'console', canTake: you?.can_approve !== false, onEnd: () => afterBrowser(id) });
      return;
    }
  }
  const actions = [];
  if (t.state === 'waiting') actions.push(`<button type="button" class="btn primary" data-action="retry-task" data-task="${esc(t.id)}">${esc(retryLabel(t))}</button>`);
  if (isOpen(t)) actions.push(`<button type="button" class="btn" data-action="cancel-task" data-task="${esc(t.id)}">Cancel the task</button>`);
  const timeline = events.length ? `<details class="raw"><summary>What happened</summary><ul class="timeline">${events.map((e) => `<li data-kind="${esc(e.kind)}">${esc(new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))} · ${esc(e.kind.replace(/_/g, ' '))}${e.to_state ? ` → ${esc(e.to_state)}` : ''}${esc(eventDetail(e))}</li>`).join('')}</ul></details>` : '';
  openSheet(`${evidenceViewer(t)}${timeline}${actions.length ? `<div class="sheet-actions">${actions.join('')}</div>` : ''}`, { label: t.title });
}

// The few events whose detail the person needs in the timeline: who took over and for how long,
// what was refused, which step.
function eventDetail(e) {
  const d = e.detail ?? {};
  if (e.kind === 'takeover_started') return ` · ${d.who ?? d.by}${d.requested ? ', as Nova asked' : ''}`;
  if (e.kind === 'takeover_ended') return ` · ${d.who ?? d.by}, after ${Math.max(1, Math.round((d.duration_ms ?? 0) / 1000))} s`;
  if (e.kind === 'blocked_request') return ` · ${d.host}`;
  if (e.kind === 'step') return ` · ${d.n} of ${d.of}: ${d.what}`;
  return '';
}

// Once a browser task's browser closes, Nova checks the evidence; the sheet moves on to the
// result when that is in (a few seconds at most), or to whatever the task shows by then.
async function afterBrowser(id) {
  for (let i = 0; i < 20; i++) {
    const t = await api('GET', `/tasks/${encodeURIComponent(id)}`).catch(() => null);
    if (!t || !['active', 'verifying'].includes(t.state)) break;
    await new Promise((r) => setTimeout(r, 250)); // wait: poll: has Nova checked the evidence?
  }
  if (sheetOpen()) openTask(id);
}

export async function approve(form) {
  if (form.dataset.request) return approveJoin(form);
  if (form.dataset.rolesConfirm) return confirmRoles(form);
  if (form.dataset.revoke) return confirmRevoke(form);
  if (form.dataset.allow) return confirmAllow(form);
  if (form.dataset.promote) return confirmPromote(form);
  if (form.dataset.promotion) return confirmPromotion(form);
  if (form.dataset.coldPromotion) return confirmCold(form);
  if (form.dataset.promotionAction) return confirmPromotionAction(form);
  if (form.dataset.provider) return confirmProvider(form);
  if (form.dataset.testRun) return approveTestRun(form.dataset.testRun);
  const id = form.dataset.task;
  const tier = Number(form.dataset.tier);
  const confirm = form.querySelector('input[name="confirm"]');
  if (tier === 3 && !confirm?.checked) { confirm?.focus(); return; }
  try {
    await api('POST', `/tasks/${encodeURIComponent(id)}/approve`, tier === 3 ? { confirm: true } : {});
    closeSheet();
    toast('Approved. Nova carries on.');
    await load(['tasks']);
  } catch (e) { toast(e.message); }
}

async function approveTestRun(id) {
  try {
    await api('POST', `/providers/tasks/${encodeURIComponent(id)}/test-run`, {});
    closeSheet();
    toast('Approved. Nova runs the test.');
    await load(['tasks']);
  } catch (e) { toast(e.message); }
}

// Don't merge (M10c): the merge step is cancelled; the person's branch stays as it is.
export async function declineMerge(run) {
  try {
    await api('POST', `/coding/runs/${encodeURIComponent(run)}/decline`, {});
    closeSheet();
    toast('Not merged. Your branch is as it was.');
    await load(['tasks']);
  } catch (e) { toast(e.message); }
}

// Don't apply (M10d): an infrastructure run's or a network change's apply is cancelled; nothing changes.
export async function declineChange(path, said) {
  try {
    await api('POST', path, {});
    closeSheet();
    toast(said || 'Not applied.');
    await load(['tasks']);
  } catch (e) { toast(e.message); }
}

export async function taskAction(action, id) {
  try {
    const t = action === 'retry-task' ? await api('POST', `/tasks/${encodeURIComponent(id)}/retry`) : null;
    if (action === 'cancel-task') await api('POST', `/tasks/${encodeURIComponent(id)}/cancel`, { reason: 'Cancelled by you.' });
    await load(['tasks']);
    // Running it again needs the person's OK again: straight to asking for it.
    if (t && needsApproval(t)) return openTask(id);
    closeSheet();
    toast(action === 'retry-task' ? 'Trying again.' : 'Cancelled.');
  } catch (e) { toast(e.message); }
}

// ---- Health -------------------------------------------------------------------------------

function checkLine(key, c) {
  if (key === 'workers') return c.ok ? `${c.workers?.length ?? 0} ready.` : c.detail;
  if (key === 'ledger') return Object.entries(c.counts ?? {}).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'No tasks yet.';
  if (key === 'design') return `Showing ${appearance().list.find((d) => d.id === c.active)?.name ?? c.active}.`;
  if (key === 'problems') return c.open ? `${c.open} open.` : 'None open.';
  // Outside content: how it is screened, then one plain line per decision seat (DS1 NOTE 4).
  if (key === 'ingest') return [c.detail, ...(c.lines ?? [])].filter(Boolean).join(' ');
  if (key === 'mesh') return `${c.counts.trusted} paired${c.counts.revoked ? `, ${c.counts.revoked} revoked` : ''}. ${c.listening ? 'Other devices can reach Nova.' : 'Other devices can’t reach Nova: no mesh address.'} ${meshRoleLine(c)}`;
  if (c.counts) return Object.entries(c.counts).filter(([, n]) => typeof n === 'number' && n).map(([s, n]) => `${n} ${s.replace(/_/g, ' ').replace(/s$/, n === 1 ? '' : 's')}`).join(', ') || 'Nothing yet.';
  return c.detail ?? (c.ok ? 'Fine.' : 'Not fine.');
}

// Hub or standby, and how far the copy is behind: the standby's lag on the hub, the hub on the standby.
function meshRoleLine(c) {
  if (c.role !== 'hub' && c.replica) {
    const s = c.replica.sync;
    const copied = s?.last_ok_at ? `Last copied ${ago(s.last_ok_at)}.` : 'Nothing copied yet.';
    return `${c.replica.reason} ${s?.unreachable_since ? `It hasn’t reached the hub since ${ago(s.unreachable_since)}. ` : s?.refused ? `${s.refused} ` : ''}${copied}`;
  }
  if (!c.standby) return `This is the hub (epoch ${c.epoch}). No standby is paired.`;
  const l = c.standby.lag;
  const lag = !l?.acked_at && l?.rows ? 'it hasn’t copied anything yet' : l?.rows ? `${l.rows} ${l.rows === 1 ? 'change' : 'changes'} behind${l.behind ? `, nothing taken for ${l.seconds} s` : ''}` : 'caught up';
  return `This is the hub (epoch ${c.epoch}). The standby “${c.standby.name}” is ${lag}.`;
}

// Health's editor is an island inside the existing surface renderer. No second limits store:
// `draft` holds only strings/checkbox intent; saved limits and spend always come from Caps.
let capsSequence = 0;
const costs = { draft: null, invalid: {}, dirty: false, revision: 0, pending: false, state: 'ready', error: '' };
const costNames = ['task.iterations', 'task.tokens', 'task.usd', 'day.iterations', 'day.tokens', 'day.usd'];
const costsChanged = () => window.dispatchEvent(new CustomEvent('nova:work-costs'));
const costsState = () => store.capsState === 'unavailable' ? 'unavailable' : costs.pending ? 'saving' : costs.state === 'save-error' ? 'save-error' : store.capsState === 'loading' ? 'loading' : costs.state;
const costsAvailable = () => !!store.caps && ['ready', 'refreshing'].includes(store.capsState);
function syncCostsForm(form) {
  if (store.caps && !costs.dirty && !costs.pending && store.capsState === 'ready') {
    const previous = costs.draft;
    costs.draft = Object.fromEntries(costNames.map(name => {
      const [scope, key] = name.split('.');
      const value = store.caps.limits[scope][key];
      return [name, { value: value === null ? previous?.[name]?.value ?? '' : String(value), unlimited: value === null }];
    }));
  }
  for (const name of costNames) {
    const field = form.elements.namedItem(name);
    const checkbox = form.elements.namedItem(`${name}.unlimited`);
    const draft = costs.draft?.[name];
    // Assign only changed values: assigning a focused input can reset its caret on WebKit.
    if (draft && field.value !== draft.value) field.value = draft.value;
    if (draft) checkbox.checked = draft.unlimited;
    const locked = !costsAvailable();
    field.disabled = locked || checkbox.checked;
    checkbox.disabled = locked;
    const errorId = `${field.id}-error`;
    form.querySelector(`[id="${errorId}"]`)?.remove();
    field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby');
    if (costs.invalid[name]) {
      field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', errorId);
      const line = document.createElement('p'); line.id = errorId; line.className = 'card-line work-limit-error';
      line.textContent = costs.invalid[name]; field.parentElement.append(line);
    }
  }
  if (store.capsState === 'refreshing' && !costs.pending && costs.state !== 'save-error') form.querySelector('[data-work-costs-notice]').innerHTML = waitingLine('Refreshing work costs and limits', { key: 'health-costs', tag: 'span' });
  if (costs.state === 'success' && costs.dirty && !costs.pending) form.querySelector('[data-work-costs-notice]').textContent = 'Submitted limits saved on this node. Your newer edits are not saved yet.';
  form.querySelector('[data-save-work-limits]').disabled = !costsAvailable() || costs.pending || Object.keys(costs.invalid).length > 0;
}
export function editWorkCosts(form) {
  const draft = Object.fromEntries(costNames.map(name => [name, { value: form.elements.namedItem(name).value, unlimited: form.elements.namedItem(`${name}.unlimited`).checked }]));
  // Browsers emit both input and change, sometimes around submission. An unchanged
  // trailing event is not a new edit and must not erase validation or a save refusal.
  if (costs.draft && costNames.every(name => draft[name].value === costs.draft[name].value && draft[name].unlimited === costs.draft[name].unlimited)) return;
  costs.draft = draft;
  costs.dirty = true; costs.revision++; costs.invalid = {}; costs.state = 'ready'; costs.error = '';
  costsChanged();
}
export async function retryWorkCosts() { costs.state = 'ready'; costs.error = ''; await load(['caps']); costsChanged(); }
export async function saveWorkCosts() {
  if (costs.pending || !costsAvailable() || !costs.draft) return;
  const submitted = { task: {}, day: {} };
  costs.invalid = {};
  for (const name of costNames) {
    const [scope, key] = name.split('.');
    const draft = costs.draft[name];
    const value = Number(draft.value);
    if (!draft.unlimited && (!draft.value.trim() || !Number.isFinite(value) || value <= 0 || (key !== 'usd' && !Number.isInteger(value)))) costs.invalid[name] = key === 'usd' ? 'Enter a finite number greater than zero, or choose Unlimited.' : 'Enter a positive whole number, or choose Unlimited.';
    submitted[scope][key] = draft.unlimited ? null : value;
  }
  if (Object.keys(costs.invalid).length) { costsChanged(); return; }
  costs.pending = true; costs.error = ''; begin('health-costs-save'); costsChanged();
  const revision = costs.revision;
  let validated = false;
  try {
    // Revalidate live access/freshness at the mutation boundary; another endpoint is no proof.
    const check = await request('GET', '/caps');
    if (check.stale) { store.capsState = 'unavailable'; store.capsError = 'Work costs were saved earlier. Reconnect and retry before saving limits.'; throw new Error(store.capsError); }
    store.caps = check.data; validated = true;
    const response = await request('PUT', '/caps/limits', submitted);
    if (response.stale) throw new Error('The server has not confirmed these limits. Retry before saving again.');
    // Invalidate any older in-flight GET so it cannot overwrite a completed save.
    capsSequence++; store.caps = response.data.view; store.capsState = 'ready';
    costs.state = 'success'; costs.dirty = costs.revision !== revision;
  } catch (e) {
    costs.state = 'save-error'; costs.error = e.message;
    // An access or read failure must not leave the prior cached answer editable.
    if (!validated || e.status === 401 || e.status === 403 || e instanceof Unreachable || !store.caps) { capsSequence++; store.capsState = 'unavailable'; store.capsError = e.message; }
  } finally { costs.pending = false; over('health-costs-save'); costsChanged(); }
}

// Replace facts around a live child, without disconnecting that child or its ancestors.
// This is deliberately bounded to Health's editor, not a whole-app DOM reconciler.
function aroundCosts(current, next, island, placeholder) {
  for (const node of [...current.childNodes]) if (node !== island) node.remove();
  let after = false;
  for (const node of [...next.childNodes]) {
    if (node === placeholder) { after = true; continue; }
    current.insertBefore(node, after ? null : island);
  }
}

// GET /api/v1/version as one line: which commit is running and whether it's the latest merged, then
// when it was built, or, when the launcher didn't say, when it started (never one passed off as the other).
const utc = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
export const buildStamp = (v) => (v ? `<p class="settings-note" data-build-stamp>${esc(v.words)} ${v.built_at ? `Built ${esc(utc(v.built_at))}.` : v.started_at ? `Started ${esc(utc(v.started_at))}.` : ''}</p>` : '');

// Settings › About Nova: the version and the build stamp, and the doors to About and its two pages.
export function renderAboutSettings() {
  const v = store.version;
  return `<section class="memory-section" id="about" aria-labelledby="set-about"><h2 class="memory-heading" id="set-about">About Nova</h2>
<p class="memory-lede">${v ? `Nova ${esc(v.version)}.` : 'Which Nova this is, and what changed.'}</p>${buildStamp(v)}
<div class="connection-actions"><a class="btn small" href="/about">Open About Nova</a><a class="btn small quiet" href="/changelog">What’s new</a><a class="btn small quiet" href="/pipeline">Where Nova stands</a></div></section>`;
}

// What Health shows above its fold, read in the first load. Its costs are read when it opens and
// are its own panel's wait (a Caps-only failure belongs to that panel, not the whole view).
const HEALTH_PARTS = ['problems', 'health', 'resilience'];
export function renderHealth(el) {
  // Until those parts have answered (or failed), Health waits as one view under its heading: panels
  // drawn early would be pushed down when the problems and their playbooks land (walker W-6, CLS).
  if (!HEALTH_PARTS.every(partSettled)) { if (!el.querySelector('[data-skeleton], .view-waiting')) showWaiting('health', el, 'Loading Health', { head: healthHead() }); return; }
  const retained = el.querySelector('[data-work-limits]');
  const opened = [...el.querySelectorAll('.work-costs details, .diagnostics-download details')].map(d => d.open);
  const h = store.health;
  // One column at every width: the problem's actions sit in its own card, under the steps they
  // finish, never in a column of their own beside it (owner, 2026-11-08, the Duo cover screen).
  const problem = (p, open) => {
    const resolve = open ? `<button type="button" class="btn small" data-action="resolve-problem" data-problem="${esc(String(p.id))}">Mark as dealt with</button>` : '';
    const pb = open ? playbookBlock(p, resolve) : '';
    return `<li class="settings-row problem-row" id="pr-${esc(String(p.id))}">
  <div class="settings-text"><p class="settings-label">${esc(p.message)}</p><p class="settings-note">${open ? `${status(p.stops ? 'failed' : 'needs-you')} ` : ''}${esc(p.source)} · ${esc(ago(p.at))}${p.task_id ? ` · <a class="link" href="/tasks" data-action="open-task" data-task="${esc(p.task_id)}">the task</a>` : ''}</p>
  ${pb || (resolve ? `<div class="problem-actions">${resolve}</div>` : '')}
  ${p.detail ? `<details class="raw"><summary>Technical detail</summary><pre tabindex="0">${esc(p.detail)}</pre></details>` : ''}</div>
</li>`;
  };
  const fine = (k, c) => c.ok && !c.attention && !(k === 'passkeys' && !c.complete) && !(k === 'mesh' && (c.standby?.lag?.behind || c.replica?.sync?.unreachable_since || c.replica?.sync?.refused));
  const checks = h ? Object.entries(h.checks).map(([k, c]) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(CHECK_NAMES[k] ?? k)}</p><p class="settings-note">${esc(checkLine(k, c))}${k === 'mesh' ? ' <a class="link" href="/topology">View machines and services</a>' : ''}</p></div>${fine(k, c) ? '<span class="pill is-on">Fine</span>' : '<span class="pill is-warn">Needs a look</span>'}</li>`).join('') : '';
  const next = document.createElement('div');
  // The lede says the same severity as the mark, the badge and Home (status.js severity; D5).
  const s = severityNow();
  const lede = !store.reachable ? 'Nova isn’t answering. This page reconnects when it’s back.'
    : s.level === 'stopped' ? 'Nova is stopped. The problem marked Failed says why; the detail is one tap away.'
      : store.problems.length ? 'Nova is running, and something needs you. Each problem says what happened; the detail is one tap away.'
        : s.level === 'unknown' ? 'Nova couldn’t load its list of problems, so this page can’t say nothing is wrong.'
          : 'Everything Nova runs on, and anything that went wrong.';
  // Problems: the list, its empty state only once it was read (F-021, F-023), or why it isn't here.
  const problems = store.problems.length ? `<ul class="settings-list">${store.problems.map((p) => problem(p, true)).join('')}</ul>`
    : partFailed('problems') ? unloaded('problems', 'Problems couldn’t be loaded')
      : !partSettled('problems') ? pending('problems', 'Loading problems')
        : emptyState({ title: 'Nothing needs you', line: 'No problems are open.' });
  // Checks: the reading, a wait while it is on its way, or (failed or overdue) why not, with a retry.
  const checksBody = h ? `<ul class="settings-list">${checks}</ul><p class="settings-note">Version ${esc(h.version)} · running for ${esc(uptime(h.uptime_s))}.</p>${buildStamp(store.version)}`
    : partFailed('health') ? unloaded('health', 'Health checks couldn’t be loaded')
      : waitingLine('Checking Nova’s health', { key: 'health' });
  next.innerHTML = `${healthHead(lede)}
<section class="panel" aria-labelledby="h-problems"><h3 class="section-title" id="h-problems">Problems</h3>
${problems}</section>
${keepingRunning()}
<div class="panel"><h3 class="section-title" id="h-work-costs">Work costs</h3>${workCosts({ view: store.caps, state: costsState(), error: costs.error, invalid: costs.invalid })}${store.capsState === 'unavailable' ? `<p class="settings-note" role="status">${esc(store.capsError)}</p><button class="btn" type="button" data-retry-work-costs>Retry work costs</button>` : ''}</div>
<div class="panel"><h3 class="section-title" id="h-diagnostics">Diagnostics</h3>${diagnosticsDownload({ available: !!store.health && store.reachable, why: store.reachable ? 'health' : 'unreachable' })}</div>
<section class="panel" aria-labelledby="h-checks"><h3 class="section-title" id="h-checks">Checks</h3>
${checksBody}</section>
${store.resolved.length ? `<details class="panel raw"><summary>Dealt with recently</summary><ul class="settings-list">${store.resolved.map((p) => problem(p, false)).join('')}</ul></details>` : ''}`;
  const fresh = next.querySelector('[data-work-limits]');
  if (retained) {
    retained.querySelector('[data-work-costs-notice]').replaceWith(fresh.querySelector('[data-work-costs-notice]'));
    const currentCosts = retained.parentElement;
    const nextCosts = fresh.parentElement;
    const panel = currentCosts.parentElement;
    const nextPanel = nextCosts.parentElement;
    aroundCosts(currentCosts, nextCosts, retained, fresh);
    currentCosts.dataset.workCostsState = nextCosts.dataset.workCostsState;
    aroundCosts(panel, nextPanel, currentCosts, nextCosts);
    aroundCosts(el, next, panel, nextPanel);
  } else el.replaceChildren(...next.childNodes);
  syncCostsForm(el.querySelector('[data-work-limits]'));
  [...el.querySelectorAll('.work-costs details, .diagnostics-download details')].forEach((d, i) => { d.open = opened[i] ?? false; });
}

// A problem's playbook (M7b): what Nova already did about it, and the steps that are the person's,
// then its actions in one row: the repair, and `resolve` (Mark as dealt with) beside it.
// The same event several times in a row is one line with its count (playbookEvents).
function playbookBlock(p, resolve = '') {
  const pb = store.resilience?.playbooks?.[p.id];
  if (!pb) return '';
  // A repair that said it worked isn’t “fixed” until its independent check sees it (owner,
  // 2026-11-11): “Repaired, checking” until then, and said plainly when the check saw it didn’t hold.
  const checking = (r) => r.verified === null ? ` Repaired, checking: this closes when ${pb.check ?? 'Nova checks it again'}.` : r.verified === false ? ` It didn’t hold: ${r.checked ?? 'the check after it still saw the problem.'}` : '';
  const did = playbookEvents(pb.repairs).map((r) => `<li>${esc(r.said)}${esc(checking(r))} <span class="playbook-when">${r.count > 1 ? `${r.count} times, last ` : ''}<time datetime="${esc(r.at)}">${esc(ago(r.at))}</time></span></li>`).join('');
  const repair = pb.repair ? `<button type="button" class="btn small" data-action="repair-problem" data-problem="${esc(String(p.id))}">Try the repair now</button>` : '';
  return `<div class="playbook" data-playbook="${esc(pb.id)}">
  ${did ? `<p class="settings-note"><b>What Nova did</b></p><ul class="steps">${did}</ul>` : pb.automatic ? `<p class="settings-note">${esc(pb.automatic)}</p>` : ''}
  <p class="settings-note"><b>What you can do</b></p><ol class="steps">${pb.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  ${repair || resolve ? `<div class="problem-actions">${repair}${resolve}</div>` : ''}
</div>`;
}

const MODE_WORDS = { starting: 'Starting', running: 'Running', restarting: 'Restarting after a crash', safe_mode: 'Held in safe mode', deploying: 'Deploying a release', stopped: 'Stopped' };
const releaseName = (v) => (!v ? 'none' : v === 'base' ? 'as installed' : v);

// The supervisor, releases (and a canary in progress), backups and the last restore drill: one
// calm list of facts; the one thing that may need the person (a failed drill, a missing backup
// folder) is a problem above, not a second alarm here.
function keepingRunning() {
  const r = store.resilience;
  if (!r) return '';
  const sup = r.supervisor;
  const rel = r.releases;
  const b = r.backups;
  const d = r.drill;
  const dep = rel?.deploy;
  const canary = dep && dep.outcome === 'running' && dep.canary ? `<p class="settings-note" data-canary>Canary for ${esc(dep.version)}: ${dep.canary.probes.length} probe${dep.canary.probes.length === 1 ? '' : 's'} so far${dep.canary.probes.length ? `, the last: ${esc(dep.canary.probes.at(-1).said)}` : ''}. It rolls back by itself if health fails before ${esc(new Date(dep.canary.until).toLocaleTimeString())}.</p>` : '';
  const lastDeploy = dep && dep.outcome !== 'running' ? `${esc(dep.version)}: ${esc({ promoted: 'live', rolled_back: 'rolled back by itself', stopped: 'stopped before the switch', refused: 'going back was refused' }[dep.outcome] ?? dep.outcome)}, ${esc(ago(dep.started_at))}` : '';
  const backupLine = !b.settings.target ? 'No backup folder yet. Choose one in Settings › Backups; Nova then backs up nightly and drills weekly.'
    : b.target_present === false ? `The backup folder ${b.settings.target} isn’t there (a drive not plugged in?).${b.last_ok ? ` Last backup ${ago(b.last_ok.at)}.` : ''}`
    : b.last_ok ? `Last backup ${ago(b.last_ok.at)}, to ${b.settings.target} (not encrypted). ${b.count} kept (up to ${b.settings.keep}).${b.encrypted !== null ? ` ${b.encrypted} encrypted cop${b.encrypted === 1 ? 'y' : 'ies'} in ${b.settings.encrypted_target}.` : ' No encrypted copy: set an encrypted copy folder for one.'}`
    : `Nothing backed up yet to ${b.settings.target}.`;
  // Named like a backup but not made by this Nova (or changed since): never used, said once here.
  const strays = b.strays?.length ? ` ${b.strays.length} folder${b.strays.length === 1 ? '' : 's'} there look${b.strays.length === 1 ? 's' : ''} like a backup but ${b.strays.length === 1 ? 'isn’t' : 'aren’t'} one Nova made; Nova leaves ${b.strays.length === 1 ? 'it' : 'them'} alone and never restores from ${b.strays.length === 1 ? 'it' : 'them'}.` : '';
  const drillLine = !d ? 'No restore drill yet.' : `${d.ok ? 'Passed' : 'Failed'} ${ago(d.at)}: ${d.checks.filter((c) => c.ok).length} of ${d.checks.length} checks.`;
  return `<section class="panel" aria-labelledby="h-keep"><h3 class="section-title" id="h-keep">Keeping Nova running</h3>
<dl class="facts" data-resilience>
  <dt>Supervisor</dt><dd>${sup ? `${esc(MODE_WORDS[sup.mode] ?? sup.mode)}${sup.server?.restarts ? `; restarted ${sup.server.restarts} time${sup.server.restarts === 1 ? '' : 's'}` : ''}.${sup.safe_mode ? ` ${esc(sup.safe_mode.reason)}` : ''}` : 'Not running under the supervisor. node src/supervisor/main.ts run keeps Nova running and takes releases.'}</dd>
  ${rel ? `<dt>Release</dt><dd>${esc(releaseName(rel.current))}${rel.previous ? `; ${esc(releaseName(rel.previous))} is kept to go back to` : ''}.${lastDeploy ? ` Last deploy: ${lastDeploy}.` : ''}</dd>` : ''}
  <dt>Backups</dt><dd>${esc(backupLine + strays)} <a class="link" href="/settings#backups">Backup settings</a> <a class="link" href="/docs/restore" data-restore-doc>How to restore a backup</a></dd>
  <dt>Restore drill</dt><dd>${esc(drillLine)}${d?.task_id ? ` <a class="link" href="/tasks" data-action="open-task" data-task="${esc(d.task_id)}">Its evidence</a>` : ''}</dd>
  ${r.clock?.held ? `<dt>Clock</dt><dd>${esc(r.clock.held)}</dd>` : ''}
</dl>
${canary}
${b.settings.target ? `<p class="row-actions"><button type="button" class="btn small" data-action="backup-now">Back up now</button> <button type="button" class="btn small" data-action="drill-now">Run the restore drill</button></p>` : ''}
</section>`;
}

// Back up now, run the drill, or a problem's repair: each a ledger task or a recorded attempt.
export async function resilienceAction(action, id) {
  try {
    if (action === 'backup-now') { await api('POST', '/backups'); toast('Backing up now. It shows in Tasks.'); }
    if (action === 'drill-now') { await api('POST', '/backups/drill'); toast('Running the restore drill. It shows in Tasks.'); }
    if (action === 'repair-problem') { const r = await api('POST', `/problems/${encodeURIComponent(id)}/repair`); toast(r.checking ? `${r.said} Repaired, checking: it closes once Nova’s own check sees it.` : r.said); }
  } catch (e) { toast(e.message); }
}

const uptime = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

// ---- automation rules (above Era 2's schedules) -------------------------------------------

export function renderRules(el) {
  // Never "No rules yet" before the rules have been read, or when they couldn't be (F-021, F-023).
  const body = store.rules.length ? `<ul class="trigger-list">${store.rules.map(triggerRow).join('')}</ul>`
    : partFailed('rules') ? unloaded('rules', 'Rules couldn’t be loaded')
      : !partSettled('rules') ? pending('rules', 'Loading rules')
        : '<p class="settings-note">No rules yet. Rules start work or send a message when something happens or on a schedule.</p>';
  el.innerHTML = `<header class="view-head"><h2 class="view-title">Automations</h2>
<p class="view-lede">Rules Nova runs on its own. Each can be paused or removed.</p></header>
<section class="panel" aria-labelledby="ru-title"><h3 class="section-title" id="ru-title">Rules</h3>
${body}</section>`;
}

export async function ruleAction(action, id) {
  try {
    if (action === 'pause-rule') await api('POST', `/triggers/rules/${encodeURIComponent(id)}/pause`);
    if (action === 'resume-rule') await api('POST', `/triggers/rules/${encodeURIComponent(id)}/resume`);
    if (action === 'delete-rule') await api('DELETE', `/triggers/rules/${encodeURIComponent(id)}`);
    await load(['rules']);
    toast(action === 'pause-rule' ? 'Paused. It won’t run until you resume it.' : action === 'resume-rule' ? 'Resumed.' : 'Removed. Its past firings stay in the record.');
  } catch (e) { toast(e.message); }
}

// ---- Settings: you and Nova, privacy, appearance, devices -------------------------------------

// Backups has its own freshness. A failed read never marks all Core endpoints offline.
// Plaintext lives only in this closure and the dedicated visible recovery section.
const backups = { settings: null, draft: null, state: 'loading', errors: {}, notice: '', recovery: { state: 'hidden' }, loadingSince: null, fresh: false };
let backupsChanged = () => {};
let backupsActive = false;
let backupsEpoch = 0;
let backupsRevision = 0;
let backupsPending = false;
let backupsLoading = null;
// A successful background read does not resolve an unsuccessful save of the retained draft, nor
// erase what a finished save said: a read the save itself set off can answer after it (#484).
let backupsSaveFailure = '';
let backupsSaved = '';
const backupSettingsOnly = (s) => ({ target: s.target ?? null, keep: s.keep ?? 7, encrypted_target: s.encrypted_target ?? null });
function backupsPermissions() {
  const m = store.mesh;
  const known = store.meshFresh && !!m?.you && typeof m.you.console === 'boolean' && typeof m.you.can_approve === 'boolean';
  const readOnlyReason = !known ? 'Backup settings are read-only until this device’s permissions are available.'
    : m.replica || m.role === 'replica' ? 'This is a standby. Change backup settings on the hub.'
    : !backups.fresh ? 'Backup settings could not be refreshed. Try again before making changes.'
    : !m.you.can_approve ? 'Only an approver can change backup settings. Use Nova’s console or an approving device.' : '';
  return { canEdit: !readOnlyReason, console: known && m.you.console === true, readOnlyReason };
}
export function hideBackupsKey() {
  backupsEpoch++;
  backups.recovery = { state: 'hidden' };
  backupsChanged();
}
export function leaveBackups() { backupsActive = false; hideBackupsKey(); }
export function enterBackups() { backupsActive = true; }
let backupsLastPermissions = null;
function syncBackupsPermissions() {
  const p = backupsPermissions();
  if (!store.meshFresh && backups.draft && !backupsPending) {
    backups.state = 'error';
    backups.notice = 'Device permissions could not be refreshed. Try again.';
  }
  if (!p.canEdit || (backupsLastPermissions?.console && !p.console)) hideBackupsKey();
  backupsLastPermissions = p;
}
// Reads that overlap share one. Try again never does: a read already on its way began before the
// person asked, and its answers (a failed mesh check) may be the very ones they are retrying, so
// Try again asks once more after it.
export function loadBackups({ again = false } = {}) {
  if (backupsLoading) return again ? backupsLoading.then(() => loadBackups()) : backupsLoading;
  backups.loadingSince = Date.now();
  backupsChanged();
  backupsLoading = Promise.all([request('GET', '/backups'), load(['mesh'])]).then(([r]) => {
    backups.settings = backupSettingsOnly(r.data.settings);
    backups.draft ??= { ...backups.settings };
    backups.fresh = !r.stale;
    if (!backupsPending) {
      const live = backups.fresh && store.meshFresh;
      backups.state = live && !backupsSaveFailure ? 'ready' : 'error';
      backups.notice = live ? backupsSaveFailure || backupsSaved : 'Backup settings or device permissions could not be refreshed. Try again.';
    }
  }).catch(() => {
    backups.fresh = false;
    backups.state = 'error';
    backups.notice = 'Backup settings could not be loaded. Try again.';
    backups.draft ??= { target: '', keep: 7, encrypted_target: '' };
  }).finally(() => {
    backupsLoading = null;
    syncBackupsPermissions();
    backupsChanged();
  });
  return backupsLoading;
}
export function drawBackups(box) {
  const next = document.createElement('template');
  next.innerHTML = renderBackupsSettings({ ...backups, settings: backups.draft ?? {}, permissions: backupsPermissions(), recovery: { ...backups.recovery, previouslyShown: !!store.profile?.backups?.recovery_shown } }, { id: 'backups' });
  // Keep native input nodes (including number-input lexical buffers), focus and caret through
  // ordinary SSE, request state and errors. Permissions still update immediately under focus.
  const active = document.activeElement;
  const focused = box.contains(active) ? active : null;
  const focusAction = focused?.dataset.action;
  const focusInput = focused?.matches('input[name]') ? focused.name : null;
  for (const input of box.querySelectorAll('input[name="target"], input[name="keep"], input[name="encrypted_target"]')) {
    const replacement = next.content.querySelector(`input[name="${input.name}"]`);
    if (!replacement) continue;
    const desired = replacement.value;
    for (const attr of [...input.attributes]) if (!replacement.hasAttribute(attr.name)) input.removeAttribute(attr.name);
    for (const attr of replacement.attributes) if (attr.name !== 'value') input.setAttribute(attr.name, attr.value);
    if (input.value !== desired && input !== active) input.value = desired;
    replacement.replaceWith(input);
  }
  box.replaceChildren(next.content);
  if (focused?.isConnected && !focused.disabled) focused.focus({ preventScroll: true });
  else if (focusAction) box.querySelector(`[data-action="${focusAction}"]`)?.focus({ preventScroll: true });
  else if (focusInput) box.querySelector(`input[name="${CSS.escape(focusInput)}"]:not(:disabled)`)?.focus({ preventScroll: true });
}
async function requireBackupsPermission(consoleOnly = false) {
  await load(['mesh']);
  syncBackupsPermissions();
  const p = backupsPermissions();
  if (!backupsActive || !p.canEdit || (consoleOnly && !p.console)) throw new Error('This device cannot make that change. Check its permissions and try again.');
}
async function saveBackups(clear = null) {
  if (backupsPending || !backupsPermissions().canEdit || !backupsActive) return;
  const draft = { ...backups.draft };
  const body = { target: draft.target, keep: Number(draft.keep), encrypted_target: draft.encrypted_target };
  const errors = {};
  if (!/^\d+$/.test(String(draft.keep)) || !Number.isInteger(body.keep) || body.keep < 1 || body.keep > 365) errors.keep = 'Enter a whole number from 1 to 365.';
  for (const field of ['target', 'encrypted_target']) {
    if (String(body[field] ?? '').trim() === '') {
      if (backups.settings?.[field] && !clear) errors[field] = 'Use Remove to stop using the saved folder.';
      else body[field] = null;
    }
  }
  if (clear === 'target') { body.target = null; body.encrypted_target = null; delete errors.target; delete errors.encrypted_target; }
  if (clear === 'encrypted_target') { body.encrypted_target = null; delete errors.encrypted_target; }
  if (body.encrypted_target && !body.target) errors.encrypted_target = 'Choose a backup folder first.';
  if (body.encrypted_target && body.encrypted_target === body.target) errors.encrypted_target = 'Choose a different folder for encrypted copies.';
  backups.errors = errors;
  if (Object.keys(errors).length) { backups.state = 'error'; backupsSaved = ''; backupsSaveFailure = backups.notice = 'Check the backup settings below.'; backupsChanged(); return; }
  backupsPending = true;
  backups.state = 'saving'; backupsSaved = backupsSaveFailure = backups.notice = '';
  const epoch = backupsEpoch, revision = backupsRevision;
  backupsChanged();
  try {
    await requireBackupsPermission();
    const result = await api('PUT', '/backups/settings', body);
    backups.settings = backupSettingsOnly(result);
    if (revision === backupsRevision) backups.draft = { ...backups.settings };
    if (result.recovery_key && epoch === backupsEpoch && backupsActive && backupsPermissions().canEdit) backups.recovery = { state: 'first-shown', key: result.recovery_key };
    backups.state = 'ready'; backupsSaved = backups.notice = 'Backup settings saved.';
    // GET never populates recovery state. Refresh shared Health facts and shown metadata only.
    await load(['profile', 'resilience']);
  } catch (e) {
    backups.state = 'error'; backupsSaveFailure = backups.notice = e.message;
  } finally { backupsPending = false; syncBackupsPermissions(); backupsChanged(); }
}
async function revealBackupsKey() {
  if (backupsPending || !backupsActive || backups.recovery.state !== 'confirm' || !backups.recovery.confirmed || !backupsPermissions().console || !backupsPermissions().canEdit) return;
  const epoch = backupsEpoch;
  backupsPending = true; backups.state = 'saving'; backupsChanged();
  try {
    await requireBackupsPermission(true);
    // Cancellation/navigation while the permission read was pending cancels the reveal itself.
    if (epoch !== backupsEpoch) return;
    const r = await api('POST', '/backups/recovery-key', { confirm: true });
    if (epoch === backupsEpoch && backupsActive && backupsPermissions().canEdit && backupsPermissions().console) backups.recovery = { state: 'shown', key: r.recovery_key };
  } catch {
    if (epoch === backupsEpoch) backups.recovery = { state: 'unavailable', error: 'The recovery key is unavailable. Check the connection and try again from the console.' };
  } finally { backupsPending = false; backups.state = 'ready'; syncBackupsPermissions(); backupsChanged(); }
}
export function bindBackups(root, changed) {
  backupsChanged = changed;
  root.addEventListener('input', (e) => {
    if (!e.target.closest('#settings-backups')) return;
    if (['target', 'keep', 'encrypted_target'].includes(e.target.name)) { backups.draft[e.target.name] = e.target.value; backupsRevision++; }
  });
  root.addEventListener('change', (e) => {
    if (e.target.closest('#settings-backups') && e.target.name === 'confirm') { backups.recovery.confirmed = e.target.checked; backupsChanged(); }
  });
  root.addEventListener('submit', (e) => { if (e.target.closest('#settings-backups')) { e.preventDefault(); saveBackups(); } });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('#settings-backups [data-action]');
    if (!b || b.disabled) return;
    const action = b.dataset.action;
    if (action === 'backups-hide' || action === 'backups-cancel') hideBackupsKey();
    else if (action === 'backups-reveal' && backupsPermissions().canEdit && backupsPermissions().console) { hideBackupsKey(); backups.recovery = { state: 'confirm', confirmed: false }; backupsChanged(); }
    else if (action === 'backups-confirm') revealBackupsKey();
    else if (action === 'backups-retry') loadBackups({ again: true });
    else if (action === 'backups-clear-target') saveBackups('target');
    else if (action === 'backups-clear-encrypted') saveBackups('encrypted_target');
    else if (action === 'backups-copy' && e.isTrusted && backupsActive && backupsPermissions().canEdit && ['first-shown', 'shown'].includes(backups.recovery.state) && backups.recovery.key) {
      // The native clipboard is called only in this explicit click, without a hidden fallback.
      navigator.clipboard?.writeText(backups.recovery.key).catch(() => { backups.recovery.error = 'The key could not be copied. Select it to copy it yourself.'; backupsChanged(); });
    }
  });
  window.addEventListener('nova:devices', () => { syncBackupsPermissions(); backupsChanged(); });
}

const PRIVACY = [
  ['local-only', 'Local-only', 'Model calls stay on your own devices.'],
  ['local-preferred', 'Local first', 'Nova’s own model work runs on your devices first; cloud help only when local isn’t enough, and recorded. Chat goes where its chat model sends it, below.'],
  ['cloud-allowed', 'Cloud allowed', 'Nova may use cloud services within your policy.'],
];
const DIRECTNESS = [['gentle', 'Gently'], ['balanced', 'Plainly'], ['blunt', 'Bluntly']];

export function renderYou() {
  const i = store.identity ?? {};
  const field = (id, value, labelText) => `<label class="sr-only" for="${id}">${esc(labelText)}</label><input class="input" id="${id}" value="${esc(value ?? '')}" maxlength="40" autocomplete="off">`;
  return `<section class="memory-section" id="you" aria-labelledby="set-you"><h2 class="memory-heading" id="set-you">You and Nova</h2>
<ul class="settings-list">
${settingsRow({ id: 'you-name-row', title: 'Your name', note: 'What Nova calls you.', control: `${field('you-name', i.user_name, 'Your name')}<button type="button" class="btn small" data-action="save-profile" data-section="user" data-key="name" data-field="you-name">Save</button>` })}
${settingsRow({ id: 'nova-name-row', title: 'Nova’s name', note: 'Only the name changes; the charter stays.', control: `${field('nova-name', i.name, 'Nova’s name')}<button type="button" class="btn small" data-action="save-profile" data-section="identity" data-key="name" data-field="nova-name">Save</button>` })}
${settingsRow({ id: 'directness-row', title: 'Directness', note: 'Telling you when Nova thinks something’s wrong isn’t adjustable; this is how it says it.', control: `<label class="sr-only" for="directness">Directness</label><select class="input" id="directness" data-action="set-profile" data-section="tuning" data-key="directness">${DIRECTNESS.map(([v, l]) => `<option value="${v}"${i.directness === v ? ' selected' : ''}>${l}</option>`).join('')}</select>` })}
</ul></section>`;
}

// Until the profile has answered (partState, F-021) the section names no mode (V-3): no choice is
// checked, the choices wait disabled (a pick can't be weighed against a mode not yet read), and the
// note says the setting is on its way, or that it couldn't be read, with a retry.
export function renderPrivacy() {
  const state = partState('profile');
  const known = state === 'known';
  const note = known ? esc(PRIVACY.find(([v]) => v === privacy())?.[2] ?? '')
    : state === 'failed' ? esc('Nova’s server didn’t give your privacy setting, so this page can’t say what it is.')
    : esc('Reading your privacy setting from Nova…');
  const retry = state === 'failed' ? '<button type="button" class="btn small" data-action="retry-privacy">Try again</button>' : '';
  return `<section class="memory-section" id="privacy" aria-labelledby="set-privacy"><h2 class="memory-heading" id="set-privacy">Privacy</h2>
<p class="memory-lede">The default for every task. A task can be stricter, never looser.</p>
<fieldset class="set-field"${known ? '' : ' disabled'}><legend class="sr-only">Privacy mode</legend><div class="choices">${PRIVACY.map(([v, l]) => `<label class="choice"><input type="radio" name="privacy" value="${v}"${known && privacy() === v ? ' checked' : ''}><span class="choice-name">${l}</span></label>`).join('')}</div></fieldset>
<p class="settings-note"${known ? '' : ` data-privacy-unknown="${state}" role="status"`}>${note}</p>${retry}${chatPrivacyNote()}
<div class="connection-actions"><a class="btn" href="/receipts">Receipts: what left your devices</a></div></section>`;
}

// Where chat goes, and what a chat turn carries, said where the mode is chosen and before the first
// send (F-025, F-027, A-006): the hub builds the words from the chat model actually chosen. Under
// local-only, what choosing the cloud would mean for chat is said before the person chooses it.
// Nothing until the profile has answered: the words are the current mode's, and it isn't known (V-3).
function chatPrivacyNote() {
  const s = store.providers?.chat?.sends;
  if (!s?.modes || !partKnown('profile')) return '';
  const now = s.modes[privacy()] ?? '';
  const ifCloud = privacy() === 'local-only' && s.modes['local-preferred'] !== now ? ` With Local first or Cloud allowed: ${s.modes['local-preferred']}` : '';
  return `<p class="settings-note" data-chat-privacy>${esc(`${now}${ifCloud}`)}</p>`;
}

export async function saveProfile(section, key, value) {
  // Looser privacy is tier 3: confirmed (with the passkey on Nova's own screen), every time.
  const order = PRIVACY.map(([v]) => v);
  const looser = section === 'privacy' && key === 'default' && order.indexOf(value) > order.indexOf(privacy());
  try {
    await api('PUT', `/profile/${section}/${key}`, { value, ...(looser ? { confirm: true } : {}) });
    await load(['profile']);
    toast('Saved.');
  } catch (e) { toast(e.message); await load(['profile']).catch(() => {}); }
}

// ---- Settings › Appearance (Amendment 2026-10-30-C Part 1 §5) ---------------------------------
// Picking a design applies it to the real page at once; there is no preview mock. For this device
// it is saved at once, with Undo on show. For all devices it shows here first and is kept only on
// Save. The scope in force is always on show, a live contrast check reads what the screen shows,
// and Nova recommends one design.

// `next`: where focus belongs after the last action, kept briefly so a redraw that arrives late
// (the core's event) doesn't drop it on the page.
// `more`: whether the designs not yet at the bar are open.
const look = { scope: 'device', pending: null, undo: null, next: null, nextUntil: 0, more: false };
const prefers = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const designName = (a, id) => a.list.find((d) => d.id === id)?.name ?? id;

// A design's thumbnail: a few of its own colours, in the look this device would show.
function chips(d, want) {
  const sw = (d.looks?.[want] ?? d.looks?.default)?.swatch;
  if (!sw) return '<span class="ds-chips" aria-hidden="true"></span>';
  const vars = [['bg', sw.bg], ['card', sw.raised], ['text', sw.text], ['accent', sw.accent], ['orb', sw.orb]].map(([k, v]) => `--chip-${k}: ${esc(v)}`).join('; ');
  return `<span class="ds-chips" aria-hidden="true" style="${vars}"><span class="chip chip-bg"></span><span class="chip chip-card"></span><span class="chip chip-text"></span><span class="chip chip-accent"></span><span class="chip chip-orb"></span></span>`;
}

function designCard(d, a, { big = false, showing, want }) {
  const tags = [d.id === a.user ? '<span class="pill">All devices</span>' : '', d.id === a.device ? '<span class="pill">This device</span>' : '', d.valid ? '' : '<span class="pill is-warn">Has problems</span>'].join('');
  return `<button type="button" class="ds-card${big ? ' is-big' : ''}" data-action="pick-ds" data-ds="${esc(d.id)}" aria-pressed="${d.id === showing}"${d.valid ? '' : ' disabled'}>
  ${chips(d, want)}<span class="ds-text"><span class="ds-name">${esc(d.name)}</span>${big && d.description ? `<span class="ds-note">${esc(d.description)}</span>` : ''}${tags ? `<span class="ds-tags">${tags}</span>` : ''}</span>
</button>`;
}

// The live check on what this page shows now, from its own variables (look.js decides what it
// says and offers).
function contrastPanel(a) {
  const css = getComputedStyle(document.documentElement);
  const shown = a.list.find((d) => d.id === a.theme);
  const v = contrastView({
    checks: a.checks, get: (t) => css.getPropertyValue(`--${t.replace(/\//g, '-')}`).trim(),
    fix: a.fix, fixable: shown?.fixable ?? [], unfixable: shown?.unfixable ?? [], pending: !!look.pending,
  });
  const ok = v.state === 'unknown' ? 'unknown' : v.state === 'ok' ? 'true' : 'false';
  const items = v.failures.map((f) => `<li>${esc(f.what)}: ${f.ratio}:1; it needs ${f.min}:1.</li>`).join('');
  const cant = v.cantFix.length ? `<p class="settings-note">${v.offerUndo ? 'The fix went as far as it can.' : 'Adjusting colours can’t fix this.'} Still hard to read: ${esc(v.cantFix.join('; ').toLowerCase())}. Another design will read better.</p>` : '';
  const wait = v.state === 'fail' && look.pending ? '<p class="settings-note">Save or cancel first; then Nova can fix it on this device.</p>' : '';
  const fix = v.offerFix ? '<div class="sheet-actions"><button type="button" class="btn primary small" data-action="fix-contrast">Fix it on this device</button></div><p class="settings-note">Nova moves just those colours until they pass, on this device only. You can undo it.</p>' : '';
  const undo = v.offerUndo ? '<div class="sheet-actions"><button type="button" class="btn small" data-action="undo-fix">Undo the contrast fix</button></div>' : '';
  const body = v.state === 'fail'
    ? `<p class="contrast-title">${esc(v.line)}</p><ul class="contrast-list">${items}</ul>${fix}${cant}${wait}${undo}`
    : `<p class="contrast-line">${esc(v.line)}</p>${undo}`;
  return { ok, body };
}

// Appearance is drawn once as a frame, and its parts are filled in place, so the live regions
// (the scope line, the bar with Undo or Save, the contrast check) stay the same elements and a
// screen reader hears each change.
const FRAME = `<section class="memory-section" id="appearance" aria-labelledby="set-look"><h2 class="memory-heading" id="set-look">Appearance</h2>
<p class="ds-scope" id="appearance-scope" role="status"></p>
<div data-sub="where"></div>
<div class="ds-bar-slot" id="appearance-bar" role="status"></div>
<div class="ds-picker" id="appearance-design"></div>
<div class="contrast-check" id="contrast-check" role="status"></div>
<div data-sub="mode"></div>
<p class="settings-note" id="appearance-iphone">On an iPhone with Nova on the Home Screen, a dark design also fills the strip with the time and battery. After you switch to or from a dark design, that strip may only change once you close Nova and open it again.</p>
<p class="perm-foot"><a class="set-link" href="/styleguide">Styleguide</a></p></section>`;

// Each part is written again only when what it should show changes. The browser never reads
// innerHTML back exactly as written (quotes, entities, boolean attributes), so comparing with it
// rewrote the design cards on every refresh, taking focus and hover with them. Each part keeps
// the source it was last given and the children that made; a part whose children were replaced
// some other way is written again. FRAME makes new parts, which start with nothing kept.
const drawn = new WeakMap();
const setHtml = (node, html) => {
  if (!node) return;
  const last = drawn.get(node);
  const kids = node.childNodes;
  if (last?.html === html && last.kids.length === kids.length && last.kids.every((k, i) => k === kids[i])) return;
  node.innerHTML = html;
  drawn.set(node, { html, kids: [...node.childNodes] });
};

export function drawAppearance(box) {
  if (!box.querySelector('#appearance')) box.innerHTML = FRAME;
  const a = appearance();
  const usable = a.list.filter((d) => d.state !== 'disabled');
  const showing = look.pending?.id ?? a.theme;
  const mode = look.pending?.mode ?? a.mode;
  const want = mode === 'light' || mode === 'dark' ? mode : prefers();
  const rec = recommend(usable, { mode, prefers: prefers() });
  const others = usable.filter((d) => d.id !== rec?.id);
  setHtml(box.querySelector('#appearance-scope'), `Theme: <b>${esc(designName(a, a.theme))}</b> · ${a.scope === 'device' ? 'this device only' : 'synced'}`);
  setHtml(box.querySelector('[data-sub="where"]'), `<fieldset class="set-field" id="appearance-where"><legend class="set-legend">Change it for</legend>
<div class="choices"><label class="choice"><input type="radio" name="ds-scope" value="device"${look.scope === 'device' ? ' checked' : ''}><span class="choice-name">This device</span></label><label class="choice"><input type="radio" name="ds-scope" value="user"${look.scope === 'user' ? ' checked' : ''}><span class="choice-name">All my devices</span></label></div>
<p class="settings-note">${look.scope === 'device' ? 'A design you pick shows here at once, and Undo puts the last one back.' : 'A design you pick shows here first; your other devices change when you save it.'}</p></fieldset>`);
  const bar = box.querySelector('#appearance-bar');
  const barHtml = look.pending
    ? `<div class="ds-bar" id="appearance-pending"><p>${esc(designName(a, showing))}${look.pending.mode ? `, ${esc(look.pending.mode)}` : ''} is showing here only. Save to use it on all your devices.</p><span class="row-actions"><button type="button" class="btn primary small" data-action="save-ds">Save for all devices</button><button type="button" class="btn small" data-action="cancel-ds">Cancel</button></span></div>`
    : look.undo && a.scope === 'device' && a.theme === look.undo
      ? `<div class="ds-bar" id="appearance-undo"><p>${esc(designName(a, look.undo))} is on this device now.</p><button type="button" class="btn small" data-action="undo-ds">Undo</button></div>`
      : '';
  setHtml(bar, barHtml);
  // Packages aren't equals (DESIGN-SYSTEM §0): Nova's own design first; the rest are behind
  // "More designs", said plainly to be not yet at the bar, and open whenever one of them is in use.
  const inUse = others.some((d) => [showing, a.user, a.device].includes(d.id));
  const more = look.more || inUse;
  const kicker = rec?.at_bar ? 'Recommended · Nova’s design' : 'Recommended';
  // Orb Teal is at the bar too, though not the lead: count only the ones that aren't.
  const below = others.filter((d) => !d.at_bar).length;
  const moreNote = below === others.length ? `${below}, not yet at Nova’s design bar` : below ? `${others.length}, ${below} not yet at Nova’s design bar` : `${others.length}`;
  const otherNote = below ? '<p class="settings-note">These work, and each says whether it reads well, but none has yet been held to the design bar Nova’s own design meets. They may change as they are brought up to it.</p>' : '';
  setHtml(box.querySelector('#appearance-design'), `${rec ? `<div class="ds-recommended"><p class="ds-kicker">${kicker}</p>${designCard(rec, a, { big: true, showing, want })}<p class="ds-reason">${esc(rec.reason)}</p></div>` : ''}
${others.length ? `<details class="ds-more"${more ? ' open' : ''}><summary class="ds-more-summary">${ICONS.chevron}More designs <span class="ds-more-note">· ${moreNote}</span></summary>${otherNote}<ul class="ds-others" aria-label="More designs">${others.map((d) => `<li>${designCard(d, a, { showing, want })}${d.valid ? '' : `<p class="settings-note">${esc(d.problems.slice(0, 2).join(' '))}</p>`}</li>`).join('')}</ul></details>` : ''}`);
  const details = box.querySelector('.ds-more');
  if (details && !details.dataset.wired) { details.dataset.wired = '1'; details.addEventListener('toggle', () => { look.more = details.open; }); }
  const check = box.querySelector('#contrast-check');
  const panel = contrastPanel(a);
  if (check.dataset.ok !== panel.ok) check.dataset.ok = panel.ok;
  setHtml(check, panel.body);
  const focusLost = () => !document.activeElement || document.activeElement === document.body;
  const lost = focusLost();
  setHtml(box.querySelector('[data-sub="mode"]'), `<fieldset class="set-field" id="appearance-mode"><legend class="set-legend">Light and dark <span class="set-legend-note">· all devices</span></legend>
<div class="choices">${MODES.map((m) => `<label class="choice"><input type="radio" name="mode" value="${m}"${m === mode ? ' checked' : ''}><span class="choice-name">${m[0].toUpperCase()}${m.slice(1)}</span></label>`).join('')}</div></fieldset>`);
  if (look.next && Date.now() < look.nextUntil && (lost || focusLost())) box.querySelector(look.next)?.focus({ preventScroll: true });
}

// Leaving Settings with a design only tried for all devices puts the saved one back.
export function cancelPreview() {
  if (!look.pending && !previewingNow()) return;
  look.pending = null;
  endPreview().catch(() => {});
}

// Undo after Save: exactly what that Save changed (look.js undoPlan), in the order that keeps
// each step's own rollback meaningful.
async function undoSave(plan, before) {
  if (plan.device) await rollback('device');
  if (plan.user) await rollback('user');
  if (plan.mode) await setMode(plan.mode);
  toast(`Back to ${before.label}.`);
}

const PRESSED = '.ds-card[aria-pressed="true"]';

// Runs one action and returns where focus should go next (a selector), or null.
export async function appearanceAction(action, el) {
  const next = await act(action, el);
  look.next = next;
  look.nextUntil = next ? Date.now() + 2000 : 0;
  return next;
}

async function act(action, el) {
  const a = appearance();
  try {
    if (action === 'scope') { look.scope = el.value === 'user' ? 'user' : 'device'; return null; }
    if (action === 'pick-ds') {
      const id = el.dataset.ds;
      if (look.scope === 'device') {
        look.pending = null;
        look.undo = id;
        await use(id, 'device').catch((e) => { look.undo = null; throw e; });
      } else {
        look.pending = { ...look.pending, id };
        await preview(id, look.pending.mode ?? a.mode);
      }
      return `.ds-card[data-ds="${CSS.escape(id)}"]`;
    }
    if (action === 'mode') {
      look.pending = { ...look.pending, mode: el.value };
      await preview(look.pending.id ?? a.theme, el.value);
      return null;
    }
    if (action === 'save-ds' && look.pending) {
      const saved = look.pending;
      const before = { mode: a.mode, synced: await syncedId(), device: a.device, label: designName(a, a.theme) };
      const plan = undoPlan(before, saved);
      look.pending = null;
      look.undo = null;
      if (saved.mode && saved.mode !== a.mode) await setMode(saved.mode);
      if (saved.id) {
        if (saved.id !== before.synced) await use(saved.id, 'user');
        if (a.device) await follow();
      }
      await endPreview();
      toast('Saved for all your devices.', plan ? { action: { label: 'Undo', run: () => undoSave(plan, before).catch((e) => toast(e.message)) } } : {});
      return PRESSED;
    }
    if (action === 'cancel-ds') { look.pending = null; await endPreview(); return PRESSED; }
    if (action === 'undo-ds') { look.undo = null; await rollback('device'); return PRESSED; }
    if (action === 'fix-contrast') {
      const out = await fixContrast();
      toast(out.unfixable?.length ? 'Fixed what Nova could on this device.' : 'Fixed on this device.');
      return '[data-action="undo-fix"]';
    }
    if (action === 'undo-fix') { await undoFix(); return '[data-action="fix-contrast"]'; }
  } catch (e) { toast(e.message); }
  return null;
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; window.dispatchEvent(new CustomEvent('nova:installable')); });
export async function install() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
}

// Settings › Devices: the real registry. Adding a device is the one standout, unless a device is
// already waiting for an OK: then reviewing it is. Revoked devices are kept one layer down.
export function renderDevices() {
  const m = store.mesh;
  const me = m?.you;
  const approver = !!me?.can_approve;
  // A standby shows the hub's registry as it copied it; devices are added and revoked on the hub.
  const copy = !!m?.replica;
  const installRow = standalone()
    ? settingsRow({ id: 'install-row', title: 'Installed', note: 'Nova runs as an app on this device.' })
    : installPrompt
      ? settingsRow({ id: 'install-row', title: 'Install Nova', note: 'Open Nova like an app, with its own window and icon.', control: '<button type="button" class="btn small" data-action="install">Install</button>' })
      : settingsRow({ id: 'install-row', title: 'Install Nova', note: iosLimits() ? 'In Safari, tap Share, then Add to Home Screen.' : 'Your browser offers Install in its menu when it can.' });
  const all = meshDevices();
  const trusted = all.filter((d) => d.trust !== 'revoked');
  const revoked = all.filter((d) => d.trust === 'revoked');
  // What it is for (M10f): an approver can change it, the hub's own included.
  const rolesButton = (d) => (approver && !copy && d.id && d.trust !== 'revoked' && allowedRoles(d).length > 1 ? `<button type="button" class="btn small quiet" data-action="edit-roles" data-device="${esc(d.id)}">Roles</button>` : '');
  // Its models (model-fit step 3): the hub, and a computer that holds the compute role.
  const modelsButton = (d) => (!copy && d.id && d.trust !== 'revoked' && (d.role === 'hub' || (d.kind === 'computer' && (d.purposes ?? []).includes('compute')))
    ? `<button type="button" class="btn small quiet" data-action="device-models" data-device="${esc(d.role === 'hub' ? 'hub' : d.id)}" aria-label="Models on ${esc(d.name)}">Models</button>` : '');
  const actions = (d) => {
    if (copy || !d.id || d.trust === 'revoked') return '';
    if (d.role === 'hub') return `${modelsButton(d)}${rolesButton(d)}`;
    const allow = approver && (d.kind === 'phone' || d.kind === 'browser') && !d.this
      ? `<button type="button" class="btn small quiet" data-action="allow-approve" data-device="${esc(d.id)}" data-value="${d.can_approve ? 'false' : 'true'}">${d.can_approve ? 'Stop it approving' : 'Let it approve'}</button>` : '';
    // A hub candidate can be made the hub (M10g): the pre-checks say whether it is ready.
    const promote = approver && (d.purposes ?? []).includes('hub-candidate') && (d.kind === 'standby' || d.kind === 'computer')
      ? `<button type="button" class="btn small quiet" data-action="promote-device" data-device="${esc(d.id)}">Promote to hub</button>` : '';
    return `${modelsButton(d)}${rolesButton(d)}${allow}${promote}<button type="button" class="btn small" data-action="revoke-device" data-device="${esc(d.id)}">Revoke</button>`;
  };
  // A promotion under way, or how the last one ended, in its own words (GET /mesh/status).
  const p = m?.promotion;
  // Settling it by hand (M10g review): a hand-over whose outcome isn't known can be cancelled; a new
  // hub that can't be reached can be given back. Both tier 3, on this computer's own screen.
  const settle = !p || !approver ? ''
    : p.side === 'from' && ['holding', 'transferring'].includes(p.state) && (p.told ?? []).includes('unknown') ? '<button type="button" class="btn small" data-action="promotion-cancel">Cancel the hand-over</button>'
      : p.side === 'from' && p.state === 'verifying' && (p.told ?? []).includes('unreachable') ? '<button type="button" class="btn small" data-action="promotion-take-back">Take the hub back</button>' : '';
  const promotionRow = p && p.said ? settingsRow({ id: 'promotion-row', title: p.kind === 'cold' ? 'Promotion from a backup' : 'Promotion', note: p.said, control: settle }) : '';
  const waiting = store.requests.map((r) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(r.name)} is asking to join</p><p class="settings-note">${esc(KIND_WORDS[r.kind] ?? r.kind)} · compare the six digits it shows.</p></div><div class="settings-control"><button type="button" class="btn small primary" data-action="review-request" data-request="${esc(r.id)}">Review</button></div></li>`).join('');
  const lede = !m
    ? 'Paired devices show here.'
    : copy
      ? 'The hub’s devices, as this node last copied them. Add and revoke devices on the hub.'
    : !m.listening
      ? 'Other devices can’t reach this Nova yet, so only this one is here. To pair a phone or a computer, start Nova with a mesh address (NOVA_MESH_URL); the README says how.'
      : `Phones, browsers and computers you’ve paired. Devices reach Nova at ${m.public_url}.`;
  // A device that wasn't allowed to approve can't add one; it says where to instead of just
  // leaving the button out.
  const add = !m?.listening || copy
    ? ''
    : approver
      ? `<div class="sheet-actions"><button type="button" class="btn${store.requests.length ? '' : ' primary'}" data-action="add-device">Add a device</button></div>`
      : '<p class="memory-lede">This device can’t add devices. To pair another, use the hub’s own screen, or let this device approve from there.</p>';
  return `<section class="memory-section" id="devices" aria-labelledby="set-devices"><h2 class="memory-heading" id="set-devices">Devices</h2>
<p class="memory-lede">${esc(lede)}</p>
<p class="memory-lede" id="devices-topology"><a class="link" href="/topology">Machines and services</a></p>
${waiting ? `<ul class="settings-list">${waiting}</ul>` : ''}
${promotionRow ? `<ul class="settings-list">${promotionRow}</ul>` : ''}
<ul class="device-list device-registry">${trusted.map((d) => deviceRow(d, { actions: actions(d), roles: true })).join('')}</ul>
${add}
${revoked.length ? `<details class="raw"><summary>Revoked (${revoked.length})</summary><ul class="device-list device-registry">${revoked.map((d) => deviceRow(d)).join('')}</ul></details>` : ''}
<ul class="settings-list">${installRow}
${iosLimits() ? settingsRow({ title: 'On iPhone and iPad', note: 'An installed Nova can’t work in the background there. Your hub does the always-on work; this screen is a window onto it.' }) : ''}
${settingsRow({ title: 'Appearance id', note: `${deviceId()}. It lets this browser keep its own appearance.` })}</ul></section>`;
}

// ---- pairing and revoking ------------------------------------------------------------------

let pairing = null;
let expiry = 0;

// A new code and its sheet. The sheet turns into "expired" when the code does: real state.
export async function addDevice() {
  try {
    pairing = await api('POST', '/mesh/pairings');
  } catch (e) { toast(e.message); return; }
  const show = () => openSheet(addDeviceSheet(pairing), { label: 'Add a device', onClose: () => { clearTimeout(expiry); pairing = null; } });
  show();
  clearTimeout(expiry);
  expiry = setTimeout(() => { if (pairing && document.querySelector(`#sheet .add-device[data-pairing="${CSS.escape(pairing.pairing_id)}"]`)) show(); }, Math.max(0, Date.parse(pairing.expires_at) - Date.now()) + 50); // wait: expiry: the pairing code
}

export async function copyCommand() {
  const text = document.getElementById('add-command')?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Run it on the computer you’re adding.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('add-command'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    toast('Selected. Copy it with your keyboard.');
  }
}

// A device showing its digits. It takes the sheet if the sheet is free or showing the code it used;
// otherwise it waits behind a toast, and in Settings and the orb.
export function promptJoin(r) {
  if (!r?.confirmation || r.state !== 'pending' || store.mesh?.you?.can_approve === false) return;
  const busy = sheetOpen() && !document.querySelector('#sheet .add-device') && !document.querySelector(`#sheet [data-request="${CSS.escape(r.id)}"]`);
  if (busy) { toast(`${r.name} is asking to join.`, { action: { label: 'Review', run: () => openRequest(r.id) } }); return; }
  openSheet(joinRequestSheet(r), { label: 'A device is asking to join' });
}

// A request was answered somewhere else (or expired): its sheet goes.
export function joinDecided(r) {
  if (!r || r.state === 'pending') return;
  if (document.querySelector(`#sheet [data-request="${CSS.escape(r.id)}"]`)) {
    closeSheet();
    if (r.state === 'expired') toast(`${r.name} waited too long; the request expired.`);
  }
}

export async function openRequest(id) {
  await load(['requests']);
  const r = store.requests.find((x) => x.id === id);
  if (!r) { toast('That request was already answered.'); return; }
  openSheet(joinRequestSheet(r), { label: 'A device is asking to join' });
}

async function approveJoin(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  // The roles as the person left them (M10f); a hub candidacy is confirmed on its own.
  const purposes = form.querySelector('input[name="purpose"]') ? pickedRoles(form) : undefined;
  const candidate = form.querySelector('input[name="confirm_candidate"]');
  if (purposes?.includes('hub-candidate') && candidate && !candidate.checked) { toast('Making it a hub candidate is confirmed on its own: tick that box too, or untick Hub candidate.'); candidate.focus(); return; }
  try {
    const { device } = await api('POST', `/mesh/requests/${encodeURIComponent(form.dataset.request)}/approve`, { confirm: true, ...(purposes ? { purposes } : {}), confirm_candidate: !!candidate?.checked });
    closeSheet();
    // Device setup's Models step (model-fit step 3): a computer declared for compute is offered its
    // Models screen, which fills in once it has reported its hardware.
    const plan = (device.purposes ?? []).includes('compute') && device.kind === 'computer'
      ? { action: { label: 'Plan its models', run: () => { history.pushState(null, '', `/settings#models-on-${encodeURIComponent(device.id)}`); window.dispatchEvent(new PopStateEvent('popstate')); } } } : {};
    toast(`${device.name} is paired.`, plan);
  } catch (e) { toast(e.message); }
  await load(['devices', 'requests']);
}

export async function denyRequest(id) {
  try {
    await api('POST', `/mesh/requests/${encodeURIComponent(id)}/deny`);
    closeSheet();
    toast('Turned away.');
  } catch (e) { toast(e.message); }
  await load(['requests']);
}

export function revokeDevice(id) {
  const d = store.devices.find((x) => x.id === id);
  if (d) openSheet(revokeSheet(d), { label: `Revoke ${d.name}` });
}

async function confirmRevoke(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  try {
    const d = await api('POST', `/mesh/devices/${encodeURIComponent(form.dataset.revoke)}/revoke`, { confirm: true, reason: 'Revoked by you.' });
    closeSheet();
    toast(`${d.name} is revoked.`);
  } catch (e) { toast(e.message); }
  await load(['devices']);
}

// Letting a phone or browser approve new devices is a permissions change: tier 3, its own sheet.
export function allowApprove(id, value) {
  const d = store.devices.find((x) => x.id === id);
  if (d) openSheet(allowApproveSheet(d, value === 'true'), { label: `Who approves new devices` });
}

async function confirmAllow(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  const yes = form.dataset.value === 'true';
  try {
    const d = await api('PATCH', `/mesh/devices/${encodeURIComponent(form.dataset.allow)}`, { can_approve: yes, confirm: true });
    closeSheet();
    toast(yes ? `${d.name} can approve new devices.` : `${d.name} can no longer approve new devices.`);
  } catch (e) { toast(e.message); }
  await load(['devices']);
}

// ---- device roles (M10f) ---------------------------------------------------------------------

// What each kind may hold and must hold: the hub's rules (src/core/mesh/purposes.ts), for the sheet.
const ALL_ROLES = ['thin-client', 'hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'];
export function allowedRoles(d) {
  if (d.role === 'hub' || d.kind === 'standby') return ALL_ROLES.filter((p) => p !== 'thin-client');
  if (d.kind === 'phone' || d.kind === 'browser') return ['thin-client'];
  return ALL_ROLES;
}
export function fixedRoles(d) {
  if (d.role === 'hub') return ['hub-candidate', 'general-server'];
  if (d.kind === 'phone' || d.kind === 'browser') return ['thin-client'];
  if (d.kind === 'standby') return ['hub-candidate'];
  return [];
}
export function roleChange(before, after) {
  return { added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) };
}

export function editRoles(id) {
  const d = store.devices.find((x) => x.id === id);
  if (d) openSheet(rolesSheet(d, { allowed: allowedRoles(d), fixed: fixedRoles(d) }), { label: `What ${d.name} is for` });
}

// Step one done: the review at its tier, or nothing when nothing changed.
export async function reviewRoles(form) {
  const d = store.devices.find((x) => x.id === form.dataset.roles);
  if (!d) return;
  const next = ALL_ROLES.filter((p) => pickedRoles(form).includes(p) || fixedRoles(d).includes(p));
  const change = roleChange(d.purposes ?? [], next);
  if (!change.added.length && !change.removed.length) { closeSheet(); toast('Nothing changed.'); return; }
  // What taking roles away would stop there, as the hub says (a dry run: nothing changes yet).
  let stops = [];
  if (change.removed.length) {
    try { stops = (await api('PATCH', `/mesh/devices/${encodeURIComponent(d.id)}`, { purposes: next, dry_run: true })).stops ?? []; } catch (e) { toast(e.message); return; }
  }
  openSheet(rolesReviewSheet(d, next, change, stops), { label: `Change what ${d.name} is for` });
}

async function confirmRoles(form) {
  const tier = Number(form.dataset.tier);
  const confirm = form.querySelector('input[name="confirm"]');
  if (tier === 3 && !confirm?.checked) { confirm?.focus(); return; }
  const candidate = form.querySelector('input[name="confirm_candidate"]');
  if (candidate && !candidate.checked) { candidate.focus(); toast('Making it a hub candidate is confirmed on its own: tick that box too.'); return; }
  const purposes = form.dataset.next ? form.dataset.next.split(',') : [];
  try {
    const d = await api('PATCH', `/mesh/devices/${encodeURIComponent(form.dataset.rolesConfirm)}`, { purposes, ...(tier === 3 ? { confirm: true } : { approved: true }), confirm_candidate: !!candidate?.checked });
    closeSheet();
    toast(`${d.name} is for: ${d.purposes.length ? d.purposes.join(', ').replace(/-/g, ' ') : 'nothing yet'}.`);
  } catch (e) { toast(e.message); }
  await load(['devices']);
}

// ---- promotion (M10g) ---------------------------------------------------------------------------

// The pre-checks first (tier 0), then the sheet at tier 3.
export async function promoteDevice(id) {
  const d = meshDevices().find((x) => x.id === id);
  if (!d) return;
  let check;
  try { check = await api('POST', '/mesh/promotions/check', { device_id: id }); } catch (e) { toast(e.message); return; }
  openSheet(promotionSheet(d, check), { label: 'Promote to hub' });
}

async function confirmPromotion(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  try {
    await api('POST', '/mesh/promotions', { device_id: form.dataset.promotion, confirm: true });
    closeSheet();
    toast('Handing the hub over. Changes wait a moment while it happens.');
  } catch (e) { toast(e.message); }
  await load(['devices', 'mesh']);
}

export async function promoteCold() {
  let view;
  try { view = await api('GET', '/mesh/promotion/cold'); } catch (e) { toast(e.message); return; }
  openSheet(coldPromotionSheet(view), { label: 'Make this the hub from a backup' });
}

export function promotionAction(kind) {
  openSheet(promotionActionSheet(kind, store.mesh?.promotion), { label: kind === 'cancel' ? 'Cancel the hand-over' : 'Take the hub back' });
}

async function confirmPromotionAction(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  try {
    const r = await api('POST', form.dataset.promotionAction === 'cancel' ? '/mesh/promotion/cancel' : '/mesh/promotion/take-back', { confirm: true });
    closeSheet();
    toast(r.said ?? 'Done.');
  } catch (e) { toast(e.message); }
  await load(['devices', 'mesh']);
}

async function confirmCold(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  try {
    const r = await api('POST', '/mesh/promotion/cold', { confirm: true, backup: form.dataset.backup });
    closeSheet();
    toast(`Restoring the backup of ${r.backup?.at ?? 'then'}. Nova restarts to apply it.`);
  } catch (e) { toast(e.message); }
}

// ---- the standby: becoming the hub ------------------------------------------------------------

export function promote() {
  openSheet(promoteSheet(store.mesh?.replica), { label: 'Make this the hub' });
}

async function confirmPromote(form) {
  const confirm = form.querySelector('input[name="confirm"]');
  if (!confirm?.checked) { confirm?.focus(); return; }
  try {
    const r = await api('POST', '/mesh/promote', { confirm: true });
    closeSheet();
    toast(`This node is the hub now (epoch ${r.epoch}).`);
  } catch (e) { toast(e.message); }
  await load();
}

// ---- Settings › Providers (M5a) ------------------------------------------------------------------
// Who Nova can hand work to. Nova recommends one for chat rather than listing choices; that is the
// one standout here. The full list waits one layer down. Turning a provider on is tier 2: its own
// sheet, with what it may do and where its data goes.

const CLASS_WORDS = { 'coding-agent': 'Coding agent', chat: 'Chat model', automation: 'Automation' };
const providerById = (id) => store.providers?.providers?.find((p) => p.id === id) ?? null;

export function renderProviders() {
  const data = store.providers;
  const head = '<h2 class="memory-heading" id="set-providers">Providers</h2>';
  if (!data) return `<section class="memory-section" id="providers" aria-labelledby="set-providers">${head}<p class="memory-lede">Nova hasn’t heard back about its providers yet.</p></section>`;
  const name = (id) => providerById(id)?.name ?? id;
  const advice = (what, standout) => {
    const c = what === 'chat' ? data.chat : data.defaults[what];
    const rec = c.recommended;
    const better = rec.id && rec.id !== c.current;
    const title = what === 'chat' ? `Chat uses ${name(c.current)}` : c.current ? `Coding tasks go to ${name(c.current)}` : 'Coding tasks';
    // Before the person switches: the recommended model's scorecard, or that it has none
    // (Amendment B Part 4).
    const card = better && what === 'chat' ? store.chatCard : null;
    // A cloud chat program's line says what each turn carries (F-027).
    const carries = what === 'chat' && data.chat.sends?.egress === 'remote' ? ` ${data.chat.sends.turn}` : '';
    return settingsRow({
      title,
      note: `${better ? `Nova recommends ${name(rec.id)}. ${rec.why}${card ? ` ${card.words}` : ''}` : rec.why}${carries}`,
      control: better ? `<button type="button" class="btn small${standout ? ' primary' : ''}" data-action="provider-choose" data-for="${what}" data-provider="${esc(rec.id)}">Use ${esc(name(rec.id))}</button>` : '',
    });
  };
  const rows = data.providers.map((p) => {
    const usable = p.health.state === 'ready' || p.health.state === 'unchecked';
    const pill = `<span class="pill${p.enabled && p.health.state === 'ready' ? ' is-on' : p.enabled ? ' is-warn' : ''}">${p.enabled ? 'On' : 'Off'}</span>`;
    const setup = p.fields.some((f) => !f.fixed) ? `<button type="button" class="btn small quiet" data-action="provider-setup" data-provider="${esc(p.id)}">Settings</button>` : '';
    const toggle = p.enabled
      ? `<button type="button" class="btn small" data-action="provider-off" data-provider="${esc(p.id)}">Turn off</button>`
      : `<button type="button" class="btn small" data-action="provider-on" data-provider="${esc(p.id)}"${usable ? '' : ' disabled'}>Turn on</button>`;
    return settingsRow({ id: `provider-${p.id}`, title: p.name, note: `${CLASS_WORDS[p.class] ?? p.class}. ${p.egress.words} ${p.health.words}`, control: `${pill}${setup}${toggle}` });
  }).join('');
  const chatBetter = data.chat.recommended.id && data.chat.recommended.id !== data.chat.current;
  // Redrawn on every change; the full list stays open if the person opened it.
  const open = document.querySelector('#providers details.raw')?.open ? ' open' : '';
  return `<section class="memory-section" id="providers" aria-labelledby="set-providers">${head}
<p class="memory-lede">Other AIs and automations Nova can hand work to. Each is off until you turn it on, and Nova checks what they do before it counts.</p>
<ul class="settings-list">${advice('chat', true)}${advice('coding-agent', !chatBetter)}</ul>
<details class="raw"${open}><summary>All providers (${data.providers.length})</summary><ul class="settings-list">${rows}</ul></details>
<p class="settings-note">Test commands a brief declares: ${data.task_tests === 'allow' ? 'Nova runs them without asking.' : 'Nova asks before running them.'}</p></section>`;
}

export async function loadProviders() {
  try {
    store.providers = await api('GET', '/providers');
    const rec = store.providers?.chat?.recommended?.id;
    const target = rec && rec !== store.providers.chat.current ? providerById(rec) : null;
    store.chatCard = target?.model ? await api('GET', `/evals/scorecards/status?provider=${encodeURIComponent(target.id)}&model=${encodeURIComponent(target.model)}`).catch(() => null) : null;
  } catch { /* the part keeps what it had; the next event tries again */ }
  window.dispatchEvent(new CustomEvent('nova:providers'));
}

export async function chooseProvider(what, id) {
  try {
    await api('PUT', '/providers/choice', { for: what, id });
    toast(what === 'chat' ? `Chat uses ${providerById(id)?.name ?? id} now.` : `Coding tasks go to ${providerById(id)?.name ?? id} now.`);
  } catch (e) { toast(e.message); }
  await loadProviders();
}

export async function providerOff(id) {
  try {
    const p = await api('POST', `/providers/${encodeURIComponent(id)}/disable`);
    toast(`${p.name} is off. Its tasks wait until it is on again.`);
  } catch (e) { toast(e.message); }
  await loadProviders();
}

// Turning one on asks first (tier 2): what it may do, and where its data goes.
export function providerOn(id) {
  const p = providerById(id);
  if (!p) return;
  openSheet(`<form class="approval-sheet" data-tier="2" data-provider="${esc(p.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Turn on ${esc(p.name)}?</h2>
  <p class="sheet-line">${esc(p.about)}</p>
  <dl class="facts"><dt>Where it sends</dt><dd>${esc(p.egress.words)}</dd><dt>It may</dt><dd>${p.review.map(esc).join('<br>')}</dd></dl>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve">Turn it on</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`, { label: `Turn on ${p.name}` });
}

async function confirmProvider(form) {
  try {
    const p = await api('POST', `/providers/${encodeURIComponent(form.dataset.provider)}/enable`, { approved: true });
    closeSheet();
    toast(`${p.name} is on.`);
  } catch (e) { toast(e.message); }
  await loadProviders();
}

export function providerSetup(id) {
  const p = providerById(id);
  if (!p) return;
  const field = (f) => {
    const fid = `pf-${f.key}`;
    if (f.kind === 'boolean') return `<label class="choice" for="${fid}"><input type="checkbox" id="${fid}" name="${esc(f.key)}"${p.config[f.key] === true ? ' checked' : ''}${f.fixed ? ' disabled' : ''}><span class="choice-name">${esc(f.label)}</span></label>${f.note ? `<p class="settings-note">${esc(f.note)}</p>` : ''}`;
    const plain = `<label class="field-label" for="${fid}">${esc(f.label)}<input class="input field" id="${fid}" name="${esc(f.key)}" value="${esc(p.config[f.key] ?? '')}" autocomplete="off"${f.fixed ? ' readonly' : ''}></label>${f.note ? `<p class="settings-note">${esc(f.note)}</p>` : ''}`;
    // A secret's value is typed here and goes into the vault; it is never shown back.
    const value = f.kind === 'secret' && !f.fixed
      ? `<label class="field-label" for="${fid}-value">${esc(f.label)}: the value<input class="input field" type="password" id="${fid}-value" name="${esc(f.key)}__value" value="" autocomplete="new-password" placeholder="Kept in the vault, never shown again"></label>`
      : '';
    return plain + value;
  };
  openSheet(`<form class="provider-form" data-provider="${esc(p.id)}" method="dialog">
  <h2 class="sheet-title" id="sheet-title">${esc(p.name)}</h2>
  <p class="sheet-line">${esc(p.health.words)}</p>
  ${p.fields.map(field).join('')}
  ${p.enabled ? `<label class="confirm"><input type="checkbox" name="confirm"> ${esc(p.name)} is on. Changing what it runs or where it sends needs this: I confirm it.</label>` : ''}
  <div class="sheet-actions">
    <button type="submit" class="btn primary">Save</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Cancel</button>
  </div>
</form>`, { label: `${p.name} settings` });
}

// The vault name a secret field's value goes under: the one it already names, or one made from the
// provider and the field (OPENAI_COMPATIBLE_API_KEY).
const secretNameFor = (p, f, ref) => /^secret:\/\/([A-Z][A-Z0-9_]*)$/.exec(ref)?.[1] ?? `${p.id}_${f.key}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^[^A-Z]+/, '').slice(0, 64);

export async function saveProvider(form) {
  const p = providerById(form.dataset.provider);
  if (!p) return;
  const config = {};
  for (const f of p.fields) {
    if (f.fixed) continue;
    if (f.kind === 'boolean') {
      const on = !!form.elements[f.key]?.checked;
      if (on !== (p.config[f.key] === true)) config[f.key] = on;
      continue;
    }
    const v = form.elements[f.key]?.value.trim() ?? '';
    if (v !== String(p.config[f.key] ?? '')) config[f.key] = v;
  }
  try {
    // A secret typed here goes straight into the vault; the setting keeps only its name.
    for (const f of p.fields.filter((x) => x.kind === 'secret' && !x.fixed)) {
      const input = form.elements[`${f.key}__value`];
      const value = input?.value.trim() ?? '';
      if (!value) continue;
      const name = secretNameFor(p, f, form.elements[f.key]?.value.trim() ?? '');
      await api('PUT', `/vault/${encodeURIComponent(name)}`, { value });
      input.value = '';
      if (`secret://${name}` !== String(p.config[f.key] ?? '')) config[f.key] = `secret://${name}`;
    }
    const confirm = form.elements.confirm?.checked === true;
    const r = await api('PUT', `/providers/${encodeURIComponent(p.id)}/config`, { config, ...(confirm ? { confirm: true } : {}) });
    if (r.token) {
      openSheet(`<div class="provider-token"><h2 class="sheet-title" id="sheet-title">The workflow’s callback token</h2>
<p class="sheet-line">${esc(r.note)}</p><p class="fingerprint">${esc(r.token)}</p>
<div class="sheet-actions"><button type="button" class="btn primary" data-action="close-sheet">Done</button></div></div>`, { label: 'Callback token' });
    } else {
      closeSheet();
      toast(`Saved. ${r.provider.health.words}`);
    }
  } catch (e) { toast(e.message); }
  await loadProviders();
}
