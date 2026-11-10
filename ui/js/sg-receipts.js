// Receipts, the egress viewer, design-first (2026-11-09): compositions for the owner's reaction.
// Styleguide only: nothing here is sent anywhere, and every receipt is made up. The filters filter
// these specimens in the page, nothing else. The drawing is receipts-draw.js, the same one the app's
// Receipts screen (receipts.js) uses with the hub's real receipts, so the two can't drift apart.
import { ICONS } from './components.js';
import { statusIcon } from './status-icon.js';
import { coverage, detail, emptyDetail, listPane, localOnlyDetail, matches, panes, refilter } from './receipts-draw.js';

export { COVERED, MODES, NOT_COVERED, matches, whereWords, whyWords } from './receipts-draw.js';

// Every frame: [state, what it shows]. RC_NARROW are also drawn at phone and Duo-cover sizes.
export const RC_FRAMES = [
  ['list', 'The list, grouped by day: where each call went, why, and how many things it was told; one opened beside it'],
  ['filtered', 'Filtered to what left your devices under Cloud allowed'],
  ['receipt', 'One receipt opened: every field Nova keeps, and its task'],
  ['screening', 'A screening receipt in Local first: the opt-in that allowed it'],
  ['coverage', 'What receipts cover, and what they don’t'],
  ['empty', 'No receipts yet'],
  ['empty-local', 'Local-only: no receipt shows a call leaving your devices'],
];
export const RC_NARROW = ['list', 'receipt', 'empty-local'];

// A fixed "now", so the words (and the screenshots) never drift: Monday 9 November 2026, 15:20 UTC.
const TODAY = '2026-11-09';

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
// A local-only Nova: every receipt says local (screening by a cloud model is off in local-only).
const LOCAL_ONLY = [
  { ...RECEIPTS[3], id: '0e7b3c19-4d2a-4f85-9b6c-8a1d5e2f7c09', privacy_mode: 'local-only' },
  { ...RECEIPTS[2], id: '3f9a6d02-7e4b-4c18-a5d9-2b8e1c6f4a10', privacy_mode: 'local-only' },
  { ...RECEIPTS[6], id: '5a2c8e41-9b3d-4e76-8f1a-7d0c4b9e2a11', privacy_mode: 'local-only' },
];
const TASKS = { 'k-201': 'Draft the release notes for the next alpha', 'k-198': 'Read the page the link pointed to', 'k-196': 'Check last week’s backups', 'k-190': 'Add the weather extension' };

// ---- frames --------------------------------------------------------------------------------------

const slot = (state, size) => `<span class="rc-icon" data-rc-icon="${state}" data-rc-size="${size}" aria-hidden="true"></span>`;

function screen(state, inner) {
  return `<div class="uc-screen rc" data-rc-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${ICONS.panel ?? ''}</button><h2 class="uc-title">Receipts</h2>${slot('idle', 24)}</header>
${inner}</div></div>`;
}
const list = (id, o = {}) => listPane(id, { list: RECEIPTS, today: TODAY, ...o });
const tasks = { tasks: TASKS };

export function rcFrame(state) {
  const id = `rc-${state}`;
  const first = RECEIPTS[0];
  if (state === 'filtered') {
    const f = { where: 'left', mode: 'cloud-allowed' };
    const r = RECEIPTS.find((x) => matches(x, f));
    return screen(state, panes('list', list(id, { current: r.id, f }), detail(id, r, tasks)));
  }
  if (state === 'receipt') return screen(state, panes('detail', list(id, { current: RECEIPTS[1].id }), detail(id, RECEIPTS[1], tasks)));
  if (state === 'screening') return screen(state, panes('detail', list(id, { current: RECEIPTS[4].id }), detail(id, RECEIPTS[4], tasks)));
  if (state === 'coverage') return screen(state, panes('detail', list(id), coverage(id)));
  if (state === 'empty') return screen(state, panes('detail', list(id, { list: [] }), emptyDetail(id)));
  if (state === 'empty-local') return screen(state, panes('list', list(id, { list: LOCAL_ONLY, f: { where: 'left', mode: 'all' }, localOnly: true }), localOnlyDetail(id)));
  return screen('list', panes('list', list('rc-list', { current: first.id }), detail('rc-list', first, tasks)));
}

// The styleguide entry: every frame, each with its full-screen address.
export function rcEntry(wrap) {
  return RC_FRAMES.map(([s, said]) => wrap(`${said} · <a class="link" href="?entry=receipts&amp;frame=${s}">Full screen</a>`, rcFrame(s))).join('');
}
export const isRcFrame = (s) => RC_FRAMES.some(([k]) => k === s);

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
