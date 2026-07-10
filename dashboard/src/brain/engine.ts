/**
 * Brain graph engine — data, layout, camera, and cognition state shared by
 * all three renderers (galaxy / orrery / singularity).
 *
 * Pure TS: no React, no DOM beyond what a renderer is handed. The page owns
 * the canvas + rAF loop; renderers are draw functions over this scene.
 */

// ── Server shapes (GET /mem/api/v1/memory/graph) ────────────────────────────

export interface MemGraphNode {
  id: string
  title: string
  type: string
  tags: string[]
  description: string
  trust: number | null
  source_kind: string | null
  created: string
  degree: number
}

export interface MemGraph {
  nodes: MemGraphNode[]
  edges: [number, number][]
  generated_at: string
}

export interface RetrievalEvent {
  id: string
  ts: string
  query: string
  session_id: string
  surfaced: string[]
}

// ── Visual categories ───────────────────────────────────────────────────────
// Validated 6-color categorical set (dataviz six-checks, dark surface).
// OKF `type` values route into one of six visual categories.

export interface CatStyle {
  key: string
  label: string
  color: string
  rgb: [number, number, number]
}

const hex2rgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
]

const mkCat = (key: string, label: string, color: string): CatStyle =>
  ({ key, label, color, rgb: hex2rgb(color) })

export const CATS: Record<string, CatStyle> = {
  topic:      mkCat('topic', 'topic', '#19A89E'),
  person:     mkCat('person', 'person', '#8B5CF6'),
  preference: mkCat('preference', 'preference', '#65A30D'),
  source:     mkCat('source', 'source', '#6366F1'),
  episode:    mkCat('episode', 'journal / reflection', '#F43F5E'),
  project:    mkCat('project', 'project', '#0284C7'),
}

const TYPE_TO_CAT: Record<string, string> = {
  topic: 'topic', note: 'topic', schema: 'topic', fact: 'topic',
  person: 'person', people: 'person',
  preference: 'preference',
  source: 'source',
  journal: 'episode', reflection: 'episode', episode: 'episode',
  project: 'project', goal: 'project',
}

export const catFor = (type: string): CatStyle =>
  CATS[TYPE_TO_CAT[(type || '').toLowerCase()] ?? 'topic']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/

