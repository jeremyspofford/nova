import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error -- plain JS config, no declaration file; only .theme.extend.colors is read
import config from '../../../tailwind.config.js'
import { MODEL_PALETTE } from './spendFormat'
import { themePresets, resolvePalette } from '../../lib/color-palettes'
import { themeVariables } from '../../stores/theme-store'

// T22 (verification-2-7): the Spend chart's model colours are a FIXED palette
// of eight hues that stay apart from each other and readable on the card, in
// light AND dark. The chart paints with Tailwind classes (SpendPage.tsx), so
// these tests resolve each class the way the browser will: tailwind.config.js
// -> one CSS custom property -> its value in index.css for :root (light) and
// html.dark (dark). A class that resolves through a theme token (accent, the
// status tiers) follows the theme — which is how all eight read as teal.

type RGB = [number, number, number]
type Mode = 'light' | 'dark'

const colors = (config as { theme: { extend: { colors: Record<string, unknown> } } }).theme.extend.colors
const css = readFileSync('src/index.css', 'utf8')

/** The custom property a `bg-*` class paints with, or why it has none. */
function propertyOf(cls: string): string {
  const m = cls.match(/^bg-([a-z][a-z0-9-]*)$/)
  if (!m) throw new Error(`${cls}: not a bg-* colour utility`)
  const parts = m[1].split('-')
  let value: unknown
  for (let i = parts.length; i >= 1 && value === undefined; i--) {
    const head = parts.slice(0, i).join('-')
    const tail = parts.slice(i).join('-')
    const entry = (colors as Record<string, unknown>)[head]
    if (entry === undefined) continue
    if (tail === '') value = typeof entry === 'string' ? entry : (entry as Record<string, unknown>).DEFAULT
    else if (typeof entry === 'object' && entry !== null) value = (entry as Record<string, unknown>)[tail]
  }
  if (typeof value !== 'string') throw new Error(`${cls}: not a colour tailwind.config.js defines`)
  const prop = value.match(/^rgb\(var\((--[a-z0-9-]+)\) \/ <alpha-value>\)$/)
  if (!prop) throw new Error(`${cls}: resolves to "${value}", not exactly one custom property with no fallback`)
  return prop[1]
}

/** The property's value in index.css for a mode: the last :root definition
 *  for light; html.dark's own, else the inherited :root one, for dark. */
function cssValue(prop: string, mode: Mode): string | undefined {
  const esc = prop.replace(/[-]/g, '\\-')
  const decl = new RegExp(`${esc}\\s*:\\s*([^;]+);`)
  let light: string | undefined
  let dark: string | undefined
  for (const block of css.matchAll(/(:root|html\.dark)\s*\{([^}]*)\}/g)) {
    const found = block[2].match(decl)?.[1].trim()
    if (found === undefined) continue
    if (block[1] === ':root') light = found
    else dark = found
  }
  return mode === 'light' ? light : (dark ?? light)
}

/** A palette class's colour in a mode, as an "r g b" literal — or an error. */
function resolve(cls: string, mode: Mode): RGB {
  const prop = propertyOf(cls)
  const value = cssValue(prop, mode)
  if (value === undefined) throw new Error(`${cls}: ${prop} has no ${mode} value in index.css`)
  if (!/^\d{1,3} \d{1,3} \d{1,3}$/.test(value)) {
    throw new Error(`${cls}: ${prop} is "${value}" in ${mode} — not a fixed "r g b" colour`)
  }
  return value.split(' ').map(Number) as RGB
}

const triplet = (t: string) => t.split(' ').map(Number) as RGB
const channel = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
/** WCAG 2 contrast ratio. */
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** sRGB (D65) -> CIELAB. */
function lab([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [channel(r), channel(g), channel(b)]
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const [fx, fy, fz] = [f(X), f(Y), f(Z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIEDE2000 colour difference between two CIELAB colours (Sharma 2005). */
function deltaE2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
  const ap1 = (1 + G) * a1
  const ap2 = (1 + G) * a2
  const Cp1 = Math.hypot(ap1, b1)
  const Cp2 = Math.hypot(ap2, b2)
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0
    const h = Math.atan2(b, a) / rad
    return h < 0 ? h + 360 : h
  }
  const hp1 = hue(ap1, b1)
  const hp2 = hue(ap2, b2)
  const dL = L2 - L1
  const dC = Cp2 - Cp1
  let dh = 0
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad)
  const Lbar = (L1 + L2) / 2
  const Cpbar = (Cp1 + Cp2) / 2
  let hbar = hp1 + hp2
  if (Cp1 * Cp2 !== 0) hbar = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2 : (hp1 + hp2) / 2
  const T =
    1 -
    0.17 * Math.cos((hbar - 30) * rad) +
    0.24 * Math.cos(2 * hbar * rad) +
    0.32 * Math.cos((3 * hbar + 6) * rad) -
    0.2 * Math.cos((4 * hbar - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2))
  const RC = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7))
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2)
  const SC = 1 + 0.045 * Cpbar
  const SH = 1 + 0.015 * Cpbar * T
  const RT = -Math.sin(2 * dTheta * rad) * RC
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))
}

