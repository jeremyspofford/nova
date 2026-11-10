// The agent status icon: Nova's mark, the N itself, drawn as one inline SVG on a transparent
// background (owner, UI item 24, 2026-11-10: "the N itself on a TRANSPARENT background, not a picture
// in a box"). The letterform is traced from the owner's artwork (docs/builder-packet/ui-references/
// nova-mark-owner-reference-regenerated-2026-11-08.webp): two ribbons turning round a dark core, each
// an upright of the N that sweeps over (or under) and curls into the centre, the left one blue to
// cyan, the right one violet through magenta to coral; where they cross, the right one is in front,
// as in the artwork. One geometry at every size, so the mark is identical at 16 px and at 180 px.
// Its colours are the design system's: each ribbon is a gradient whose stops are the theme's mark
// tokens (--mark-left-outer … --mark-right-inner; the full nebula on a dark look, a deepened one at
// 4.5:1 on a light look: src/core/design.ts MARK_CONTRAST), and a surface may set a variant of them
// (--mark-variant-*: the Jarvis HUD study, ui/styles/jarvis-rings.css).
// Each state is a TREATMENT of the mark, never new geometry (nova-single-mark-n-direction-2026-11-08.md):
// a palette shift, brightness, and motion (the light turning round the core, a radial pulse).
// This file only draws: it is served before pairing on that condition (tests/public-status-icon.test.js),
// so the geometry is computed here and nothing is imported or loaded.
// The model (StatusModel, stateTreatment) is pure and unit-tested (tests/status-icon.test.js).

export const STATUS_ICON_STATES = Object.freeze(['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline']);
// Owner, 2026-11-08: 400 ms read as too fast and acute; a change takes 800 ms on a soft ease-in-out.
export const MORPH_MS = 800;
// success is a flourish, never a resting state: it settles to idle by itself.
export const SUCCESS_MS = 1800; // the 800 ms change in, its sweep, then about a second shown
const SWEEP_MS = 1000;
const LOOPS = new Set(['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you']);
const TAU = Math.PI * 2;

function known(status) {
  if (!STATUS_ICON_STATES.includes(status)) throw new TypeError(`Unknown status: ${String(status)}`);
  return status;
}
const ease = (k) => (1 - Math.cos(Math.PI * k)) / 2;

// ---- the state model: which forms are on screen, and how much of each --------------------------

export class StatusModel {
  constructor(status = 'idle', now = 0) {
    this.to = known(status);
    this.from = { [status]: 1 };
    this.start = now;
    this.reduced = false; // no morph: each change swaps straight to the new form
  }

