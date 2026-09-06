import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ThemeProvider, useTheme, STORAGE_KEY } from './theme-store'
import { DEFAULT_PRESET, neutralPalettes, accentPalettes } from '../lib/color-palettes'

function Probe() {
  const t = useTheme()
  return (
    <div>
      <span data-testid="preset">{t.preset}</span>
      <span data-testid="mode">{t.mode}</span>
      <span data-testid="pref">{t.modePreference}</span>
      <span data-testid="chosen">{String(t.presetChosen)}</span>
      <button onClick={() => t.setPreset('daylight')}>daylight</button>
      <button onClick={() => t.setPreset('nebula')}>nebula</button>
      <button onClick={() => t.setPreset('no-such-theme')}>bogus</button>
      <button onClick={() => t.setPreset('constructor')}>proto</button>
      <button onClick={() => t.adoptInstanceDefault('ember')}>adopt-ember</button>
      <button onClick={() => t.adoptInstanceDefault('ocean')}>adopt-ocean</button>
      <button onClick={() => t.adoptInstanceDefault('hologram')}>adopt-bogus</button>
      <button onClick={() => t.setCustomAccent('rose')}>custom-rose</button>
      <button onClick={() => t.setModePreference('light')}>mode-light</button>
      <button onClick={() => t.setModePreference('dark')}>mode-dark</button>
      <button onClick={() => t.setModePreference('system')}>mode-system</button>
    </div>
  )
}

