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
import { computeSystems, hashStr as hash, tagColor, MEMORY_BODY_TYPES, TAG_COLORS } from './systems';

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
const NOVA_R = 26, USER_R = 15;
const BINARY_NOVA_ORBIT = 30, BINARY_USER_ORBIT = 85;
const AGENT_R_MIN = 85, AGENT_R_MAX = 150;
const SKILL_R = 175;
const BELT_R = 235;
const SHELL_R = 950;
const ROGUE_R = 560;

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

/** Offset variant (i+0.5)/n — never lands exactly on a pole, even for n=1. */
function fibonacciSphere(i: number, n: number, radius: number): THREE.Vector3 {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * i;
  return new THREE.Vector3(Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius);
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
  baseHeight: number;
  bodyId: string | null;
}

/** Sprites on this layer skip the bloom chain and render in a crisp overlay
 *  pass — text must never glow like the planets do. */
export const LABEL_LAYER = 1;

/** Canvas-texture label sprite — in-scene positioning, bloom-free overlay. */
function makeLabel(text: string, color: string, kind: LabelKind['kind'],
                   sysCenter: THREE.Vector3, bodyId: string | null): LabelEntry {
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
  return { sprite, kind, sysCenter, baseHeight, bodyId };
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
  const shared = new Set<THREE.BufferGeometry | THREE.Texture>(
    [glowTex, unitSphere, unitRock, unitOcta, unitCone]);

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
  let yaw = 0.6, pitch = 0.32, dist = 620;
  const camTarget = new THREE.Vector3(0, 0, 0);
  function applyCamera() {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    camera.position.set(
      camTarget.x + dist * cp * Math.cos(yaw),
      camTarget.y + dist * sp,
      camTarget.z + dist * cp * Math.sin(yaw));
    camera.lookAt(camTarget);
  }

  // ── runtime settings (Brain HUD → configure()) ──────────────────────────
  let rotationSpeed = 1;   // global orbital time-scale multiplier (0 = still)
  let labelMode: 'auto' | 'on' | 'off' = 'auto';
  let labelScale = 1;

  // ── ambient dressing (built once, survives setData) ─────────────────────
  const ambient = new THREE.Group();
  scene.add(ambient);

  {
    // starfield backdrop
    const rand = mulberry32(1337);
    const N = 1600;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)
        .normalize().multiplyScalar(3800 + rand() * 900);
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
    ambient.add(new THREE.Points(g, m));

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
    const d = new THREE.Vector3(
      meteorRand() - 0.5, meteorRand() - 0.5, meteorRand() - 0.5)
      .normalize().multiplyScalar(1500 + meteorRand() * 700);
    m.head.copy(d);
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
  let liveSystems: { label: string; center: THREE.Vector3 }[] = [];
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
        ({ label: s.label, x: s.center.x, y: s.center.y, z: s.center.z })),
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

    // adjacency over real relations only — tag edges are a clustering
    // construction (chains) and would highlight arbitrary same-tag neighbors
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
                      sysCenter: THREE.Vector3, labelKind: LabelKind['kind'] = 'body') {
      const group = new THREE.Group();
      group.userData.nodeId = id;
      group.userData.focusDist = Math.max(110, size * 26);   // body + its moons in frame
      bodyGroups.set(id, group);
      group.add(mesh);
      const proxy = makeHitProxy(Math.max(6, size * 1.9), id);
      group.add(proxy);
      pickables.push(proxy);
      if (labelText) {
        addLabel(makeLabel(labelText, labelColor, labelKind, sysCenter, id),
                 group, size * 2 + 7);
      }
      dataRoot.add(group);
      posOf.set(id, group.position);
      return group;
    }

    /** pulsing halo for memories touched in the last 24h — "Nova just learned this" */
    function freshFlare(group: THREE.Group, node: GraphNode, color: string, size: number) {
      const age = nowSec - node.mtime;
      if (age > 86400) return;
      const strong = age < 3600;
      const flare = makeGlowSprite(color, size * (strong ? 7 : 5), 0);
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
    novaGroup.userData.focusDist = 240;
    bodyGroups.set(coreId ?? 'soul.md', novaGroup);
    {
      const star = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.nova }));
      star.scale.setScalar(NOVA_R);
      const glow = makeGlowSprite(COLOR.nova, NOVA_R * 3.8, 0.8);
      const proxy = makeHitProxy(NOVA_R * 1.5, 'soul.md');   // the star IS Nova → open the soul
      novaGroup.add(star, glow, proxy);
      pickables.push(proxy);
      addLabel(makeLabel(coreNode?.label || 'Nova', COLOR.nova, 'anchor', HOME_CENTER, 'soul.md'),
               novaGroup, NOVA_R + 16);
      dataRoot.add(novaGroup);
      const ng = novaGroup;
      updaters.push(({ t }) => {
        const a = t * (Math.PI * 2 / 90);           // binary period ~90s at speed 1
        ng.position.set(Math.cos(a) * BINARY_NOVA_ORBIT, 0, Math.sin(a) * BINARY_NOVA_ORBIT);
        glow.scale.setScalar(NOVA_R * (3.8 + Math.sin(t * 0.9) * 0.25));
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
      const Q_ = 265 + norm * 175;                   // aphelion beyond the belt
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
    const memIds = new Set(nodes.filter(n => MEMORY_BODY_TYPES.has(n.type)).map(n => n.id));
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

    systems.forEach((sys, si) => {
      const members = sys.members;
      const rand = mulberry32(hash(sys.key));
      const center = fibonacciSphere(si, Math.max(systems.length, 2), SHELL_R);
      center.x += (rand() - 0.5) * 160;
      center.y += (rand() - 0.5) * 160;
      center.z += (rand() - 0.5) * 160;
      const sysGroup = new THREE.Group();
      sysGroup.position.copy(center);
      dataRoot.add(sysGroup);

      // dominant shared tag names the system (computed in systems.ts)
      const dominant = sys.name;
      const sysColor = sys.color;

      const star = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.sysStar }));
      star.scale.setScalar(9);
      sysGroup.add(star, makeGlowSprite(COLOR.sysStar, 95, 0.55));
      addLabel(makeLabel(dominant, sysColor, 'sysname', center, null), sysGroup, 34);
      sysGroup.add(makeGlowSprite(sysColor, 380, 0.05));   // per-system nebula tint
      // clicking a system's star flies the camera there (recenter returns home)
      const sysProxy = makeHitProxy(16, '');
      sysProxy.userData.focus = center;
      sysGroup.add(sysProxy);
      pickables.push(sysProxy);
      liveSystems.push({ label: dominant, center });

      const topics = members.filter(m => m.type === 'topic');
      const sources = members.filter(m => m.type === 'source');

      // moons: a topic wiki-linked to exactly one other topic orbits it
      const isMoon = (m: GraphNode) => {
        if (linkDegree.get(m.id) !== 1) return false;
        const e = linkEdges.find(x => x.source === m.id || x.target === m.id)!;
        const otherId = e.source === m.id ? e.target : e.source;
        const other = byId.get(otherId);
        return !!other && other.type === 'topic' && (linkDegree.get(otherId) ?? 0) >= 2;
      };
      const moons = topics.filter(isMoon);
      const planets = topics.filter(m => !moons.includes(m));

      const times = planets.map(p => p.mtime);
      const lo = Math.min(...times), hi = Math.max(...times);
      const ranked = [...planets].sort((a, b) => b.mtime - a.mtime);   // recent innermost

      for (const p of planets) {
        const prand = mulberry32(hash(p.id));
        const rank = ranked.indexOf(p);
        const r = 36 + rank * (62 / Math.max(1, planets.length - 1) || 0) + (prand() - 0.5) * 8;
        const q = orbitQuat(prand, 0.2);
        const phase = prand() * Math.PI * 2;
        const period = 34 * Math.pow(r / 55, 1.5);
        const deg = fullDegree.get(p.id) ?? 0;
        const size = 3.5 + Math.min(deg, 6) * 0.8;
        const recency = hi > lo ? (p.mtime - lo) / (hi - lo) : 0.5;
        const color = tagColor(p);
        const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color }));
        mesh.scale.setScalar(size);
        const group = makeBody(p.id, mesh, size, p.label, color, center);
        group.add(makeGlowSprite(color, size * 4.5, 0.25 + recency * 0.3));
        freshFlare(group, p, color, size);
        const ring = orbitRing(r, q, color, 0.05);
        ring.position.copy(center);
        dataRoot.add(ring);
        updaters.push(({ t }) => {
          const a = phase + t * (Math.PI * 2 / period);
          group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r)
            .applyQuaternion(q).add(center);
        });
      }

      for (const m of moons) {
        const e = linkEdges.find(x => x.source === m.id || x.target === m.id)!;
        const parentId = e.source === m.id ? e.target : e.source;
        const parentPos = posOf.get(parentId);
        const mrand = mulberry32(hash(m.id));
        const r = 11 + mrand() * 4;
        const q = orbitQuat(mrand, 0.6);
        const phase = mrand() * Math.PI * 2;
        const size = 2.3;
        const color = tagColor(m);
        const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color }));
        mesh.scale.setScalar(size);
        const group = makeBody(m.id, mesh, size, m.label, color, center);
        freshFlare(group, m, color, size);
        updaters.push(({ t }) => {
          const a = phase + t * (Math.PI * 2 / 11);
          group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q);
          if (parentPos) group.position.add(parentPos);
        });
      }

      // sources — interstellar visitors loitering near the topics that cite them
      // (world space like planets, so posOf stays world-valid for the arcs)
      for (const s of sources) {
        const link = linkEdges.find(x =>
          (x.source === s.id && memIds.has(x.target)) ||
          (x.target === s.id && memIds.has(x.source)));
        const anchorId = link ? (link.source === s.id ? link.target : link.source) : null;
        const anchorPos = anchorId ? posOf.get(anchorId) : undefined;
        const srand = mulberry32(hash(s.id));
        const offset = new THREE.Vector3(srand() - 0.5, (srand() - 0.5) * 0.5, srand() - 0.5)
          .normalize().multiplyScalar(14);
        const size = 2.6;
        const mesh = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: COLOR.source }));
        mesh.scale.set(size * 2.1, size * 0.7, size * 0.7);   // elongated — it came from outside
        const group = makeBody(s.id, mesh, size, s.label, COLOR.source, center);
        const tail = new THREE.Mesh(unitCone, new THREE.MeshBasicMaterial({
          color: COLOR.source, transparent: true, opacity: 0.16,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
        dataRoot.add(tail);
        const tailDir = new THREE.Vector3();
        updaters.push(() => {
          if (anchorPos) group.position.copy(anchorPos).add(offset);
          else group.position.copy(center).add(offset).addScaledVector(offset, 2);
          // tail points away from the HOME star — this thing came from outside
          tailDir.copy(group.position).normalize();
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tailDir);
          const len = 12;
          tail.scale.set(1.4, len, 1.4);
          tail.position.copy(group.position).addScaledVector(tailDir, len / 2);
          tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailDir);
        });
      }
    });

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
    const relationSets: { kinds: GraphEdge[]; color: string; opacity: number }[] = [
      { kinds: edges.filter(e => e.kind === 'about'), color: COLOR.nova, opacity: 0.22 },
      { kinds: edges.filter(e => e.kind === 'writes'), color: '#9fd4ff', opacity: 0.3 },
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
      if (pinchDist > 0) dist = Math.max(120, Math.min(3200, dist * (pinchDist / d)));
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
        yaw += (e.clientX - lastX) * 0.005;
        pitch = Math.max(-1.35, Math.min(1.35, pitch + (e.clientY - lastY) * 0.005));
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
        // fly to the system rather than opening a detail
        followObj = null;
        flyTarget = (hit.userData.focus as THREE.Vector3).clone();
        distTarget = 340;
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
    dist = Math.max(120, Math.min(3200, dist * (e.deltaY > 0 ? 1.08 : 1 / 1.08)));
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

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dtReal = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    const dt = dtReal * rotationSpeed;
    simT += dt;

    if (!dragging) yaw += 0.012 * rotationSpeed * dtReal;   // idle auto-orbit
    const k = 1 - Math.exp(-4 * dtReal);
    if (followObj) {
      followObj.getWorldPosition(followPos);   // world: belt journals spin as one
      camTarget.lerp(followPos, k);
    } else if (flyTarget) {
      camTarget.lerp(flyTarget, k);
      if (camTarget.distanceTo(flyTarget) < 1) flyTarget = null;
    }
    if (distTarget !== null) {
      dist += (distTarget - dist) * k;
      if (Math.abs(dist - distTarget) < 1) distTarget = null;
    }
    applyCamera();

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

    // semantic zoom: distance to each label's system decides what's readable
    camPos.copy(camera.position);
    for (const l of labels) {
      const d = camPos.distanceTo(l.sysCenter);
      let alpha = 0;
      if (l.kind === 'anchor') {
        alpha = labelMode === 'off' ? 0 : 0.92;
      } else if (l.kind === 'sysname') {
        alpha = labelMode === 'off' ? 0 : Math.max(0, Math.min(1, (d - 500) / 280));
      } else if (l.kind === 'quiet') {
        alpha = labelMode === 'on' ? 0.85 : 0;
      } else {
        alpha = labelMode === 'on' ? 1
          : labelMode === 'off' ? 0
            : Math.max(0, Math.min(1, (560 - d) / 260));
      }
      if (highlightSet) {
        const bid = normId(l.bodyId);
        alpha *= bid && highlightSet.has(bid) ? 1 : 0.05;
      }
      if (l.bodyId && l.bodyId === hoveredId) alpha = 1;   // hover pierces the dim
      const mat = l.sprite.material as THREE.SpriteMaterial;
      mat.opacity = alpha;
      l.sprite.visible = alpha > 0.02;
      const h = l.baseHeight * labelScale;
      const w = h * ((mat.map as THREE.CanvasTexture).image.width /
                     (mat.map as THREE.CanvasTexture).image.height);
      l.sprite.scale.set(w, h, 1);
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

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else if (!destroyed) {
      lastTime = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(frame);

  return {
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
      distTarget = 620;
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