  #mix(now) {
    const k = ease(Math.min(1, Math.max(0, (now - this.start) / MORPH_MS)));
    const out = {};
    for (const [s, w] of Object.entries(this.from)) out[s] = w * (1 - k);
    out[this.to] = (out[this.to] ?? 0) + k;
    return out;
  }

  #settle(now) {
    if (this.to !== 'success' || now < this.start + SUCCESS_MS) return;
    const at = this.start + SUCCESS_MS;
    this.from = this.reduced ? { idle: 1 } : this.#mix(at);
    this.to = 'idle';
    this.start = at;
  }

  weights(now) { this.#settle(now); return this.#mix(now); }
  status(now) { this.#settle(now); return this.to; }
  moving(now) { this.#settle(now); return this.to === 'success' || now - this.start < MORPH_MS; }

  set(next, now) {
    known(next);
    this.#settle(now);
    if (this.reduced) { this.from = { [next]: 1 }; this.to = next; this.start = now; return; }
    if (next === this.to) return;
    this.from = this.#mix(now); // retarget from the form on screen, never from a fresh start
    this.to = next;
    this.start = now;
  }
}

// ---- the treatments: what each state does to the mark (the owner's state table) -----------------

// A wave that eases in and out by itself, and a 0 → 1 → 0 swell over one period.
const sway = (t, period) => Math.sin((TAU * t) / period);
const swell = (t, period) => (1 - Math.cos((TAU * t) / period)) / 2;

// stateTreatment(status, t) → how the mark is drawn in that state at time t (seconds; 0 when
// motion is reduced): twirl (radians the light turns round the core), pulse (radial: > 0 draws
// inward, < 0 outward), hue (radians of palette churn), tint ('cyan' | 'amber' | 'red' | null) and
// how much, saturation and brightness. Paused, stopped and offline don't depend on t: they are frozen.
export function stateTreatment(status, t = 0) {
  const still = { twirl: 0, pulse: 0, hue: 0, tint: null, tintAmt: 0, sat: 1, bright: 1 };
  switch (known(status)) {
    case 'idle': return { ...still, twirl: 0.1 * sway(t, 12) }; // full palette, a very slow swirl
    case 'listening': return { ...still, tint: 'cyan', tintAmt: 0.45, pulse: 0.035 * swell(t, 4) }; // cyan-leaning, a slow inward pulse
    case 'thinking': return { ...still, hue: 0.2 + 0.3 * sway(t, 6), twirl: 0.16 * sway(t, 7) }; // the palette shifted and churning, medium motion
    case 'working': return { ...still, twirl: 0.22 * sway(t, 2.4), sat: 1.12, bright: 1.15 }; // full palette, faster, brighter
    case 'speaking': return { ...still, pulse: -0.03 * swell(t, 1.8), bright: 1.05 }; // a gentle outward pulse
    case 'needs-you': return { ...still, tint: 'amber', tintAmt: 0.7, twirl: 0.1 * sway(t, 8), bright: 1.05 }; // amber, still running
    case 'success': return { ...still, sat: 1.05, bright: 1.12 }; // plus the sweep, drawn from the model's clock
    case 'paused': return { ...still, sat: 0.55, bright: 0.5 }; // dimmed and frozen
    case 'stopped': return { ...still, tint: 'red', tintAmt: 0.8, bright: 0.95 }; // red and frozen
    case 'offline': return { ...still, sat: 0, bright: 0.45 }; // greyscale, dim and frozen
  }
}

// The treatments of every state on screen, mixed by how much of each there is.
function blend(weights, t, tints) {
  const out = { twirl: 0, pulse: 0, hue: 0, tint: [0, 0, 0], tintAmt: 0, sat: 0, bright: 0 };
  for (const [s, k] of Object.entries(weights)) {
    if (k < 1e-3) continue;
    const tr = stateTreatment(s, t);
    for (const f of ['twirl', 'pulse', 'hue', 'tintAmt', 'sat', 'bright']) out[f] += tr[f] * k;
    if (tr.tint) for (let i = 0; i < 3; i++) out.tint[i] += tints[tr.tint][i] * tr.tintAmt * k;
  }
  if (out.tintAmt > 0) out.tint = out.tint.map((v) => v / out.tintAmt);
  return out;
}

// ---- the mark: the N, traced from the owner's artwork --------------------------------------------

// On a 100-unit square, the core at its centre. Each ribbon's centre line runs up (or down) an
// upright, then round a squared spiral (a superellipse, squareness N_SQUARE, that rounds off as it
// winds in) from the outer radius R_OUT to R_IN at its tip, a quarter turn past the far side; its
// width eases from W_OUT to a W_IN point. These numbers are the artwork's, measured on its 1600 px
// source: the uprights a fifth of the mark wide, the core hole an eighth, the tips curling a
// quarter turn under (or over) the core. The right ribbon is the left one turned half round.
const CORE = 50;
const N_SQUARE = 2.5;
const R_OUT = 30, R_IN = 15;
const W_OUT = 19, W_IN = 4;
const UPRIGHT = 30; // how far the upright runs past the core's line
const WIND_FROM = 250, WIND_TO = 455, TAPER_FROM = 300; // degrees round the core
export const MARK_VIEWBOX = '9 9 82 82';

const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

// The ribbon's centre line: points with the width there.
function spine(turn) {
  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push([-R_OUT, UPRIGHT * (1 - i / 24), W_OUT]);
  for (let i = 1; i <= 140; i++) {
    const deg = 180 + (WIND_TO - 180) * (i / 140);
    const th = (deg * Math.PI) / 180;
    const c = Math.cos(th), s = Math.sin(th), e = 2 / N_SQUARE;
    const sq = 1 - smooth(WIND_FROM, WIND_TO - 40, deg); // square on the frame, round in the curl
    const ux = c + (Math.sign(c) * Math.abs(c) ** e - c) * sq;
    const uy = s + (Math.sign(s) * Math.abs(s) ** e - s) * sq;
    const r = R_OUT + (R_IN - R_OUT) * smooth(WIND_FROM, WIND_TO, deg);
    pts.push([r * ux, r * uy, W_OUT + (W_IN - W_OUT) * smooth(TAPER_FROM, WIND_TO, deg)]);
  }
  const ct = Math.cos(turn), st = Math.sin(turn);
  return pts.map(([x, y, w]) => [CORE + x * ct - y * st, CORE + x * st + y * ct, w]);
}

// The ribbon's outline: both edges of the centre line, joined by round ends.
function ribbon(pts) {
  const left = [], right = [];
  pts.forEach(([x, y, w], i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    left.push([x + (nx * w) / 2, y + (ny * w) / 2]);
    right.push([x - (nx * w) / 2, y - (ny * w) / 2]);
  });
  // A half circle round an end, from one edge to the other, bulging the way the end faces.
  const cap = ([x, y, w], from, dx, dy) => {
    const a0 = Math.atan2(from[1] - y, from[0] - x);
    const turn = Math.sin(Math.atan2(dy, dx) - a0) >= 0 ? 1 : -1;
    return Array.from({ length: 11 }, (_, k) => { const a = a0 + (turn * Math.PI * (k + 1)) / 12; return [x + (w / 2) * Math.cos(a), y + (w / 2) * Math.sin(a)]; });
  };
  const n = pts.length;
  const ring = [
    ...left, ...cap(pts[n - 1], left[n - 1], pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]),
    ...right.reverse(), ...cap(pts[0], right.at(-1), pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]),
  ];
  const f = (v) => Math.round(v * 100) / 100;
  return `M${ring.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
}

// The two ribbons' outlines, left (drawn first) and right (in front where they cross).
export const MARK_PATHS = Object.freeze([ribbon(spine(0)), ribbon(spine(Math.PI))]);

// Each ribbon's gradient: centred on the core, its focus set off towards the ribbon's own curl, so
// its light turns as the gradient turns. Inner stop at the curl, outer along the upright and arc.
const RIBBONS = [
  { side: 'left', focus: [58, 52], stops: [['inner', 0.25], ['mid', 0.55], ['outer', 0.95]] },
  { side: 'right', focus: [42, 48], stops: [['inner', 0.25], ['mid', 0.6], ['outer', 0.95]] },
];
export const MARK_STOPS = Object.freeze(RIBBONS.flatMap((r) => r.stops.map(([at]) => `${r.side}-${at}`)));
// Each stop's colour: the surface's variant if it sets one, else the theme's token.
const STOP_COLOURS = Object.freeze({
  'left-outer': 'var(--mark-variant-left-outer, var(--mark-left-outer))',
  'left-mid': 'var(--mark-variant-left-mid, var(--mark-left-mid))',
  'left-inner': 'var(--mark-variant-left-inner, var(--mark-left-inner))',
  'right-outer': 'var(--mark-variant-right-outer, var(--mark-right-outer))',
  'right-mid': 'var(--mark-variant-right-mid, var(--mark-right-mid))',
  'right-inner': 'var(--mark-variant-right-inner, var(--mark-right-inner))',
});
const stopColour = (name) => STOP_COLOURS[name];

let made = 0;
// markSvg({ size, label }) → the mark as SVG markup, at rest in its theme's colours: for a place that
// shows Nova's mark rather than its state (About). Decorative unless `label` is given.
export function markSvg({ size = 24, label = null } = {}) {
  const px = Number(size);
  if (!(px > 0)) throw new TypeError(`Bad size: ${String(size)}`);
  const id = `nova-mark-${++made}`;
  const a11y = label ? `role="img" aria-label="${String(label).replace(/[&<>"']/g, '')}"` : 'aria-hidden="true"';
  const grads = RIBBONS.map((r) => `<radialGradient id="${id}-${r.side}" gradientUnits="userSpaceOnUse" cx="${CORE}" cy="${CORE}" r="44" fx="${r.focus[0]}" fy="${r.focus[1]}">${r.stops.map(([at, offset]) => `<stop offset="${offset}" data-stop="${r.side}-${at}" style="stop-color:${stopColour(`${r.side}-${at}`)}"/>`).join('')}</radialGradient>`).join('');
  const paths = RIBBONS.map((r, i) => `<path data-ribbon="${r.side}" d="${MARK_PATHS[i]}" style="fill:url(#${id}-${r.side})"/>`).join('');
  return `<svg class="nova-mark" ${a11y} width="${px}" height="${px}" viewBox="${MARK_VIEWBOX}" focusable="false"><defs>${grads}</defs><g data-mark-body>${paths}</g></svg>`;
}

