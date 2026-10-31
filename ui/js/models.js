// Settings › Models (M6 plan §2): the device map, what Nova recommends for each role and why,
// the roles as assigned, downloads with real progress and the digest Nova read, the disk budget
// and the cloud budget, from /api/v1/models. Nova recommends; it doesn't list every model that
// would run. The one standout is "Use these" while there is a recommendation to take, or the OK
// a download waits for. Installed models and their removal are one layer down.
//
// Each model shows its eval scorecard before the person switches to it (Amendment B Part 4;
// /api/v1/evals/scorecards), and says so plainly when there is none. The decision model (DS1 NOTE
// 4; owner decision 2): Jev's route, model and key, Tev1's size, the two opt-ins (Screening; Box,
// a preview), each with its plain words beside it and again while it is on, every notice before
// saving, and each decision model's scorecard per template.
import { api, on } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { toast } from './shell.js';
import { left, over, since, waitingLine } from './wait.js';

let data = null;
let failed = '';
// The eval scorecards (null: the route didn't answer, so no line is shown), and the decision model.
let cards = null;
let decisions = null;
// What a save waits on: the choices sent, and the notices Nova gave back before saving them.
let pending = null;
let rerender = () => {};
// Live download progress by task, from the event stream (model_progress).
const progress = new Map();

