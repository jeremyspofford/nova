import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  accentPalettes, themePresets, resolvePalette, normalizePreset, DEFAULT_PRESET,
  type ColorScale,
} from '../lib/color-palettes'

type Mode = 'light' | 'dark'
type ModePreference = 'light' | 'dark' | 'system'

interface ThemeState {
  modePreference: ModePreference
  /** One theme for both modes. A theme is a whole palette — accent, neutral
   *  family, atmosphere — and the mode says which end of it is on screen. */
  preset: string
  /** True once somebody in THIS browser picked a theme. Until then the
   *  instance default (`appearance.default_preset`) is free to apply. */
  presetChosen: boolean
  customAccent: string
  fontScale: number
  timezone: string                        // IANA timezone (e.g. "America/New_York")
}

interface ThemeStore {
  mode: Mode                              // resolved (never 'system')
  modePreference: ModePreference
  setModePreference: (p: ModePreference) => void
  preset: string
  setPreset: (name: string) => void
  presetChosen: boolean
  /** The server's answer to "what does a browser that has never chosen start
   *  on". Applies only while this browser has not chosen for itself. */
  adoptInstanceDefault: (name: string) => void
  customAccent: string
  setCustomAccent: (name: string) => void
  fontScale: number
  setFontScale: (scale: number) => void
  timezone: string
  setTimezone: (tz: string) => void
}

export const STORAGE_KEY = 'nova-appearance'

function getSystemMode(): Mode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getBrowserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
}

function resolveMode(pref: ModePreference): Mode {
  return pref === 'system' ? getSystemMode() : pref
}

function defaultState(): ThemeState {
  return {
    modePreference: 'dark',
    preset: DEFAULT_PRESET,
    presetChosen: false,
    customAccent: 'teal',
    fontScale: 1,
    timezone: getBrowserTimezone(),
  }
}

const knownPreset = normalizePreset

function loadState(): ThemeState {
  const base = defaultState()
  let raw: string | null = null
  try { raw = localStorage.getItem(STORAGE_KEY) } catch { /* no storage: defaults */ }
  if (!raw) return base
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(raw) } catch { return base }
  if (!parsed || typeof parsed !== 'object') return base

  const modePreference: ModePreference =
    parsed.modePreference === 'light' || parsed.modePreference === 'system' ? parsed.modePreference : 'dark'

  let preset = DEFAULT_PRESET
  let presetChosen = false
  if ('preset' in parsed) {
    preset = knownPreset(parsed.preset) ?? DEFAULT_PRESET
    presetChosen = parsed.presetChosen === true && knownPreset(parsed.preset) !== null
  } else if ('darkPreset' in parsed || 'lightPreset' in parsed) {
    // The pre-redesign shape kept one preset per mode. Keep the one that was
    // on screen; a browser still on the old 'default' had not chosen, so the
    // instance default may still apply to it.
    const legacyKey = resolveMode(modePreference) === 'dark' ? parsed.darkPreset : parsed.lightPreset
    preset = knownPreset(legacyKey) ?? DEFAULT_PRESET
    presetChosen = typeof legacyKey === 'string' && legacyKey !== 'default' && knownPreset(legacyKey) !== null
  }

  const legacyAccent = resolveMode(modePreference) === 'dark' ? parsed.customDarkAccent : parsed.customLightAccent
  const customAccentRaw = typeof parsed.customAccent === 'string' ? parsed.customAccent : legacyAccent
  const customAccent = typeof customAccentRaw === 'string' && accentPalettes[customAccentRaw] ? customAccentRaw : 'teal'

  // A theme that IS light or dark owns the mode; stored state cannot disagree.
  const forcedMode = themePresets[preset]?.preferredMode
  return {
    modePreference: forcedMode ?? modePreference,
    preset,
    presetChosen,
    customAccent,
    fontScale: typeof parsed.fontScale === 'number' ? parsed.fontScale : 1,
    timezone: typeof parsed.timezone === 'string' && parsed.timezone ? parsed.timezone : getBrowserTimezone(),
  }
}

const scaleVars = (prefix: string, scale: ColorScale) =>
  Object.entries(scale).map(([s, v]) => `--${prefix}-${s}:${v}`)

const triplet = (t: string) => t.split(' ').map(Number) as [number, number, number]
const luminance = ([r, g, b]: [number, number, number]) => {
  const ch = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
/** WCAG contrast ratio between two "r g b" triplets. */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(triplet(a)), luminance(triplet(b))].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
/** `top` at `alpha` over `under` — how tailwind's dim tints paint. */
export function blendOver(top: string, under: string, alpha: number): string {
  const t = triplet(top), u = triplet(under)
  return t.map((v, i) => Math.round(v * alpha + u[i] * (1 - alpha))).join(' ')
}
/** The tint alphas tailwind.config.js paints with (accent.dim, *.dim) —
 *  color-palettes.test.ts checks the config still says the same. */
