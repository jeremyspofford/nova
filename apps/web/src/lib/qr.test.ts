import { describe, it, expect } from 'vitest'
import jsQR from 'jsqr'
import { qrMatrix, qrPath, qrRefusal } from './qr'

/** Rasterise the module matrix (4 px a module) and read it back the way a phone camera does. */
function decode(link: string): string | null {
  const m = qrMatrix(link)
  const scale = 4
  const w = m.size * scale
  const px = new Uint8ClampedArray(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const v = m.dark[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255
      const i = (y * w + x) * 4
      px[i] = v
      px[i + 1] = v
      px[i + 2] = v
      px[i + 3] = 255
    }
  }
  return jsQR(px, w, w)?.data ?? null
}

describe('qrMatrix', () => {
  it.each([
    'https://nova.fake-tailnet.ts.net/install',
    'https://nova.fake-tailnet.ts.net/app',
    'https://nova.fake-tailnet.ts.net/add#ABCD-2345',
  ])('decodes back to exactly %s', link => {
    expect(decode(link)).toBe(link)
  })

  it('keeps a four-module quiet zone of light modules on every edge', () => {
    const m = qrMatrix('https://nova.fake-tailnet.ts.net/install')
    for (let i = 0; i < m.size; i++) {
      for (const edge of [0, 1, 2, 3, m.size - 4, m.size - 3, m.size - 2, m.size - 1]) {
        expect(m.dark[edge][i]).toBe(false)
        expect(m.dark[i][edge]).toBe(false)
      }
    }
  })
})

describe('qrPath', () => {
  it('draws one unit square per dark module', () => {
    expect(qrPath({ size: 2, dark: [[true, false], [false, true]] })).toBe('M0 0h1v1h-1zM1 1h1v1h-1z')
  })
})

describe('qrRefusal', () => {
  it('accepts an https tailnet address', () => {
    expect(qrRefusal('https://nova.fake-tailnet.ts.net/add#ABCD-2345')).toBeNull()
  })
  it.each([
    ['http://nova.fake-tailnet.ts.net/install', 'https'],
    ['http://127.0.0.1:3000/install', 'https'],
    ['https://localhost/app', 'this machine only'],
    ['https://127.0.0.1/app', 'an IP address'],
    ['https://192.168.0.245/install', 'an IP address'],
    ['https://[::1]/add', 'an IP address'],
    ['not a link', 'not a link'],
  ])('refuses %s', (link, says) => {
    expect(qrRefusal(link)).toContain(says)
  })
})
