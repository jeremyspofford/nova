import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ThemeProvider } from './theme-store'

describe('ThemeProvider', () => {
  it('injects the Nova teal accent (not stock Tailwind teal) into #nova-theme-vars by default', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    )
    const styleEl = document.getElementById('nova-theme-vars')
    expect(styleEl).not.toBeNull()
    expect(styleEl!.textContent).toContain('--accent-500:25 168 158')
  })
})