// Thresholds (tracker T22 Assumptions): every pair at least a CIEDE2000 of
// 10 apart in each mode; every colour at least 3:1 (WCAG 1.4.11, non-text)
// against every built-in theme's card and page ground in that mode.
const MIN_DELTA_E = 10
const MIN_CONTRAST = 3
const MODES: Mode[] = ['light', 'dark']

describe('T22 helpers', () => {
  it('deltaE2000 matches Sharma\'s published test pairs', () => {
    // Sharma, Wu, Dalal (2005), table 1: pairs 1, 7, 17 and 25.
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3)
    expect(deltaE2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 3)
    expect(deltaE2000([50, 2.5, 0], [56, -27, -3])).toBeCloseTo(31.903, 2)
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3)
  })
})

describe('T22: the Spend chart palette is eight fixed, distinct hues in light and dark', () => {
  it('C1: eight different classes, each a fixed colour per mode that no theme rewrites', () => {
    expect(MODEL_PALETTE).toHaveLength(8)
    expect(new Set(MODEL_PALETTE).size).toBe(8)
    const problems: string[] = []
    const props: string[] = []
    for (const cls of MODEL_PALETTE) {
      try {
        const prop = propertyOf(cls)
        props.push(prop)
        if (/^--(accent|neutral|status|tier|surface|text|border|card|glow|on-accent)\b/.test(prop)) {
          problems.push(`${cls}: ${prop} is a theme token`)
        }
        for (const mode of MODES) resolve(cls, mode)
      } catch (err) {
        problems.push((err as Error).message)
      }
    }
    expect(problems).toEqual([])
    expect(new Set(props).size).toBe(8)
    // No theme, in either mode, sets any of them: the palette does not move
    // with the theme (the defect was every swatch following the teal accent).
    for (const preset of Object.keys(themePresets)) {
      for (const mode of MODES) {
        const vars = themeVariables(mode, preset, 'teal', 1)
        for (const prop of props) expect(vars, `${preset} ${mode} sets ${prop}`).not.toContain(`${prop}:`)
      }
    }
  })

  it.each(MODES)('C2: in %s mode every pair is at least a CIEDE2000 of 10 apart', mode => {
    const shown = MODEL_PALETTE.map(cls => ({ cls, colour: resolve(cls, mode) }))
    const close: string[] = []
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const d = deltaE2000(lab(shown[i].colour), lab(shown[j].colour))
        if (d < MIN_DELTA_E) close.push(`${shown[i].cls} / ${shown[j].cls}: ${d.toFixed(1)}`)
      }
    }
    expect(close).toEqual([])
  })

  it.each(MODES)('C3: in %s mode every colour is at least 3:1 on every built-in theme\'s card and page ground', mode => {
    const grounds: [string, RGB][] = []
    for (const preset of Object.keys(themePresets)) {
      const { neutral, card } = resolvePalette(preset)
      grounds.push([`${preset} card`, triplet(mode === 'light' ? card.light : card.dark)])
      grounds.push([`${preset} ground`, triplet(mode === 'light' ? neutral[50] : neutral[950])])
    }
    const faint: string[] = []
    for (const cls of MODEL_PALETTE) {
      const colour = resolve(cls, mode)
      for (const [name, ground] of grounds) {
        const c = contrast(colour, ground)
        if (c < MIN_CONTRAST) faint.push(`${cls} on ${name}: ${c.toFixed(2)}`)
      }
    }
    expect(faint).toEqual([])
  })
})

describe('T22 coverage: Tailwind emits every palette class from the source it ships in', () => {
  // C1 resolves each class through tailwind.config.js, but a class only
  // exists in the built CSS if Tailwind's content scan finds it written out
  // whole. A palette built as `bg-chart-${n}` passes C1-C4 in jsdom and
  // paints nothing in the browser. Run Tailwind itself over spendFormat.ts.
  it('every MODEL_PALETTE class is emitted, painting with its own --chart property', async () => {
    const { default: postcss } = await import('postcss')
    const { default: tailwind } = await import('tailwindcss')
    const source = readFileSync('src/pages/spend/spendFormat.ts', 'utf8')
    const out = await postcss([
      tailwind({ ...(config as object), content: [{ raw: source, extension: 'ts' }] } as never),
    ]).process('@tailwind utilities;', { from: undefined })
    const missing: string[] = []
    for (const cls of MODEL_PALETTE) {
      const rule = out.css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))
      const prop = propertyOf(cls)
      if (!rule || !rule[1].includes(`var(${prop})`)) missing.push(cls)
    }
    expect(missing).toEqual([])
  })
})
