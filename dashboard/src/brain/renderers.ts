/**
 * Brain renderers — three draw pipelines over the shared engine scene:
 *   galaxy      calm constellation, force layout (default)
 *   orrery      structured type rings + journal time-spiral
 *   singularity presence view — event horizon + accretion disk, no nodes
 *
 * All are plain canvas-2D functions; the page owns the rAF loop and hands
 * them a FrameCtx. Teal = steady state, amber = cognition (DESIGN.md).
 */

import {
  AMBER, BrainMode, Camera, CATS, css, heartOf, mix, mulberry32, Projected,
  project, Retrieval, RINGS, Scene, SPIRAL_DA, SPIRAL_DR, SPIRAL_R0,
  TEAL, TEAL_BRIGHT, edgeFlow, layoutOrrery,
} from './engine'

export interface FrameCtx {
  W: number
  H: number
  dt: number
  simT: number
  mode: BrainMode
  retrieval: Retrieval | null
  colorByType: boolean
  showLabels: boolean
  selected: number
  hovered: number
  reduceMotion: boolean
  /** orrery ring rotation accumulator (advances only while drift is on) */
  rotT: number
  /** respond envelope 0..1 — eases in/out so the heartbeat never snaps */
  respondAmp: number
  /** hide journal/reflection episodes (the secondary tier) */
  hideJournals: boolean
  /** search hits — everything outside the set dims away; null = no search */
  search: Set<number> | null
}

export const GOLDW: [number, number, number] = [255, 214, 140]

// ── Shared background: debanded nebula + film-grain dither ───────────────────
// Canvas radial gradients posterize badly on dark surfaces — a 2-stop teal→black
// ramp shows concentric bands. Two fixes, applied together:
//   1. smootherstep alpha over 10 stops → the falloff has no hard steps
//   2. a low-amplitude grain pattern in `overlay` blend → dithers the residual
//      8-bit banding away without visibly texturing the scene.

const NEB_TEAL: [number, number, number] = [8, 45, 42]

let grainTile: HTMLCanvasElement | null = null
function grain(): HTMLCanvasElement {
  if (grainTile) return grainTile
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const img = g.createImageData(128, 128)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 118 + Math.random() * 20 // centered on 128 (overlay identity), ±10
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  grainTile = c
  return c
}

/** Opaque warm-black base + eased teal glow. No banding, no transparency seams. */
export function paintNebula(
  ctx: CanvasRenderingContext2D, W: number, H: number, peak = 0.28, rad = 0.72,
): void {
  const base = ctx.createLinearGradient(0, 0, 0, H)
  base.addColorStop(0, '#0C0A09')
  base.addColorStop(1, '#080F0E') // faint teal-black floor for depth
  ctx.fillStyle = base
  ctx.fillRect(0, 0, W, H)

  const R = Math.max(W, H) * rad
  const g = ctx.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, R)
  const N = 10
  for (let k = 0; k <= N; k++) {
    const t = k / N
    const s = t * t * t * (t * (t * 6 - 15) + 10) // smootherstep
    g.addColorStop(t, css(NEB_TEAL, peak * (1 - s)))
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}

/** Dither pass — call right after the background, before bright content. */
export function applyGrain(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const pat = ctx.createPattern(grain(), 'repeat')
  if (!pat) return
  ctx.save()
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = 0.55
  ctx.fillStyle = pat
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
}

// ── Shared node sprite ──────────────────────────────────────────────────────

function nodeRadius(nDeg: number, s: number): number {
  return (2.1 + Math.log2(1 + nDeg) * 1.5) * s * 0.55
}

