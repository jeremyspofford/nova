// The PWA's own surfaces, drawn from the core (/api/v1): Home, the right column, Tasks, Health,
// automation rules, and Settings' identity, privacy, appearance and devices. Era 2's views
// (conversations, Memory, Skills, Schedules, Activity, permissions) stay in app.js and view.js.
import { api, deviceId, request } from './core.js';
import { ICONS, ago, approvalSheet, briefCard, card, deviceMeshCard, deviceRow, emptyState, evidenceViewer, handlingCard, healthCard, memoryHighlightCard, orb, proactiveBanner, settingsRow, status, taskRow, triggerRow, verifiedResultCard } from './components.js';
import { greeting, isOpen, needsApproval, statusOf } from './status.js';
import { escapeHtml as esc } from './markdown.js';
import { closeSheet, layout, liveOrb, openSheet, toast } from './shell.js';
import { MODES, current as appearance, previewCss, rollback, setMode, use } from './theme.js';

// What the core has told this page, kept fresh by the event stream.
export const store = {
  tasks: [], problems: [], resolved: [], health: null, profile: null, identity: null,
  memory: [], rules: [], messages: [], workers: [], reachable: true, stale: false, loaded: false,
};

const settle = (p, fallback) => p.catch(() => fallback);
export async function load(parts = ['tasks', 'problems', 'health', 'profile', 'memory', 'rules', 'messages', 'workers']) {
  // Each part comes back as [value, stale].
  const get1 = (path) => request('GET', path).then((r) => [r.data, r.stale]);
  const get = {
    tasks: () => get1('/tasks?limit=100'),
    problems: () => get1('/problems'),
    health: () => get1('/health'),
    profile: () => Promise.all([get1('/profile'), get1('/identity')]).then(([a, b]) => [[a[0], b[0]], a[1] || b[1]]),
    memory: () => get1('/memory'),
    rules: () => get1('/triggers/rules'),
    messages: () => get1('/messages'),
    workers: () => get1('/workers'),
  };
  const results = await Promise.all(parts.map((p) => settle(get[p]().then(([v, s]) => [p, v, s]), [p, undefined, false])));
  let any = false;
  let wasStale = false;
  for (const [p, v, s] of results) {
    if (v === undefined) continue;
    any = true;
    wasStale ||= s;
    if (p === 'problems') { store.problems = v.filter((x) => !x.resolved_at); store.resolved = v.filter((x) => x.resolved_at).slice(0, 10); }
    else if (p === 'profile') { store.profile = v[0]; store.identity = v[1].identity; }
    else store[p] = v;
  }
  if (any) store.loaded = true;
  store.stale = wasStale;
  // Live means at least one answer came from the server itself, not the offline cache.
  return { any, live: results.some(([, v, s]) => v !== undefined && !s) };
}

export const needsYou = () => store.tasks.filter(needsApproval).length + store.messages.filter((m) => m.hold === 'needs_ok').length;
export const working = () => store.tasks.filter((t) => t.state === 'active' || t.state === 'verifying').length;
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

// ---- Home ---------------------------------------------------------------------------------

function summary() {
  const n = needsYou();
  const w = working();
  if (!store.reachable) return 'Nova isn’t answering right now.';
  if (store.problems.length) return `Something went wrong; it’s in Health.`;
  if (n) return `${n === 1 ? 'One thing needs' : `${n} things need`} you.`;
  if (w) return `Nova is working on ${w === 1 ? 'one thing' : `${w} things`}.`;
  return 'Nothing needs you.';
}

const today = (now = new Date()) => now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function renderHome(el, now = new Date()) {
  const name = store.identity?.address_as ?? store.identity?.user_name ?? '';
  const unread = store.messages.filter((m) => (m.hold === 'needs_ok' || (m.delivered_at && !m.read_at)));
  const asking = store.tasks.filter(needsApproval);
  const verified = store.tasks.find((t) => t.state === 'done' && t.verification?.ok);
  const needsCard = asking.length
    ? card({ kind: 'needs-you-card', title: 'Needs you', icon: 'handling', body: `<ul class="task-list">${asking.slice(0, 3).map((t) => taskRow(t, { now })).join('')}</ul>` })
    : '';
  el.innerHTML = `${unread.slice(0, 2).map(proactiveBanner).join('')}
<header class="home-hero">${liveOrb('hero')}
  <h2 class="greeting">${esc(greeting(now, name))}</h2>
  <p class="greeting-sub">${esc(today(now))} · ${esc(summary())}</p>
</header>
<div class="home-cards">
  ${needsCard}
  ${briefCard()}
  ${verified ? verifiedResultCard(verified, { now }) : ''}
  <div data-asideable>${handlingCard({ tasks: store.tasks, now })}</div>
  <div data-asideable>${deviceMeshCard({ devices: [thisDevice()] })}</div>
  ${memoryHighlightCard({ records: store.memory })}
  <div data-asideable>${healthCard({ health: store.health, problems: store.problems, reachable: store.reachable })}</div>
</div>`;
}

