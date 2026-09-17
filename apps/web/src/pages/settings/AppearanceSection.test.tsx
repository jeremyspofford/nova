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

describe('the icon pickers', () => {
  /** Jeremy asked for the v3 swirl to stay available as a choice rather
   *  than as the default — "keep it in the theme area so we can select an
   *  icon in the future to use". */
  it('offers every icon and marks the active one', async () => {
    renderSection()

    const mark = await screen.findByTestId('app-icon-mark')
    const cosmic = await screen.findByTestId('app-icon-cosmic')
    expect(mark.getAttribute('aria-pressed')).toBe('true')
    expect(cosmic.getAttribute('aria-pressed')).toBe('false')
  })

  it('picking one moves the tab icon', async () => {
    renderSection()

    fireEvent.click(await screen.findByTestId('app-icon-cosmic'))

    expect(screen.getByTestId('app-icon-cosmic').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      '/icons/cosmic-192.png',
    )
  })

  it('says what a phone will do with the choice, and when', async () => {
    // 2026-09-17: the hint promised "a phone's home screen" while the code
    // moved only the tab. An installed iOS app keeps the icon it was added
    // with; the choice reaches the phone on the next add, and the hint has
    // to say so or the setting looks broken.
    renderSection()
    await screen.findByTestId('app-icon-mark')
    expect(screen.getByText(/keeps the icon it was added with/)).toBeDefined()
    expect(screen.queryByText(/and on a phone's home screen\./)).toBeNull()
  })

  it('picking one moves the home-screen icon as well as the tab', async () => {
    renderSection()
    fireEvent.click(await screen.findByTestId('app-icon-cosmic'))
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe(
      '/icons/touch/cosmic.png',
    )
  })

  it('each option previews itself, so the choice is visible before it is made', async () => {
    renderSection()

    const preview = (await screen.findByTestId('app-icon-mark')).querySelector('img')
    expect(decodeURIComponent(preview?.getAttribute('src') ?? '')).toContain('<svg')
  })
})

describe('the sidebar mark is its own choice', () => {
  /** Asked for 2026-09-14: the tab and the sidebar are different jobs — a
   *  16px silhouette in a crowded tab strip versus a 28px mark beside a
   *  wordmark — so picking one must not move the other. */
  it('picking a sidebar mark leaves the tab icon alone', async () => {
    renderSection()

    fireEvent.click(await screen.findByTestId('brand-icon-orb'))

    expect(screen.getByTestId('brand-icon-orb').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('app-icon-mark').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('app-icon-orb').getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toContain(
      'data:image/svg',
    )
  })

  it('and picking a tab icon leaves the sidebar alone', async () => {
    renderSection()

    fireEvent.click(await screen.findByTestId('app-icon-cosmic'))

    expect(screen.getByTestId('brand-icon-mark').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      '/icons/cosmic-192.png',
    )
  })

  it('offers every icon to both', async () => {
    renderSection()

    for (const key of ['mark', 'orb', 'orb-amber', 'cosmic']) {
      expect(await screen.findByTestId(`app-icon-${key}`)).toBeTruthy()
      expect(await screen.findByTestId(`brand-icon-${key}`)).toBeTruthy()
    }
  })
})

/**
 * The interface font, chosen here (2026-09-15).
 *
 * The value ends up inside a `<style>` element's text, which is why the
 * custom family is scrubbed; `src/lib/fonts.test.ts` drives that rule
 * directly. What these add is that the CONTROL is wired to it — a picker
 * that renders but publishes nothing looks identical to a working one until
 * somebody tries to read the page.
 */
describe('AppearanceSection — the interface font', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  const fontGroup = () => within(screen.getByRole('group', { name: 'Interface font' }))

  it('offers every font and marks the active one', () => {
    renderSection()
    for (const key of ['jakarta', 'inter', 'figtree', 'source-serif', 'system', 'custom']) {
      expect(screen.getByTestId(`font-${key}`), key).toBeTruthy()
    }
    expect(screen.getByTestId('font-jakarta').getAttribute('aria-pressed')).toBe('true')
  })

  it('picking one publishes it, so the page is actually set in it', () => {
    renderSection()
    fireEvent.click(screen.getByTestId('font-inter'))

    expect(screen.getByTestId('font-inter').getAttribute('aria-pressed')).toBe('true')
    expect(vars()).toContain('--font-sans:"Inter Variable"')
  })

  it('each card is set in the face it offers', () => {
    // A font picker whose options are all drawn in the current font is a
    // list of names, not a choice.
    renderSection()
    const inter = screen.getByTestId('font-inter')
    expect(within(inter).getByText('Inter').getAttribute('style')).toContain('Inter Variable')
  })

  it('asks for a family name only when there is one to ask for', () => {
    renderSection()
    expect(screen.queryByTestId('custom-font-input')).toBeNull()

    fireEvent.click(screen.getByTestId('font-custom'))
    expect(screen.getByTestId('custom-font-input')).toBeTruthy()
  })

  it('an installed family is published, quoted, with a fallback behind it', () => {
    renderSection()
    fireEvent.click(screen.getByTestId('font-custom'))
    fireEvent.change(screen.getByTestId('custom-font-input'), { target: { value: 'Styrene A' } })

    expect(vars()).toContain('--font-sans:"Styrene A", ')
    expect(vars()).toMatch(/--font-sans:"Styrene A", [^;]*sans-serif/)
  })

  it('a family name cannot close the rule it is written into', () => {
    // The stylesheet this lands in is built by string concatenation. Typing
    // a brace must not end the rule and start another.
    renderSection()
    fireEvent.click(screen.getByTestId('font-custom'))
    fireEvent.change(screen.getByTestId('custom-font-input'), {
      target: { value: 'X}html{opacity:0' },
    })

    const published = vars()
    expect(published).toContain('--font-sans:"Xhtmlopacity0"')
    expect(published).not.toContain('opacity:0')
  })

  it('keeps the typed family while another font is selected', () => {
    // Switching away and back must not make the operator retype it.
    renderSection()
    fireEvent.click(screen.getByTestId('font-custom'))
    fireEvent.change(screen.getByTestId('custom-font-input'), { target: { value: 'Styrene A' } })
    fireEvent.click(screen.getByTestId('font-inter'))
    fireEvent.click(screen.getByTestId('font-custom'))

    expect(screen.getByTestId('custom-font-input').getAttribute('value')).toBe('Styrene A')
  })

  it('the font group exists under a name a screen reader can find', () => {
    renderSection()
    expect(fontGroup().getByTestId('font-inter')).toBeTruthy()
  })
})
