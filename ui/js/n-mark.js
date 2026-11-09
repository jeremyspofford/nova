// The supernova N (owner direction 2026-11-08, docs/builder-packet/ui-references/
// nova-single-mark-n-direction-2026-11-08.md), step 1: still compositions of ONE mark for Nova, in
// three constructions for the owner to choose from. Black in the middle (a true void); the nebula's
// colours form the N, two uprights and a diagonal as accretion ribbons round the core. No type, no
// face. Nothing here is wired into the app: the live status icon (status-icon.js) is unchanged.
//
// The material is the shipped status icon's: the same tube shading, nebula ramp along the ribbon,
// speckle and glow, through the same one shared WebGL context (status-icon.js shadeRibbon), with
// its Canvas2D fallback. The shapes (nMarkShape, ribbonPasses) are pure and unit-tested
// (tests/n-mark.test.js).

import { RIBBON_POINTS, SMALL_MAX, ribbonPalette, shadeRibbon } from './status-icon.js';

export const N_MARK_VARIANTS = Object.freeze([
  Object.freeze({ id: 'accretion', letter: 'A', name: 'Accretion N', about: 'Three ribbons. The diagonal runs straight into a soft black core and thins as it falls in; each upright hooks toward the core at its free end.' }),
  Object.freeze({ id: 'swirl', letter: 'B', name: 'Swirl N', about: 'One continuous ribbon: up the left upright, a full vortex turn round the core as the diagonal, out and up the right upright. The closest to the original swirl.' }),
  Object.freeze({ id: 'eclipse', letter: 'C', name: 'Eclipse N', about: 'A crisp geometric N of three thick nebula strokes; the core is a black disc where the diagonal crosses the centre, ringed by a thin bright event horizon.' }),
]);
const IDS = N_MARK_VARIANTS.map((v) => v.id);
const known = (variant) => {
  if (!IDS.includes(variant)) throw new TypeError(`Unknown N mark: ${String(variant)}`);
  return variant;
};

// ---- the shapes: [x, y, half-width, u] in [-1, 1], y up; u runs the nebula ramp ------------------
// (0 deep space, 0.2 blue-teal, 0.4 violet, 0.6 magenta, 0.8 coral, 1 amber: cool outside, hot at the heart)

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;
const polar = (a, r, w, u) => [r * Math.cos(deg(a)), r * Math.sin(deg(a)), w, u];

