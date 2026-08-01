/** Universe theme — the 3D celestial brain (true Three.js + UnrealBloom).
 *
 * The celestial mapping (docs/plans/universe-view.md): Nova and the operator
 * are a binary star pair at the origin; connected components of the memory
 * layer are star systems on a distant shell; topics are planets (degree-1
 * link satellites render as moons); journals are a chronological asteroid
 * belt; automations are comets whose period visualizes interval_minutes;
 * agents are inner planets, tools their moons, rules beacon buoys, skills
 * orbital stations, sources interstellar visitors; orphaned topics drift as
 * rogue planets. Layout is deterministic orbital mechanics (hash-seeded), so
 * nothing jumps between renders — no force simulation.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { GraphNode, GraphEdge } from '../api';
import type { LegendEntry, RendererHandle, RendererOpts } from './theme';
import { computeSystems, hashStr as hash, tagColor, TAG_COLORS } from './systems';

// ── palette (kept in family with graph2d/galaxy; tag palette in systems.ts) ─
const COLOR = {
  nova: '#ffd27a',
  user: '#cfe0ff',
  agent: '#a78bfa',
  tool: '#84a98c',
  comet: '#bfe3ff',
  rule: '#f87171',
  skill: '#fbbf24',
  journal: '#a8a29e',
  source: '#818cf8',
  sysStar: '#d8c9a3',
};

// ── layout radii (world units) ───────────────────────────────────────────
// NOVA_R is the anchor and every radius below is a multiple of it, so the
// whole universe scales from one number. Before, these were nine independent
// literals: growing the central star put the agents INSIDE it, and there was
// no way to make Nova dominate without hand-retuning the entire home tier.
const NOVA_R = 52;
const DISC_IN = NOVA_R * 1.35;           // accretion disc inner edge
const DISC_OUT = NOVA_R * 4.2;           // outer edge — a wide disc, not a band
const USER_R = NOVA_R * 0.44;
const BINARY_NOVA_ORBIT = NOVA_R * 0.34; // Nova's own wobble about the barycentre
const BINARY_USER_ORBIT = DISC_OUT + USER_R * 3;   // the operator clears the disc
const AGENT_R_MIN = BINARY_USER_ORBIT * 1.15;
const AGENT_R_MAX = AGENT_R_MIN * 1.7;
const SKILL_R = AGENT_R_MAX * 1.15;
const BELT_R = SKILL_R * 1.3;
const ROGUE_R = BELT_R * 1.7;
const COMET_Q_MIN = BELT_R * 1.1;        // nearest aphelion, just past the belt
const COMET_Q_SPAN = BELT_R * 0.75;      // slowest automations reach this much further
const STAR_R = 9;          // the system star's mesh scale
const MOON_R = 2.3;        // topic-moon body radius

/** Extent of the home tier — the radius the memory shell must clear.
 *  Derived from the outermost thing actually drawn at home: a comet's
 *  aphelion (763), the rogue drift sphere, the belt and the skill ring. */
const HOME_EXT = Math.max(COMET_Q_MIN + COMET_Q_SPAN, ROGUE_R * 1.20, BELT_R, SKILL_R);

/** Fraction of a shell's slots actually used. Filling every slot looks
 *  machined; leaving gaps gives irregular angular spacing while every
 *  occupied slot is still at least `sep` from its neighbours. */
const SHELL_FILL = 0.6;

/** How far a shell may tilt out of the system plane (radians). Enough that a
 *  system reads as a three-dimensional thing rather than a flat orrery. */
const MAX_INCL = 0.5;

/** tan(half-FOV) for the 50° camera below — every framing distance derives
 *  from it, so nothing has to guess how far away "fits on screen" is. */
const FOV_TAN = Math.tan((50 * Math.PI) / 360);
/** Camera distance at which a sphere of `radius` fills half the viewport. */
const frameDist = (radius: number) => (2 * radius) / FOV_TAN;

/** Star-dome shell, measured from the camera (it rides along). */
const DOME_R_MIN = 4200, DOME_R_MAX = 5600;

/** Accretion-disc texture: soft-edged, turbulent, brighter down one limb.
 *
 *  RingGeometry's UVs span the full outer disc, so texture radius maps
 *  directly to world radius — the hole occupies the inner DISC_IN/DISC_OUT
 *  of it and is simply left transparent. Fading to nothing at BOTH edges is
 *  what stops the annulus reading as a stamped-out ring. */
function makeDiscTexture(): THREE.CanvasTexture {
  const S = 512, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  const inner = DISC_IN / DISC_OUT;
  const g = x.createRadialGradient(C, C, C * inner * 0.94, C, C, C);
  // Alphas stay low on purpose. This is additively blended and then passes
  // through bloom, so anything that looks right as a flat swatch arrives
  // saturated — the disc has to read as light, not as a surface.
  g.addColorStop(0.00, 'rgba(255,240,205,0.00)');
  g.addColorStop(0.05, 'rgba(255,236,186,0.50)');   // hot inner edge
  g.addColorStop(0.22, 'rgba(255,190,112,0.26)');
  g.addColorStop(0.52, 'rgba(236,140,150,0.12)');
  g.addColorStop(0.78, 'rgba(170,110,214,0.05)');
  g.addColorStop(1.00, 'rgba(120,86,200,0.00)');    // dissolves, never ends
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  // turbulence: partial arcs at scattered radii, so no two angles look alike
  const rnd = mulberry32(0x9e37);
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 220; i++) {
    const rr = C * (inner + rnd() * (1 - inner) * 0.98);
    const a0 = rnd() * Math.PI * 2;
    x.beginPath();
    x.arc(C, C, rr, a0, a0 + 0.1 + rnd() * 1.1);
    x.strokeStyle = `rgba(255,${190 + Math.floor(rnd() * 60)},`
      + `${110 + Math.floor(rnd() * 110)},${(0.015 + rnd() * 0.05).toFixed(3)})`;
    x.lineWidth = 1 + rnd() * 6;
    x.stroke();
  }

  // Doppler-ish beaming — the limb sweeping toward the viewer runs brighter.
  // Pure asymmetry; it is what tells you the thing is spinning.
  const d = x.createLinearGradient(0, 0, S, 0);
  d.addColorStop(0.0, 'rgba(255,246,224,0.20)');
  d.addColorStop(0.55, 'rgba(255,255,255,0.00)');
  x.fillStyle = d;
  x.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A memory system's spacing rules, derived entirely from its own membership. */
function systemGeometry(count: number, maxR: number) {
  // clear space between neighbouring surfaces, a bit over a body diameter
  let sep = 4.6 * maxR;
  // a moon clump must fit inside its parent's cell or the guarantee leaks
  const moonEnv = maxR + MOON_R + 1.0 + MOON_R;
  if (moonEnv > sep / 2) sep = 2 * moonEnv;
  const r0 = STAR_R + maxR + sep * 1.6;            // clear the core
  return { sep, r0, count };
}

/** Concentric orbital shells — things in space orbit things.
 *
 *  Each shell is a real orbit: its own radius, its own inclination, and its
 *  own Keplerian period, so inner bodies genuinely lap outer ones. What makes
 *  that safe is the geometry, not luck:
 *
 *  - **Within a shell**, every body shares one radius and one period, so the
 *    angular gaps never change. Slots are sized by `cap` such that the chord
 *    between adjacent slots is ≥ `sep`.
 *  - **Between shells**, `|a − b| ≥ ||a| − |b||` (reverse triangle
 *    inequality) and the radii differ by ≥ `sep`. That holds for ANY phase,
 *    ANY tilt and ANY pair of periods — which is exactly why each shell is
 *    free to orbit at its own rate without the arrangement ever shearing
 *    into a jam, the failure mode of per-BODY orbits.
 *
 *  Append-stable: shell capacities and quotas depend only on radius, so a new
 *  document takes the next free slot and moves nothing. Filling outward in
 *  ascending-mtime order makes "oldest orbits closest" emergent.
 */
function orbitalShells(g: ReturnType<typeof systemGeometry>, seed: number) {
  const shells: {
    r: number; cap: number; q: THREE.Quaternion; period: number; phase: number;
  }[] = [];
  const seats: { shell: number; slot: number }[] = [];
  for (let k = 0; seats.length < g.count; k++) {
    const r = g.r0 + k * g.sep;
    // most bodies whose adjacent-slot chord 2·r·sin(π/cap) is still ≥ sep
    const cap = Math.max(1, Math.floor(Math.PI / Math.asin(Math.min(1, g.sep / (2 * r)))));
    const rnd = mulberry32(seed ^ Math.imul(k + 1, 0x85ebca6b));
    // deterministic shuffle, then take a quota — occupied slots land at
    // irregular angles instead of a machined even ring
    const slots = [...Array(cap).keys()];
    for (let a = cap - 1; a > 0; a--) {
      const b_ = Math.floor(rnd() * (a + 1));
      [slots[a], slots[b_]] = [slots[b_], slots[a]];
    }
    const node = rnd() * Math.PI * 2;
    const axis = new THREE.Vector3(Math.cos(node), 0, Math.sin(node));
    shells.push({
      r, cap,
      q: new THREE.Quaternion().setFromAxisAngle(axis, (rnd() - 0.5) * 2 * MAX_INCL),
      period: 46 * Math.pow(r / 110, 1.5),      // Kepler: outer shells run slower
      phase: rnd() * Math.PI * 2,
    });
    const quota = Math.max(1, Math.round(cap * SHELL_FILL));
    for (let s = 0; s < quota && seats.length < g.count; s++) {
      seats.push({ shell: k, slot: slots[s] });
    }
  }
  const rMax = shells.length ? shells[shells.length - 1].r : g.r0;
  return { shells, seats, rMax };
}

/** What each celestial form means — rendered by Brain's legend panel. */
export const UNIVERSE_LEGEND: LegendEntry[] = [
  { key: 'core', color: COLOR.nova, label: 'Nova', note: 'central star' },
  { key: 'user', color: COLOR.user, label: 'You', note: 'companion star' },
  { key: 'topic', color: TAG_COLORS[0], label: 'Memories', note: 'planets, grouped into tag systems' },
  { key: 'journal', color: COLOR.journal, label: 'Journals', note: 'asteroid belt, oldest to newest' },
  { key: 'source', color: COLOR.source, label: 'Sources', note: 'interstellar visitors' },
  { key: 'agent', color: COLOR.agent, label: 'Agents', note: 'inner planets' },
  { key: 'tool', color: COLOR.tool, label: 'Tools', note: 'moons of their agent' },
  { key: 'automation', color: COLOR.comet, label: 'Automations', note: 'comets; period shows cadence' },
  { key: 'rule', color: COLOR.rule, label: 'Rules', note: 'beacons at what they guard' },
  { key: 'skill', color: COLOR.skill, label: 'Skills', note: 'orbital stations' },
  { color: '#e879f9', label: 'Shared subject', note: 'faint arc between systems that are about the same thing' },
  { color: '#efe9e2', label: 'Fresh memory', note: 'pulsing halo, learned in the last 24h' },
  { color: '#57534e', label: 'Disabled', note: 'grey body, faded orbit' },
  { color: '#b48ead', label: 'Black hole', note: 'deleted things fall in' },
];

