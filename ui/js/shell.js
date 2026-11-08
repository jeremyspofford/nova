// The shell around every view: the layout and posture on <body>, the navigation each layout
// shows (rail, its drawer on a phone), the live orb, toasts and the sheet. The rules themselves are pure
// and tested (layout.js, nav.js, status.js); this module applies them to the page.
import { resolve, viewportOf } from './layout.js';
import { DESTINATIONS, destination, placement } from './nav.js';
import { ICONS, orb, versionStamp } from './components.js';
import { ORB_WORDS, orbState } from './status.js';
import { escapeHtml as esc } from './markdown.js';

const body = document.body;
const root = document.documentElement;
const $ = (id) => document.getElementById(id);

// ---- layout and posture ----------------------------------------------------------------------

// ?posture=folded | half-open-vertical | half-open-horizontal | continuous emulates a posture.
// It exists for tests (and for trying a foldable layout on a flat screen); it is read once.
const postureHook = new URLSearchParams(location.search).get('posture');
export const layout = { layout: null, posture: null, aside: null, room: null };

// A conversation is one reading column (Stage 2, approved 2026-11-04): there the glance column
// starts closed and opens only when the person opens it; elsewhere it starts open. Each is kept.
const chatView = () => document.body.dataset.view === 'chat';
const asideKey = () => (chatView() ? 'nova.aside.chat' : 'nova.aside');
const asideClosed = () => { try { const v = localStorage.getItem(asideKey()); return chatView() ? v !== 'open' : v === 'closed'; } catch { return chatView(); } };

// The bands' widths, as layout.css derives them from the regions' minimums in the applied design
// system (F8/F9): measured off three never-seen probes, so a design system swapped live, or a
// bigger text size, moves the bands with it (the probes resize, and the layout is read again).
const probes = (() => {
  const box = document.createElement('div');
  box.className = 'band-probes';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = '<div class="band-probe" data-band="two"></div><div class="band-probe" data-band="three"></div><div class="band-probe" data-band="scrollbar"></div><div class="band-probe" data-band="rail"></div>';
  document.body.append(box);
  const [two, three, scrollbar, rail] = box.children;
  return { two, three, scrollbar, rail };
})();
let scrollbarWidth = -1;
export function bands() {
  // What a scrollbar takes here (0 where scrollbars overlay the content), for the regions' gutters.
  const sb = probes.scrollbar.offsetWidth - probes.scrollbar.clientWidth;
  if (sb !== scrollbarWidth) { scrollbarWidth = sb; root.style.setProperty('--scrollbar-room', `${sb}px`); }
  return { two: probes.two.getBoundingClientRect().width, three: probes.three.getBoundingClientRect().width, rail: probes.rail.getBoundingClientRect().width };
}

export function readLayout() {
  const cs = getComputedStyle(root);
  const word = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const segments = word('--segments', 'none');
  const b = bands();
  const viewport = viewportOf(root.clientWidth, b);
  // Room for a pane beside the conversation: the three-column band, or a real hinge's own screens.
  const room = viewport === 'wide' || segments === 'horizontal' ? 'yes' : 'no';
  const next = resolve({
    viewport,
    room,
    segments,
    devicePosture: navigator.devicePosture?.type ?? 'continuous',
    orientation: screen.orientation?.type ?? 'portrait-primary',
    override: postureHook,
    closed: asideClosed(),
  });
  const changed = next.layout !== layout.layout;
  Object.assign(layout, next, { room });
  body.dataset.layout = next.layout;
  body.dataset.posture = next.posture;
  body.dataset.aside = next.aside;
  body.dataset.room = room;
  // The rail opens (icon, label and count in a row) where a desktop has room for it beside both
  // columns' minimums (layout.css --band-rail), and in a phone's drawer; elsewhere it stays slim.
  body.dataset.rail = next.layout === 'phone' || (next.layout === 'desktop' && root.clientWidth >= b.rail) ? 'open' : 'slim';
  const toggle = $('aside-toggle');
  if (toggle) {
    const open = next.aside === 'on';
    toggle.innerHTML = ICONS.panel;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Hide the right column' : 'Show the right column');
    toggle.title = toggle.getAttribute('aria-label');
  }
  if (changed) {
    closeNav();
    renderNav();
    window.dispatchEvent(new CustomEvent('nova:layout', { detail: { ...layout } }));
  }
}