// A smooth ribbon through control points (Catmull-Rom on all four values), resampled to n points:
// evenly by length, with more points where it turns, so a curve stays round on a fixed budget.
export function spline(ctrl, n) {
  const dense = [];
  const at = (i) => ctrl[Math.min(ctrl.length - 1, Math.max(0, i))];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < 48; k++) {
      const t = k / 48, t2 = t * t, t3 = t2 * t;
      dense.push(p1.map((_, j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  dense.push([...ctrl.at(-1)]);
  const m = [0];
  for (let i = 1; i < dense.length; i++) {
    const [a, b] = [dense[i - 1], dense[i]];
    const ds = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const prev = i > 1 ? Math.atan2(a[1] - dense[i - 2][1], a[0] - dense[i - 2][0]) : null;
    const turn = prev === null ? 0 : Math.abs(((Math.atan2(b[1] - a[1], b[0] - a[0]) - prev + 3 * Math.PI) % TAU) - Math.PI);
    m.push(m[i - 1] + ds + 0.22 * turn);
  }
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (m.at(-1) * k) / (n - 1);
    while (j < m.length - 2 && m[j + 1] < target) j++;
    const f = m[j + 1] > m[j] ? Math.min(1, (target - m[j]) / (m[j + 1] - m[j])) : 0;
    // The ends land exactly on their control points, so ribbons that share a joint meet.
    const p = k === n - 1 ? [...ctrl.at(-1)] : dense[j].map((v, c) => v + (dense[j + 1][c] - v) * f);
    p[2] = Math.max(0.012, p[2]);
    p[3] = Math.min(1, Math.max(0, p[3]));
    out.push(p);
  }
  return out;
}
const line = (a, b, n) => Array.from({ length: n }, (_, k) => a.map((v, j) => v + (b[j] - v) * (k / (n - 1))));

// A: matter falling into the hole. Small sizes drop the hooks and keep the strokes thick.
function accretion(small) {
  const X = small ? 0.58 : 0.6, Y = small ? 0.7 : 0.72, W = small ? 0.2 : 0.16;
  // Each upright's free end hooks round toward the core and thins, hot at its tip.
  const left = small
    ? line([-X, -Y, W, 0.08], [-X, Y, W, 0.3], 4)
    : spline([[-0.17, -0.42, 0.025, 0.8], [-0.22, -0.62, 0.07, 0.55], [-0.38, -0.76, 0.12, 0.3], [-0.56, -0.66, W, 0.14], [-X, -0.36, W, 0.08], [-X, 0.2, W, 0.16], [-X, Y, W, 0.3]], 14);
  const right = small
    ? line([X, -Y, W, 0.58], [X, Y, W, 0.44], 4)
    : spline([[0.17, 0.42, 0.025, 0.95], [0.22, 0.62, 0.07, 0.75], [0.38, 0.76, 0.12, 0.56], [0.56, 0.66, W, 0.48], [X, 0.36, W, 0.46], [X, -0.2, W, 0.5], [X, -Y, W, 0.58]], 14);
  // The diagonal: broad at its corners, narrowing and heating as it falls into the hole.
  const diagonal = small
    ? line([-X, Y, W, 0.3], [0, 0, 0.13, 0.95], 4).concat(line([0, 0, 0.13, 0.95], [X, -Y, W, 0.58], 4).slice(1))
    : spline([[-X, Y, W, 0.3], [-0.36, 0.43, 0.14, 0.55], [-0.17, 0.2, 0.09, 0.85], [0, 0, 0.04, 1], [0.17, -0.2, 0.09, 0.9], [0.36, -0.43, 0.14, 0.7], [X, -Y, W, 0.58]], 16);
  return {
    strokes: [{ name: 'left', points: left }, { name: 'diagonal', points: diagonal }, { name: 'right', points: right }],
    continuous: false,
    core: { r: small ? 0.22 : 0.2, soft: small ? 0.05 : 0.12, over: true },
    rim: null,
  };
}

// B: one ribbon, a full vortex turn round the core. Small sizes turn half as far, with a broader ribbon.
function swirl(small) {
  // Small: the same path with the turn cut to a tight bow over the core, clear of the right upright.
  const X = 0.66;
  const left = small
    ? [[-X, -0.76, 0.1, 0.04], [-X, -0.2, 0.16, 0.1], [-X, 0.36, 0.17, 0.2], [-0.58, 0.66, 0.17, 0.28]]
    : [[-0.62, -0.78, 0.06, 0.02], [-0.65, -0.4, 0.15, 0.08], [-0.65, 0.25, 0.18, 0.18], [-0.6, 0.6, 0.18, 0.27]];
  const turn = small
    ? [[-0.58, 0.66, 0.17, 0.28], [-0.42, 0.72, 0.16, 0.34], [-0.22, 0.5, 0.13, 0.5], polar(50, 0.33, 0.11, 0.8), polar(0, 0.3, 0.11, 0.95), polar(-50, 0.36, 0.12, 0.75), [0.52, -0.66, 0.16, 0.58]]
    // Broad and cool where it leaves the corner, spiralling in (fine and hot) for more than a turn,
    // then thrown out across its own outer arm to the far corner: the twist.
    : [[-0.6, 0.6, 0.18, 0.27], [-0.46, 0.75, 0.17, 0.32], [-0.26, 0.64, 0.17, 0.38],
      polar(115, 0.57, 0.16, 0.42), polar(75, 0.55, 0.15, 0.47), polar(30, 0.52, 0.14, 0.52), polar(-15, 0.48, 0.12, 0.58), polar(-60, 0.43, 0.1, 0.64),
      polar(-105, 0.38, 0.085, 0.7), polar(-150, 0.34, 0.07, 0.78), polar(-195, 0.31, 0.055, 0.86), polar(-240, 0.29, 0.045, 0.94), polar(-285, 0.29, 0.045, 1),
      polar(-330, 0.31, 0.06, 0.95), polar(-368, 0.39, 0.09, 0.85), [0.45, -0.5, 0.14, 0.7], [0.6, -0.7, 0.17, 0.6]];
  const right = small
    ? [[0.52, -0.66, 0.16, 0.58], [X, -0.42, 0.17, 0.54], [X, 0.2, 0.16, 0.48], [X, 0.76, 0.1, 0.42]]
    : [[0.6, -0.7, 0.17, 0.6], [0.66, -0.3, 0.18, 0.53], [0.66, 0.3, 0.15, 0.46], [0.62, 0.78, 0.06, 0.4]];
  const n = small ? [6, 12, 6] : [8, 38, 8];
  return {
    strokes: [{ name: 'left', points: spline(left, n[0]) }, { name: 'diagonal', points: spline(turn, n[1]) }, { name: 'right', points: spline(right, n[2]) }],
    continuous: true,
    core: { r: small ? 0.16 : 0.22, soft: 0.06, over: false },
    rim: null,
  };
}

// C: the legible one. Straight strokes, a black disc over the crossing, a thin bright horizon.
function eclipse(small) {
  const X = small ? 0.56 : 0.6, Y = small ? 0.68 : 0.72, W = small ? 0.2 : 0.16;
  const R = small ? 0.24 : 0.25, D = W * 0.94;
  // The diagonal heats as it nears the disc: cool at its corners, coral at the horizon.
  const k = R / Math.hypot(X, Y);
  const edge = (s) => [s * X * k, -s * Y * k];
  return {
    strokes: [
      { name: 'left', points: line([-X, -Y, W, 0.06], [-X, Y, W, 0.3], 4) },
      { name: 'diagonal', points: [[-X, Y, D, 0.3], [...edge(-1), D, 0.86], [0, 0, D, 1], [...edge(1), D, 0.86], [X, -Y, D, 0.6]] },
      { name: 'right', points: line([X, -Y, W, 0.6], [X, Y, W, 0.44], 4) },
    ],
    continuous: false,
    core: { r: R, soft: 0.015, over: true },
    rim: { r: small ? 0.29 : 0.275, w: small ? 0.055 : 0.024, u: 0.96 },
  };
}

export function nMarkShape(variant, small = false) {
  switch (known(variant)) {
    case 'accretion': return accretion(small);
    case 'swirl': return swirl(small);
    default: return eclipse(small);
  }
}

// The shape as the shader takes it: passes of RIBBON_POINTS points of [x, y, half-width, u, link].
// Separate strokes never split across passes. A continuous ribbon is one stroke, its joints shared;
// longer than a pass, it runs on into the next pass from the point the last one ended on.
export function ribbonPasses(shape) {
  let strokes = shape.strokes.map((s) => s.points);
  if (shape.continuous) {
    const all = shape.strokes.flatMap((s, i) => (i ? s.points.slice(1) : s.points));
    strokes = [];
    for (let i = 0; i < all.length - 1; i += RIBBON_POINTS - 1) strokes.push(all.slice(i, i + RIBBON_POINTS));
  }
  const passes = [];
  let cur = null, used = 0;
  for (const pts of strokes) {
    if (pts.length > RIBBON_POINTS) throw new RangeError(`A stroke of ${pts.length} points is longer than one pass (${RIBBON_POINTS})`);
    if (!cur || used + pts.length > RIBBON_POINTS) { cur = new Float32Array(RIBBON_POINTS * 5); passes.push(cur); used = 0; }
    pts.forEach((p, j) => cur.set([p[0], p[1], p[2], p[3], j ? 1 : 0], (used + j) * 5));
    used += pts.length;
  }
  return passes;
}
// The event horizon: a closed ring, one pass of its own.
export function rimPass({ r, w, u }) {
  const out = new Float32Array(RIBBON_POINTS * 5);
  for (let j = 0; j < RIBBON_POINTS; j++) {
    const a = (j / (RIBBON_POINTS - 1)) * TAU + deg(135);
    out.set([r * Math.cos(a), r * Math.sin(a), w, u - 0.1 + 0.1 * Math.cos(a - deg(135)), j ? 1 : 0], j * 5);
  }
  return out;
}

// ---- drawing (browser only below) ----------------------------------------------------------------

// The void: true black to r, fading out over `soft`. Black in any theme: it is the absence of light,
// not a surface colour.
const VOID = [0, 0, 0];
function core(ctx, size, { r, soft }) {
  const s = size / 2;
  const g = ctx.createRadialGradient(s, s, 0, s, s, (r + soft) * s);
  const at = r / (r + soft);
  g.addColorStop(0, css(VOID));
  g.addColorStop(at, css(VOID));
  g.addColorStop(Math.min(1, at + (1 - at) * 0.5), css(VOID, 0.55));
  g.addColorStop(1, css(VOID, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s, s, (r + soft) * s, 0, TAU);
  ctx.fill();
}

function drawMark(ctx, size, variant, small) {
  const shape = nMarkShape(variant, small);
  let renderer = 'canvas2d';
  if (!shape.core.over) core(ctx, size, shape.core);
  for (const pass of ribbonPasses(shape)) renderer = shadeRibbon(ctx, size, pass, { small });
  if (shape.core.over) core(ctx, size, shape.core);
  if (shape.rim) shadeRibbon(ctx, size, rimPass(shape.rim), { small });
  return renderer;
}

const css = (c, a = 1) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(' ')} / ${a})`;
// The app-icon tile: a rounded square of deep space (the ramp's darkest stop, near black), a few
// faint stars, and the mark inset in it.
function tileGround(ctx, size) {
  const [stops] = ribbonPalette('idle');
  const deep = stops[0];
  const r = size * 0.2237;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  const g = ctx.createRadialGradient(size / 2, size * 0.42, 0, size / 2, size / 2, size * 0.72);
  g.addColorStop(0, css(deep.map((v) => v * 0.42)));
  g.addColorStop(1, css(deep.map((v) => v * 0.16)));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 46; i++) {
    const x = rand() * size, y = rand() * size, a = 0.15 + rand() * 0.45;
    ctx.fillStyle = css(stops[1].map((v) => 0.75 + v * 0.25), a);
    ctx.fillRect(x, y, Math.max(1, size / 260), Math.max(1, size / 260));
  }
  ctx.restore();
}

// nMark({ variant, size }) → a <span role="img" aria-label="Nova"> holding one still canvas.
// `tile` draws it as the app icon: the mark inset in a rounded square of deep space.
export function nMark({ variant = 'accretion', size = 48, tile = false, label = 'Nova' } = {}) {
  known(variant);
  const px = Number(size);
  if (!(px > 0)) throw new TypeError(`Bad size: ${String(size)}`);
  const el = document.createElement('span');
  el.className = 'n-mark';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.dataset.variant = variant;
  el.dataset.size = String(px);
  const canvas = document.createElement('canvas');
  const scale = Math.min(3, Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1)));
  const full = Math.round(px * scale);
  canvas.width = canvas.height = full;
  canvas.style.width = canvas.style.height = `${px}px`;
  canvas.setAttribute('aria-hidden', 'true');
  el.append(canvas);
  const ctx = canvas.getContext('2d');
  const small = px <= SMALL_MAX;
  if (!tile) {
    el.dataset.renderer = drawMark(ctx, full, variant, small);
    return el;
  }
  tileGround(ctx, full);
  const inner = Math.round(full * 0.84);
  const off = document.createElement('canvas');
  off.width = off.height = inner;
  el.dataset.renderer = drawMark(off.getContext('2d'), inner, variant, small);
  ctx.drawImage(off, (full - inner) / 2, (full - inner) / 2);
  return el;
}