/** Deterministic PRNG (galaxy's recipe) so nothing jumps between renders. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kepler's equation E - e·sinE = M, a few Newton steps (e < 0.9 converges fast). */
function keplerE(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 6; i++) {
    E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return E;
}

/** Shared soft radial-gradient texture — tinted per sprite for star glow. */
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

interface LabelKind { kind: 'body' | 'sysname' | 'anchor' | 'quiet' }

interface LabelEntry extends LabelKind {
  sprite: THREE.Sprite;
  /** World position of the system this label belongs to (semantic zoom key). */
  sysCenter: THREE.Vector3;
  /** Radius of that system — every crossfade threshold scales off it, so a
   *  2-body system and a 70-body one hand over at their own sizes. */
  sysExtent: number;
  baseHeight: number;
  bodyId: string | null;
  /** Screen AABB, refreshed per frame by the declutter pass. */
  sx: number; sy: number; sw: number; sh: number;
  /** Eased acceptance weight — hysteresis against strobing (see frame()). */
  vis: number;
}

/** Sprites on this layer skip the bloom chain and render in a crisp overlay
 *  pass — text must never glow like the planets do. */
export const LABEL_LAYER = 1;

/** Canvas-texture label sprite — in-scene positioning, bloom-free overlay. */
function makeLabel(text: string, color: string, kind: LabelKind['kind'],
                   sysCenter: THREE.Vector3, bodyId: string | null,
                   sysExtent: number = HOME_EXT): LabelEntry {
  const fontPx = 46;
  const pad = 28;
  const c = document.createElement('canvas');
  const measure = c.getContext('2d')!;
  measure.font = `600 ${fontPx}px system-ui, sans-serif`;
  const t = text.length > 34 ? text.slice(0, 32) + '…' : text;
  c.width = Math.ceil(measure.measureText(t).width) + pad * 2;
  c.height = fontPx + pad * 2;
  const ctx = c.getContext('2d')!;
  // dark backing plate — keeps text readable over starfield and glow alike
  ctx.fillStyle = 'rgba(6, 8, 12, 0.58)';
  ctx.beginPath();
  ctx.roundRect(6, 8, c.width - 12, c.height - 16, 16);
  ctx.fill();
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = kind === 'sysname' ? color : 'rgba(240, 246, 250, 0.98)';
  ctx.fillText(t, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.layers.set(LABEL_LAYER);
  sprite.userData.isLabel = true;
  const baseHeight = kind === 'sysname' ? 46 : kind === 'anchor' ? 17 : 11;
  sprite.scale.set(baseHeight * (c.width / c.height), baseHeight, 1);
  sprite.visible = false;
  return { sprite, kind, sysCenter, sysExtent, baseHeight, bodyId,
           sx: 0, sy: 0, sw: 0, sh: 0, vis: 0 };
}

// invisible-but-raycastable material for oversized hit proxies on small bodies
function makeHitProxy(radius: number, id: string): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }));
  m.userData.pickId = id;
  return m;
}

interface UpdateCtx { t: number; now: number; dt: number }

