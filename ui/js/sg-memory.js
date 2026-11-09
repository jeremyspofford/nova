// Core memory, design-first (2026-11-09): search, confirm, correct and export, compositions for the
// owner's reaction before any wiring. Styleguide only: the app never loads this file, nothing here is
// sent anywhere, and every control is a specimen (the demo buttons say they are a demo).
//
// Drawn from the real model (src/core/memory.ts, GET/POST /api/v1/memory…; the Memory view's own
// /api/memory in src/server.js and src/memory.js; the memory gate in src/runner.js keep()/gated()).
// A memory is a record with a kind, its words, where it came from (a conversation and turn, a device's
// note, an import, or the person), when it was noted, who kept it (nova, person, import, a worker, a
// device), a confidence or none (under 0.5 is low), a scope, an optional end date, and a state:
// confirmed (the person's own, or confirmed by them), unreviewed (anything Nova kept on its own) or
// corrected. Nova reads every active memory either way; confirming only marks it right.
// Correcting never rewrites: a new record supersedes the old, which is kept, marked corrected, until
// the chain is forgotten. Search matches whole words (stop words skipped) in active memories only,
// up to 5 by default; it doesn't look at meaning, day notes, corrected wording or what is waiting.
// Export writes two plain files on the computer Nova runs on (memory.json, every field; memory.md,
// readable by kind) of the active memories only; there is no download. What waits for the person
// (memory_candidate) is either from a run that read outside content, or, only with the memory gate
// on (features.memory_gate, off by default, no switch in Settings), a conflict the gate flagged.
// Gaps are drawn as gaps (.au-locked), not as working controls.
// Its CSS is ui/styles/compositions.css (.mm-*, and the .au-* panes it shares with the Automations
// compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
const MM_FRAMES = [
  ['list', 'Memory at rest: what Nova holds now, by kind, with what is waiting and what isn’t reviewed yet', 'list'],
  ['search', 'Searching “calendar”: the two memories that share the word, one open with its history', 'list'],
  ['search-empty', 'Searching “dentist”: nothing Nova remembers has the word', 'list'],
  ['search-no-words', 'Searching a question: no word in it to match on (search skips words like what and you)', 'list'],
  ['memory', 'One memory and where it came from: not yet reviewed, from a conversation, low confidence', 'detail'],
  ['history', 'A corrected memory: what is true now, and the earlier wording kept beneath it', 'detail'],
  ['review', 'Not yet reviewed: what Nova kept on its own, to confirm or correct', 'detail'],
  ['waiting-gate-off', 'Waiting for your OK with the memory gate off (the default): only what Nova wanted to keep after reading something from outside', 'detail'],
  ['waiting-gate-on', 'Waiting for your OK with the memory gate on: a conflict the gate held, beside one from outside content', 'detail'],
  ['correct', 'Correcting a memory: your words replace it from now on; the old wording is kept, marked corrected', 'detail'],
  ['correct-empty', 'Correcting with nothing in the field: the Memory view’s own words', 'detail'],
  ['correct-conflict', 'Correcting a memory that was corrected meanwhile (another device): refused, in the core’s words', 'detail'],
  ['export', 'Exporting: two plain files on the computer Nova runs on, and what isn’t in them', 'detail'],
  ['export-done', 'Exported: where the files are, and what memory.md says; no download yet', 'detail'],
  ['export-failed', 'Export failed, in the core’s words', 'detail'],
  ['not-answering', 'Memory can’t be read: Nova’s server didn’t answer (the Memory view’s own words)', 'list'],
  ['empty', 'Nothing kept yet (the Memory view’s own words)', 'detail'],
];
const paneOf = (s) => MM_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';

// Conversations the memories came from (the view's titles).
const TITLES = { '2026-11-07-aaaaaa': 'Morning plan', '2026-11-02-bbbbbb': 'Planning the spring', '2026-11-05-cccccc': 'Family calendar' };
const DEVICE = 'device:6f1c2b9e-0d4a-4c3e-9a51-2b7d8e0f4c11';

