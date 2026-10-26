// The Stellar Map: Nova's memory as a place (Nova theme only). A view over the
// files: /api/map rebuilds it from the home folder, and every action here is
// the same action the Memory list offers.
//
// Drag pans (the far field, nebulae and bodies move at different rates, so
// dragging changes your perspective); scroll or pinch travels Galaxy → System
// → Orbit; click selects; double-click or Enter dives; Esc backs out one
// scale; ⌘K searches and flies there; arrow keys step along threads.
import { layout, orbitAt, radiusOf, bounds, ORBIT_TILT } from './layout.js';
import { createRenderer, TYPE } from './render.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const FAR_RATE = 0.14;     // the far field moves this fraction of the bodies (at galaxy scale)
const NEBULA_RATE = 0.96;  // nebulae, a little less than the bodies they sit behind
const IDLE_MS = 3000;      // chrome fades after this long without the pointer
const AMBIENT_FPS = 15;    // drift is a fraction of a pixel a second; this is plenty

// ---- colour, from tokens ---------------------------------------------------------
function parseColor(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = s.match(/rgba?\(([^)]+)\)/);
  if (m) return m[1].split(/[ ,/]+/).slice(0, 3).map((x) => Number(x) / 255);
  return [1, 1, 1];
}
function toHsl([r, g, b]) {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const shift = (c, dh, ds = 0, dl = 0) => { const [h, s, l] = toHsl(c); return fromHsl([(h + dh + 1) % 1, clamp(s + ds, 0, 1), clamp(l + dl, 0, 1)]); };
const mix = (a, b, t) => a.map((x, i) => lerp(x, b[i], t));
const unit = (seed, k) => { let x = (seed ^ (0x85ebca6b * (k + 1))) >>> 0; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const cssMs = (v, d) => { const m = String(v).trim().match(/^([\d.]+)(ms|s)$/); return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : d; };
function bezier(v) {
  const m = String(v).match(/cubic-bezier\(([^)]+)\)/);
  const [x1, y1, x2, y2] = m ? m[1].split(',').map(Number) : [0.22, 0.61, 0.21, 1];
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => { let lo = 0; let hi = 1; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (at(x1, x2, mid) < x) lo = mid; else hi = mid; } return at(y1, y2, (lo + hi) / 2); };
}

const KIND_NAMES = { agent: 'The Nova', person: 'Planet · Person', topic: 'Gas giant · Topic', goal: 'Star · Goal', memory: 'Moon · Note', file: 'Moon · Nova’s file', event: 'Comet · Recent day', orphan: 'Asteroid · Unconnected', stack: 'Gathered' };
const SCALES = ['Galaxy', 'System', 'Orbit'];