export const TINT_ALPHA = { accentDim: 0.08, statusDim: 0.12 } as const
/** Status hues — fixed, but the step follows the mode: the 400s read on a
 *  dark ground, the 700-800s on a light one. */
export const STATUS_BASE = {
  dark: { success: '52 211 153', warning: '251 191 36', danger: '248 113 113', info: '96 165 250' },
  light: { success: '6 95 70', warning: '146 64 14', danger: '185 28 28', info: '29 78 216' },
} as const
export type StatusKey = keyof typeof STATUS_BASE.dark

/**
 * A text colour that reads on every ground it will sit on: `base` if it
 * already does, otherwise `base` moved toward white (on a dark ground) or
 * black (on a light one) in small steps until it clears `min` everywhere.
 * The built-in palettes never need the move — color-palettes.test.ts pins
 * that — so this exists for community and custom palettes, whose greys are
 * whatever their sources chose (Catppuccin Latte's secondary is 4.4:1).
 */
export function legibleTier(base: string, grounds: string[], towards: 'light' | 'dark', min = 4.5): string {
  let c = triplet(base)
  for (let i = 0; i < 60; i++) {
    const cur = c.join(' ')
    if (grounds.every(g => contrastRatio(cur, g) >= min)) return cur
    c = c.map(v => Math.round(towards === 'light' ? v + (255 - v) * 0.06 : v * 0.94)) as [number, number, number]
  }
  return c.join(' ')
}

/** The CSS custom properties one (preset, mode) paints with. Everything in
 *  index.css that used to name a colour reads one of these instead, so a
 *  theme changes the whole page — atmosphere, glass and scrollbars included
 *  — and not only the elements that happen to say `accent`. */
export function themeVariables(mode: Mode, preset: string, customAccent: string, fontScale: number): string {
  const { accent, neutral, secondary, card } = resolvePalette(preset, customAccent)
  // dark-mode tertiary text: a step between 400 and 500 (weighted toward
  // 400), derived so every family gets one — 500 was 3.5:1 on a card, the
  // midpoint 4.4:1 on an input; 400 is the secondary tier
  const mid = (x: string, y: string) => x.split(' ').map((v, i) => Math.round(Number(v) * 0.7 + Number(y.split(' ')[i]) * 0.3)).join(' ')
  // light-mode tertiary text: the midpoint of 500 and 600 (500 is 4.4:1 on an input)
  const half = (x: string, y: string) => x.split(' ').map((v, i) => Math.round((Number(v) + Number(y.split(' ')[i])) / 2)).join(' ')
  // the text tiers, proven against the ground, the card and an input in the
  // mode about to paint (index.css reads --tier-*; the raw steps are the
  // fallback the stylesheet carries)
  const dark = mode === 'dark'
  const grounds = dark ? [neutral[950], card.dark, neutral[800]] : [neutral[50], card.light, neutral[100]]
  const towards = dark ? 'light' : 'dark'
  const secondaryTier = legibleTier(dark ? neutral[400] : neutral[600], grounds, towards)
  const tertiaryTier = legibleTier(dark ? mid(neutral[400], neutral[500]) : half(neutral[500], neutral[600]), grounds, towards)
  // accent as text, also on its own dim tint (active nav, accent badges)
  const cardBg = dark ? card.dark : card.light
  const accentTier = legibleTier(dark ? accent[400] : accent[700],
    [...grounds, ...grounds.map(g => blendOver(accent[500], g, TINT_ALPHA.accentDim))], towards)
  // status text, also on its own dim tint (badges) over every ground — the
  // tint is always the 400 hue
  const statusTiers = (Object.keys(STATUS_BASE.dark) as StatusKey[]).map(k =>
    `--tier-${k}:${legibleTier(STATUS_BASE[mode][k],
      [...grounds, ...grounds.map(g => blendOver(STATUS_BASE.dark[k], g, TINT_ALPHA.statusDim))], towards)}`)
  return [
    ...scaleVars('accent', accent),
    ...scaleVars('neutral', neutral),
    `--neutral-450:${mid(neutral[400], neutral[500])}`,
    `--neutral-550:${half(neutral[500], neutral[600])}`,
    `--tier-secondary:${secondaryTier}`,
    `--tier-tertiary:${tertiaryTier}`,
    `--tier-accent:${accentTier}`,
    ...statusTiers,
    `--card:${mode === 'dark' ? card.dark : card.light}`,
    // atmosphere: the two families' deep ends tint the dark ground, their
    // palest step tints the light one (the 200 step darkened paper enough to
    // take stone's secondary grey under 4.5:1 — color-palettes.test pins it)
    `--glow-1:${accent[950]}`,
    `--glow-2:${secondary[950]}`,
    `--glow-1-light:${accent[100]}`,
    `--glow-2-light:${secondary[100]}`,
    `--font-scale:${fontScale}`,
  ].join(';')
}

