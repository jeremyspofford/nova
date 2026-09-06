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

/** The CSS custom properties one (preset, mode) paints with. Everything in
 *  index.css that used to name a colour reads one of these instead, so a
 *  theme changes the whole page — atmosphere, glass and scrollbars included
 *  — and not only the elements that happen to say `accent`. */
export function themeVariables(mode: Mode, preset: string, customAccent: string, fontScale: number): string {
  const { accent, neutral, secondary, card } = resolvePalette(preset, customAccent)
  return [
    ...scaleVars('accent', accent),
    ...scaleVars('neutral', neutral),
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