// Memories as GET /api/v1/memory returns them (only what is drawn). Active, newest first.
const M = {
  coffee: { id: '3b0f6c1e-2a4d-4e8b-9c51-7d2e8a4f1b60', kind: 'preference', content: 'Takes coffee with oat milk.', source: '2026-11-07-aaaaaa/3', observed_at: '2026-11-07T08:14:00Z', recorded_by: 'nova', confidence: null, scope: 'personal', expires: null, user_state: 'unreviewed', supersedes: null },
  fridays: { id: '9e4a7c20-5b1d-4f3a-8e62-0c9b1d7a3e48', kind: 'fact', content: 'Works from home on Fridays and keeps the calendar free after 3.', source: null, observed_at: '2026-11-06T17:40:00Z', recorded_by: DEVICE, confidence: null, scope: 'personal', expires: null, user_state: 'unreviewed', supersedes: null },
  notes: { id: '5d2c8e14-7f0b-4a69-b3d1-6e8a0c2f9b37', kind: 'commitment', content: 'Nova drafts the release notes on Thursdays.', source: '2026-11-07-aaaaaa/5', observed_at: '2026-11-07T08:20:00Z', recorded_by: 'nova', confidence: 0.4, scope: 'work', expires: '2026-12-31T00:00:00Z', user_state: 'unreviewed', supersedes: null },
  family: { id: '8c1e4b7a-3d2f-4e90-a6b5-1f0d9c8e2a73', kind: 'decision', content: 'Use the shared calendar for family plans, not email.', source: 'correction', observed_at: '2026-11-07T19:02:00Z', recorded_by: 'person', confidence: null, scope: 'personal', expires: null, user_state: 'confirmed', supersedes: '1a7d3f90-6c2e-4b18-8d45-9e0b2c7f5a16' },
  spring: { id: '2f6b9d03-8a1c-4e57-b2f4-3c0e7a9d1b85', kind: 'fact', content: 'The spring project starts on the first Monday of March.', source: '2026-11-02-bbbbbb/1', observed_at: '2026-11-02T10:05:00Z', recorded_by: 'person', confidence: null, scope: 'work', expires: null, user_state: 'confirmed', supersedes: null },
  replies: { id: '4e9a1c6d-0b3f-4d82-9a7e-5c1b8f2d0e64', kind: 'preference', content: 'Short replies before 9 in the morning.', source: null, observed_at: '2026-10-30T07:51:00Z', recorded_by: 'person', confidence: null, scope: 'personal', expires: null, user_state: 'confirmed', supersedes: null },
  shop: { id: '7a3f0e58-1c9d-4b26-8f40-2d6e9b1a5c03', kind: 'entity', content: 'Corner Cycles, the bike shop that services the commuter bike.', source: '2026-11-02-bbbbbb/4', observed_at: '2026-11-02T10:31:00Z', recorded_by: 'nova', confidence: null, scope: 'personal', expires: null, user_state: 'confirmed', supersedes: null },
};
// The earlier wording of the family decision: kept, marked corrected, not active.
const FAMILY_OLD = { id: '1a7d3f90-6c2e-4b18-8d45-9e0b2c7f5a16', kind: 'decision', content: 'Use email for family plans.', source: '2026-11-05-cccccc/2', observed_at: '2026-11-05T12:30:00Z', recorded_by: 'nova', confidence: null, user_state: 'corrected' };
const ACTIVE = Object.values(M);
// counts(): active, unreviewed, low confidence.
const COUNTS = { active: ACTIVE.length, unreviewed: ACTIVE.filter((r) => r.user_state === 'unreviewed').length, low: ACTIVE.filter((r) => r.confidence != null && r.confidence < 0.5).length };

// What waits for the person (GET /api/memory candidates). The first is from a run that read outside
// content; the second is the memory gate's flag, with conflictReason()'s words.
const FROM_OUTSIDE = { id: 'c4f81a2e', op: 'remember', kind: 'preference', content: 'Prefers the window seat on trains.', source: '2026-11-08-dddddd/2', origins: ['rail.example.com'], reason: null };
const GATE_FLAG = { id: 'c9b06d13', op: 'remember', kind: 'preference', content: 'Takes coffee black.', source: '2026-11-09-eeeeee/1', origins: [], reason: 'It may conflict with what Nova remembers: “Takes coffee with oat milk.”.' };

// The kinds the Memory view shows, in its order (src/memory.js SHOWN), with view.js's notes.
const KINDS = [
  ['fact', 'Facts', 'Who you are and what is true about your life.'],
  ['preference', 'Preferences', 'How you like things done.'],
  ['decision', 'Decisions', 'What you settled, so it stays settled.'],
  ['commitment', 'Commitments', 'What you or Nova said would happen.'],
  ['entity', 'People, places and things', ''],
];
const KIND_WORD = { fact: 'Fact', preference: 'Preference', decision: 'Decision', commitment: 'Commitment', entity: 'Person, place or thing' };

