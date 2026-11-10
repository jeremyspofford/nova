// Receipts, the egress viewer: how a list of receipts is drawn. One drawing for both the styleguide
// composition made for the owner's reaction (sg-receipts.js, made-up specimens) and the app's
// Receipts screen (receipts.js, the hub's real receipts), so the screen is exactly the composition.
// Pure: no reads, no state; links come from the caller (`href`), so the specimens keep their
// in-page anchors and the app gets real addresses.
//
// The model: src/core/receipts.ts and GET /api/v1/receipts. A receipt is {id, at, task_id,
// session_id, provider, model, purpose, privacy_mode, egress ('local' | 'remote:<name>'), opt_in
// (screening | box | capture | null), context_items [{kind, ref, sha256}]}. It holds where each piece
// came from and its hash, never the text; no size, tokens or cost; no device column. The route
// filters by egress (local | remote), task_id and session_id, newest first, 200 at most; filtering
// by destination or privacy setting is done here, over what was fetched.
//
// What writes a receipt, from the code: the conversation runner (src/runner.js: chat, scheduled
// runs, helpers), Nova's own models (src/core/models/index.ts, local and cloud), the worker registry
// for every task handed to a provider (src/core/providers/registry.ts) and the foundry
// (src/core/changes/foundry.ts), the Decision Service's remote screening (src/core/index.ts), and
// every call to a connected service that runs as its task (src/core/connectors/index.ts, F-031).
// Nothing else does: web_fetch and web_search (src/tools.js), browser tasks, what a service sends
// Nova on its own (mail arriving, a home's events), network and infra targets, repository fetches,
// provider checks, model downloads, mesh sync, and screening decided on the person's devices. T4
// (one egress enforcement point) isn't built, so the words never say that nothing else left. Its
// CSS is ui/styles/compositions.css (.rc-*) and ui/styles/receipts.css (one pane when narrow).
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dateWords = (day) => { const d = new Date(`${day}T12:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const dayBefore = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
const dayWords = (day, today) => (day === today ? `Today, ${dateWords(day)}` : day === dayBefore(today) ? `Yesterday, ${dateWords(day)}` : dateWords(day));
const clock = (at) => at.slice(11, 16);

// ---- the words: the model in plain language ------------------------------------------------------

export const MODES = { 'local-only': 'Local-only', 'local-preferred': 'Local first', 'cloud-allowed': 'Cloud allowed' };
const OPT_INS = { screening: 'Screening', box: 'Box', capture: 'Capture' };
const KINDS = { file: 'File or request', standing: 'Standing file', memory: 'Memory', skill: 'Skill', session: 'Conversation', outside: 'Outside content' };
const ROLES = { 'triage-text': 'Sorting what came in', reasoner: 'Reasoning', embedder: 'Indexing', transcriber: 'Transcribing' };

const remote = (r) => r.egress.startsWith('remote:');
const destination = (r) => (remote(r) ? r.egress.slice('remote:'.length) : null);
export const whereWords = (r) => (remote(r) ? `Sent to ${destination(r)}` : 'Stayed on your devices');
// Why, from the purpose the backend writes (runner, registry, foundry, Decision Service, a role,
// a connected service).
export function whyWords(r) {
  const p = r.purpose;
  if (p === 'chat') return 'A message in a conversation';
  if (p === 'scheduled run') return 'A scheduled run';
  if (p === 'helper') return 'A helper’s work';
  if (p.startsWith('task: ')) return `Task: ${p.slice('task: '.length)}`;
  if (p.startsWith('foundry: ')) return `A change to Nova (${p.slice('foundry: '.length)})`;
  if (p.startsWith('decision: ')) return `Screening outside content (${p.slice('decision: '.length).replace(/@\d+$/, '')})`;
  if (p.startsWith('service: ')) return `A call to ${p.slice('service: '.length)}`;
  return ROLES[p] ?? p;
}
const count = (n) => (n === 0 ? 'Told nothing by reference' : `${n} thing${n === 1 ? '' : 's'}, by reference`);
const metaWhy = (r) => [count(r.context_items.length), MODES[r.privacy_mode], ...(r.opt_in ? [`${OPT_INS[r.opt_in]} opt-in`] : [])].join(' · ');

// ---- links ---------------------------------------------------------------------------------------

// The specimens' in-page anchors; the app passes real addresses.
export const ANCHORS = {
  receipt: (id, r) => `#${id}-${r.id.slice(0, 8)}`,
  list: (id) => `#${id}-list`,
  coverage: (id) => `#${id}-coverage`,
  task: (id) => `#${id}-task`,
  conversation: (id) => `#${id}-conversation`,
};

// ---- the list ------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';

// A filter: { where: 'all' | 'left' | 'local' | <destination>, mode: 'all' | <privacy mode> }.
export const ALL = { where: 'all', mode: 'all' };
export function matches(r, f) {
  const w = f.where === 'all' || (f.where === 'left' ? remote(r) : f.where === 'local' ? !remote(r) : destination(r) === f.where);
  return w && (f.mode === 'all' || r.privacy_mode === f.mode);
}

function row(id, r, { current, shown, href }) {
  const on = r.id === current;
  return `<li class="rc-item" data-rc-egress="${esc(r.egress)}" data-rc-mode="${esc(r.privacy_mode)}"${shown ? '' : ' hidden'}><a class="uc-row rc-open${on ? ' is-on' : ''}" href="${esc(href.receipt(id, r))}"${on ? ' aria-current="true"' : ''}><span class="rc-text"><span class="rc-name">${esc(whyWords(r))}</span><span class="rc-meta${remote(r) ? ' rc-left' : ''}">${esc(whereWords(r))} · ${esc(r.model)}</span><span class="rc-meta">${esc(metaWhy(r))}</span></span><span class="rc-time">${clock(r.at)}</span></a></li>`;
}

function filters(id, list, f) {
  const dests = [...new Set(list.filter(remote).map(destination))].sort();
  const opt = (v, w, on) => `<option value="${esc(v)}"${v === on ? ' selected' : ''}>${esc(w)}</option>`;
  return `<div class="rc-filters" role="group" aria-labelledby="${id}-fh"><p class="rc-filters-head" id="${id}-fh">Show</p>
<div class="rc-field"><label class="rc-label" for="${id}-where">Where it went</label><select class="uc-input" id="${id}-where" data-rc-filter="where">${opt('all', 'Anywhere', f.where)}${opt('left', 'Left your devices', f.where)}${opt('local', 'Stayed on your devices', f.where)}${dests.map((d) => opt(d, `Sent to ${d}`, f.where)).join('')}</select></div>
<div class="rc-field"><label class="rc-label" for="${id}-mode">Privacy setting</label><select class="uc-input" id="${id}-mode" data-rc-filter="mode">${opt('all', 'Any setting', f.mode)}${Object.entries(MODES).map(([k, w]) => opt(k, w, f.mode)).join('')}</select></div></div>`;
}

export const shownWords = (n, total, f) => (f.where === 'all' && f.mode === 'all' ? `${total} receipt${total === 1 ? '' : 's'}, newest first.` : `${n} of ${total} shown.`);

// What an empty result says, by why it is empty.
export function noneWords(list, f, localOnly) {
  if (!list.length) return '';
  if (localOnly && f.where === 'left') return 'No receipt shows a call leaving your devices.';
  return 'No receipt matches these filters.';
}

export function listPane(id, { list, current = '', f = ALL, localOnly = false, today, href = ANCHORS }) {
  const days = [...new Set(list.map((r) => r.at.slice(0, 10)))];
  const n = list.filter((r) => matches(r, f)).length;
  const groups = days.map((day, i) => {
    const rs = list.filter((r) => r.at.startsWith(day));
    const any = rs.some((r) => matches(r, f));
    return `<section class="rc-day" data-rc-day${any ? '' : ' hidden'} aria-labelledby="${id}-d${i}"><h3 class="uc-group" id="${id}-d${i}">${dayWords(day, today)}</h3><ul class="rc-items">${rs.map((r) => row(id, r, { current, shown: matches(r, f), href })).join('')}</ul></section>`;
  }).join('');
  const none = noneWords(list, f, localOnly);
  return `<div class="rc-list" data-rc-list data-rc-total="${list.length}"${localOnly ? ' data-rc-local-only' : ''}><p class="rc-intro">Where each model call and service call went, why, and what it was told, by reference.</p>
${list.length ? filters(id, list, f) : ''}<p class="rc-count" data-rc-count role="status">${list.length ? shownWords(n, list.length, f) : 'None yet.'}</p>
<p class="rc-none" data-rc-none${n || !list.length ? ' hidden' : ''}>${esc(none)}</p>${localOnly ? '<p class="rc-intro">Nova is set to Local-only. Receipts record model calls and service calls only, not everything Nova sends.</p>' : ''}${groups}
<div class="rc-cover"><a class="uc-row" href="${esc(href.coverage(id))}"><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span><span class="uc-label">What receipts cover</span></a></div></div>`;
}

// ---- one receipt ---------------------------------------------------------------------------------

const back = (id, href) => `<a class="uc-row uc-back" href="${esc(href.list(id))}"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Receipts</span></a>`;
const fact = (k, v) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`;
const mono = (v) => `<span class="uc-mono">${esc(v)}</span>`;

// `tasks`: a task's title by id, where it is known.
export function detail(id, r, { tasks = {}, href = ANCHORS } = {}) {
  const link = r.task_id ? `<a class="btn" href="${esc(href.task(id, r))}" data-rc-task="${esc(r.task_id)}">Open the task</a>` : r.session_id ? `<a class="btn" href="${esc(href.conversation(id, r))}">Open the conversation</a>` : '';
  const tied = link ? `<div class="rc-actions">${link}</div>` : '<p class="rc-note">It isn’t tied to a task or a conversation.</p>';
  const when = `${dateWords(r.at.slice(0, 10))}, ${clock(r.at)} UTC`;
  const optIn = r.opt_in ? `${OPT_INS[r.opt_in]}, which you turned on` : 'None';
  const rows = [
    fact('When', esc(when)),
    fact('Where it went', `${esc(whereWords(r))} ${mono(`(${r.egress})`)}`),
    fact('Provider', mono(r.provider)),
    fact('Model', mono(r.model)),
    fact('Why, as recorded', mono(r.purpose)),
    fact('Privacy setting for this call', esc(MODES[r.privacy_mode] ?? r.privacy_mode)),
    fact('Opt-in', esc(optIn)),
    ...(r.task_id ? [fact('Task', `${esc(tasks[r.task_id] ?? '')} ${mono(r.task_id)}`)] : []),
    ...(r.session_id ? [fact('Conversation', mono(r.session_id))] : []),
    fact('Receipt', mono(r.id)),
  ];
  const items = r.context_items.length
    ? `<ul class="rc-told">${r.context_items.map((c) => `<li class="rc-told-item"><span class="rc-kind">${KINDS[c.kind] ?? esc(c.kind)}</span><span class="uc-mono">${esc(c.ref)}</span><span class="rc-hash">SHA-256 <span class="uc-mono">${esc(c.sha256.slice(0, 16))}…</span></span></li>`).join('')}</ul>`
    : '<p class="rc-note">Its receipt lists nothing it was told, by reference.</p>';
  return `${back(id, href)}<h3 class="uc-h" id="${id}-name">${esc(whyWords(r))}</h3><p class="rc-sentence${remote(r) ? ' rc-left' : ''}">${esc(whereWords(r))}.</p>${tied}
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
  'Each call Nova makes to a connected service, such as Home Assistant, on your network or off it.',
  'Outside content sent for screening, when you’ve turned screening on and your privacy isn’t Local-only.',
];
export const NOT_COVERED = [
  'What a worker does on its own once it has a task, such as its own web requests.',
  'Web pages and searches Nova fetches, and browser tasks.',
  'What a connected service sends Nova on its own, such as mail arriving or your home’s events.',
  'Your servers and network devices, and the code repositories Nova fetches.',
  'Checking a provider, and downloading a model.',
  'Sync between your own devices.',
  'Screening decided on your own devices, which is kept in the decision record.',
];

