// dashboard/src/components/VoiceOrb.tsx
import { useRef, useEffect } from 'react'

export type OrbState = 'listen' | 'think' | 'speak'

interface VoiceOrbProps {
  state: OrbState
  size?: number   // canvas px, default 240
}

export function VoiceOrb({ state, size = 240 }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef  = useRef<OrbState>(state)
  stateRef.current = state   // always current — no stale closure in rAF

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const TAU = Math.PI * 2
    const W = size, H = size, cx = W / 2, cy = H / 2
    const R = size * 0.366   // orb radius — 106px at size=290, 88px at size=240

    // Seeded LCG so stars are reproducible across renders
    function mkRng(seed: number) {
      let s = seed >>> 0
      return () => { s = ((s * 1664525) + 1013904223) >>> 0; return s / 4294967295 }
    }
    const rng = mkRng(5555)
    const stars = Array.from({ length: 40 }, () => ({
      x: rng() * W, y: rng() * H, r: 0.25 + rng() * 0.7,
      a: 0.05 + rng() * 0.18, sp: 0.00011 + rng() * 0.00022, ph: rng() * TAU,
    }))

    function lerp(a: number, b: number, k: number) { return a + (b - a) * k }

    // Display values — lerped each frame for smooth state transitions
    let dOBrt = 0.18, dOScale = 0.90
    let dIBrt = 0.28, dIScale = 0.44
    let rafId: number

    function frame(t: number) {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#030712'
      ctx.fillRect(0, 0, W, H)

      // Background stars
      for (const s of stars) {
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, TAU)
        ctx.fillStyle = `rgba(248,250,252,${s.a * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph))})`
        ctx.fill()
      }

      const s = stateRef.current

      // Outer orb: breathes at base rate
      const oFreq    = s === 'speak' ? 0.00065 : s === 'think' ? 0.00020 : 0.00038
      const oBreathe = 0.5 + 0.5 * Math.sin(t * oFreq)
      const tOBrt    = s === 'speak' ? 0.36 + 0.32 * oBreathe
                     : s === 'think' ? 0.18 + 0.10 * oBreathe
                     :                 0.14 + 0.12 * oBreathe
      const tOScale  = s === 'speak' ? 0.84 + 0.16 * oBreathe
                     : s === 'think' ? 0.84 + 0.04 * oBreathe
                     :                 0.84 + 0.12 * oBreathe

      // Inner orb: 2× faster during speaking, anti-phase during listening
      const iFreq    = s === 'speak' ? oFreq * 2.0 : s === 'think' ? 0.00080 : oFreq * 1.08
      const iPhase   = s === 'listen' ? Math.PI : 0
      const iBreathe = 0.5 + 0.5 * Math.sin(t * iFreq + iPhase)
      const tIBrt    = s === 'speak' ? 0.55 + 0.40 * iBreathe
                     : s === 'think' ? 0.12 + 0.38 * iBreathe
                     :                 0.18 + 0.20 * iBreathe
      const tIScale  = s === 'speak' ? 0.40 + 0.18 * iBreathe
                     : s === 'think' ? 0.30 + 0.12 * iBreathe
                     :                 0.30 + 0.20 * iBreathe

      dOBrt   = lerp(dOBrt,   tOBrt,   0.016)
      dOScale = lerp(dOScale, tOScale, 0.018)
      dIBrt   = lerp(dIBrt,   tIBrt,   0.016)
      dIScale = lerp(dIScale, tIScale, 0.018)

      // Soft outer corona when orb is bright (speaking state)
      if (dOBrt > 0.34) {
        const f  = (dOBrt - 0.34) / 0.34
        const cg = ctx.createRadialGradient(cx, cy, R * 0.88, cx, cy, R + 10 + 6 * oBreathe)
        cg.addColorStop(0, `rgba(20,184,166,${f * 0.13})`)
        cg.addColorStop(1, 'rgba(20,184,166,0)')
        ctx.beginPath(); ctx.arc(cx, cy, R + 16, 0, TAU); ctx.fillStyle = cg; ctx.fill()
      }

      // All orb layers are clipped to a perfect circle — boundary never deforms
      ctx.save()
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip()

      // Outer glow layer — wide soft teal
      const or = R * dOScale
      const go = ctx.createRadialGradient(cx, cy, 0, cx, cy, or)
      go.addColorStop(0,    `rgba(20,184,166,${dOBrt * 0.22})`)
      go.addColorStop(0.42, `rgba(20,184,166,${dOBrt * 0.38})`)
      go.addColorStop(0.75, `rgba(13,148,136,${dOBrt * 0.20})`)
      go.addColorStop(1,    'rgba(13,148,136,0)')
      ctx.beginPath(); ctx.arc(cx, cy, or, 0, TAU); ctx.fillStyle = go; ctx.fill()

      // Inner core — small, bright, white-hot center
      // Subtle drift on gradient focus point gives organic depth without visible motion
      const scale = size / 290
      const dx    = 3.6 * scale * Math.sin(t * 0.0000141)
      const dy    = 3.6 * scale * Math.cos(t * 0.0000196)
      const ir    = R * dIScale
      const gi    = ctx.createRadialGradient(cx + dx, cy + dy, 0, cx, cy, ir)
      gi.addColorStop(0,    `rgba(255,255,255,${dIBrt * 0.97})`)
      gi.addColorStop(0.18, `rgba(210,255,250,${dIBrt * 0.82})`)
      gi.addColorStop(0.42, `rgba(94,234,212,${dIBrt  * 0.55})`)
      gi.addColorStop(0.72, `rgba(20,184,166,${dIBrt  * 0.22})`)
      gi.addColorStop(1,    'rgba(20,184,166,0)')
      ctx.beginPath(); ctx.arc(cx, cy, ir, 0, TAU); ctx.fillStyle = gi; ctx.fill()

      ctx.restore()
      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [size])  // Re-run only if size changes — state is read via ref, not dep

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  )
}