function drawNodes(
  ctx: CanvasRenderingContext2D, scene: Scene, P: (Projected | null)[], f: FrameCtx,
): void {
  const heart = heartOf(f.simT)
  const order = [...scene.nodes.keys()].filter(i => P[i]).sort((i, j) => P[j]!.z - P[i]!.z)

  ctx.globalCompositeOperation = 'lighter'
  for (const i of order) {
    const n = scene.nodes[i], p = P[i]!
    if (n.satKind) {
      // live-state satellite: hollow ring, in-scene (depth-faded like a node),
      // drives glow an ember by real urgency
      const hot = n.satKind === 'drive' ? Math.max(0, Math.min(1, n.satHot ?? 0)) : 0
      const scol = n.satKind === 'drive' ? mix(AMBER, GOLDW, 0.35) : TEAL_BRIGHT
      const satDim = (!f.search || f.search.has(i) ? 1 : 0.15)
        * Math.max(0.3, 1.1 - p.z * 0.0016)
      const rr = Math.max(2, 3.1 * p.s * 0.55) * (i === f.hovered ? 1.35 : 1)
      if (hot > 0.02) {
        ctx.fillStyle = css(scol, 0.28 * hot * satDim)
        ctx.beginPath(); ctx.arc(p.sx, p.sy, rr * 0.7, 0, 7); ctx.fill()
      }
      ctx.strokeStyle = css(scol, (0.4 + hot * 0.5) * satDim)
      ctx.lineWidth = i === f.hovered ? 1.8 : 1.2
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rr, 0, 7); ctx.stroke()
      continue
    }
    const baseR = nodeRadius(n.degree, p.s)
    const wave = f.reduceMotion
      ? n.near * 0.45 * f.respondAmp
      : n.near * f.respondAmp * (0.22 + 0.88 * heart)
    const breathe = f.reduceMotion ? 0 : Math.sin(f.simT * 0.9 + n.phase) * 0.09
    const glow = Math.min(1, Math.max(n.act, wave, n.rim * (0.26 + 0.24 * heart)))
    const isSoul = i === scene.soulIdx
    const rgb = isSoul ? mix(GOLDW, [255, 255, 255], 0.25)
      : f.colorByType ? n.cat.rgb : (n.degree > 6 ? TEAL_BRIGHT : TEAL)
    const col = glow > 0.02 ? mix(rgb, AMBER, glow * 0.9) : rgb
    // journals are the secondary tier: smaller and quieter than concepts;
    // the soul is the identity anchor and reads a step brighter
    const tier = isSoul ? 1.5 : n.cat.key === 'episode' ? 0.72 : 1
    const sDim = !f.search || f.search.has(i) ? 1 : 0.15

    const r = baseR * tier * (1 + breathe) * (1 + glow * 0.7)
      * (i === f.selected ? 1.35 : 1) * (i === f.hovered ? 1.2 : 1)
    // resting halos stay tight — the big soft glow is EARNED by cognition
    // (amber activation) and hub status, otherwise everything reads as candy
    const haloR = r * (1.9 + glow * 3.4) * (n.degree > 6 ? 1.15 : 1)
    const depthFade = Math.max(0.25, 1.1 - p.z * 0.0016)
      * (n.cat.key === 'episode' ? 0.6 : 1) * sDim

    const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, haloR)
    g.addColorStop(0, css(col, (0.36 + glow * 0.5) * depthFade))
    g.addColorStop(0.35, css(col, 0.13 * depthFade))
    g.addColorStop(1, css(col, 0))
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(p.sx, p.sy, haloR, 0, 7); ctx.fill()

    ctx.fillStyle = css(mix(col, [255, 255, 255], 0.55 + glow * 0.3),
      Math.min(1, 0.95 * depthFade + glow * 0.4))
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(0.8, r * 0.5), 0, 7); ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'

  // the soul wears a fine double ring — identity, not activity
  if (scene.soulIdx >= 0 && P[scene.soulIdx]) {
    const p = P[scene.soulIdx]!
    const rr = nodeRadius(scene.nodes[scene.soulIdx].degree, p.s) * 1.5
    ctx.strokeStyle = css(GOLDW, 0.5)
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rr + 7, 0, 7); ctx.stroke()
    ctx.strokeStyle = css(GOLDW, 0.16)
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rr + 11, 0, 7); ctx.stroke()
  }

  // selection ring only — retrieval results pulse instead of getting a circle
  if (f.selected >= 0 && P[f.selected]) {
    const p = P[f.selected]!
    const baseR = nodeRadius(scene.nodes[f.selected].degree, p.s)
    ctx.strokeStyle = css(TEAL_BRIGHT, 0.9)
    ctx.lineWidth = 1.4
    ctx.beginPath(); ctx.arc(p.sx, p.sy, baseR * 2.6 + 5, 0, 7); ctx.stroke()
  }

  if (f.showLabels || f.hovered >= 0 || f.selected >= 0 || f.search) {
    ctx.font = '10.5px "Geist Mono Variable", "Geist Mono", monospace'
    ctx.textAlign = 'left'
    for (const i of order) {
      const n = scene.nodes[i], p = P[i]!
      const hit = f.search?.has(i) ?? false
      // journals never join the bulk label pass — hover/select/search only
      const show = (f.showLabels && n.cat.key !== 'episode' && (n.degree >= 5 || n.act > 0.25))
        || i === f.hovered || i === f.selected || n.rim > 0.3 || hit || i === scene.soulIdx
      if (!show) continue
      const a = Math.max(0.4, 1.05 - p.z * 0.0016) * (!f.search || hit ? 1 : 0.15)
      ctx.fillStyle = `rgba(250,250,249,${i === f.hovered || i === f.selected || hit ? 0.95 : a * 0.62})`
      ctx.fillText(n.label, p.sx + 9, p.sy + 3.5)
    }
  }
}