export function createUniverse(canvas: HTMLCanvasElement, opts?: RendererOpts): RendererHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050507');

  const camera = new THREE.PerspectiveCamera(
    50, (canvas.width || 300) / (canvas.height || 150), 2, 12000);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(canvas.width || 300, canvas.height || 150), 1.05, 0.55, 0.3);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // shared assets — disposed once in destroy(), never with the data tree
  const glowTex = makeGlowTexture();
  const unitSphere = new THREE.SphereGeometry(1, 24, 16);
  const unitRock = new THREE.DodecahedronGeometry(1, 0);
  const unitOcta = new THREE.OctahedronGeometry(1, 0);
  const unitCone = new THREE.ConeGeometry(1, 1, 8, 1, true);
  // built once per renderer, not per rebuild: 220 canvas arcs on every 20s
  // graph poll is real work for a texture that never changes
  const discTex = makeDiscTexture();
  const shared = new Set<THREE.BufferGeometry | THREE.Texture>(
    [glowTex, discTex, unitSphere, unitRock, unitOcta, unitCone]);

  function makeGlowSprite(color: string, size: number, opacity = 0.55): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(size, size, 1);
    return s;
  }

  // ── camera state (galaxy conventions: drag orbit, wheel zoom, idle spin) ─
  /** Home framing: the belt with a little air. Was a literal 620. */
  const HOME_DIST = 1.25 * frameDist(BELT_R) / 2;
  let yaw = 0.6, pitch = 0.32, dist = HOME_DIST;
  /** Zoom limits, recomputed from the built scene in build(). The floor must
   *  let a single body fill the frame — the old literal 120 sat ABOVE the
   *  ~25 a planet needs, so no planet could ever be inspected. */
  let zoomMin = 3 * camera.near;
  let zoomMax = frameDist(HOME_EXT);
  const clampDist = (d: number) => Math.max(zoomMin, Math.min(zoomMax, d));
  const camTarget = new THREE.Vector3(0, 0, 0);
  function applyCamera() {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    camera.position.set(
      camTarget.x + dist * cp * Math.cos(yaw),
      camTarget.y + dist * sp,
      camTarget.z + dist * cp * Math.sin(yaw));
    // flip up when past a pole so the tumble is continuous (infinite rotate)
    camera.up.set(0, cp >= 0 ? 1 : -1, 0);
    camera.lookAt(camTarget);
  }

  // ── runtime settings (Brain HUD → configure()) ──────────────────────────
  let rotationSpeed = 1;   // global orbital time-scale multiplier (0 = still)
  let labelMode: 'auto' | 'on' | 'off' = 'auto';
  let labelScale = 1;

  // chat-activity engagement (#7): the universe glows warmer and time runs
  // a touch faster while Nova is working — eased, never snapping
  let act = { active: false, at: 0 };
  let eng = 0;

  // ── ambient dressing (built once, survives setData) ─────────────────────
  const ambient = new THREE.Group();
  scene.add(ambient);

  // Starfield backdrop. The dome RIDES THE CAMERA (repositioned every frame
  // in frame()) instead of sitting on a fixed shell at the origin. A fixed
  // shell is a bounded room: zoom far enough out and you fly through the back
  // wall and watch the sky end. Following the camera is how a skybox works —
  // the stars are always the same distance away, so space has no edge, which
  // is also the physically honest reading (real stars show no parallax at
  // these scales, but they never run out either).
  const starDome = new THREE.Group();
  ambient.add(starDome);   // in `ambient` so destroy()'s disposeTree finds it
  {
    const rand = mulberry32(1337);
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      // shell thickness gives a little depth without any of it being reachable
      const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)
        .normalize().multiplyScalar(DOME_R_MIN + rand() * (DOME_R_MAX - DOME_R_MIN));
      pos.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + rand() * 0.65;
      const warm = rand();
      col.set([b, b * (0.92 + warm * 0.08), b * (0.85 + warm * 0.15)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 2.1, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0.85, depthWrite: false,
    });
    const points = new THREE.Points(g, m);
    // the dome moves with the camera, so per-star frustum culling against a
    // stale bounding sphere would blink whole patches out
    points.frustumCulled = false;
    starDome.add(points);

    // two faint ambient nebulae near home
    const neb1 = makeGlowSprite('#1a5a5a', 1500, 0.05);
    neb1.position.set(320, -120, -260);
    const neb2 = makeGlowSprite('#3c3278', 1300, 0.045);
    neb2.position.set(-420, 160, 340);
    ambient.add(neb1, neb2);
  }

  // black hole — a distant landmark, the one thing out here nobody orbits.
  // Not in the data mapping (decorative): event horizon + tilted accretion
  // disk + photon ring; bloom does the rest.
  const blackHole = new THREE.Group();
  {
    const dir = new THREE.Vector3(0.55, 0.2, -0.81).normalize();
    blackHole.position.copy(dir.multiplyScalar(2600));

    const horizon = new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 24),
      new THREE.MeshBasicMaterial({ color: '#000000' }));

    const diskCanvas = document.createElement('canvas');
    diskCanvas.width = 256; diskCanvas.height = 256;
    const dctx = diskCanvas.getContext('2d')!;
    const dg = dctx.createRadialGradient(128, 128, 60, 128, 128, 128);
    dg.addColorStop(0, 'rgba(255,214,150,0.95)');
    dg.addColorStop(0.35, 'rgba(255,160,90,0.55)');
    dg.addColorStop(0.8, 'rgba(180,90,220,0.18)');
    dg.addColorStop(1, 'rgba(0,0,0,0)');
    dctx.fillStyle = dg;
    dctx.fillRect(0, 0, 256, 256);
    const diskTex = new THREE.CanvasTexture(diskCanvas);
    const disk = new THREE.Mesh(
      new THREE.RingGeometry(72, 165, 64),
      new THREE.MeshBasicMaterial({
        map: diskTex, transparent: true, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    disk.rotation.x = Math.PI / 2 - 0.35;

    const photonRing = new THREE.Mesh(
      new THREE.TorusGeometry(63, 1.4, 8, 64),
      new THREE.MeshBasicMaterial({
        color: '#fff3d6', blending: THREE.AdditiveBlending,
        transparent: true, opacity: 0.9, depthWrite: false,
      }));
    photonRing.rotation.x = Math.PI / 2 - 0.35;

    blackHole.add(horizon, disk, photonRing);
    ambient.add(blackHole);
  }
  const blackHoleDisk = blackHole.children[1];

  // shooting stars — a tiny pool of transient streaks in the far background
  interface Meteor {
    line: THREE.Line;
    mat: THREE.LineBasicMaterial;
    posAttr: THREE.BufferAttribute;
    head: THREE.Vector3; vel: THREE.Vector3;
    life: number; nextAt: number;
  }
  const meteors: Meteor[] = [];
  {
    const rand = mulberry32(99);
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(new Float32Array(6), 3);
      g.setAttribute('position', attr);
      const mat = new THREE.LineBasicMaterial({
        color: '#ffffff', transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const line = new THREE.Line(g, mat);
      line.frustumCulled = false;
      ambient.add(line);
      meteors.push({
        line, mat, posAttr: attr,
        head: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, nextAt: performance.now() / 1000 + 4 + rand() * 12 + i * 6,
      });
    }
  }
  const meteorRand = mulberry32(4242);
  function spawnMeteor(m: Meteor, now: number) {
    // Spawned around the CAMERA, inside the star dome. Anchored to the origin
    // they only ever streaked past the home system, and were a speck or
    // off-screen entirely once you pulled back.
    const d = new THREE.Vector3(
      meteorRand() - 0.5, meteorRand() - 0.5, meteorRand() - 0.5)
      .normalize().multiplyScalar(2200 + meteorRand() * 900);
    m.head.copy(camera.position).add(d);
    m.vel.set(meteorRand() - 0.5, (meteorRand() - 0.5) * 0.4, meteorRand() - 0.5)
      .normalize().multiplyScalar(500 + meteorRand() * 400);
    m.life = 1.1;
    m.nextAt = now + 6 + meteorRand() * 9;
  }

  // ── per-dataset scene graph ──────────────────────────────────────────────
  let dataRoot = new THREE.Group();
  scene.add(dataRoot);
  let updaters: ((ctx: UpdateCtx) => void)[] = [];
  let labels: LabelEntry[] = [];
  let pickables: THREE.Mesh[] = [];
  let fingerprint = '';
  let novaGroup: THREE.Group | null = null;   // for the always-on anchor labels
  let livePos = new Map<string, THREE.Vector3>();          // world positions by node id
  let liveSystems: { label: string; center: THREE.Vector3; extent: number; count: number }[] = [];
  /** Distance that frames the whole sky — the HUD's "Fit all". */
  let fitAllDist = frameDist(HOME_EXT);
  let bodyGroups = new Map<string, THREE.Object3D>();      // node id → body group
  let adj = new Map<string, Set<string>>();                // real-relation adjacency
  let coreId: string | null = null;

  // ── camera flight: fly to a fixed point, or track a moving body ─────────
  let followObj: THREE.Object3D | null = null;
  let flyTarget: THREE.Vector3 | null = null;
  let distTarget: number | null = null;

  // ── selection: highlight the clicked body + direct relations, dim the rest ─
  let selectedId: string | null = null;
  let highlightSet: Set<string> | null = null;
  /** The Nova star opens soul.md but relates through the core graph node. */
  const normId = (id: string | null) => (id === 'soul.md' && coreId ? coreId : id);
  const dimOf = (id: string) => (!highlightSet || highlightSet.has(id) ? 1 : 0.08);

  /** Walk the data tree carrying body ownership; dim materials outside the
   *  highlight set (base opacities stashed on first touch, restored on clear).
   *  Labels are skipped — the per-frame label loop applies its own dim. */
  function applyDim(o: THREE.Object3D, owner: string | null) {
    const id = typeof o.userData.nodeId === 'string' ? o.userData.nodeId : owner;
    if (!o.userData.isLabel) {
      const mesh = o as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material
        : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        const ud = mat.userData as { baseO?: number; baseT?: boolean };
        if (ud.baseO === undefined) { ud.baseO = mat.opacity; ud.baseT = mat.transparent; }
        const dim = highlightSet !== null && !(id && highlightSet.has(id));
        mat.opacity = dim ? ud.baseO * 0.08 : ud.baseO;
        mat.transparent = dim ? true : ud.baseT!;
      }
    }
    for (const c of o.children) applyDim(c, id);
  }

  function select(rawId: string | null) {
    const id = normId(rawId);
    if (!id) {
      selectedId = null;
      highlightSet = null;
      followObj = null;
      applyDim(dataRoot, null);
      return;
    }
    selectedId = id;
    highlightSet = new Set([id, ...(adj.get(id) ?? [])]);
    const g = bodyGroups.get(id);
    if (g) {
      followObj = g;
      flyTarget = null;
      distTarget = (g.userData.focusDist as number) ?? 130;
    }
    applyDim(dataRoot, null);
  }

  // ── deletion: vanished bodies spiral into the black hole ────────────────
  interface Dying { group: THREE.Object3D; from: THREE.Vector3; side: THREE.Vector3; t0: number }
  const dying: Dying[] = [];

  // dev-only introspection for scripted visual verification (world → screen)
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__novaUniverse = {
      toScreen: (x: number, y: number, z: number) => {
        const v = new THREE.Vector3(x, y, z).project(camera);
        return {
          x: ((v.x + 1) / 2) * canvas.clientWidth,
          y: ((1 - v.y) / 2) * canvas.clientHeight,
          behind: v.z > 1,
        };
      },
      body: (id: string) => {
        const p = livePos.get(id);
        return p ? { x: p.x, y: p.y, z: p.z } : null;
      },
      systems: () => liveSystems.map(s =>
        ({ label: s.label, x: s.center.x, y: s.center.y, z: s.center.z,
           extent: s.extent, count: s.count, dist: s.center.length() })),
      /** Labels currently accepted by the declutter pass, with screen boxes. */
      labels: () => labels
        .filter(l => l.sprite.visible)
        .map(l => ({ id: l.bodyId, kind: l.kind, x: l.sx, y: l.sy, w: l.sw, h: l.sh })),
      camera: () => ({ dist, zoomMin, zoomMax, fitAllDist,
                       t: simT, rotationSpeed, updaters: updaters.length }),
    };
  }

  function disposeTree(root: THREE.Object3D) {
    root.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry && !shared.has(mesh.geometry)) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const m = mat as THREE.Material & { map?: THREE.Texture | null };
        if (m.map && !shared.has(m.map)) m.map.dispose();
        m.dispose();
      }
    });
  }

  /** Orbit-plane quaternion: tilt by incl around a hash-seeded horizontal axis. */
  function orbitQuat(rand: () => number, maxIncl: number): THREE.Quaternion {
    const nodeAngle = rand() * Math.PI * 2;
    const axis = new THREE.Vector3(Math.cos(nodeAngle), 0, Math.sin(nodeAngle));
    return new THREE.Quaternion().setFromAxisAngle(axis, (rand() - 0.5) * 2 * maxIncl);
  }

  function orbitRing(radius: number, q: THREE.Quaternion, color: string, opacity: number): THREE.Line {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius).applyQuaternion(q));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  }

  const HOME_CENTER = new THREE.Vector3(0, 0, 0);

  function build(nodes: GraphNode[], edges: GraphEdge[]) {
    scene.remove(dataRoot);
    disposeTree(dataRoot);
    dataRoot = new THREE.Group();
    scene.add(dataRoot);
    updaters = [];
    labels = [];
    pickables = [];

    const nowSec = Date.now() / 1000;
    const byId = new Map(nodes.map(n => [n.id, n]));
    /** live world positions, refreshed every frame — dependents read these */
    const posOf = new Map<string, THREE.Vector3>();
    livePos = posOf;
    liveSystems = [];
    bodyGroups = new Map();

    // Adjacency over real relations only. A `tag` edge is a MEMBERSHIP
    // primitive — it asserts "these belong to the same group", and which two
    // members carry it is arbitrary (the spanning path, not the pair), so
    // highlighting it would name a neighbour the corpus never claimed.
    // `subject` edges pass: each one is a true per-pair statement that two
    // documents share a specific subject, which is exactly a related node.
    // (Before ROADMAP #37 this filter was accidentally backwards: no `tag`
    // edge existed at all, and `subject` carried the full arbitrary clique.)
    adj = new Map();
    for (const e of edges) {
      if (e.kind === 'tag') continue;
      (adj.get(e.source) ?? adj.set(e.source, new Set()).get(e.source)!).add(e.target);
      (adj.get(e.target) ?? adj.set(e.target, new Set()).get(e.target)!).add(e.source);
    }

    const addLabel = (entry: LabelEntry, parent: THREE.Object3D, yOffset: number) => {
      entry.sprite.position.set(0, yOffset, 0);
      parent.add(entry.sprite);
      labels.push(entry);
    };

    /** a body = group placed by its updater; mesh + optional glow + label + hit proxy */
    function makeBody(id: string, mesh: THREE.Mesh, size: number,
                      labelText: string | null, labelColor: string,
                      sysCenter: THREE.Vector3, labelKind: LabelKind['kind'] = 'body',
                      sysExtent: number = HOME_EXT) {
      const group = new THREE.Group();
      group.userData.nodeId = id;
      // frame the body and any moons it carries; the old max(110, …) floor
      // sat far above the distance at which a planet fills the view
      group.userData.focusDist = frameDist(size + size + MOON_R + 1.0 + MOON_R);
      bodyGroups.set(id, group);
      group.add(mesh);
      const proxy = makeHitProxy(Math.max(6, size * 1.9), id);
      group.add(proxy);
      pickables.push(proxy);
      if (labelText) {
        addLabel(makeLabel(labelText, labelColor, labelKind, sysCenter, id, sysExtent),
                 group, size * 2 + 7);
      }
      dataRoot.add(group);
      posOf.set(id, group.position);
      return group;
    }

    /** pulsing halo for memories touched in the last 24h — "Nova just learned this" */
    function freshFlare(group: THREE.Group, node: GraphNode, color: string, size: number,
                        sep = Infinity) {
      const age = nowSec - node.mtime;
      if (age > 86400) return;
      const strong = age < 3600;
      // capped against the cell: a fresh flare may kiss its neighbours but
      // must not swallow them — in a daily-ingesting channel the entire
      // newest arc is flaring at once
      const flare = makeGlowSprite(
        color, Math.min(size * (strong ? 7 : 5), 1.15 * sep), 0);
      group.add(flare);
      const h = hash(node.id) % 628 / 100;
      updaters.push(({ t }) => {
        const base = strong ? 0.5 : 0.3;
        (flare.material as THREE.SpriteMaterial).opacity =
          (base + Math.sin(t * 2.4 + h) * base * 0.6) * dimOf(node.id);
      });
    }

    // ═══ the binary home pair — drawn unconditionally: this IS the view's anchor ═══
    const coreNode = nodes.find(n => n.type === 'core');
    const userNode = nodes.find(n => n.type === 'user');
    coreId = coreNode?.id ?? null;

    novaGroup = new THREE.Group();
    novaGroup.userData.nodeId = coreId ?? 'soul.md';
    novaGroup.userData.focusDist = frameDist(DISC_OUT);
    bodyGroups.set(coreId ?? 'soul.md', novaGroup);
    {
      const star = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.nova }));
      star.scale.setScalar(NOVA_R);
      // a tight corona: at 3.8x it was 198 units wide, laid straight over the
      // disc, and drowned every bit of structure in it
      const glow = makeGlowSprite(COLOR.nova, NOVA_R * 2.1, 0.62);
      const proxy = makeHitProxy(NOVA_R * 1.5, 'soul.md');   // the star IS Nova → open the soul

      // A supergiant with a black-hole's silhouette — accretion disc and
      // photon ring wrapped around a LUMINOUS core, not a void. The dark
      // version was considered and rejected: the black hole is where deleted
      // things fall, so making Nova one would put memory's anchor where
      // memories go to die; and this whole renderer establishes hierarchy
      // through bloom, which an absence gives nothing to work with.
      // Two overlapping sheets at slightly different tilts, textured. A flat
      // ring in a single flat colour is a compact disc: hard edges, uniform
      // fill, one perfect circle. What stops that reading is soft falloff at
      // BOTH edges, azimuthal turbulence so no two angles match, and the
      // brightness asymmetry a rotating disc actually has.
      const discTilt = new THREE.Group();
      discTilt.rotation.set(-0.42, 0, 0.16);
      const sheet = (tex: THREE.Texture, tilt: number, opacity: number) => {
        const m = new THREE.Mesh(
          new THREE.RingGeometry(DISC_IN, DISC_OUT, 128, 8),
          new THREE.MeshBasicMaterial({
            map: tex, transparent: true, opacity,
            blending: THREE.AdditiveBlending, depthWrite: false,
            side: THREE.DoubleSide,
          }));
        m.rotation.set(-Math.PI / 2, 0, tilt);
        return m;
      };
      // second sheet is a WARP, not a cross — a large tilt difference reads
      // as a shell rather than a disc
      discTilt.add(sheet(discTex, 0, 0.55), sheet(discTex, 0.38, 0.22));
      novaGroup.add(star, glow, discTilt, proxy);
      pickables.push(proxy);
      addLabel(makeLabel(coreNode?.label || 'Nova', COLOR.nova, 'anchor', HOME_CENTER, 'soul.md'),
               novaGroup, NOVA_R + 16);
      dataRoot.add(novaGroup);
      const ng = novaGroup;
      updaters.push(({ t }) => {
        const a = t * (Math.PI * 2 / 90);           // binary period ~90s at speed 1
        ng.position.set(Math.cos(a) * BINARY_NOVA_ORBIT, 0, Math.sin(a) * BINARY_NOVA_ORBIT);
        glow.scale.setScalar(NOVA_R * (2.1 + Math.sin(t * 0.9) * 0.16));
        discTilt.rotation.z = 0.16 + t * 0.045;    // the disc turns, slowly
      });
    }
    {
      const group = new THREE.Group();
      if (userNode) {
        group.userData.nodeId = 'user';
        group.userData.focusDist = 170;
        bodyGroups.set('user', group);
      }
      const star = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.user }));
      star.scale.setScalar(USER_R);
      const glow = makeGlowSprite(COLOR.user, USER_R * 3.4, 0.7);
      // no user node in the data (platform off / old backend) → clicking = empty space
      const proxy = makeHitProxy(USER_R * 1.8, userNode ? 'user' : '');
      group.add(star, glow, proxy);
      pickables.push(proxy);
      addLabel(makeLabel(userNode?.label || 'You', COLOR.user, 'anchor', HOME_CENTER, userNode ? 'user' : null),
               group, USER_R + 14);
      dataRoot.add(group);
      if (userNode) posOf.set('user', group.position);
      updaters.push(({ t }) => {
        const a = t * (Math.PI * 2 / 90) + Math.PI;  // opposite side of the barycenter
        group.position.set(Math.cos(a) * BINARY_USER_ORBIT, 0, Math.sin(a) * BINARY_USER_ORBIT);
      });
    }
    if (coreNode) posOf.set(coreNode.id, novaGroup.position);

    // ═══ agents — inner planets, Nova's own bodies ═══
    const agents = nodes.filter(n => n.type === 'agent')
      .sort((a, b) => a.id.localeCompare(b.id));
    agents.forEach((n, i) => {
      const rand = mulberry32(hash(n.id));
      const r = agents.length === 1 ? (AGENT_R_MIN + AGENT_R_MAX) / 2
        : AGENT_R_MIN + (i / (agents.length - 1)) * (AGENT_R_MAX - AGENT_R_MIN) + (rand() - 0.5) * 8;
      const q = orbitQuat(rand, 0.16);
      const phase = rand() * Math.PI * 2;
      const period = 40 * Math.pow(r / 100, 1.5);   // Kepler-ish: outer = slower
      const off = n.enabled === false;
      const size = 5.5;
      const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({
        color: off ? '#57534e' : COLOR.agent,
        transparent: off, opacity: off ? 0.4 : 1,
      }));
      mesh.scale.setScalar(size);
      const group = makeBody(n.id, mesh, size, n.label, COLOR.agent, HOME_CENTER);
      if (!off) group.add(makeGlowSprite(COLOR.agent, size * 5, 0.4));
      dataRoot.add(orbitRing(r, q, COLOR.agent, off ? 0.03 : 0.06));
      updaters.push(({ t }) => {
        const a = phase + t * (Math.PI * 2 / period);
        group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q);
      });
    });

    // ═══ tools — moons of their first granting agent; extra grants = transfer lines ═══
    const grantEdges = edges.filter(e => e.kind === 'grant');
    const toolPrimary = new Map<string, string>();      // tool id → first agent id
    const toolExtra: { tool: string; agent: string }[] = [];
    for (const e of grantEdges) {
      if (!toolPrimary.has(e.target)) toolPrimary.set(e.target, e.source);
      else toolExtra.push({ tool: e.target, agent: e.source });
    }
    const moonIdx = new Map<string, number>();          // per-agent moon counter
    for (const n of nodes.filter(n => n.type === 'tool')) {
      const agentId = toolPrimary.get(n.id);
      const rand = mulberry32(hash(n.id));
      const k = agentId ? (moonIdx.get(agentId) ?? 0) : 0;
      if (agentId) moonIdx.set(agentId, k + 1);
      const r = 11 + k * 4.5;
      const q = orbitQuat(rand, 0.5);
      const phase = rand() * Math.PI * 2;
      const period = 9 + k * 3.5;
      const size = 2.4;
      const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.tool }));
      mesh.scale.setScalar(size);
      const group = makeBody(n.id, mesh, size, n.label, COLOR.tool, HOME_CENTER);
      const parentPos = agentId ? posOf.get(agentId) : undefined;
      updaters.push(({ t }) => {
        const a = phase + t * (Math.PI * 2 / period);
        group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q);
        if (parentPos) group.position.add(parentPos);
      });
    }
    if (toolExtra.length) {
      const g = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(new Float32Array(toolExtra.length * 6), 3);
      g.setAttribute('position', attr);
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: COLOR.tool, transparent: true, opacity: 0.08,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      lines.frustumCulled = false;
      dataRoot.add(lines);
      updaters.push(() => {
        toolExtra.forEach((x, i) => {
          const a = posOf.get(x.tool), b = posOf.get(x.agent);
          if (!a || !b) return;
          attr.setXYZ(i * 2, a.x, a.y, a.z);
          attr.setXYZ(i * 2 + 1, b.x, b.y, b.z);
        });
        attr.needsUpdate = true;
      });
    }

    // ═══ skills — orbital stations: artificial silhouettes among natural bodies ═══
    const skills = nodes.filter(n => n.type === 'skill')
      .sort((a, b) => a.id.localeCompare(b.id));
    skills.forEach((n, i) => {
      const rand = mulberry32(hash(n.id));
      const r = SKILL_R + (rand() - 0.5) * 18;
      const q = orbitQuat(rand, 0.3);
      const phase = (i / Math.max(skills.length, 1)) * Math.PI * 2 + rand();
      const size = 4.5;
      const mesh = new THREE.Mesh(unitOcta, new THREE.MeshBasicMaterial({
        color: COLOR.skill, wireframe: true,
      }));
      mesh.scale.setScalar(size);
      const core = new THREE.Mesh(unitOcta, new THREE.MeshBasicMaterial({
        color: COLOR.skill, transparent: true, opacity: 0.55,
      }));
      core.scale.setScalar(size * 0.45);
      const group = makeBody(n.id, mesh, size, n.label, COLOR.skill, HOME_CENTER);
      group.add(core);
      updaters.push(({ t, dt }) => {
        const a = phase + t * (Math.PI * 2 / 150);
        group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q);
        mesh.rotation.y += dt * 0.4;
      });
    });

    // ═══ journals — the chronological asteroid belt (fixes the 0-edge float) ═══
    const beltGroup = new THREE.Group();
    dataRoot.add(beltGroup);
    const journals = nodes.filter(n => n.type === 'journal')
      .sort((a, b) => (a.learned ?? a.id).localeCompare(b.learned ?? b.id));
    if (journals.length) {
      const times = journals.map(j => j.mtime);
      const lo = Math.min(...times), hi = Math.max(...times);
      journals.forEach((n, i) => {
        const rand = mulberry32(hash(n.id));
        const recency = hi > lo ? (n.mtime - lo) / (hi - lo) : 0.5;
        const a = (i / journals.length) * Math.PI * 2 + (rand() - 0.5) * (2 / Math.max(journals.length, 4));
        const r = BELT_R + (rand() - 0.5) * 24;
        const size = 1.7 + recency * 1.8;
        const shade = new THREE.Color(COLOR.journal).lerp(new THREE.Color('#efe9e2'), recency * 0.8);
        const mesh = new THREE.Mesh(unitRock, new THREE.MeshBasicMaterial({ color: shade }));
        mesh.scale.setScalar(size);
        mesh.rotation.set(rand() * 3, rand() * 3, rand() * 3);
        const group = new THREE.Group();
        group.userData.nodeId = n.id;
        group.userData.focusDist = 70;
        bodyGroups.set(n.id, group);
        group.add(mesh);
        const proxy = makeHitProxy(Math.max(6, size * 2.4), n.id);
        group.add(proxy);
        pickables.push(proxy);
        // journal labels are hover/forced-only (galaxy precedent — they'd spam)
        addLabel(makeLabel(n.label, COLOR.journal, 'quiet', HOME_CENTER, n.id), group, size * 2 + 6);
        if (recency > 0.75) group.add(makeGlowSprite('#efe9e2', size * 5, 0.28));
        group.position.set(Math.cos(a) * r, (rand() - 0.5) * 9, Math.sin(a) * r);
        beltGroup.add(group);
        posOf.set(n.id, group.position);   // NB: belt-local; fine — belt spins as one
        const spin = (rand() - 0.5) * 1.6;
        updaters.push(({ dt }) => { mesh.rotation.y += dt * spin; });
      });

      // belt dust — non-interactive filler that sells the ring
      const rand = mulberry32(777);
      const N = 340;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const a = rand() * Math.PI * 2;
        const r = BELT_R + (rand() - 0.5) * 34;
        pos.set([Math.cos(a) * r, (rand() - 0.5) * 11, Math.sin(a) * r], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      beltGroup.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: '#7a716a', size: 1.4, sizeAttenuation: true,
        transparent: true, opacity: 0.5, depthWrite: false,
      })));
      updaters.push(({ dt }) => { beltGroup.rotation.y += dt * (Math.PI * 2 / 420); });
    }

    // ═══ automations — comets: period visualizes interval_minutes (log-scaled) ═══
    for (const n of nodes.filter(n => n.type === 'automation')) {
      const rand = mulberry32(hash(n.id));
      const interval = n.interval_minutes ?? 60;
      const norm = Math.min(1, Math.max(0, Math.log10(Math.max(interval, 5) / 5) / 3.5));
      const agentEdge = edges.find(e => e.kind === 'platform' && e.source === n.id);
      const agentNode = agentEdge && byId.get(agentEdge.target);
      const agentIdx = agentNode ? agents.findIndex(a => a.id === agentNode.id) : -1;
      // perihelion hugs the executor agent's orbit radius
      const q_ = agentIdx >= 0 && agents.length > 1
        ? AGENT_R_MIN + (agentIdx / (agents.length - 1)) * (AGENT_R_MAX - AGENT_R_MIN)
        : 115;
      const Q_ = COMET_Q_MIN + norm * COMET_Q_SPAN;  // aphelion beyond the belt
      const semi = (q_ + Q_) / 2;
      const ecc = 1 - q_ / semi;
      const semiMinor = semi * Math.sqrt(1 - ecc * ecc);
      const period = 25 + norm * 95;                 // seconds at speed 1
      const peri = rand() * Math.PI * 2;
      const qTilt = orbitQuat(rand, 0.22);
      const phase = rand() * Math.PI * 2;
      const off = n.enabled === false;
      const size = 2.8;

      const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({
        color: off ? '#6b7280' : COLOR.comet,
        transparent: off, opacity: off ? 0.35 : 1,
      }));
      mesh.scale.setScalar(size);
      const group = makeBody(n.id, mesh, size, n.label, COLOR.comet, HOME_CENTER);
      let tail: THREE.Mesh | null = null;
      let glow: THREE.Sprite | null = null;
      if (!off) {
        glow = makeGlowSprite(COLOR.comet, size * 6, 0.5);
        group.add(glow);
        tail = new THREE.Mesh(unitCone, new THREE.MeshBasicMaterial({
          color: '#9fd4ff', transparent: true, opacity: 0.25,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
        dataRoot.add(tail);
      }

      // trace the ellipse for a faint path ring
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const E = (i / 96) * Math.PI * 2;
        const p = new THREE.Vector3(semi * (Math.cos(E) - ecc), 0, semiMinor * Math.sin(E));
        p.applyAxisAngle(new THREE.Vector3(0, 1, 0), peri).applyQuaternion(qTilt);
        pts.push(p);
      }
      const pathGeom = new THREE.BufferGeometry().setFromPoints(pts);
      dataRoot.add(new THREE.Line(pathGeom, new THREE.LineBasicMaterial({
        color: COLOR.comet, transparent: true, opacity: off ? 0.025 : 0.06,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })));

      const tailDir = new THREE.Vector3();
      updaters.push(({ t }) => {
        const M = (phase + t * (Math.PI * 2 / period)) % (Math.PI * 2);
        const E = keplerE(M, ecc);
        group.position.set(semi * (Math.cos(E) - ecc), 0, semiMinor * Math.sin(E))
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), peri).applyQuaternion(qTilt);
        if (tail) {
          const r = group.position.length();
          const len = Math.min(46, Math.max(9, 2800 / r));
          tailDir.copy(group.position).normalize();
          tail.scale.set(2.2, len, 2.2);
          tail.position.copy(group.position).addScaledVector(tailDir, len / 2);
          tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailDir);
          (tail.material as THREE.MeshBasicMaterial).opacity =
            Math.min(0.5, Math.max(0.1, 130 / r)) * dimOf(n.id);
          if (glow) (glow.material as THREE.SpriteMaterial).opacity =
            Math.min(0.7, Math.max(0.25, 160 / r)) * dimOf(n.id);
        }
      });
    }

    // ═══ rules — beacon buoys stationed at what they guard ═══
    const ruleNodes = nodes.filter(n => n.type === 'rule')
      .sort((a, b) => a.id.localeCompare(b.id));
    ruleNodes.forEach((n, idx) => {
      const targets = edges.filter(e => e.kind === 'guard' && e.source === n.id)
        .map(e => e.target).filter(id => posOf.has(id));
      const off = n.enabled === false;
      const size = 1.9;
      const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({
        color: off ? '#7f1d1d' : COLOR.rule,
        transparent: off, opacity: off ? 0.4 : 1,
      }));
      mesh.scale.setScalar(size);
      const group = makeBody(n.id, mesh, size, n.label, COLOR.rule, HOME_CENTER);
      const pulse = off ? null : makeGlowSprite(COLOR.rule, size * 7, 0.4);
      if (pulse) group.add(pulse);

      const arcs: { attr: THREE.BufferAttribute; target: string; line: THREE.Line }[] = [];
      for (const target of targets) {
        const g = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(new Float32Array(9 * 3), 3);
        g.setAttribute('position', attr);
        const line = new THREE.Line(g, new THREE.LineDashedMaterial({
          color: COLOR.rule, transparent: true, opacity: off ? 0.15 : 0.45,
          dashSize: 3, gapSize: 2.5, depthWrite: false,
        }));
        line.frustumCulled = false;
        dataRoot.add(line);
        arcs.push({ attr, target, line });
      }

      const anchor = targets[0] ? posOf.get(targets[0]) : undefined;
      const mid = new THREE.Vector3();
      updaters.push(({ t }) => {
        if (anchor) group.position.copy(anchor).add(new THREE.Vector3(0, 11 + idx * 2, 0));
        else group.position.set(0, 70 + idx * 14, 0);   // untargeted: hover over home
        if (pulse) {
          (pulse.material as THREE.SpriteMaterial).opacity =
            (0.28 + Math.sin(t * 4 + idx) * 0.2) * dimOf(n.id);
        }
        for (const arc of arcs) {
          const tp = posOf.get(arc.target);
          if (!tp) continue;
          (arc.line.material as THREE.LineDashedMaterial).opacity =
            (off ? 0.15 : 0.45) * dimOf(n.id);
          mid.copy(group.position).add(tp).multiplyScalar(0.5);
          mid.y += 8;
          for (let i = 0; i <= 8; i++) {
            const s = i / 8;
            // quadratic bezier group.position → mid → target
            const x = (1 - s) * (1 - s) * group.position.x + 2 * (1 - s) * s * mid.x + s * s * tp.x;
            const y = (1 - s) * (1 - s) * group.position.y + 2 * (1 - s) * s * mid.y + s * s * tp.y;
            const z = (1 - s) * (1 - s) * group.position.z + 2 * (1 - s) * s * mid.z + s * s * tp.z;
            arc.attr.setXYZ(i, x, y, z);
          }
          arc.attr.needsUpdate = true;
          arc.line.computeLineDistances();
        }
      });
    });

    // ═══ memory layer → star systems (shared computation — see systems.ts,
    // the Atlas panel groups from the very same call) ═══
    const linkEdges = edges.filter(e => e.kind === 'link');
    // personal facts — docs carrying an `about: user` arc to the operator
    const aboutIds = new Set(edges.filter(e => e.kind === 'about').map(e => e.source));
    const { systems, rogues: singles } = computeSystems(nodes, edges);

    // degree over link edges only — moon determination uses real relations,
    // never the tag-chain construction artifact
    const linkDegree = new Map<string, number>();
    for (const e of linkEdges) {
      linkDegree.set(e.source, (linkDegree.get(e.source) ?? 0) + 1);
      linkDegree.set(e.target, (linkDegree.get(e.target) ?? 0) + 1);
    }
    // total degree (drawn or not) sizes planets
    const fullDegree = new Map<string, number>();
    for (const e of edges) {
      fullDegree.set(e.source, (fullDegree.get(e.source) ?? 0) + 1);
      fullDegree.set(e.target, (fullDegree.get(e.target) ?? 0) + 1);
    }

    // Link adjacency built once. The old code called linkEdges.find() per
    // topic in three separate loops — ~16k comparisons on the live corpus.
    const linkOf = new Map<string, GraphEdge[]>();
    for (const e of linkEdges) {
      (linkOf.get(e.source) ?? linkOf.set(e.source, []).get(e.source)!).push(e);
      (linkOf.get(e.target) ?? linkOf.set(e.target, []).get(e.target)!).push(e);
    }
    const planetSize = (n: GraphNode) => 3.5 + Math.min(fullDegree.get(n.id) ?? 0, 6) * 0.8;

    // moons: a topic wiki-linked to exactly one other topic orbits it.
    // Resolved once for the whole graph rather than per system per loop.
    const moonSet = new Set<string>();
    for (const n of nodes) {
      if (n.type !== 'topic' || linkDegree.get(n.id) !== 1) continue;
      const e = linkOf.get(n.id)?.[0];
      if (!e) continue;
      const otherId = e.source === n.id ? e.target : e.source;
      const other = byId.get(otherId);
      if (other && other.type === 'topic' && (linkDegree.get(otherId) ?? 0) >= 2) {
        moonSet.add(n.id);
      }
    }

    // Geometry first, placement second: a system's distance from home is a
    // function of its own extent, so extent has to exist before the centre.
    const parts = systems.map(sys => {
      const topics = sys.members.filter(m => m.type === 'topic');
      // Radius means AGE: oldest holds the inner orbits, newest the rim.
      // Filling outward in growth order is also what makes an ingest free —
      // it takes the next free seat and moves nothing. (Tried ordering by
      // citation count instead; reverted. It cost that stability, and link
      // degree is only ever 0/1/2 on this corpus, so it bought three coarse
      // bands rather than a ranking.)
      const planets = topics.filter(m => !moonSet.has(m.id))
        .sort((a, b) => a.mtime - b.mtime || a.id.localeCompare(b.id));
      const maxR = planets.reduce((a, m) => Math.max(a, planetSize(m)), 3.5);
      const geo = systemGeometry(Math.max(planets.length, 1), maxR);
      const orb = orbitalShells(geo, hash(sys.key));
      return {
        planets, maxR, geo, orb,
        moons: topics.filter(m => moonSet.has(m.id)),
        sources: sys.members.filter(m => m.type === 'source'),
        extent: orb.rMax + maxR,
      };
    });
    // ═══ orbital lanes — everything orbits Nova ═══════════════════════════
    // The shell mechanism from inside a system, applied one level up. Systems
    // sharing a lane share its radius and period, so their angular gaps never
    // change; lanes are separated by more than two cluster extents, so the
    // reverse triangle inequality keeps different lanes apart at any phase and
    // any tilt. Nothing can collide, and nothing has to be simulated.
    const maxExtent = parts.reduce((a, p) => Math.max(a, p.extent), 1);
    const laneMargin = maxExtent * 0.35;
    const laneGap = 2 * maxExtent + laneMargin;
    const laneR0 = HOME_EXT + maxExtent + laneMargin;
    // Lane by SIZE BAND, so radius still means size and a system only changes
    // lane when its membership crosses a power of two — meaningful and rare.
    // A rank-based assignment would swap two systems the moment an ingest tied
    // them.
    const bandOf = (n: number) => Math.max(0, Math.floor(Math.log2(Math.max(n, 1))) - 1);
    const laneMembers = new Map<number, number[]>();
    parts.forEach((_p, i) => {
      const band = bandOf(systems[i].members.length);
      (laneMembers.get(band) ?? laneMembers.set(band, []).get(band)!).push(i);
    });
    // Occupied bands compact to consecutive lanes. Mapping bands to fixed
    // radii is more stable, but log2 bands are sparse — a 2-member and a
    // 163-member system sit six bands apart, and the view became one distant
    // speck across an empty void. Compaction only shifts when the SET of
    // occupied size classes changes, which is far rarer than an ingest.
    const laneIndex = new Map<number, number>(
      [...laneMembers.keys()].sort((a, b) => a - b).map((band, i) => [band, i]));
    const lanes = new Map<number, {
      r: number; cap: number; q: THREE.Quaternion; period: number; phase: number;
    }>();
    for (const band of laneMembers.keys()) {
      const r = laneR0 + laneIndex.get(band)! * laneGap;
      const rnd = mulberry32(0x1f83d9ab ^ Math.imul(band + 1, 0x9e3779b1));
      const node = rnd() * Math.PI * 2;
      lanes.set(band, {
        r,
        cap: Math.max(1, Math.floor(Math.PI / Math.asin(Math.min(1, laneGap / (2 * r))))),
        q: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(Math.cos(node), 0, Math.sin(node)), (rnd() - 0.5) * 0.7),
        // Kepler again: the far lanes drift, they do not race. A full turn is
        // minutes, not seconds — "everything eventually orbits Nova".
        period: 900 * Math.pow(r / laneR0, 1.5),
        phase: rnd() * Math.PI * 2,
      });
    }

    /** Radius the camera must be able to frame — drives the zoom ceiling. */
    let worldExtent = HOME_EXT;

    systems.forEach((sys, si) => {
      const { planets, moons, sources, maxR, geo, orb, extent: E } = parts[si];
      const band = bandOf(sys.members.length);
      const lane = lanes.get(band)!;
      const seat = laneMembers.get(band)!.indexOf(si);   // stable: sys.key order
      const laneAng = (seat * 2 * Math.PI) / lane.cap;
      // Live: the centre is mutated every frame by the updater below, and
      // every dependent holds a REFERENCE to it — bodies add it, labels
      // measure to it, the fly-to proxy tracks it. One mutation point moves
      // the entire system.
      const center = new THREE.Vector3();
      const placeCenter = (t: number) => {
        const a = laneAng + lane.phase + t * ((Math.PI * 2) / lane.period);
        center.set(Math.cos(a) * lane.r, 0, Math.sin(a) * lane.r)
          .applyQuaternion(lane.q);
      };
      placeCenter(0);
      worldExtent = Math.max(worldExtent, lane.r + E);
      const sysGroup = new THREE.Group();
      sysGroup.position.copy(center);
      dataRoot.add(sysGroup);

      // dominant shared tag names the system (computed in systems.ts)
      const dominant = sys.name;
      const sysColor = sys.color;

      // A source anchor IS the sun of its system — the channel every member
      // came from, and the most connected node in it. Only draw the generic
      // star when nothing real occupies the centre.
      if (!sources.length) {
        const star = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.sysStar }));
        star.scale.setScalar(STAR_R);
        sysGroup.add(star);
      }
      // glow and nebula scale with the system — they were flat 95 and 380,
      // which swallowed a 2-planet system whole
      sysGroup.add(makeGlowSprite(COLOR.sysStar, Math.max(40, 0.8 * E), 0.55));
      addLabel(makeLabel(dominant, sysColor, 'sysname', center, null, E), sysGroup, 34);
      sysGroup.add(makeGlowSprite(sysColor, 3.2 * E, 0.05));   // per-system nebula tint
      // clicking a system's star flies the camera there (recenter returns
      // home). It TRACKS the system now — a cloned snapshot would fly you to
      // where the cluster used to be.
      const sysProxy = makeHitProxy(16, '');
      sysProxy.userData.focus = center;
      sysProxy.userData.follow = sysGroup;
      sysProxy.userData.focusDist = 1.25 * frameDist(E) / 2;
      sysGroup.add(sysProxy);
      pickables.push(sysProxy);
      liveSystems.push({ label: dominant, center, extent: E, count: sys.members.length });

      // Carry the whole system around its lane. Pushed BEFORE the body
      // updaters so they read this frame's centre, not last frame's.
      const followers: { g: THREE.Object3D; off: THREE.Vector3 }[] = [];
      updaters.push(({ t }) => {
        placeCenter(t);
        sysGroup.position.copy(center);
        for (const f of followers) f.g.position.copy(center).add(f.off);
      });

      // ── the cluster ─────────────────────────────────────────────────────
      // Positions come from the blue-noise scatter computed above: no visible
      // geometric rule, a hard minimum separation, and stable under append.
      // No guide curves and no arms — an exact spiral reads as drawn rather
      // than grown, which is the thing this replaced.
      const times = planets.map(p => p.mtime);
      const lo = Math.min(...times), hi = Math.max(...times);
      const orbiting: { g: THREE.Object3D; shell: number; ang: number }[] = [];

      planets.forEach((p, i) => {
        const seat = orb.seats[i];
        const sh = orb.shells[seat.shell];
        const size = planetSize(p);
        const recency = hi > lo ? (p.mtime - lo) / (hi - lo) : 0.5;
        const color = tagColor(p);
        const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color }));
        mesh.scale.setScalar(size);
        const group = makeBody(p.id, mesh, size, p.label, color, center, 'body', E);
        // A sprite's scale IS its world WIDTH, so an uncapped size*4.5 halo is
        // 26.6 wu across — wider than the gap between bodies, and it then goes
        // through bloom. Cap it against the cell or the bodies separate and
        // the picture does not.
        group.add(makeGlowSprite(color, Math.min(size * 4.5, 0.88 * geo.sep),
                                 0.25 + recency * 0.3));
        freshFlare(group, p, color, size, geo.sep);
        orbiting.push({ g: group, shell: seat.shell, ang: (seat.slot * 2 * Math.PI) / sh.cap });
      });

      // one faint path per shell — this is what makes the motion read as
      // orbiting rather than drifting. One Line per shell, not per body.
      // PARENTED to sysGroup so they ride the lane; a world-space copy of the
      // centre would leave the paths behind as the system orbits.
      for (const sh of orb.shells) {
        sysGroup.add(orbitRing(sh.r, sh.q, sysColor, 0.055));
      }

      if (orbiting.length) {
        const scratch = new THREE.Vector3();
        updaters.push(({ t }) => {
          for (const b of orbiting) {
            const sh = orb.shells[b.shell];
            const a = b.ang + sh.phase + t * ((Math.PI * 2) / sh.period);
            scratch.set(Math.cos(a) * sh.r, 0, Math.sin(a) * sh.r)
              .applyQuaternion(sh.q).add(center);
            b.g.position.copy(scratch);
          }
        });
      }

      for (const m of moons) {
        const e = linkOf.get(m.id)![0];
        const parentId = e.source === m.id ? e.target : e.source;
        const parentPos = posOf.get(parentId);
        const mrand = mulberry32(hash(m.id));
        // derived from the parent so the clump fits inside its own cell —
        // systemGeometry() widens SEP if this envelope ever outgrows it
        const r = (byId.get(parentId) ? planetSize(byId.get(parentId)!) : maxR) + MOON_R + 1.0;
        const q = orbitQuat(mrand, 0.6);
        const phase = mrand() * Math.PI * 2;
        const size = MOON_R;
        const color = tagColor(m);
        const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color }));
        mesh.scale.setScalar(size);
        const group = makeBody(m.id, mesh, size, m.label, color, center, 'body', E);
        freshFlare(group, m, color, size, geo.sep);
        updaters.push(({ t }) => {
          const a = phase + t * (Math.PI * 2 / 11);
          group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q);
          if (parentPos) group.position.add(parentPos);
        });
      }

      // sources — the channel a system came from IS its sun, so it sits at the
      // centre. It used to loiter 14 wu from an arbitrary drive-by topic while
      // its 66 arcs radiated from that offset, which read as a passer-by; it
      // was also the last body escaping the spacing budget.
      sources.forEach((s, k) => {
        const size = 2.6;
        const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.source }));
        mesh.scale.set(size * 2.1, size * 0.7, size * 0.7);   // elongated — it came from outside
        const group = makeBody(s.id, mesh, size, s.label, COLOR.source, center, 'body', E);
        // a lone source takes the centre exactly; several share a tight ring
        const ring = sources.length === 1 ? 0 : STAR_R + size + 3;
        const ang = (k * 2 * Math.PI) / Math.max(sources.length, 1);
        const off = new THREE.Vector3(Math.cos(ang) * ring, 0, Math.sin(ang) * ring);
        group.position.copy(center).add(off);
        // It rides the lane with its system. NOT parented to sysGroup: posOf
        // must stay world-valid, because 37 link arcs terminate on this body.
        followers.push({ g: group, off });
        // tail points away from home — this thing came from outside. Oriented
        // once, from where the system sits at t=0.
        const tailDir = group.position.clone().normalize();
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tailDir);
        const tail = new THREE.Mesh(unitCone, new THREE.MeshBasicMaterial({
          color: COLOR.source, transparent: true, opacity: 0.16,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
        const len = 12;
        tail.scale.set(1.4, len, 1.4);
        tail.position.copy(group.position).addScaledVector(tailDir, len / 2);
        tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailDir);
        followers.push({ g: tail, off: off.clone().addScaledVector(tailDir, len / 2) });
        dataRoot.add(tail);
      });
    });

    // The camera must be able to frame the whole sky and to close on a single
    // body — both limits derived, replacing the literals 3200 and 120 (that
    // floor sat ABOVE the ~25 a planet needs, so no planet was ever
    // inspectable).
    // Generous both ways: close enough to sit among the bodies, far enough to
    // leave the whole sky behind you. The old literals (120 / 3200) made the
    // wheel feel like it hit a wall in both directions.
    zoomMin = Math.max(1.5 * camera.near, frameDist(1.0));
    zoomMax = (3.0 * worldExtent) / FOV_TAN;
    fitAllDist = Math.min(zoomMax, 1.15 * frameDist(worldExtent) / 2);
    // The far plane is measured from the CAMERA, so it has to clear the whole
    // scene FROM THE FURTHEST THE CAMERA CAN GET — not just the scene radius.
    // `worldExtent * 3` was shorter than zoomMax, so pulling back past it
    // clipped the far side of the universe away a system at a time, which
    // read as things randomly disappearing on zoom-out.
    camera.far = Math.max(DOME_R_MAX * 1.3, zoomMax + worldExtent * 1.5);
    camera.updateProjectionMatrix();

    // The black hole is a landmark, and it keeps its job: deleted things fall
    // in. Derived so it stays OUTSIDE the outermost lane however far the lanes
    // grow, and scaled so it still reads as huge from out there. It was a flat
    // 2600 with a 60-unit horizon, which the widened universe swallowed.
    blackHole.position.set(0.55, 0.2, -0.81).normalize().multiplyScalar(worldExtent * 1.55);
    blackHole.scale.setScalar(Math.max(1, worldExtent / 900));

    // link edges as faint arcs (real relations only — tag chains never draw).
    // Journals excluded: their posOf is belt-local, and the belt already
    // carries their meaning.
    const drawableLinks = linkEdges.filter(e =>
      posOf.has(e.source) && posOf.has(e.target) &&
      byId.get(e.source)?.type !== 'journal' && byId.get(e.target)?.type !== 'journal');
    if (drawableLinks.length) {
      const SEG = 12;
      const arcs = drawableLinks.map(() => {
        const g = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3);
        g.setAttribute('position', attr);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({
          color: '#5aa0c8', transparent: true, opacity: 0.18,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        line.frustumCulled = false;
        dataRoot.add(line);
        return attr;
      });
      const mid = new THREE.Vector3();
      updaters.push(() => {
        drawableLinks.forEach((e, i) => {
          const a = posOf.get(e.source)!, b = posOf.get(e.target)!;
          mid.copy(a).add(b).multiplyScalar(0.5);
          mid.y += a.distanceTo(b) * 0.18;
          const attr = arcs[i];
          for (let s = 0; s <= SEG; s++) {
            const u = s / SEG;
            const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * mid.x + u * u * b.x;
            const y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * mid.y + u * u * b.y;
            const z = (1 - u) * (1 - u) * a.z + 2 * (1 - u) * u * mid.z + u * u * b.z;
            attr.setXYZ(s, x, y, z);
          }
          attr.needsUpdate = true;
        });
      });
    }

    // ═══ singles — rogue planets (orphaned topics) and lone visitors.
    // Personal facts are not rogues: a doc with an about-user arc orbits
    // the operator's star at full color instead of drifting grey in the
    // deep — connected to a person, not lost in space. ═══
    singles.forEach(n => {
      const rand = mulberry32(hash(n.id));
      const personal = aboutIds.has(n.id) && posOf.has('user');
      const base = new THREE.Vector3(rand() - 0.5, (rand() - 0.5) * 0.7, rand() - 0.5)
        .normalize().multiplyScalar(ROGUE_R * (0.85 + rand() * 0.35));
      const size = n.type === 'source' ? 2.6 : 3.2;
      const color = n.type === 'source' ? COLOR.source
        : personal ? tagColor(n)
        : new THREE.Color(tagColor(n)).lerp(new THREE.Color('#6b7280'), 0.55).getStyle();
      const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({
        color, transparent: !personal, opacity: personal ? 1 : 0.8,
      }));
      if (n.type === 'source') mesh.scale.set(size * 2.1, size * 0.7, size * 0.7);
      else mesh.scale.setScalar(size);
      const group = makeBody(n.id, mesh, size, n.label, color,
                             personal ? HOME_CENTER : base);
      freshFlare(group, n, color, size);
      if (personal) {
        group.add(makeGlowSprite(color, size * 4.5, 0.3));
        const r = USER_R + 12 + rand() * 10;
        const q = orbitQuat(rand, 0.5);
        const phase = rand() * Math.PI * 2;
        const period = 13 + rand() * 9;
        const userPos = posOf.get('user')!;
        updaters.push(({ t }) => {
          const a = phase + t * (Math.PI * 2 / period);
          group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r)
            .applyQuaternion(q).add(userPos);
        });
        return;
      }
      const h1 = rand() * 6.28, h2 = rand() * 6.28, h3 = rand() * 6.28;
      updaters.push(({ t }) => {
        group.position.set(
          base.x + Math.sin(t * 0.03 + h1) * 20,
          base.y + Math.sin(t * 0.023 + h2) * 14,
          base.z + Math.sin(t * 0.027 + h3) * 20);
      });
    });

    // ═══ relationship arcs (#28) — personal facts arc to the operator's
    // star; automations arc to the documents they maintain. Drawn after
    // every body exists so rogue/user positions are live in posOf. ═══
    // ONE arc per pair of SYSTEMS, not per document. Measured on the live
    // corpus: 38 subject edges span only 6 system pairs — eleven of them
    // between the same two channels — so drawing every one rendered a bundle
    // of near-parallel lines saying a single thing eleven times. Redundancy
    // 6x, and it read as a cable rather than a relationship.
    //
    // What is drawn is still a REAL per-document edge, picked deterministically
    // from that pair, never a synthesised cluster-to-cluster link. That
    // distinction is the one the galaxy tier failed: a claim ABOUT two groups
    // could not beat a permutation null, while "these two specific notes share
    // this specific subject" is true edge by edge and needs no threshold.
    const subjectArcs = (): GraphEdge[] => {
      const sysOf = new Map<string, string>();
      systems.forEach(s => s.members.forEach(m => sysOf.set(m.id, s.key)));
      const best = new Map<string, GraphEdge>();
      const candidates = edges.filter(e => e.kind === 'subject')
        .sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));
      for (const e of candidates) {
        const a = sysOf.get(e.source), b = sysOf.get(e.target);
        if (!a || !b || a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!best.has(key)) best.set(key, e);
      }
      return [...best.values()];
    };

    const relationSets: { kinds: GraphEdge[]; color: string; opacity: number }[] = [
      { kinds: edges.filter(e => e.kind === 'about'), color: COLOR.nova, opacity: 0.22 },
      { kinds: edges.filter(e => e.kind === 'writes'), color: '#9fd4ff', opacity: 0.3 },
      // Subject affinity (ROADMAP #37). The ONLY arcs here that cross a
      // cluster boundary — every other line relates a document to something
      // it belongs to, so the view could show nothing at all about how two
      // systems relate. They were in the payload and rendered nowhere.
      //
      // This is not the milky-way tier the permutation null refused. That
      // was a CLUSTER-level arm, a claim about two groups that a shuffle
      // reproduced 200 times out of 200. Each of these is a per-document
      // statement that two specific notes share one specific subject, true
      // edge by edge, and it survives the null because it never generalises.
      // NOT graph2d's violet: in this view #a78bfa is already Agents, and an
      // arc the same colour as a body reads as belonging to it.
      { kinds: subjectArcs(), color: '#e879f9', opacity: 0.16 },
    ];
    for (const set of relationSets) {
      const drawable = set.kinds.filter(e =>
        posOf.has(e.source) && posOf.has(e.target) &&
        byId.get(e.source)?.type !== 'journal' && byId.get(e.target)?.type !== 'journal');
      if (!drawable.length) continue;
      const SEG = 12;
      const arcs = drawable.map(() => {
        const g = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3);
        g.setAttribute('position', attr);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({
          color: set.color, transparent: true, opacity: set.opacity,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        line.frustumCulled = false;
        dataRoot.add(line);
        return attr;
      });
      const mid = new THREE.Vector3();
      updaters.push(() => {
        drawable.forEach((e, i) => {
          const a = posOf.get(e.source)!, b = posOf.get(e.target)!;
          mid.copy(a).add(b).multiplyScalar(0.5);
          mid.y += a.distanceTo(b) * 0.18;
          const attr = arcs[i];
          for (let s = 0; s <= SEG; s++) {
            const u = s / SEG;
            const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * mid.x + u * u * b.x;
            const y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * mid.y + u * u * b.y;
            const z = (1 - u) * (1 - u) * a.z + 2 * (1 - u) * u * mid.z + u * u * b.z;
            attr.setXYZ(s, x, y, z);
          }
          attr.needsUpdate = true;
        });
      });
    }

    // carry an active selection across the rebuild: re-point the follow at
    // the new body group, or clear everything if the node is gone
    if (selectedId) {
      if (!bodyGroups.has(selectedId)) {
        select(null);
      } else {
        const wasFollowing = followObj !== null;
        highlightSet = new Set([selectedId, ...(adj.get(selectedId) ?? [])]);
        followObj = wasFollowing ? bodyGroups.get(selectedId)! : null;
        applyDim(dataRoot, null);
      }
    }
  }

  // ── picking + hover (drag < 4px = click, galaxy convention) ─────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointerDirty = false;
  let hoveredId: string | null = null;
  let dragging = false, dragDist = 0, lastX = 0, lastY = 0;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  let panning = false;                       // right-button drag = lateral pan
  let pinchCx = 0, pinchCy = 0, pinchPan = 0;

  const panRight = new THREE.Vector3(), panUp = new THREE.Vector3();
  /** Slide the orbit target in the camera plane; manual pan takes the wheel
   *  back from any flight or follow in progress. */
  function panBy(dx: number, dy: number) {
    followObj = null; flyTarget = null; distTarget = null;
    const s = dist * 0.0012;
    panRight.setFromMatrixColumn(camera.matrixWorld, 0);
    panUp.setFromMatrixColumn(camera.matrixWorld, 1);
    camTarget.addScaledVector(panRight, -dx * s).addScaledVector(panUp, dy * s);
  }

  function setNdc(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  function pick(): THREE.Object3D | null {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    // A real body always beats a system's fly-to proxy. The proxy is a
    // radius-16 sphere sitting at the system centre, so "nearest hit wins"
    // made every body inside it unselectable — you got a camera flight
    // instead. That is load-bearing now the source anchor sits at the centre.
    for (const h of hits) {
      const id = h.object.userData.pickId;
      if (typeof id === 'string' && id) return h.object;
    }
    return hits[0]?.object ?? null;
  }
  const pickId = (o: THREE.Object3D | null): string | null => {
    const id = o?.userData.pickId;
    return typeof id === 'string' && id ? id : null;
  };

  const onPointerDown = (e: PointerEvent) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchCx = (a.x + b.x) / 2; pinchCy = (a.y + b.y) / 2;
      pinchPan = 0;
    }
    if (e.button === 2) panning = true;
    dragging = true; dragDist = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (activePointers.size === 2) {
      // pinch zoom + two-finger pan (centroid movement past a small threshold,
      // so pinch jitter doesn't cancel a follow)
      const [a, b] = [...activePointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) dist = clampDist(dist * (pinchDist / d));
      pinchDist = d;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      pinchPan += Math.abs(cx - pinchCx) + Math.abs(cy - pinchCy);
      if (pinchPan > 16) panBy(cx - pinchCx, cy - pinchCy);
      pinchCx = cx; pinchCy = cy;
      dragDist += 10;   // a pinch is never a click
      return;
    }
    if (dragging) {
      dragDist += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
      if (panning) {
        panBy(e.clientX - lastX, e.clientY - lastY);
      } else {
        // unclamped tumble; yaw sense flips when the camera is upside down
        // so dragging always feels natural
        yaw += (e.clientX - lastX) * 0.005 * (Math.cos(pitch) >= 0 ? 1 : -1);
        pitch += (e.clientY - lastY) * 0.005;
        if (pitch > Math.PI) pitch -= 2 * Math.PI;
        if (pitch < -Math.PI) pitch += 2 * Math.PI;
      }
      lastX = e.clientX; lastY = e.clientY;
    } else {
      setNdc(e);
      pointerDirty = true;
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchDist = 0;
    if (activePointers.size > 0) return;
    dragging = false;
    panning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (dragDist < 4 && e.button === 0) {
      setNdc(e);
      const hit = pick();
      if (hit?.userData.focus) {
        // fly to the system rather than opening a detail — framed to ITS
        // size, not the flat 340 every system used to arrive at, and TRACKING
        // it, since systems orbit Nova now
        followObj = (hit.userData.follow as THREE.Object3D | undefined) ?? null;
        flyTarget = followObj ? null : (hit.userData.focus as THREE.Vector3).clone();
        distTarget = (hit.userData.focusDist as number | undefined)
          ?? 1.25 * frameDist(HOME_EXT) / 2;
      } else {
        const id = pickId(hit);
        opts?.onNodeClick?.(id);
        select(id);   // camera tracks the body, relations light up, rest dims
      }
    }
  };
  const onPointerLeave = () => {
    hoveredId = null; pointerDirty = false;
    canvas.style.cursor = 'grab';
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // manual zoom overrides flight, but zooming while tracking a body is fine
    flyTarget = null; distTarget = null;
    // 1.16 per notch, not 1.08 — the range is now ~1000x, and a small step
    // over that span reads as a stuck wheel rather than as travel
    dist = clampDist(dist * (e.deltaY > 0 ? 1.16 : 1 / 1.16));
  };
  const onContextMenu = (e: Event) => e.preventDefault();   // right-drag pans

  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  // ── frame loop (paused while the tab is hidden) ──────────────────────────
  let raf = 0;
  let simT = 0;
  let lastTime = performance.now();
  let destroyed = false;
  const camPos = new THREE.Vector3();
  const followPos = new THREE.Vector3();
  const projV = new THREE.Vector3();   // scratch for the label declutter pass

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dtReal = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    const engaged = act.active && performance.now() - act.at < 90_000;
    eng += ((engaged ? 1 : 0) - eng) * Math.min(1, 2.5 * dtReal);
    bloom.strength = 1.05 + eng * 0.3;
    const dt = dtReal * rotationSpeed * (1 + eng * 0.5);
    simT += dt;

    if (!dragging) yaw += 0.012 * rotationSpeed * dtReal * (1 + eng * 0.5);   // idle auto-orbit
    const k = 1 - Math.exp(-4 * dtReal);
    if (followObj) {
      followObj.getWorldPosition(followPos);   // world: belt journals spin as one
      camTarget.lerp(followPos, k);
    } else if (flyTarget) {
      camTarget.lerp(flyTarget, k);
      if (camTarget.distanceTo(flyTarget) < 1) flyTarget = null;
    }
    if (distTarget !== null) {
      // clamp here too: a flight target is the third path that writes `dist`,
      // and it used to escape both interactive clamps entirely
      const dt_ = clampDist(distTarget);
      dist += (dt_ - dist) * k;
      if (Math.abs(dist - dt_) < 1) distTarget = null;
    }
    applyCamera();
    // keep the sky centred on the eye — this is what makes the field endless
    starDome.position.copy(camera.position);

    const ctx: UpdateCtx = { t: simT, now: now / 1000, dt };
    for (const u of updaters) u(ctx);

    // ambient motion runs on real time — the backdrop never freezes
    blackHoleDisk.rotation.z += dtReal * 0.05;
    for (const m of meteors) {
      if (m.life > 0) {
        m.life -= dtReal;
        m.head.addScaledVector(m.vel, dtReal);
        m.posAttr.setXYZ(0, m.head.x, m.head.y, m.head.z);
        m.posAttr.setXYZ(1,
          m.head.x - m.vel.x * 0.08, m.head.y - m.vel.y * 0.08, m.head.z - m.vel.z * 0.08);
        m.posAttr.needsUpdate = true;
        m.mat.opacity = Math.max(0, Math.min(0.8, m.life * 1.6));
      } else if (now / 1000 > m.nextAt) {
        spawnMeteor(m, now / 1000);
      } else {
        m.mat.opacity = 0;
      }
    }

    // deleted bodies fall into the black hole — an accelerating spiral on
    // real time (a deletion animates even with motion speed at 0)
    for (let i = dying.length - 1; i >= 0; i--) {
      const d = dying[i];
      const u = (now / 1000 - d.t0) / 6;
      if (u >= 1) {
        scene.remove(d.group);
        disposeTree(d.group);
        dying.splice(i, 1);
        continue;
      }
      d.group.position.lerpVectors(d.from, blackHole.position, u * u)
        .addScaledVector(d.side, Math.sin(Math.PI * u) * (1 - u));
      d.group.scale.setScalar(Math.max(0.05, 1 - 0.9 * u));
      d.group.rotation.y += dtReal * 1.5;
    }

    // hover pick (only when the pointer actually moved)
    if (pointerDirty && !dragging) {
      pointerDirty = false;
      const hit = pick();
      const id = pickId(hit);
      if (id !== hoveredId) hoveredId = id;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }

    // ── semantic zoom, then screen-space declutter ─────────────────────────
    // Each label crossfades against ITS OWN system's extent, so a 2-body
    // system and a 70-body one hand over at their own scales rather than at
    // literals tuned for a fixed 950 shell.
    camPos.copy(camera.position);
    const vw = canvas.clientWidth || canvas.width || 1;
    const vh = canvas.clientHeight || canvas.height || 1;
    const wants: { l: LabelEntry; a: number; d: number }[] = [];
    for (const l of labels) {
      const E = l.sysExtent;
      let alpha = 0;
      if (l.kind === 'anchor') {
        alpha = labelMode === 'off' ? 0 : 0.92;
      } else if (l.kind === 'sysname') {
        const d = camPos.distanceTo(l.sysCenter);
        alpha = labelMode === 'off' ? 0
          : Math.max(0, Math.min(1, (d - 2.2 * E) / (1.1 * E)));
      } else if (l.kind === 'quiet') {
        alpha = labelMode === 'on' ? 0.85 : 0;
      } else {
        // distance to the BODY, not to its system centre. The old form keyed
        // every label in a system off one point, so all 67 switched on at the
        // same instant and piled into an unreadable stack.
        const p = l.bodyId ? livePos.get(l.bodyId) : null;
        const d = camPos.distanceTo(p ?? l.sysCenter);
        alpha = labelMode === 'on' ? 1
          : labelMode === 'off' ? 0
            : Math.max(0, Math.min(1, (2.2 * E - d) / (1.1 * E)));
      }
      if (highlightSet) {
        const bid = normId(l.bodyId);
        alpha *= bid && highlightSet.has(bid) ? 1 : 0.05;
      }
      if (l.bodyId && l.bodyId === hoveredId) alpha = 1;   // hover pierces the dim

      const mat = l.sprite.material as THREE.SpriteMaterial;
      const h = l.baseHeight * labelScale;
      const w = h * ((mat.map as THREE.CanvasTexture).image.width /
                     (mat.map as THREE.CanvasTexture).image.height);
      l.sprite.scale.set(w, h, 1);

      if (alpha <= 0.02) { l.sw = 0; wants.push({ l, a: 0, d: Infinity }); continue; }
      // screen box: a label sprite is ~90 world units wide against ~24 of
      // body spacing, so spacing the BODIES apart can never make the labels
      // legible on its own.
      l.sprite.getWorldPosition(projV);
      const d = camPos.distanceTo(projV);
      projV.project(camera);
      const px = ((projV.x + 1) / 2) * vw;
      const py = ((1 - projV.y) / 2) * vh;
      const scale = vh / (2 * Math.max(d, 1) * FOV_TAN);
      l.sx = px; l.sy = py; l.sw = w * scale; l.sh = h * scale;
      const onScreen = projV.z < 1
        && px > -l.sw && px < vw + l.sw && py > -l.sh && py < vh + l.sh;
      wants.push({ l, a: onScreen ? alpha : 0, d });
    }

    // Greedy non-overlapping selection. Incumbency is the hysteresis: a label
    // already shown outranks a newcomer, so the idle auto-orbit (which never
    // stops) can't make the set churn while the view sits still.
    wants.sort((p, q) => {
      const rank = (x: typeof p) =>
        (x.l.bodyId && x.l.bodyId === hoveredId ? 3 : 0)
        + (x.l.kind === 'anchor' || x.l.kind === 'sysname' ? 2 : 0)
        + x.l.vis;
      return rank(q) - rank(p) || p.d - q.d;
    });
    const cap = Math.max(8, Math.floor((0.25 * vw * vh) / 9000));
    const taken: LabelEntry[] = [];
    for (const cd of wants) {
      const l = cd.l;
      let ok = cd.a > 0.02 && taken.length < cap;
      if (ok) {
        for (const t of taken) {
          if (Math.abs(l.sx - t.sx) * 2 < l.sw + t.sw
              && Math.abs(l.sy - t.sy) * 2 < l.sh + t.sh) { ok = false; break; }
        }
      }
      if (ok) taken.push(l);
      // Asymmetric ease. Fading IN slowly is the hysteresis — it stops the
      // never-ending idle auto-orbit from strobing the set while the view
      // sits still. Fading OUT quickly matters for a different reason: a
      // label on its way out is still drawn but no longer holds a slot, so a
      // slow fade would let it overlap whatever replaced it.
      l.vis += ((ok ? 1 : 0) - l.vis) * Math.min(1, dtReal / (ok ? 0.4 : 0.1));
      const mat = l.sprite.material as THREE.SpriteMaterial;
      mat.opacity = cd.a * l.vis;
      l.sprite.visible = mat.opacity > 0.02;
    }

    composer.render();

    // labels live on their own layer, drawn after the bloom chain — crisp
    // text on top, never glowing like the bodies do. scene.background must be
    // nulled for this pass: a Color background FORCES a clear even with
    // autoClear off, which would erase the composer output.
    renderer.autoClear = false;
    renderer.clearDepth();
    const bg = scene.background;
    scene.background = null;
    camera.layers.set(LABEL_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    scene.background = bg;
    renderer.autoClear = true;
  }

  // `paused` is occlusion (an overlay covering the canvas, or the phone's
  // chat panel); document.hidden is the tab. Either one stops the loop —
  // and this is the expensive one: a bloom composer doing two full render
  // passes per frame.
  let paused = false;
  const onVisibility = () => {
    // ALWAYS cancel before deciding. `frame` reschedules itself
    // unconditionally, and `raf` names only the most recent handle — so
    // scheduling without cancelling first starts a SECOND self-perpetuating
    // chain whose handle is lost forever. That is not theoretical: Brain.tsx
    // seeds the renderer with setPaused(occluded) right after creation, so
    // every non-occluded load (i.e. the normal desktop one) hit it, ran the
    // two-pass bloom composer at double cost from mount, and left the
    // pre-existing document.hidden pause unable to stop it. The phone path
    // seeds setPaused(true), which cancels cleanly — which is exactly why
    // measuring only on the phone missed it.
    cancelAnimationFrame(raf);
    raf = 0;
    if (!document.hidden && !paused && !destroyed) {
      lastTime = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(frame);

  return {
    setPaused(next: boolean) { paused = next; onVisibility(); },

    setData(nodes: GraphNode[], edges: GraphEdge[]) {
      const fp = JSON.stringify([
        nodes.map(n => [n.id, n.label, n.type, n.mtime, n.enabled, n.interval_minutes]),
        edges.map(e => [e.source, e.target, e.kind]),
      ]);
      if (fp === fingerprint) return;   // 20s poll with same data — don't rebuild
      fingerprint = fp;

      // departures: bodies that vanished from the data fall into the black
      // hole. Detached (world transform kept) before the rebuild disposes
      // their tree. A large diff is a data reload, not deletions — skip.
      const newIds = new Set(nodes.map(n => n.id));
      const removed = [...bodyGroups.keys()].filter(
        id => !newIds.has(id) && id !== 'soul.md');
      if (removed.length && removed.length <= 12) {
        for (const id of removed) {
          const g = bodyGroups.get(id)!;
          scene.attach(g);
          g.traverse(o => { if (o.userData.isLabel) o.visible = false; });
          const from = g.position.clone();
          const side = new THREE.Vector3()
            .crossVectors(from.lengthSq() > 1 ? from : new THREE.Vector3(0, 1, 0),
                          blackHole.position)
            .normalize().multiplyScalar(140);
          dying.push({ group: g, from, side, t0: performance.now() / 1000 });
        }
      }

      build(nodes, edges);
    },
    resize(width: number, height: number) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      composer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    recenter() {
      yaw = 0.6; pitch = 0.32;
      select(null);
      flyTarget = new THREE.Vector3(0, 0, 0);
      distTarget = HOME_DIST;
    },
    /** Pull back until every system is in frame — the size differentiation is
     *  only visible from out here, and home framing deliberately isn't. */
    fitAll() {
      select(null);
      flyTarget = new THREE.Vector3(0, 0, 0);
      distTarget = fitAllDist;
    },
    focusNode(id: string) {
      select(id);   // Atlas navigation: same flight + highlight as a click
    },
    configure(options: Record<string, unknown>) {
      if (typeof options.rotationSpeed === 'number') rotationSpeed = options.rotationSpeed;
      if (typeof options.labelScale === 'number') labelScale = options.labelScale;
      if (options.labelMode === 'auto' || options.labelMode === 'on' || options.labelMode === 'off') {
        labelMode = options.labelMode;
      }
    },
    setActivity(state: { active: boolean; kind?: 'thinking' | 'dispatch' | 'tool' | 'listening' }) {
      if (state.kind === 'listening') return;   // mic state has no universe treatment
      act = { active: state.active, at: performance.now() };
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      for (const d of dying) { scene.remove(d.group); disposeTree(d.group); }
      dying.length = 0;
      disposeTree(dataRoot);
      disposeTree(ambient);
      for (const s of shared) s.dispose();
      composer.dispose();
      renderer.dispose();
      // deliberately NO forceContextLoss(): StrictMode double-runs effects on
      // the same canvas (ThemePreview), and a force-lost context can never be
      // re-adopted — three dies reading getShaderPrecisionFormat(). dispose()
      // frees the GPU resources; the context is released with its canvas
      // element (Brain.tsx remounts the canvas per renderer creation).
    },
  };
}
