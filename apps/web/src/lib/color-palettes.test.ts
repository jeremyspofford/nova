import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { accentPalettes, neutralPalettes, themePresets, resolvePalette, DEFAULT_PRESET } from './color-palettes'
import { legibleTier, themeVariables, blendOver, TINT_ALPHA, STATUS_BASE, type StatusKey } from '../stores/theme-store'

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
  const css = readFileSync('src/index.css', 'utf8')
  // the alphas the light atmosphere actually paints with — read from the
  // stylesheet, so nobody can raise them without moving these numbers
  const glowAlpha = Number(css.match(/--glow-1-light\) \/ ([\d.]+)\)/)?.[1])
  const glow2Alpha = Number(css.match(/--glow-2-light\) \/ ([\d.]+)\)/)?.[1])
  // the status steps index.css assigns per mode — fixed hues, so every
  // family has to carry them
  const STATUS_KEYS = Object.keys(STATUS_BASE.dark) as StatusKey[]
  const status = (mode: 'dark' | 'light') => STATUS_KEYS.map(k => STATUS_BASE[mode][k])
  it('the stylesheet fallbacks and tailwind tints agree with the store', () => {
    for (const mode of ['dark', 'light'] as const) {
      const block = mode === 'dark' ? css.slice(css.indexOf('html.dark {')) : css.slice(css.indexOf('/* Light mode defaults */'), css.indexOf('html.dark {'))
      for (const k of STATUS_KEYS) expect(block).toContain(`--status-${k}: var(--tier-${k}, ${STATUS_BASE[mode][k]})`)
    }
    expect(dimAlpha).toBe(TINT_ALPHA.accentDim)
    for (const d of statusDim) expect(d.alpha).toBe(TINT_ALPHA.statusDim)
  })
  // the same weighting the store uses for --neutral-450
  const mid = (x: string, y: string) => x.split(' ').map((v, i) => Math.round(Number(v) * 0.7 + Number(y.split(' ')[i]) * 0.3)).join(' ')
  const half = (x: string, y: string) => x.split(' ').map((v, i) => Math.round((Number(v) + Number(y.split(' ')[i])) / 2)).join(' ')
  const WHITE = '255 255 255'
  // the tints tailwind.config.js paints badges and the active nav with — read
  // from the config so an alpha cannot move without moving these numbers
  const tw = readFileSync('tailwind.config.js', 'utf8')
  const dimAlpha = Number(tw.match(/dim: 'rgb\(var\(--accent-500\) \/ ([\d.]+)\)'/)?.[1])
  const statusDim = ['success', 'warning', 'danger', 'info'].map(k => {
    const m = tw.match(new RegExp(`${k}: \\{[^}]*dim: 'rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\)'`))!
    return { hue: `${m[1]} ${m[2]} ${m[3]}`, alpha: Number(m[4]) }
  })

  it.each(house)('%s: every text tier, accent text and status text clear WCAG AA where they sit', (key, p) => {
    const { accent, neutral, secondary, card } = resolvePalette(key)
    const modes: ('dark' | 'light')[] = p.preferredMode ? [p.preferredMode] : ['dark', 'light']
    for (const mode of modes) {
      const dark = mode === 'dark'
      // index.css: the grounds text sits on
      const root = dark ? neutral[950] : neutral[50]
      const cardBg = dark ? card.dark : card.light
      const elevated = dark ? neutral[800] : neutral[100]
      const grounds: [string, string][] = [['root', root], ['card', cardBg], ['elevated', elevated]]
      if (!dark) {
        expect(glowAlpha).toBeGreaterThan(0)
        expect(glow2Alpha).toBeGreaterThan(0)
        grounds.push(['glow', blend(accent[100], neutral[50], glowAlpha)], ['glow2', blend(secondary[100], neutral[50], glow2Alpha)])
      }
      // index.css text tiers
      const secondaryText = dark ? neutral[400] : neutral[600]
      const tertiaryText = dark ? mid(neutral[400], neutral[500]) : half(neutral[500], neutral[600])
      const accentText = dark ? accent[400] : accent[700]
      const onAccent = dark ? neutral[950] : WHITE
      for (const [name, g] of grounds) {
        expect(contrast(secondaryText, g), `${key} ${mode} secondary on ${name}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(tertiaryText, g), `${key} ${mode} tertiary on ${name}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(accentText, g), `${key} ${mode} accent text on ${name}`).toBeGreaterThanOrEqual(4.5)
        for (const st of status(mode)) expect(contrast(st, g), `${key} ${mode} status ${st} on ${name}`).toBeGreaterThanOrEqual(4.5)
      }
      // active nav and accent badges: accent text on the accent-dim tint over the root and the card
      expect(dimAlpha).toBeGreaterThan(0)
      for (const [name, g] of [['root', root], ['card', cardBg]] as const) {
        expect(contrast(accentText, blend(accent[500], g, dimAlpha)), `${key} ${mode} accent text on accent-dim over ${name}`).toBeGreaterThanOrEqual(4.5)
        // status badges: the mode's status text on its fixed-hue dim tint
        status(mode).forEach((st, i) => {
          expect(contrast(st, blend(statusDim[i].hue, g, statusDim[i].alpha)), `${key} ${mode} status ${st} on its dim tint over ${name}`).toBeGreaterThanOrEqual(4.5)
        })
      }
      // the store's tier derivation is a no-op here: built-in greys are
      // legible by design, not by correction
      const inputs = dark ? [neutral[950], cardBg, neutral[800]] : [neutral[50], cardBg, neutral[100]]
      expect(legibleTier(secondaryText, inputs, dark ? 'light' : 'dark'), `${key} ${mode} secondary needs no nudge`).toBe(secondaryText)
      expect(legibleTier(tertiaryText, inputs, dark ? 'light' : 'dark'), `${key} ${mode} tertiary needs no nudge`).toBe(tertiaryText)
      const accentInputs = [...inputs, ...inputs.map(g => blendOver(accent[500], g, TINT_ALPHA.accentDim))]
      expect(legibleTier(accentText, accentInputs, dark ? 'light' : 'dark'), `${key} ${mode} accent text needs no nudge`).toBe(accentText)
      STATUS_KEYS.forEach(k => {
        const stInputs = [...inputs, ...inputs.map(g => blendOver(STATUS_BASE.dark[k], g, TINT_ALPHA.statusDim))]
        expect(legibleTier(STATUS_BASE[mode][k], stInputs, dark ? 'light' : 'dark'), `${key} ${mode} status ${k} needs no nudge`).toBe(STATUS_BASE[mode][k])
      })
      // code blocks are dark in both modes (.markdown-body pre) and their
      // comment colour is the scale's light end (highlight.css)
      const preBg = dark ? neutral[950] : neutral[900]
      const commentText = dark ? neutral[400] : neutral[300]
      expect(contrast(commentText, preBg), `${key} ${mode} code comment on the code block`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(neutral[200], preBg), `${key} ${mode} code text on the code block`).toBeGreaterThanOrEqual(4.5)
      // fills carry their own text colour
      expect(contrast(onAccent, accentText), `${key} ${mode} on-accent on the accent fill`).toBeGreaterThanOrEqual(4.5)
      for (const st of status(mode)) expect(contrast(onAccent, st), `${key} ${mode} on-accent on status fill ${st}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every OTHER theme gets text tiers that read on its own grounds, derived', () => {
    const others = Object.keys(themePresets).filter(k => themePresets[k].group !== 'nova')
    for (const key of others) {
      const modes: ('dark' | 'light')[] = themePresets[key].preferredMode ? [themePresets[key].preferredMode!] : ['dark', 'light']
      for (const mode of modes) {
        const { neutral, card } = resolvePalette(key, 'rose')
        const vars = themeVariables(mode, key, 'rose', 1)
        const tier = (name: string) => vars.match(new RegExp(`--tier-${name}:(\\d+ \\d+ \\d+)`))![1]
        const grounds = mode === 'dark' ? [neutral[950], card.dark, neutral[800]] : [neutral[50], card.light, neutral[100]]
        const { accent } = resolvePalette(key, 'rose')
        for (const g of [...grounds, ...grounds.map(x => blendOver(accent[500], x, TINT_ALPHA.accentDim))]) {
          expect(contrast(tier('accent'), g), `${key} ${mode} derived accent text`).toBeGreaterThanOrEqual(4.5)
        }
        for (const g of grounds) {
          expect(contrast(tier('secondary'), g), `${key} ${mode} derived secondary`).toBeGreaterThanOrEqual(4.5)
          expect(contrast(tier('tertiary'), g), `${key} ${mode} derived tertiary`).toBeGreaterThanOrEqual(4.5)
          for (const k of STATUS_KEYS) {
            expect(contrast(tier(k), g), `${key} ${mode} derived status ${k}`).toBeGreaterThanOrEqual(4.5)
            expect(contrast(tier(k), blendOver(STATUS_BASE.dark[k], g, TINT_ALPHA.statusDim)), `${key} ${mode} derived status ${k} on its tint`).toBeGreaterThanOrEqual(4.5)
          }
        }
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