// The words each failure says: the core's (src/core/memory.ts, src/core/api.ts) and the Memory view's
// (src/server.js, src/memory.js, ui/js/app.js).
const SAID = {
  empty: 'An entry needs some words. To remove it, forget it instead.',
  conflict: `That memory has already been corrected; correct the newer one (${M.family.id}) instead.`,
  inside: 'Something went wrong inside Nova. It has been recorded as a problem.',
  server: 'Nova’s server didn’t answer, so memory can’t be read right now.',
};
const EXPORT_DIR = '~/Nova/exports/memory-2026-11-09T14-02-11-000Z';

// ---- the words: the model in plain language ------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-mm-icon="${state}" data-mm-size="${size}" aria-hidden="true"></span>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const low = (r) => r.confidence != null && r.confidence < 0.5;

// Who kept it, in words.
function keptBy(r) {
  if (r.recorded_by === 'person') return 'You';
  if (r.recorded_by.startsWith('device:')) return 'One of your paired devices sent it as a note';
  if (r.recorded_by === 'import') return 'Imported';
  return 'Nova, on its own';
}

// Where it came from, as the row's meta says it.
function fromShort(r) {
  const sid = r.source && r.source !== 'correction' ? r.source.split('/')[0] : null;
  if (r.supersedes) return `corrected by you, ${day(r.observed_at)}`;
  if (sid && TITLES[sid]) return `from “${TITLES[sid]}”, ${day(r.observed_at)}`;
  if (r.recorded_by.startsWith('device:')) return `a note from one of your devices, ${day(r.observed_at)}`;
  return `written by you, ${day(r.observed_at)}`;
}

function stateWord(r) {
  if (r.user_state === 'unreviewed') return 'Not yet reviewed';
  if (r.user_state === 'corrected') return 'Corrected';
  return r.recorded_by === 'person' ? 'Yours' : 'Confirmed';
}

function rowMeta(r) {
  return [r.user_state === 'unreviewed' ? 'Not yet reviewed' : null, low(r) ? 'low confidence' : null, fromShort(r)].filter(Boolean).join(' · ');
}

// ---- the list pane: search, what to look at, and every memory by kind ----------------------------

function searchBox(id, q = '') {
  return `<div class="uc-search mm-search" role="search"><span class="uc-ic" aria-hidden="true">${icon('search')}</span><label class="sr-only" for="${id}-q">Search memory</label><input type="search" id="${id}-q" class="uc-bare" placeholder="Search memory" value="${esc(q)}" spellcheck="false">${q ? `<button type="button" class="uc-icon" aria-label="Clear search">${icon('close')}</button>` : ''}</div>`;
}

function memRow(id, r, current) {
  const on = current === r.id;
  return `<li class="mm-item"><a class="uc-row au-open${on ? ' is-on' : ''}" href="#${id}-${r.id.slice(0, 8)}"${on ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(r.content)}</span><span class="au-meta">${esc(rowMeta(r))}</span></span></a></li>`;
}

function toLook(id, { waiting = 0, current = '' } = {}) {
  const rows = [];
  if (waiting) rows.push(['waiting', `Waiting for your OK · ${waiting}`, 'Not in what Nova reads until you keep it']);
  rows.push(['review', `Not yet reviewed · ${COUNTS.unreviewed}`, 'Nova kept these on its own']);
  return `<h3 class="uc-group" id="${id}-look">To look at</h3><ul class="mm-list" aria-labelledby="${id}-look">${rows.map(([k, name, note]) => `<li class="mm-item"><a class="uc-row au-open${current === k ? ' is-on' : ''}" href="#${id}-${k}"${current === k ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(name)}</span><span class="au-meta">${esc(note)}</span></span></a></li>`).join('')}</ul>`;
}

function byKind(id, current) {
  return KINDS.map(([kind, title], i) => {
    const mine = ACTIVE.filter((r) => r.kind === kind);
    if (!mine.length) return '';
    return `<h3 class="uc-group" id="${id}-k${i}">${title}</h3><ul class="mm-list" aria-labelledby="${id}-k${i}">${mine.map((r) => memRow(id, r, current)).join('')}</ul>`;
  }).join('');
}

