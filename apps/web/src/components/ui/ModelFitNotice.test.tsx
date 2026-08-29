import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ModelFitNotice } from './ModelFitNotice'
import type { ModelFit } from '../../lib/api'

function fit(overrides: Partial<ModelFit> = {}): ModelFit {
  return {
    verdict: 'comfortable',
    needed_gb: 10,
    free_gb: 20,
    total_gb: 24,
    source: 'estimated',
    reason: null,
    ...overrides,
  }
}

describe('ModelFitNotice', () => {
  it('renders "fit unknown" when there is no fit object at all', () => {
    render(<ModelFitNotice fit={null} />)
    expect(screen.getByText('fit unknown')).toBeDefined()
  })

  it('renders a comfortable verdict plainly, with its source badge', () => {
    render(<ModelFitNotice fit={fit({ verdict: 'comfortable', source: 'estimated' })} />)
    expect(screen.getByText('comfortable')).toBeDefined()
    expect(screen.getByText('estimated')).toBeDefined()
  })

  it('renders a tight fit with the needed/total numbers and a caution role', () => {
    render(<ModelFitNotice fit={fit({ verdict: 'tight', needed_gb: 22, total_gb: 24 })} />)
    expect(screen.getByText('tight fit — ~22/24 GB')).toBeDefined()
  })

  it('shows a won\'t-fit verdict as an explicit warning, not just a label', () => {
    render(<ModelFitNotice fit={fit({ verdict: 'wont_fit', needed_gb: 30, total_gb: 24 })} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain("won't fit on this GPU")
  })

  it('shows "verified on your hardware" distinctly from "estimated"', () => {
    render(<ModelFitNotice fit={fit({ source: 'verified' })} />)
    expect(screen.getByText('verified on your hardware')).toBeDefined()
  })

  it('states the reason for an unknown verdict, when one is given, as a tooltip title', () => {
    render(
      <ModelFitNotice
        fit={fit({ verdict: 'unknown', needed_gb: null, free_gb: null, total_gb: null, reason: 'no GPU detected' })}
      />,
    )
    const badge = screen.getByText('fit unknown')
    expect(badge.closest('[title]')?.getAttribute('title')).toBe('no GPU detected')
  })
})