/** What the browser chrome (status bar, tab strip) is told the page is. */
export function themeColor(mode: Mode, preset: string, customAccent: string): string {
  const { neutral } = resolvePalette(preset, customAccent)
  return `rgb(${mode === 'dark' ? neutral[950] : neutral[50]})`
}

/**
 * Inject all CSS custom properties via a dedicated <style> element.
 * This is more robust than inline styles because it always wins
 * over the :root defaults in index.css by source order (appended last).
 */
function applyTheme(mode: Mode, state: ThemeState) {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  // form controls, scrollbars and the caret follow the mode, not the OS
  root.style.colorScheme = mode
  // index.html painted the first frame's ground inline; repaint it in the
  // real palette or the canvas behind the body keeps the load-time colour
  root.style.backgroundColor = themeColor(mode, state.preset, state.customAccent)

  let el = document.getElementById('nova-theme-vars') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'nova-theme-vars'
  }
  el.textContent = `:root{${themeVariables(mode, state.preset, state.customAccent, state.fontScale)}}`
  document.head.appendChild(el)

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', themeColor(mode, state.preset, state.customAccent))
}

const ThemeContext = createContext<ThemeStore | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>(loadState)
  const [resolvedMode, setResolvedMode] = useState<Mode>(() => resolveMode(state.modePreference))

  // Listen for OS color scheme changes when in system mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (state.modePreference === 'system') {
        setResolvedMode(getSystemMode())
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [state.modePreference])

  // Re-resolve mode when preference changes
  useEffect(() => {
    setResolvedMode(resolveMode(state.modePreference))
  }, [state.modePreference])

  // Apply theme on mount and whenever state/resolved mode changes
  useEffect(() => {
    applyTheme(resolvedMode, state)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* private mode */ }
  }, [state, resolvedMode])

  // A theme that IS light or dark keeps its mode — the control is disabled
  // in the picker, and this is the line that holds when it is not.
  const setModePreference = useCallback((p: ModePreference) => {
    setState(s => (themePresets[s.preset]?.preferredMode ? s : { ...s, modePreference: p }))
  }, [])

  // A theme that IS light or IS dark brings its mode with it — choosing
  // "Daylight" and getting a dark page would be the picker lying.
  const withPreset = (s: ThemeState, name: string, chosen: boolean): ThemeState => {
    const preferred = themePresets[name]?.preferredMode
    return {
      ...s,
      preset: name,
      presetChosen: chosen || s.presetChosen,
      modePreference: preferred ?? s.modePreference,
    }
  }

  const setPreset = useCallback((name: string) => {
    const key = normalizePreset(name)
    if (!key) return
    setState(s => withPreset(s, key, true))
  }, [])

  // The server may still hold a key from before the redesign ('default',
  // 'ocean'); it means what replaced it, the same as in loadState.
  const adoptInstanceDefault = useCallback((name: string) => {
    const key = normalizePreset(name)
    if (!key) return
    setState(s => (s.presetChosen || s.preset === key ? s : withPreset(s, key, false)))
  }, [])

  const setCustomAccent = useCallback((name: string) => {
    if (!accentPalettes[name]) return
    setState(s => ({ ...withPreset(s, 'custom', true), customAccent: name }))
  }, [])

  const setFontScale = useCallback((scale: number) => {
    setState(s => ({ ...s, fontScale: scale }))
  }, [])

  const setTimezone = useCallback((tz: string) => {
    setState(s => ({ ...s, timezone: tz }))
  }, [])

  return (
    <ThemeContext.Provider value={{
      mode: resolvedMode,
      modePreference: state.modePreference,
      setModePreference,
      preset: state.preset,
      setPreset,
      presetChosen: state.presetChosen,
      adoptInstanceDefault,
      customAccent: state.customAccent,
      setCustomAccent,
      fontScale: state.fontScale,
      setFontScale,
      timezone: state.timezone,
      setTimezone,
    }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeStore {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