const exportRow = (id, on = false) => `<a class="uc-row au-new${on ? ' is-on' : ''}" href="#${id}-export"${on ? ' aria-current="true"' : ''}><span class="uc-ic" aria-hidden="true">${icon('copy')}</span><span class="uc-label">Export to files</span></a>`;

function listPane(id, { current = '', waiting = 1, exporting = false } = {}) {
  return `<div class="au-list">${searchBox(id)}<p class="au-intro">${COUNTS.active} memories Nova holds now.</p>${toLook(id, { waiting, current })}${byKind(id, current)}${exportRow(id, exporting)}</div>`;
}

const SEARCH_NOTE = 'Search matches whole words in what Nova holds now, up to 5. It doesn’t look at meaning, at earlier wording of a corrected memory, at day notes, or at what is waiting.';

function searchPane(id, q, hits, { current = '', why = '' } = {}) {
  const head = hits.length
    ? `<h3 class="uc-group" id="${id}-found">${hits.length} ${hits.length === 1 ? 'memory shares' : 'memories share'} a word with “${esc(q)}”</h3><ul class="mm-list" aria-labelledby="${id}-found">${hits.map((r) => memRow(id, r, current)).join('')}</ul>`
    : `<p class="au-sentence mm-none">${why}</p>`;
  return `<div class="au-list">${searchBox(id, q)}${head}<p class="au-note mm-pad">${SEARCH_NOTE}</p></div>`;
}

// ---- the detail pane --------------------------------------------------------------------------------

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Memory</span></a>`;

const convOf = (r) => { const sid = r.source && r.source !== 'correction' ? r.source.split('/')[0] : null; return sid && TITLES[sid] ? sid : null; };

function source(r) {
  const sid = convOf(r);
  if (sid) return `Nova kept it from the conversation “${esc(TITLES[sid])}”, at ${time(r.observed_at)} on ${day(r.observed_at)}.`;
  if (r.recorded_by.startsWith('device:')) return `A note one of your paired devices sent, ${day(r.observed_at)}. Nova didn’t write the words.`;
  if (r.supersedes) return `Your correction, ${day(r.observed_at)}.`;
  return `Written by you, ${day(r.observed_at)}.`;
}

function recordFacts(id, r) {
  const sid = convOf(r);
  const open = sid ? `<div class="au-actions mm-open"><a class="btn quiet" href="#${id}-c-${sid}">Open “${esc(TITLES[sid])}” at that turn</a></div>` : '';
  return facts([
    ['Where it came from', source(r)],
    ['Kept by', esc(keptBy(r))],
    ['Confidence', r.confidence == null ? 'None given' : `${low(r) ? 'Low' : 'Given'}, ${r.confidence}${low(r) ? '. Nova reads it marked low confidence.' : ''}`],
    ['Scope', esc(r.scope)],
    ['Until', r.expires ? `${day(r.expires)}. After that Nova no longer holds it as true.` : 'No end date'],
    ['Id', mono(r.id)],
  ]) + open;
}

function recordActions(id, r) {
  const confirm = r.user_state === 'unreviewed' ? '<button type="button" class="btn primary" data-mm-demo>Confirm it’s right</button>' : '';
  return `<div class="au-actions mm-acts">${confirm}<a class="btn${confirm ? '' : ' primary'}" href="#${id}-correct">Correct it</a><button type="button" class="btn quiet" data-mm-demo>Forget</button></div>`;
}

const READS = 'Nova reads it either way; confirming only marks it as right.';

function record(id, r) {
  const head = `${back(id)}<p class="mm-kind">${KIND_WORD[r.kind]} · ${stateWord(r)}</p><h3 class="uc-h mm-words" id="${id}-name">${esc(r.content)}</h3>`;
  const review = r.user_state === 'unreviewed' ? `<p class="au-note">Nova kept this on its own and you haven’t looked at it yet. ${READS}</p>` : '';
  return `${head}${review}${recordActions(id, r)}<h4 class="uc-group au-group-head" id="${id}-src">About it</h4>${recordFacts(id, r)}
<p class="au-note">Forgetting deletes it and every earlier wording, here, in backups and on the standby, leaving only a note that something was forgotten.</p>`;
}

function history(id) {
  const r = M.family;
  const head = `${back(id)}<p class="mm-kind">${KIND_WORD[r.kind]} · ${stateWord(r)}</p><h3 class="uc-h mm-words" id="${id}-name">${esc(r.content)}</h3>`;
  const chain = [
    [r.content, `Now · your correction, ${day(r.observed_at)}`],
    [FAMILY_OLD.content, `Corrected · Nova kept it from “${TITLES['2026-11-05-cccccc']}”, ${day(FAMILY_OLD.observed_at)}`],
  ];
  return `${head}${recordActions(id, r)}<h4 class="uc-group au-group-head" id="${id}-hist">Its history · oldest last</h4>