export function coverage(id, { href = ANCHORS } = {}) {
  return `${back(id, href)}<h3 class="uc-h" id="${id}-cov">What receipts cover</h3><p class="rc-sentence">Receipts record model calls and calls to connected services, not everything Nova sends.</p>
<h4 class="uc-group rc-head">A receipt is written for</h4><ul class="rc-cov">${COVERED.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<h4 class="uc-group rc-head">No receipt is written for</h4><ul class="rc-cov">${NOT_COVERED.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<p class="rc-note">Nova doesn’t yet have one place that checks everything it sends. Until it does, this list can’t show that nothing else left.</p>
<p class="rc-note">A call that Local-only refuses gets no receipt. It is shown in Health as a problem.</p>`;
}

// ---- empty states --------------------------------------------------------------------------------

export const emptyDetail = (id, { href = ANCHORS } = {}) => `<h3 class="uc-h" id="${id}-none">No receipts yet</h3><p class="rc-sentence">When a conversation, a task or one of Nova’s models calls a model, or Nova calls a connected service, its receipt is listed here: where the call went, why, and what it was told, by reference.</p>
<p class="rc-note">Receipts record model calls and service calls, not everything Nova sends.</p><div class="rc-actions"><a class="btn" href="${esc(href.coverage(id))}">What receipts cover</a></div>`;

export const localOnlyDetail = (id, { href = ANCHORS } = {}) => `<h3 class="uc-h" id="${id}-none">No receipt shows a call leaving your devices</h3><p class="rc-sentence">Nova is set to Local-only. Each receipt here says the call stayed on your devices.</p>
<p class="rc-note">A call that would have left is refused, gets no receipt, and is shown in Health as a problem. Screening by a cloud model is off in Local-only, even if you turned it on.</p>
<p class="rc-note">Receipts record model calls and service calls only. Web pages, searches and the rest under What receipts cover aren’t recorded here.</p><div class="rc-actions"><a class="btn" href="${esc(href.coverage(id))}">What receipts cover</a></div>`;

// ---- the panes -----------------------------------------------------------------------------------

// The list beside one right-hand pane, `pane` saying which shows when narrow (layout: one at a time).
export const panes = (pane, left, right) => `<div class="rc-panes" data-rc-pane="${pane}">${left}<div class="rc-detail">${right}</div></div>`;

// Re-applies a list's filters to its own rows: rows and days hide, the count says so.
export function refilter(scope) {
  const list = scope.querySelector('[data-rc-list]');
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
  return f;
}
