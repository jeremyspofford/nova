// The PWA's own surfaces, drawn from the core (/api/v1): Home, the right column, Tasks, Health,
// automation rules, and Settings' identity, privacy, appearance and devices. Era 2's views
// (conversations, Memory, Skills, Schedules, Activity, permissions) stay in app.js and view.js.
import { api, deviceId, request } from './core.js';
import { ICONS, KIND_WORDS, addDeviceSheet, ago, approvalSheet, briefCard, card, deviceMeshCard, deviceRow, emptyState, evidenceViewer, handlingCard, healthCard, allowApproveSheet, joinRequestSheet, memoryHighlightCard, orb, proactiveBanner, promoteSheet, revokeSheet, settingsRow, status, taskRow, triggerRow, verifiedResultCard } from './components.js';
import { greeting, isOpen, needsApproval, retryLabel, statusOf } from './status.js';
import { escapeHtml as esc } from './markdown.js';
import { closeSheet, layout, liveOrb, openSheet, sheetOpen, toast } from './shell.js';
import { MODES, current as appearance, previewCss, rollback, setMode, use } from './theme.js';
import { openTakeover } from './takeover.js';

// What the core has told this page, kept fresh by the event stream.
export const store = {
  tasks: [], problems: [], resolved: [], health: null, profile: null, identity: null,
  memory: [], rules: [], messages: [], workers: [], reachable: true, stale: false, loaded: false,
  // The device mesh: the registry, whether other devices can reach Nova (and who this page is),
  // and devices waiting for an OK.
  devices: [], mesh: null, requests: [],
  // Settings › Providers: GET /providers, loaded when Settings opens (M5a).
  providers: null,
  // Keeping Nova running (M7b): the supervisor, releases, backups, the last drill, playbooks.
  resilience: null,
};

const settle = (p, fallback) => p.catch(() => fallback);
export async function load(parts = ['tasks', 'problems', 'health', 'profile', 'memory', 'rules', 'messages', 'workers', 'devices', 'mesh', 'requests', 'resilience']) {
  // Each part comes back as [value, stale].
  const get1 = (path) => request('GET', path).then((r) => [r.data, r.stale]);
  const get = {
    tasks: () => get1('/tasks?limit=100'),
    problems: () => get1('/problems'),
    health: () => get1('/health'),
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
  if (parts.some((p) => p === 'devices' || p === 'mesh' || p === 'requests')) window.dispatchEvent(new CustomEvent('nova:devices'));
  // Live means at least one answer came from the server itself, not the offline cache.
  return { any, live: results.some(([, v, s]) => v !== undefined && !s) };
}

// Everything in the one vocabulary's Needs you: an OK to give, a step only the person can do
// (a browser task waiting for a takeover), a task that is stuck without them.
const asksYou = (t) => statusOf(t) === 'needs-you';
export const needsYou = () => store.tasks.filter(asksYou).length + store.messages.filter((m) => m.hold === 'needs_ok').length + store.requests.length;
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

// The registry once it has answered; until then (or when its answer was cut off as a page was
// left, which reads as null), this browser alone.
const meshDevices = () => (store.devices?.length ? store.devices : [thisDevice()]);

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
  const asking = store.tasks.filter(asksYou);
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
  <div data-asideable>${deviceMeshCard({ devices: meshDevices(), now })}</div>
  ${memoryHighlightCard({ records: store.memory })}
  <div data-asideable>${healthCard({ health: store.health, problems: store.problems, reachable: store.reachable })}</div>
</div>`;
}

// The right column (desktop) or context pane (tablet): three quiet cards.
export function renderAside(el, now = new Date()) {
  el.innerHTML = `${handlingCard({ tasks: store.tasks, now })}
${deviceMeshCard({ devices: meshDevices(), now })}
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
    await new Promise((r) => setTimeout(r, 250));
  }
  if (sheetOpen()) openTask(id);
}

