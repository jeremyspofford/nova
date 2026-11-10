// The agent status icon: Nova's mark, the owner's artwork (docs/builder-packet/ui-references/
// nova-mark-artwork-not-code-amendment-2026-11-08.md), with each state a TREATMENT of it, never new
// geometry (nova-single-mark-n-direction-2026-11-08.md): a palette shift, brightness, and motion
// (a twirl round the black core, a radial pulse). One shared offscreen WebGL context samples the
// artwork as a mipmapped texture, so 16 px is a prefiltered downscale of the same picture as 180 px,
// and copies into each instance's own 2D canvas; Canvas2D draws the artwork with composited tints if
// WebGL isn't there. Colours come from the design system's tokens, read at runtime.
// The artwork itself is the page's: an <img data-nova-mark> in its markup (ui/index.html and
// styleguide.html load /icons/mark.svg, the master unchanged on a transparent background; pair.html
// carries a 256 px downscale inline). This file only draws what is already on the page; it loads
// nothing (it is served before pairing on that condition: tests/public-status-icon.test.js).
// The model (StatusModel, stateTreatment) is pure and unit-tested (tests/status-icon.test.js).

export const STATUS_ICON_STATES = Object.freeze(['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline']);
// Owner, 2026-11-08: 400 ms read as too fast and acute; a change takes 800 ms on a soft ease-in-out.
export const MORPH_MS = 800;
// success is a flourish, never a resting state: it settles to idle by itself.
export const SUCCESS_MS = 1800; // the 800 ms change in, its sweep, then about a second shown
const SWEEP_MS = 1000;
// Where the artwork's vortex turns and where its black core is, as fractions of the master
// (ui/icons/mark-master-1024.png: the largest disc at its centre that stays under luminance 16 is
// centred at 480, 504 px with a radius of 63 px).
const CORE = [0.4688, 0.4922];
const CORE_BLACK = [0.4688, 0.4922, 0.06]; // the darkest disc: centre and radius, kept black
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

// ---- the treatments: what each state does to the artwork (the owner's state table) ---------------

// A wave that eases in and out by itself, and a 0 → 1 → 0 swell over one period.
const sway = (t, period) => Math.sin((TAU * t) / period);
const swell = (t, period) => (1 - Math.cos((TAU * t) / period)) / 2;

// stateTreatment(status, t) → how the artwork is drawn in that state at time t (seconds; 0 when
// motion is reduced): twirl (radians round the core), pulse (radial: > 0 draws inward, < 0 outward),
// hue (radians of palette churn), tint ('cyan' | 'amber' | 'red' | null) and how much, saturation
// and brightness. Paused, stopped and offline don't depend on t: they are frozen.
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

// ---- rendering (browser only below) --------------------------------------------------------------

