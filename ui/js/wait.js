// Progress and waiting (DESIGN-SYSTEM §1, binding; Amendment 2026-10-30-C Part 2): the one place
// the timing bands live, so every waiting state in the PWA follows them.
//   under 1 s   no indicator;
//   1–10 s      a spinner for one part, or a skeleton for a whole view (skeleton.js);
//   over 10 s   progress in real units (parts, steps, bytes) and a general estimate, where there is
//               a measured basis for one; never a percentage without a total, never false precision.
// Nothing here makes anything wait: there are no delays, only a clock that decides what to say about
// a wait that is really happening. The pure functions are unit-tested (tests/m9-wait.test.js).
import { escapeHtml as esc } from './markdown.js';

export const QUIET_MS = 1000;
export const LONG_MS = 10_000;

// Which band an elapsed wait is in.
export function band(elapsed) {
  if (!(elapsed >= QUIET_MS)) return 'quiet';
  return elapsed < LONG_MS ? 'indicator' : 'progress';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Real units of work: "3 of 9 parts". With no total there is no fraction and no bar, only what is
// done so far. A bar's value is the real count, so it never stalls at 99%: it says 8 of 9.
export function units(done, total, one = 'part', many = `${one}s`) {
  const d = Math.max(0, Math.floor(Number(done) || 0));
  const t = Number(total);
  if (!(t > 0)) return { text: d ? `${plural(d, one, many)} done` : '', value: null, max: null };
  const v = Math.min(d, Math.floor(t));
  return { text: `${v} of ${plural(Math.floor(t), one, many)}`, value: v, max: Math.floor(t) };
}

// A general estimate, never a countdown: words, rounded the way a person would say it, padded a
// little so it errs long (NN/g: "always allow for extra time").
export function about(ms) {
  if (!(ms > 0)) return '';
  const s = ms / 1000;
  if (s < 15) return 'a few seconds';
  if (s < 45) return 'about half a minute';
  if (s < 90) return 'about a minute';
  const min = Math.round(s / 60);
  if (min < 55) return `about ${min} minutes`;
  const h = Math.round(s / 3600);
  return h <= 1 ? 'about an hour' : `about ${h} hours`;
}

// Time left from the measured rate so far: only once a wait is long (10 s) and some real units are
// done, so the basis is real. Otherwise nothing.
export function left(done, total, elapsed) {
  if (!(elapsed >= LONG_MS) || !(done > 0) || !(total > done)) return '';
  return `${about((elapsed * (total - done) / done) * 1.2)} left`;
}

// How long this kind of wait usually takes, from earlier ones on this device: the median, in words.
export function usually(durations) {
  const d = (durations ?? []).filter((x) => x > 0).sort((a, b) => a - b);
  if (d.length < 2) return '';
  const mid = d[Math.floor(d.length / 2)];
  return mid < 1000 ? 'under a second' : about(mid).replace(/^about /, 'about ');
}

// What a kind of wait usually takes, in general words, before this device has any history of its own
// (a first visit): Nova's own reads are local and answer in well under a second; a reply, a step, a
// scheduled run take what such work takes. The amendment asks for a general estimate after 10 s,
// so there is always one; this device's own history replaces it as soon as there is some.
const USUAL = [
  [/^(view-|capture|changes|checkpoints|connections|browser-sites|health|models|reset|memory-save|send)/, 'under a second'],
  [/^(restore-preview|takeover-picture|step-)/, 'a few seconds'],
  [/^reply/, 'about half a minute'],
  [/^(schedule|first-task)/, 'about a minute'],
  [/^download-/, 'a few minutes'],
];
export function expected(kind, durations = []) {
  return usually(durations) || USUAL.find(([re]) => re.test(kind))?.[1] || '';
}

// Time so far, plainly.
export function sofar(elapsed) {
  const s = Math.floor(elapsed / 1000);
  return s < 60 ? `${s} s so far` : `${Math.floor(s / 60)} min so far`;
}

// ---- in the page ------------------------------------------------------------------------------

// When each wait began, by name, so a part redrawn while it waits keeps the wait's real age; and,
// once it is over, how long it took (for "it usually takes…").
const begun = new Map();
export function since(key) {
  if (!begun.has(key)) begun.set(key, Date.now());
  return begun.get(key);
}
// A wait that began before it had a name here: the page's own moment, carried over (a message that
// was pending becomes the server's turn, and its Thinking keeps the time the person pressed Send).
export function begin(key, at = Date.now()) {
  if (at > 0) begun.set(key, at);
  return begun.get(key);
}
export function over(key) {
  const t = begun.get(key);
  begun.delete(key);
  if (t !== undefined) remember(key, Date.now() - t);
}

// What a wait's indicator shows now, from when it began: whether it is past 1 s (seen), past 10 s,
// and its long-wait words. The same at a redraw as the clock below makes it, so redrawing a wait
// never hides or changes it.
export function waitState(key, at, { done = null, total = null, noun = 'part' } = {}) {
  const elapsed = Date.now() - at;
  const words = longWords({ elapsed, done, total, noun, usual: expected(key, history(key)) });
  const cls = `${elapsed >= QUIET_MS ? ' is-late' : ''}${elapsed >= LONG_MS ? ' is-long' : ''}`;
  const u = done === null ? '' : ` data-done="${done}" data-total="${total ?? ''}" data-noun="${esc(noun)}"`;
  // A redraw keeps the fade-in on the wait's own clock, not the new element's.
  const delay = elapsed < QUIET_MS ? ` style="--wait-left: ${Math.round(QUIET_MS - elapsed)}ms"` : '';
  return { cls, attrs: ` data-waiting="${esc(key)}" data-since="${at}"${u}${delay}`, more: `<span class="waiting-more">${words ? ` · ${esc(words)}` : ''}</span>` };
}

// A waiting line for one part: unseen for its first second (CSS: .waiting fades in after
// --wait-quiet), then a calm spinner and what is being waited for; after 10 s, real units and an
// estimate. `key`: the wait's name; its start is kept (since/over) unless `since` (ms) says when
// it really began. `done`/`total`/`noun`: real units, where they are known.
export function waitingLine(text, { key = '', since: at = key ? since(key) : Date.now(), done = null, total = null, noun = 'part', tag = 'p' } = {}) {
  const w = waitState(key, at, { done, total, noun });
  return `<${tag} class="waiting${w.cls}"${w.attrs} role="status"><span class="pulse" aria-hidden="true"></span><span class="waiting-text">${esc(text)}…${w.more}</span></${tag}>`;
}

// What a long wait adds: real units, an estimate where there is a basis, or the time so far.
export function longWords({ elapsed, done = null, total = null, noun = 'part', usual = '' }) {
  if (band(elapsed) !== 'progress') return '';
  const u = done === null ? { text: '' } : units(done, total, noun);
  const est = done === null ? '' : left(done, total, elapsed);
  const parts = [u.text, est || sofar(elapsed)];
  if (!est && usual) parts.push(`it usually takes ${usual}`);
  return parts.filter(Boolean).join(' · ');
}

// Durations of waits of one kind on this device, for "it usually takes…".
const KEY = 'nova.waits';
export function remember(kind, ms) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    all[kind] = [...(all[kind] ?? []), Math.round(ms)].slice(-9);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage off: no history */ }
}
export function history(kind) {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}')[kind] ?? []; } catch { return []; }
}

// One clock for every long wait on the page: once a second it brings each waiting line's words up to
// date. It changes words only; nothing waits on it.
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-waiting][data-since]')) {
    const elapsed = now - Number(el.dataset.since);
    if (elapsed >= QUIET_MS) el.classList.add('is-late');
    if (elapsed >= LONG_MS) el.classList.add('is-long');
    const more = el.querySelector(':scope > .waiting-more, :scope .waiting-more');
    if (!more) continue;
    const words = longWords({
      elapsed,
      done: el.dataset.done === undefined ? null : Number(el.dataset.done),
      total: el.dataset.total ? Number(el.dataset.total) : null,
      noun: el.dataset.noun ?? 'part',
      usual: expected(el.dataset.waiting, history(el.dataset.waiting)),
    });
    const text = words ? ` · ${words}` : '';
    if (more.textContent !== text) more.textContent = text;
  }
}
if (typeof document !== 'undefined') setInterval(tick, 1000); // wait: clock for long waits' words
