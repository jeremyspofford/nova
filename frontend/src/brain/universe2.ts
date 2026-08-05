/** Nova Universe (2) — the v0.1.0-alpha "Galaxy" brain, rebuilt.
 *
 * The alpha's brain page (dashboard/src/components/ForceGraph3D.tsx at tag
 * v0.1.0-alpha) drew the whole graph as a star field: every node a luminous
 * star, clusters as glowing nebulae, structure found by a 3D force layout
 * rather than declared by an orrery. That is a genuinely different reading of
 * the same data than the Universe theme next door — Universe says "here is
 * Nova's solar system, and everything has an assigned place"; this one says
 * "here is the shape your knowledge actually has". Both are worth having, so
 * this is a fifth theme rather than a replacement.
 *
 * Rebuilt, not ported: alpha tags are reference-only (CLAUDE.md), and the
 * alpha leaned on `3d-force-graph`, which this repo does not carry. What is
 * carried over is the *recipe* — instanced star shader with a soft radial
 * falloff and a white-hot core, GPU-side breathing and birth fade, cluster
 * gravity on a Fibonacci shell, semantic-zoom labels, deep-field backdrop,
 * UnrealBloom — reimplemented against our own layout math and our own data.
 *
 * Clustering is NOT re-derived here: it comes from systems.ts, the same
 * computation the Universe view and the Atlas use, so the three can never
 * disagree about which memories belong together.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { GraphNode, GraphEdge } from '../api';
import type { LegendEntry, RendererHandle, RendererOpts } from './theme';
import { computeSystems, hashStr, TAG_COLORS } from './systems';

// ── palette ──────────────────────────────────────────────────────────────
// Memory bodies take their system's colour (that IS the alpha's "domain"
// colour mode). Platform entities keep the type colours the other themes use,
// so a violet dot means "agent" everywhere in the app.
const TYPE_COLOR: Record<string, string> = {
  core: '#ffd27a',
  user: '#cfe0ff',
  agent: '#a78bfa',
  tool: '#84a98c',
  automation: '#60a5fa',
  rule: '#f87171',
  skill: '#fbbf24',
  journal: '#a8a29e',
  source: '#818cf8',
  topic: '#22d3ee',
};
const ROGUE_COLOR = '#5b6472';

export const UNIVERSE2_LEGEND: LegendEntry[] = [
  { key: 'core', color: TYPE_COLOR.core, label: 'Nova', note: 'the bright star at the centre' },
  { key: 'user', color: TYPE_COLOR.user, label: 'You', note: 'beside her' },
  { key: 'topic', color: TAG_COLORS[0], label: 'Memories', note: 'stars, coloured by the cluster they fell into' },
  { key: 'journal', color: TYPE_COLOR.journal, label: 'Journals', note: 'their own drift of pale stars' },
  { key: 'source', color: TYPE_COLOR.source, label: 'Sources', note: 'stars in the cluster they feed' },
  { key: 'agent', color: TYPE_COLOR.agent, label: 'Agents', note: 'close in around Nova' },
  { key: 'tool', color: TYPE_COLOR.tool, label: 'Tools', note: 'bound to the agent granted them' },
  { key: 'automation', color: TYPE_COLOR.automation, label: 'Automations' },
  { key: 'rule', color: TYPE_COLOR.rule, label: 'Rules' },
  { key: 'skill', color: TYPE_COLOR.skill, label: 'Skills' },
  { color: ROGUE_COLOR, label: 'Rogue memory', note: 'dim and adrift — nothing links it' },
  { color: '#e879f9', label: 'Shared subject', note: 'faint thread between clusters about the same thing' },
];

/** Sprites on this layer skip the bloom chain and draw in a crisp overlay
 *  pass — the same trick universe.ts uses. Text must never glow. */
const LABEL_LAYER = 1;

// ── layout constants ─────────────────────────────────────────────────────
/** Rest length of a drawn edge, by kind. Grants sit tight (a tool belongs to
 *  its agent); plain memory links sit loose enough to read as a web. */
const SPRING_LEN: Record<string, number> = {
  link: 62, platform: 78, grant: 34, guard: 40, writes: 66, bond: 46,
};
/** Edge kinds that are drawn but kept OUT of the simulation. `tag` is a
 *  co-tagging chain artifact (ROADMAP #37) and isn't drawn at all; `subject`
 *  is a true claim, but it spans clusters, and letting it pull would drag two
 *  otherwise-separate systems into one blob — the exact structure this view
 *  exists to show. */
const UNSIMULATED = new Set(['subject']);
const DRAWN_KINDS = new Set([...Object.keys(SPRING_LEN), ...UNSIMULATED]);

const PLATFORM_TYPES = new Set(['core', 'user', 'agent', 'tool', 'automation', 'rule', 'skill']);

/** Frames of settling before the layout freezes. The stars visibly fly into
 *  place on arrival — that motion is the point, it's how the alpha read. */
const SETTLE_FRAMES = 150;
const STEPS_PER_FRAME = 6;

/** Nothing renders past this. 342 nodes today; the cap is a floor under the
 *  frame rate on a graph that grows, and it announces itself (console) rather
 *  than silently drawing a partial universe. */
const MAX_STARS = 1500;

const FOV = 52;
const FOV_TAN = Math.tan((FOV * Math.PI) / 360);
/** Camera distance at which a sphere of `radius` fills half the viewport. */
const frameDist = (radius: number) => (2 * radius) / FOV_TAN;

/** Deterministic PRNG (galaxy's recipe) — a reload must not reshuffle the sky. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly-spread points on a sphere — cluster homes, and the star dome. */
function fibonacci(i: number, n: number, radius: number, out: THREE.Vector3) {
  const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * i;
  return out.set(Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius);
}

// ── textures ─────────────────────────────────────────────────────────────
/** Soft radial glow — used for cluster halos and the two anchor stars. */
function makeGlowTexture(): THREE.CanvasTexture {
  const S = 128, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(C, C, 0, C, C, C);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.16)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Lumpy nebula cloud. One texture, tinted per sprite — a nebula that is
 *  radially symmetric reads as a lens flare, so the lumps matter. */