<ol class="mm-chain" aria-labelledby="${id}-hist">${chain.map(([words, meta], i) => `<li class="mm-step${i ? ' is-old' : ''}"><p class="au-block-head">${esc(words)}</p><p class="au-note">${esc(meta)}</p></li>`).join('')}</ol>
<p class="au-note">A correction never rewrites: the earlier wording stays, marked corrected, and Nova no longer reads it. Search doesn’t find it either.</p>
<h4 class="uc-group au-group-head" id="${id}-src">About it</h4>${recordFacts(id, r)}`;
}

function review(id) {
  const items = ACTIVE.filter((r) => r.user_state === 'unreviewed');
  return `${back(id)}<h3 class="uc-h" id="${id}-name">Not yet reviewed · ${items.length}</h3><p class="uc-lede">What Nova kept on its own. ${READS}</p>
<ul class="mm-cards" aria-labelledby="${id}-name">${items.map((r) => `<li class="mm-card"><p class="au-block-head">${esc(r.content)}</p><p class="au-note">${esc([KIND_WORD[r.kind], low(r) ? `low confidence, ${r.confidence}` : null, fromShort(r)].filter(Boolean).join(' · '))}</p>
<div class="au-actions"><button type="button" class="btn" data-mm-demo>Confirm</button><a class="btn quiet" href="#${id}-correct-${r.id.slice(0, 8)}">Correct</a></div></li>`).join('')}</ul>`;
}

function waitingCard(c) {
  const why = c.reason
    ? `Nova heard something that conflicts with what it remembers. ${esc(c.reason)}`
    : `A memory from a conversation that read ${esc(c.origins.join(', '))}.`;
  return `<li class="mm-card"><p class="au-block-head">${esc(c.content)}</p><p class="au-note">${why}</p>
<div class="au-actions"><button type="button" class="btn" data-mm-demo>Keep</button><button type="button" class="btn quiet" data-mm-demo>Drop</button></div></li>`;
}

function waiting(id, gate) {
  const list = gate ? [GATE_FLAG, FROM_OUTSIDE] : [FROM_OUTSIDE];
  const about = gate
    ? `<p class="au-note">The memory gate is on. Before Nova keeps something on its own, it checks it against your own words this turn and the memories nearest it: it may leave it out, find it is already kept, or hold it here because it conflicts. When the check can’t be relied on, Nova keeps it as before, not yet reviewed. Only a conflict shows here; what the gate left out or found already kept doesn’t.</p>`
    : `<p class="au-note">The memory gate is off, as it is by default. What Nova keeps on its own goes straight into memory, not yet reviewed. Only what it wanted to keep after reading something from outside waits here.</p>`;
  return `${back(id)}<h3 class="uc-h" id="${id}-name">Waiting for your OK · ${list.length}</h3><p class="uc-lede">Nova doesn’t see these until you keep them. Keeping one makes it yours, confirmed; dropping one deletes it.</p>
<ul class="mm-cards" aria-labelledby="${id}-name">${list.map(waitingCard).join('')}</ul>${about}
<p class="au-locked">The gate is turned on in Nova’s configuration (features.memory_gate). There is no switch for it in Settings yet.</p>`;
}

function correctForm(id, { value = 'Takes coffee with oat milk, no sugar.', error = '' } = {}) {
  const r = M.coffee;
  const field = `<div class="au-field"><label class="au-label" for="${id}-words">What’s true now</label><textarea class="uc-input au-area" id="${id}-words" rows="2"${error ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}>${esc(value)}</textarea>${error ? `<p class="au-error" id="${id}-err">${esc(error)}</p>` : ''}<p class="au-note">Was: “${esc(r.content)}”</p></div>`;
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="mm-kind">${KIND_WORD[r.kind]} · ${stateWord(r)}</p><h3 class="uc-h" id="${id}-title">Correct this memory</h3>
${field}
<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">What happens</h4><p class="au-sentence">Your words replace it from now on, as yours.</p><p class="au-note">The old wording is kept, marked corrected, in its history; Nova stops reading it. Forgetting the memory later removes both. To remove it now, forget it instead.</p></section>
<div class="au-actions"><button type="submit" class="btn primary" data-mm-demo>Save the correction</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function correctConflict(id) {
  return `${back(id)}<p class="mm-kind">Decision · Corrected</p><h3 class="uc-h" id="${id}-name">${esc(FAMILY_OLD.content)}</h3>