// ---- colours: the tokens a state's treatment works from, resolved where each icon is -------------

// Every colour a treatment needs, as the custom property it comes from: the mark's stops (with any
// variant the icon's surface sets), the surface it sits on (dimming fades towards it), and the
// tints the state table names.
const TINTS = { cyan: '--orb-core', amber: '--orb-attention', red: '--status-error' };
const REFS = [...MARK_STOPS.map((n) => [n, stopColour(n)]), ['surface', 'var(--bg-base)'], ...Object.entries(TINTS).map(([k, v]) => [k, `var(${v})`])];

// A computed colour, in whatever syntax the browser gives it, as sRGB 0..1: drawn and read back.
let probe;
const parsed = new Map();
function rgb(value) {
  if (!value) return [0, 0, 0];
  if (parsed.has(value)) return parsed.get(value);
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = 'transparent';
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const out = [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((v) => v / 255);
  parsed.set(value, out);
  return out;
}

// An icon's colours, read from hidden stops in its own SVG (so a surface's variant counts), once,
// and again whenever the design system or the light/dark preference changes.
let paletteEpoch = 0;
function palette(ic) {
  if (ic.palette && ic.paletteEpoch === paletteEpoch) return ic.palette;
  ic.palette = Object.fromEntries([...ic.refs].map((s) => [s.dataset.ref, rgb(getComputedStyle(s).stopColor)]));
  ic.paletteEpoch = paletteEpoch;
  return ic.palette;
}

const lumOf = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
const mixC = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// A hue turn in YIQ, as the palette churns.
function hueTurn([r, g, b], h) {
  if (!h) return [r, g, b];
  const y = 0.299 * r + 0.587 * g + 0.114 * b, i = 0.596 * r - 0.274 * g - 0.322 * b, q = 0.211 * r - 0.523 * g + 0.312 * b;
  const c = Math.cos(h), s = Math.sin(h), i2 = i * c - q * s, q2 = i * s + q * c;
  return [y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2].map(clamp01);
}

// One stop under a treatment. A tint maps the stop onto the token's colour, keeping how much
// lighter or darker than the rest it is; brightness is towards or away from the surface, so a dim
// state fades into its page in light and dark alike, and a bright one stands out from it.
function treat(c, tr, pal, mean) {
  let out = hueTurn(c, tr.hue);
  if (tr.tintAmt > 0) {
    const shade = Math.min(1.35, Math.max(0.45, 1 + (lumOf(out) - mean) * 1.6));
    out = mixC(out, tr.tint.map((v) => clamp01(v * shade)), Math.min(1, tr.tintAmt));
  }
  const l = lumOf(out);
  out = out.map((v) => clamp01(l + (v - l) * tr.sat));
  const away = lumOf(pal.surface) < 0.5 ? [1, 1, 1] : [0, 0, 0];
  if (tr.bright < 1) out = mixC(out, pal.surface, 1 - tr.bright);
  else if (tr.bright > 1) out = mixC(out, away, Math.min(1, (tr.bright - 1) * 1.5));
  return out;
}

const css = (c) => `rgb(${c.map((v) => Math.round(clamp01(v) * 255)).join(' ')})`;
const IDENTITY = (tr) => Math.abs(tr.hue) < 1e-4 && tr.tintAmt < 1e-4 && Math.abs(tr.sat - 1) < 1e-4 && Math.abs(tr.bright - 1) < 1e-4;

function paint(ic, now) {
  const { model } = ic;
  const t = model.reduced ? 0 : now / 1000;
  const pal = palette(ic);
  const tr = blend(model.weights(now), t, pal);
  // Success: one turn of light round the core and a swell of brightness, across its first second,
  // unless motion is reduced.
  const since = now - model.start;
  if (model.to === 'success' && !model.reduced && since < SWEEP_MS) {
    const k = since / SWEEP_MS;
    tr.twirl += TAU * ease(k);
    tr.bright += 0.35 * Math.sin(Math.PI * k);
  }
  // The light turns round the core (the gradients turn; the N never moves) and the pulse draws the
  // whole mark in or out about it.
  const deg = ((tr.twirl * 3 * 180) / Math.PI).toFixed(2);
  for (const g of ic.grads) g.setAttribute('gradientTransform', `rotate(${deg} ${CORE} ${CORE})`);
  const scale = (1 - tr.pulse).toFixed(4);
  ic.body.setAttribute('transform', `translate(${CORE} ${CORE}) scale(${scale}) translate(${-CORE} ${-CORE})`);
  // At rest in its own colours, a stop is the token itself (a theme change shows at once); under a
  // treatment, the token's colour treated.
  const plain = IDENTITY(tr);
  const mean = MARK_STOPS.reduce((s, n) => s + lumOf(pal[n]), 0) / MARK_STOPS.length;
  for (const s of ic.stops) {
    const name = s.dataset.stop;
    s.style.setProperty('stop-color', plain ? stopColour(name) : css(treat(pal[name], tr, pal, mean)));
  }
  ic.el.dataset.renderer = 'svg';
}

// ---- instances and the one animation loop --------------------------------------------------------

const live = new Set();
let raf = 0;
// What is on screen: an icon scrolled away, or in a hidden region (the rail's on an empty chat, the
// phone's top bar on a desktop), keeps its state but isn't redrawn until it shows again.
let sight;
const watchSight = (ic) => {
  if (sight === undefined) {
    sight = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const it = e.target.statusIcon;
        if (!it) continue;
        it.visible = e.isIntersecting;
        if (it.visible) { it.dirty = true; kick(); }
      }
    }) : null;
  }
  sight?.observe(ic.el);
};
let forced = null; // the preview's reduced-motion switch; null follows the system
const reduceQuery = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const reducedNow = () => forced ?? !!reduceQuery()?.matches;

