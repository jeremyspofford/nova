// The command palette (Ctrl K, or Cmd K on a Mac), as the owner approved it (the UI rebuild
// compositions, 2026-11-06): a search field, then grouped results, each row an icon, a label and a
// hint on the right, and the keys in a footer. It finds real things only: the places Nova has
// (nav.js), your conversations, Settings' categories (settings-ia.js) and a few actions. Choosing
// one goes through the app's own router, never a page load.
//
// A modal <dialog>: the page behind it is inert, Tab stays inside, Esc closes it and focus goes back
// where it was. The field is a combobox over a listbox; the arrow keys move the selection
// (aria-activedescendant) while focus stays in the field.
import { DESTINATIONS } from './nav.js';
import { CATEGORIES, searchSettings } from './settings-ia.js';
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { layout } from './shell.js';
import { matchNorm } from './view.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';
const ARIA_MOD = MAC ? 'Meta' : 'Control';
const RECENT = 5;     // conversations shown before anything is typed
const FOUND = 8;      // conversations shown for a search

const opts = { navigate: () => {}, conversations: () => [], toggleAside: () => {} };
let dialog = null;
let input = null;
let list = null;
let empty = null;
let count = null;
let items = [];
let active = -1;
let returnTo = null;

const norm = matchNorm; // one match rule for the palette and Memory's filter (view.js)

// How well a query matches an item: 0 for not at all; a label that starts with it ranks first.
function score(q, item) {
  if (!q) return 1;
  const label = norm(item.label);
  if (label.startsWith(q)) return 3;
  const words = norm([item.label, ...(item.words ?? [])].join(' ')).split(' ');
  if (q.split(' ').every((w) => words.some((x) => x.startsWith(w)))) return 2;
  return label.includes(q) ? 1 : 0;
}

