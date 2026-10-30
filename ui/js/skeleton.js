// A whole view waiting for its data (DESIGN-SYSTEM §1, binding): under 1 s nothing shows; from 1 s
// a skeleton; after 10 s, real units and an estimate (wait.js). A skeleton here is never a guess:
// it is the view's own last real layout on this device, at this width, block by block, so the
// content lands exactly where the skeleton stood and nothing moves (CLS). With no layout kept for
// this width, there is no skeleton, only the waiting line. It is drawn at once but unseen for its
// first second (CSS), so the room it takes is the room the view will take.
import { waitingLine, over } from './wait.js';

const KEY = 'nova.shape';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };
const write = (all) => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage off: no skeletons */ } };
// One shape per view, layout and width; a conversation's is its own (`id`): another conversation's
// shape would be a guess (review of #234), so a conversation not opened here before has no skeleton.
const slot = (view, el, id = '') => `${view}${id ? `:${id}` : ''}|${document.body.dataset.layout}|${Math.round(contentBox(el).width)}`;

function contentBox(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const top = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
  const height = r.height - (top - r.top) - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
  return { left, top, width: r.width - (left - r.left) - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight), height };
}

// A block's text lines, as bars inside it (a skeleton is never just a frame).
function lines(el, r) {
  const out = [];
  for (const t of el.querySelectorAll('h1, h2, h3, p, li, .task-title, .memory-text, .card-title, .bubble')) {
    const b = t.getBoundingClientRect();
    if (!b.width || !b.height || out.length >= 12) continue;
    out.push([Math.round(b.left - r.left), Math.round(b.top - r.top), Math.round(b.width), Math.max(4, Math.round(b.height * 0.6))]);
  }
  return out;
}

// A view's blocks: what a skeleton stands in for, one by one.
export function blocksOf(view, el) {
  if (view === 'chat') return [...el.querySelectorAll(':scope > .block > *')];
  if (view === 'home') return [...el.children].flatMap((c) => (c.classList.contains('home-cards') ? [...c.children].flatMap((x) => (x.matches('[data-asideable]') ? [...x.children] : [x])) : [c]));
  return [...el.children];
}

// After a real render: where each of the view's blocks is. A conversation is read from its end and
// lays out turns far above only as estimates (content-visibility), so its blocks are kept by their
// distance from the end: what is on screen when it opens is what must match.
const FROM_END = new Set(['chat']);
export function keepShape(view, el, blocks, id = '') {
  const box = contentBox(el);
  const end = FROM_END.has(view);
  const shape = blocks.map((b) => {
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cs = getComputedStyle(b);
    const card = !cs.backgroundColor.endsWith(', 0)') || cs.borderTopStyle !== 'none'; // a painted box
    const y = end ? box.top + box.height - r.bottom : r.top - box.top;
    return { x: r.left - box.left, y, w: r.width, h: r.height, radius: cs.borderTopLeftRadius, card, lines: lines(b, r) };
  }).filter(Boolean);
  if (!shape.length) return;
  // As tall as the view's content (its margins and spacing included), so a view read from its end
  // (a conversation) is scrolled to the same place.
  const height = Math.max(box.height, ...shape.map((s) => s.y + s.h));
  const all = read();
  const key = slot(view, el, id);
  delete all[key]; // the newest last
  all[key] = { height, end, blocks: shape };
  // Kept for the conversations opened most recently only, so the store stays small.
  const chats = Object.keys(all).filter((k) => k.startsWith('chat:'));
  for (const k of chats.slice(0, Math.max(0, chats.length - 24))) delete all[k];
  write(all);
}

// While the view waits: its skeleton (if its layout at this width is known) and the waiting line.
// `units`: { done, total } for the 10 s words.
export function showWaiting(view, el, text, { done = null, total = null, end = false, id = '' } = {}) {
  // Not on screen yet (a view drawn before it is shown): nothing to size a skeleton by.
  if (!(contentBox(el).width > 0)) { el.innerHTML = ''; return; }
  const shape = read()[slot(view, el, id)];
  const line = waitingLine(text, { key: `view-${view}`, done, total, noun: 'part' });
  if (!shape) { el.innerHTML = `<div class="view-waiting" data-waiting-view="${view}">${line}</div>`; return; }
  const bars = (b) => b.lines.map(([x, y, w, h]) => `<span class="skel-line" style="left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px"></span>`).join('');
  const edge = shape.end ? 'bottom' : 'top';
  el.innerHTML = `<div class="skeleton${shape.end ? ' is-end' : ''}" data-skeleton="${view}" style="height: ${shape.height}px"><div aria-hidden="true">${shape.blocks.map((b) => `<div class="skel-block${b.card ? ' is-card' : ''}" style="left: ${b.x}px; ${edge}: ${b.y}px; width: ${b.w}px; height: ${b.h}px; border-radius: ${b.radius}">${bars(b)}</div>`).join('')}</div><div class="skel-status">${line}</div></div>`;
  if (end) el.closest('#scroller')?.scrollTo({ top: 1e9 });
}

// The data is in: the wait is over (and how long it took is kept for "it usually takes…").
export function doneWaiting(view) { over(`view-${view}`); }

// Real units arriving while the view waits: the 10 s words count them.
export function waitingUnits(view, done, total) {
  for (const n of document.querySelectorAll(`[data-waiting="view-${view}"]`)) { n.dataset.done = String(done); n.dataset.total = String(total); }
}
