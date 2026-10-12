import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Banner } from './Banner'

// UI review R10 leftover (2026-10-11): the same banner was pasted 33 times
// across 26 files in five slightly different versions.

const SOURCES = import.meta.glob(['/src/**/*.tsx', '!/src/**/*.test.tsx', '!/src/components/ui/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('Banner', () => {
  it('an error is an alert, in the danger tone', () => {
    render(<Banner>could not load</Banner>)
    const b = screen.getByRole('alert')
    expect(b.textContent).toBe('could not load')
    expect(b.className).toContain('bg-danger-dim')
    expect(b.className).toContain('text-danger')
  })

  it('a warning or a note is a status, not an alert', () => {
    render(<Banner tone="warning">heads up</Banner>)
    expect(screen.getByRole('status').className).toContain('bg-warning-dim')
  })

  it('keeps the page\'s own layout classes and a role it was given', () => {
    render(<Banner tone="info" size="sm" role="alert" className="mb-6 flex gap-2">x</Banner>)
    const b = screen.getByRole('alert')
    expect(b.className).toContain('mb-6')
    expect(b.className).toContain('flex')
    expect(b.className).toContain('px-3')
    expect(b.className).not.toContain('px-4')
  })
})

describe('no pasted banners', () => {
  it('no page draws a tinted, bordered banner by hand', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50)
    const pasted = Object.entries(SOURCES)
      .filter(([, src]) => /\bborder-(?:danger|warning|info)\/\d+ bg-(?:danger|warning|info)-dim\b/.test(src))
      .map(([path]) => path)
    // PullControl is a download panel that turns red on failure, not a
    // message banner: its neutral state is a bordered panel of its own.
    expect(pasted).toEqual(['/src/pages/models/PullControl.tsx'])
  })
})
