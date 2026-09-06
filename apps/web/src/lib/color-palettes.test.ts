import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { accentPalettes, neutralPalettes, themePresets, resolvePalette, DEFAULT_PRESET } from './color-palettes'

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const

describe('accentPalettes', () => {
  it('teal resolves to the custom Nova accent (500 = #19A89E)', () => {
    expect(accentPalettes.teal[500]).toBe('25 168 158')
  })

  it('tailwind-teal preserves the original stock Tailwind teal scale', () => {
    expect(accentPalettes['tailwind-teal']).toBeDefined()
    expect(accentPalettes['tailwind-teal'][500]).toBe('20 184 166')
  })

  it('every accent palette has the full 50..950 scale', () => {
    for (const [name, scale] of Object.entries(accentPalettes)) {
      for (const shade of SHADES) {
        expect(scale[shade], `${name}.${shade} should be a non-empty RGB triplet`).toBeTruthy()
      }
    }
  })
})

describe('themePresets', () => {
  it('every preset paints with families that exist, and the default is one of them', async () => {
    const { themePresets, neutralPalettes, cardSurface, DEFAULT_PRESET } = await import('./color-palettes')
    expect(themePresets[DEFAULT_PRESET]).toBeDefined()
    for (const [key, p] of Object.entries(themePresets)) {
      expect(accentPalettes[p.accent], `${key}.accent`).toBeDefined()
      expect(neutralPalettes[p.neutral], `${key}.neutral`).toBeDefined()
      expect(cardSurface[p.neutral], `${key} card surface`).toBeDefined()
      if (p.secondary) expect(accentPalettes[p.secondary], `${key}.secondary`).toBeDefined()
    }
  })

  it('the five house themes sit on five different neutral families', async () => {
    const { themePresets } = await import('./color-palettes')
    const house = Object.values(themePresets).filter(p => p.group === 'nova')
    expect(house).toHaveLength(5)
    expect(new Set(house.map(p => p.neutral)).size).toBe(5)
  })

  it('normalizePreset keeps a live key, maps a retired one, and refuses nonsense', async () => {
    const { normalizePreset, LEGACY_PRESETS } = await import('./color-palettes')
    expect(normalizePreset('nebula')).toBe('nebula')
    expect(normalizePreset('default')).toBe('nova')
    expect(normalizePreset('ocean')).toBe('slate')
    expect(normalizePreset('hologram')).toBeNull()
    expect(normalizePreset(42)).toBeNull()
    for (const target of Object.values(LEGACY_PRESETS)) expect(normalizePreset(target)).toBe(target)
  })
})

// ── Legibility is a property of the registry, not a hope ─────────────────
const triplet = (t: string) => t.split(' ').map(Number) as [number, number, number]
const lum = ([r, g, b]: [number, number, number]) => {
  const ch = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
const contrast = (a: string, b: string) => {
  const [l1, l2] = [lum(triplet(a)), lum(triplet(b))].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
/** `over` at alpha on `under`, as the atmosphere paints it (index.css). */
const blend = (over: string, under: string, alpha: number) =>
  triplet(over).map((c, i) => Math.round(c * alpha + triplet(under)[i] * (1 - alpha))).join(' ')

describe('every theme is legible in the mode(s) it renders', () => {
  // The built-in five are ours to guarantee. Community palettes are kept
  // faithful to their sources (Catppuccin Latte's secondary grey is 2.8:1
  // there too), so they are listed, not pinned.
  const house = Object.entries(themePresets).filter(([, p]) => p.group === 'nova')
  // the alpha the light atmosphere actually paints with — read from the
  // stylesheet, so nobody can raise it without moving this number
  const css = readFileSync('src/index.css', 'utf8')
  const glowAlpha = Number(css.match(/--glow-1-light\) \/ ([\d.]+)\)/)?.[1])
  const glow2Alpha = Number(css.match(/--glow-2-light\) \/ ([\d.]+)\)/)?.[1])

  it.each(house)('%s: secondary text and accent text clear WCAG AA on the ground and the card', (key, p) => {
    const { accent, neutral, card } = resolvePalette(key)
    const modes = p.preferredMode ? [p.preferredMode] : ['dark', 'light']
    for (const mode of modes) {
      if (mode === 'dark') {
        // index.css dark: text-secondary = neutral-400, text-accent = accent-500 (--accent-ui)
        expect(contrast(neutral[400], neutral[950]), `${key} dark secondary on root`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(neutral[400], card.dark), `${key} dark secondary on card`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(accent[500], neutral[950]), `${key} dark accent text on root`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(neutral[500], neutral[950]), `${key} dark tertiary on root`).toBeGreaterThanOrEqual(3)
      } else {
        // index.css light: text-secondary = neutral-500, text-accent = accent-700 (--accent-ui),
        // the ground carries accent-100 at glowAlpha where the atmosphere is densest
        expect(glowAlpha).toBeGreaterThan(0)
        expect(glow2Alpha).toBeGreaterThan(0)
        const { secondary } = resolvePalette(key)
        const glowCentre = blend(accent[100], neutral[50], glowAlpha)
        const glow2Centre = blend(secondary[100], neutral[50], glow2Alpha)
        expect(contrast(neutral[500], neutral[50]), `${key} light secondary on root`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(neutral[500], glowCentre), `${key} light secondary at the glow`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(neutral[500], glow2Centre), `${key} light secondary at the second glow`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(neutral[500], card.light), `${key} light secondary on card`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(accent[700], neutral[50]), `${key} light accent text on root`).toBeGreaterThanOrEqual(4.5)
        expect(contrast('255 255 255', accent[700]), `${key} light white on accent fill`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(neutral[400], neutral[50]), `${key} light tertiary on root`).toBeGreaterThanOrEqual(2.3)
      }
    }
  })

  it('the five built-in themes differ in colour, not only in name', () => {
    const grounds = Object.values(themePresets).filter(p => p.group === 'nova').map(p => neutralPalettes[p.neutral][950])
    expect(new Set(grounds).size).toBe(5)
    const accents = Object.values(themePresets).filter(p => p.group === 'nova').map(p => accentPalettes[p.accent][500])
    // Daylight deliberately shares Nova's teal; the other four are their own hue
    expect(new Set(accents).size).toBe(4)
  })

  it('resolvePalette: unknown → Nova, no secondary → the accent tints everything', () => {
    expect(resolvePalette('hologram')).toEqual(resolvePalette(DEFAULT_PRESET))
    expect(resolvePalette('constructor')).toEqual(resolvePalette(DEFAULT_PRESET))
    expect(resolvePalette('slate').secondary).toBe(accentPalettes.blue)
    expect(resolvePalette('custom', 'rose').accent).toBe(accentPalettes.rose)
  })
})

describe('index.css names no hue', () => {
  // DESIGN.md amendment 3. A colour literal here means one theme (the one it
  // was typed for) and silently the wrong one for every other — the 2026-09
  // defect was exactly a hard-coded teal atmosphere. Black, white and greys
  // (shadows, glass highlights) are the only literals allowed.
  it('every rgb()/rgba()/hex literal outside the :root defaults is achromatic', () => {
    const css = readFileSync('src/index.css', 'utf8')
    expect(css.length).toBeGreaterThan(1000)
    const body = css.replace(/:root\s*\{[^}]*\}/, '')   // the seed block is the defaults, by design
    const offenders: string[] = []
    for (const m of body.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      if (!(m[1] === m[2] && m[2] === m[3])) offenders.push(m[0])
    }
    for (const m of body.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16))
      if (!(r === g && g === b)) offenders.push(m[0])
    }
    expect(offenders).toEqual([])
  })
})