// The right column (desktop) or context pane (tablet): three quiet cards.
export function renderAside(el, now = new Date()) {
  el.innerHTML = `${handlingCard({ tasks: store.tasks, now })}
${deviceMeshCard({ devices: [thisDevice()] })}
${healthCard({ health: store.health, problems: store.problems, reachable: store.reachable })}`;
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

export function renderTasks(el, now = new Date()) {
  const by = new Map(GROUPS.map(([k]) => [k, []]));
  for (const t of store.tasks) by.get(statusOf(t))?.push(t);
  const groups = GROUPS.filter(([k]) => by.get(k).length).map(([k, title]) => `<section class="panel task-group" aria-labelledby="tg-${k}">
  <h2 class="section-title" id="tg-${k}">${esc(title)}</h2>
  <ul class="task-list">${by.get(k).map((t) => taskRow(t, { now })).join('')}</ul>
</section>`).join('');
  el.innerHTML = `<header class="view-head"><h2 class="view-title">Tasks</h2>
<p class="view-lede">Everything Nova takes on, in plain words. Nothing is done until Nova has checked the evidence; tap Verified to see it.</p></header>
${groups || emptyState({ title: 'Nothing needs you', line: 'No tasks yet. When Nova takes something on, it shows here until it’s verified.', orbState: 'idle' })}`;
}

// One task in the sheet: the approval when it waits for one, else its evidence and history.
export async function openTask(id) {
  let t;
  let events = [];
  try {
    [t, events] = await Promise.all([api('GET', `/tasks/${encodeURIComponent(id)}`), api('GET', `/tasks/${encodeURIComponent(id)}/events`).catch(() => [])]);
  } catch (e) { toast(e.message); return; }
  if (needsApproval(t)) {
    const worker = store.workers.find((w) => w.id === t.owner) ?? null;
    openSheet(approvalSheet(t, { worker }), { label: 'Needs your OK' });
    return;
  }
  const actions = [];
  if (t.state === 'waiting') actions.push(`<button type="button" class="btn primary" data-action="retry-task" data-task="${esc(t.id)}">Try again</button>`);
  if (isOpen(t)) actions.push(`<button type="button" class="btn" data-action="cancel-task" data-task="${esc(t.id)}">Cancel the task</button>`);
  const timeline = events.length ? `<details class="raw"><summary>What happened</summary><ul class="timeline">${events.map((e) => `<li>${esc(new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))} · ${esc(e.kind.replace(/_/g, ' '))}${e.to_state ? ` → ${esc(e.to_state)}` : ''}</li>`).join('')}</ul></details>` : '';
  openSheet(`${evidenceViewer(t)}${timeline}${actions.length ? `<div class="sheet-actions">${actions.join('')}</div>` : ''}`, { label: t.title });
}