/** Journals are secondary in every view: "Journal 2026-07-09" reads as "Jul 9". */
export function displayLabel(title: string, id: string, cat: CatStyle): string {
  if (cat.key !== 'episode') return title
  const m = DATE_RE.exec(title) ?? DATE_RE.exec(id)
  if (!m) return title
  const short = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`
  return Number(m[1]) === new Date().getFullYear() ? short : `${short} ’${m[1].slice(2)}`
}

export const TEAL = hex2rgb('#19A89E')
export const TEAL_BRIGHT = hex2rgb('#5CE8D0')
export const AMBER: [number, number, number] = [251, 191, 36]

export const css = (c: readonly number[], a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`
export const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

// ── Runtime scene ───────────────────────────────────────────────────────────

export interface BrainNode extends MemGraphNode {
  idx: number
  cat: CatStyle
  /** display label — journals shorten to "Jul 9", concepts keep their title */
  label: string
  out: number[]
  // live coordinates — the ACTIVE renderer writes these every frame
  x: number; y: number; z: number
  // galaxy (force-relaxed) home coordinates
  gx: number; gy: number; gz: number
  // orrery orbit parameters
  a0: number; rad: number; yy: number; w: number
  // animation state
  phase: number
  act: number      // amber activation 0..1
  rim: number      // retrieval-result flag (pulses, no ring)
  near: number     // respond heartbeat weight
}

export interface Scene {
  nodes: BrainNode[]
  edges: [number, number][]
  byId: Map<string, number>
  relaxDone: boolean
  orreryDone: boolean
  spiralCount: number
}

/** Deterministic PRNG so layouts are stable across visits. */
export function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NODE_CAP = 600

export function buildScene(graph: MemGraph): Scene {
  const rnd = mulberry32(20260707)

  // Cap pathological bundles: keep the best-connected / newest files.
  let keep = graph.nodes.map((_, i) => i)
  if (graph.nodes.length > NODE_CAP) {
    keep = [...keep]
      .sort((a, b) =>
        (graph.nodes[b].degree - graph.nodes[a].degree) ||
        (graph.nodes[b].created > graph.nodes[a].created ? 1 : -1))
      .slice(0, NODE_CAP)
      .sort((a, b) => a - b)
  }
  const remap = new Map(keep.map((orig, now) => [orig, now]))

  const nodes: BrainNode[] = keep.map((orig, idx) => {
    const n = graph.nodes[orig]
    const cat = catFor(n.type)
    return {
      ...n,
      idx,
      cat,
      label: displayLabel(n.title, n.id, cat),
      out: [],
      x: 0, y: 0, z: 0,
      gx: 0, gy: 0, gz: 0,
      a0: 0, rad: 0, yy: 0, w: 0,
      phase: rnd() * Math.PI * 2,
      act: 0, rim: 0, near: 0,
    }
  })

  const edges: [number, number][] = []
  for (const [a, b] of graph.edges) {
    const i = remap.get(a), j = remap.get(b)
    if (i === undefined || j === undefined) continue
    edges.push([i, j])
    nodes[i].out.push(j)
    nodes[j].out.push(i)
  }

  // seed galaxy positions near per-category anchors so clusters form
  const catKeys = Object.keys(CATS)
  const anchors: Record<string, [number, number, number]> = {}
  catKeys.forEach((k, i) => {
    const phi = (i / catKeys.length) * Math.PI * 2
    anchors[k] = [Math.cos(phi) * 60, i % 2 ? 22 : -22, Math.sin(phi) * 60]
  })
  for (const n of nodes) {
    const a = anchors[n.cat.key]
    n.gx = a[0] + (rnd() - 0.5) * 70
    n.gy = a[1] + (rnd() - 0.5) * 60
    n.gz = a[2] + (rnd() - 0.5) * 70
    n.x = n.gx; n.y = n.gy; n.z = n.gz
  }

  return {
    nodes, edges,
    byId: new Map(nodes.map(n => [n.id, n.idx])),
    relaxDone: false,
    orreryDone: false,
    spiralCount: 0,
  }
}

// ── Galaxy layout: chunked force relax (call per frame until relaxDone) ─────

const RELAX_TOTAL = 200
let relaxIter = 0

export function relaxStep(scene: Scene, iters = 20): void {
  if (scene.relaxDone) return
  const N = scene.nodes
  const catKeys = Object.keys(CATS)
  const anchors: Record<string, [number, number, number]> = {}
  catKeys.forEach((k, i) => {
    const phi = (i / catKeys.length) * Math.PI * 2
    anchors[k] = [Math.cos(phi) * 60, i % 2 ? 22 : -22, Math.sin(phi) * 60]
  })
  const K = 0.012, REP = 900, CTR = 0.015, ANCH = 0.02
  const fx = new Float32Array(N.length), fy = new Float32Array(N.length), fz = new Float32Array(N.length)
  for (let it = 0; it < iters && relaxIter < RELAX_TOTAL; it++, relaxIter++) {
    fx.fill(0); fy.fill(0); fz.fill(0)
    for (let i = 0; i < N.length; i++) {
      const a = N[i]
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j]
        const dx = a.gx - b.gx, dy = a.gy - b.gy, dz = a.gz - b.gz
        const d2 = dx * dx + dy * dy + dz * dz + 0.01
        const f = REP / d2 / Math.sqrt(d2)
        fx[i] += dx * f; fy[i] += dy * f; fz[i] += dz * f
        fx[j] -= dx * f; fy[j] -= dy * f; fz[j] -= dz * f
      }
      const an = anchors[a.cat.key]
      fx[i] += (an[0] - a.gx) * ANCH - a.gx * CTR
      fy[i] += (an[1] - a.gy) * ANCH - a.gy * CTR
      fz[i] += (an[2] - a.gz) * ANCH - a.gz * CTR
    }
    for (const [i, j] of scene.edges) {
      const a = N[i], b = N[j]
      const dx = b.gx - a.gx, dy = b.gy - a.gy, dz = b.gz - a.gz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01
      const f = K * (d - 34)
      fx[i] += dx * f; fy[i] += dy * f; fz[i] += dz * f
      fx[j] -= dx * f; fy[j] -= dy * f; fz[j] -= dz * f
    }
    const step = relaxIter < 80 ? 0.9 : 0.4
    for (let i = 0; i < N.length; i++) {
      const n = N[i]
      n.gx += Math.max(-6, Math.min(6, fx[i] * step))
      n.gy += Math.max(-6, Math.min(6, fy[i] * step))
      n.gz += Math.max(-6, Math.min(6, fz[i] * step))
    }
  }
  if (relaxIter >= RELAX_TOTAL) scene.relaxDone = true
}