function drawEdges(
  ctx: CanvasRenderingContext2D, scene: Scene, P: (Projected | null)[], f: FrameCtx,
  baseAlpha: (depth: number) => number,
): void {
  const heart = heartOf(f.simT)
  for (const [i, j] of scene.edges) {
    const a = P[i], b = P[j]
    if (!a || !b) continue
    const sDim = !f.search || f.search.has(i) || f.search.has(j) ? 1 : 0.15
    const depth = (a.z + b.z) / 2
    const base = baseAlpha(depth) * sDim
    const flow = edgeFlow(f.retrieval, i, j, f.simT)
    const beat = heart * f.respondAmp * Math.min(scene.nodes[i].near, scene.nodes[j].near) * 0.55
    const act = Math.max(Math.min(scene.nodes[i].act, scene.nodes[j].act), flow, beat)
    if (act > 0.02) {
      ctx.strokeStyle = css(AMBER, Math.min(0.8, base + act * 0.75 * sDim))
      ctx.lineWidth = 1 + act * 1.3
    } else {
      // endpoint-tinted gradient, near-transparent midpoint — links read as
      // belonging to their nodes instead of a flat wireframe
      const ca = f.colorByType ? scene.nodes[i].cat.rgb : (scene.nodes[i].degree > 6 ? TEAL_BRIGHT : TEAL)
      const cb = f.colorByType ? scene.nodes[j].cat.rgb : (scene.nodes[j].degree > 6 ? TEAL_BRIGHT : TEAL)
      const g = ctx.createLinearGradient(a.sx, a.sy, b.sx, b.sy)
      g.addColorStop(0, css(ca, Math.min(0.5, base * 1.6)))
      g.addColorStop(0.5, css(mix(ca, cb, 0.5), base * 0.4))
      g.addColorStop(1, css(cb, Math.min(0.5, base * 1.6)))
      ctx.strokeStyle = g
      ctx.lineWidth = 1
    }
    // gentle bow perpendicular to the chord — dense regions weave, not clutter
    const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2
    const ddx = b.sx - a.sx, ddy = b.sy - a.sy
    const len = Math.hypot(ddx, ddy) || 1
    const bow = Math.min(12, len * 0.06)
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.quadraticCurveTo(mx - (ddy / len) * bow, my + (ddx / len) * bow, b.sx, b.sy)
    ctx.stroke()
  }
}

// ── Galaxy ──────────────────────────────────────────────────────────────────

// Three parallax depths that drift with the camera; sizes/brightness follow an
// exponential distribution (many faint, few bright) and stars are round —
// uniform square pixels are what made the old field read as noise.
const starRnd = mulberry32(7)
const STAR_LAYERS = [0.35, 0.7, 1.15].map(depth => ({
  depth,
  stars: Array.from({ length: 70 }, () => ({
    x: starRnd(), y: starRnd(),
    r: 0.35 + Math.pow(starRnd(), 2.2) * 1.1,
    a: 0.05 + Math.pow(starRnd(), 2.6) * 0.42,
    tw: 0.3 + starRnd() * 1.1, ph: starRnd() * Math.PI * 2,
  })),
}))

function drawStarfield(
  ctx: CanvasRenderingContext2D, W: number, H: number, cam: Camera,
  simT: number, reduceMotion: boolean,
): void {
  for (const layer of STAR_LAYERS) {
    const oxs = cam.yaw * 0.035 * layer.depth
    const oys = cam.pitch * 0.05 * layer.depth
    for (const s of layer.stars) {
      const x = (((s.x - oxs) % 1) + 1) % 1 * W
      const y = (((s.y - oys) % 1) + 1) % 1 * H
      const tw = reduceMotion ? 1 : 0.75 + 0.25 * Math.sin(simT * s.tw + s.ph)
      ctx.fillStyle = `rgba(250,250,249,${s.a * tw})`
      ctx.beginPath(); ctx.arc(x, y, s.r * (0.7 + 0.45 * layer.depth), 0, 7); ctx.fill()
    }
  }
}