export function toggleAside() {
  try { localStorage.setItem(asideKey(), layout.aside === 'on' ? 'closed' : 'open'); } catch {}
  readLayout();
  window.dispatchEvent(new CustomEvent('nova:layout', { detail: { ...layout } }));
}

let frame = 0;
const relayout = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(readLayout); };
window.addEventListener('resize', relayout);
new ResizeObserver(relayout).observe(probes.three);
new ResizeObserver(relayout).observe(probes.two);
screen.orientation?.addEventListener?.('change', relayout);
navigator.devicePosture?.addEventListener?.('change', relayout);

// ---- navigation ------------------------------------------------------------------------------

let currentDest = 'home';
const badges = new Map(); // dest → { tone: 'attention' | 'alert' | 'working', label }

function navItem(id, { tag = 'li' } = {}) {
  const d = destination(id);
  const b = badges.get(id);
  // One current page: in the drawer, a Recent row that is the open conversation takes it from Chat.
  const cur = id === currentDest && !(id === 'chat' && recentHasCurrent()) ? ' aria-current="page"' : '';
  const aria = b ? ` aria-label="${esc(`${d.label}, ${b.label}`)}"` : '';
  const a = `<a class="nav-item" href="${d.path}" data-dest="${id}"${cur}${aria}>${ICONS[id]}<span class="nav-label">${esc(d.label)}</span>${b?.count ? `<span class="nav-count" aria-hidden="true">${esc(String(b.count))}</span>` : ''}${b ? `<span class="nav-badge" data-tone="${esc(b.tone)}" aria-hidden="true"></span>` : ''}</a>`;
  return tag ? `<${tag}>${a}</${tag}>` : a;
}

export function renderNav() {
  if (!layout.layout) return;
  const focused = document.activeElement?.closest?.('[data-dest], #rail .rail-recent a, #nav-all');
  const focusKey = focused ? focused.dataset.dest ?? (focused.id === 'nav-all' ? 'all' : focused.getAttribute('href')) : null;
  const p = placement(layout.layout);
  // A phone's drawer: the same rail, Home a row (the orb is the top bar's), and a close button.
  const drawer = layout.layout === 'phone';
  const home = p.home === 'orb' ? `<a class="rail-home" href="/" data-dest="home" aria-label="Home. ${esc(ORB_WORDS[orbNow])}"${currentDest === 'home' ? ' aria-current="page"' : ''}>${orb({ state: orbNow, size: 'rail', live: true, decorative: true })}${ICONS.home}</a>` : '';
  $('rail').innerHTML = `<div class="rail-head">${home}
<button type="button" class="icon-btn rail-search" id="rail-search" aria-label="Search or go to" aria-haspopup="dialog" aria-keyshortcuts="Control+K" title="Search or go to (Ctrl K)">${ICONS.search}</button>${drawer ? `<button type="button" class="icon-btn rail-new" id="nav-new" aria-label="New conversation" title="New conversation (Ctrl Shift O)">${ICONS.plus}</button><button type="button" class="icon-btn" id="nav-close" aria-label="Close navigation">${ICONS.close}</button>` : ''}</div>
<div class="rail-scroll"><p class="rail-group" id="rail-places">Places</p>
<ul class="rail-list" aria-labelledby="rail-places">${p.primary.map((id) => navItem(id)).join('')}</ul>
${drawer && recent.list.length ? recentGroup() : ''}</div>
<div class="rail-foot"><ul class="rail-list">${p.foot.map((id) => navItem(id)).join('')}</ul>${stamp()}</div>`;
  // The menu button carries the most urgent place's dot, as the tabs did.
  const b = DESTINATIONS.map((d) => badges.get(d.id)).find(Boolean);
  $('nav-menu').innerHTML = `${ICONS.panel}${b ? `<span class="nav-badge" data-tone="${esc(b.tone)}" aria-hidden="true"></span>` : ''}`;
  $('nav-menu').setAttribute('aria-label', b ? `Open navigation, ${b.label}` : 'Open navigation');
  if (focusKey) {
    const back = focusKey === 'all' ? $('nav-all')
      : focusKey.startsWith('/c/') ? [...document.querySelectorAll('#rail .rail-recent a')].find((a) => a.getAttribute('href') === focusKey)
        : document.querySelector(`#rail [data-dest="${focusKey}"]`);
    // A Recent row that left the list hands focus to All conversations, not to the page.
    (back ?? (focusKey.startsWith('/c/') ? $('nav-all') : null))?.focus({ preventScroll: true });
  }
}

