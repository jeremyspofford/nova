// The agent status icon (owner spec 2026-11-08, docs/builder-packet/ui-references/
// nova-agent-status-icon-builder-prompt-2026-11-08.md; art: nova-agent-state-system-sheet-2026-11-08.jpg).
// One iridescent ribbon, reshaped per state. Every state is a ribbon of N points (x, y, half-width,
// gradient position, link to the previous point), so a morph interpolates the same points, and a
// change mid-morph starts from the form on screen. One shared offscreen WebGL context shades every
// instance and copies into each instance's own 2D canvas; Canvas2D strokes the same points if WebGL
// isn't there. Colours are the design system's tokens, read at runtime, so any theme maps the states.
// The model (StatusModel, statusForm) is pure and unit-tested (tests/status-icon.test.js).

export const STATUS_ICON_STATES = Object.freeze(['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline']);
// Owner, 2026-11-08: 400 ms read as too fast and acute; a morph takes 800 ms on a soft ease-in-out.
export const MORPH_MS = 800;
// success is a flourish, never a resting state: it settles to idle by itself.
export const SUCCESS_MS = 1800; // the 800 ms morph in, then about a second shown
export const SMALL_MAX = 24;
const N = 36;
const EXTENT = 1; // the canvas shows [-EXTENT, EXTENT]; forms fill about 90% of it, the glow the rest
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

// ---- the forms: N points of [x, y, half-width, u, link] in [-1, 1], y up -------------------------

function stroke(out, i0, n, at) {
  for (let j = 0; j < n; j++) {
    const s = j / (n - 1);
    const [x, y, w, u = s] = at(s);
    out.set([x, y, w, u, j ? 1 : 0], (i0 + j) * 5);
  }
}
// An arm of the swirl: from r0 (inner, a fine tip) to r1 (outer, broad); warm at the heart, cool outside.
// taper < 1 swells the ribbon early, so most of its length is broad.
const arm = ({ a0, span, r0, r1, w0, w1, taper = 1 }) => (s) => {
  const a = a0 - span * (1 - s);
  const r = r0 + (r1 - r0) * s;
  return [r * Math.cos(a), r * Math.sin(a), w0 + (w1 - w0) * s ** taper, 1 - s];
};
const ring = (r, w, a0 = 0) => (s) => [r * Math.cos(a0 + s * TAU), r * Math.sin(a0 + s * TAU), w, 0.5 - 0.5 * Math.cos(TAU * s)];
// A straight-ish stroke with a width profile along it.
const bend = (ax, ay, bx, by, k, width) => (s) => {
  const x = ax + (bx - ax) * s, y = ay + (by - ay) * s, b = k * Math.sin(Math.PI * s);
  return [x - (by - ay) * b, y + (bx - ax) * b, width(s)];
};
// Loops ease in and out: each period turns by `step` and comes to rest, never a linear spin.
const soft = (x) => (1 - Math.cos(Math.PI * x)) / 2;
const turn = (t, period, step) => step * (Math.floor(t / period) + soft((t / period) % 1));

// The idle swirl, the owner's supernova N: two broad lobes in opposite corners, joined by a diagonal
// sweep that curls round a dark heart. Stretched along the upper-left to lower-right diagonal.
function swirl(out, t, small, { scale = 1, thin = 1, from = 0, n = N / 2 } = {}) {
  const shape = small
    ? { span: 1.1 * Math.PI, r0: 0.26, r1: 0.6, w0: 0.1, w1: 0.2 }
    : { span: 1.2 * Math.PI, r0: 0.17, r1: 0.55, w0: 0.05, w1: 0.36, taper: 0.45 };
  const rot = turn(t, 10, Math.PI); // two-fold, so half a turn per period is seamless
  for (let k = 0; k < 2; k++) {
    const at = arm({ a0: rot + k * Math.PI + (3 * Math.PI) / 4, ...shape });
    stroke(out, from + k * n, n, (s) => {
      const [x, y, w, u] = at(s);
      const along = (x - y) / Math.SQRT2 * 1.12, across = (x + y) / Math.SQRT2 * 0.9;
      return [((along + across) / Math.SQRT2) * scale, ((across - along) / Math.SQRT2) * scale, w * scale * thin, u];
    });
  }
}