export function drawGalaxy(
  ctx: CanvasRenderingContext2D, scene: Scene, cam: Camera, f: FrameCtx,
  P: (Projected | null)[],
): void {
  for (const n of scene.nodes) { n.x = n.gx; n.y = n.gy; n.z = n.gz }

  paintNebula(ctx, f.W, f.H, 0.30, 0.70)
  applyGrain(ctx, f.W, f.H)
  drawStarfield(ctx, f.W, f.H, cam, f.simT, f.reduceMotion)

  for (let i = 0; i < scene.nodes.length; i++) {
    const n = scene.nodes[i]
    P[i] = f.hideJournals && n.cat.key === 'episode'
      ? null : project(n.x, n.y, n.z, cam, f.W, f.H)
  }
  drawEdges(ctx, scene, P, f, depth => Math.max(0.03, 0.16 - depth * 0.00022))
  drawNodes(ctx, scene, P, f)
}

// ── Orrery ──────────────────────────────────────────────────────────────────

export function drawOrrery(
  ctx: CanvasRenderingContext2D, scene: Scene, cam: Camera, f: FrameCtx,
  P: (Projected | null)[],
): void {
  layoutOrrery(scene)
  for (const n of scene.nodes) {
    const a = n.a0 + n.w * f.rotT
    n.x = Math.cos(a) * n.rad; n.z = Math.sin(a) * n.rad; n.y = n.yy
  }

  paintNebula(ctx, f.W, f.H, 0.16, 0.74)
  applyGrain(ctx, f.W, f.H)

  const heart = heartOf(f.simT)
  const ringPath = (rad: number) => {
    ctx.beginPath()
    let started = false
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2
      const p = project(Math.cos(a) * rad, 0, Math.sin(a) * rad, cam, f.W, f.H)
      if (!p) { started = false; continue }
      if (!started) { ctx.moveTo(p.sx, p.sy); started = true } else ctx.lineTo(p.sx, p.sy)
    }
  }

  // ring guides + dial labels
  ctx.font = '10px "Geist Mono Variable", "Geist Mono", monospace'
  ctx.textAlign = 'left'
  for (const ring of RINGS) {
    ringPath(ring.rad)
    ctx.strokeStyle = 'rgba(250,250,249,0.05)'
    ctx.lineWidth = 1
    ctx.stroke()
    const lp = project(ring.rad, 0, 0, cam, f.W, f.H)
    if (lp) {
      const c = CATS[ring.cat]
      ctx.fillStyle = 'rgba(120,113,108,0.9)'
      ctx.fillText(c.label.toUpperCase() + 'S', lp.sx + 8, lp.sy - 4)
      ctx.fillStyle = f.colorByType ? c.color : 'rgba(25,168,158,0.7)'
      ctx.fillRect(lp.sx + 8, lp.sy - 1, 14, 1.5)
    }
  }
  // journal spiral guide
  if (!f.hideJournals && scene.spiralCount > 0) {
    ctx.beginPath()
    let started = false
    for (let k = 0; k <= scene.spiralCount * 10; k++) {
      const t = k / 10
      const a = -0.8 + t * SPIRAL_DA + 0.012 * f.rotT
      const rad = SPIRAL_R0 + t * SPIRAL_DR
      const p = project(Math.cos(a) * rad, 2 + t * 1.4, Math.sin(a) * rad, cam, f.W, f.H)
      if (!p) { started = false; continue }
      if (!started) { ctx.moveTo(p.sx, p.sy); started = true } else ctx.lineTo(p.sx, p.sy)
    }
    ctx.strokeStyle = 'rgba(244,63,94,0.10)'
    ctx.stroke()
    const sl = project(Math.cos(-0.8 + 0.012 * f.rotT) * SPIRAL_R0, 2,
      Math.sin(-0.8 + 0.012 * f.rotT) * SPIRAL_R0, cam, f.W, f.H)
    if (sl) {
      ctx.fillStyle = 'rgba(120,113,108,0.9)'
      ctx.fillText('JOURNAL → PAST', sl.sx + 8, sl.sy + 12)
    }
  }

  // center: the soul node holds the dial's centre when present; otherwise
  // index.md marks it — beats amber while responding
  const c0 = scene.soulIdx >= 0 ? null : project(0, 0, 0, cam, f.W, f.H)
  if (c0) {
    const beat = f.reduceMotion ? 0 : heart * f.respondAmp
    const coreCol = beat > 0 ? mix(TEAL_BRIGHT, AMBER, beat * 0.7) : TEAL_BRIGHT
    const cr = 26 * c0.s * 0.55 * (1 + beat * 0.55)
    const g = ctx.createRadialGradient(c0.sx, c0.sy, 0, c0.sx, c0.sy, cr)
    g.addColorStop(0, css(coreCol, 0.7 + beat * 0.3))
    g.addColorStop(0.4, css(TEAL, 0.25 + beat * 0.15))
    g.addColorStop(1, css(TEAL, 0))
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(c0.sx, c0.sy, cr, 0, 7); ctx.fill()
    ctx.fillStyle = 'rgba(250,250,249,0.9)'
    ctx.beginPath(); ctx.arc(c0.sx, c0.sy, 2.4, 0, 7); ctx.fill()
    ctx.fillStyle = 'rgba(168,162,158,0.85)'
    ctx.fillText('index.md', c0.sx + 9, c0.sy + 3.5)
  }

  // radar sweep during the first beat of a retrieval
  if (f.retrieval) {
    const t = (f.simT - f.retrieval.start) / 1.15
    if (t < 1) {
      const maxR = SPIRAL_R0 + scene.spiralCount * SPIRAL_DR + 8
      const a = t * Math.PI * 2 - 0.8
      for (let trail = 0; trail < 10; trail++) {
        const ta = a - trail * 0.05
        const p1 = project(Math.cos(ta) * 8, 0, Math.sin(ta) * 8, cam, f.W, f.H)
        const p2 = project(Math.cos(ta) * maxR, 0, Math.sin(ta) * maxR, cam, f.W, f.H)
        if (p1 && p2) {
          ctx.strokeStyle = css(AMBER, (1 - t) * 0.32 * (1 - trail / 10))
          ctx.lineWidth = 1.2
          ctx.beginPath(); ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke()
        }
      }
    }
  }

  // respond: the outer dial breathes with the heartbeat (enveloped)
  if (f.respondAmp > 0.02 && !f.reduceMotion) {
    ringPath(RINGS[RINGS.length - 1].rad + 10)
    ctx.strokeStyle = css(AMBER, (0.10 + heart * 0.30) * f.respondAmp)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  for (let i = 0; i < scene.nodes.length; i++) {
    const n = scene.nodes[i]
    P[i] = f.hideJournals && n.cat.key === 'episode'
      ? null : project(n.x, n.y, n.z, cam, f.W, f.H)
  }
  drawEdges(ctx, scene, P, f, depth => Math.max(0.025, 0.11 - depth * 0.00016))
  drawNodes(ctx, scene, P, f)
}