// The version stamp at the rail's foot, from GET /api/v1/version (components.js versionStamp): a
// link to About. On a phone the rail is the navigation drawer, so the stamp is at the drawer's foot.
let build = null;
export function setBuild(v) { build = v; renderNav(); }
const stamp = () => versionStamp(build);

// A phone's drawer lists the newest conversations under Places (owner decision 2026-11-08, option
// B), as the composition does, and a row to the whole list: the conversations drawer (app.js).
const RECENT = 4;
let recent = { list: [], current: null };
export function setRecent(list, current) {
  const next = { list: list.slice(0, RECENT).map(({ id, title }) => ({ id, title })), current };
  if (JSON.stringify(next) === JSON.stringify(recent)) return;
  recent = next;
  renderNav();
}
const recentHasCurrent = () => layout.layout === 'phone' && recent.list.some((s) => s.id === recent.current);
function recentGroup() {
  const rows = recent.list.map((s) => `<li><a class="nav-item" href="/c/${esc(s.id)}"${s.id === recent.current ? ' aria-current="page"' : ''}>${ICONS.chat}<span class="nav-label">${esc(s.title)}</span></a></li>`).join('');
  return `<p class="rail-group" id="rail-recent">Recent</p>
<ul class="rail-list rail-recent" aria-labelledby="rail-recent">${rows}<li><button type="button" class="nav-item" id="nav-all" aria-haspopup="dialog" aria-controls="sidebar">${ICONS.conversations}<span class="nav-label">All conversations</span></button></li></ul>`;
}

export function markCurrent(dest) {
  if (dest === currentDest) return;
  currentDest = dest;
  renderNav();
}

export function setBadge(dest, badge) {
  const before = JSON.stringify(badges.get(dest) ?? null);
  if (badge) badges.set(dest, badge); else badges.delete(dest);
  if (before !== JSON.stringify(badge ?? null)) renderNav();
}

// A phone's navigation drawer (owner decision 2026-11-08): the rail, opened by the title bar's menu
// button. A modal while open: the page behind is inert, Tab stays inside, and the scrim, Esc and the
// close button shut it and give focus back to the menu button. A place chosen closes it too.
const navOpen = () => $('app').classList.contains('nav-open');
export function openNav() {
  $('app').classList.add('nav-open');
  $('scrim').hidden = false;
  $('main').inert = $('aside').inert = true;
  $('nav-menu').setAttribute('aria-expanded', 'true');
  ($('rail').querySelector('[aria-current="page"]') ?? $('rail-search')).focus();
}
export function closeNav({ focus = false } = {}) {
  if (!navOpen()) return;
  $('app').classList.remove('nav-open');
  $('scrim').hidden = true;
  $('main').inert = $('aside').inert = false;
  $('nav-menu').setAttribute('aria-expanded', 'false');
  if (focus) $('nav-menu').focus();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#nav-menu')) openNav();
  // The search button's palette gives focus back to the menu button, so close (and focus) first.
  else if (navOpen() && e.target.closest('#nav-close, #scrim, #rail-search')) closeNav({ focus: true });
  // A place, a conversation, New and All conversations close it; app.js does the rest.
  else if (navOpen() && e.target.closest('#rail a, #nav-new, #nav-all')) closeNav();
});
document.addEventListener('keydown', (e) => {
  if (!navOpen() || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeNav({ focus: true }); return; }
  if (e.key !== 'Tab') return;
  const items = [...$('rail').querySelectorAll('a[href], button')];
  const edge = e.shiftKey ? items[0] : items.at(-1);
  if (document.activeElement === edge || !$('rail').contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? items.at(-1) : items[0]).focus(); }
});