export function resetRelax(): void { relaxIter = 0 }

// ── Orrery layout: category rings + episode time-spiral ─────────────────────

export const RINGS: { cat: string; rad: number }[] = [
  { cat: 'person', rad: 30 },
  { cat: 'preference', rad: 52 },
  { cat: 'project', rad: 74 },
  { cat: 'topic', rad: 100 },
  { cat: 'source', rad: 126 },
]
export const SPIRAL_R0 = 140, SPIRAL_DR = 4.2, SPIRAL_DA = 0.58

export function layoutOrrery(scene: Scene): void {
  if (scene.orreryDone) return
  const rnd = mulberry32(20260709)
  const GOLD = 2.399963
  const placed = new Set<number>()
  RINGS.forEach((ring, ri) => {
    const members = scene.nodes
      .filter(n => n.cat.key === ring.cat)
      .sort((a, b) => b.degree - a.degree)
    members.forEach((n, k) => {
      let vx = 0, vy = 0, found = 0
      for (const j of n.out) if (placed.has(j)) {
        vx += Math.cos(scene.nodes[j].a0); vy += Math.sin(scene.nodes[j].a0); found++
      }
      n.a0 = found ? Math.atan2(vy, vx) + (rnd() - 0.5) * 1.3 : k * GOLD + ri * 0.7
      n.rad = ring.rad + (rnd() - 0.5) * 5
      n.yy = ((k % 2) ? 1 : -1) * (1.5 + ri * 0.8) + (rnd() - 0.5) * 2
      n.w = 0.028 * (1.7 - ri * 0.26)
      placed.add(n.idx)
    })
  })
  const spiral = scene.nodes
    .filter(n => n.cat.key === 'episode')
    .sort((a, b) => (a.created < b.created ? 1 : -1))
  spiral.forEach((n, k) => {
    n.a0 = -0.8 + k * SPIRAL_DA
    n.rad = SPIRAL_R0 + k * SPIRAL_DR
    n.yy = 2 + k * 1.4
    n.w = 0.012
  })
  scene.spiralCount = spiral.length
  scene.orreryDone = true
}

// ── Camera & projection ─────────────────────────────────────────────────────

export interface Camera {
  yaw: number
  pitch: number
  dist: number
  fov: number
  auto: boolean
  /** screen-space pan offset in CSS px (singularity view only — world views pan the target) */
  cx: number
  cy: number
  /** layout offset: the page shifts the scene center when side panels open */
  ox: number
  /** world-space orbit target — yaw/pitch rotate and zoom pivots around this point */
  tx: number
  ty: number
  tz: number
}

export interface Projected { sx: number; sy: number; s: number; z: number }

export function project(
  x: number, y: number, z: number, cam: Camera, W: number, H: number,
): Projected | null {
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw)
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
  const rx = x - cam.tx, ry = y - cam.ty, rz = z - cam.tz
  const X = rx * cy - rz * sy
  let Z = rx * sy + rz * cy
  const Y = ry * cp - Z * sp
  Z = ry * sp + Z * cp + cam.dist
  if (Z < 40) return null
  const s = cam.fov / Z
  return { sx: W / 2 + cam.cx + cam.ox + X * s, sy: H / 2 + cam.cy + Y * s, s, z: Z }
}

/** Right-drag pan for the 3D views: move the orbit target in the camera plane
 *  so the scene follows the cursor and rotation always pivots around whatever
 *  is currently centred in the view. */
export function panWorld(cam: Camera, dx: number, dy: number): void {
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw)
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
  const k = cam.dist / cam.fov // world units per CSS px at the target depth
  // screen-right and screen-down expressed in world space (inverse rotation)
  cam.tx -= (cy * dx - sy * sp * dy) * k
  cam.ty -= cp * dy * k
  cam.tz -= (-sy * dx - cy * sp * dy) * k
}