// ── Singularity (stateful: trail-fade + own particle field) ─────────────────

const CYAN: [number, number, number] = [92, 232, 208]
const ICE: [number, number, number] = [214, 240, 235]
const WHITE: [number, number, number] = [240, 250, 250]

// Thin-disk temperature falls with radius (T ∝ r^-3/4): white-gold inner edge
// through amber to a cool teal rim, bridged by a pale stop so the blend never
// passes through muddy green. Nova palette only — no synthwave violet/pink.
const DISK_STOPS: [number, [number, number, number]][] = [
  [0.00, [255, 244, 214]],
  [0.20, [255, 214, 140]],  // gold
  [0.45, [251, 191, 36]],   // amber
  [0.62, ICE],              // bridge
  [0.80, CYAN],             // teal-300
  [1.00, [25, 168, 158]],   // teal-500
]

function diskColor(u: number, jitter: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, u + jitter * 0.08))
  for (let k = 1; k < DISK_STOPS.length; k++) {
    if (t <= DISK_STOPS[k][0]) {
      const [t0, c0] = DISK_STOPS[k - 1], [t1, c1] = DISK_STOPS[k]
      return mix(c0, c1, (t - t0) / (t1 - t0))
    }
  }
  return DISK_STOPS[DISK_STOPS.length - 1][1]
}

const RHW = 50, RMINW = RHW * 1.22, RMAXW = 235
const ROLL = -0.13
const cosR = Math.cos(ROLL), sinR = Math.sin(ROLL)

// Backdrop stars for the singularity: the shadow is visible by what it does
// to the light behind it — occlusion inside, deflection just outside.
const singStarRnd = mulberry32(11)
const SING_STARS = Array.from({ length: 110 }, () => ({
  x: singStarRnd(), y: singStarRnd(),
  r: 0.3 + Math.pow(singStarRnd(), 2) * 1.0,
  a: 0.05 + Math.pow(singStarRnd(), 2.4) * 0.5,
}))

