// The takeover view (M5 plan §3): a browser task's live picture in the sheet, and the person's
// hands on it. The picture and the state come over the task's own frame stream
// (/api/v1/browser/tasks/{id}/frames), which the service worker never caches. Take over and Hand
// back are the one standout action; while this device holds the browser, its pointer, wheel and
// keys go to the page, and on a phone the Type field does what a keyboard would.
import { V1, api } from './core.js';
import { status, takeoverActions, takeoverPanel, takeoverRefused, takeoverState } from './components.js';
import { openSheet, toast } from './shell.js';

// Keys that aren't text, as the server takes them (src/core/browser/session.ts).
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

let live = null; // { id, task, view, me, canTake, es, queue, onEnd, wheel }

const $ = (sel) => document.querySelector(`#sheet .takeover ${sel}`);
const path = (id, rest = '') => `/browser/tasks/${encodeURIComponent(id)}${rest}`;

export function openTakeover(task, view, { me = 'console', canTake = true, onEnd = null } = {}) {
  stop();
  live = { id: task.id, task, view, me, canTake, es: null, queue: Promise.resolve(), onEnd, wheel: null };
  openSheet(takeoverPanel(task, view, { me, canTake }), { label: task.title, onClose: stop });
  document.getElementById('sheet').dataset.kind = 'takeover';
  const es = new EventSource(`${V1}${path(task.id, '/frames')}`);
  live.es = es;
  const mine = live;
  es.addEventListener('frame', (e) => {
    if (live !== mine) return;
    let f;
    try { f = JSON.parse(e.data); } catch { return; }
    const img = $('.takeover-frame');
    if (!img) return;
    const first = !img.dataset.seq;
    img.src = `data:image/jpeg;base64,${f.jpeg}`;
    img.dataset.seq = String(f.seq);
    // On a phone the page is wider than the screen: start with its middle in view, where pages
    // put their content.
    if (first) img.decode().then(() => { const s = $('.takeover-screen'); if (s && s.scrollWidth > s.clientWidth) s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2; }).catch(() => {});
    img.hidden = false;
    const wait = $('.takeover-wait');
    if (wait) wait.hidden = true;
  });
  es.addEventListener('state', (e) => {
    if (live !== mine) return;
    try { mine.view = JSON.parse(e.data); } catch { return; }
    render();
    if (!mine.view.live) ended(mine);
  });
  // A stream that won't come back (the browser closed before it opened, a session ended).
  es.addEventListener('error', () => { if (live === mine && es.readyState === EventSource.CLOSED) ended(mine); });
}

function ended(mine) {
  mine.es?.close();
  if (mine.done) return;
  mine.done = true;
  // The task goes on to its evidence; the sheet follows it there.
  setTimeout(() => { if (live !== mine) return; stop(); mine.onEnd?.(); }, 600);
}

function stop() {
  live?.es?.close();
  live = null;
  const sheet = document.getElementById('sheet');
  if (sheet) delete sheet.dataset.kind;
}

// Only the parts that change: the picture stays where it is.
function render() {
  if (!live || !$('.takeover-line')) return;
  const st = takeoverState(live.view, live);
  $('.takeover-status').innerHTML = status(st.status);
  $('.takeover-line').textContent = st.line;
  $('.takeover-screen').dataset.held = String(st.mine);
  $('.takeover-type').hidden = !st.mine;
  $('.takeover-refused').innerHTML = takeoverRefused(live.view);
  document.querySelector('#sheet .takeover').dataset.mode = live.view.mode ?? 'closed';
  const actions = $('.takeover-actions');
  const focused = actions.contains(document.activeElement);
  actions.innerHTML = takeoverActions(st, live);
  if (focused) actions.querySelector('.btn.primary, .btn')?.focus({ preventScroll: true });
}

// One at a time and in order: keys typed fast must arrive as typed.
function send(body) {
  if (!live) return;
  const id = live.id;
  live.queue = live.queue.then(() => api('POST', path(id, '/input'), body)).catch((e) => toast(e.message));
}

const holding = () => !!live && takeoverState(live.view, live).mine;

async function takeOver() {
  if (!live) return;
  try {
    live.view = await api('POST', path(live.id, '/takeover'));
    render();
    $('.takeover-frame')?.focus({ preventScroll: true });
    toast('You have control. Nova waits until you hand back.');
  } catch (e) { toast(e.message); }
}

async function handBack() {
  if (!live) return;
  try {
    await live.queue;
    live.view = await api('POST', path(live.id, '/handback'));
    render();
    toast('Handed back. Nova carries on from here.');
  } catch (e) { toast(e.message); }
}

// Where on the page the pointer is, as fractions of the picture.
function at(e, img) {
  const r = img.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

document.addEventListener('click', (e) => {
  if (!live || !e.target.closest?.('#sheet .takeover')) return;
  const b = e.target.closest('[data-action]');
  if (b?.dataset.action === 'take-over') { e.preventDefault(); takeOver(); return; }
  if (b?.dataset.action === 'hand-back') { e.preventDefault(); handBack(); return; }
  if (b?.dataset.action === 'takeover-key') { e.preventDefault(); if (holding()) send({ type: 'key', key: b.dataset.key }); return; }
  const img = e.target.closest('.takeover-frame');
  if (img && holding()) {
    e.preventDefault();
    img.focus({ preventScroll: true });
    send({ type: 'click', ...at(e, img) });
  }
});

document.addEventListener('keydown', (e) => {
  if (!live || !e.target.closest?.('#sheet .takeover-frame') || !holding()) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') return; // closes the sheet, as everywhere
  // A space is a key (it ticks a box, presses a button); other characters are text.
  if (e.key === ' ') { e.preventDefault(); send({ type: 'key', key: ' ' }); return; }
  if (e.key.length === 1) { e.preventDefault(); send({ type: 'text', text: e.key }); return; }
  if (KEYS.has(e.key)) { e.preventDefault(); send({ type: 'key', key: e.key }); }
});

document.addEventListener('wheel', (e) => {
  const img = e.target.closest?.('#sheet .takeover-frame');
  if (!img || !holding()) return;
  e.preventDefault();
  // Gathered for a moment, so a wheel turn is one scroll, not fifty requests.
  const w = live.wheel ?? (live.wheel = { dx: 0, dy: 0, at: at(e, img), timer: 0 });
  w.dx += e.deltaX;
  w.dy += e.deltaY;
  if (!w.timer) w.timer = setTimeout(() => { if (!live) return; const { dx, dy, at: p } = live.wheel; live.wheel = null; send({ type: 'scroll', ...p, dx, dy }); }, 80);
}, { passive: false });

document.addEventListener('submit', (e) => {
  const form = e.target.closest?.('#sheet .takeover-type');
  if (!form) return;
  e.preventDefault();
  const field = form.querySelector('input[name="text"]');
  if (!holding() || !field.value) return;
  send({ type: 'text', text: field.value });
  field.value = '';
});

export const takeoverOpen = (id) => live?.id === id;