export async function approve(form) {
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

export async function taskAction(action, id) {
  try {
    if (action === 'retry-task') await api('POST', `/tasks/${encodeURIComponent(id)}/retry`);
    if (action === 'cancel-task') await api('POST', `/tasks/${encodeURIComponent(id)}/cancel`, { reason: 'Cancelled by you.' });
    closeSheet();
    toast(action === 'retry-task' ? 'Trying again.' : 'Cancelled.');
    await load(['tasks']);
  } catch (e) { toast(e.message); }
}

// ---- Health -------------------------------------------------------------------------------

const CHECK_NAMES = { database: 'Database', workers: 'Workers', ledger: 'Work Ledger', extensions: 'Extensions', design: 'Design system', triggers: 'Automations', problems: 'Problems', memory: 'Memory', receipts: 'Context receipts' };
function checkLine(key, c) {
  if (key === 'workers') return c.ok ? `${c.workers?.length ?? 0} ready.` : c.detail;
  if (key === 'ledger') return Object.entries(c.counts ?? {}).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'No tasks yet.';
  if (key === 'design') return `Showing ${appearance().list.find((d) => d.id === c.active)?.name ?? c.active}.`;
  if (key === 'problems') return c.open ? `${c.open} open.` : 'None open.';
  if (c.counts) return Object.entries(c.counts).filter(([, n]) => typeof n === 'number' && n).map(([s, n]) => `${n} ${s.replace(/_/g, ' ').replace(/s$/, n === 1 ? '' : 's')}`).join(', ') || 'Nothing yet.';
  return c.detail ?? (c.ok ? 'Fine.' : 'Not fine.');
}

export function renderHealth(el) {
  const h = store.health;
  const problem = (p, open) => `<li class="settings-row" id="pr-${esc(String(p.id))}">
  <div class="settings-text"><p class="settings-label">${esc(p.message)}</p><p class="settings-note">${esc(p.source)} · ${esc(ago(p.at))}${p.task_id ? ` · <a class="link" href="/tasks" data-action="open-task" data-task="${esc(p.task_id)}">the task</a>` : ''}</p>
  ${p.detail ? `<details class="raw"><summary>Technical detail</summary><pre tabindex="0">${esc(p.detail)}</pre></details>` : ''}</div>
  ${open ? `<div class="settings-control"><button type="button" class="btn small" data-action="resolve-problem" data-problem="${esc(String(p.id))}">Mark as dealt with</button></div>` : ''}
</li>`;
  const checks = h ? Object.entries(h.checks).map(([k, c]) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(CHECK_NAMES[k] ?? k)}</p><p class="settings-note">${esc(checkLine(k, c))}</p></div>${c.ok ? '<span class="pill is-on">Fine</span>' : '<span class="pill is-warn">Needs a look</span>'}</li>`).join('') : '';
  el.innerHTML = `<header class="view-head"><h2 class="view-title">Health</h2>
<p class="view-lede">${!store.reachable ? 'Nova isn’t answering. This page reconnects when it’s back.' : store.problems.length ? 'Something went wrong. Each problem says what happened; the detail is one tap away.' : 'Everything Nova runs on, and anything that went wrong.'}</p></header>
<section class="panel" aria-labelledby="h-problems"><h3 class="section-title" id="h-problems">Problems</h3>
${store.problems.length ? `<ul class="settings-list">${store.problems.map((p) => problem(p, true)).join('')}</ul>` : emptyState({ title: 'Nothing needs you', line: 'No problems are open.' })}</section>
<section class="panel" aria-labelledby="h-checks"><h3 class="section-title" id="h-checks">Checks</h3>
${h ? `<ul class="settings-list">${checks}</ul><p class="settings-note">Version ${esc(h.version)} · running for ${esc(uptime(h.uptime_s))}.</p>` : '<p class="settings-note">Checking…</p>'}</section>
${store.resolved.length ? `<details class="panel raw"><summary>Dealt with recently</summary><ul class="settings-list">${store.resolved.map((p) => problem(p, false)).join('')}</ul></details>` : ''}`;
}
const uptime = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

// ---- automation rules (above Era 2's schedules) -------------------------------------------

export function renderRules(el) {
  el.innerHTML = `<header class="view-head"><h2 class="view-title">Automations</h2>
<p class="view-lede">Everything that runs on its own. Nothing runs that isn’t listed here, and each can be paused or removed.</p></header>
<section class="panel" aria-labelledby="ru-title"><h3 class="section-title" id="ru-title">Rules</h3>
${store.rules.length ? `<ul class="trigger-list">${store.rules.map(triggerRow).join('')}</ul>` : '<p class="settings-note">No rules yet. Rules start work or send a message when something happens or on a schedule.</p>'}</section>`;
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

const PRIVACY = [
  ['local-only', 'Local-only', 'Nothing leaves this machine. Never falls back to the cloud.'],
  ['local-preferred', 'Local first', 'Local first; cloud help only when local isn’t enough, and recorded.'],
  ['cloud-allowed', 'Cloud allowed', 'Nova may use cloud services within your policy.'],
];
const DIRECTNESS = [['gentle', 'Gently'], ['balanced', 'Plainly'], ['blunt', 'Bluntly']];

export function renderYou() {
  const i = store.identity ?? {};
  const field = (id, value, labelText) => `<label class="sr-only" for="${id}">${esc(labelText)}</label><input class="input" id="${id}" value="${esc(value ?? '')}" maxlength="40" autocomplete="off">`;
  return `<section class="memory-section" id="you" aria-labelledby="set-you"><h2 class="memory-heading" id="set-you">You and Nova</h2>
<ul class="settings-list">
${settingsRow({ title: 'Your name', note: 'What Nova calls you.', control: `${field('you-name', i.user_name, 'Your name')}<button type="button" class="btn small" data-action="save-profile" data-section="user" data-key="name" data-field="you-name">Save</button>` })}
${settingsRow({ title: 'Nova’s name', note: 'Only the name changes; the charter stays.', control: `${field('nova-name', i.name, 'Nova’s name')}<button type="button" class="btn small" data-action="save-profile" data-section="identity" data-key="name" data-field="nova-name">Save</button>` })}
${settingsRow({ title: 'Directness', note: 'Nova always says when it thinks something’s wrong; this is how.', control: `<label class="sr-only" for="directness">Directness</label><select class="input" id="directness" data-action="set-profile" data-section="tuning" data-key="directness">${DIRECTNESS.map(([v, l]) => `<option value="${v}"${i.directness === v ? ' selected' : ''}>${l}</option>`).join('')}</select>` })}
</ul></section>
<section class="memory-section" id="privacy" aria-labelledby="set-privacy"><h2 class="memory-heading" id="set-privacy">Privacy</h2>
<p class="memory-lede">The default for every task. A task can be stricter, never looser.</p>
<fieldset class="set-field"><legend class="sr-only">Privacy mode</legend><div class="choices">${PRIVACY.map(([v, l]) => `<label class="choice"><input type="radio" name="privacy" value="${v}"${privacy() === v ? ' checked' : ''}><span class="choice-name">${l}</span></label>`).join('')}</div></fieldset>
<p class="settings-note">${esc(PRIVACY.find(([v]) => v === privacy())?.[2] ?? '')}</p></section>`;
}

export async function saveProfile(section, key, value) {
  try {
    await api('PUT', `/profile/${section}/${key}`, { value });
    await load(['profile']);
    toast('Saved.');
  } catch (e) { toast(e.message); }
}

let previewId = null;
const SAMPLE = {
  tasks: [
    { id: 's1', title: 'Summarize the week’s notes', state: 'active', reason: null, approval_tier: 1, user_visibility: 'handling', created_at: new Date().toISOString() },
    { id: 's2', title: 'Send the draft reply', state: 'waiting', approval_tier: 2, approved_at: null, user_visibility: 'attention', created_at: new Date().toISOString() },
  ],
  done: { id: 's3', title: 'Write a welcome note', state: 'done', report: { summary: 'The note is in your workspace.' }, verification: { ok: true, checks: [{ ok: true }] }, completed_at: new Date().toISOString() },
};

// A sample of the real components, drawn in a sandboxed frame with only the previewed design
// system's CSS: nothing is applied until the person says so.
function previewDoc(id, mode) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${previewCss(id, mode)}"><link rel="stylesheet" href="/styles/base.css"><link rel="stylesheet" href="/styles/components.css"><link rel="stylesheet" href="/styles/views.css">
</head><body data-layout="phone" style="overflow:auto"><main class="view home">
<header class="home-hero">${orb({ state: 'idle', size: 'hero', decorative: true })}<h2 class="greeting">Good morning</h2><p class="greeting-sub">Nothing needs you.</p></header>
<div class="home-cards">${handlingCard({ tasks: SAMPLE.tasks })}${verifiedResultCard(SAMPLE.done)}
<div class="card"><div class="chat-bubble from-person"><div class="bubble-body">What’s on today?</div></div><div class="chat-bubble from-nova">${orb({ size: 'avatar', decorative: true })}<div class="bubble-body">Two things, both small.</div></div>
<div class="card-action"><span class="btn primary">Approve</span><span class="btn">Not now</span>${status('failed')}</div></div></div>
</main></body></html>`;
}

export function renderAppearance() {
  const a = appearance();
  const usable = a.list.filter((d) => d.state !== 'disabled');
  previewId ??= a.theme;
  const name = (id) => a.list.find((d) => d.id === id)?.name ?? id;
  const tags = (d) => [d.id === a.user ? '<span class="pill is-on">All devices</span>' : '', d.id === a.device ? '<span class="pill is-on">This device</span>' : '', d.valid ? '' : '<span class="pill is-warn">Has problems</span>'].join('');
  const cards = usable.map((d) => `<li><button type="button" class="ds-card" data-action="preview-ds" data-ds="${esc(d.id)}" aria-pressed="${d.id === previewId}"${d.valid ? '' : ' disabled'}>
  <span class="ds-name">${esc(d.name)}</span><span class="ds-note">${esc(d.description || '')}</span><span class="ds-tags">${tags(d)}</span>
</button>${d.valid ? '' : `<p class="settings-note">${esc(d.problems.slice(0, 2).join(' '))}</p>`}</li>`).join('');
  const shown = a.scope === 'device' ? `This device shows ${name(a.theme)}, its own choice.` : a.scope === 'user' ? `Every device shows ${name(a.theme)}.` : `Showing ${name(a.theme)}, the default.`;
  return `<section class="memory-section" id="appearance" aria-labelledby="set-look"><h2 class="memory-heading" id="set-look">Appearance</h2>
<p class="memory-lede">${esc(shown)} Preview a design system here; nothing changes until you apply it.</p>
<ul class="ds-grid" aria-label="Design systems">${cards}</ul>
<iframe class="preview-frame" id="ds-preview" title="Preview of ${esc(name(previewId))}" sandbox srcdoc="${esc(previewDoc(previewId, a.mode))}"></iframe>
<div class="sheet-actions">
  <button type="button" class="btn primary" data-action="apply-ds" data-scope="user" data-ds="${esc(previewId)}">Use ${esc(name(previewId))} on all devices</button>
  <button type="button" class="btn" data-action="apply-ds" data-scope="device" data-ds="${esc(previewId)}">On this device only</button>
</div>
<div class="sheet-actions">
  <button type="button" class="btn small quiet" data-action="rollback-ds" data-scope="user"${a.canRollback.user ? '' : ' disabled'}>Undo the last change for all devices</button>
  <button type="button" class="btn small quiet" data-action="rollback-ds" data-scope="device"${a.canRollback.device ? '' : ' disabled'}>Undo the last change on this device</button>
</div>
<fieldset class="set-field"><legend class="set-legend">Light and dark</legend>
<div class="choices">${MODES.map((m) => `<label class="choice"><input type="radio" name="mode" value="${m}"${m === a.mode ? ' checked' : ''}><span class="choice-name">${m[0].toUpperCase()}${m.slice(1)}</span></label>`).join('')}</div></fieldset>
<p class="perm-foot"><a class="set-link" href="/styleguide">Style reference</a></p></section>`;
}

export function previewDs(id) {
  previewId = id;
}

export async function appearanceAction(action, el) {
  try {
    if (action === 'apply-ds') { await use(el.dataset.ds, el.dataset.scope); toast(el.dataset.scope === 'device' ? 'Applied on this device.' : 'Applied on every device.'); }
    if (action === 'rollback-ds') { await rollback(el.dataset.scope); toast('Back to the one before.'); }
    if (action === 'mode') await setMode(el.value);
  } catch (e) { toast(e.message); }
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; window.dispatchEvent(new CustomEvent('nova:installable')); });
export async function install() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
}

export function renderDevices() {
  const d = thisDevice();
  const installRow = standalone()
    ? settingsRow({ title: 'Installed', note: 'Nova runs as an app on this device.' })
    : installPrompt
      ? settingsRow({ title: 'Install Nova', note: 'Open Nova like an app, with its own window and icon.', control: '<button type="button" class="btn small" data-action="install">Install</button>' })
      : settingsRow({ title: 'Install Nova', note: iosLimits() ? 'In Safari, tap Share, then Add to Home Screen.' : 'Your browser offers Install in its menu when it can.' });
  return `<section class="memory-section" id="devices" aria-labelledby="set-devices"><h2 class="memory-heading" id="set-devices">Devices</h2>
<p class="memory-lede">Only this device for now. Pairing your other devices comes in a later version.</p>
<ul class="device-list">${deviceRow(d)}</ul>
<ul class="settings-list">${installRow}
${iosLimits() ? settingsRow({ title: 'On iPhone and iPad', note: 'An installed Nova can’t work in the background there. Your hub does the always-on work; this screen is a window onto it.' }) : ''}
${settingsRow({ title: 'Device id', note: `${deviceId()}. It lets this device keep its own appearance.` })}</ul></section>`;
}

export { ICONS };