export function statusForm(status, t = 0, small = false) {
  const out = new Float32Array(N * 5);
  switch (known(status)) {
    case 'idle': swirl(out, t, small); break;
    case 'offline': swirl(out, 0, small, { scale: 0.9, thin: 0.8 }); break;
    case 'speaking': {
      // The idle swirl, smaller, with a ring easing outward from it.
      const k = soft((t / 1.6) % 1);
      swirl(out, t, small, { scale: 0.74, n: 9 });
      stroke(out, 18, 18, ring(t ? 0.78 + 0.12 * k : 0.86, t ? 0.07 * (1 - k) + 0.02 : 0.05));
      break;
    }
    case 'thinking':
      // One arm curling inward: a nautilus whose outer turn rides over the inner. A slow, eased turn.
      stroke(out, 0, N, small
        ? arm({ a0: turn(t, 7, TAU), span: 1.5 * Math.PI, r0: 0.2, r1: 0.66, w0: 0.1, w1: 0.22 })
        : arm({ a0: turn(t, 7, TAU), span: 2.1 * Math.PI, r0: 0.06, r1: 0.55, w0: 0.04, w1: 0.37, taper: 0.7 }));
      break;
    case 'working':
      // The thinking spiral's family: three broad blades round an open heart, a third of a turn at a time, briskly.
      for (let k = 0; k < 3; k++) stroke(out, k * 12, 12, arm({ a0: turn(t, 1.2, TAU / 3) + (k * TAU) / 3, span: 0.75 * Math.PI, r0: 0.26, r1: 0.64, w0: 0.08, w1: 0.26, taper: 0.7 }));
      break;
    case 'listening': {
      // A full orbit ring, tilted, broad on one side and fine on the other; the broad side slowly orbits.
      const g = turn(t, 8, TAU), tilt = 0.4;
      stroke(out, 0, N, (s) => {
        const a = s * TAU;
        const x = 0.68 * Math.cos(a), y = 0.44 * Math.sin(a);
        return [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt), 0.07 + 0.19 * (0.5 + 0.5 * Math.cos(a - g - 3.4)), 0.5 - 0.5 * Math.cos(a)];
      });
      break;
    }
    case 'needs-you': {
      // A rounded triangle ribbon, broadest at its lower left, gently beckoning.
      const z = 1 + 0.05 * Math.sin((t * TAU) / 1.8);
      stroke(out, 0, N, (s) => {
        const a = Math.PI / 2 + s * TAU;
        const tri = 0.4 / Math.cos(((((a - Math.PI / 2) % (TAU / 3)) + TAU / 3) % (TAU / 3)) - Math.PI / 3);
        const r = (tri * 0.8 + 0.1) * z;
        return [r * Math.cos(a), r * Math.sin(a) - 0.05, 0.15 + 0.07 * Math.cos(a - 3.6), 0.5 - 0.5 * Math.cos(TAU * s)];
      });
      break;
    }
    case 'success': {
      // A check drawn as one wave of ribbon, broad at its turn, fine at its tips; nebula, never green.
      const [a, b, c] = [[-0.66, 0.06], [-0.2, -0.46], [0.7, 0.6]];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]), m = l1 / (l1 + l2);
      stroke(out, 0, N, (s) => {
        const [p, q, k] = s < m ? [a, b, s / m] : [b, c, (s - m) / (1 - m)];
        return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, 0.07 + 0.22 * (1 - s) ** 0.6 * Math.min(1, s * 4)];
      });
      break;
    }
    case 'paused': {
      // Twin pillars, swollen at their ends and pinched at the waist.
      const width = (s) => 0.2 + 0.06 * Math.cos(TAU * s);
      stroke(out, 0, 18, bend(-0.34, 0.56, -0.34, -0.56, 0.06, width));
      stroke(out, 18, 18, bend(0.34, 0.56, 0.34, -0.56, 0.06, width));
      break;
    }
    case 'stopped': {
      // HALT: two heavy crossed ribbons, swung like a twist, broad lobes at the ends.
      const width = (s) => 0.32 - 0.1 * Math.sin(Math.PI * s);
      stroke(out, 0, 18, bend(-0.56, 0.56, 0.56, -0.56, 0.1, width));
      stroke(out, 18, 18, bend(0.56, 0.56, -0.56, -0.56, -0.1, width));
      break;
    }
  }
  if (small) {
    // Small sizes: the same silhouette, no hairlines, and no band so broad it closes the gaps
    // (stopped keeps its mass: it must read as a halt at 16 px).
    const cap = status === 'stopped' ? 0.28 : 0.22;
    for (let i = 0; i < N; i++) out[i * 5 + 2] = Math.min(Math.max(out[i * 5 + 2] * 1.25, 0.1), cap);
  } else {
    // Large sizes fill the tile, as the sheet's forms do.
    for (let i = 0; i < N * 5; i += 5) { out[i] *= 1.04; out[i + 1] *= 1.04; out[i + 2] *= 1.04; }
  }
  return out;
}

