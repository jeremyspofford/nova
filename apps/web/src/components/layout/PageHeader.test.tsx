import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from './PageHeader'

// UI review R10 (2026-10-11): the header rendered an empty actions block on
// every page without actions, and its description ran the full content
// width (1150px lines on Spend).

describe('PageHeader', () => {
  it('draws no actions block when there are no actions', () => {
    const { container } = render(<PageHeader title="Spend" description="What it cost." />)
    expect(container.querySelector('[data-testid="page-actions"]')).toBeNull()
  })

  it('draws the actions block when there are actions', () => {
    render(<PageHeader title="Spend" actions={<button>Refresh</button>} />)
    expect(screen.getByTestId('page-actions').textContent).toContain('Refresh')
  })

  it('keeps the description to a readable measure', () => {
    render(<PageHeader title="Spend" description="What it cost." />)
    expect(screen.getByText('What it cost.').className).toContain('max-w-prose')
  })
})