/** Centre of mass of the galaxy layout — the natural resting orbit target. */
export function sceneCentroid(scene: Scene): { x: number; y: number; z: number } {
  const n = scene.nodes.length
  if (!n) return { x: 0, y: 0, z: 0 }
  let x = 0, y = 0, z = 0
  for (const nd of scene.nodes) { x += nd.gx; y += nd.gy; z += nd.gz }
  return { x: x / n, y: y / n, z: z / n }
}

// ── Cognition state: smooth wavefront + heartbeat ───────────────────────────

export type BrainMode = 'idle' | 'retrieve' | 'respond'

export interface Retrieval {
  depth: Float64Array          // BFS hop distance from the surfaced seeds
  maxD: number
  results: Set<number>
  start: number                // simT at start
  query: string
}

export const heartOf = (simT: number) => Math.pow((Math.sin(simT * 2.2) + 1) / 2, 1.6)

export function startRetrieval(
  scene: Scene, surfacedIds: string[], query: string, simT: number,
): Retrieval | null {
  const seeds = surfacedIds.map(id => scene.byId.get(id)).filter((i): i is number => i !== undefined)
  if (!seeds.length) return null
  // no hard reset: existing glow decays naturally under the new wavefront
  const depth = new Float64Array(scene.nodes.length).fill(Infinity)
  const bfs = [...seeds]
  seeds.forEach(s => { depth[s] = 0 })
  for (let h = 0; h < bfs.length; h++) {
    const id = bfs[h]
    for (const nb of scene.nodes[id].out) if (!Number.isFinite(depth[nb])) {
      depth[nb] = depth[id] + 1
      bfs.push(nb)
    }
  }
  const maxD = Math.min(3, bfs.length ? depth[bfs[bfs.length - 1]] : 0)
  return { depth, maxD, results: new Set(seeds), start: simT, query }
}

/** Advance the wavefront; returns true when it has fully passed. */
export function applyRetrieval(scene: Scene, r: Retrieval, simT: number): boolean {
  const wf = (simT - r.start) * 1.5
  for (let i = 0; i < scene.nodes.length; i++) {
    const d = r.depth[i]
    if (!Number.isFinite(d) || d > r.maxD) continue
    const x = wf - d
    if (x > -1) {
      const n = scene.nodes[i]
      n.act = Math.max(n.act, Math.exp(-x * x / 0.30) * (1 - d * 0.15))
      if (x > 0 && r.results.has(i)) n.rim = 1
    }
  }
  return wf > r.maxD + 1.5
}

/** Edge glow while the wavefront crosses it (0 when no retrieval). */
export function edgeFlow(r: Retrieval | null, i: number, j: number, simT: number): number {
  if (!r) return 0
  const di = r.depth[i], dj = r.depth[j]
  if (!Number.isFinite(di) || !Number.isFinite(dj) || Math.abs(di - dj) > 1) return 0
  const f = (simT - r.start) * 1.5 - Math.min(di, dj)
  return f > 0 && f < 1.6 ? Math.exp(-Math.pow(f - 0.7, 2) / 0.16) : 0
}

/** Per-frame decay + respond-heartbeat weights. Call before drawing. */
export function tickNodes(
  scene: Scene, dt: number, mode: BrainMode,
  centroid: { x: number; y: number; z: number } | null,
): void {
  for (const n of scene.nodes) {
    n.act = Math.max(0, n.act - dt * (mode === 'respond' ? 0.10 : 0.45))
    // results fade out gently everywhere except while actively responding
    if (mode !== 'respond') n.rim = Math.max(0, n.rim - dt * 0.5)
    n.near = 0
  }
  // near is always maintained when a centroid exists; the page's respond
  // envelope (respondAmp) gates how much of it shows — never a hard snap
  if (centroid) {
    for (const n of scene.nodes) {
      n.near = Math.exp(-Math.hypot(n.x - centroid.x, n.y - centroid.y, n.z - centroid.z) / 130)
    }
  }
}

export function resultCentroid(scene: Scene, r: Retrieval) {
  let x = 0, y = 0, z = 0, k = 0
  for (const i of r.results) { const n = scene.nodes[i]; x += n.x; y += n.y; z += n.z; k++ }
  return k ? { x: x / k, y: y / k, z: z / k } : { x: 0, y: 0, z: 0 }
}
