// Jarvis rings (owner direction 2026-11-08, step 1: styleguide compositions only). The agent's
// state as a HUD instrument: concentric segmented rings, arcs and fine ticks in one cyan family on
// near-black. The same ten states as the status icon (ui/js/status-icon.js); only the look differs.
// jarvisRing() is pure: state in, SVG markup out. Arcs are circles with pathLength 360, so a dash
// array is in degrees; motion is CSS loops keyed by class (ui/styles/jarvis-rings.css), and colours
// are the Jarvis surface's own custom properties. JarvisModel is the morph between states (800 ms,
// eased in and out) and success settling to idle; jarvisCore() is the DOM driver that cross-fades.
// Tests: tests/jarvis-ring.test.js (renderer and model), tests/ui/jarvis-rings.test.ts (the entry).

export const JARVIS_STATES = Object.freeze(['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline']);
export const JARVIS_MORPH_MS = 800;
// success is a flourish, never a resting state: it settles to idle by itself.
export const JARVIS_SUCCESS_MS = 1000;
export const JARVIS_SMALL_MAX = 24;

function known(status) {
  if (!JARVIS_STATES.includes(status)) throw new TypeError(`Unknown status: ${String(status)}`);
  return status;
}

// Size classes. At 24 px and under: no ticks, fewer segments, heavier strokes, so 16 px stays crisp.
// Widths and radii are in viewBox units (the box is 100 across, whatever the size on screen).
const TIERS = {
  s: { R: 38, r: 19, main: 10, inner: 9, heavy: 15, segs: 4, work: 6, fill: 4, dash: 3, off: 8, ticks: 0, minor: 0, gap: 16 },
  m: { R: 38, r: 25, main: 4.5, inner: 4, heavy: 8, segs: 6, work: 12, fill: 8, dash: 12, off: 24, ticks: 12, minor: 0, gap: 8 },
  l: { R: 37, r: 26, main: 2.6, inner: 2, heavy: 5.5, segs: 10, work: 24, fill: 8, dash: 24, off: 36, ticks: 12, minor: 60, gap: 5 },
  xl: { R: 37, r: 26, main: 1.6, inner: 1.2, heavy: 4, segs: 12, work: 36, fill: 8, dash: 30, off: 48, ticks: 12, minor: 60, gap: 3.5 },
};
export function jarvisTier(size) {
  const px = Number(size);
  if (!(px > 0)) throw new TypeError(`Bad size: ${String(size)}`);
  return px <= JARVIS_SMALL_MAX ? 's' : px <= 64 ? 'm' : px <= 128 ? 'l' : 'xl';
}

const n2 = (x) => Number(x.toFixed(2));
// One circle about the centre. dash/at in degrees from the top, clockwise.
// `k` is a segment's index, for loops that run along a ring in turn.
function ring(r, w, cls, { dash, at = 0, extra = '', k = null } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  const o = at ? ` stroke-dashoffset="${n2(-at)}"` : '';
  return `<circle cx="50" cy="50" r="${n2(r)}" pathLength="360" class="${cls}" style="stroke-width: ${n2(w)}${k === null ? '' : `; --jv-k: ${k}`}"${d}${o}${extra}/>`;
}
// One arc from `at` degrees, `len` degrees long. The dash pattern repeats every 360°, so an arc that
// crosses the top (at + len > 360) wraps round instead of being cut off where the circle's path ends.
const arc = (r, w, cls, at, len, extra = '', k = null) => ring(r, w, cls, { dash: `${n2(len)} ${n2(360 - len)}`, at, extra, k });
// n equal segments around a whole ring, with `gap` degrees between them.
const segmented = (r, w, cls, n, gap) => ring(r, w, cls, { dash: `${n2(360 / n - gap)} ${n2(gap)}`, at: gap / 2 });
const group = (cls, body, extra = '') => `<g${cls ? ` class="${cls}"` : ''}${extra}>${body}</g>`;