function kick() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  let more = false;
  for (const ic of live) {
    if (!ic.el.isConnected) {
      // Gone from the page (or never put there): let it go.
      if (ic.seen || ++ic.unseen > 600) { live.delete(ic); sight?.unobserve(ic.el); }
      else more = true;
      continue;
    }
    if (!ic.seen) { ic.seen = true; ic.palette = null; ic.dirty = true; } // its surface is known now
    // A morph or the success flourish runs out whether seen or not; a resting loop runs only on screen.
    const morphing = ic.model.moving(now);
    const moving = morphing || (ic.visible && !ic.model.reduced && LOOPS.has(ic.model.status(now)));
    if ((moving && ic.visible) || ic.dirty) { paint(ic, now); ic.dirty = false; }
    ic.label(ic.model.status(now));
    if (moving) more = true;
  }
  if (more) kick();
}

function repaintAll() { for (const ic of live) ic.dirty = true; kick(); }
function restill() {
  const now = performance.now(), r = reducedNow();
  for (const ic of live) {
    ic.model.reduced = r;
    if (r) ic.model.set(ic.model.status(now), now);
  }
  repaintAll();
}
// The design system changed (theme.js says so, or its stylesheet was swapped), or light and dark did:
// every icon reads its colours again.
function recolour() { paletteEpoch++; repaintAll(); }