<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-c-h"><div class="au-result-text"><p class="au-block-head" id="${id}-c-h">Your correction wasn’t saved</p><p class="mm-quote">${esc(SAID.conflict)}</p><p class="au-note">It was corrected on another device while this one showed the older wording. Nothing changed.</p></div><div class="au-actions"><a class="btn primary" href="#${id}-${M.family.id.slice(0, 8)}">Open the newer one</a></div></div>
${facts([['Now', `“${esc(M.family.content)}”, your correction, ${day(M.family.observed_at)}`], ['What you wrote', '“Use the shared calendar for all plans.”']])}`;
}

const MD = [
  '# Memory',
  '',
  `Exported 2026-11-09T14:02:11.000Z. ${COUNTS.active} records.`,
  '',
  '## People, places and things',
  '',
  `- ${M.shop.content} (noted 2026-11-02 by nova; from 2026-11-02-bbbbbb/4)`,
  '',
  '## Facts',
  '',
  `- ${M.fridays.content} (not yet reviewed; noted 2026-11-06 by ${DEVICE})`,
  `- ${M.spring.content} (noted 2026-11-02 by person; from 2026-11-02-bbbbbb/1)`,
];

const LEAVES_OUT = 'Only what Nova holds now: not the earlier wording of corrected memories, not day notes, not what is waiting for your OK, and nothing past its end date.';

function exportPane(id) {
  return `${back(id)}<h3 class="uc-h" id="${id}-name">Export to files</h3><p class="uc-lede">Plain files you own, written on the computer Nova runs on.</p>
${facts([['memory.json', 'Every field of every memory'], ['memory.md', 'The same, readable, grouped by kind'], ['Where', `A new folder in ${mono('~/Nova/exports/')}, named for the time`], ['How many', `The ${COUNTS.active} memories Nova holds now`]])}
<p class="au-note">${LEAVES_OUT}</p><p class="au-note">The files aren’t encrypted: anyone who can read that folder can read them.</p>
<div class="au-actions"><button type="button" class="btn primary" data-mm-demo>Write the files</button><button type="button" class="btn quiet">Cancel</button></div>`;
}

function exportDone(id) {
  return `${back(id)}<h3 class="uc-h" id="${id}-name">Export to files</h3>
<div class="au-result" role="group" aria-labelledby="${id}-d-h"><div class="au-result-text"><p class="au-block-head" id="${id}-d-h">Wrote ${COUNTS.active} memories</p><p class="mm-quote">${mono(`${EXPORT_DIR}/`)}</p><p class="au-note">memory.json and memory.md, on the computer Nova runs on.</p></div><div class="au-actions"><button type="button" class="btn" data-mm-demo>Copy the folder path</button></div></div>
<p class="au-locked">No download yet: the files stay on that computer. From a phone you can’t open them here.</p>
<h4 class="uc-group au-group-head" id="${id}-md">The start of memory.md</h4><pre class="mm-file" aria-labelledby="${id}-md">${esc(MD.join('\n'))}</pre>
<p class="au-note">${LEAVES_OUT}</p>`;
}

function exportFailed(id) {
  return `${back(id)}<h3 class="uc-h" id="${id}-name">Export to files</h3>
<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-f-h"><div class="au-result-text"><p class="au-block-head" id="${id}-f-h">Nothing was exported</p><p class="mm-quote">${esc(SAID.inside)}</p><p class="au-note">If it stopped part way, the new folder may hold one of the two files. Your memories didn’t change.</p></div><div class="au-actions"><button type="button" class="btn" data-mm-demo>Try again</button><a class="btn quiet" href="#${id}-health">Open Health</a></div></div>`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, panes, live) {
  const id = `mm-${state}`;
  return `<div class="uc-screen mm" data-mm-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Memory</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;

// The detail pane at rest: what memory is, in the view's words, and its counts.
function rest(id) {
  return `<h3 class="uc-h" id="${id}-name">What Nova knows</h3><p class="uc-lede">Change anything, or forget it.</p>
