/**
 * Camera-target math: the orbit pivot must be whatever is centred in the view.
 * project() is target-relative; panWorld() moves the target in the camera
 * plane so grab-panning keeps the content under the cursor.
 */
import { describe, expect, it } from 'vitest'
import { Camera, panWorld, project } from './engine'

const cam = (o: Partial<Camera> = {}): Camera => ({
  yaw: 0.6, pitch: 0.32, dist: 300, fov: 640, auto: true,
  cx: 0, cy: 0, ox: 0, tx: 0, ty: 0, tz: 0, ...o,
})

describe('camera orbit target', () => {
  it('projects the target to the screen centre at any yaw/pitch', () => {
    for (const [yaw, pitch] of [[0, 0], [0.6, 0.32], [2.4, -1.1], [-3.0, 0.9]] as const) {
      const c = cam({ yaw, pitch, tx: 37, ty: -12, tz: 81 })
      const p = project(37, -12, 81, c, 800, 600)
      expect(p).not.toBeNull()
      expect(p!.sx).toBeCloseTo(400)
      expect(p!.sy).toBeCloseTo(300)
    }
  })

  it('keeps the target centred while zooming', () => {
    for (const dist of [60, 300, 800]) {
      const p = project(5, 6, 7, cam({ dist, tx: 5, ty: 6, tz: 7 }), 800, 600)
      expect(p!.sx).toBeCloseTo(400)
      expect(p!.sy).toBeCloseTo(300)
    }
  })

  it('grab-pan: the point under the view centre follows the drag exactly', () => {
    const c = cam({ yaw: 1.3, pitch: -0.5, tx: 10, ty: 20, tz: 30 })
    const before = project(10, 20, 30, c, 800, 600)!
    panWorld(c, 25, -40)
    const after = project(10, 20, 30, c, 800, 600)!
    expect(after.sx - before.sx).toBeCloseTo(25)
    expect(after.sy - before.sy).toBeCloseTo(-40)
  })

  it('rotation orbits the panned target, not the world origin', () => {
    const c = cam()
    panWorld(c, 120, -60) // look somewhere off-origin
    const t = { x: c.tx, y: c.ty, z: c.tz }
    for (const yaw of [0, 1, 2, 3]) {
      c.yaw = yaw
      const p = project(t.x, t.y, t.z, c, 800, 600)!
      // the view centre stays fixed under any rotation
      expect(p.sx).toBeCloseTo(400)
      expect(p.sy).toBeCloseTo(300)
    }
  })
})