export async function loadModels() {
  try {
    [data, cards, decisions] = await Promise.all([
      api('GET', '/models'),
      api('GET', '/evals/scorecards').catch(() => null),
      api('GET', '/models/decisions').catch(() => null),
    ]);
    failed = '';
    over('models');
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

const GB = 1024 ** 3;
const size = (b) => (b >= 10 * GB ? `${Math.round(b / GB)} GB` : b >= GB ? `${(b / GB).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
// While layers are still arriving, Ollama hasn't said the whole size yet: the total is a floor.
// Bytes so far, in real units; after 10 s, time left from the measured rate ("about 3 minutes left").
const sofar = (p) => {
  const est = p.task_id ? left(p.completed ?? 0, p.total ?? 0, Date.now() - since(`download-${p.task_id}`)) : '';
  return `${size(p.completed ?? 0)} of ${/^pulling/.test(p.status ?? '') ? 'at least ' : ''}${size(p.total ?? 0)}${p.status ? ` · ${p.status}` : ''}${est ? ` · ${est}` : ''}`;
};
const STATE_WORDS = { ready: ['Ready', 'is-on'], down: ['Not answering', 'is-warn'], asleep: ['Asleep', ''], unassigned: ['Not set', ''], 'no-runtime': ['No runtime', ''] };

// A model's latest regression scorecard, before the person switches to it; "none" said plainly.
const NO_CARD = 'No scorecard: Nova hasn’t run its regression tasks against this model. You can still switch to it; how well it does here is unchecked.';
function cardFor(model) {
  if (!cards || !model) return null;
  const configured = cards.configured?.find((c) => c.target?.model === model);
  if (configured) return configured;
  const kept = cards.cards?.find((c) => c.target?.model === model);
  const reg = kept?.suites?.regression;
  if (!reg) return { state: 'none', words: NO_CARD };
  const when = new Date(reg.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const score = `${reg.passed} of ${reg.total} regression tasks passed (${Math.round(reg.pass_rate * 100)}%), ${when}`;
  return reg.fingerprint === cards.fingerprint ? { state: 'current', words: `${score}.` } : { state: 'stale', words: `${score}. Not current: the regression tasks have changed since. You can still switch to it.` };
}
function scoreLine(model) {
  const c = cardFor(model);
  return c ? `<p class="settings-note model-score${c.state === 'current' ? '' : ' is-unchecked'}">${esc(c.words)}</p>` : '';
}

function deviceCard(d) {
  const pill = d.online ? '<span class="pill is-on">Online</span>' : '<span class="pill">Asleep or away</span>';
  return `<li class="model-device" data-device="${esc(d.id)}">
  <div class="conn-head"><p class="settings-label">${esc(d.name)}${d.hub ? ' <span class="model-tag">hub</span>' : ''}</p>${pill}</div>
  <p class="settings-note">${esc(d.words)}</p>
  ${d.capacity ? `<p class="settings-note">${esc(d.capacity)}</p>` : ''}
  ${d.runtime ? `<p class="settings-note">${esc(d.runtime.words)}</p>` : ''}
  ${d.wake ? `<p class="settings-note">${esc(d.wake.words)}</p>` : ''}
  ${d.decision_model?.model ? `<p class="settings-note">Decision model: ${esc(d.decision_model.model)}${d.decision_model.digest ? ` (sha256:${esc(d.decision_model.digest.replace(/^sha256:/, '').slice(0, 12))}…)` : ''}. ${esc(d.decision_model.why)}</p>` : ''}
</li>`;
}

function roleRow(r) {
  const [label, tone] = STATE_WORDS[r.state] ?? ['', ''];
  const where = r.assigned ? `${r.assigned.model} on ${r.assigned.device_name}${r.assigned.hub_model ? `; small jobs: ${r.assigned.hub_model} on the hub` : ''}.` : '';
  const lines = [];
  if (where) lines.push(`<p class="settings-note model-where">${esc(where)}${r.problem ? ` ${esc(r.problem)}` : ''}</p>`);
  if (r.assigned) lines.push(scoreLine(r.assigned.model));
  if (r.role === 'transcriber') lines.push(`<p class="settings-note">${esc(r.words)}</p>`);
  else if (r.recommended) {
    const p = r.recommended;
    lines.push(`<p class="settings-note model-why">${r.assigned ? 'Nova would use' : 'Nova recommends'} <strong>${esc(p.model)}</strong>${p.device !== 'hub' ? ` on ${esc(p.device_name)}` : ''}: ${esc(p.why)} ${esc(p.tradeoff)}</p>`);
    lines.push(scoreLine(p.model));
    if (!p.installed) lines.push(`<div class="sheet-actions"><button type="button" class="btn small" data-action="models-pull" data-model="${esc(p.model)}">Download ${esc(p.model)} (${esc(size(p.size))})</button></div>`);
  } else if (!r.assigned && r.words) lines.push(`<p class="settings-note">${esc(r.words)}</p>`);
  return `<li class="model-role" data-role="${esc(r.role)}">
  <div class="conn-head"><p class="settings-label">${esc(r.name)}</p>${label ? `<span class="pill ${tone}">${esc(label)}</span>` : ''}</div>
  <p class="settings-note">For ${esc(r.does)}.</p>
  ${lines.join('\n  ')}
</li>`;
}

function downloadRow(t) {
  const live = progress.get(t.id);
  if (t.needs_ok) {
    return `<li class="model-download" data-task="${esc(t.id)}"><p class="settings-label">${esc(t.title)}</p>
  <p class="settings-note">Ollama downloads it from its library on the internet; nothing of yours is sent.${t.size ? ` About ${esc(size(t.size))}.` : ''}</p>
  <div class="sheet-actions"><button type="button" class="btn primary" data-action="models-approve" data-task="${esc(t.id)}">${t.action === 'remove' ? 'Remove it' : 'Download it'}</button><button type="button" class="btn quiet" data-action="models-cancel" data-task="${esc(t.id)}">Not now</button></div></li>`;
  }
  if (t.state === 'active' || t.state === 'queued' || t.state === 'verifying') {
    const total = live?.total ?? 0;
    const done = live?.completed ?? 0;
    const bar = total ? `<progress class="model-progress" max="${total}" value="${done}" aria-label="${esc(t.title)}"></progress><p class="settings-note">${esc(sofar(live))}</p>` : (live?.status ? `<p class="settings-note">${esc(live.status)}</p>` : waitingLine('Starting the download', { key: `download-${t.id}` }));
    return `<li class="model-download" data-task="${esc(t.id)}"><p class="settings-label">${esc(t.title)}</p>${bar}</li>`;
  }
  const ok = t.state === 'done';
  const digest = ok && t.action === 'pull' && t.digest ? `<p class="settings-note model-digest">Digest sha256:${esc(t.digest.slice(0, 12))}…, read by Nova from Ollama itself.</p>` : '';
  return `<li class="model-download" data-task="${esc(t.id)}"><div class="conn-head"><p class="settings-label">${esc(t.title)}</p><span class="pill ${ok ? 'is-on' : t.state === 'failed' ? 'is-warn' : ''}">${ok ? 'Verified' : t.state === 'failed' ? 'Failed' : esc(t.state)}</span></div>
  ${!ok && t.reason ? `<p class="settings-note">${esc(t.reason)}</p>` : ''}${digest}</li>`;
}

function installedList(models) {
  return models.map((m) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(m.name)}</p><p class="settings-note">${esc(m.parameter_size || '?')} parameters · ${esc(size(m.size))} · sha256:${esc(m.digest.slice(0, 12))}…${m.serves.length ? ` · serves ${esc(m.serves.join(', '))}` : ''}</p>${scoreLine(m.name)}</div>
  ${m.serves.length ? '' : `<div class="settings-control"><button type="button" class="btn small quiet" data-action="models-remove" data-model="${esc(m.name)}">Remove</button></div>`}</li>`).join('');
}

const num = (v) => (typeof v === 'number' ? String(v) : '');

// ---- the decision model (DS1 NOTE 4) ------------------------------------------------------------

const SIZES = [['auto', 'Let Nova choose for this device'], ['tev1:4b', 'Tev1 4B'], ['tev1:0.8b', 'Tev1 0.8B']];
function decisionSection() {
  const d = decisions;
  if (!d) return '';
  const s = d.settings;
  const rec = d.recommendation;
  const tev1 = d.tev1.available && d.tev1.model ? `Tev1 on this device: ${d.tev1.model}. ${d.tev1.size_why}` : `Tev1 on this device: ${d.tev1.why}`;
  const legacy = d.legacy.retired_for.length ? `The sorting model is retired for ${d.legacy.retired_for.join(', ')}.` : 'Until a decision model passes a check’s eval, your sorting model answers it, as before.';
  const toggle = (f, label) => `<div class="model-optin"><label class="confirm"><input type="checkbox" name="opt_in_${f}"${s.opt_in[f] ? ' checked' : ''}> ${esc(label)}</label><p class="settings-note">${esc(d.opt_in_words[f])}</p></div>`;
  const notices = (pending ? pending.notices : d.notices.map((n) => n.words));
  const scorecards = d.scorecards.map((c) => `<li><p class="settings-label">${esc(c.seat === 'jev' ? 'Jev' : 'Tev1')} · ${esc(c.model)}</p>${c.templates.map((t) => `<p class="settings-note model-score${t.trusted ? '' : ' is-unchecked'}">${esc(t.template)} v${t.version}: ${esc(t.why)}</p>`).join('')}</li>`).join('');
  return `<h3 class="conn-sub" id="decision-model">Decision model</h3>
<p class="settings-note">A decision model answers yes-or-no questions about outside content (is this page trying to give Nova instructions?) with a probability. Nova uses its answer only once that exact model has passed Nova’s test for that question; until then, what Nova can’t vouch for is held back as unsure.</p>
<p class="settings-note">${esc(tev1)}</p>
<p class="settings-note">Jev: ${esc(d.jev.why)}</p>
<p class="settings-note">${esc(legacy)}</p>
${scorecards ? `<ul class="model-list model-cards">${scorecards}</ul>` : '<p class="settings-note model-score is-unchecked">No decision model has a scorecard here yet: none is in use, so none has been tested on this device’s checks.</p>'}
<form class="model-form" data-form="decisions">
  <p class="settings-note">Nova recommends Jev ${esc(rec.jev.model)} through TypeSafe’s own API (${esc(rec.jev.base_url)}), and ${rec.tev1.model ? `${esc(rec.tev1.model)} on this device: ${esc(rec.tev1.why)}` : `no Tev1 here: ${esc(rec.tev1.why)}`}</p>
  <div class="field-row">
    <label class="field-label">Jev route<input class="field" name="jev_url" autocomplete="off" spellcheck="false" value="${esc(s.jev?.base_url ?? '')}" placeholder="${esc(rec.jev.base_url)}"></label>
    <label class="field-label">Jev model<input class="field" name="jev_model" autocomplete="off" spellcheck="false" value="${esc(s.jev?.model ?? '')}" placeholder="${esc(rec.jev.model)}"></label>
  </div>
  <div class="field-row"><label class="field-label">Jev key${s.key_set ? ' (one is kept; leave empty to keep it)' : ''}<input class="field" name="jev_key" type="password" autocomplete="off" placeholder="${s.key_set ? 'Kept in the vault' : 'From TypeSafe'}"></label></div>
  <p class="settings-note">The key is kept in Nova’s vault and never shown again. No call is made to Jev until a route and a key are set.</p>
  <div class="field-row"><label class="field-label">Tev1 size<select class="field" name="tev1">${SIZES.map(([v, w]) => `<option value="${v}"${(s.tev1?.model ?? 'auto') === v ? ' selected' : ''}>${esc(w)}</option>`).join('')}</select></label></div>
  ${toggle('screening', 'Screening: let Jev judge outside content in local modes')}
  <p class="settings-note">Screening covers pages, mail, files and tool output. Text from Capture (screen text and meeting transcripts) never goes to Jev, in any mode: only your local models and Nova’s own checks screen it.</p>
  ${toggle('box', 'Box (preview): let Jev judge images')}
  ${notices.length ? `<ul class="model-notices">${notices.map((w) => `<li class="settings-note is-unchecked">${esc(w)}</li>`).join('')}</ul>` : ''}
  ${pending ? '<p class="settings-note">This changes where outside content may go or which model judges it. Read the notices above first.</p>' : ''}
  <div class="sheet-actions">${pending ? '<button type="button" class="btn small primary" data-action="models-decisions-confirm">Save these choices</button><button type="button" class="btn small quiet" data-action="models-decisions-cancel">Not now</button>' : '<button type="submit" class="btn small">Save</button>'}</div>
</form>`;
}

// The choices in the form, as PUT /models/decisions takes them.
function decisionChoices(form) {
  const f = new FormData(form);
  const url = String(f.get('jev_url') ?? '').trim();
  const model = String(f.get('jev_model') ?? '').trim();
  const key = String(f.get('jev_key') ?? '').trim();
  return {
    jev: url || model ? { base_url: url || decisions.recommendation.jev.base_url, model: model || decisions.recommendation.jev.model } : null,
    tev1: { model: String(f.get('tev1') ?? 'auto') },
    opt_in: { screening: f.get('opt_in_screening') === 'on', box: f.get('opt_in_box') === 'on' },
    ...(key ? { key } : {}),
  };
}

async function saveDecisions(body) {
  try {
    decisions = await api('PUT', '/models/decisions', body);
    pending = null;
    toast('Decision-model choices saved.');
  } catch (e) {
    // Tier 2: Nova gives back every notice first; the person reads them and saves again.
    if (e.status === 409) pending = { body, notices: e.details ?? [] };
    else { pending = null; toast(e.details?.length ? `${e.message} ${e.details.join(' ')}` : e.message); }
  }
  rerender();
}

export function renderModels() {
  const head = '<section class="memory-section" id="models" aria-labelledby="set-models"><h2 class="memory-heading" id="set-models">Models</h2>';
  if (!data) return `${head}${failed ? `<p class="memory-lede">${esc(failed)}</p><button type="button" class="btn set-retry" data-action="models-retry">Try again</button>` : waitingLine('Loading models', { key: 'models' })}</section>`;
  const hub = data.devices[0];
  const lede = hub?.runtime?.ok
    ? 'Nova runs models on your own devices. Here is what each can do, with a suggested model for each job.'
    : `Nova runs models on your own devices, through Ollama. ${hub?.runtime ? hub.runtime.words : ''}`;
  const standout = data.standout === 'accept' && !data.recent.some((t) => t.needs_ok);
  const cloud = data.cloud;
  const b = cloud.budget ?? {};
  return `${head}
<p class="memory-lede">${esc(lede)}</p>
<h3 class="conn-sub">Your devices</h3>
<ul class="model-list">${data.devices.map(deviceCard).join('')}</ul>
<h3 class="conn-sub">What runs where</h3>
<ul class="model-list">${data.roles.map(roleRow).join('')}</ul>
${data.standout === 'accept' ? `<div class="sheet-actions"><button type="button" class="btn${standout ? ' primary' : ''}" data-action="models-accept">Use these</button></div>` : ''}
${data.recent.length ? `<h3 class="conn-sub">Downloads</h3><ul class="model-list">${data.recent.map(downloadRow).join('')}</ul>` : ''}
${decisionSection()}
<h3 class="conn-sub">Disk</h3>
<form class="model-form" data-form="disk"><p class="settings-note">${esc(data.disk.words)}</p>
  <div class="field-row"><label class="field-label">Disk budget for models (GB)<input class="field" name="gb" type="number" min="1" step="1" inputmode="numeric" value="${esc(data.disk.budget_bytes ? String(Math.round(data.disk.budget_bytes / GB)) : '')}" placeholder="No budget"></label></div>
  <div class="sheet-actions"><button type="submit" class="btn small">Save</button></div></form>
<h3 class="conn-sub">Cloud</h3>
<form class="model-form" data-form="budget"><p class="settings-note">${esc(cloud.words)}</p>
  <div class="field-row">
    <label class="field-label">Per task (US$)<input class="field" name="per_task_usd" type="number" min="0" step="0.01" value="${esc(num(b.per_task_usd))}" placeholder="No limit"></label>
    <label class="field-label">Per ${esc(b.period ?? 'month')} (US$)<input class="field" name="per_period_usd" type="number" min="0" step="0.01" value="${esc(num(b.per_period_usd))}" placeholder="No limit"></label>
  </div>
  <p class="settings-note">Over budget, work that needs the cloud waits and says why; local models stay the default.</p>
  <div class="sheet-actions"><button type="submit" class="btn small">Save budget</button></div></form>
<details class="raw model-more"><summary>Installed on ${esc(hub?.name ?? 'the hub')} (${data.installed.length})</summary>
  <ul class="settings-list">${installedList(data.installed)}</ul>
  <form class="model-form" data-form="pull"><div class="field-row"><label class="field-label">Download another model<input class="field" name="model" autocomplete="off" spellcheck="false" placeholder="name:tag"></label></div>
  <div class="sheet-actions"><button type="submit" class="btn small">Download</button></div></form>
</details>
</section>`;
}

async function act(fn, done) {
  try {
    const r = await fn();
    if (done) toast(typeof done === 'function' ? done(r) : done);
  } catch (e) { toast(e.message); }
  await loadModels();
}

// Wires the part into Settings: `render` redraws it when the data changes.
export function bindModels(root, render) {
  // A redraw never wipes what the person is typing into one of this part's fields: it waits until
  // they leave the field.
  let held = false;
  const typing = () => { const a = document.activeElement; return !!a?.closest?.('#models .model-form') && a.matches('input'); };
  rerender = () => { if (typing()) { held = true; return; } held = false; render(); };
  root.addEventListener('focusout', () => { if (held) setTimeout(() => { if (held && !typing()) rerender(); }, 0); }); // wait: after the event: focus has settled
  on('models', () => { if (document.getElementById('models')) loadModels(); });
  on('model_progress', (p) => {
    if (!p?.task_id) return;
    since(`download-${p.task_id}`);
    progress.set(p.task_id, p);
    const row = document.querySelector(`.model-download[data-task="${CSS.escape(p.task_id)}"]`);
    const bar = row?.querySelector('progress');
    // Moves the bar in place, so a download doesn't redraw the whole section many times a second.
    if (bar && p.total) { bar.max = p.total; bar.value = p.completed; const note = bar.nextElementSibling; if (note) note.textContent = sofar(p); }
    else if (row) rerender();
  });
  on('task', (t) => { if (data?.recent.some((x) => x.id === t?.id) || t?.title?.startsWith('Download ') || t?.title?.startsWith('Remove ')) loadModels(); });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !b.dataset.action.startsWith('models-')) return;
    const a = b.dataset.action;
    if (a === 'models-retry') loadModels();
    if (a === 'models-accept') act(() => api('POST', '/models/roles/accept'), (r) => (r.assigned.length ? `Nova uses ${r.assigned.length === 1 ? 'that model' : 'those models'} now.` : 'Nothing to change.'));
    if (a === 'models-pull') act(() => api('POST', '/models/pull', { model: b.dataset.model }), 'Nova asks before it downloads anything: see Downloads.');
    if (a === 'models-remove') act(() => api('POST', '/models/remove', { model: b.dataset.model }), 'Nova asks before it removes it: see Downloads.');
    if (a === 'models-approve') act(() => api('POST', `/tasks/${encodeURIComponent(b.dataset.task)}/approve`, {}), null);
    if (a === 'models-cancel') act(() => api('POST', `/tasks/${encodeURIComponent(b.dataset.task)}/cancel`, { reason: 'Not now.' }), null);
    if (a === 'models-decisions-confirm' && pending) saveDecisions({ ...pending.body, confirm: true });
    if (a === 'models-decisions-cancel') { pending = null; rerender(); }
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('.model-form');
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const n = (v) => (v === '' || v === undefined ? null : Number(v));
    if (form.dataset.form === 'disk') act(() => api('PUT', '/models/disk-budget', { gb: n(f.gb) }), 'Disk budget saved.');
    if (form.dataset.form === 'budget') act(() => api('PUT', '/models/budget', { per_task_usd: n(f.per_task_usd), per_period_usd: n(f.per_period_usd), period: data?.cloud?.budget?.period ?? 'month' }), 'Cloud budget saved.');
    if (form.dataset.form === 'pull' && f.model) act(() => api('POST', '/models/pull', { model: String(f.model).trim() }), 'Nova asks before it downloads anything: see Downloads.');
    if (form.dataset.form === 'decisions' && decisions) saveDecisions(decisionChoices(form));
  });
}