// The bezel: fine ticks just outside the ring (none at 24 px and under).
function bezel(t, tone, turning) {
  if (!t.ticks || !tone) return '';
  const major = ring(46, t.minor ? 4 : 5, tone, { dash: `${t.minor ? 1.2 : 2.4} ${n2(360 / t.ticks - (t.minor ? 1.2 : 2.4))}`, at: t.minor ? 0.6 : 1.2 });
  const minor = t.minor ? ring(46.5, 2.2, `${tone} jv-faint`, { dash: `0.5 ${n2(360 / t.minor - 0.5)}`, at: 0.25 }) : '';
  return group(turning ? 'jv-a-turn' : '', major + minor);
}

// What each state draws: [bezel tone, bezel turns, the state's own layers].
function layers(status, t, { reduced, amplitude }) {
  const a = (cls) => (reduced ? '' : cls); // motion classes vanish under reduced motion
  switch (status) {
    case 'idle':
      return ['jv-dim', false, group(a('jv-a-breathe'), ring(t.R, t.main, 'jv-c'))];
    case 'listening': {
      // An open arc (a 60° gap at the top) of segments that brighten in turn; the whole turns slowly.
      // Brighter and a little heavier than idle: it is an active state.
      const span = 300, n = t.segs, seg = (span - (n - 1) * t.gap) / n;
      const segs = Array.from({ length: n }, (_, k) => arc(t.R, t.main * 1.3, `jv-hi${reduced ? '' : ' jv-a-seg'}`, 30 + k * (seg + t.gap), seg, '', reduced ? null : k)).join('');
      return ['jv-dim', false, group(a('jv-a-turn'), segs)];
    }
    case 'thinking':
      // Two rings turning against each other, slowly: the outer one with two notches, the inner dashed.
      // At 24 px and under the outer ring is whole (notches there read as working's segments).
      return ['jv-dim', false,
        group(a('jv-a-turn'), ring(t.R, t.main, 'jv-c', t.tier === 's' ? {} : { dash: '168 12', at: 6 }))
        + group(a('jv-a-turn-rev'), ring(t.r, t.inner, 'jv-c', { dash: `${n2(360 / t.dash / 2)} ${n2(360 / t.dash / 2)}` }))];
    case 'working': {
      // A segmented outer ring turning, and a progress arc inside that fills segment by segment.
      const n = t.fill, step = 360 / n, gap = t.tier === 's' ? 10 : 6;
      const k8 = (k) => (n === 8 ? k + 1 : (k + 1) * (8 / n)); // which of the eight fill keyframes
      const fill = Array.from({ length: n }, (_, k) => arc(t.r, t.inner, `jv-c${reduced ? '' : ` jv-a-fill jv-f${k8(k)}`}`, k * step + gap / 2, step - gap, reduced && k >= Math.ceil(n * 0.6) ? ' opacity="0.2"' : '')).join('');
      return ['jv-dim', false, group(a('jv-a-work'), segmented(t.R, t.main, 'jv-c', t.work, t.tier === 's' ? 18 : t.gap)) + group('', fill)];
    }
    case 'speaking': {
      // The ring's radius pulses (or follows the voice's amplitude), around a small steady core.
      const voice = amplitude !== null && !reduced;
      const pulse = reduced ? '' : voice ? 'jv-amp' : 'jv-a-pulse';
      return ['jv-dim', false, group(pulse, ring(t.R - (t.tier === 's' ? 2 : 0), t.main, 'jv-c')) + ring(t.tier === 's' ? 12 : 13, t.inner, 'jv-c')];
    }
    case 'needs-you': {
      // One heavy amber arc (about 70°, centred on the top) and ONE clear gap after it; the rest of
      // the ring runs on from the amber arc's other end and keeps breathing.
      const [amber, gap] = t.tier === 's' ? [76, 40] : [68, 30];
      const end = amber / 2; // the amber arc runs from -amber/2 to +amber/2
      return ['jv-dim', !reduced,
        group(a('jv-a-breathe'), arc(t.R, t.main, 'jv-c', end + gap, 360 - amber - gap))
        + arc(t.R, t.heavy, 'jv-amber', 360 - end, amber)];
    }
    case 'success':
      // Closing: the full ring, and a heavy sweep arc with a bright head leading it round once.
      // Still (reduced), the sweep rests with its head at the top: still not idle's single ring.
      // The base ring is dim so the bright, heavy sweep stands out from idle's even ring at 16 px.
      return ['jv-dim', false, ring(t.R, t.main, 'jv-c jv-base')
        + group(a('jv-a-sweep'), arc(t.R, t.heavy, 'jv-hi jv-tail', 195, 150) + arc(t.R, t.heavy, 'jv-flash', 340, 20))];
    case 'paused':
      // Two still halves with wide gaps at the top and the bottom: a pair of vertical brackets.
      return ['jv-dim', false, arc(t.R, t.main * 1.15, 'jv-c', 35, 110) + arc(t.R, t.main * 1.15, 'jv-c', 215, 110)];
    case 'stopped': {
      // A broken red ring: three heavy segments, one centred on the top, wide even gaps at 60°, 180°
      // and 300° (so never paused's top-and-bottom brackets), still.
      const seg = 72;
      return ['jv-off', false, ring(t.R, t.heavy, 'jv-red', { dash: `${seg} ${120 - seg}`, at: 360 - seg / 2 })];
    }
    case 'offline':
      // A dim dashed ring, desaturated, and no bezel ticks at any size: deliberately off, not faint.
      return ['', false, ring(t.R, t.main, 'jv-grey', { dash: `${n2(360 / t.off * 0.45)} ${n2(360 / t.off * 0.55)}` })];
  }
  return ['', false, ''];
}