const day = (s) => {
  const d = new Date(s.updated ?? s.created ?? '');
  return Number.isNaN(d.getTime()) ? 'Conversation' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Every group, already filtered and ranked for the query.
function results(query) {
  const q = norm(query);
  const rank = (list, extra = () => 0) => list
    .map((item, i) => ({ item, i, s: Math.max(score(q, item), extra(item)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);

  const places = DESTINATIONS.map((d) => ({
    label: d.label, hint: d.parent ? 'Settings' : 'Go to', icon: ICONS[d.id] ?? ICONS.settings, path: d.path,
    words: d.id === 'chat' ? ['main conversation'] : d.id === 'automations' ? ['schedules'] : [],
  }));
  const conversations = (opts.conversations() ?? [])
    .filter((s) => s?.id && s.id !== 'main')
    .map((s) => ({ label: s.title || 'Untitled conversation', hint: day(s), icon: ICONS.chat, path: `/c/${encodeURIComponent(s.id)}` }));
  // A category is found by its own words, and by any setting in it that Settings' search finds.
  const viaSearch = new Set(q ? searchSettings(query).map((r) => r.cat) : []);
  const settings = CATEGORIES.map((c) => ({ id: c.id, label: c.label, hint: 'Settings', icon: ICONS.settings, path: `/settings#${c.id}`, words: [c.summary] }));
  const actions = [{ label: 'New conversation', icon: ICONS.plus, path: '/new', keys: [MOD, 'Shift', 'O'], aria: `${ARIA_MOD}+Shift+O`, words: ['new chat', 'start'] }];
  // The right column can be toggled only where the layout has one (as Ctrl \ can).
  if (layout.layout === 'desktop' && layout.room === 'yes') {
    actions.push({ label: layout.aside === 'on' ? 'Hide the right column' : 'Show the right column', icon: ICONS.panel, run: () => opts.toggleAside(), keys: [MOD, '\\'], aria: `${ARIA_MOD}+\\`, words: ['aside', 'glance', 'panel', 'sidebar', 'toggle'] });
  }

  return [
    { id: 'places', title: 'Go to', items: rank(places) },
    { id: 'conversations', title: 'Conversations', items: rank(conversations).slice(0, q ? FOUND : RECENT) },
    { id: 'settings', title: 'Settings', items: rank(settings, (c) => (viaSearch.has(c.id) ? 2 : 0)) },
    { id: 'actions', title: 'Actions', items: rank(actions) },
  ].filter((g) => g.items.length);
}

const kbd = (keys = []) => keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('');

function render() {
  const groups = results(input.value);
  items = groups.flatMap((g) => g.items);
  let n = 0;
  list.innerHTML = groups.map((g) => `<div class="palette-group" role="group" aria-labelledby="palette-g-${g.id}"><div class="palette-group-title" id="palette-g-${g.id}" aria-hidden="true">${esc(g.title)}</div>${g.items.map((it) => {
    const i = n++;
    // Its name is what it shows: "Tasks, Go to" (the comma only for a screen reader).
    return `<div class="palette-row" role="option" id="palette-opt-${i}" data-i="${i}" aria-selected="false"${it.aria ? ` aria-keyshortcuts="${esc(it.aria)}"` : ''}><span class="palette-ic" aria-hidden="true">${it.icon}</span><span class="palette-label">${esc(it.label)}</span>${it.hint ? `<span class="sr-only">, </span><span class="palette-hint">${esc(it.hint)}</span>` : ''}${it.keys ? `<span class="palette-keys" aria-hidden="true">${kbd(it.keys)}</span>` : ''}</div>`;
  }).join('')}</div>`).join('');
  const q = input.value.trim();
  list.hidden = !items.length;
  empty.hidden = !!items.length;
  empty.textContent = items.length ? '' : `Nothing matches “${q}”. Try a place, a conversation’s name, or a setting like “theme”.`;
  input.setAttribute('aria-expanded', String(items.length > 0));
  const said = !q ? '' : items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'No results';
  if (count.textContent !== said) count.textContent = said;
  select(items.length ? 0 : -1);
}

function select(i, { scroll = true } = {}) {
  const was = list.querySelector('.palette-row.is-on');
  if (was) { was.classList.remove('is-on'); was.setAttribute('aria-selected', 'false'); }
  active = i;
  const row = i >= 0 ? document.getElementById(`palette-opt-${i}`) : null;
  if (!row) { input.removeAttribute('aria-activedescendant'); return; }
  row.classList.add('is-on');
  row.setAttribute('aria-selected', 'true');
  input.setAttribute('aria-activedescendant', row.id);
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

function move(dir) {
  if (!items.length) return;
  select((active + dir + items.length) % items.length);
}

function choose(i) {
  const it = items[i];
  if (!it) return;
  // Going somewhere: the view that opens decides where focus goes. Otherwise it goes back.
  close({ restore: !it.path });
  if (it.path) opts.navigate(it.path);
  else it.run();
}

function close({ restore = true } = {}) {
  if (!dialog?.open) return;
  const back = returnTo;
  returnTo = null;
  dialog.close();
  if (restore && back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

export function openPalette() {
  if (!dialog || dialog.open) return;
  // Another modal (an approval, a sheet) keeps the screen until it is answered.
  if (document.querySelector('dialog[open]')) return;
  returnTo = document.activeElement;
  input.value = '';
  render();
  dialog.showModal();
  input.focus();
}

// `navigate`: the app's router. `conversations`: the conversation list, as the app holds it now.
// `toggleAside`: shows or hides the right column and redraws.
export function initPalette({ navigate, conversations, toggleAside } = {}) {
  Object.assign(opts, { navigate, conversations, toggleAside });
  if (dialog) return;
  dialog = document.createElement('dialog');
  dialog.className = 'palette';
  dialog.id = 'palette';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Search Nova');
  dialog.innerHTML = `<div class="palette-search"><span class="palette-ic" aria-hidden="true">${ICONS.search}</span><input id="palette-input" class="palette-input" type="text" role="combobox" aria-label="Search places, conversations, settings and actions" aria-autocomplete="list" aria-controls="palette-list" aria-expanded="false" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search or go to…"></div>
<div class="palette-list" id="palette-list" role="listbox" aria-label="Results"></div>
<p class="palette-empty" hidden></p>
<p class="sr-only" id="palette-count" role="status"></p>
<p class="palette-foot">${kbd(['↑'])}${kbd(['↓'])} move · ${kbd(['Enter'])} open · ${kbd(['Esc'])} close</p>`;
  document.body.append(dialog);
  input = dialog.querySelector('#palette-input');
  list = dialog.querySelector('#palette-list');
  empty = dialog.querySelector('.palette-empty');
  count = dialog.querySelector('#palette-count');

  input.addEventListener('input', render);
  // Every key stays with the palette: the app's own shortcuts don't act on the page behind it.
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' || (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); choose(active); return; }
    // The field is the palette's one stop: Tab and Shift Tab keep focus in it.
    if (e.key === 'Tab') { e.preventDefault(); input.focus(); }
  });
  // Esc the browser handles itself (and a phone's back gesture) closes it the same way.
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  // A press outside the box (on the backdrop, which belongs to the dialog) closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  // Rows are chosen with the pointer too; pressing one never takes focus from the field.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[role="option"]');
    if (row) choose(Number(row.dataset.i));
  });
  list.addEventListener('pointermove', (e) => {
    const row = e.target.closest('[role="option"]');
    if (row && Number(row.dataset.i) !== active) select(Number(row.dataset.i), { scroll: false });
  });
}
