/**
 * Soul satellites — live, read-only state orbiting the soul node.
 *
 * Cortex drives (amber, glow follows real urgency) on the inner ring and
 * active goals (teal) on the outer ring. They are NOT memory nodes: hollow
 * rings, no modal — clicking deep-links to the page that owns the state.
 * Screen-space, so the same overlay works over every view.
 */
import type { CortexDrive, Goal } from '../api'
import { AMBER, TEAL, TEAL_BRIGHT, css, mix } from './engine'
import { GOLDW } from './renderers'

export interface SatHit {
  x: number
  y: number
  r: number
  label: string
  link: string
}

const R_DRIVES = 46
const R_GOALS = 78
const MAX_GOALS = 8

export function drawSatellites(
  ctx: CanvasRenderingContext2D,
  soul: { x: number; y: number },
  drives: CortexDrive[],
  goals: Goal[],
  simT: number,
  hovered: number,
  reduceMotion: boolean,
  hits: SatHit[], // out param — rebuilt every frame for the page's pointer pick
): void {
  hits.length = 0
  const t = reduceMotion ? 0 : simT

  const place = (k: number, n: number, R: number, w: number, phase: number) => {
    const a = phase + (k / Math.max(1, n)) * Math.PI * 2 + t * w
    return { x: soul.x + Math.cos(a) * R, y: soul.y + Math.sin(a) * R * 0.85 }
  }

  ctx.save()
  ctx.font = '10px "Geist Mono Variable", "Geist Mono", monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  // faint orbit guides
  for (const R of [R_DRIVES, R_GOALS]) {
    ctx.strokeStyle = 'rgba(250,250,249,0.04)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.ellipse(soul.x, soul.y, R, R * 0.85, 0, 0, Math.PI * 2); ctx.stroke()
  }

  drives.forEach((d, k) => {
    const p = place(k, drives.length, R_DRIVES, 0.05, -Math.PI / 2)
    const idx = hits.length
    hits.push({ ...p, r: 10, label: `${d.name} · urgency ${d.urgency.toFixed(2)}`, link: '/goals' })
    const hot = Math.max(0, Math.min(1, d.urgency))
    // spoke
    ctx.strokeStyle = css(AMBER, 0.05 + hot * 0.08)
    ctx.beginPath(); ctx.moveTo(soul.x, soul.y); ctx.lineTo(p.x, p.y); ctx.stroke()
    // hollow ring, warmth by urgency
    ctx.strokeStyle = css(mix(AMBER, GOLDW, 0.3), 0.35 + hot * 0.55)
    ctx.lineWidth = idx === hovered ? 2 : 1.3
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.4 + hot * 1.6, 0, 7); ctx.stroke()
    if (idx === hovered) {
      ctx.fillStyle = 'rgba(250,250,249,0.95)'
      ctx.fillText(hits[idx].label, p.x + 10, p.y)
    }
  })

  goals.slice(0, MAX_GOALS).forEach((g, k) => {
    const p = place(k, Math.min(goals.length, MAX_GOALS), R_GOALS, -0.03, Math.PI / 6)
    const idx = hits.length
    hits.push({ ...p, r: 10, label: g.title, link: '/goals' })
    ctx.strokeStyle = css(TEAL, 0.08)
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(soul.x, soul.y); ctx.lineTo(p.x, p.y); ctx.stroke()
    ctx.strokeStyle = css(TEAL_BRIGHT, idx === hovered ? 0.9 : 0.55)
    ctx.lineWidth = idx === hovered ? 2 : 1.3
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.stroke()
    if (idx === hovered) {
      ctx.fillStyle = 'rgba(250,250,249,0.95)'
      const label = g.title.length > 34 ? g.title.slice(0, 33) + '…' : g.title
      ctx.fillText(label, p.x + 10, p.y)
    }
  })

  ctx.restore()
}