export async function approve(form) {
  if (form.dataset.request) return approveJoin(form);
  if (form.dataset.revoke) return confirmRevoke(form);
  if (form.dataset.allow) return confirmAllow(form);
  if (form.dataset.promote) return confirmPromote(form);
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

const CHECK_NAMES = { database: 'Database', workers: 'Workers', ledger: 'Work Ledger', extensions: 'Extensions', design: 'Design system', triggers: 'Automations', problems: 'Problems', memory: 'Memory', receipts: 'Context receipts', mesh: 'Devices', browser: 'Browser work', backups: 'Backups', changes: 'Changes', capture: 'Capture', vault: 'Vault', connectors: 'Connections', ingest: 'Outside content' };
function checkLine(key, c) {
  if (key === 'workers') return c.ok ? `${c.workers?.length ?? 0} ready.` : c.detail;
  if (key === 'ledger') return Object.entries(c.counts ?? {}).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'No tasks yet.';
  if (key === 'design') return `Showing ${appearance().list.find((d) => d.id === c.active)?.name ?? c.active}.`;
  if (key === 'problems') return c.open ? `${c.open} open.` : 'None open.';
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

export function renderHealth(el) {
  const h = store.health;
  const problem = (p, open) => `<li class="settings-row" id="pr-${esc(String(p.id))}">
  <div class="settings-text"><p class="settings-label">${esc(p.message)}</p><p class="settings-note">${esc(p.source)} · ${esc(ago(p.at))}${p.task_id ? ` · <a class="link" href="/tasks" data-action="open-task" data-task="${esc(p.task_id)}">the task</a>` : ''}</p>
  ${open ? playbookBlock(p) : ''}
  ${p.detail ? `<details class="raw"><summary>Technical detail</summary><pre tabindex="0">${esc(p.detail)}</pre></details>` : ''}</div>
  ${open ? `<div class="settings-control"><button type="button" class="btn small" data-action="resolve-problem" data-problem="${esc(String(p.id))}">Mark as dealt with</button></div>` : ''}
</li>`;
  const fine = (k, c) => c.ok && !(k === 'mesh' && (c.standby?.lag?.behind || c.replica?.sync?.unreachable_since || c.replica?.sync?.refused));
  const checks = h ? Object.entries(h.checks).map(([k, c]) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(CHECK_NAMES[k] ?? k)}</p><p class="settings-note">${esc(checkLine(k, c))}</p></div>${fine(k, c) ? '<span class="pill is-on">Fine</span>' : '<span class="pill is-warn">Needs a look</span>'}</li>`).join('') : '';
  el.innerHTML = `<header class="view-head"><h2 class="view-title">Health</h2>
<p class="view-lede">${!store.reachable ? 'Nova isn’t answering. This page reconnects when it’s back.' : store.problems.length ? 'Something went wrong. Each problem says what happened; the detail is one tap away.' : 'Everything Nova runs on, and anything that went wrong.'}</p></header>
<section class="panel" aria-labelledby="h-problems"><h3 class="section-title" id="h-problems">Problems</h3>
${store.problems.length ? `<ul class="settings-list">${store.problems.map((p) => problem(p, true)).join('')}</ul>` : emptyState({ title: 'Nothing needs you', line: 'No problems are open.' })}</section>
${keepingRunning()}
<section class="panel" aria-labelledby="h-checks"><h3 class="section-title" id="h-checks">Checks</h3>
${h ? `<ul class="settings-list">${checks}</ul><p class="settings-note">Version ${esc(h.version)} · running for ${esc(uptime(h.uptime_s))}.</p>` : '<p class="settings-note">Checking…</p>'}</section>
${store.resolved.length ? `<details class="panel raw"><summary>Dealt with recently</summary><ul class="settings-list">${store.resolved.map((p) => problem(p, false)).join('')}</ul></details>` : ''}`;
}

// A problem's playbook (M7b): what Nova already did about it, and the steps that are the person's.
function playbookBlock(p) {
  const pb = store.resilience?.playbooks?.[p.id];
  if (!pb) return '';
  const did = (pb.repairs ?? []).slice(-3).map((r) => `<li>${esc(r.said)} <span class="is-faint">${esc(ago(r.at))}</span></li>`).join('');
  return `<div class="playbook" data-playbook="${esc(pb.id)}">
  ${did ? `<p class="settings-note"><b>What Nova did</b></p><ul class="steps">${did}</ul>` : pb.automatic ? `<p class="settings-note">${esc(pb.automatic)}</p>` : ''}
  <p class="settings-note"><b>What you can do</b></p><ol class="steps">${pb.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  ${pb.repair ? `<p><button type="button" class="btn small" data-action="repair-problem" data-problem="${esc(String(p.id))}">Try the repair now</button></p>` : ''}
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
  const backupLine = !b.settings.target ? 'No backup folder yet. Choose one with PUT /api/v1/backups/settings; Nova then backs up nightly and drills weekly.'
    : b.target_present === false ? `The backup folder ${b.settings.target} isn’t there (a drive not plugged in?).${b.last_ok ? ` Last backup ${ago(b.last_ok.at)}.` : ''}`
    : b.last_ok ? `Last backup ${ago(b.last_ok.at)}, to ${b.settings.target}. ${b.count} kept (up to ${b.settings.keep}).${b.encrypted !== null ? ` ${b.encrypted} encrypted cop${b.encrypted === 1 ? 'y' : 'ies'} in ${b.settings.encrypted_target}.` : ''}`
    : `Nothing backed up yet to ${b.settings.target}.`;
  // Named like a backup but not made by this Nova (or changed since): never used, said once here.
  const strays = b.strays?.length ? ` ${b.strays.length} folder${b.strays.length === 1 ? '' : 's'} there look${b.strays.length === 1 ? 's' : ''} like a backup but ${b.strays.length === 1 ? 'isn’t' : 'aren’t'} one Nova made; Nova leaves ${b.strays.length === 1 ? 'it' : 'them'} alone and never restores from ${b.strays.length === 1 ? 'it' : 'them'}.` : '';
  const drillLine = !d ? 'No restore drill yet.' : `${d.ok ? 'Passed' : 'Failed'} ${ago(d.at)}: ${d.checks.filter((c) => c.ok).length} of ${d.checks.length} checks.`;
  return `<section class="panel" aria-labelledby="h-keep"><h3 class="section-title" id="h-keep">Keeping Nova running</h3>
<dl class="facts" data-resilience>
  <dt>Supervisor</dt><dd>${sup ? `${esc(MODE_WORDS[sup.mode] ?? sup.mode)}${sup.server?.restarts ? `; restarted ${sup.server.restarts} time${sup.server.restarts === 1 ? '' : 's'}` : ''}.${sup.safe_mode ? ` ${esc(sup.safe_mode.reason)}` : ''}` : 'Not running under the supervisor. node src/supervisor/main.ts run keeps Nova running and takes releases.'}</dd>
  ${rel ? `<dt>Release</dt><dd>${esc(releaseName(rel.current))}${rel.previous ? `; ${esc(releaseName(rel.previous))} is kept to go back to` : ''}.${lastDeploy ? ` Last deploy: ${lastDeploy}.` : ''}</dd>` : ''}
  <dt>Backups</dt><dd>${esc(backupLine + strays)}</dd>
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
    if (action === 'repair-problem') { const r = await api('POST', `/problems/${encodeURIComponent(id)}/repair`); toast(r.said); }
  } catch (e) { toast(e.message); }
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
    if (action === 'apply-ds') {
      await use(el.dataset.ds, el.dataset.scope);
      // This device's own choice still wins here; say so rather than claim the screen changed.
      const own = el.dataset.scope !== 'device' && appearance().scope === 'device';
      toast(el.dataset.scope === 'device' ? 'Applied on this device.' : own ? 'Applied on every other device. This one keeps the design you chose for it.' : 'Applied on every device.');
    }
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

// Settings › Devices: the real registry. Adding a device is the one standout, unless a device is
// already waiting for an OK: then reviewing it is. Revoked devices are kept one layer down.
export function renderDevices() {
  const m = store.mesh;
  const me = m?.you;
  const approver = !!me?.can_approve;
  // A standby shows the hub's registry as it copied it; devices are added and revoked on the hub.
  const copy = !!m?.replica;
  const installRow = standalone()
    ? settingsRow({ title: 'Installed', note: 'Nova runs as an app on this device.' })
    : installPrompt
      ? settingsRow({ title: 'Install Nova', note: 'Open Nova like an app, with its own window and icon.', control: '<button type="button" class="btn small" data-action="install">Install</button>' })
      : settingsRow({ title: 'Install Nova', note: iosLimits() ? 'In Safari, tap Share, then Add to Home Screen.' : 'Your browser offers Install in its menu when it can.' });
  const all = meshDevices();
  const trusted = all.filter((d) => d.trust !== 'revoked');
  const revoked = all.filter((d) => d.trust === 'revoked');
  const actions = (d) => {
    if (copy || !d.id || d.role === 'hub' || d.trust === 'revoked') return '';
    const allow = approver && (d.kind === 'phone' || d.kind === 'browser') && !d.this
      ? `<button type="button" class="btn small quiet" data-action="allow-approve" data-device="${esc(d.id)}" data-value="${d.can_approve ? 'false' : 'true'}">${d.can_approve ? 'Stop it approving' : 'Let it approve'}</button>` : '';
    return `${allow}<button type="button" class="btn small" data-action="revoke-device" data-device="${esc(d.id)}">Revoke</button>`;
  };
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
${waiting ? `<ul class="settings-list">${waiting}</ul>` : ''}
<ul class="device-list device-registry">${trusted.map((d) => deviceRow(d, { actions: actions(d) })).join('')}</ul>
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
  expiry = setTimeout(() => { if (pairing && document.querySelector(`#sheet .add-device[data-pairing="${CSS.escape(pairing.pairing_id)}"]`)) show(); }, Math.max(0, Date.parse(pairing.expires_at) - Date.now()) + 50);
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
  try {
    const { device } = await api('POST', `/mesh/requests/${encodeURIComponent(form.dataset.request)}/approve`, { confirm: true });
    closeSheet();
    toast(`${device.name} is paired.`);
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
    return settingsRow({
      title,
      note: better ? `Nova recommends ${name(rec.id)}. ${rec.why}` : rec.why,
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

export { ICONS };
