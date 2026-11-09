// Receipts, the egress viewer, design-first (2026-11-09): compositions for the owner's reaction,
// before any wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere,
// and every receipt is made up. The filters filter these specimens in the page, nothing else.
//
// Drawn from the real model, src/core/receipts.ts and GET /api/v1/receipts: a receipt is {id, at,
// task_id, session_id, provider, model, purpose, privacy_mode, egress ('local' | 'remote:<name>'),
// opt_in (screening | box | capture | null), context_items [{kind, ref, sha256}]}. It holds where
// each piece came from and its hash, never the text; no size, tokens or cost; no device column.
// The route filters by egress (local | remote), task_id and session_id, newest first, 200 at most;
// filtering by destination or privacy setting is done here, over what was fetched.
//
// What writes a receipt, from the code: the conversation runner (src/runner.js: chat, scheduled
// runs, helpers), Nova's own models (src/core/models/index.ts, local and cloud), the worker registry
// for every task handed to a provider (src/core/providers/registry.ts) and the foundry
// (src/core/changes/foundry.ts), and the Decision Service's remote screening (src/core/index.ts).
// Nothing else does: web_fetch and web_search (src/tools.js), browser tasks, Gmail, Home Assistant,
// network and infra targets, repository fetches, provider checks, model downloads, mesh sync, and
// screening decided on the person's devices. T4 (one egress enforcement point) isn't built, so
// the words never say that nothing else left. Its CSS is ui/styles/compositions.css (.rc-*); the
// narrow layout is in ui/styles/layout.css.
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows]. RC_NARROW are also drawn at phone and Duo-cover sizes.
export const RC_FRAMES = [
  ['list', 'The list, grouped by day: where each call went, why, and how many things it was told; one opened beside it'],
  ['filtered', 'Filtered to what left your devices under Cloud allowed'],
  ['receipt', 'One receipt opened: every field Nova keeps, and its task'],
  ['screening', 'A screening receipt in Local first: the opt-in that allowed it'],
  ['coverage', 'What receipts cover, and what they don’t'],
  ['empty', 'No receipts yet'],
  ['empty-local', 'Local-only: no receipt shows a model call leaving your devices'],
];
export const RC_NARROW = ['list', 'receipt', 'empty-local'];

