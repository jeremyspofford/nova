/**
 * Brain — 2D "Graph" view (Obsidian-style).
 *
 * A flat, force-directed graph you pan/zoom around, in the spirit of Obsidian's
 * graph pane: circular nodes sized by connectivity, straight links, labels that
 * fade in as you zoom, and a hover spotlight that dims everything except the
 * focused node's neighbourhood. Cognition still lights it up — the same amber
 * activation the 3D views use (retrieval wavefront + respond heartbeat) rides on
 * scene node state, so a Pulse or chat retrieval glows here too.
 *
 * Layout uses d3-force (already a dep). The page owns the rAF loop and pointer
 * events; this module owns its simulation and a pan/zoom transform. Plain
 * canvas-2D, consistent with the other renderers. Teal = steady, amber = thinking.
 */

import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation,
} from 'd3-force'
import {
  AMBER, Scene, TEAL, TEAL_BRIGHT, css, edgeFlow, heartOf, mix,
} from './engine'
import { FrameCtx, GOLDW, applyGrain, paintNebula } from './renderers'

interface SimNode {
  i: number
  x: number
  y: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}
interface SimLink { source: number | SimNode; target: number | SimNode }

const STONE = 'rgba(214,211,209,'   // label ink (stone-300)
const nodeR = (deg: number) => 3 + Math.log2(1 + deg) * 2.1

export interface Graph2D {
  draw(ctx: CanvasRenderingContext2D, scene: Scene, f: FrameCtx, drift: boolean, offset: number): void
  pan(dx: number, dy: number): void
  zoomAt(mx: number, my: number, deltaY: number): void
  /** node index under the cursor, or -1 */
  pick(mx: number, my: number): number
  /** current screen position of a node (for overlays), or null */
  screenOf(i: number): { x: number; y: number } | null
  /** re-fit the whole graph into view on the next frame */
  requestFit(): void
  reset(): void
}