// ---- colour: six stops per state, derived from the design system's tokens -----------------------

const mixc = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const scalec = (a, k) => a.map((v) => v * k);
const LIGHT = [1, 1, 1];
const grey = (a, k) => { const l = a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11; return mixc(a, [l, l, l], k); };

// [stops, brightness] per state, from the five tokens the Nebula orb already defines.
export function statePalettes({ core, violet, coral, amber, red }) {
  const deep = scalec(mixc(core, violet, 0.35), 0.5);
  const magenta = mixc(violet, coral, 0.5);
  const nebula = [deep, core, violet, magenta, coral, amber];
  return {
    idle: [nebula, 0.92],
    speaking: [nebula, 1.1],
    offline: [nebula.map((c) => grey(c, 0.85)), 0.62],
    listening: [[deep, core, core, mixc(core, violet, 0.5), violet, magenta], 1],
    thinking: [[deep, deep, core, core, mixc(core, LIGHT, 0.3), violet], 0.98],
    working: [nebula, 1.05],
    'needs-you': [[magenta, amber, amber, coral, amber, mixc(amber, LIGHT, 0.2)], 1.05],
    success: [[violet, magenta, violet, core, mixc(core, LIGHT, 0.25), core], 1.1],
    paused: [[deep, violet, violet, magenta, magenta, violet], 0.95],
    stopped: [[scalec(red, 0.45), scalec(red, 0.75), red, red, scalec(red, 0.6), mixc(red, violet, 0.35)], 1],
  };
}

// ---- rendering (browser only below) --------------------------------------------------------------