// jarvisRing({ status, size, reduced, amplitude }) → SVG markup. Pure. `amplitude` (0..1, or null)
// drives speaking's radius when there is a voice; without it speaking pulses gently by itself.
export function jarvisRing({ status = 'idle', size = 24, reduced = false, amplitude = null } = {}) {
  known(status);
  const tier = jarvisTier(size);
  if (amplitude !== null && !Number.isFinite(amplitude)) throw new TypeError(`Bad amplitude: ${String(amplitude)}`);
  const amp = amplitude === null ? null : Math.min(1, Math.max(0, amplitude));
  const t = { ...TIERS[tier], tier };
  const [tone, turning, body] = layers(status, t, { reduced: !!reduced, amplitude: amp });
  const attrs = [`class="jv-ring"`, `viewBox="0 0 100 100"`, `width="${Number(size)}"`, `height="${Number(size)}"`, `data-state="${status}"`, `data-tier="${tier}"`, 'aria-hidden="true"', 'focusable="false"'];
  if (reduced) attrs.push('data-reduced');
  if (amp !== null && status === 'speaking' && !reduced) attrs.push(`style="--jv-amp: ${n2(amp)}"`);
  // The drawing starts at the top: everything sits in one group turned back a quarter.
  return `<svg ${attrs.join(' ')}><g transform="rotate(-90 50 50)">${bezel(t, tone, turning && !reduced)}${body}</g></svg>`;
}

// ---- the state model: which states are on screen, and how much of each -------------------------

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2); // soft in and out

export class JarvisModel {
  constructor(status = 'idle', now = 0) {
    this.to = known(status);
    this.from = { [status]: 1 };
    this.start = now;
    this.reduced = false; // no morph: each change swaps straight to the new state
  }