export function createStellarMap(root, hooks) {
  root.innerHTML = `
<canvas class="map-canvas" aria-hidden="true"></canvas>
<div class="map-vignette"></div>
<div class="map-labels" aria-hidden="true"></div>
<div class="map-hud map-title"><p class="map-kicker">Stellar Map</p><p class="map-scale"></p></div>
<div class="map-hud map-tools">
  <button type="button" class="map-tool" data-act="search" title="Search (⌘K)" aria-label="Search the map">Search <kbd>⌘K</kbd></button>
  <button type="button" class="map-tool" data-act="home" title="Back to Nova" aria-label="Fly home to Nova">⌂</button>
  <span class="map-seg" role="group" aria-label="Memory view">
    <button type="button" class="map-seg-btn" data-act="list" aria-pressed="false">List</button>
    <button type="button" class="map-seg-btn" aria-pressed="true">Map</button>
  </span>
</div>
<div class="map-hud map-search" hidden><input type="search" class="map-search-input" placeholder="Fly to…" aria-label="Fly to" autocomplete="off"><ul class="map-results" role="listbox"></ul></div>
<div class="map-hud map-legend" aria-hidden="true"><span>Star = goal</span><span>Planet = person or topic</span><span>Moon = note</span><span>Comet = recent day</span><span>Asteroid = unconnected</span></div>
<aside class="map-hud map-inspector" hidden aria-live="polite"></aside>
<p class="map-empty" hidden>Nothing remembered yet. Talk to me, and this fills in.</p>
<p class="map-fallback" hidden>The map needs WebGL, which this browser has turned off. Everything is in the <button type="button" class="map-link" data-act="list">list</button>.</p>
<p class="sr-only map-live" aria-live="polite"></p>`;
  const $ = (s) => root.querySelector(s);
  const canvas = $('.map-canvas');
  const labelsEl = $('.map-labels');
  const inspector = $('.map-inspector');
  const search = $('.map-search');
  const searchInput = $('.map-search-input');
  const results = $('.map-results');
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-roledescription', 'map');
  root.setAttribute('aria-label', 'Stellar Map of memory. Arrow keys step along threads, Enter dives, Escape backs out, Command K searches.');

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let renderer = null;
  try { renderer = createRenderer(canvas); } catch (e) { console.error(e); renderer = null; }
  if (!renderer) $('.map-fallback').hidden = false;

  // ---- state ---------------------------------------------------------------
  let data = null;
  let lay = null;
  let byId = new Map();
  let adj = new Map();
  let seen = null;              // ids from the previous load, to flare newcomers
  const flares = [];
  let W = 1; let H = 1;
  const cam = { x: 0, y: 0, z: 1 };
  let fitZ = 1;
  let flight = null;
  let selected = null;
  let hovered = null;
  const dims = new Map();
  let visible = false;
  let raf = 0;
  let dirty = true;
  let ambient = 0;              // seconds of drift/orbit/twinkle time
  let ambientOff = false;       // dropped when frames slip
  let saver = false;            // battery saver
  let lastAmbient = 0;
  let lastInteract = 0;
  let lastFrame = 0;
  const slow = [];
  let quality = 1;             // render scale; drops while moving if frames slip, back to 1 when still
  let settledAt = 0;
  let pointer = { x: 0, y: 0, nx: 0, ny: 0 };
  let entering = null;
  let colors = null;
  let tokens = null;
  let lines = new Float32Array(9 * 6 * 4096);
  const labelEls = new Map();
  let fieldStars = [];

  navigator.getBattery?.().then((b) => {
    const check = () => { saver = !b.charging && b.level <= 0.2; };
    check();
    b.addEventListener('levelchange', check);
    b.addEventListener('chargingchange', check);
  }).catch(() => {});

  // ---- tokens --------------------------------------------------------------
  function readTokens() {
    const cs = getComputedStyle(root);
    const t = (n) => parseColor(cs.getPropertyValue(n));
    tokens = {
      space: t('--space-bg'), star: t('--starlight'), star2: t('--starlight-2'), star3: t('--starlight-3'),
      person: t('--node-person'), goal: t('--node-goal'), note: t('--node-note'), project: t('--node-project'),
      event: t('--node-event'), orphan: t('--node-orphan'),
      neb: [t('--nebula-1'), t('--nebula-2'), t('--nebula-3')], warm: t('--milky-warm'), cool: t('--milky-cool'),
      fly: cssMs(cs.getPropertyValue('--m-fly'), 800), enter: cssMs(cs.getPropertyValue('--m-enter'), 600),
      ease: bezier(cs.getPropertyValue('--ease-fly')),
    };
    colors = {
      uSpace: tokens.space, uWarm: tokens.warm, uCool: tokens.cool, uHazeA: tokens.neb[0], uHazeB: tokens.neb[1],
      uSelA: tokens.star, uSelB: tokens.star2, uSelC: tokens.star3,
    };
    renderer?.setColors(colors);
  }

  // A body's look: its type sets the material; its seed sets its hue, so
  // identity is hue + ring + label + position, never a texture alone.
  function look(n) {
    const k = n.seed ?? 0;
    switch (n.type) {
      case 'core': return { type: TYPE.nova };
      case 'star': return { type: TYPE.star, hue: tokens.goal, warp: 1 };
      case 'comet': return { type: TYPE.comet, hue: tokens.event };
      case 'asteroid': return { type: TYPE.asteroid, hue: mix(tokens.orphan, [0.42, 0.38, 0.34], 0.4).map((x) => x * 0.8) };
      case 'moon': {
        const base = n.kind === 'file' ? mix(tokens.note, tokens.star, 0.18) : tokens.note;
        return { type: TYPE.moon, hue: shift(base, (unit(k, 1) - 0.5) * 0.06, -0.1, (unit(k, 2) - 0.5) * 0.1).map((x) => x * 0.85) };
      }
      case 'planet': {
        if (n.kind === 'topic') {
          const hue = shift(tokens.project, (unit(k, 1) - 0.5) * 0.18, 0.05, -0.05);
          return { type: TYPE.gas, hue, hue2: shift(hue, 0.08 + unit(k, 2) * 0.1, -0.1, 0.18), atmo: shift(hue, 0.05, -0.1, 0.25), warp: unit(k, 3) * 2 };
        }
        if (n.owner) return { type: TYPE.terran, hue: tokens.person, atmo: mix(tokens.person, [1, 1, 1], 0.15) };
        // Everyone else: a world of their own hue (rust, teal, ochre, ice, rose…),
        // so two people never look alike for the wrong reason.
        const [, s0, l0] = toHsl(tokens.person);
        const hue = fromHsl([n.hueAt ?? unit(k, 1), clamp(s0 * 0.3 + unit(k, 2) * 0.2, 0.15, 0.55), clamp(l0 * 0.62 - unit(k, 5) * 0.08, 0.3, 0.6)]);
        return { type: TYPE.rocky, hue, hue2: shift(hue, 0.05, -0.2, -0.22), atmo: mix(hue, [1, 1, 1], 0.4) };
      }
      default: return { type: TYPE.moon, hue: tokens.note };
    }
  }

  // ---- data ------------------------------------------------------------------
  function setData(next) {
    const fresh = !data;
    data = next;
    byId = new Map(data.nodes.map((n) => [n.id, n]));
    lay = layout(data);
    // People's hues are their own: seeded, then nudged apart where two would clash.
    const taken = [toHsl(tokens.person)[0]];
    for (const n of data.nodes.filter((x) => x.kind === 'person' && !x.owner).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      let h = unit(n.seed, 1);
      for (let i = 0; i < 9 && taken.some((t) => Math.min(Math.abs(t - h), 1 - Math.abs(t - h)) < 0.09); i++) h = (h + 0.113) % 1;
      taken.push(h);
      n.hueAt = h;
    }
    for (const n of data.nodes) n.look = look(n);
    adj = new Map(data.nodes.map((n) => [n.id, new Set()]));
    const join = (a, b) => { if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); } };
    for (const l of data.links) join(l.a, l.b);
    for (const n of data.nodes) { if (n.parent) join(n.id, n.parent); for (const id of n.near ?? []) join(n.id, id); }
    // stars in the far field: seeded, so the sky is the same every visit
    fieldStars = Array.from({ length: 90 }, (_, i) => {
      const s = 7919 * (i + 1);
      const big = i < 7;
      const t = unit(s, 3);
      return { sx: (unit(s, 1) - 0.5) * 3600, sy: (unit(s, 2) - 0.5) * 2400, size: big ? 1.6 + unit(s, 4) * 1.2 : 0.7 + unit(s, 4) * 0.8,
        color: t < 0.4 ? [0.75, 0.84, 1] : t < 0.8 ? [1, 0.97, 0.93] : [1, 0.82, 0.6], spikes: big ? 1 : 0, phase: unit(s, 5) * 6.28, speed: 0.4 + unit(s, 6) };
    });
    measure();
    if (seen) for (const n of data.nodes) if (!seen.has(n.id) && n.type !== 'core') flares.push({ id: n.id, t0: performance.now() });
    seen = new Set(data.nodes.map((n) => n.id));
    if (selected && !byId.has(selected)) selected = null;
    if (hovered && !byId.has(hovered)) hovered = null;
    const empty = !data.nodes.some((n) => n.kind === 'memory' || n.kind === 'event' || n.kind === 'orphan' || (n.type === 'planet' && !n.owner) || n.type === 'star');
    root.classList.toggle('is-empty', empty);
    $('.map-empty').hidden = !empty;
    if (fresh) home({ instant: true });
    renderInspector();
    dirty = true;
  }

  async function refresh() {
    try {
      const res = await fetch('/api/map');
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch { /* keep the last good sky; the list still works */ }
  }

  // ---- camera ----------------------------------------------------------------
  function measure() {
    const r = root.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    renderer?.resize(W, H, Math.min(window.devicePixelRatio || 1, 2) * quality);
    if (lay && data) {
      const b = bounds(lay, data);
      const hx = Math.max(Math.abs(b.x0), Math.abs(b.x1), 160);
      const hy = Math.max(Math.abs(b.y0), Math.abs(b.y1), 120);
      fitZ = Math.min((W * 0.44) / hx, (H * 0.40) / hy);
      if (root.classList.contains('is-empty')) fitZ = Math.min(W, H) / 900;
    }
    dirty = true;
  }

  // The scale is what the screen shows: the galaxy, one system, or one body up close.
  const scaleOf = () => {
    if (cam.z < fitZ * 1.6) return 0;
    let nearest = null; let best = Infinity;
    if (selected && lay.pos.get(selected)) nearest = worldPos(selected);
    else for (const [, p] of lay.pos) { if (p.orbit) continue; const d = Math.hypot(p.x - cam.x, p.y - cam.y); if (d < best) { best = d; nearest = p; } }
    return nearest && nearest.r * cam.z >= Math.min(W, H) * 0.2 ? 2 : 1;
  };

  function flyTo(x, y, z, { ms = tokens.fly, instant = false } = {}) {
    z = clamp(z, fitZ * 0.5, fitZ * 80);
    if (instant || reduced.matches) { Object.assign(cam, { x, y, z }); flight = null; dirty = true; return; }
    flight = { from: { ...cam }, to: { x, y, z }, t0: performance.now(), ms };
  }

  function home(opts = {}) { flyTo(0, 0, fitZ, opts); }

  function worldPos(id, t = ambient) {
    const p = lay.pos.get(id);
    if (!p) return null;
    if (p.orbit) { const parent = worldPos(p.orbit.parent, t); return parent ? { ...p, ...orbitAt(p, parent, t) } : null; }
    return p;
  }

  function reach(id) {
    let r = lay.pos.get(id)?.r ?? 10;
    for (const [mid, p] of lay.pos) if (p.orbit?.parent === id) r = Math.max(r, p.orbit.radius + p.r);
    return r;
  }

  function dive(id, { deeper = true } = {}) {
    const n = byId.get(id);
    const p = worldPos(id);
    if (!n || !p) return;
    const m = Math.min(W, H);
    let z;
    if (n.type === 'planet' || n.type === 'star' || n.type === 'core') {
      const sys = (m * 0.34) / reach(id);
      const orb = (m * 0.3) / p.r;
      const here = Math.hypot(cam.x - p.x, cam.y - p.y) * cam.z < 40;
      z = deeper && here && cam.z >= sys * 0.9 ? orb : sys;
    } else z = (m * 0.05) / p.r;
    select(id);
    flyTo(p.x, p.y, z);
  }

  function backOut() {
    const s = scaleOf();
    if (s === 0) { if (selected) select(null); return; }
    if (s === 2 && selected) {
      const n = byId.get(selected);
      const top = n.parent && byId.get(n.parent)?.type !== 'core' ? n.parent : n.type === 'planet' || n.type === 'star' ? n.id : null;
      if (top) { const p = worldPos(top); flyTo(p.x, p.y, (Math.min(W, H) * 0.34) / reach(top)); return; }
    }
    home();
  }

  // ---- selection --------------------------------------------------------------
  function select(id) {
    if (selected === id) return;
    selected = id;
    renderInspector();
    hooks.onSelect?.(id ? byId.get(id) : null);
    if (id) announce(id);
    dirty = true;
  }

  function announce(id) {
    const n = byId.get(id);
    const links = adj.get(id)?.size ?? 0;
    $('.map-live').textContent = `${n.name}. ${n.sub ?? KIND_NAMES[n.kind] ?? ''}. ${links} ${links === 1 ? 'thread' : 'threads'}.`;
  }

  // 1 hop lit fully, 2 hops faintly, the rest dims to starfield.
  function neighbourhood(id) {
    const lvl = new Map([[id, 1]]);
    for (const a of adj.get(id) ?? []) lvl.set(a, 1);
    for (const a of adj.get(id) ?? []) for (const b of adj.get(a) ?? []) if (!lvl.has(b)) lvl.set(b, 0.5);
    return lvl;
  }

  // ---- inspector: a glass panel, not a tooltip ------------------------------------
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };

  function entryRow(e) {
    return `<li class="map-entry" data-entry="${esc(e.id)}"><p class="map-entry-text">${esc(e.text)}</p>
<span class="map-entry-acts"><button type="button" class="map-act" data-act="edit">Edit</button><button type="button" class="map-act" data-act="forget">Forget</button></span></li>`;
  }

  function renderInspector() {
    const n = selected && byId.get(selected);
    if (!n) { inspector.hidden = true; inspector.innerHTML = ''; return; }
    const kicker = n.owner ? 'Planet — you' : (n.sub || KIND_NAMES[n.kind] || '').replace(' · ', ' — ');
    const rows = [];
    rows.push(`<p class="map-insp-kicker">Selected · ${esc(kicker)}</p><h2 class="map-insp-title">${esc(n.name)}</h2>`);
    if (n.kind === 'memory' || n.kind === 'orphan') rows.push(`<ul class="map-entries">${entryRow({ id: n.entryId, text: n.text })}</ul>`);
    else if (n.entries) rows.push(`<ul class="map-entries">${n.entries.map(entryRow).join('')}</ul>`);
    else if (n.text) rows.push(`<p class="map-insp-text">${esc(n.text)}</p>`);
    const facts = [];
    if (n.source) facts.push(['Source', `<code>${esc(n.source)}</code>`]);
    if (n.at) facts.push(['Learned', esc(when(n.at))]);
    const touched = n.why?.lastTouched ?? n.touched;
    if (touched && touched !== n.at) facts.push(['Last touched', esc(when(touched))]);
    if (n.groups?.length) facts.push(['Constellation', esc(n.groups.join(', '))]);
    if (n.why) facts.push(['Size', `${n.why.mentions} mention${n.why.mentions === 1 ? '' : 's'}, ${n.why.links} thread${n.why.links === 1 ? '' : 's'}, ${n.why.moons} moon${n.why.moons === 1 ? '' : 's'}`]);
    if (n.reason) facts.push(['Why here', esc(n.reason)]);
    rows.push(`<dl class="map-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`);
    const linked = [...(adj.get(n.id) ?? [])].map((id) => byId.get(id)).filter((m) => m && m.type !== 'moon' && m.type !== 'asteroid');
    const moons = data.nodes.filter((m) => m.parent === n.id);
    if (linked.length) {
      const why = (m) => {
        const l = data.links.find((x) => (x.a === n.id && x.b === m.id) || (x.b === n.id && x.a === m.id));
        if (!l) return m.id === n.parent ? 'orbits it' : 'mentioned that day';
        return l.stated ? `named in ${l.why[0]}` : `named together in ${l.together} note${l.together === 1 ? '' : 's'}`;
      };
      rows.push(`<p class="map-insp-label">Threads</p><ul class="map-links">${linked.map((m) => `<li><button type="button" class="map-link" data-go="${esc(m.id)}">${esc(m.name)}</button> <span class="map-why">${esc(why(m))}</span></li>`).join('')}</ul>`);
    }
    if (moons.length) rows.push(`<p class="map-insp-label">Moons</p><ul class="map-links">${moons.slice(0, 8).map((m) => `<li><button type="button" class="map-link" data-go="${esc(m.id)}">${esc(m.name)}</button></li>`).join('')}${moons.length > 8 ? `<li class="map-why">and ${moons.length - 8} more</li>` : ''}</ul>`);
    inspector.innerHTML = rows.join('');
    inspector.hidden = false;
  }

  inspector.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { dive(go.dataset.go, { deeper: false }); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    const row = e.target.closest('.map-entry');
    if (!act || !row) return;
    if (act === 'forget') {
      row.classList.add('is-leaving');
      const ok = await hooks.forget(row.dataset.entry);
      if (!ok) row.classList.remove('is-leaving');
      return;
    }
    if (act === 'edit') {
      const text = row.querySelector('.map-entry-text');
      if (row.querySelector('textarea')) return;
      const field = document.createElement('textarea');
      field.className = 'memory-edit map-edit';
      field.value = text.textContent;
      field.setAttribute('aria-label', 'Edit this memory');
      text.hidden = true;
      text.after(field);
      field.focus();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const next = field.value.replace(/\s+/g, ' ').trim();
        field.remove();
        text.hidden = false;
        if (save && next && next !== text.textContent) { text.textContent = next; await hooks.edit(row.dataset.entry, next); }
      };
      field.addEventListener('blur', () => finish(true));
      field.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
    }
  });

  // ---- search: ⌘K flies you there ------------------------------------------------
  let found = [];
  let pick = 0;
  function openSearch() {
    search.hidden = false;
    searchInput.value = '';
    runSearch();
    searchInput.focus();
  }
  function closeSearch() { search.hidden = true; root.focus({ preventScroll: true }); }
  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    // a name that starts with what you typed beats one that contains it, which beats a mention in the text
    const hit = (n) => { const name = n.name.toLowerCase(); return !q || name.startsWith(q) ? 0 : name.includes(q) ? 1 : (n.text ?? '').toLowerCase().includes(q) ? 2 : 3; };
    const rank = (n) => (n.type === 'planet' || n.type === 'star' ? 0 : n.type === 'core' ? 1 : 2);
    found = (data?.nodes ?? []).filter((n) => hit(n) < 3)
      .sort((a, b) => hit(a) - hit(b) || rank(a) - rank(b) || (b.salience ?? 0) - (a.salience ?? 0)).slice(0, 8);
    pick = 0;
    results.innerHTML = found.length
      ? found.map((n, i) => `<li role="option" class="map-result" data-i="${i}" aria-selected="${i === 0}"><span>${esc(n.name)}</span><span class="map-why">${esc(n.sub ?? KIND_NAMES[n.kind] ?? '')}</span></li>`).join('')
      : '<li class="map-why map-result-none">Nothing by that name.</li>';
  }
  function choose(i) {
    const n = found[i];
    if (!n) return;
    closeSearch();
    // the one cinematic moment: fly, arrive selected with the neighbourhood lit
    const p = worldPos(n.id);
    const m = Math.min(W, H);
    const z = n.type === 'planet' || n.type === 'star' ? (m * 0.34) / reach(n.id) : n.type === 'core' ? fitZ : (m * 0.05) / p.r;
    select(n.id);
    flyTo(p.x, p.y, z);
  }
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(pick); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pick = clamp(pick + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, found.length - 1));
      results.querySelectorAll('.map-result').forEach((li, i) => li.setAttribute('aria-selected', String(i === pick)));
    }
  });
  results.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); choose(Number(li.dataset.i)); } });
  searchInput.addEventListener('blur', () => setTimeout(() => { if (!search.contains(document.activeElement)) search.hidden = true; }, 120));

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'search') openSearch();
    else if (act === 'home') { select(null); home(); }
    else if (act === 'list') hooks.onList?.();
  });

  // ---- pointer: drag pans, wheel travels, click selects, double-click dives -------
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  function hit(x, y) {
    let best = null;
    for (const b of drawn.slice().reverse()) {
      if (!b.id || b.type === TYPE.ringBack || b.type === TYPE.ringFront || b.type === TYPE.flare) continue;
      const r = b.type === TYPE.nova ? b.r * 1.4 : b.type === TYPE.star ? Math.max(b.r * 2.2, 12) : Math.max(b.r * 1.05, 10);
      const d = Math.hypot(x - b.x, y - b.y);
      if (d <= r && (!best || d / r < best.d)) best = { id: b.id, d: d / r };
      if (best && b.type !== TYPE.moon && b.type !== TYPE.asteroid && b.type !== TYPE.comet) break;
    }
    return best?.id ?? null;
  }

  const local = (e) => { const r = root.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function poke() {
    lastInteract = performance.now();
    root.classList.remove('is-idle');
    clearTimeout(poke.t);
    poke.t = setTimeout(() => root.classList.add('is-idle'), IDLE_MS);
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pointers.set(e.pointerId, { x, y });
    poke();
    flight = null;
    if (pointers.size === 1) drag = { x, y, cx: cam.x, cy: cam.y, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      drag = null;
    }
    root.focus({ preventScroll: true });
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    pointer = { x, y, nx: x / W - 0.5, ny: y / H - 0.5 };
    poke();
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomAt(pinch.mx, pinch.my, (pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d);
      return;
    }
    if (drag) {
      if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
      if (drag.moved) { cam.x = drag.cx - (x - drag.x) / cam.z; cam.y = drag.cy - (y - drag.y) / cam.z; root.classList.add('is-dragging'); }
      dirty = true;
      return;
    }
    const h = hit(x, y);
    if (h !== hovered) { hovered = h; canvas.style.cursor = h ? 'pointer' : ''; dirty = true; }
    else dirty = true; // pointer parallax
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    root.classList.remove('is-dragging');
    if (drag && !drag.moved && e.type === 'pointerup') {
      const [x, y] = local(e);
      select(hit(x, y));
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (hovered) { hovered = null; dirty = true; } });
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = local(e);
    const id = hit(x, y);
    if (id) dive(id);
    else zoomAt(x, y, cam.z * 2, true);
  });

  function zoomAt(x, y, z, smooth = false) {
    z = clamp(z, fitZ * 0.5, fitZ * 80);
    // keep the point under the cursor still
    const wx = cam.x + (x - W / 2) / cam.z;
    const wy = cam.y + (y - H / 2) / cam.z;
    const nx = wx - (x - W / 2) / z;
    const ny = wy - (y - H / 2) / z;
    if (smooth) flyTo(nx, ny, z, { ms: tokens.fly * 0.5 });
    else { cam.x = nx; cam.y = ny; cam.z = z; flight = null; dirty = true; }
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    poke();
    const [x, y] = local(e);
    const k = e.ctrlKey ? 0.012 : 0.0018; // pinch on a trackpad arrives as ctrl+wheel
    zoomAt(x, y, cam.z * Math.exp(-e.deltaY * k));
  }, { passive: false });

  // ---- keyboard ----------------------------------------------------------------
  function step(dx, dy) {
    if (!selected) { select('core'); return; }
    const here = screenOf(selected);
    let best = null;
    for (const id of adj.get(selected) ?? []) {
      const s = screenOf(id);
      if (!s) continue;
      const vx = s.x - here.x; const vy = s.y - here.y;
      const d = Math.hypot(vx, vy) || 1;
      const along = (vx * dx + vy * dy) / d;
      if (along < 0.35) continue;
      const score = along * 2 - d / Math.max(W, H);
      if (!best || score > best.score) best = { id, score };
    }
    if (best) {
      select(best.id);
      const s = screenOf(best.id);
      if (s.x < 60 || s.x > W - 60 || s.y < 60 || s.y > H - 60) { const p = worldPos(best.id); flyTo(p.x, p.y, cam.z); }
    }
  }
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    const keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (keys[e.key]) { e.preventDefault(); step(...keys[e.key]); return; }
    if (e.key === 'Enter' && selected && e.target === root) { e.preventDefault(); dive(selected); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!search.hidden) closeSearch(); else backOut(); return; }
    if (e.key === 'Home') { e.preventDefault(); home(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(W / 2, H / 2, cam.z * 1.5, true); }
    if (e.key === '-') { e.preventDefault(); zoomAt(W / 2, H / 2, cam.z / 1.5, true); }
  });

  // ---- projection ------------------------------------------------------------
  function project(x, y, rate = 1) {
    const px = pointer.nx * 10 * rate; const py = pointer.ny * 7 * rate;
    return { x: W / 2 + (x - cam.x) * cam.z * rate - px, y: H / 2 + (y - cam.y) * cam.z * rate - py };
  }
  function screenOf(id) { const p = worldPos(id); return p ? project(p.x, p.y) : null; }

  // ---- one frame -------------------------------------------------------------------
  let drawn = [];
  let lastSky = [0, 0];
  function frame(now) {
    const S = scaleOf();
    const focus = hovered ?? selected;
    // what you hover lights up alongside what you selected; neither ever dims the other
    let lvl = focus ? neighbourhood(focus) : null;
    if (lvl && selected && hovered && selected !== hovered) for (const [id, v] of neighbourhood(selected)) lvl.set(id, Math.max(lvl.get(id) ?? 0, v));
    // dim toward the target, smoothly, at the same pace whatever the frame rate
    const ease = 1 - Math.exp(-(now - (frame.last ?? now - 16)) / 110);
    frame.last = now;
    let settling = false;
    for (const n of data.nodes) {
      const target = lvl ? (lvl.get(n.id) === 1 ? 0 : lvl.get(n.id) === 0.5 ? 0.45 : 1) : 0;
      const cur = dims.get(n.id) ?? 0;
      const next = reduced.matches ? target : lerp(cur, target, ease);
      if (Math.abs(next - target) > 0.01) settling = true;
      dims.set(n.id, Math.abs(next - target) < 0.01 ? target : next);
    }

    const core = project(0, 0);
    const bodies = [];
    const labels = [];
    const t = ambient;
    const spinRate = (Math.PI * 2) / 600;
    const lightFor = (x, y) => {
      const dx = core.x - x; const dy = core.y - y; const d = Math.hypot(dx, dy) || 1;
      const zc = 0.45 + 0.35 * Math.exp(-d / (Math.min(W, H) * 0.6));
      const l = Math.hypot(dx / d, dy / d, zc);
      return [dx / d / l, -dy / d / l, zc / l];
    };
    const visibleAt = (s, r) => s.x > -r * 3 - 40 && s.x < W + r * 3 + 40 && s.y > -r * 3 - 40 && s.y < H + r * 3 + 40;
    const flareOf = (id) => { const f = flares.find((x) => x.id === id); return f ? clamp(1 - (now - f.t0) / 2000, 0, 1) : 0; };

    const bodyFor = (n, p, s, r) => {
      const L = n.look;
      return { id: n.id, type: L.type, x: s.x, y: s.y, r, seed: (n.seed % 997) + 0.5, hue: L.hue, hue2: L.hue2, atmo: L.atmo, warp: L.warp ?? 0,
        light: lightFor(s.x, s.y), spin: unit(n.seed, 9) * 6.28 + t * spinRate * (0.6 + unit(n.seed, 8)), dim: dims.get(n.id) ?? 0,
        sel: selected === n.id ? 1 : 0, hover: hovered === n.id && selected !== n.id ? 1 : 0, alpha: 1 };
    };

    // core and its moons, then each system: ring back, moons behind, planet, ring front, moons in front
    const systems = [];
    // On the empty days the sky is just the Nova; starfield and nebula carry the space.
    const empty = root.classList.contains('is-empty');
    for (const n of data.nodes) if (n.type === 'core' || (!empty && (n.type === 'planet' || n.type === 'star'))) systems.push(n);
    systems.sort((a, b) => (a.type === 'core' ? -1 : b.type === 'core' ? 1 : (lay.pos.get(a.id)?.y ?? 0) - (lay.pos.get(b.id)?.y ?? 0)));
    const moonsOf = new Map();
    for (const n of data.nodes) if (n.type === 'moon' && n.parent) { if (!moonsOf.has(n.parent)) moonsOf.set(n.parent, []); moonsOf.get(n.parent).push(n); }

    // asteroids and comets first: they are small and far
    for (const n of data.nodes) {
      if (n.type !== 'asteroid' && n.type !== 'comet') continue;
      const p = lay.pos.get(n.id);
      const s = project(p.x, p.y);
      const r = Math.max(p.r * cam.z, n.type === 'comet' ? 2.2 : 1.4);
      if (!visibleAt(s, n.type === 'comet' ? r * 30 : r)) continue;
      const b = bodyFor(n, p, s, r);
      if (n.type === 'comet') {
        const ang = Math.atan2(s.y - core.y, s.x - core.x);
        b.angle = ang;
        b.tail = 4 + 22 * clamp(1 - (n.age ?? 0) / 30, 0, 1);
      }
      bodies.push(b);
      if (n.id === focus || n.id === selected || S >= 1) labels.push({ n, s, r, prio: n.id === selected ? 100 : n.id === hovered ? 90 : 10 });
    }

    for (const n of systems) {
      const p = lay.pos.get(n.id);
      if (!p) continue;
      const s = project(p.x, p.y);
      const r = Math.max(p.r * cam.z, n.type === 'star' ? 4 : n.type === 'core' ? 24 : 2.5);
      const moons = (moonsOf.get(n.id) ?? []).map((m) => {
        const mp = lay.pos.get(m.id);
        const o = orbitAt(mp, p, t);
        const ms = project(o.x, o.y);
        return { m, mp, o, ms, r: Math.max(mp.r * cam.z, 2.1) };
      });
      const sysR = Math.max(r, ...moons.map((x) => Math.hypot(x.ms.x - s.x, x.ms.y - s.y) + x.r));
      if (!visibleAt(s, sysR + (n.type === 'core' ? r * 18 : 0))) continue;
      const pushMoon = (x) => {
        bodies.push(bodyFor(x.m, x.mp, x.ms, x.r));
        if (x.m.id === focus || x.m.id === selected || (S >= 1 && (selected === n.id || hovered === n.id || S === 2)) || x.m.kind === 'stack') {
          labels.push({ n: x.m, s: x.ms, r: x.r, prio: x.m.id === selected ? 100 : x.m.id === hovered ? 90 : 5 });
        }
      };
      for (const x of moons) if (!x.o.front) pushMoon(x);
      const pinned = n.type === 'planet' && n.pinned;
      if (pinned) bodies.push({ ...bodyFor(n, p, s, r), type: TYPE.ringBack, hue2: n.look.hue2 ?? mix(n.look.hue, [1, 1, 1], 0.5), id: null });
      const b = bodyFor(n, p, s, r);
      const f = flareOf(n.id);
      bodies.push(b);
      if (pinned) bodies.push({ ...b, type: TYPE.ringFront, hue2: n.look.hue2 ?? mix(n.look.hue, [1, 1, 1], 0.5), id: null, sel: 0, hover: 0 });
      for (const x of moons) if (x.o.front) pushMoon(x);
      if (f > 0) bodies.push({ type: TYPE.flare, x: s.x, y: s.y, r: Math.max(r, 6), alpha: f });
      const prio = n.id === selected ? 100 : n.id === hovered ? 90 : n.type === 'core' ? 80 : n.type === 'star' ? 60 : 30 + (n.salience ?? 0) * 20;
      if (n.type === 'core' || n.type === 'star' || r >= 9 || n.id === focus) labels.push({ n, s, r, prio });
    }
    for (const n of data.nodes) {
      if (n.type !== 'moon' && n.type !== 'asteroid' && n.type !== 'comet') continue;
      const f = flareOf(n.id);
      if (f <= 0) continue;
      const p = worldPos(n.id); const s = project(p.x, p.y);
      bodies.push({ type: TYPE.flare, x: s.x, y: s.y, r: 6, alpha: f });
    }
    for (let i = flares.length - 1; i >= 0; i--) if (now - flares[i].t0 > 2000) flares.splice(i, 1);

    // ---- threads: gravity, not spaghetti ---------------------------------------------
    let v = 0;
    const put = (x, y, across, along, alpha, c) => {
      if (v + 9 > lines.length) { const bigger = new Float32Array(lines.length * 2); bigger.set(lines); lines = bigger; }
      lines[v++] = x; lines[v++] = y; lines[v++] = across; lines[v++] = along; lines[v++] = alpha; lines[v++] = 0;
      lines[v++] = c[0]; lines[v++] = c[1]; lines[v++] = c[2];
    };
    const strip = (pts, width, alpha, color) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i]; const [x1, y1] = pts[i + 1];
        const dx = x1 - x0; const dy = y1 - y0; const d = Math.hypot(dx, dy) || 1;
        const nx = (-dy / d) * width; const ny = (dx / d) * width;
        const a0 = i / (pts.length - 1); const a1 = (i + 1) / (pts.length - 1);
        put(x0 - nx, y0 - ny, -1, a0, alpha, color); put(x0 + nx, y0 + ny, 1, a0, alpha, color); put(x1 + nx, y1 + ny, 1, a1, alpha, color);
        put(x0 - nx, y0 - ny, -1, a0, alpha, color); put(x1 + nx, y1 + ny, 1, a1, alpha, color); put(x1 - nx, y1 - ny, -1, a1, alpha, color);
      }
    };
    const colorOf = (n) => (n.type === 'star' ? tokens.goal : n.kind === 'topic' ? tokens.project : n.type === 'comet' ? tokens.event : n.kind === 'person' ? tokens.person : tokens.note);
    const thread = (a, b, strength, alpha) => {
      const pa = worldPos(a.id); const pb = worldPos(b.id);
      if (!pa || !pb) return;
      const sa = project(pa.x, pa.y); const sb = project(pb.x, pb.y);
      const dx = sb.x - sa.x; const dy = sb.y - sa.y; const d = Math.hypot(dx, dy);
      const ra = pa.r * cam.z * 1.05 + 2; const rb = pb.r * cam.z * 1.05 + 2;
      if (d < ra + rb + 4) return;
      const bend = (unit((a.seed ^ b.seed) >>> 0, 1) - 0.5) * 0.45;
      const cx = (sa.x + sb.x) / 2 - dy * bend; const cy = (sa.y + sb.y) / 2 + dx * bend;
      const N = 28;
      const pts = [];
      const t0 = ra / d; const t1 = 1 - rb / d;
      for (let i = 0; i <= N; i++) {
        const u = t0 + (t1 - t0) * (i / N);
        pts.push([(1 - u) ** 2 * sa.x + 2 * (1 - u) * u * cx + u * u * sb.x, (1 - u) ** 2 * sa.y + 2 * (1 - u) * u * cy + u * u * sb.y]);
      }
      const c = mix(colorOf(a), colorOf(b), 0.5);
      strip(pts, 2.2 + 3.2 * strength, alpha, mix(c, [1, 1, 1], 0.25));
    };
    const clusterOf = (n) => n.cluster ?? n.id;
    for (const l of data.links) {
      const a = byId.get(l.a); const b = byId.get(l.b);
      if (!a || !b) continue;
      const recency = Math.max(a.recency ?? 0.3, b.recency ?? 0.3);
      let alpha;
      if (lvl) {
        const la = lvl.get(a.id) ?? 0; const lb = lvl.get(b.id) ?? 0;
        alpha = (a.id === focus || b.id === focus) ? 0.7 : la && lb ? 0.18 : 0;
      } else if (S === 0) alpha = clusterOf(a) !== clusterOf(b) ? 0.3 : 0;
      else alpha = 0.3;
      if (alpha > 0) thread(a, b, l.strength, alpha * (0.55 + 0.45 * recency));
    }
    // comets point at the days' people only when lit
    if (focus) {
      const f = byId.get(focus);
      const comets = f.type === 'comet' ? [f] : data.nodes.filter((c) => c.type === 'comet' && (c.near ?? []).includes(focus));
      for (const c of comets) for (const id of c.near ?? []) if (byId.get(id)) thread(c, byId.get(id), 0.2, 0.55);
    }
    // visible orbits: faint, brighter round the focus
    if (S >= 1 || focus) {
      for (const [pid, moons] of moonsOf) {
        const pp = worldPos(pid);
        if (!pp) continue;
        const lit = pid === focus || moons.some((m) => m.id === focus);
        if (!lit && S === 0) continue;
        const ps = project(pp.x, pp.y);
        if (!visibleAt(ps, (lay.pos.get(moons.at(-1).id)?.orbit.radius ?? 50) * cam.z)) continue;
        for (const m of moons) {
          const R = lay.pos.get(m.id).orbit.radius * cam.z;
          if (R < 6) continue;
          const pts = [];
          for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; pts.push([ps.x + Math.cos(a) * R, ps.y + Math.sin(a) * R * ORBIT_TILT]); }
          strip(pts, 1.4, (lit ? 0.16 : 0.07) * (1 - (dims.get(pid) ?? 0) * 0.8), tokens.note);
        }
      }
    }

    // ---- far field, nebulae and twinkling stars, each at its own depth ----------------
    const drift = reduced.matches || ambientOff ? [0, 0] : [Math.cos((t / 120) * Math.PI * 2) * 14, Math.sin((t / 120) * Math.PI * 2) * 9];
    const sky = [cam.x * fitZ * FAR_RATE + pointer.nx * 3 + drift[0], cam.y * fitZ * FAR_RATE + pointer.ny * 2 + drift[1]];
    const farScale = clamp(1 + 0.05 * Math.log2(cam.z / fitZ), 0.96, 1.18);
    const nebulae = lay.clusters.map((c) => {
      const s = project(c.x, c.y, NEBULA_RATE);
      const pal = [0, 1, 2].map((i) => tokens.neb[(Math.floor(unit(c.seed, 1) * 3) + i) % 3]);
      return { x: s.x, y: s.y, r: c.r * 1.7 * cam.z * NEBULA_RATE, seed: c.seed, palette: pal, alpha: 0.95 * (lvl && !c.members.some((id) => lvl.get(id)) ? 0.45 : 1), angle: unit(c.seed, 2) * 3 };
    });
    const tw = reduced.matches || ambientOff ? 0 : 1;
    const stars = [];
    for (const st of fieldStars) {
      const x = ((((st.sx - sky[0]) % 3600) + 3600) % 3600) - 400;
      const y = ((((st.sy - sky[1]) % 2400) + 2400) % 2400) - 300;
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue;
      stars.push({ x, y, size: st.size, color: st.color, spikes: st.spikes, alpha: (0.8 + 0.1 * tw * Math.sin(t * st.speed + st.phase)) * (lvl ? 0.7 : 1) });
    }

    drawn = bodies;
    lastSky = sky;
    renderer.draw({ sky, farScale, nebulae, stars, lines, lineCount: v / 9, bodies, time: t });
    placeLabels(labels, S, now);
    renderTitle(S, focus);
    return settling;
  }

  // ---- labels: only this scale's, never colliding -------------------------------
  function placeLabels(list, S, now) {
    const used = new Set();
    const boxes = [];
    // constellation names at galaxy scale
    if (S === 0) for (const c of lay.clusters) {
      const s = project(c.x, c.y, NEBULA_RATE);
      list.push({ cluster: c, s: { x: s.x, y: s.y - c.r * cam.z * 0.62 }, r: 0, prio: 20 });
    }
    list.sort((a, b) => b.prio - a.prio);
    // big bodies are obstacles too: a label never sits on a planet
    for (const b of drawn) if (b.id && b.r > 14 && b.type !== TYPE.nova) boxes.push([b.x - b.r * 0.85, b.y - b.r * 0.85, b.x + b.r * 0.85, b.y + b.r * 0.85, b.id]);
    for (const L of list) {
      const id = L.cluster ? L.cluster.id : L.n.id;
      let el = labelEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = L.cluster ? 'map-label is-cluster' : `map-label is-${L.n.kind}${L.n.type === 'core' ? ' is-core' : ''}`;
        el.innerHTML = L.cluster ? `<b>${esc(L.cluster.name)}</b>`
          : L.n.type === 'core' ? '<b>Nova</b><span>The agent · home</span>'
            : `<b>${esc(L.n.name)}</b><span>${esc(L.n.owner ? 'Planet · Person — you' : L.n.sub ?? KIND_NAMES[L.n.kind] ?? '')}</span>`;
        labelsEl.append(el);
        labelEls.set(id, el);
        el.w = el.offsetWidth; el.h = el.offsetHeight;
      }
      if (!el.w) { el.w = el.offsetWidth; el.h = el.offsetHeight; }
      const gap = L.n?.type === 'core' ? Math.max(L.r * 2.2, 26) : L.n?.type === 'star' ? Math.max(L.r * 2.6, 14) : L.r + 8;
      // below first, then right, left and above: the first spot that's free
      const spots = [[L.s.x - el.w / 2, L.s.y + gap], [L.s.x + gap, L.s.y - el.h / 2], [L.s.x - gap - el.w, L.s.y - el.h / 2], [L.s.x - el.w / 2, L.s.y - gap - el.h]];
      let box = null; let x = 0; let y = 0;
      for (const [sx, sy] of L.cluster ? spots.slice(0, 1) : spots) {
        const b = [sx - 4, sy - 2, sx + el.w + 4, sy + el.h + 2];
        if (sx < 4 || sx + el.w > W - 4 || sy < 4 || sy + el.h > H - 4) continue; // whole labels only, never cut by the edge
        if (boxes.some((o) => o[4] !== id && !(b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]))) continue;
        box = b; x = sx; y = sy;
        break;
      }
      if (!box) continue;
      boxes.push(box);
      used.add(id);
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      el.classList.toggle('is-dim', !!L.n && (dims.get(L.n.id) ?? 0) > 0.5);
      el.classList.add('is-on');
    }
    for (const [id, el] of labelEls) if (!used.has(id)) el.classList.remove('is-on');
  }

  let lastTitle = '';
  function renderTitle(S, focus) {
    const n = S > 0 ? byId.get(selected ?? focus) : null;
    const text = `${SCALES[S]} view · centred on ${n && n.type !== 'core' ? esc(n.name) : 'Nova, the agent'}`;
    if (text !== lastTitle) { $('.map-scale').innerHTML = text; lastTitle = text; }
  }

  // ---- the loop: full rate while you interact, a trickle while the sky drifts --------
  function loop(now) {
    raf = 0;
    if (!visible || !data || !renderer) return;
    const dt = lastFrame ? now - lastFrame : 16;
    let moving = false;
    if (flight) {
      const k = clamp((now - flight.t0) / flight.ms, 0, 1);
      const e = tokens.ease(k);
      // travel in log-zoom, so a long flight doesn't rush the last stretch
      cam.x = lerp(flight.from.x, flight.to.x, e); cam.y = lerp(flight.from.y, flight.to.y, e);
      cam.z = Math.exp(lerp(Math.log(flight.from.z), Math.log(flight.to.z), e));
      if (k >= 1) flight = null;
      moving = true;
    }
    if (entering) {
      const k = clamp((now - entering.t0) / tokens.enter, 0, 1);
      if (k >= 1) entering = null;
      moving = true;
    }
    const interacting = now - lastInteract < 1500 || pointers.size > 0 || flight || hovered;
    const still = reduced.matches || ambientOff || saver;
    let tick = false;
    if (!still && !interacting && now - lastAmbient > 1000 / AMBIENT_FPS) {
      ambient += Math.min((now - (lastAmbient || now)) / 1000, 0.25);
      lastAmbient = now;
      tick = true;
    } else if (interacting || still) lastAmbient = now;
    if (dirty || moving || tick || flares.length) {
      dirty = false;
      const settling = frame(now);
      if (settling) dirty = true;
      // When frames slip while you interact, drift and twinkle go first; then
      // the render scale drops until you stop. Interaction itself never waits.
      if (interacting && lastFrame) {
        slow.push(dt);
        if (slow.length > 12) slow.shift();
        const avg = slow.reduce((a, b) => a + b, 0) / slow.length;
        if (slow.length === 12 && avg > 24) {
          if (!ambientOff) ambientOff = true;
          else if (quality > 0.5) { quality -= 0.25; measure(); }
          slow.length = 0;
        }
      }
    }
    if (interacting) settledAt = now;
    else if (quality < 1 && now - settledAt > 400) { quality = 1; measure(); }
    lastFrame = now;
    raf = requestAnimationFrame(loop);
  }

  const resize = new ResizeObserver(() => { if (visible) { measure(); if (!flight) cam.z = Math.max(cam.z, fitZ * 0.5); } });
  resize.observe(root);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); $('.map-fallback').hidden = false; });
  canvas.addEventListener('webglcontextrestored', () => { location.reload(); });
  reduced.addEventListener('change', () => { dirty = true; });

  return {
    async show({ enter = false } = {}) {
      visible = true;
      root.hidden = false;
      readTokens();
      measure();
      if (!data) await refresh();
      else refresh();
      if (enter && data && !reduced.matches) {
        // travel in, don't switch a tab: a short push from wide to the galaxy
        const to = { ...cam };
        Object.assign(cam, { z: to.z * 0.72 });
        flyTo(to.x, to.y, to.z, { ms: tokens.enter });
        entering = { t0: performance.now() };
        root.classList.remove('is-entering');
        void root.offsetWidth;
        root.classList.add('is-entering');
      }
      poke();
      dirty = true;
      if (!raf) raf = requestAnimationFrame(loop);
      root.focus({ preventScroll: true });
    },
    hide() { visible = false; root.hidden = true; if (raf) cancelAnimationFrame(raf); raf = 0; hovered = null; },
    refresh,
    openSearch,
    get visible() { return visible; },
    select(id) { if (byId.has(id)) dive(id, { deeper: false }); },
    // for the walkthrough: where a body is on screen right now
    where(id) { return screenOf(id); },
    state() { return { cam: { ...cam }, fitZ, scale: SCALES[scaleOf()], selected, hovered, flying: !!flight, flares: flares.length, sky: [...lastSky], bodies: drawn.length, dimmed: [...dims.values()].filter((d) => d > 0.5).length, ambientOff }; },
  };
}