${facts([['Holds now', `${COUNTS.active} memories`], ['Not yet reviewed', `${COUNTS.unreviewed}, kept by Nova on its own`], ['Low confidence', `${COUNTS.low}`], ['Waiting for your OK', '1, not in what Nova reads until you keep it']])}
<div class="au-actions"><a class="btn" href="#${id}-review">Review what’s new</a><a class="btn quiet" href="#${id}-export">Export to files</a></div>`;
}

function notAnswering(id) {
  return `<div class="au-list">${searchBox(id)}<div class="au-result mm-pad-block" data-tone="warn" role="group" aria-labelledby="${id}-na-h"><div class="au-result-text"><p class="au-block-head" id="${id}-na-h">Memory couldn’t be read.</p><p class="mm-quote">${esc(SAID.server)}</p></div><div class="au-actions"><button type="button" class="btn" data-mm-demo>Try again</button></div></div></div>
<div class="au-detail"><p class="au-note">Nothing to show until Nova answers.</p></div>`;
}

function empty(id) {
  return `<div class="au-list">${searchBox(id)}<p class="au-intro">Nothing kept yet.</p></div>
<div class="au-detail"><h3 class="uc-h" id="${id}-name">What Nova knows</h3><p class="au-sentence">Nothing kept yet.</p>
<p class="au-note">As you talk, Nova keeps what lasts here: facts about you, your preferences, decisions and commitments. You can change or forget any of it.</p>
<div class="au-actions"><a class="btn primary" href="#${id}-chat">Tell Nova something to remember</a></div></div>`;
}

export function mmFrame(state) {
  const calendar = [M.fridays, M.family];
  const L = (o) => (id) => listPane(id, o);
  if (state === 'search') return screen(state, pair((id) => searchPane(id, 'calendar', calendar, { current: M.family.id }), history), 'idle');
  if (state === 'search-empty') return screen(state, pair((id) => searchPane(id, 'dentist', [], { why: 'Nothing Nova remembers has the word “dentist”.' }), rest), 'idle');
  if (state === 'search-no-words') return screen(state, pair((id) => searchPane(id, 'what do you know about me', [], { why: '“what do you know about me” has no word to match on: search skips words like what, you and about. Try one that would be in the memory, like coffee.' }), rest), 'idle');
  if (state === 'memory') return screen(state, pair(L({ current: M.notes.id }), (id) => record(id, M.notes)), 'idle');
  if (state === 'history') return screen(state, pair(L({ current: M.family.id }), history), 'idle');
  if (state === 'review') return screen(state, pair(L({ current: 'review' }), review), 'idle');
  if (state === 'waiting-gate-off') return screen(state, pair(L({ current: 'waiting' }), (id) => waiting(id, false)), 'needs-you');
  if (state === 'waiting-gate-on') return screen(state, pair(L({ current: 'waiting', waiting: 2 }), (id) => waiting(id, true)), 'needs-you');
  if (state === 'correct') return screen(state, pair(L({ current: M.coffee.id }), (id) => correctForm(id)), 'idle');
  if (state === 'correct-empty') return screen(state, pair(L({ current: M.coffee.id }), (id) => correctForm(id, { value: '', error: SAID.empty })), 'idle');
  if (state === 'correct-conflict') return screen(state, pair(L({ current: M.family.id }), correctConflict), 'idle');
  if (state === 'export') return screen(state, pair(L({ exporting: true }), exportPane), 'idle');
  if (state === 'export-done') return screen(state, pair(L({ exporting: true }), exportDone), 'idle');
  if (state === 'export-failed') return screen(state, pair(L({ exporting: true }), exportFailed), 'idle');
  if (state === 'not-answering') return screen(state, notAnswering, 'offline');
  if (state === 'empty') return screen(state, empty, 'idle');
  return screen('list', pair(L({}), rest), 'idle');
}
// The styleguide entry: every frame, each with its full-screen address.
export function mmEntry(wrap) {
  return MM_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=memory-surface&amp;frame=${s}">Full screen</a>`, mmFrame(s))).join('');
}
export const isMmFrame = (s) => MM_FRAMES.some(([k]) => k === s);

// Fills the status icon slots, and the demo buttons say they are a demo.
export function bindMemory(root) {
  for (const el of root.querySelectorAll('[data-mm-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.mmIcon, size: Number(el.dataset.mmSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-mm-frame]')) {
    if (frame.dataset.mmBound) continue;
    frame.dataset.mmBound = '1';
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mm-demo]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