// ---- the live orb ------------------------------------------------------------------------------

const signals = { reachable: true, listening: false, stopped: 0, needsYou: 0, speaking: false, working: 0 };
let orbNow = 'idle';

// Real signals in: the orb (every live one on the page) shows the most urgent.
export function signal(patch) {
  Object.assign(signals, patch);
  const next = orbState(signals);
  if (next === orbNow) return;
  orbNow = next;
  for (const el of document.querySelectorAll('.orb[data-orb-live]')) {
    el.dataset.state = next;
    if (el.getAttribute('role') === 'img') el.setAttribute('aria-label', ORB_WORDS[next]);
  }
  document.querySelector('.rail-home')?.setAttribute('aria-label', `Home. ${ORB_WORDS[next]}`);
  window.dispatchEvent(new CustomEvent('nova:orb', { detail: next }));
}
export const liveOrb = (size, opts = {}) => orb({ state: orbNow, size, live: true, ...opts });

// ---- toasts ------------------------------------------------------------------------------------

let toastTimer = 0;
let toastAction = null;
// One at a time. `action` is { label, run } (Undo, See Health); alerts stay longer.
export function toast(text, { action = null, tone = 'info', ms = null } = {}) {
  const el = $('toast');
  toastAction = action;
  el.dataset.tone = tone;
  el.setAttribute('role', tone === 'alert' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" class="toast-btn" data-action="${action.label === 'Undo' ? 'undo' : 'toast-action'}">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms ?? (action ? 8000 : tone === 'alert' ? 8000 : 3200)); // wait: expiry: the toast
}
export function hideToast() {
  $('toast').hidden = true;
  const a = toastAction;
  toastAction = null;
  a?.expire?.();
}
$('toast').addEventListener('click', (e) => {
  if (!e.target.closest('.toast-btn')) return;
  const a = toastAction;
  toastAction = null;
  $('toast').hidden = true;
  a?.run?.();
});
export const runToastAction = () => { const a = toastAction; if (!a) return false; toastAction = null; $('toast').hidden = true; a.run?.(); return true; };

// ---- the sheet: approvals, evidence ------------------------------------------------------------

let sheetClose = null;
let sheetReturn = null;
export function openSheet(html, { onClose = null, label = '' } = {}) {
  const dialog = $('sheet');
  sheetReturn = document.activeElement;
  sheetClose = onClose;
  $('sheet-body').innerHTML = `<button type="button" class="icon-btn sheet-close" data-action="close-sheet" aria-label="Close">${ICONS.close}</button>${html}`;
  if (label) dialog.setAttribute('aria-label', label); else dialog.removeAttribute('aria-label');
  if (!dialog.open) dialog.showModal();
  ($('sheet-body').querySelector('[autofocus], .btn.primary:not(:disabled), input, .btn') ?? $('sheet-body').querySelector('.sheet-close'))?.focus();
}
export function closeSheet() {
  const dialog = $('sheet');
  if (dialog.open) dialog.close();
}
export const sheetOpen = () => $('sheet').open;
$('sheet').addEventListener('close', () => {
  const fn = sheetClose;
  sheetClose = null;
  fn?.();
  if (sheetReturn?.isConnected) sheetReturn.focus({ preventScroll: true });
  sheetReturn = null;
});
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) closeSheet(); // the backdrop
  if (e.target.closest('[data-action="close-sheet"]')) closeSheet();
});