const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes, uCore;
uniform vec3 uBlack, uTint;
uniform float uTwirl, uPulse, uTintAmt, uSat, uBright, uHue, uSweep, uSweepAmt;
vec3 hue(vec3 c, float h) {
  vec3 yiq = mat3(.299, .596, .211, .587, -.274, -.523, .114, -.322, .312) * c;
  float cs = cos(h), sn = sin(h);
  yiq.yz = mat2(cs, sn, -sn, cs) * yiq.yz;
  return mat3(1., 1., 1., .956, -.272, -1.106, .621, -.647, 1.703) * yiq;
}
void main() {
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
  vec2 d = uv - uCore;
  float r = length(d);
  // Motion moves where the artwork is read from, never what it is: a twirl that is strongest at the
  // core and gone before the tile's frame, and a radial pulse inside the vortex.
  float a = uTwirl * exp(-r / .22) * (1. - smoothstep(.36, .46, r));
  d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d;
  d *= 1. + uPulse * (1. - smoothstep(.3, .46, r));
  vec4 tex = texture2D(uTex, uCore + d);
  vec3 col = tex.a > 0. ? tex.rgb / tex.a : vec3(0.);
  col = clamp(hue(col, uHue), 0., 1.);
  float lum = dot(col, vec3(.3, .59, .11));
  // A tint is a gradient map onto the token's colour: black stays black, light stays light.
  vec3 mapped = uTint * smoothstep(0., .6, lum) * 1.25 + vec3(smoothstep(.6, 1., lum) * .35);
  col = mix(col, mapped, uTintAmt);
  lum = dot(col, vec3(.3, .59, .11));
  col = mix(vec3(lum), col, uSat) * uBright;
  // Success: a band of light sweeping across, lighting the ribbons and not the dark between them.
  float band = exp(-pow((uv.x + uv.y) * .5 - uSweep, 2.) / .008);
  col += band * uSweepAmt * .7 * smoothstep(.03, .25, lum);
  // The core stays black under every treatment.
  col *= smoothstep(uBlack.z * .8, uBlack.z * 1.15, distance(uv, uBlack.xy));
  gl_FragColor = vec4(clamp(col, 0., 1.) * tex.a, tex.a);
}`;

let gl; // undefined: not tried; null: unavailable
let glCanvas, loc, tex, texOf;
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
    loc = Object.fromEntries(['uTex', 'uRes', 'uCore', 'uBlack', 'uTint', 'uTwirl', 'uPulse', 'uTintAmt', 'uSat', 'uBright', 'uHue', 'uSweep', 'uSweepAmt'].map((u) => [u, g.getUniformLocation(prog, u)]));
    glCanvas.addEventListener('webglcontextlost', () => { gl = null; });
    gl = g;
  } catch { gl = null; }
  return gl;
}

// The artwork: the page's own <img data-nova-mark>, once it has loaded. Until then an icon draws
// nothing, and every icon is redrawn when it arrives.
let waitingFor = null;
function artwork() {
  const img = document.querySelector('img[data-nova-mark]');
  if (img?.complete && img.naturalWidth > 0) return img;
  if (img && waitingFor !== img) {
    waitingFor = img;
    img.addEventListener('load', () => { for (const ic of live) ic.dirty = true; kick(); }, { once: true });
  }
  return null;
}

// The artwork as a texture, mipmapped (it is 1024 px square) so every size is a prefiltered downscale.
function texture(g, img) {
  if (texOf === img) return tex;
  tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img);
  const pot = (n) => (n & (n - 1)) === 0;
  const mip = pot(img.naturalWidth) && pot(img.naturalHeight);
  if (mip) g.generateMipmap(g.TEXTURE_2D);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, mip ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  texOf = img;
  return tex;
}

// Token colours, parsed once per distinct value: the tints the state table names.
const TOKENS = { cyan: '--orb-core', amber: '--orb-attention', red: '--status-error' };
let parser, lastKey, lastTints;
function rgb(value) {
  parser ??= document.createElement('canvas').getContext('2d');
  parser.fillStyle = value;
  const v = String(parser.fillStyle);
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return (v.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map((x) => Number(x) / 255);
}
function tints() {
  const style = getComputedStyle(document.documentElement);
  const raw = Object.fromEntries(Object.entries(TOKENS).map(([k, name]) => [k, style.getPropertyValue(name).trim()]));
  const key = Object.values(raw).join('|');
  if (key !== lastKey) { lastKey = key; lastTints = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, rgb(v)])); }
  return lastTints;
}

function paint(ic, now, colours) {
  const { canvas, model } = ic;
  const t = model.reduced ? 0 : now / 1000;
  const tr = blend(model.weights(now), t, colours);
  // The success sweep runs once across its first second, unless motion is reduced.
  const since = now - model.start;
  tr.sweep = model.to === 'success' && !model.reduced && since < SWEEP_MS ? -0.3 + 1.6 * (since / SWEEP_MS) : -9;
  tr.sweepAmt = tr.sweep > -9 ? 1 : 0;
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const img = artwork();
  if (!img) { ic.el.dataset.renderer = 'waiting'; return; }
  const g = webgl();
  try {
    if (g) { shade(g, ctx, size, img, tr); ic.el.dataset.renderer = 'webgl'; return; }
  } catch {
    gl = null; // a context that fails mid-draw: draw with Canvas2D from now on
  }
  ic.el.dataset.renderer = 'canvas2d';
  composite(ctx, size, img, tr);
}

function shade(g, ctx, size, img, tr) {
  // Big enough both ways (a fresh canvas is 300 × 150, so checking the width alone clipped any icon
  // drawn more than 150 px tall).
  if (glCanvas.width < size || glCanvas.height < size) glCanvas.width = glCanvas.height = Math.max(size, glCanvas.width, glCanvas.height);
  g.viewport(0, 0, size, size);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, texture(g, img));
  g.uniform1i(loc.uTex, 0);
  g.uniform2f(loc.uRes, size, size);
  g.uniform2f(loc.uCore, CORE[0], CORE[1]);
  g.uniform3f(loc.uBlack, CORE_BLACK[0], CORE_BLACK[1], CORE_BLACK[2]);
  g.uniform3fv(loc.uTint, tr.tint);
  for (const [u, v] of [['uTwirl', tr.twirl], ['uPulse', tr.pulse], ['uTintAmt', tr.tintAmt], ['uSat', tr.sat], ['uBright', tr.bright], ['uHue', tr.hue], ['uSweep', tr.sweep], ['uSweepAmt', tr.sweepAmt]]) g.uniform1f(loc[u], v);
  g.drawArrays(g.TRIANGLES, 0, 3);
  ctx.drawImage(glCanvas, 0, glCanvas.height - size, size, size, 0, 0, size, size);
}

// No WebGL: the artwork, downscaled by halving (so small sizes aren't aliased), with the state's
// saturation, tint and brightness composited over it. Still, but every state still reads.
const halves = new Map();
function downscaled(img, size) {
  const key = `${size}`;
  if (halves.get('img') !== img) { halves.clear(); halves.set('img', img); }
  if (halves.has(key)) return halves.get(key);
  let c = img, w = img.naturalWidth;
  while (w / 2 >= size) {
    const h = document.createElement('canvas');
    h.width = h.height = Math.round(w / 2);
    const g = h.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, h.width, h.height);
    c = h; w = h.width;
  }
  halves.set(key, c);
  return c;
}
function composite(ctx, size, img, tr) {
  const art = downscaled(img, size);
  const grey = (v) => { const n = Math.round(Math.min(1, Math.max(0, v)) * 255); return `rgb(${n} ${n} ${n})`; };
  const fill = (op, colour, alpha) => { ctx.globalCompositeOperation = op; ctx.globalAlpha = alpha; ctx.fillStyle = colour; ctx.fillRect(0, 0, size, size); };
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art, 0, 0, size, size);
  if (tr.sat < 0.99) fill('saturation', grey(0.5), Math.min(1, 1 - tr.sat));
  if (tr.tintAmt > 0.01) fill('color', `rgb(${tr.tint.map((v) => Math.round(v * 255)).join(' ')})`, Math.min(1, tr.tintAmt));
  if (tr.bright < 0.99) fill('multiply', grey(tr.bright), 1);
  else if (tr.bright > 1.01) fill('screen', grey(tr.bright - 1), 1);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in'; // back to the artwork's own shape
  ctx.drawImage(art, 0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
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
  const colours = tints();
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
    if ((moving && ic.visible) || ic.dirty) { paint(ic, now, colours); ic.dirty = false; }
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
    el, canvas, model: new StatusModel(status, performance.now()), dirty: false, seen: false, unseen: 0, visible: true,
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
  paint(ic, performance.now(), tints());
  kick();
  return el;
}