interface DiskP {
  u: number; a: number; spark: boolean
  size: number; alpha: number; tw: number; ph: number; scat: number
  p0: { x: number; y: number; front: boolean } | null
  p1: { x: number; y: number; front: boolean } | null
}

export interface Singularity {
  draw(ctx: CanvasRenderingContext2D, f: FrameCtx, cam: Camera, drift: boolean): void
  stir(): void
  reset(): void
}

export function createSingularity(): Singularity {
  const rnd = mulberry32(20260710)
  const disk: DiskP[] = []
  for (let i = 0; i < 820; i++) {
    const t = Math.pow(rnd(), 1.8)
    disk.push({
      u: t, a: rnd() * Math.PI * 2, spark: rnd() < 0.04,
      size: 0.5 + rnd() * 1.2, alpha: 0.035 + rnd() * 0.07,
      tw: 0.4 + rnd() * 1.2, ph: rnd() * Math.PI * 2, scat: rnd() - 0.5,
      p0: null, p1: null,
    })
  }
  const comets: { a: number; u: number; w: number }[] = []
  const pulses: { r: number }[] = []
  let speedEase = 1, ringFlash = 0, lastBeat = 0, camStir = -9, needClear = true

  const projS = (
    x: number, y: number, z: number, cam: Camera, W: number, H: number,
  ) => {
    const syw = Math.sin(cam.yaw), cyw = Math.cos(cam.yaw)
    const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
    const X = x * cyw - z * syw, Zr = x * syw + z * cyw
    const Y = y * cp - Zr * sp, Zc = y * sp + Zr * cp
    const Z = Zc + cam.dist
    if (Z < 40) return null
    const s = cam.fov / Z
    const px = X * s, py = Y * s
    return {
      x: W / 2 + cam.cx + cam.ox + px * cosR - py * sinR,
      y: H * 0.52 + cam.cy + px * sinR + py * cosR,
      // camera-space depth grows away from the viewer: Zc < 0 is NEARER than
      // the hole — only that half of the disk may draw over the event horizon
      front: Zc < 0,
    }
  }
  const diskXYZ = (a: number, u: number, scat: number): [number, number, number] => {
    const r = RMINW + (RMAXW - RMINW) * u
    return [Math.cos(a) * r, scat * r * 0.045, Math.sin(a) * r]
  }

  return {
    stir() { camStir = -1e9 + 1 }, // sentinel replaced in draw with simT
    reset() { needClear = true; pulses.length = 0; comets.length = 0 },
    draw(ctx, f, cam, drift) {
      const { W, H, dt, simT, mode } = f
      if (camStir === -1e9 + 1) camStir = simT
      const S0 = cam.fov / cam.dist
      const RH = RHW * S0
      const CX = W / 2 + cam.cx + cam.ox, CY = H * 0.52 + cam.cy

      const targetSpeed = mode === 'retrieve' ? 2.1 : mode === 'respond' ? 1.15 : 1
      speedEase += (targetSpeed - speedEase) * Math.min(1, dt * 2.5)
      const heart = Math.pow((Math.sin(simT * 2.2) + 1) / 2, 1.7)
      const amp = f.respondAmp
      const bright = (mode === 'retrieve' ? 1.15 : 1) * (1 - amp) + (0.8 + 0.45 * heart) * amp
      const brightD = Math.min(1.2, bright)
      ringFlash = Math.max(0, ringFlash - dt * 1.6)

      if (needClear || f.reduceMotion) {
        ctx.fillStyle = '#061110'; ctx.fillRect(0, 0, W, H); needClear = false
      } else {
        const stirring = simT - camStir < 0.5
        ctx.fillStyle = stirring ? 'rgba(6,17,16,0.30)' : 'rgba(6,17,16,0.10)'
        ctx.fillRect(0, 0, W, H)
      }

      // background stars: swallowed inside the shadow, pushed outward just
      // beyond it (weak-field deflection) — the hole shows as pure absence
      const trailComp = f.reduceMotion ? 1 : 0.11 // equilibrium vs the fade veil
      const DEFL = RH * RH * 0.8
      const deflEdge = DEFL / (RH * 2.4)
      for (const st of SING_STARS) {
        let x = st.x * W, y = st.y * H
        const dx = x - CX, dy = y - CY
        const d = Math.hypot(dx, dy)
        if (d < RH * 1.02) continue
        if (d < RH * 2.4) {
          const k = DEFL / d - deflEdge
          x += (dx / d) * k; y += (dy / d) * k
        }
        ctx.fillStyle = `rgba(235,248,246,${st.a * trailComp})`
        ctx.beginPath(); ctx.arc(x, y, st.r, 0, 7); ctx.fill()
      }

      if (amp > 0.5 && !f.reduceMotion && simT - lastBeat > 1.35) {
        lastBeat = simT
        if (pulses.length < 2) pulses.push({ r: RHW + 3 })
      }

      const spd = (drift ? 1 : 0) * speedEase * (f.reduceMotion ? 0 : 1)
      for (const p of disk) {
        const w = 0.38 * Math.pow(RMINW / (RMINW + (RMAXW - RMINW) * p.u), 1.5)
        const a0 = p.a
        p.a += w * spd * dt
        if (mode === 'retrieve' && !f.reduceMotion) {
          p.u -= p.u * 0.20 * dt
          if (p.u < 0.015) { p.u = 0.85 + rnd() * 0.15; p.a = rnd() * Math.PI * 2 }
        }
        const q0 = diskXYZ(a0 - w * Math.max(spd, 0.4) * 0.22, p.u, p.scat)
        const q1 = diskXYZ(p.a, p.u, p.scat)
        p.p0 = projS(q0[0], q0[1], q0[2], cam, W, H)
        p.p1 = projS(q1[0], q1[1], q1[2], cam, W, H)
      }

      // underglow band — thin rings with a gaussian alpha profile
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'butt'
      for (let k = 0; k < 9; k++) {
        const fr = (k - 4) / 4
        const rw = RMINW + (RMAXW - RMINW) * (0.34 + fr * 0.16)
        const al = 0.028 * Math.exp(-fr * fr * 2.2) * brightD
        ctx.strokeStyle = css(k % 3 === 1 ? GOLDW : CYAN, al)
        ctx.lineWidth = RHW * S0 * 0.16
        ctx.beginPath()
        ctx.ellipse(CX, CY, rw * S0, Math.max(0.02, rw * S0 * Math.abs(Math.sin(cam.pitch))), ROLL, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.lineCap = 'round'

      // back half of the disk — anything projecting into the shadow is
      // captured or lensed (the arcs below carry that light), never drawn
      ctx.globalCompositeOperation = 'lighter'
      const shadow2 = RH * RH * 1.30
      for (const p of disk) {
        if (!p.p0 || !p.p1 || p.p1.front) continue
        const bdx = p.p1.x - CX, bdy = p.p1.y - CY
        if (bdx * bdx + bdy * bdy < shadow2) continue
        const twk = 0.6 + 0.4 * Math.sin(simT * p.tw + p.ph)
        const dop = 1 + 0.30 * Math.sin(p.a + cam.yaw)
        const col = p.spark ? WHITE : diskColor(p.u, p.scat)
        ctx.strokeStyle = css(col, p.alpha * twk * brightD * dop * 0.85)
        ctx.lineWidth = p.size
        ctx.beginPath(); ctx.moveTo(p.p0.x, p.p0.y); ctx.lineTo(p.p1.x, p.p1.y); ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'

      // glow crown
      const domeA = 0.09 + 0.07 * heart * amp
      const dome = ctx.createRadialGradient(CX, CY - RH * 0.35, 0, CX, CY - RH * 0.35, RH * 1.6)
      dome.addColorStop(0, css(ICE, domeA))
      dome.addColorStop(0.55, css(TEAL, domeA * 0.35))
      dome.addColorStop(1, css(CYAN, 0))
      ctx.fillStyle = dome
      ctx.beginPath(); ctx.arc(CX, CY - RH * 0.35, RH * 1.6, 0, 7); ctx.fill()

      // the void
      const voidG = ctx.createRadialGradient(CX, CY, RH * 0.55, CX, CY, RH)
      voidG.addColorStop(0, '#010707')
      voidG.addColorStop(0.9, '#020808')
      voidG.addColorStop(1, '#041312')
      ctx.fillStyle = voidG
      ctx.beginPath(); ctx.arc(CX, CY, RH, 0, 7); ctx.fill()

      // photon ring — warm gold-white at the beat peak
      const ringCol = mix(mix(CYAN, WHITE, 0.1), mix(CYAN, GOLDW, 0.25 + 0.45 * heart), amp)
      const flashBoost = 1 + ringFlash * 0.9
      const ringPulse = 1 * (1 - amp) + (0.75 + 0.45 * heart) * amp
      ctx.save()
      ctx.shadowColor = css(ringCol, 0.85)
      ctx.shadowBlur = 14
      for (const [lw, al] of [[5, 0.05], [2.8, 0.15], [1.6, 0.40], [0.8, 0.85]] as const) {
        ctx.strokeStyle = css(ringCol, Math.min(1, al * ringPulse * flashBoost))
        ctx.lineWidth = lw
        ctx.beginPath(); ctx.arc(CX, CY, RH + 2, 0, 7); ctx.stroke()
      }
      ctx.restore()
      ctx.strokeStyle = css(TEAL, 0.09 * ringPulse)
      ctx.lineWidth = 3.5
      ctx.beginPath(); ctx.arc(CX, CY, RH + 6.5, 0, 7); ctx.stroke()

      // gravitational lensing: the far side of the disk reappears wrapped
      // around the shadow — a bright arc over the top, a fainter mirror below
      const arcCol = mix(diskColor(0.30, 0), WHITE, 0.15)
      const arcA = (0.13 + 0.05 * heart * amp) * brightD
      ctx.save()
      ctx.shadowColor = css(arcCol, 0.6)
      ctx.shadowBlur = 10
      ctx.strokeStyle = css(arcCol, arcA)
      ctx.lineWidth = 2.6
      ctx.beginPath(); ctx.ellipse(CX, CY, RH * 1.10, RH * 1.10, ROLL, Math.PI * 1.06, Math.PI * 1.94); ctx.stroke()
      ctx.strokeStyle = css(mix(arcCol, CYAN, 0.5), arcA * 0.4)
      ctx.lineWidth = 1.6
      ctx.beginPath(); ctx.ellipse(CX, CY, RH * 1.16, RH * 1.10, ROLL, Math.PI * 0.10, Math.PI * 0.90); ctx.stroke()
      ctx.restore()

      ctx.globalCompositeOperation = 'lighter'
      // heartbeat halos
      for (let k = pulses.length - 1; k >= 0; k--) {
        const pu = pulses[k]
        pu.r += dt * RHW * 1.5
        const fade = 1 - (pu.r - RHW) / (RHW * 1.6)
        if (fade <= 0) { pulses.splice(k, 1); continue }
        ctx.strokeStyle = css(mix(GOLDW, CYAN, 0.45), fade * 0.15)
        ctx.lineWidth = 1.8
        ctx.beginPath(); ctx.arc(CX, CY, pu.r * S0, 0, 7); ctx.stroke()
      }

      // infalling context during retrieval
      if (mode === 'retrieve' && !f.reduceMotion) {
        if (comets.length < 7 && rnd() < 0.2) comets.push({ a: rnd() * Math.PI * 2, u: 1, w: 1.4 + rnd() * 1.1 })
        for (let k = comets.length - 1; k >= 0; k--) {
          const c = comets[k]
          c.a += c.w * dt
          c.u -= (c.u * 0.9 + 0.10) * dt
          if (c.u <= 0.005) { comets.splice(k, 1); ringFlash = 1; continue }
          const q0 = diskXYZ(c.a - c.w * 0.12, c.u, 0), q1 = diskXYZ(c.a, c.u, 0)
          const a = projS(q0[0], q0[1], q0[2], cam, W, H), b = projS(q1[0], q1[1], q1[2], cam, W, H)
          if (!a || !b || !b.front) continue // far-side comets pass BEHIND the horizon
          ctx.strokeStyle = css(AMBER, 0.45)
          ctx.lineWidth = 1.8
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
          ctx.fillStyle = css(mix(AMBER, WHITE, 0.5), 0.85)
          ctx.beginPath(); ctx.arc(b.x, b.y, 1.6, 0, 7); ctx.fill()
        }
      } else comets.length = 0

      // front half of the disk
      for (const p of disk) {
        if (!p.p0 || !p.p1 || !p.p1.front) continue
        const twk = 0.6 + 0.4 * Math.sin(simT * p.tw + p.ph)
        const dop = 1 + 0.30 * Math.sin(p.a + cam.yaw)
        const col = p.spark ? WHITE : diskColor(p.u, p.scat)
        ctx.strokeStyle = css(col, p.alpha * 1.2 * twk * brightD * dop)
        ctx.lineWidth = p.size
        ctx.beginPath(); ctx.moveTo(p.p0.x, p.p0.y); ctx.lineTo(p.p1.x, p.p1.y); ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
    },
  }
}