export function createGraph2D(): Graph2D {
  let bound: Scene | null = null
  let sim: Simulation<SimNode, SimLink> | null = null
  let nodes: SimNode[] = []
  let links: SimLink[] = []

  // view transform: screen = tx + ox + world * scale
  let scale = 1, tx = 0, ty = 0
  let ox = 0                    // eased horizontal offset (chat drawer)
  let wantFit = true
  const screen: ({ x: number; y: number; r: number } | null)[] = []

  function build(scene: Scene) {
    bound = scene
    nodes = scene.nodes.map((n, i) => ({
      i,
      // seed from the galaxy's relaxed x/z so we start near a sane shape
      x: n.gx * 1.7 + (n.phase - Math.PI) * 2,
      y: n.gz * 1.7,
    }))
    if (scene.soulIdx >= 0) {
      // the soul anchors the layout: fixed at the origin, everything grows around it
      nodes[scene.soulIdx].x = 0
      nodes[scene.soulIdx].y = 0
      nodes[scene.soulIdx].fx = 0
      nodes[scene.soulIdx].fy = 0
    }
    links = scene.edges.map(([a, b]) => ({ source: a, target: b }))

    sim = forceSimulation(nodes)
      .force('charge', forceManyBody<SimNode>().strength(-58).distanceMax(380))
      .force('link', forceLink<SimNode, SimLink>(links).distance(36).strength(0.28))
      .force('collide', forceCollide<SimNode>().radius(d => nodeR(scene.nodes[d.i].degree) + 5).strength(0.9))
      .force('x', forceX<SimNode>(0).strength(0.045))
      .force('y', forceY<SimNode>(0).strength(0.045))
      .stop()

    // pre-warm so the first painted frame already looks settled
    for (let k = 0; k < 200; k++) sim.tick()
    wantFit = true
  }

  function fit(W: number, H: number) {
    if (!nodes.length) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x)
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y)
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY)
    scale = Math.max(0.15, Math.min(2.2, Math.min((W * 0.82) / bw, (H * 0.82) / bh)))
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    tx = W / 2 - ox - cx * scale
    ty = H / 2 - cy * scale
  }

  const s2w = (sx: number, sy: number) => ({ x: (sx - ox - tx) / scale, y: (sy - ty) / scale })

  return {
    reset() { wantFit = true },
    requestFit() { wantFit = true },

    pan(dx, dy) { tx += dx; ty += dy },

    zoomAt(mx, my, deltaY) {
      const w = s2w(mx, my)
      scale = Math.max(0.12, Math.min(6, scale * Math.exp(-deltaY * 0.0012)))
      tx = mx - ox - w.x * scale
      ty = my - w.y * scale
    },

    screenOf(i) {
      const p = screen[i]
      return p ? { x: p.x, y: p.y } : null
    },

    pick(mx, my) {
      let best = -1, bd = 16
      for (let i = 0; i < screen.length; i++) {
        const p = screen[i]
        if (!p) continue
        const hit = Math.max(7, p.r + 4)
        const d = Math.hypot(p.x - mx, p.y - my)
        if (d < hit && d < bd) { bd = d; best = i }
      }
      return best
    },

    draw(ctx, scene, f, drift, offsetTarget) {
      if (scene !== bound) build(scene)
      ox += (offsetTarget - ox) * Math.min(1, f.dt * 6)
      if (wantFit) { fit(f.W, f.H); wantFit = false }

      // keep the layout gently alive while drifting; otherwise let it rest
      if (sim && !f.reduceMotion) {
        sim.alphaTarget(drift ? 0.012 : 0)
        if (sim.alpha() > 0.006) { sim.tick(); if (drift) sim.tick() }
      }
      // publish 2D positions onto the shared scene so cognition helpers (act/
      // near/rim) operate in this view's space too
      for (const sn of nodes) {
        const n = scene.nodes[sn.i]
        n.x = sn.x; n.y = sn.y; n.z = 0
      }

      paintNebula(ctx, f.W, f.H, 0.14, 0.78)
      applyGrain(ctx, f.W, f.H)

      // world → screen for this frame
      if (screen.length !== nodes.length) screen.length = nodes.length
      for (let k = 0; k < nodes.length; k++) {
        const sn = nodes[k]
        const n = scene.nodes[sn.i]
        screen[sn.i] = f.hideJournals && n.cat.key === 'episode' ? null : {
          x: tx + ox + sn.x * scale,
          y: ty + sn.y * scale,
          // journals are the secondary tier: visibly smaller than concepts
          r: Math.max(1.4, nodeR(n.degree) * (n.cat.key === 'episode' ? 0.7 : 1) * scale),
        }
      }

      // hover/selection spotlight: dim everything outside the focus neighbourhood
      const focus = f.hovered >= 0 ? f.hovered : f.selected
      const near = new Set<number>()
      if (focus >= 0) { near.add(focus); for (const j of scene.nodes[focus].out) near.add(j) }
      const dim = (i: number, j?: number) => {
        const spot = focus < 0 ? 1 : (near.has(i) && (j === undefined || near.has(j)) ? 1 : 0.12)
        const hit = !f.search || f.search.has(i) || (j !== undefined && f.search.has(j)) ? 1 : 0.15
        return spot * hit
      }

      const heart = heartOf(f.simT)

      // ── edges: endpoint-tinted gradients with a gentle bow ──
      ctx.lineCap = 'round'
      for (const [i, j] of scene.edges) {
        const a = screen[i], b = screen[j]
        if (!a || !b) continue
        const flow = edgeFlow(f.retrieval, i, j, f.simT)
        const beat = heart * f.respondAmp * Math.min(scene.nodes[i].near, scene.nodes[j].near) * 0.5
        const act = Math.max(Math.min(scene.nodes[i].act, scene.nodes[j].act), flow, beat)
        const d = dim(i, j)
        if (act > 0.03) {
          ctx.strokeStyle = css(AMBER, Math.min(0.85, (0.12 + act * 0.75)) * d)
          ctx.lineWidth = (1 + act * 1.4)
        } else {
          const ca = f.colorByType ? scene.nodes[i].cat.rgb : (scene.nodes[i].degree > 6 ? TEAL_BRIGHT : TEAL)
          const cb = f.colorByType ? scene.nodes[j].cat.rgb : (scene.nodes[j].degree > 6 ? TEAL_BRIGHT : TEAL)
          const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
          g.addColorStop(0, css(ca, 0.26 * d))
          g.addColorStop(0.5, css(mix(ca, cb, 0.5), 0.07 * d))
          g.addColorStop(1, css(cb, 0.26 * d))
          ctx.strokeStyle = g
          ctx.lineWidth = 1
        }
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        const ddx = b.x - a.x, ddy = b.y - a.y
        const len = Math.hypot(ddx, ddy) || 1
        const bow = Math.min(12, len * 0.06)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(mx - (ddy / len) * bow, my + (ddx / len) * bow, b.x, b.y)
        ctx.stroke()
      }

      // ── nodes ──
      for (let i = 0; i < scene.nodes.length; i++) {
        const p = screen[i]
        if (!p) continue
        const n = scene.nodes[i]
        if (n.satKind) {
          // live-state satellite: hollow ring, part of the layout like any node
          const hot = n.satKind === 'drive' ? Math.max(0, Math.min(1, n.satHot ?? 0)) : 0
          const scol = n.satKind === 'drive' ? mix(AMBER, GOLDW, 0.35) : TEAL_BRIGHT
          const dd = dim(i)
          const rr = Math.max(2.2, p.r * 0.8) * (i === f.hovered ? 1.35 : 1)
          if (hot > 0.02) {
            ctx.fillStyle = css(scol, 0.3 * hot * dd)
            ctx.beginPath(); ctx.arc(p.x, p.y, rr * 0.7, 0, 7); ctx.fill()
          }
          ctx.strokeStyle = css(scol, (0.45 + hot * 0.45) * dd)
          ctx.lineWidth = i === f.hovered ? 1.8 : 1.2
          ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, 7); ctx.stroke()
          continue
        }
        const wave = f.reduceMotion ? n.near * 0.45 * f.respondAmp
          : n.near * f.respondAmp * (0.22 + 0.88 * heart)
        const glow = Math.min(1, Math.max(n.act, wave, n.rim * (0.26 + 0.24 * heart)))
        const isSoul = i === scene.soulIdx
        const rgb = isSoul ? mix(GOLDW, [255, 255, 255], 0.25)
          : f.colorByType ? n.cat.rgb : (n.degree > 6 ? TEAL_BRIGHT : TEAL)
        const col = glow > 0.02 ? mix(rgb, AMBER, glow * 0.9) : rgb
        const d = dim(i) * (n.cat.key === 'episode' ? 0.65 : 1)
        const r = p.r * (isSoul ? 1.5 : 1)
          * (i === f.selected ? 1.35 : 1) * (i === f.hovered ? 1.2 : 1) * (1 + glow * 0.5)

        // soft halo — tight at rest; the big glow is earned by cognition
        const haloR = r * (1.7 + glow * 3.2) * (n.degree > 6 ? 1.15 : 1)
        const hg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR)
        hg.addColorStop(0, css(col, (0.22 + glow * 0.5) * d))
        hg.addColorStop(0.4, css(col, 0.07 * d))
        hg.addColorStop(1, css(col, 0))
        ctx.fillStyle = hg
        ctx.beginPath(); ctx.arc(p.x, p.y, haloR, 0, 7); ctx.fill()

        // solid core with a faint rim for definition against the halo
        ctx.fillStyle = css(mix(col, [255, 255, 255], 0.25 + glow * 0.35), Math.min(1, 0.92 * d + glow * 0.3))
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = css(mix(col, [0, 0, 0], 0.35), 0.5 * d)
        ctx.stroke()
      }

      // the soul wears a fine double ring — identity, not activity
      const soulP = bound && bound.soulIdx >= 0 ? screen[bound.soulIdx] : null
      if (soulP) {
        ctx.strokeStyle = css(GOLDW, 0.5)
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(soulP.x, soulP.y, soulP.r * 1.5 + 6, 0, 7); ctx.stroke()
        ctx.strokeStyle = css(GOLDW, 0.16)
        ctx.beginPath(); ctx.arc(soulP.x, soulP.y, soulP.r * 1.5 + 10, 0, 7); ctx.stroke()
      }

      // selection ring
      const selP = f.selected >= 0 ? screen[f.selected] : null
      if (selP) {
        ctx.strokeStyle = css(TEAL_BRIGHT, 0.9)
        ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.arc(selP.x, selP.y, selP.r + 6, 0, 7); ctx.stroke()
      }

      // ── labels: zoom-gated, plus always for hover/selection/hubs/hits ──
      const labelAlpha = Math.max(0, Math.min(1, (scale - 0.55) / 0.5))
      if (labelAlpha > 0.02 || f.showLabels || f.hovered >= 0 || f.selected >= 0 || f.search) {
        ctx.font = '11px "Geist Mono Variable", "Geist Mono", monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.85)' // legible over bright halos
        ctx.shadowBlur = 3
        for (let i = 0; i < scene.nodes.length; i++) {
          const p = screen[i]
          if (!p) continue
          const n = scene.nodes[i]
          const focused = i === f.hovered || i === f.selected
          const hit = f.search?.has(i) ?? false
          // journals join the bulk label pass only when fully zoomed in
          const bulk = (f.showLabels || labelAlpha > 0.02)
            && (n.cat.key === 'episode' ? labelAlpha > 0.85 : (n.degree >= 4 || labelAlpha > 0.6))
          const show = focused || hit || bulk || i === scene.soulIdx
          if (!show) continue
          const a = focused || hit ? 0.96 : labelAlpha * (n.degree >= 6 ? 0.85 : 0.6) * dim(i)
          if (a < 0.03) continue
          const label = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label
          ctx.fillStyle = STONE + a + ')'
          ctx.fillText(label, p.x, p.y + p.r + 4)
        }
        ctx.restore()
      }
    },
  }
}