const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 uP[${N}];
uniform vec4 uL[${N / 4}];
uniform vec3 uC[6];
uniform vec2 uRes;
uniform float uBright, uSmall;
vec3 pal(float t) {
  t = clamp(t, 0., 1.) * 5.;
  vec3 c = mix(uC[0], uC[1], clamp(t, 0., 1.));
  c = mix(c, uC[2], clamp(t - 1., 0., 1.));
  c = mix(c, uC[3], clamp(t - 2., 0., 1.));
  c = mix(c, uC[4], clamp(t - 3., 0., 1.));
  return mix(c, uC[5], clamp(t - 4., 0., 1.));
}
void main() {
  vec2 p = (gl_FragCoord.xy / uRes * 2. - 1.) * ${EXTENT.toFixed(2)};
  float aa = ${(2 * EXTENT).toFixed(2)} / uRes.x;
  float best = -1., cover = 0., edge = 9., bu = 0., bz = 0., layer = 0.;
  vec2 bn = vec2(0.);
  vec4 prev = uP[0];
  for (int q = 0; q < ${N / 4}; q++) {
    vec4 L = uL[q];
    for (int c = 0; c < 4; c++) {
      int i = q * 4 + c;
      vec4 cur = uP[q * 4 + c]; // GLSL ES 1.0 indexes uniforms by loop indices only
      float l = c == 0 ? L.x : c == 1 ? L.y : c == 2 ? L.z : L.w;
      if (l < .5) layer += 1.;
      if (i > 0 && l > 0.01) {
        vec2 pa = p - prev.xy, ba = cur.xy - prev.xy;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0., 1.);
        vec2 d = pa - ba * h;
        float w = max(mix(prev.z, cur.z, h) * l, 1e-4), r = length(d);
        edge = min(edge, r - w);
        float cv = clamp((w - r) / aa + .5, 0., 1.);
        if (cv > 0.) {
          float z = sqrt(max(0., 1. - r * r / (w * w)));
          float score = z + layer * 2.; // within a stroke the nearest wins; a later stroke passes over an earlier one
          if (score > best) { best = score; bu = mix(prev.w, cur.w, h); bn = d / w; bz = z; }
          cover = max(cover, cv);
        }
      }
      prev = cur;
    }
  }
  // A solid lit ribbon first, glow second: a body darker on its shadow side, a bright rim on the
  // edge facing the light, a soft sheen, and the colour running along the ribbon (u), not across it.
  vec3 base = pal(bu);
  float rr = length(bn), lit = clamp(dot(bn, normalize(vec2(-.6, .8))) * .5 + .5, 0., 1.);
  vec3 col = base * mix(mix(.42, 1.05, lit), .98, uSmall) * mix(.85, 1.1, bz); // small sizes: flat and bright, for legibility
  col += base * smoothstep(.5, .97, rr) * smoothstep(.45, 1., lit) * .9 * (1. - uSmall * .4);
  col += mix(base, vec3(1.), .3) * exp(-pow((rr - .4) / .14, 2.)) * lit * .2 * (1. - uSmall);
  float star = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
  col += step(.993, star) * .25 * bz * (1. - uSmall);
  col = mix(vec3(dot(col, vec3(.3, .59, .11))), col, 1.25); // toward the sheet's saturation
  col = clamp(col * uBright, 0., 1.);
  // A tight glow, fading out before the canvas edge so no square shows.
  float fade = 1. - smoothstep(.9, 1., max(abs(p.x), abs(p.y)));
  float glow = exp(-max(edge, 0.) * 26.) * mix(.24, .14, uSmall) * uBright * (1. - cover) * fade;
  gl_FragColor = vec4(col * cover + pal(.45) * glow, cover + glow);
}`;

let gl; // undefined: not tried; null: unavailable
let glCanvas, loc;
function webgl() {
  if (gl !== undefined) return gl;
  gl = null;
  try {
    glCanvas = document.createElement('canvas');
    const g = glCanvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!g) return null;
    const sh = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); return s; };
    const prog = g.createProgram();
    g.attachShader(prog, sh(g.VERTEX_SHADER, VERT));
    g.attachShader(prog, sh(g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) return null;
    g.useProgram(prog);
    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    loc = Object.fromEntries(['uP', 'uL', 'uC', 'uRes', 'uBright', 'uSmall'].map((u) => [u, g.getUniformLocation(prog, u)]));
    glCanvas.addEventListener('webglcontextlost', () => { gl = null; });
    gl = g;
  } catch { gl = null; }
  return gl;
}

// Token colours, parsed once per distinct value.
const TOKENS = { core: '--orb-core', violet: '--accent-secondary', coral: '--orb-listening', amber: '--orb-attention', red: '--status-error' };
let parser, lastKey, lastPalettes;
function rgb(value) {
  parser ??= document.createElement('canvas').getContext('2d');
  parser.fillStyle = value;
  const v = String(parser.fillStyle);
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return (v.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map((x) => Number(x) / 255);
}
function palettes() {
  const style = getComputedStyle(document.documentElement);
  const raw = Object.fromEntries(Object.entries(TOKENS).map(([k, name]) => [k, style.getPropertyValue(name).trim()]));
  const key = Object.values(raw).join('|');
  if (key !== lastKey) { lastKey = key; lastPalettes = statePalettes(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, rgb(v)]))); }
  return lastPalettes;
}

function paint(ic, now, pals) {
  const { canvas, model, small } = ic;
  const t = model.reduced ? 0 : now / 1000;
  const pts = new Float32Array(N * 5);
  const cols = Array.from({ length: 6 }, () => [0, 0, 0]);
  let bright = 0;
  for (const [s, k] of Object.entries(model.weights(now))) {
    if (k < 1e-3) continue;
    const f = statusForm(s, t, small);
    for (let i = 0; i < f.length; i++) pts[i] += f[i] * k;
    const [stops, b] = pals[s];
    stops.forEach((c, j) => { for (let x = 0; x < 3; x++) cols[j][x] += c[x] * k; });
    bright += b * k;
  }
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const g = webgl();
  try {
    if (g) { shade(g, ctx, size, pts, cols, bright, small); ic.el.dataset.renderer = 'webgl'; return; }
  } catch {
    gl = null; // a context that fails mid-draw: draw with Canvas2D from now on
  }
  ic.el.dataset.renderer = 'canvas2d';
  strokeFallback(ctx, size, pts, cols, bright);
}

function shade(g, ctx, size, pts, cols, bright, small) {
  if (glCanvas.width < size) glCanvas.width = glCanvas.height = size;
  g.viewport(0, 0, size, size);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  const p = new Float32Array(N * 4), l = new Float32Array(N);
  for (let i = 0; i < N; i++) { p.set(pts.subarray(i * 5, i * 5 + 4), i * 4); l[i] = pts[i * 5 + 4]; }
  g.uniform4fv(loc.uP, p);
  g.uniform4fv(loc.uL, l);
  g.uniform3fv(loc.uC, cols.flat());
  g.uniform2f(loc.uRes, size, size);
  g.uniform1f(loc.uBright, bright);
  g.uniform1f(loc.uSmall, small ? 1 : 0);
  g.drawArrays(g.TRIANGLES, 0, 3);
  ctx.drawImage(glCanvas, 0, glCanvas.height - size, size, size, 0, 0, size, size);
}

// No WebGL: the same ribbon, stroked flat with the same colours.
function strokeFallback(ctx, size, pts, cols, bright) {
  const at = (u) => { const t = Math.min(1, Math.max(0, u)) * 5, j = Math.min(4, Math.floor(t)); return mixc(cols[j], cols[j + 1], t - j).map((v) => Math.round(Math.min(1, v * bright) * 255)); };
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(size / 2 / EXTENT, -size / 2 / EXTENT);
  ctx.lineCap = 'round';
  for (let i = 1; i < N; i++) {
    const a = (i - 1) * 5, b = i * 5, link = pts[b + 4];
    if (link < 0.01) continue;
    ctx.lineWidth = (pts[a + 2] + pts[b + 2]) * link;
    ctx.strokeStyle = `rgb(${at((pts[a + 3] + pts[b + 3]) / 2).join(' ')})`;
    ctx.beginPath();
    ctx.moveTo(pts[a], pts[a + 1]);
    ctx.lineTo(pts[b], pts[b + 1]);
    ctx.stroke();
  }
  ctx.restore();
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
  const pals = palettes();
  let more = false;
  for (const ic of live) {
    if (!ic.el.isConnected) {
      // Gone from the page (or never put there): let it go.
      if (ic.seen || ++ic.unseen > 600) { live.delete(ic); sight?.unobserve(ic.el); }
      else more = true;
      continue;
    }
    ic.seen = true;
    // A morph or the success flourish runs out whether seen or not; a resting loop runs only on screen.
    const morphing = ic.model.moving(now);
    const moving = morphing || (ic.visible && !ic.model.reduced && LOOPS.has(ic.model.status(now)));
    if ((moving && ic.visible) || ic.dirty) { paint(ic, now, pals); ic.dirty = false; }
    ic.label(ic.model.status(now));
    if (moving) more = true;
  }
  if (more) kick();
}

function restill() {
  const now = performance.now(), r = reducedNow();
  for (const ic of live) {
    ic.model.reduced = r;
    if (r) ic.model.set(ic.model.status(now), now);
    ic.dirty = true;
  }
  kick();
}

// The preview's switch: true or false forces reduced motion on or off; null follows the system.
export function setReducedMotion(on) { forced = on; restill(); }

let watching = false;
// statusIcon({ status, size }) → a <span role="img"> holding one canvas, with el.setStatus(next).
// `label(status)` gives the words it says (the status itself if not given); a `decorative` one says
// nothing (aria-hidden), for a place whose own name or text already says the state.
// An icon taken off the page and put back is woken by setStatus (its own status wakes it unchanged).
export function statusIcon({ status = 'idle', size = 24, label = null, decorative = false } = {}) {
  known(status);
  const px = Number(size);
  if (!(px > 0)) throw new TypeError(`Bad size: ${String(size)}`);
  if (!watching) {
    watching = true;
    reduceQuery()?.addEventListener?.('change', restill);
    document.addEventListener('visibilitychange', kick);
  }
  const el = document.createElement('span');
  el.className = 'status-icon';
  if (decorative) el.setAttribute('aria-hidden', 'true');
  else el.setAttribute('role', 'img');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.round(px * Math.min(3, Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1))));
  canvas.style.width = canvas.style.height = `${px}px`;
  canvas.setAttribute('aria-hidden', 'true');
  el.append(canvas);
  const ic = {
    el, canvas, small: px <= SMALL_MAX, model: new StatusModel(status, performance.now()), dirty: false, seen: false, unseen: 0, visible: true,
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
  paint(ic, performance.now(), palettes());
  kick();
  return el;
}
