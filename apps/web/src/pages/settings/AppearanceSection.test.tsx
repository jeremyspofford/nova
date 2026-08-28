import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '../../stores/theme-store'
import { AppearanceSection } from './AppearanceSection'

function renderSection(storedPreset = 'default') {
  return render(
    <ThemeProvider>
      <AppearanceSection storedPreset={storedPreset} onStored={vi.fn()} />
    </ThemeProvider>,
  )
}

const lightGrid = () =>
  within(screen.getByRole('group', { name: 'Light theme presets' }))

describe('AppearanceSection — saving a default preset', () => {
  it('offers Save only once the browser differs from the stored default', () => {
    renderSection('default')
    fireEvent.click(screen.getByText('Light'))
    expect(screen.queryByText('Save as default')).toBeNull()
    fireEvent.click(lightGrid().getByText('Ocean'))
    expect(screen.getByText('Save as default')).toBeDefined()
  })

  // Dirty tracks the preset actually on screen, so editing the grid for the
  // mode you are not in is not a pending change to the instance default.
  it('stays clean when the other mode’s grid is edited', () => {
    renderSection('default')
    fireEvent.click(screen.getByText('Dark'))
    fireEvent.click(lightGrid().getByText('Ocean'))
    expect(screen.queryByText('Save as default')).toBeNull()
  })

  // The bug this covers: `dirty` is computed from the RESOLVED mode while
  // Reset branched on the PREFERENCE. Under 'system' with a light OS the two
  // disagree, so Reset wrote the dark preset, the visible preset never moved,
  // and the button silently did nothing forever.
  it('resets the preset that is actually on screen under system mode', () => {
    renderSection('default')
    fireEvent.click(screen.getByText('System'))

    fireEvent.click(lightGrid().getByText('Ocean'))
    expect(screen.getByText('Reset')).toBeDefined()

    fireEvent.click(screen.getByText('Reset'))
    expect(screen.queryByText('Reset')).toBeNull()
  })

  it('resets the preset that is on screen under an explicit dark preference', () => {
    renderSection('default')
    fireEvent.click(screen.getByText('Dark'))

    const darkGrid = within(screen.getByRole('group', { name: 'Dark theme presets' }))
    fireEvent.click(darkGrid.getByText('Ocean'))
    expect(screen.getByText('Reset')).toBeDefined()

    fireEvent.click(screen.getByText('Reset'))
    expect(screen.queryByText('Reset')).toBeNull()
  })
})
