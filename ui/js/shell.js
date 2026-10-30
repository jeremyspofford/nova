// The shell around every view: the layout and posture on <body>, the navigation each layout
// shows (rail, tabs, More), the live orb, toasts and the sheet. The rules themselves are pure
// and tested (layout.js, nav.js, status.js); this module applies them to the page.
import { resolve } from './layout.js';
import { destination, placement } from './nav.js';
import { ICONS, orb } from './components.js';
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

const asideClosed = () => { try { return localStorage.getItem('nova.aside') === 'closed'; } catch { return false; } };

export function readLayout() {
  const cs = getComputedStyle(root);
  const word = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const room = word('--aside-room', 'no');
  const next = resolve({
    viewport: word('--viewport', 'narrow'),
    room,
    segments: word('--segments', 'none'),
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
  const toggle = $('aside-toggle');
  if (toggle) {
    const open = next.aside === 'on';
    toggle.innerHTML = ICONS.panel;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Hide the right column' : 'Show the right column');
    toggle.title = toggle.getAttribute('aria-label');
  }
  if (changed) {
    closeMore();
    renderNav();
    window.dispatchEvent(new CustomEvent('nova:layout', { detail: { ...layout } }));
  }
}

export function toggleAside() {
  try { localStorage.setItem('nova.aside', layout.aside === 'on' ? 'closed' : 'open'); } catch {}
  readLayout();
  window.dispatchEvent(new CustomEvent('nova:layout', { detail: { ...layout } }));
}

let frame = 0;
const relayout = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(readLayout); };
window.addEventListener('resize', relayout);
screen.orientation?.addEventListener?.('change', relayout);
navigator.devicePosture?.addEventListener?.('change', relayout);

// ---- navigation ------------------------------------------------------------------------------

let currentDest = 'home';
const badges = new Map(); // dest → { tone: 'attention' | 'alert' | 'working', label }

function navItem(id, { tag = 'li' } = {}) {
  const d = destination(id);
  const b = badges.get(id);
  const cur = id === currentDest ? ' aria-current="page"' : '';
  const aria = b ? ` aria-label="${esc(`${d.label}, ${b.label}`)}"` : '';
  const a = `<a class="nav-item" href="${d.path}" data-dest="${id}"${cur}${aria}>${ICONS[id]}<span class="nav-label">${esc(d.label)}</span>${b ? `<span class="nav-badge" data-tone="${esc(b.tone)}" aria-hidden="true"></span>` : ''}</a>`;
  return tag ? `<${tag}>${a}</${tag}>` : a;
}

function moreButton(more) {
  const b = more.map((id) => badges.get(id)).find(Boolean);
  const open = !$('more')?.hidden;
  return `<li><button type="button" class="nav-item" id="more-btn" aria-haspopup="dialog" aria-controls="more" aria-expanded="${open}"${more.includes(currentDest) ? ' data-current' : ''}>${ICONS.more}<span class="nav-label">More</span>${b ? `<span class="nav-badge" data-tone="${esc(b.tone)}" aria-hidden="true"></span>` : ''}</button></li>`;
}

export function renderNav() {
  if (!layout.layout) return;
  const focused = document.activeElement?.closest?.('[data-dest], #more-btn');
  const focusKey = focused ? focused.dataset.dest ?? 'more' : null;
  const p = placement(layout.layout);
  const rail = $('rail');
  const tabs = $('tabs');
  if (p.home === 'orb') {
    rail.innerHTML = `<a class="rail-home" href="/" data-dest="home" aria-label="Home. ${esc(ORB_WORDS[orbNow])}"${currentDest === 'home' ? ' aria-current="page"' : ''}>${orb({ state: orbNow, size: 'rail', live: true, decorative: true })}</a>
<ul class="rail-list">${p.primary.map((id) => navItem(id)).join('')}${moreButton(p.more)}</ul>
<ul class="rail-list rail-foot">${p.foot.map((id) => navItem(id)).join('')}</ul>`;
    tabs.innerHTML = '';
  } else {
    tabs.innerHTML = `<ul class="tabs-list">${p.primary.map((id) => navItem(id)).join('')}${moreButton(p.more)}</ul>`;
    rail.innerHTML = '';
  }
  $('more').innerHTML = `<ul class="more-list">${p.more.map((id) => navItem(id)).join('')}</ul>`;
  if (focusKey) (focusKey === 'more' ? $('more-btn') : document.querySelector(`#rail [data-dest="${focusKey}"], #tabs [data-dest="${focusKey}"], #more [data-dest="${focusKey}"]`))?.focus({ preventScroll: true });
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

// More: a sheet with the rest of the destinations.
export function openMore() {
  const more = $('more');
  more.hidden = false;
  $('more-btn')?.setAttribute('aria-expanded', 'true');
  more.querySelector('a')?.focus();
}
export function closeMore({ focus = false } = {}) {
  const more = $('more');
  if (!more || more.hidden) return;
  more.hidden = true;
  $('more-btn')?.setAttribute('aria-expanded', 'false');
  if (focus) $('more-btn')?.focus();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#more-btn')) { $('more').hidden ? openMore() : closeMore(); return; }
  if (!e.target.closest('#more')) closeMore();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('more').hidden) { e.preventDefault(); closeMore({ focus: true }); }
});

// ---- the live orb ------------------------------------------------------------------------------

const signals = { reachable: true, listening: false, problems: 0, needsYou: 0, speaking: false, working: 0 };
let orbNow = 'idle';
export const orbNowState = () => orbNow;

// Real signals in: the orb (every live one on the page) shows the most urgent.
export function signal(patch) {
  Object.assign(signals, patch);
  const next = orbState(signals);
  if (next === orbNow) return;
  orbNow = next;
  for (const el of document.querySelectorAll('.orb[data-live]')) {
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
  toastTimer = setTimeout(hideToast, ms ?? (action ? 8000 : tone === 'alert' ? 8000 : 3200));
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
