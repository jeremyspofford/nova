import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '../../stores/theme-store'
import { AppearanceSection } from './AppearanceSection'
import { accentPalettes } from '../../lib/color-palettes'

function renderSection(storedPreset = 'nova') {
  return render(
    <ThemeProvider>
      <AppearanceSection storedPreset={storedPreset} onStored={vi.fn()} />
    </ThemeProvider>,
  )
}

const builtIn = () => within(screen.getByRole('group', { name: 'Built in themes' }))
const card = (label: string) => builtIn().getByText(label).closest('button')!
const checked = (label: string) => card(label).getAttribute('aria-checked')
const isDark = () => document.documentElement.classList.contains('dark')
const modeButton = (label: string) =>
  within(screen.getByRole('group', { name: 'Mode' })).getByText(label).closest('button')!
const vars = () => document.getElementById('nova-theme-vars')!.textContent ?? ''

describe('AppearanceSection — one theme, one grid', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('offers Save only once the browser differs from the stored default', () => {
    renderSection('nova')
    expect(screen.queryByText('Save as default')).toBeNull()
    fireEvent.click(card('Slate'))
    expect(screen.getByText('Save as default')).toBeDefined()
    expect(checked('Slate')).toBe('true')
    expect(checked('Nova')).toBe('false')
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeDefined()
  })

  it('Reset returns to the stored default and clears the pending save', () => {
    renderSection('nova')
    fireEvent.click(card('Nebula'))
    expect(screen.getByText('Reset')).toBeDefined()
    fireEvent.click(screen.getByText('Reset'))
    expect(screen.queryByText('Reset')).toBeNull()
    expect(checked('Nova')).toBe('true')
  })

  it('marks the stored default on its card, whichever theme that is, outside the card name', () => {
    renderSection('ember')
    expect(within(card('Ember')).getByText('Default')).toBeDefined()
    expect(within(card('Nova')).queryByText('Default')).toBeNull()
    // the tag describes the card; it is not part of what the card is called
    expect(card('Ember').getAttribute('aria-describedby')).toBe('theme-ember-default')
    expect(card('Nova').getAttribute('aria-describedby')).toBeNull()
  })

  it('names the active theme and says what it is, where touch can read it', () => {
    renderSection('nova')
    expect(screen.getByTestId('theme-description').textContent).toContain('Teal on warm near-black')
    fireEvent.click(card('Nebula'))
    expect(screen.getByTestId('theme-description').textContent).toContain('Nebula')
    expect(screen.getByTestId('theme-description').textContent).toContain('Violet')
  })

  // Daylight IS a light theme and Ember IS a dark one: picking either brings
  // its mode, and the Mode control goes quiet until a two-mode theme is back.
  it('a theme designed for one mode brings that mode with it and locks the control', () => {
    renderSection('nova')
    fireEvent.click(modeButton('Light'))
    expect(isDark()).toBe(false)
    expect(modeButton('Light').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(card('Ember'))
    expect(isDark()).toBe(true)
    expect(modeButton('Light').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Ember is a dark theme/)).toBeDefined()
    fireEvent.click(modeButton('Light'))          // disabled — must not flip
    expect(isDark()).toBe(true)

    fireEvent.click(card('Daylight'))
    expect(isDark()).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')

    // Nova renders in whichever mode you are in — the control comes back
    fireEvent.click(card('Nova'))
    expect(isDark()).toBe(false)
    expect(modeButton('Dark').hasAttribute('disabled')).toBe(false)
    fireEvent.click(modeButton('Dark'))
    expect(isDark()).toBe(true)
  })

  it('shows the accent picker only while the Custom theme is active, and paints with the pick', () => {
    renderSection('nova')
    expect(screen.queryByText('Accent colour')).toBeNull()
    fireEvent.click(within(screen.getByRole('group', { name: 'Custom themes' })).getByText('Custom'))
    expect(screen.getByRole('group', { name: 'Accent colour' })).toBeDefined()
    fireEvent.click(screen.getByLabelText('Accent rose'))
    expect(screen.getByLabelText('Accent rose').getAttribute('aria-pressed')).toBe('true')
    expect(vars()).toContain(`--accent-500:${accentPalettes.rose[500]}`)
    fireEvent.click(card('Slate'))
    expect(screen.queryByText('Accent colour')).toBeNull()
  })

  it('will not save a per-browser custom accent as everyone\'s default', () => {
    renderSection('nova')
    fireEvent.click(within(screen.getByRole('group', { name: 'Custom themes' })).getByText('Custom'))
    expect(screen.queryByText('Save as default')).toBeNull()
    expect(screen.getByText(/A custom accent is this browser's alone/)).toBeDefined()
    fireEvent.click(card('Slate'))
    expect(screen.getByText('Save as default')).toBeDefined()
  })
})
