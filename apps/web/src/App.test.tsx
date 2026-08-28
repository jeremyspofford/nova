import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import App from './App'
import * as ui from './components/ui'

describe('App', () => {
  it('renders without crashing (default route redirects to the gallery)', () => {
    const { container } = render(<App />)
    expect(container.textContent).toContain('Component Gallery')
  })
})

describe('components/ui index', () => {
  it('exports at least 30 distinct component bindings', () => {
    const keys = Object.keys(ui)
    expect(keys.length).toBeGreaterThanOrEqual(30)
  })
})