function makeNebulaTexture(seed: number): THREE.CanvasTexture {
  const S = 256, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  const rnd = mulberry32(seed);
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.pow(rnd(), 0.7) * C * 0.62;
    const px = C + Math.cos(a) * d, py = C + Math.sin(a) * d;
    const r = C * (0.14 + rnd() * 0.3);
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(255,255,255,${(0.05 + rnd() * 0.07).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.beginPath();
    x.arc(px, py, r, 0, Math.PI * 2);
    x.fill();
  }
  // vignette the edges to nothing, or the sprite's square shows at low alpha
  x.globalCompositeOperation = 'destination-in';
  const v = x.createRadialGradient(C, C, C * 0.15, C, C, C * 0.5);
  v.addColorStop(0, 'rgba(0,0,0,1)');
  v.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = v;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A far-off spiral, seen at an angle. Pure set dressing. */
function makeGalaxyTexture(): THREE.CanvasTexture {
  const S = 128, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  x.translate(C, C);
  x.scale(1, 0.38);            // the tilt
  x.globalCompositeOperation = 'lighter';
  const rnd = mulberry32(0x51a4);
  for (let i = 0; i < 900; i++) {
    const t = rnd();
    const arm = Math.floor(rnd() * 2) * Math.PI;
    const a = arm + t * 5.2 + (rnd() - 0.5) * 0.55;
    const r = t * C * 0.92;
    x.fillStyle = `rgba(${210 + rnd() * 45 | 0},${205 + rnd() * 40 | 0},255,${(0.5 * (1 - t)).toFixed(3)})`;
    x.fillRect(Math.cos(a) * r, Math.sin(a) * r, 1.3, 1.3);
  }
  const g = x.createRadialGradient(0, 0, 0, 0, 0, C * 0.34);
  g.addColorStop(0, 'rgba(255,246,222,0.85)');
  g.addColorStop(1, 'rgba(255,240,210,0)');
  x.fillStyle = g;
  x.beginPath();
  x.arc(0, 0, C * 0.34, 0, Math.PI * 2);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── the star shader ──────────────────────────────────────────────────────
// Every per-star animation lives here, on the GPU. The alpha's own audit is
// the reason: it ran three JS forEach loops over every node every frame
// (breathing, highlight, birth) and measured 4 FPS. Breathing is a sine of a
// uniform; birth and highlight are ramps off per-instance timestamps. The CPU
// touches an instance only when the DATA changes.
const STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aImp;      // 0..1 importance — size, brightness, alpha
  attribute float aBirth;    // seconds; drives the fade-in
  attribute float aSeed;     // decorrelates the breathing
  attribute float aFocus;    // 1 = selected or a neighbour of it

  varying float vFacing;
  varying vec3 vColor;
  varying float vImp;
  varying float vBirth;
  varying float vSeed;
  varying float vFocus;
  varying float vRadius;     // distance from the origin — the pulse ripple

  void main() {
    vec4 world = instanceMatrix * vec4(position, 1.0);
    vec4 mv = modelViewMatrix * world;
    // uniform per-instance scale, so the normal matrix alone is enough
    vec3 n = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vFacing = dot(n, normalize(-mv.xyz));
    vColor = aColor; vImp = aImp; vBirth = aBirth; vSeed = aSeed; vFocus = aFocus;
    vRadius = length((instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uDim;        // 0..1 — how hard to push everything unfocused back
  uniform float uPulseT;     // seconds since the last activity pulse (<0 = none)
  uniform float uPulseSpeed;

  varying float vFacing;
  varying vec3 vColor;
  varying float vImp;
  varying float vBirth;
  varying float vSeed;
  varying float vFocus;
  varying float vRadius;

  void main() {
    float f = max(vFacing, 0.0);
    float glow = pow(f, 1.9);            // soft body, no hard sphere edge
    float core = pow(f, 9.0);            // the white-hot pinprick
    float breathe = 1.0 + sin(uTime * 0.55 + vSeed * 6.2831) * 0.09;
    float birth = clamp((uTime - vBirth) / 1.1, 0.0, 1.0);

    float level = (0.30 + vImp * 0.75) * breathe;
    vec3 col = vColor * glow * level + vec3(1.0) * core * level * 0.62;

    // Activity ripple: a shell of light expanding from Nova, so a turn in
    // progress is visible as the graph reacting rather than as a spinner.
    if (uPulseT >= 0.0) {
      float d = (vRadius - uPulseT * uPulseSpeed) / 110.0;
      float ring = exp(-d * d) * max(0.0, 1.0 - uPulseT / 2.8);
      col += vColor * ring * 0.85 + vec3(1.0) * ring * 0.22;
    }

    float mute = mix(1.0, 0.13, uDim * (1.0 - vFocus));
    float alpha = clamp(glow * (0.34 + vImp * 0.66) + core * 0.5, 0.0, 1.0)
                * birth * mix(1.0, 0.3, uDim * (1.0 - vFocus));
    // linear out, on purpose: RenderPass draws into a linear target and
    // OutputPass does tone mapping + the sRGB transfer at the end of the
    // chain. Converting here would apply it twice.
    gl_FragColor = vec4(col * mute, alpha);
  }
`;

// Edges get their own tiny program because LineBasicMaterial has no per-vertex
// alpha, and the alpha's "gradient" style is exactly that: full colour at each
// endpoint, dissolving at the midpoint so the web reads as connection rather
// than as a cage of wires.
const EDGE_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aFocus;
  varying vec3 vColor; varying float vAlpha; varying float vFocus;
  void main() {
    vColor = aColor; vAlpha = aAlpha; vFocus = aFocus;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const EDGE_FRAG = /* glsl */ `
  uniform float uDim;
  varying vec3 vColor; varying float vAlpha; varying float vFocus;
  void main() {
    float mute = mix(1.0, 0.06, uDim * (1.0 - vFocus));
    gl_FragColor = vec4(vColor * mute, vAlpha * mute);
  }
`;

/** What a star's colour means. `cluster` is the alpha's "domain" mode. */
type ColorMode = 'cluster' | 'type' | 'importance';
/** How links are drawn — the alpha's three edge styles. */
type EdgeStyle = 'animated' | 'gradient' | 'static';

/** The single hue used when colour carries no information and brightness is
 *  left to say everything (importance mode). Deliberately NOT a teal: topics
 *  are teal in `type` mode, and the two modes have to be distinguishable at a
 *  glance or the toggle is decoration. */
const IMPORTANCE_HEX = '#bcd4ea';
const STATIC_EDGE_HEX = '#c8d4e4';

interface Star {
  node: GraphNode;
  group: string;
  /** Live colour under the current mode — the two candidates it picks from
   *  are kept so a mode switch never needs a rebuild. */
  color: THREE.Color;
  clusterHex: string;
  typeHex: string;
  imp: number;
  radius: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  home: THREE.Vector3;   // centre of the sphere this star is contained in
  reach: number;         // radius of that sphere — free movement inside it
  pinned: boolean;
}

interface LabelEntry {
  kind: 'star' | 'cluster';
  text: string;
  color: string;
  /** Star labels track their star; cluster labels sit at a fixed centroid. */
  starIndex: number;
  at: THREE.Vector3;
  /** Scale of the thing this label belongs to — semantic zoom keys off it. */
  extent: number;
  height: number;
  sprite: THREE.Sprite | null;
  /** Screen AABB + eased acceptance, refreshed by the declutter pass. */
  sx: number; sy: number; sw: number; sh: number; vis: number;
}

export function createUniverse2(canvas: HTMLCanvasElement, opts?: RendererOpts): RendererHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#04040a');

  const camera = new THREE.PerspectiveCamera(
    FOV, (canvas.width || 300) / (canvas.height || 150), 1, 40000);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Threshold well above zero on purpose: the whole scene is soft glow, and a
  // low threshold blooms the halos and the edge web too, which is what turns
  // a star field into white fog.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(canvas.width || 300, canvas.height || 150), 0.62, 0.55, 0.42);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // shared assets — built once per renderer, disposed once in destroy()
  const glowTex = makeGlowTexture();
  const galaxyTex = makeGalaxyTexture();
  const nebulaTex = [0x1f3a, 0x77c1, 0xa9e4].map(makeNebulaTexture);
  const starGeo = new THREE.SphereGeometry(1, 10, 8);
  const hitGeo = new THREE.SphereGeometry(1, 6, 4);
  const shared = new Set<THREE.Texture | THREE.BufferGeometry>(
    [glowTex, galaxyTex, ...nebulaTex, starGeo, hitGeo]);

  // ── runtime settings (Brain HUD → configure()) ──────────────────────────
  let rotationSpeed = 1;
  let labelMode: 'auto' | 'on' | 'off' = 'auto';
  let labelScale = 1;
  let colorMode: ColorMode = 'cluster';
  let edgeStyle: EdgeStyle = 'animated';
  /** Pixels of the canvas covered by the Atlas on the left. The scene is
   *  re-centred into the clear band rather than hiding behind the panel. */
  let leftInset = 0;

  // ── camera ──────────────────────────────────────────────────────────────
  let yaw = 0.7, pitch = 0.3;
  let worldExtent = 900;
  let dist = frameDist(worldExtent) / 2;
  let zoomMin = 8, zoomMax = frameDist(worldExtent) * 3;
  const clampDist = (d: number) => Math.max(zoomMin, Math.min(zoomMax, d));
  const camTarget = new THREE.Vector3();
  let flyTarget: THREE.Vector3 | null = null;
  let distTarget: number | null = null;

  function applyCamera() {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    camera.position.set(
      camTarget.x + dist * cp * Math.cos(yaw),
      camTarget.y + dist * sp,
      camTarget.z + dist * cp * Math.sin(yaw));
    camera.up.set(0, cp >= 0 ? 1 : -1, 0);
    camera.lookAt(camTarget);
  }

  /** Shift the projection so the scene centres in the band the panels leave.
   *  A negative x offset widens the view to the left of the canvas, which
   *  moves everything drawn to the right — exactly the correction wanted.
   *  Picking stays honest because Raycaster inverts this same matrix. */
  function applyViewOffset() {
    const w = renderer.domElement.clientWidth || canvas.width || 1;
    const h = renderer.domElement.clientHeight || canvas.height || 1;
    if (leftInset > 2) camera.setViewOffset(w, h, -leftInset / 2, 0, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  // ── backdrop (built once, rides the camera so the field never ends) ─────
  const backdrop = new THREE.Group();
  scene.add(backdrop);

  function starLayer(count: number, rMin: number, rMax: number,
                     size: number, opacity: number, seed: number,
                     flatten = 1): THREE.Points {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const r = rMin + rnd() * (rMax - rMin);
      const theta = rnd() * Math.PI * 2;
      // flatten < 1 squashes the shell toward a plane — the galactic band
      const phi = Math.acos(2 * rnd() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) * flatten;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      // real star colours run blue-white through gold; a grey field looks dead
      const t = rnd();
      c.setHSL(t < 0.7 ? 0.58 - t * 0.1 : 0.09 + rnd() * 0.05,
               t < 0.7 ? 0.35 : 0.6, 0.62 + rnd() * 0.3);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, opacity,
      sizeAttenuation: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
  }

  const skyLayers = [
    starLayer(4500, 6000, 15000, 1.6, 0.85, 0xbeef, 1),
    starLayer(6000, 15000, 32000, 1.1, 0.5, 0xcafe, 1),
    starLayer(5000, 5000, 26000, 1.3, 0.55, 0xf00d, 0.12),   // the galactic band
  ];
  const skyBaseOpacity = skyLayers.map(p => (p.material as THREE.PointsMaterial).opacity);
  for (const l of skyLayers) backdrop.add(l);

  /** The sky holds a fixed number of points at a fixed pixel size, so the
   *  smaller the canvas the denser it reads — on a 220x130 theme-preview card
   *  15,500 of them are a wall of static rather than a star field. Fade the
   *  field with the viewport so it stays a backdrop at any size. */
  function applySkyDensity(width: number, height: number) {
    const k = Math.max(0.3, Math.min(1, Math.sqrt((width * height) / (1200 * 700))));
    skyLayers.forEach((l, i) => {
      (l.material as THREE.PointsMaterial).opacity = skyBaseOpacity[i] * k;
    });
  }

  {
    const rnd = mulberry32(0x2b17);
    const tints = ['#3b2f6b', '#1f4f63', '#5c2f52', '#2a4a3c', '#4a3560'];
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: nebulaTex[i % nebulaTex.length], color: tints[i],
        transparent: true, opacity: 0.42, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      const p = fibonacci(i, 5, 11000 + rnd() * 6000, new THREE.Vector3());
      s.position.copy(p);
      const sc = 9000 + rnd() * 7000;
      s.scale.set(sc, sc * (0.6 + rnd() * 0.5), 1);
      backdrop.add(s);
    }
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: galaxyTex, transparent: true, opacity: 0.32 + rnd() * 0.2,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      s.position.copy(fibonacci(i * 2 + 1, 7, 17000 + rnd() * 8000, new THREE.Vector3()));
      const sc = 2400 + rnd() * 2600;
      s.scale.set(sc, sc, 1);
      backdrop.add(s);
    }
  }

  // ── data-derived scene (rebuilt on setData) ─────────────────────────────
  const dataRoot = new THREE.Group();
  scene.add(dataRoot);

  let stars: Star[] = [];
  let indexById = new Map<string, number>();
  let simEdges: { a: number; b: number; len: number }[] = [];
  /** Star indices bucketed by cluster — repulsion is intra-cluster, and
   *  rebuilding this grouping inside every one of the ~900 solver steps was
   *  more work than the solver itself. */
  let clusterIndices: number[][] = [];
  /** Per-node neighbour ids over drawn edges — selection lights these up. */
  let neighbours = new Map<string, Set<string>>();
  let labels: LabelEntry[] = [];
  let starMesh: THREE.InstancedMesh | null = null;
  let hitMesh: THREE.InstancedMesh | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  let flowPoints: THREE.Points | null = null;
  let flow: { a: number; b: number; phase: number; speed: number }[] = [];
  /** Per-edge facts the style pass needs — kept so switching link style (or
   *  colour mode) rewrites two buffers instead of rebuilding the scene. */
  let edgeMeta: { a: number; b: number; cross: boolean; fadeA: number; fadeB: number }[] = [];
  let haloSprites: { sprite: THREE.Sprite; center: THREE.Vector3; extent: number }[] = [];
  let anchorHalos: THREE.Sprite[] = [];
  let settleLeft = 0;
  let framed = false;
  let fingerprint = '';
  /** Positions survive a rebuild: the graph is re-polled every 20s, and a
   *  layout that re-shuffled on each poll would be unusable. */
  const posCache = new Map<string, THREE.Vector3>();

  const starUniforms = {
    uTime: { value: 0 },
    uDim: { value: 0 },
    uPulseT: { value: -1 },
    uPulseSpeed: { value: 900 },
  };
  const edgeUniforms = { uDim: { value: 0 } };

  let selectedId: string | null = null;
  let hoveredId: string | null = null;

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const DISABLED = new THREE.Color('#4b4b4b');

  /** The hex a star wears under the current colour mode. */
  function starHex(s: Star): string {
    if (colorMode === 'type') return s.typeHex;
    if (colorMode === 'importance') {
      // The two anchors keep their identity in every mode. They are how you
      // orient in here, not data points to be flattened with the rest.
      return s.node.type === 'core' || s.node.type === 'user' ? s.typeHex : IMPORTANCE_HEX;
    }
    return s.clusterHex;
  }

  function resolveStarColors() {
    for (const s of stars) {
      s.color.set(starHex(s));
      if (s.node.enabled === false) s.color.lerp(DISABLED, 0.6);
    }
  }

  function disposeTree(root: THREE.Object3D) {
    root.traverse(o => {
      const mesh = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
      // Every Sprite in the process shares ONE module-level geometry inside
      // three — disposing it here would yank the buffers out from under every
      // other sprite on the page, including the other themes' previews.
      if ((o as THREE.Sprite).isSprite) { /* geometry is three's, not ours */ }
      else if (mesh.geometry && !shared.has(mesh.geometry)) mesh.geometry.dispose();
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        const map = (m as THREE.SpriteMaterial).map;
        if (map && !shared.has(map)) map.dispose();
        m.dispose();
      }
    });
    root.clear();
  }

  /** Label sprite. Created lazily — a graph of 342 nodes would otherwise
   *  allocate 342 canvas textures up front for text most of which is never
   *  on screen at once. */
  function makeSprite(entry: LabelEntry): THREE.Sprite {
    const fontPx = 44, pad = 26;
    const c = document.createElement('canvas');
    const measure = c.getContext('2d')!;
    const font = `600 ${fontPx}px system-ui, sans-serif`;
    measure.font = font;
    const t = entry.text.length > 32 ? entry.text.slice(0, 30) + '…' : entry.text;
    c.width = Math.ceil(measure.measureText(t).width) + pad * 2;
    c.height = fontPx + pad * 2;
    const x = c.getContext('2d')!;
    x.fillStyle = 'rgba(5, 7, 12, 0.55)';
    x.beginPath();
    x.roundRect(5, 7, c.width - 10, c.height - 14, 14);
    x.fill();
    x.font = font;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.shadowColor = entry.color;
    x.shadowBlur = entry.kind === 'cluster' ? 18 : 9;
    x.fillStyle = entry.kind === 'cluster' ? entry.color : 'rgba(240,246,250,0.97)';
    x.fillText(t, c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
      toneMapped: false,
    }));
    sprite.layers.set(LABEL_LAYER);
    sprite.scale.set(entry.height * (c.width / c.height), entry.height, 1);
    sprite.visible = false;
    dataRoot.add(sprite);
    return sprite;
  }

  // ── build ───────────────────────────────────────────────────────────────
  function build(nodes: GraphNode[], edges: GraphEdge[]) {
    disposeTree(dataRoot);
    stars = []; indexById = new Map(); simEdges = []; labels = [];
    flow = []; haloSprites = []; anchorHalos = []; clusterIndices = []; edgeMeta = [];
    starMesh = hitMesh = null; edgeLines = null; flowPoints = null;

    if (!nodes.length) return;

    const { systems, rogues } = computeSystems(nodes, edges);
    const groupOf = new Map<string, string>();
    const sysColor = new Map<string, string>();
    for (const s of systems) {
      sysColor.set(`sys:${s.key}`, s.color);
      for (const m of s.members) groupOf.set(m.id, `sys:${s.key}`);
    }
    for (const r of rogues) groupOf.set(r.id, 'rogue');

    // degree over drawn edges — the alpha's "importance", derived rather than
    // stored, so a memory that gets linked to gets brighter by itself
    const degree = new Map<string, number>();
    neighbours = new Map();
    for (const e of edges) {
      if (!DRAWN_KINDS.has(e.kind)) continue;
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      (neighbours.get(e.source) ?? neighbours.set(e.source, new Set()).get(e.source)!).add(e.target);
      (neighbours.get(e.target) ?? neighbours.set(e.target, new Set()).get(e.target)!).add(e.source);
    }

    const nowSec = Date.now() / 1000;
    const rank = (n: GraphNode) => {
      const deg = degree.get(n.id) ?? 0;
      const ageDays = Math.max(0, (nowSec - (n.mtime || nowSec)) / 86400);
      const fresh = Math.exp(-ageDays / 21);
      let imp = 0.12 + 0.55 * Math.min(1, deg / 9) + 0.28 * fresh;
      if (n.type === 'core') imp = 1;
      else if (n.type === 'user') imp = 0.86;
      else if (n.type === 'agent') imp = Math.max(imp, 0.62);
      else if (n.type === 'skill') imp = Math.max(imp, 0.5);
      else if (n.type === 'journal') imp = Math.min(imp, 0.42);
      if (n.enabled === false) imp *= 0.45;
      return Math.min(1, imp);
    };

    // A graph past the cap loses its faintest stars, and says so — a view
    // that silently drew 1500 of 4000 nodes would read as "that's all of it".
    let drawn = nodes;
    if (nodes.length > MAX_STARS) {
      drawn = [...nodes].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_STARS);
      console.warn(`Nova Universe (2): drawing the ${MAX_STARS} most-connected of `
        + `${nodes.length} nodes — the rest are omitted for frame rate.`);
    }
    const drawnIds = new Set(drawn.map(n => n.id));

    // ── groups and their homes ────────────────────────────────────────────
    // 'home' is Nova's own system and sits at the origin; every memory system
    // gets a slot on a Fibonacci shell, so the sky is evenly filled and the
    // arrangement is identical on every reload.
    for (const n of drawn) {
      if (PLATFORM_TYPES.has(n.type)) groupOf.set(n.id, 'home');
      else if (n.type === 'journal') groupOf.set(n.id, 'journals');
      else if (!groupOf.has(n.id)) groupOf.set(n.id, 'rogue');
    }
    const memberCount = new Map<string, number>();
    for (const n of drawn) {
      const g = groupOf.get(n.id)!;
      memberCount.set(g, (memberCount.get(g) ?? 0) + 1);
    }
    const shellGroups = [...memberCount.keys()]
      .filter(g => g !== 'home' && g !== 'rogue')
      .sort();
    const biggest = Math.max(1, ...memberCount.values());
    /** Radius a cluster of `k` members occupies once settled — used both to
     *  space the shell and to size halos and the semantic-zoom handover.
     *  The normaliser in step() makes this a promise rather than a guess. */
    const clusterExtent = (k: number) => 46 + 30 * Math.sqrt(k);
    // Nearest-neighbour spacing on a Fibonacci sphere of radius R runs about
    // 1.2R for a handful of points, so 2.2x the largest cluster leaves roughly
    // a cluster's width of empty sky between neighbours.
    const shellR = Math.max(520, 2.2 * clusterExtent(biggest));

    const groupHome = new Map<string, THREE.Vector3>();
    groupHome.set('home', new THREE.Vector3(0, 0, 0));
    shellGroups.forEach((g, i) => {
      const p = fibonacci(i, shellGroups.length, shellR, new THREE.Vector3());
      // hash-seeded jitter so the shell doesn't read as a machined lattice
      const rnd = mulberry32(hashStr(g));
      p.multiplyScalar(0.82 + rnd() * 0.36);
      groupHome.set(g, p);
    });

    // ── stars ─────────────────────────────────────────────────────────────
    for (const n of drawn) {
      const g = groupOf.get(n.id)!;
      const imp = rank(n);
      const clusterHex = PLATFORM_TYPES.has(n.type) ? TYPE_COLOR[n.type] ?? TYPE_COLOR.topic
        : n.type === 'journal' ? TYPE_COLOR.journal
          : g === 'rogue' ? ROGUE_COLOR
            : sysColor.get(g) ?? TYPE_COLOR.topic;
      const typeHex = TYPE_COLOR[n.type] ?? TYPE_COLOR.topic;

      const rnd = mulberry32(hashStr(n.id));
      let home: THREE.Vector3;
      if (g === 'rogue') {
        // rogues get their OWN far slot rather than a shared one — an orphan
        // memory adrift alone is the signal; a tidy pile of orphans is not
        home = fibonacci(hashStr(n.id) % 997, 997, shellR * (1.12 + rnd() * 0.28),
                         new THREE.Vector3());
      } else {
        home = groupHome.get(g)!.clone();
      }
      const cached = posCache.get(n.id);
      const pos = cached ? cached.clone() : home.clone().add(new THREE.Vector3(
        (rnd() - 0.5), (rnd() - 0.5), (rnd() - 0.5)).multiplyScalar(clusterExtent(memberCount.get(g) ?? 1)));

      // Nova and the operator are anchors, not just the two most-connected
      // nodes — you should be able to find them without reading a label.
      const anchorScale = n.type === 'core' ? 2.4 : n.type === 'user' ? 1.6 : 1;
      indexById.set(n.id, stars.length);
      stars.push({
        node: n, group: g, color: new THREE.Color(), clusterHex, typeHex, imp,
        radius: (2.6 + imp * 7.4) * anchorScale,
        pos, vel: new THREE.Vector3(), home,
        reach: g === 'rogue' ? 30 : clusterExtent(memberCount.get(g) ?? 1),
        pinned: n.type === 'core',
      });
    }
    resolveStarColors();
    // Nova anchors the origin; nothing else is pinned, so the rest of the
    // home system arranges itself around her.
    for (const s of stars) if (s.pinned) s.pos.set(0, 0, 0);

    const buckets = new Map<string, number[]>();
    stars.forEach((s, i) => {
      (buckets.get(s.group) ?? buckets.set(s.group, []).get(s.group)!).push(i);
    });
    // rogues share a bucket name but not a home — they must not shove each
    // other, they are meant to be scattered
    clusterIndices = [...buckets.entries()].filter(([g]) => g !== 'rogue').map(([, v]) => v);

    // ── edges ─────────────────────────────────────────────────────────────
    const drawEdges = edges.filter(e =>
      DRAWN_KINDS.has(e.kind) && drawnIds.has(e.source) && drawnIds.has(e.target)
      && e.source !== e.target);
    for (const e of drawEdges) {
      if (UNSIMULATED.has(e.kind)) continue;
      const a = indexById.get(e.source)!, b = indexById.get(e.target)!;
      // Cross-cluster springs are dropped for the same reason `subject` is:
      // one stray link would otherwise reel a whole system into the middle.
      if (stars[a].group !== stars[b].group) continue;
      // Jitter the rest length per edge. Identical lengths off a hub put every
      // satellite on one shell, which reads as a firework rather than as a
      // neighbourhood — hash-seeded, so the variation is stable across loads.
      const wobble = 0.7 + (hashStr(`${e.source}>${e.target}`) % 1000) / 1000 * 0.75;
      simEdges.push({ a, b, len: (SPRING_LEN[e.kind] ?? 60) * wobble });
    }

    // 4 vertices per edge (end → mid, mid → end) is what buys the dissolve at
    // the midpoint: LineBasicMaterial has no per-vertex alpha at all.
    const verts = drawEdges.length * 4;
    const ePos = new Float32Array(verts * 3);
    const eCol = new Float32Array(verts * 3);
    const eAlpha = new Float32Array(verts);
    const eFocus = new Float32Array(verts);
    // Fade an edge by how busy its endpoint is. These lines blend additively,
    // so a node with 69 links stacks 69 of them into one point and burns out
    // the whole cluster, while a lone link between two memories — the more
    // informative edge of the two — is invisible beside it.
    const fade = (id: string) => 1 / Math.sqrt(1 + (degree.get(id) ?? 1) / 5);
    edgeMeta = drawEdges.map(e => ({
      a: indexById.get(e.source)!, b: indexById.get(e.target)!,
      cross: UNSIMULATED.has(e.kind),
      fadeA: fade(e.source), fadeB: fade(e.target),
    }));
    const edgePairs = edgeMeta.map(m => ({ a: m.a, b: m.b }));
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    edgeGeo.setAttribute('aColor', new THREE.BufferAttribute(eCol, 3));
    edgeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(eAlpha, 1));
    edgeGeo.setAttribute('aFocus', new THREE.BufferAttribute(eFocus, 1));
    edgeLines = new THREE.LineSegments(edgeGeo, new THREE.ShaderMaterial({
      uniforms: edgeUniforms, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    edgeLines.frustumCulled = false;
    edgeLines.userData.pairs = edgePairs;
    dataRoot.add(edgeLines);
    applyEdgeStyle();

    // Sparse drift along the edges — the alpha's "animated particles" style.
    // Purely decorative, so the cap past 900 edges is a cap on the DECORATION,
    // not on what is drawn: every edge still has its line either way.
    const flowEdges = edgePairs.slice(0, 900);
    if (flowEdges.length) {
      const per = 2;
      const fPos = new Float32Array(flowEdges.length * per * 3);
      const fCol = new Float32Array(flowEdges.length * per * 3);
      flowEdges.forEach(p => {
        for (let k = 0; k < per; k++) {
          const rnd = mulberry32(hashStr(`${p.a}:${p.b}:${k}`));
          flow.push({ a: p.a, b: p.b, phase: rnd(), speed: 0.06 + rnd() * 0.12 });
        }
      });
      const fGeo = new THREE.BufferGeometry();
      fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
      fGeo.setAttribute('color', new THREE.BufferAttribute(fCol, 3));
      flowPoints = new THREE.Points(fGeo, new THREE.PointsMaterial({
        size: 2.4, vertexColors: true, transparent: true, opacity: 0.85,
        sizeAttenuation: false, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      flowPoints.frustumCulled = false;
      // applyEdgeStyle() already ran above, before this object existed — the
      // one thing it could not set is whether the drift is on at all.
      flowPoints.visible = edgeStyle === 'animated';
      dataRoot.add(flowPoints);
      applyFlowColors();
    }

    // ── instanced stars ───────────────────────────────────────────────────
    const n = stars.length;
    const aColor = new Float32Array(n * 3);
    const aImp = new Float32Array(n);
    const aBirth = new Float32Array(n);
    const aSeed = new Float32Array(n);
    const aFocus = new Float32Array(n);
    const born = starUniforms.uTime.value;
    stars.forEach((s, i) => {
      aColor[i * 3] = s.color.r; aColor[i * 3 + 1] = s.color.g; aColor[i * 3 + 2] = s.color.b;
      aImp[i] = s.imp;
      // A star already on screen must not flash back in on the next poll.
      aBirth[i] = posCache.has(s.node.id) ? born - 2 : born;
      aSeed[i] = (hashStr(s.node.id) % 1000) / 1000;
    });
    const geo = starGeo.clone();
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
    geo.setAttribute('aImp', new THREE.InstancedBufferAttribute(aImp, 1));
    geo.setAttribute('aBirth', new THREE.InstancedBufferAttribute(aBirth, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
    geo.setAttribute('aFocus', new THREE.InstancedBufferAttribute(aFocus, 1));
    starMesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
      uniforms: starUniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthWrite: false,
    }), n);
    starMesh.frustumCulled = false;
    dataRoot.add(starMesh);

    // Picking gets its own oversized invisible geometry: a 3px star is
    // impossible to click otherwise, and the glow reads far larger than the
    // body does, so the visible mesh is the wrong hit target either way.
    hitMesh = new THREE.InstancedMesh(hitGeo,
      new THREE.MeshBasicMaterial({ visible: false }), n);
    hitMesh.frustumCulled = false;
    dataRoot.add(hitMesh);

    // Coronae for the two anchors. Everything else earns its light from the
    // instanced shader; these two get a real halo so they read as suns.
    for (const s of stars) {
      if (s.node.type !== 'core' && s.node.type !== 'user') continue;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: `#${s.color.getHexString()}`, transparent: true,
        // the operator's star is near-white already; at Nova's halo strength
        // it stops being a star and becomes a lamp
        opacity: s.node.type === 'core' ? 0.62 : 0.26,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.setScalar(s.radius * (s.node.type === 'core' ? 9 : 6));
      halo.userData.followStar = indexById.get(s.node.id);
      dataRoot.add(halo);
      anchorHalos.push(halo);
    }

    // ── cluster halos + labels ────────────────────────────────────────────
    for (const s of systems) {
      const g = `sys:${s.key}`;
      if (!memberCount.has(g)) continue;
      const extent = clusterExtent(memberCount.get(g)!);
      const center = groupHome.get(g)!.clone();
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: nebulaTex[hashStr(s.key) % nebulaTex.length], color: s.color,
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.position.copy(center);
      // 2.4x the cluster, not 5x: a halo wider than the gap to the next
      // cluster stops reading as "this group" and starts reading as fog
      sprite.scale.setScalar(extent * 2.4);
      dataRoot.add(sprite);
      haloSprites.push({ sprite, center, extent });
      labels.push({
        kind: 'cluster', text: s.name, color: s.color, starIndex: -1,
        // A cluster name has to be readable from the fit-all distance, which
        // is set by the SHELL, not by the cluster — the smallest clusters had
        // 15px names out there when the height came from extent alone.
        at: center, extent, height: Math.max(shellR * 0.11, extent * 0.34), sprite: null,
        sx: 0, sy: 0, sw: 0, sh: 0, vis: 0,
      });
    }

    stars.forEach((s, i) => {
      const extent = clusterExtent(memberCount.get(s.group) ?? 1);
      labels.push({
        kind: 'star', text: s.node.label, color: `#${s.color.getHexString()}`,
        starIndex: i, at: s.pos, extent,
        height: s.node.type === 'core' ? 30 : s.node.type === 'user' ? 24 : 17,
        sprite: null, sx: 0, sy: 0, sw: 0, sh: 0, vis: 0,
      });
    });

    // A cached layout is already settled; a fresh one gets the full arrival.
    const firstBuild = !framed;
    settleLeft = posCache.size ? Math.round(SETTLE_FRAMES * 0.35) : SETTLE_FRAMES;
    syncInstances();
    refreshFocus();
    // You arrive looking at the whole sky. Framing at creation time is too
    // early — worldExtent isn't known until there are stars to measure.
    if (firstBuild) {
      framed = true;
      dist = frameDist(worldExtent) / 1.7;
    }
  }

  // ── the force layout ────────────────────────────────────────────────────
  // Deliberately hand-rolled: the repo already decided against a force-graph
  // dependency, and what this needs is small — repulsion inside a cluster,
  // springs on real edges, gravity toward the cluster's home. Repulsion is
  // intra-cluster only, which is both the cheap version (127² beats 342²) and
  // the correct one: clusters are held apart by their homes, and letting them
  // shove each other only fights that.
  function step(dt: number) {
    for (const idx of clusterIndices) {
      for (let ii = 0; ii < idx.length; ii++) {
        for (let jj = ii + 1; jj < idx.length; jj++) {
          const a = stars[idx[ii]], b = stars[idx[jj]];
          tmpV.subVectors(a.pos, b.pos);
          let d2 = tmpV.lengthSq();
          if (d2 > 160000) continue;             // 400 units — out of range
          if (d2 < 1) {
            // exactly-coincident stars need SOME separation direction, and it
            // has to be reproducible or the layout stops being deterministic
            tmpV.set(((ii % 7) - 3) / 3, ((jj % 5) - 2) / 2, ((ii + jj) % 3) - 1);
            if (tmpV.lengthSq() < 0.01) tmpV.set(1, 0, 0);
            d2 = 1;
          }
          const f = (9000 * dt) / d2;
          tmpV.normalize().multiplyScalar(f);
          a.vel.add(tmpV);
          b.vel.sub(tmpV);
        }
      }
    }

    for (const e of simEdges) {
      const a = stars[e.a], b = stars[e.b];
      tmpV.subVectors(b.pos, a.pos);
      const d = Math.max(0.01, tmpV.length());
      const f = ((d - e.len) / d) * 1.4 * dt;
      tmpV.multiplyScalar(f);
      a.vel.add(tmpV);
      b.vel.sub(tmpV);
    }

    for (const s of stars) {
      if (s.pinned) { s.pos.copy(s.home); s.vel.set(0, 0, 0); continue; }
      // Containment, not attraction. A point attractor whose pull grows with
      // distance always beats an inverse-square repulsion, and every cluster
      // collapses into a single bright knot (measured: it did). A cluster is
      // a SPHERE its members are free to move around inside, and the only
      // force toward home is the one that applies past its edge.
      const d = s.pos.distanceTo(s.home);
      if (d > s.reach) {
        tmpV.subVectors(s.home, s.pos).multiplyScalar(((d - s.reach) / d) * 0.35 * dt);
        s.vel.add(tmpV);
      }
      s.vel.multiplyScalar(0.88);
      const sp = s.vel.length();
      if (sp > 60) s.vel.multiplyScalar(60 / sp);
      s.pos.addScaledVector(s.vel, dt * 60);
    }

    // ── size normalisation ────────────────────────────────────────────────
    // Left to itself, a cluster settles at whatever radius its springs happen
    // to imply — and these clusters are hub-and-spoke (one source node here
    // has 69 links), so every leaf lands at exactly one rest-length and the
    // result is a pin-cushion the size of a spring. Rescaling each cluster
    // about its own home to a target radius decouples how big a cluster LOOKS
    // from how its edges are tuned: the force sim still decides the shape,
    // this only decides the scale. Pinned stars sit AT home, so they don't
    // move — Nova stays the origin no matter how the home system breathes.
    for (const idx of clusterIndices) {
      if (idx.length < 2) continue;
      const home = stars[idx[0]].home;
      let sum = 0;
      for (const i of idx) sum += stars[i].pos.distanceToSquared(home);
      const rms = Math.sqrt(sum / idx.length);
      if (rms < 1e-3) continue;
      const target = stars[idx[0]].reach * 0.62;
      // eased and clamped: a hard snap to target would undo the solver's work
      const s = Math.max(0.94, Math.min(1.06, 1 + (target / rms - 1) * 0.08));
      for (const i of idx) {
        const st = stars[i];
        if (st.pinned) continue;
        st.pos.sub(home).multiplyScalar(s).add(home);
      }
    }
  }

  /** Push current positions into the instance matrices, the edge buffer, and
   *  the position cache. Called while the layout settles, then not again. */
  function syncInstances() {
    if (!starMesh || !hitMesh) return;
    stars.forEach((s, i) => {
      tmpM.makeScale(s.radius, s.radius, s.radius).setPosition(s.pos);
      starMesh!.setMatrixAt(i, tmpM);
      const hit = Math.max(s.radius * 2.4, 9);
      tmpM.makeScale(hit, hit, hit).setPosition(s.pos);
      hitMesh!.setMatrixAt(i, tmpM);
    });
    starMesh.instanceMatrix.needsUpdate = true;
    hitMesh.instanceMatrix.needsUpdate = true;
    starMesh.computeBoundingSphere();
    hitMesh.computeBoundingSphere();

    if (edgeLines) {
      const pairs = edgeLines.userData.pairs as { a: number; b: number }[];
      const attr = edgeLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      pairs.forEach((p, i) => {
        const A = stars[p.a].pos, B = stars[p.b].pos;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, mz = (A.z + B.z) / 2;
        attr.setXYZ(i * 4, A.x, A.y, A.z);
        attr.setXYZ(i * 4 + 1, mx, my, mz);
        attr.setXYZ(i * 4 + 2, mx, my, mz);
        attr.setXYZ(i * 4 + 3, B.x, B.y, B.z);
      });
      attr.needsUpdate = true;
    }

    for (const halo of anchorHalos) {
      const i = halo.userData.followStar as number | undefined;
      if (i !== undefined && stars[i]) halo.position.copy(stars[i].pos);
    }

    // frame the whole thing: extent drives zoom limits and fitAll
    let far = 0;
    for (const s of stars) far = Math.max(far, s.pos.length() + s.radius);
    worldExtent = Math.max(200, far);
    zoomMax = frameDist(worldExtent) * 1.6;
    zoomMin = 6;
  }

  /** Write the current colour mode into the star instances, the anchor
   *  coronae and the labels. Cluster names keep the cluster's own colour in
   *  every mode — that colour is what the NAME means, not what its members
   *  happen to be painted right now. */
  function applyColors() {
    if (!starMesh) return;
    resolveStarColors();
    const attr = starMesh.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute;
    stars.forEach((s, i) => attr.setXYZ(i, s.color.r, s.color.g, s.color.b));
    attr.needsUpdate = true;

    for (const halo of anchorHalos) {
      const i = halo.userData.followStar as number | undefined;
      if (i !== undefined && stars[i]) {
        (halo.material as THREE.SpriteMaterial).color.copy(stars[i].color);
      }
    }

    // A label's colour is baked into its canvas, so it can't be recoloured —
    // it is dropped and lazily remade at whatever colour is current.
    for (const l of labels) {
      if (l.kind !== 'star' || !stars[l.starIndex]) continue;
      const hex = `#${stars[l.starIndex].color.getHexString()}`;
      if (hex === l.color) continue;
      l.color = hex;
      if (l.sprite) {
        const mat = l.sprite.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
        dataRoot.remove(l.sprite);
        l.sprite = null;
        l.vis = 0;
      }
    }

    applyFlowColors();
    applyEdgeStyle();
  }

  /** Drifting particles wear the colour of the star they left. */
  function applyFlowColors() {
    if (!flowPoints) return;
    const attr = flowPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    flow.forEach((f, i) => {
      const c = stars[f.a].color;
      attr.setXYZ(i, c.r, c.g, c.b);
    });
    attr.needsUpdate = true;
  }

  /** Write the current link style into the edge buffers.
   *
   *  `gradient` is the alpha's default: each end wears its own star's colour
   *  and the pair dissolves at the midpoint, so the web reads as connection
   *  rather than as a cage of wires. `animated` is the same at lower level
   *  with light drifting along it — the drift is the signal, so the line
   *  underneath gets out of its way. `static` is plain faint white: no colour
   *  claim at all, for when the stars should carry every bit of the meaning. */
  function applyEdgeStyle() {
    if (!edgeLines) return;
    const cAttr = edgeLines.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const aAttr = edgeLines.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    // shared-subject threads get their own colour in the coloured styles —
    // they are the one edge that means "these two clusters are about the
    // same thing" rather than "these two documents mention each other"
    const subject = new THREE.Color('#e879f9');
    const plain = new THREE.Color(STATIC_EDGE_HEX);

    edgeMeta.forEach((m, i) => {
      let ca: THREE.Color, cb: THREE.Color, endA: number, endB: number, mid: number;
      if (edgeStyle === 'static') {
        ca = cb = plain;
        endA = endB = mid = m.cross ? 0.035 : 0.085;
      } else {
        ca = m.cross ? subject : stars[m.a].color;
        cb = m.cross ? subject : stars[m.b].color;
        // A cross-cluster thread spans the whole sky, so at the brightness a
        // 60-unit link wants it reads as a laser through the scene. It is a
        // hint, not a structure — it gets a third of the light.
        const base = (m.cross ? 0.14 : 0.42) * (edgeStyle === 'animated' ? 0.62 : 1);
        endA = base * m.fadeA;
        endB = base * m.fadeB;
        mid = m.cross ? 0.006 : 0.022;
      }
      const cols = [ca, ca, cb, cb];
      const alphas = [endA, mid, mid, endB];
      for (let k = 0; k < 4; k++) {
        cAttr.setXYZ(i * 4 + k, cols[k].r, cols[k].g, cols[k].b);
        aAttr.setX(i * 4 + k, alphas[k]);
      }
    });
    cAttr.needsUpdate = true;
    aAttr.needsUpdate = true;
    if (flowPoints) flowPoints.visible = edgeStyle === 'animated';
  }

  /** Recompute the focus attribute: which stars and edges the selection lights
   *  up, and how hard everything else is pushed back. */
  function refreshFocus() {
    const focus = selectedId
      ? new Set<string>([selectedId, ...(neighbours.get(selectedId) ?? [])])
      : null;
    if (starMesh) {
      const attr = starMesh.geometry.getAttribute('aFocus') as THREE.InstancedBufferAttribute;
      stars.forEach((s, i) => attr.setX(i, focus ? (focus.has(s.node.id) ? 1 : 0) : 0));
      attr.needsUpdate = true;
    }
    if (edgeLines) {
      const pairs = edgeLines.userData.pairs as { a: number; b: number }[];
      const attr = edgeLines.geometry.getAttribute('aFocus') as THREE.BufferAttribute;
      pairs.forEach((p, i) => {
        const on = focus
          ? (focus.has(stars[p.a].node.id) && focus.has(stars[p.b].node.id)) ? 1 : 0
          : 0;
        for (let k = 0; k < 4; k++) attr.setX(i * 4 + k, on);
      });
      attr.needsUpdate = true;
    }
  }

  function select(id: string | null) {
    selectedId = id;
    refreshFocus();
    const i = id ? indexById.get(id) : undefined;
    if (i === undefined) { flyTarget = null; distTarget = null; return; }
    flyTarget = stars[i].pos.clone();
    distTarget = clampDist(Math.max(70, frameDist(stars[i].radius * 9) / 2));
  }

  // ── interaction ─────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const activePointers = new Map<number, { x: number; y: number }>();
  let dragging = false, panning = false, dragDist = 0, pinchDist = 0;
  let lastX = 0, lastY = 0, pointerDirty = false;

  function setNdc(e: { clientX: number; clientY: number }) {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function pick(): string | null {
    if (!hitMesh) return null;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(hitMesh, false);
    const id = hits[0]?.instanceId;
    return id === undefined ? null : stars[id]?.node.id ?? null;
  }

  const onPointerDown = (e: PointerEvent) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    panning = e.button === 2 || e.shiftKey;
    dragDist = 0;
    lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = panning ? 'move' : 'grabbing';
  };

  const onPointerMove = (e: PointerEvent) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (activePointers.size === 2) {
      const [p, q] = [...activePointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (pinchDist > 0) dist = clampDist(dist * (pinchDist / d));
      pinchDist = d;
      return;
    }
    if (!dragging) {
      setNdc(e);
      pointerDirty = true;
      return;
    }
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    if (panning) {
      // pan in the camera's own plane, scaled so a drag moves the same amount
      // of world under the cursor at any zoom
      const k = (dist * FOV_TAN * 2) / (canvas.clientHeight || 1);
      camera.getWorldDirection(tmpV);
      tmpV2.crossVectors(tmpV, camera.up).normalize();
      camTarget.addScaledVector(tmpV2, -dx * k);
      tmpV2.crossVectors(tmpV2, tmpV).normalize();
      camTarget.addScaledVector(tmpV2, -dy * k);
      flyTarget = null;
    } else {
      yaw -= dx * 0.005;
      pitch += dy * 0.005;
      pitch = Math.max(-1.45, Math.min(1.45, pitch));
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchDist = 0;
    if (activePointers.size > 0) return;
    dragging = false;
    panning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    canvas.style.cursor = 'grab';
    if (dragDist < 4 && e.button === 0) {
      setNdc(e);
      const id = pick();
      opts?.onNodeClick?.(id);
      select(id);
    }
  };

  const onPointerLeave = () => {
    hoveredId = null;
    pointerDirty = false;
    canvas.style.cursor = 'grab';
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    distTarget = null;
    dist = clampDist(dist * (e.deltaY > 0 ? 1.14 : 1 / 1.14));
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

  // ── frame loop ──────────────────────────────────────────────────────────
  let raf = 0;
  let destroyed = false;
  let lastTime = performance.now();
  let clock = 0;
  let act = { active: false, at: 0 };
  let eng = 0;
  let pulseAt = -1e9;
  const camPos = new THREE.Vector3();
  const projV = new THREE.Vector3();

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dtReal = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    clock += dtReal;
    starUniforms.uTime.value = clock;

    const engaged = act.active && now - act.at < 90_000;
    eng += ((engaged ? 1 : 0) - eng) * Math.min(1, 2.5 * dtReal);
    bloom.strength = 0.62 + eng * 0.35;
    // while Nova is working, a ripple leaves her every 2.8s
    if (engaged && clock - pulseAt > 2.8) pulseAt = clock;
    const pulseAge = clock - pulseAt;
    starUniforms.uPulseT.value = pulseAge < 2.8 ? pulseAge : -1;
    starUniforms.uPulseSpeed.value = worldExtent / 2.4;

    if (settleLeft > 0) {
      for (let k = 0; k < STEPS_PER_FRAME; k++) step(1 / 30);
      syncInstances();
      // The cache is what survives the 20s poll, so it is written once the
      // layout has stopped moving — not 150 times on the way there.
      if (--settleLeft === 0) for (const s of stars) posCache.set(s.node.id, s.pos.clone());
    }

    if (!dragging) yaw += 0.014 * rotationSpeed * dtReal * (1 + eng * 0.5);
    const k = 1 - Math.exp(-4 * dtReal);
    if (flyTarget) {
      camTarget.lerp(flyTarget, k);
      if (camTarget.distanceTo(flyTarget) < 1) flyTarget = null;
    }
    if (distTarget !== null) {
      const d = clampDist(distTarget);
      dist += (d - dist) * k;
      if (Math.abs(dist - d) < 1) distTarget = null;
    }
    applyCamera();
    backdrop.position.copy(camera.position);   // the sky never ends

    // selection dim, eased so nothing snaps
    const wantDim = selectedId ? 1 : 0;
    starUniforms.uDim.value += (wantDim - starUniforms.uDim.value) * Math.min(1, 5 * dtReal);
    edgeUniforms.uDim.value = starUniforms.uDim.value;

    // particles drifting along the edges
    if (flowPoints && flow.length) {
      const attr = flowPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      const adv = dtReal * (0.35 + rotationSpeed * 0.25);
      flow.forEach((f, i) => {
        f.phase = (f.phase + f.speed * adv * 4) % 1;
        const A = stars[f.a].pos, B = stars[f.b].pos;
        attr.setXYZ(i,
          A.x + (B.x - A.x) * f.phase,
          A.y + (B.y - A.y) * f.phase,
          A.z + (B.z - A.z) * f.phase);
      });
      attr.needsUpdate = true;
    }

    if (pointerDirty && !dragging) {
      pointerDirty = false;
      const id = pick();
      if (id !== hoveredId) hoveredId = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
    }

    // ── semantic zoom + screen-space declutter ────────────────────────────
    // Zoomed out you read cluster names; as you fall into a cluster its name
    // hands over to the memories inside it. Each cluster hands over at ITS own
    // scale, so a 4-star cluster and a 127-star one both behave.
    camPos.copy(camera.position);
    const vw = canvas.clientWidth || canvas.width || 1;
    const vh = canvas.clientHeight || canvas.height || 1;
    const wants: { l: LabelEntry; a: number; d: number }[] = [];
    const focusSet = selectedId
      ? new Set<string>([selectedId, ...(neighbours.get(selectedId) ?? [])])
      : null;

    for (const l of labels) {
      if (l.starIndex >= 0) l.at = stars[l.starIndex].pos;
      const d = camPos.distanceTo(l.at);
      const E = l.extent;
      let alpha: number;
      if (labelMode === 'off') alpha = 0;
      else if (l.kind === 'cluster') {
        alpha = labelMode === 'on' ? 0.9
          : Math.max(0, Math.min(1, (d - 3.0 * E) / (2.0 * E)));
      } else {
        const s = stars[l.starIndex];
        // anchors (Nova, you) are always named — they are how you orient
        const anchor = s.node.type === 'core' || s.node.type === 'user';
        alpha = anchor ? 0.95
          : labelMode === 'on' ? 0.9
            : Math.max(0, Math.min(1, (3.0 * E - d) / (2.0 * E))) * (0.45 + s.imp * 0.55);
      }
      if (focusSet && l.starIndex >= 0) {
        alpha *= focusSet.has(stars[l.starIndex].node.id) ? 1 : 0.04;
      }
      if (l.starIndex >= 0 && stars[l.starIndex].node.id === hoveredId) alpha = 1;

      if (alpha <= 0.03) {
        l.sw = 0;
        wants.push({ l, a: 0, d: Infinity });
        if (l.sprite) l.sprite.visible = false;
        continue;
      }
      if (!l.sprite) l.sprite = makeSprite(l);
      const h = l.height * labelScale;
      const tex = (l.sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture;
      const w = h * (tex.image.width / tex.image.height);
      l.sprite.scale.set(w, h, 1);
      // sit the label just above its star rather than inside its glow
      l.sprite.position.copy(l.at);
      l.sprite.position.y += l.kind === 'cluster' ? l.extent * 0.9
        : stars[l.starIndex].radius * 2.2 + h * 0.6;

      l.sprite.getWorldPosition(projV);
      projV.project(camera);
      const px = ((projV.x + 1) / 2) * vw;
      const py = ((1 - projV.y) / 2) * vh;
      const scale = vh / (2 * Math.max(d, 1) * FOV_TAN);
      l.sx = px; l.sy = py; l.sw = w * scale; l.sh = h * scale;
      const onScreen = projV.z < 1
        && px > -l.sw && px < vw + l.sw && py > -l.sh && py < vh + l.sh;
      wants.push({ l, a: onScreen ? alpha : 0, d });
    }

    // Greedy non-overlapping selection, incumbency first. The idle auto-orbit
    // never stops, so without hysteresis the visible set would churn forever.
    wants.sort((p, q) => {
      const rank = (x: typeof p) =>
        (x.l.starIndex >= 0 && stars[x.l.starIndex].node.id === hoveredId ? 4 : 0)
        + (x.l.kind === 'cluster' ? 2 : 0) + x.l.vis;
      return rank(q) - rank(p) || p.d - q.d;
    });
    const cap = Math.max(8, Math.floor((0.25 * vw * vh) / 9000));
    const taken: LabelEntry[] = [];
    for (const cd of wants) {
      const l = cd.l;
      let ok = cd.a > 0.03 && taken.length < cap;
      if (ok) {
        for (const t of taken) {
          if (Math.abs(l.sx - t.sx) * 2 < l.sw + t.sw
              && Math.abs(l.sy - t.sy) * 2 < l.sh + t.sh) { ok = false; break; }
        }
      }
      if (ok) taken.push(l);
      // slow in, fast out: slow-in is the hysteresis; fast-out matters because
      // a label on the way out still draws but no longer holds its slot
      l.vis += ((ok ? 1 : 0) - l.vis) * Math.min(1, dtReal / (ok ? 0.4 : 0.1));
      if (!l.sprite) continue;
      const mat = l.sprite.material as THREE.SpriteMaterial;
      mat.opacity = cd.a * l.vis;
      l.sprite.visible = mat.opacity > 0.02;
    }

    // cluster halos fade in as you pull back — up close they'd just be fog
    for (const h of haloSprites) {
      const d = camPos.distanceTo(h.center);
      const want = Math.max(0, Math.min(0.3, (d - 1.6 * h.extent) / (9 * h.extent)));
      const mat = h.sprite.material as THREE.SpriteMaterial;
      mat.opacity += (want * (1 - starUniforms.uDim.value * 0.8) - mat.opacity)
        * Math.min(1, 3 * dtReal);
    }

    composer.render();

    // labels ride their own layer, drawn after the bloom chain — crisp text on
    // top, never glowing. scene.background must be nulled: a Color background
    // forces a clear even with autoClear off, erasing the composer's output.
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

  // `paused` is occlusion (the phone's chat panel over the canvas);
  // document.hidden is the tab. Either stops the loop — and this one is
  // expensive: a bloom composer is two full render passes per frame.
  let paused = false;
  const onVisibility = () => {
    // ALWAYS cancel before deciding: frame() reschedules itself
    // unconditionally, so scheduling without cancelling starts a second
    // self-perpetuating chain whose handle is lost.
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
        nodes.map(n => [n.id, n.label, n.type, n.enabled]),
        edges.map(e => [e.source, e.target, e.kind]),
      ]);
      if (fp === fingerprint) return;   // 20s poll, same graph — don't rebuild
      fingerprint = fp;
      const live = new Set(nodes.map(n => n.id));
      for (const id of [...posCache.keys()]) if (!live.has(id)) posCache.delete(id);
      build(nodes, edges);
      if (selectedId && !indexById.has(selectedId)) selectedId = null;
    },

    resize(width: number, height: number) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      composer.setSize(width, height);
      camera.aspect = width / height;
      applySkyDensity(width, height);
      applyViewOffset();
    },

    recenter() {
      yaw = 0.7; pitch = 0.3;
      select(null);
      flyTarget = new THREE.Vector3(0, 0, 0);
      distTarget = frameDist(Math.min(worldExtent, 420)) / 2;
    },

    /** Pull back until every cluster is in frame — the shell's spread is only
     *  legible from out here, and home framing deliberately isn't. */
    fitAll() {
      select(null);
      flyTarget = new THREE.Vector3(0, 0, 0);
      distTarget = frameDist(worldExtent) / 1.7;
    },

    focusNode(id: string) { select(id); },

    configure(options: Record<string, unknown>) {
      if (typeof options.rotationSpeed === 'number') rotationSpeed = options.rotationSpeed;
      if (typeof options.labelScale === 'number') labelScale = options.labelScale;
      if (options.labelMode === 'auto' || options.labelMode === 'on' || options.labelMode === 'off') {
        labelMode = options.labelMode;
      }
      if (typeof options.leftInset === 'number') {
        leftInset = options.leftInset;
        applyViewOffset();
      }
      // brain.universe2.color_mode / .edge_style — both take effect on the
      // live scene, no rebuild: the star buffers already hold everything a
      // repaint needs, and rebuilding would re-run the layout and throw away
      // the arrangement the operator is currently looking at.
      const cm = options.colorMode;
      if (cm === 'cluster' || cm === 'type' || cm === 'importance') {
        if (cm !== colorMode) { colorMode = cm; applyColors(); }
      }
      const es = options.edgeStyle;
      if (es === 'animated' || es === 'gradient' || es === 'static') {
        if (es !== edgeStyle) { edgeStyle = es; applyEdgeStyle(); }
      }
    },

    setActivity(state: { active: boolean; kind?: 'thinking' | 'dispatch' | 'tool' | 'listening' }) {
      if (state.kind === 'listening') return;   // mic state has no treatment here
      act = { active: state.active, at: performance.now() };
      if (state.active) pulseAt = clock;        // ripple immediately, not in 2.8s
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
      disposeTree(dataRoot);
      disposeTree(backdrop);
      for (const s of shared) s.dispose();
      composer.dispose();
      renderer.dispose();
      // deliberately NO forceContextLoss(): StrictMode double-runs effects on
      // the same canvas (ThemePreview), and a force-lost context can never be
      // re-adopted — three dies reading getShaderPrecisionFormat(). dispose()
      // frees the GPU resources; the context goes with the canvas element,
      // which Brain.tsx remounts per renderer creation.
    },
  };
}