  #mix(now) {
    const k = ease(Math.min(1, Math.max(0, (now - this.start) / JARVIS_MORPH_MS)));
    const out = {};
    for (const [s, w] of Object.entries(this.from)) out[s] = w * (1 - k);
    out[this.to] = (out[this.to] ?? 0) + k;
    return out;
  }

  #settle(now) {
    if (this.to !== 'success' || now < this.start + JARVIS_SUCCESS_MS) return;
    const at = this.start + JARVIS_SUCCESS_MS;
    this.from = this.reduced ? { idle: 1 } : this.#mix(at);
    this.to = 'idle';
    this.start = at;
  }

  weights(now) { this.#settle(now); return this.#mix(now); }
  status(now) { this.#settle(now); return this.to; }
  moving(now) { this.#settle(now); return this.to === 'success' || now - this.start < JARVIS_MORPH_MS; }

  set(next, now) {
    known(next);
    this.#settle(now);
    if (this.reduced) { this.from = { [next]: 1 }; this.to = next; this.start = now; return; }
    if (next === this.to) return;
    this.from = this.#mix(now); // retarget from what is on screen, never from a fresh start
    this.to = next;
    this.start = now;
  }
}

// ---- the DOM driver (browser only below) --------------------------------------------------------

const reduceQuery = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

// jarvisCore({ status, size }) → a <span role="img"> of stacked ring layers, one per state on screen,
// cross-faded by the model. el.setStatus(s), el.setAmplitude(a | null), el.setReduced(on | null).
export function jarvisCore({ status = 'idle', size = 24 } = {}) {
  known(status);
  jarvisTier(size);
  const el = document.createElement('span');
  el.className = 'jv-core';
  el.setAttribute('role', 'img');
  const model = new JarvisModel(status, performance.now());
  let forced = null;
  let amplitude = null;
  let raf = 0;
  const shown = new Map(); // state → its layer
  const reducedNow = () => forced ?? !!reduceQuery()?.matches;
  const label = (s) => { if (el.dataset.status === s) return; el.dataset.status = s; el.setAttribute('aria-label', s); el.title = s; };
  const layer = (s) => {
    let svg = shown.get(s);
    if (!svg) {
      const tpl = document.createElement('template');
      tpl.innerHTML = jarvisRing({ status: s, size, reduced: model.reduced, amplitude: s === 'speaking' ? amplitude : null });
      svg = tpl.content.firstElementChild;
      el.append(svg);
      shown.set(s, svg);
    }
    return svg;
  };
  const clear = () => { for (const svg of shown.values()) svg.remove(); shown.clear(); };
  function paint() {
    raf = 0;
    if (!el.isConnected && el.dataset.drawn) return; // gone from the page: stop
    const now = performance.now();
    const w = model.weights(now);
    for (const [s, k] of Object.entries(w)) {
      if (k < 1e-3) continue;
      const svg = layer(s);
      svg.style.opacity = String(Number(k.toFixed(3)));
      // A touch of scale as a layer arrives or leaves, so the rings seem to re-form, not just fade.
      svg.style.scale = String(Number((0.94 + 0.06 * k).toFixed(4)));
    }
    for (const [s, svg] of shown) if (!(w[s] > 1e-3)) { svg.remove(); shown.delete(s); }
    label(model.status(now));
    el.dataset.drawn = '1';
    if (model.moving(now)) raf = requestAnimationFrame(paint);
  }
  const restill = () => { const now = performance.now(); model.reduced = reducedNow(); model.set(model.status(now), now); clear(); paint(); };
  // A change draws at once (so reduced motion swaps in the same frame), then animates on from there.
  el.setStatus = (next) => { model.set(known(next), performance.now()); cancelAnimationFrame(raf); paint(); };
  el.setAmplitude = (a) => {
    if (a !== null && !Number.isFinite(a)) throw new TypeError(`Bad amplitude: ${String(a)}`);
    const was = amplitude;
    amplitude = a === null ? null : Math.min(1, Math.max(0, a));
    const svg = shown.get('speaking');
    if (!svg) return;
    if ((was === null) !== (amplitude === null)) { svg.remove(); shown.delete('speaking'); paint(); return; }
    if (amplitude !== null) svg.style.setProperty('--jv-amp', String(amplitude));
  };
  el.setReduced = (on) => { forced = on; restill(); };
  Object.defineProperty(el, 'status', { get: () => model.status(performance.now()) });
  model.reduced = reducedNow();
  reduceQuery()?.addEventListener?.('change', () => { if (forced === null) restill(); });
  label(status);
  paint();
  return el;
}