// A fixed "now", so the words (and the screenshots) never drift: Monday 9 November 2026, 15:20 UTC.
const TODAY = '2026-11-09';
const YESTERDAY = '2026-11-08';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateWords = (day) => { const d = new Date(`${day}T12:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const dayWords = (day) => (day === TODAY ? `Today, ${dateWords(day)}` : day === YESTERDAY ? `Yesterday, ${dateWords(day)}` : dateWords(day));
const clock = (at) => at.slice(11, 16);

// A made-up SHA-256 (64 hex characters), the same for the same seed. Not the hash of anything.
function fakeSha(seed) {
  let out = '';
  for (let chunk = 0; chunk < 8; chunk++) {
    let h = 2166136261;
    for (const ch of `${chunk}:${seed}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
const item = (kind, ref) => ({ kind, ref, sha256: fakeSha(`${kind}:${ref}`) });

// Receipts, as GET /api/v1/receipts returns them, newest first. Every name and id is made up.
const CHAT_ITEMS = [item('file', 'system prompt'), item('standing', '~/SOUL.md'), item('standing', '~/USER.md'), item('memory', 'm00000001'), item('memory', 'm00000004'), item('skill', 'release-notes'), item('session', '2026-11-09-aaaaaa')];
const RECEIPTS = [
  { id: '6f1c2a90-0b7e-4c1d-9a55-2e8f3d4c1a01', at: '2026-11-09T15:12:04.000Z', task_id: null, session_id: '2026-11-09-aaaaaa', provider: 'cloud:openrouter.ai', model: 'example/large-model', purpose: 'chat', privacy_mode: 'cloud-allowed', egress: 'remote:openrouter.ai', opt_in: null, context_items: CHAT_ITEMS },
  { id: '9b3e7d21-5c44-4f0a-8e19-7a6b2c9d3e02', at: '2026-11-09T14:40:31.000Z', task_id: 'k-201', session_id: null, provider: 'claude-code', model: 'example-coder', purpose: 'task: Draft the release notes for the next alpha', privacy_mode: 'cloud-allowed', egress: 'remote:anthropic', opt_in: null, context_items: [item('file', 'brief:k-201'), item('file', 'docs/changelog/next.md')] },
  { id: '2d8a4f63-9e10-4b7c-a3d2-5f1e8c7b6a03', at: '2026-11-09T11:05:12.000Z', task_id: null, session_id: null, provider: 'ollama', model: 'example-small:8b', purpose: 'triage-text', privacy_mode: 'cloud-allowed', egress: 'local', opt_in: null, context_items: [item('file', 'triage-text request')] },
  { id: 'c47e1b05-3a9d-4e62-b8f1-0d2c6a5e9b04', at: '2026-11-09T09:00:02.000Z', task_id: null, session_id: '2026-11-09-bbbbbb', provider: 'ollama@laptop', model: 'example-medium:14b', purpose: 'scheduled run', privacy_mode: 'cloud-allowed', egress: 'local', opt_in: null, context_items: [item('file', 'system prompt'), item('standing', '~/SOUL.md'), item('session', '2026-11-09-bbbbbb')] },
  { id: 'e5a92c17-6d3b-4a08-9f4e-1b7c3d8e2f05', at: '2026-11-08T21:30:44.000Z', task_id: 'k-198', session_id: null, provider: 'jev', model: 'example-screen-1', purpose: 'decision: ingest-screen@3', privacy_mode: 'local-preferred', egress: 'remote:typesafe', opt_in: 'screening', context_items: [item('outside', 'decision: ingest-screen@3')] },
  { id: '1a6d3e88-2f5c-4b91-a7e0-9c4b8d1f3a06', at: '2026-11-08T16:02:19.000Z', task_id: 'k-196', session_id: null, provider: 'relay', model: 'Relay worker (default)', purpose: 'task: Check last week’s backups', privacy_mode: 'local-preferred', egress: 'remote:anthropic', opt_in: null, context_items: [item('file', 'brief:k-196')] },
  { id: '7c2f9a44-8b1e-4d36-9e5a-3f0d7b2c8e07', at: '2026-11-08T10:15:57.000Z', task_id: null, session_id: '2026-11-08-cccccc', provider: 'ollama', model: 'example-medium:14b', purpose: 'chat', privacy_mode: 'local-preferred', egress: 'local', opt_in: null, context_items: [item('file', 'system prompt'), item('standing', '~/SOUL.md'), item('memory', 'm00000002'), item('session', '2026-11-08-cccccc')] },
  { id: 'b8e04d72-1c6a-4f93-8d2b-6e5a9c3f1d08', at: '2026-11-07T18:44:09.000Z', task_id: 'k-190', session_id: null, provider: 'codex', model: 'example-coder', purpose: 'foundry: extension', privacy_mode: 'cloud-allowed', egress: 'remote:openai', opt_in: null, context_items: [] },
];
// A local-only Nova: every receipt says local (the screening opt-in is off).
const LOCAL_ONLY = [
  { ...RECEIPTS[3], id: '0e7b3c19-4d2a-4f85-9b6c-8a1d5e2f7c09', privacy_mode: 'local-only' },
  { ...RECEIPTS[2], id: '3f9a6d02-7e4b-4c18-a5d9-2b8e1c6f4a10', privacy_mode: 'local-only' },
  { ...RECEIPTS[6], id: '5a2c8e41-9b3d-4e76-8f1a-7d0c4b9e2a11', privacy_mode: 'local-only' },
];
const TASKS = { 'k-201': 'Draft the release notes for the next alpha', 'k-198': 'Read the page the link pointed to', 'k-196': 'Check last week’s backups', 'k-190': 'Add the weather extension' };

// ---- the words: the model in plain language ------------------------------------------------------

export const MODES = { 'local-only': 'Local-only', 'local-preferred': 'Local first', 'cloud-allowed': 'Cloud allowed' };
const OPT_INS = { screening: 'Screening', box: 'Box', capture: 'Capture' };
const KINDS = { file: 'File or request', standing: 'Standing file', memory: 'Memory', skill: 'Skill', session: 'Conversation', outside: 'Outside content' };
const ROLES = { 'triage-text': 'Sorting what came in', reasoner: 'Reasoning', embedder: 'Indexing', transcriber: 'Transcribing' };

const remote = (r) => r.egress.startsWith('remote:');
const destination = (r) => (remote(r) ? r.egress.slice('remote:'.length) : null);
export const whereWords = (r) => (remote(r) ? `Sent to ${destination(r)}` : 'Stayed on your devices');
// Why, from the purpose the backend writes (runner, registry, foundry, Decision Service, a role).
export function whyWords(r) {
  const p = r.purpose;
  if (p === 'chat') return 'A message in a conversation';
  if (p === 'scheduled run') return 'A scheduled run';
  if (p === 'helper') return 'A helper’s work';
  if (p.startsWith('task: ')) return `Task: ${p.slice('task: '.length)}`;
  if (p.startsWith('foundry: ')) return `A change to Nova (${p.slice('foundry: '.length)})`;
  if (p.startsWith('decision: ')) return `Screening outside content (${p.slice('decision: '.length).replace(/@\d+$/, '')})`;
  return ROLES[p] ?? p;
}
const count = (n) => (n === 0 ? 'Told nothing by reference' : `${n} thing${n === 1 ? '' : 's'}, by reference`);
const metaWhy = (r) => [count(r.context_items.length), MODES[r.privacy_mode], ...(r.opt_in ? [`${OPT_INS[r.opt_in]} opt-in`] : [])].join(' · ');

// ---- the list ------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="rc-icon" data-rc-icon="${state}" data-rc-size="${size}" aria-hidden="true"></span>`;

// A filter: { where: 'all' | 'left' | 'local' | <destination>, mode: 'all' | <privacy mode> }.
const ALL = { where: 'all', mode: 'all' };
export function matches(r, f) {
  const w = f.where === 'all' || (f.where === 'left' ? remote(r) : f.where === 'local' ? !remote(r) : destination(r) === f.where);
  return w && (f.mode === 'all' || r.privacy_mode === f.mode);
}

function row(id, r, { current, shown }) {
  const on = r.id === current;
  return `<li class="rc-item" data-rc-egress="${esc(r.egress)}" data-rc-mode="${r.privacy_mode}"${shown ? '' : ' hidden'}><a class="uc-row rc-open${on ? ' is-on' : ''}" href="#${id}-${r.id.slice(0, 8)}"${on ? ' aria-current="true"' : ''}><span class="rc-text"><span class="rc-name">${esc(whyWords(r))}</span><span class="rc-meta${remote(r) ? ' rc-left' : ''}">${esc(whereWords(r))} · ${esc(r.model)}</span><span class="rc-meta">${esc(metaWhy(r))}</span></span><span class="rc-time">${clock(r.at)}</span></a></li>`;
}

function filters(id, list, f) {
  const dests = [...new Set(list.filter(remote).map(destination))].sort();
  const opt = (v, w, on) => `<option value="${esc(v)}"${v === on ? ' selected' : ''}>${esc(w)}</option>`;
  return `<div class="rc-filters" role="group" aria-labelledby="${id}-fh"><p class="rc-filters-head" id="${id}-fh">Show</p>
<div class="rc-field"><label class="rc-label" for="${id}-where">Where it went</label><select class="uc-input" id="${id}-where" data-rc-filter="where">${opt('all', 'Anywhere', f.where)}${opt('left', 'Left your devices', f.where)}${opt('local', 'Stayed on your devices', f.where)}${dests.map((d) => opt(d, `Sent to ${d}`, f.where)).join('')}</select></div>
<div class="rc-field"><label class="rc-label" for="${id}-mode">Privacy setting</label><select class="uc-input" id="${id}-mode" data-rc-filter="mode">${opt('all', 'Any setting', f.mode)}${Object.entries(MODES).map(([k, w]) => opt(k, w, f.mode)).join('')}</select></div></div>`;
}

const shownWords = (n, total, f) => (f.where === 'all' && f.mode === 'all' ? `${total} receipt${total === 1 ? '' : 's'}, newest first.` : `${n} of ${total} shown.`);

// What an empty result says, by why it is empty.
function noneWords(list, f, localOnly) {
  if (!list.length) return '';
  if (localOnly && f.where === 'left') return 'No receipt shows a model call leaving your devices.';
  return 'No receipt matches these filters.';
}

function listPane(id, { list = RECEIPTS, current = '', f = ALL, localOnly = false } = {}) {
  const days = [...new Set(list.map((r) => r.at.slice(0, 10)))];
  const n = list.filter((r) => matches(r, f)).length;
  const groups = days.map((day, i) => {
    const rs = list.filter((r) => r.at.startsWith(day));
    const any = rs.some((r) => matches(r, f));
    return `<section class="rc-day" data-rc-day${any ? '' : ' hidden'} aria-labelledby="${id}-d${i}"><h3 class="uc-group" id="${id}-d${i}">${dayWords(day)}</h3><ul class="rc-items">${rs.map((r) => row(id, r, { current, shown: matches(r, f) })).join('')}</ul></section>`;
  }).join('');
  const none = noneWords(list, f, localOnly);
  return `<div class="rc-list" data-rc-list data-rc-total="${list.length}"${localOnly ? ' data-rc-local-only' : ''}><p class="rc-intro">Where each model call went, why, and what it was told, by reference.</p>
${list.length ? filters(id, list, f) : ''}<p class="rc-count" data-rc-count role="status">${list.length ? shownWords(n, list.length, f) : 'None yet.'}</p>
<p class="rc-none" data-rc-none${n || !list.length ? ' hidden' : ''}>${esc(none)}</p>${localOnly ? '<p class="rc-intro">Nova is set to Local-only. Receipts record model calls only, not everything Nova sends.</p>' : ''}${groups}
<div class="rc-cover"><a class="uc-row" href="#${id}-coverage"><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span><span class="uc-label">What receipts cover</span></a></div></div>`;
}

// ---- one receipt ---------------------------------------------------------------------------------

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Receipts</span></a>`;
const fact = (k, v) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`;
const mono = (v) => `<span class="uc-mono">${esc(v)}</span>`;

function detail(id, r) {
  const link = r.task_id ? `<a class="btn" href="#${id}-task">Open the task</a>` : r.session_id ? `<a class="btn" href="#${id}-conversation">Open the conversation</a>` : '';
  const tied = link ? `<div class="rc-actions">${link}</div>` : '<p class="rc-note">It isn’t tied to a task or a conversation.</p>';
  const when = `${dateWords(r.at.slice(0, 10))}, ${clock(r.at)} UTC`;
  const optIn = r.opt_in ? `${OPT_INS[r.opt_in]}, which you turned on` : 'None';
  const rows = [
    fact('When', esc(when)),
    fact('Where it went', `${esc(whereWords(r))} ${mono(`(${r.egress})`)}`),
    fact('Provider', mono(r.provider)),
    fact('Model', mono(r.model)),
    fact('Why, as recorded', mono(r.purpose)),
    fact('Privacy setting for this call', esc(MODES[r.privacy_mode])),
    fact('Opt-in', esc(optIn)),
    ...(r.task_id ? [fact('Task', `${esc(TASKS[r.task_id] ?? '')} ${mono(r.task_id)}`)] : []),
    ...(r.session_id ? [fact('Conversation', mono(r.session_id))] : []),
    fact('Receipt', mono(r.id)),
  ];
  const items = r.context_items.length
    ? `<ul class="rc-told">${r.context_items.map((c) => `<li class="rc-told-item"><span class="rc-kind">${KINDS[c.kind]}</span><span class="uc-mono">${esc(c.ref)}</span><span class="rc-hash">SHA-256 <span class="uc-mono">${c.sha256.slice(0, 16)}…</span></span></li>`).join('')}</ul>`
    : '<p class="rc-note">Its receipt lists nothing it was told, by reference.</p>';
  return `${back(id)}<h3 class="uc-h" id="${id}-name">${esc(whyWords(r))}</h3><p class="rc-sentence${remote(r) ? ' rc-left' : ''}">${esc(whereWords(r))}.</p>${tied}
<dl class="uc-facts rc-facts" aria-labelledby="${id}-name">${rows.join('')}</dl>
<h4 class="uc-group rc-head">What it was told, by reference</h4>${items}
<p class="rc-note">A receipt keeps where each piece came from and a fingerprint of it. It has no field for the text itself.</p>
<h4 class="uc-group rc-head">Not in a receipt</h4>
<p class="rc-note">The words that were sent and the reply, how much was sent in tokens or bytes, what it cost, and which of your devices made the call.</p>`;
}

// ---- coverage: from the code, exactly -------------------------------------------------------------

export const COVERED = [
  'Each model call in a conversation, a scheduled run or a helper.',
  'Each call to Nova’s own models, on your devices or in the cloud.',
  'Each task handed to a worker: Claude Code, Codex, Relay, an OpenAI-compatible service, n8n or a command you added. Changes Nova makes to itself are among them.',
  'Outside content sent for screening, when you’ve turned screening on.',
];
export const NOT_COVERED = [
  'What a worker does on its own once it has a task, such as its own web requests.',
  'Web pages and searches Nova fetches, and browser tasks.',
  'Gmail and Home Assistant.',
  'Your servers and network devices, and the code repositories Nova fetches.',
  'Checking a provider, and downloading a model.',
  'Sync between your own devices.',
  'Screening decided on your own devices, which is kept in the decision record.',
];

function coverage(id) {
  return `${back(id)}<h3 class="uc-h" id="${id}-cov">What receipts cover</h3><p class="rc-sentence">Receipts record model calls, not everything Nova sends.</p>
<h4 class="uc-group rc-head">A receipt is written for</h4><ul class="rc-cov">${COVERED.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<h4 class="uc-group rc-head">No receipt is written for</h4><ul class="rc-cov">${NOT_COVERED.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<p class="rc-note">Nova doesn’t yet have one place that checks everything it sends. Until it does, this list can’t show that nothing else left.</p>
<p class="rc-note">A model call that Local-only refuses gets no receipt. It is shown in Health as a problem.</p>`;
}

// ---- empty states --------------------------------------------------------------------------------

const emptyDetail = (id) => `<h3 class="uc-h" id="${id}-none">No receipts yet</h3><p class="rc-sentence">When a conversation, a task or one of Nova’s models calls a model, its receipt is listed here: where the call went, why, and what it was told, by reference.</p>
<p class="rc-note">Receipts record model calls, not everything Nova sends.</p><div class="rc-actions"><a class="btn" href="#${id}-coverage">What receipts cover</a></div>`;

const localOnlyDetail = (id) => `<h3 class="uc-h" id="${id}-none">No receipt shows a model call leaving your devices</h3><p class="rc-sentence">Nova is set to Local-only. Each receipt here says the call stayed on your devices.</p>
<p class="rc-note">A model call that would have left is refused, gets no receipt, and is shown in Health as a problem. If you turn screening on, outside content can be sent for screening even in Local-only, and each time is listed here.</p>
<p class="rc-note">Receipts record model calls only. Web pages, searches, connections and the rest under What receipts cover aren’t recorded here.</p><div class="rc-actions"><a class="btn" href="#${id}-coverage">What receipts cover</a></div>`;

// ---- frames --------------------------------------------------------------------------------------

function screen(state, panes, pane) {
  const id = `rc-${state}`;
  return `<div class="uc-screen rc" data-rc-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Receipts</h2>${slot('idle', 24)}</header>
<div class="rc-panes" data-rc-pane="${pane}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="rc-detail">${right(id)}</div>`;

export function rcFrame(state) {
  const first = RECEIPTS[0];
  if (state === 'filtered') {
    const f = { where: 'left', mode: 'cloud-allowed' };
    const r = RECEIPTS.find((x) => matches(x, f));
    return screen(state, pair((id) => listPane(id, { current: r.id, f }), (id) => detail(id, r)), 'list');
  }
  if (state === 'receipt') return screen(state, pair((id) => listPane(id, { current: RECEIPTS[1].id }), (id) => detail(id, RECEIPTS[1])), 'detail');
  if (state === 'screening') return screen(state, pair((id) => listPane(id, { current: RECEIPTS[4].id }), (id) => detail(id, RECEIPTS[4])), 'detail');
  if (state === 'coverage') return screen(state, pair((id) => listPane(id), coverage), 'detail');
  if (state === 'empty') return screen(state, pair((id) => listPane(id, { list: [] }), emptyDetail), 'detail');
  if (state === 'empty-local') return screen(state, pair((id) => listPane(id, { list: LOCAL_ONLY, f: { where: 'left', mode: 'all' }, localOnly: true }), localOnlyDetail), 'list');
  return screen('list', pair((id) => listPane(id, { current: first.id }), (id) => detail(id, first)), 'list');
}

// The styleguide entry: every frame, each with its full-screen address.
export function rcEntry(wrap) {
  return RC_FRAMES.map(([s, said]) => wrap(`${said} · <a class="link" href="?entry=receipts&amp;frame=${s}">Full screen</a>`, rcFrame(s))).join('');
}
export const isRcFrame = (s) => RC_FRAMES.some(([k]) => k === s);

// Re-applies a frame's filters to its own specimen rows: rows and days hide, the count says so.
function refilter(frame) {
  const list = frame.querySelector('[data-rc-list]');
  if (!list) return;
  const f = { where: list.querySelector('[data-rc-filter="where"]')?.value ?? 'all', mode: list.querySelector('[data-rc-filter="mode"]')?.value ?? 'all' };
  let n = 0;
  for (const li of list.querySelectorAll('.rc-item')) {
    const r = { egress: li.dataset.rcEgress, privacy_mode: li.dataset.rcMode };
    const on = matches(r, f);
    li.hidden = !on;
    if (on) n++;
  }
  for (const day of list.querySelectorAll('[data-rc-day]')) day.hidden = !day.querySelector('.rc-item:not([hidden])');
  const total = Number(list.dataset.rcTotal);
  list.querySelector('[data-rc-count]').textContent = shownWords(n, total, f);
  const none = list.querySelector('[data-rc-none]');
  none.hidden = n > 0;
  none.textContent = noneWords({ length: total }, f, list.hasAttribute('data-rc-local-only'));
}

// Fills the status icon slots and makes the filters filter the specimens in the page.
export function bindReceipts(root) {
  for (const el of root.querySelectorAll('[data-rc-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.rcIcon, size: Number(el.dataset.rcSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-rc-frame]')) {
    if (frame.dataset.rcBound) continue;
    frame.dataset.rcBound = '1';
    frame.addEventListener('change', (e) => { if (e.target.closest('[data-rc-filter]')) refilter(frame); });
    frame.addEventListener('click', (e) => { if (e.target.closest('a[href^="#"]')) e.preventDefault(); });
  }
}