// The preview's switch: true or false forces reduced motion on or off; null follows the system.
export function setReducedMotion(on) { forced = on; restill(); }

let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  reduceQuery()?.addEventListener?.('change', restill);
  globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', recolour);
  globalThis.addEventListener?.('nova:appearance', recolour);
  if (typeof MutationObserver === 'function') new MutationObserver(recolour).observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener('visibilitychange', kick);
}

// statusIcon({ status, size }) → a <span role="img"> holding the mark as inline SVG, with
// el.setStatus(next). `label(status)` gives the words it says (the status itself if not given); a
// `decorative` one says nothing (aria-hidden), for a place whose own name or text already says the
// state. An icon taken off the page and put back is woken by setStatus (its own status wakes it
// unchanged).
export function statusIcon({ status = 'idle', size = 24, label = null, decorative = false } = {}) {
  known(status);
  const px = Number(size);
  if (!(px > 0)) throw new TypeError(`Bad size: ${String(size)}`);
  watch();
  const el = document.createElement('span');
  el.className = 'status-icon';
  if (decorative) el.setAttribute('aria-hidden', 'true');
  else el.setAttribute('role', 'img');
  // The mark, plus hidden stops that only resolve its colours where it is (palette).
  const refs = `<linearGradient data-refs>${REFS.map(([n, v]) => `<stop data-ref="${n}" style="stop-color:${v}"/>`).join('')}</linearGradient>`;
  el.innerHTML = markSvg({ size: px }).replace('<defs>', `<defs>${refs}`);
  const svg = el.firstElementChild;
  const ic = {
    el, model: new StatusModel(status, performance.now()), dirty: false, seen: false, unseen: 0, visible: true,
    grads: [...svg.querySelectorAll('radialGradient')], stops: [...svg.querySelectorAll('stop[data-stop]')], refs: svg.querySelectorAll('stop[data-ref]'),
    body: svg.querySelector('[data-mark-body]'), palette: null, paletteEpoch: -1,
    label(s) {
      if (el.dataset.status === s) return;
      el.dataset.status = s;
      if (decorative) return;
      const words = label ? label(s) : s;
      el.setAttribute('aria-label', words);
      el.title = words;
    },
  };
  ic.model.reduced = reducedNow();
  ic.label(status);
  el.dataset.renderer = 'svg';
  el.statusIcon = ic;
  el.setStatus = (next) => {
    ic.model.set(known(next), performance.now());
    ic.label(next);
    ic.dirty = true;
    if (!live.has(ic)) { ic.seen = false; ic.unseen = 0; live.add(ic); watchSight(ic); }
    kick();
  };
  Object.defineProperty(el, 'status', { get: () => ic.model.status(performance.now()) });
  live.add(ic);
  watchSight(ic);
  ic.dirty = true;
  kick();
  return el;
}