const vars = () => document.getElementById('nova-theme-vars')!.textContent ?? ''
const themeColor = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')
const text = (id: string) => screen.getByTestId(id).textContent
const click = (label: string) => act(() => screen.getByText(label).click())
const saved = () => JSON.parse(localStorage.getItem(STORAGE_KEY)!)

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.backgroundColor = ''
    document.getElementById('nova-theme-vars')?.remove()
    document.querySelector('meta[name="theme-color"]')?.remove()
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
  })

  it('starts on Nova: the custom teal accent on the WARM stone neutrals, dark', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('preset')).toBe(DEFAULT_PRESET)
    expect(text('chosen')).toBe('false')
    expect(vars()).toContain('--accent-500:25 168 158')
    // the neutral family that used to sit under "stone" was a cool grey
    expect(vars()).toContain(`--neutral-900:${neutralPalettes.stone[900]}`)
    expect(vars()).toContain('--neutral-900:28 25 23')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    // the ground index.html painted before React is repainted in the palette
    // jsdom serialises with commas; the value is the triplet either way
    expect(document.documentElement.style.backgroundColor.replace(/,\s*/g, ' ')).toBe(`rgb(${neutralPalettes.stone[950]})`)
  })

  it('derives the atmosphere from the palette: accent deep end + the secondary family', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(vars()).toContain(`--glow-1:${accentPalettes.teal[950]}`)
    expect(vars()).toContain(`--glow-2:${accentPalettes.amber[950]}`)
    expect(vars()).toContain(`--glow-1-light:${accentPalettes.teal[100]}`)
    click('nebula')
    expect(vars()).toContain(`--glow-1:${accentPalettes.violet[950]}`)
    expect(vars()).toContain(`--glow-2:${accentPalettes.rose[950]}`)
    expect(vars()).toContain(`--neutral-950:${neutralPalettes.nebula[950]}`)
    expect(vars()).toContain('--card:26 20 49')
  })

  it('a theme that IS light brings light mode with it, tells the browser chrome, and holds the mode', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(themeColor()).toBe(`rgb(${neutralPalettes.stone[950]})`)
    click('daylight')
    expect(text('preset')).toBe('daylight')
    expect(text('mode')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(themeColor()).toBe(`rgb(${neutralPalettes.daylight[50]})`)
    expect(text('chosen')).toBe('true')
    // the mode is the theme's, not a preference — a dark request is refused
    click('mode-dark')
    expect(text('mode')).toBe('light')
    click('mode-system')
    expect(text('pref')).toBe('light')
    // a two-mode theme hands the control back
    click('nebula')
    click('mode-dark')
    expect(text('mode')).toBe('dark')
  })

  it('refuses a theme it does not have, including inherited object keys', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    click('bogus')
    click('proto')
    expect(text('preset')).toBe(DEFAULT_PRESET)
    expect(text('chosen')).toBe('false')
    click('adopt-bogus')
    expect(text('preset')).toBe(DEFAULT_PRESET)
  })

  it('adopts the instance default only until this browser chooses', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    click('adopt-ember')
    expect(text('preset')).toBe('ember')
    expect(text('chosen')).toBe('false')
    click('nebula')
    expect(text('chosen')).toBe('true')
    expect(saved().presetChosen).toBe(true)
    click('adopt-ember')
    expect(text('preset')).toBe('nebula')
  })

  it('adopts a retired server key as what replaced it — the same reading Settings gives it', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    click('adopt-ocean')
    expect(text('preset')).toBe('slate')
    expect(text('chosen')).toBe('false')
  })

  it('an instance default that IS dark brings dark mode, even to a browser that chose light', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modePreference: 'light', preset: 'nova', presetChosen: false }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('mode')).toBe('light')
    click('adopt-ember')
    expect(text('preset')).toBe('ember')
    expect(text('mode')).toBe('dark')
  })

  it('a chosen theme survives a reload and keeps the instance default out', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modePreference: 'dark', preset: 'nebula', presetChosen: true }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('preset')).toBe('nebula')
    expect(text('chosen')).toBe('true')
    click('adopt-ember')
    expect(text('preset')).toBe('nebula')
  })

  it('a stored single-mode theme cannot come back in the wrong mode', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modePreference: 'dark', preset: 'daylight', presetChosen: true }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('mode')).toBe('light')
    expect(text('pref')).toBe('light')
  })

  it('picking a custom accent switches to the Custom theme and paints with it', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    click('custom-rose')
    expect(text('preset')).toBe('custom')
    expect(text('chosen')).toBe('true')
    expect(vars()).toContain(`--accent-500:${accentPalettes.rose[500]}`)
  })

  it('migrates the pre-redesign per-mode shape, keeping what was on screen (dark)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      modePreference: 'dark', lightPreset: 'ctp-latte', darkPreset: 'ocean',
      customLightAccent: 'teal', customDarkAccent: 'blue', fontScale: 1.15, timezone: 'Europe/Oslo',
    }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('preset')).toBe('slate')  // ocean → slate
    expect(text('chosen')).toBe('true')
    expect(vars()).toContain('--font-scale:1.15')
    expect(saved().preset).toBe('slate')
    expect(saved().presetChosen).toBe(true)
    expect(saved().customAccent).toBe('blue')
    expect(saved().timezone).toBe('Europe/Oslo')
    expect('darkPreset' in saved()).toBe(false)
  })

  it('migrates the pre-redesign shape, keeping what was on screen (light)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      modePreference: 'light', lightPreset: 'custom', darkPreset: 'dracula',
      customLightAccent: 'rose', customDarkAccent: 'blue',
    }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('preset')).toBe('custom')
    expect(text('mode')).toBe('light')
    expect(saved().customAccent).toBe('rose')
    expect(vars()).toContain(`--accent-500:${accentPalettes.rose[500]}`)
  })

  it('an old browser still on "default" has not chosen, so the instance default may apply', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modePreference: 'dark', lightPreset: 'default', darkPreset: 'default' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('preset')).toBe(DEFAULT_PRESET)
    expect(text('chosen')).toBe('false')
    click('adopt-ember')
    expect(text('preset')).toBe('ember')
  })

  it('a stored theme that no longer exists lands on Nova, not on nothing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modePreference: 'dark', preset: 'hologram', presetChosen: true }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(text('preset')).toBe(DEFAULT_PRESET)
    expect(text('chosen')).toBe('false')
    expect(vars()).toContain('--accent-500:25 168 158')
  })
})
