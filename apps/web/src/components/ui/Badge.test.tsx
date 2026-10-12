import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from './Badge'

describe('Badge', () => {
  it('passes a title and data attributes through', () => {
    render(<Badge title="stated by the provider" data-basis="declared">tools</Badge>)
    const b = screen.getByText('tools')
    expect(b.getAttribute('title')).toBe('stated by the provider')
    expect(b.getAttribute('data-basis')).toBe('declared')
  })

  it('has a dashed look for an inferred fact and a struck look for a "no"', () => {
    render(
      <>
        <Badge color="warning" look="dashed">tools?</Badge>
        <Badge look="struck">vision</Badge>
      </>,
    )
    const dashed = screen.getByText('tools?').className
    expect(dashed).toContain('border-dashed')
    expect(dashed).toContain('border-warning')
    expect(dashed).not.toContain('bg-warning-dim')
    const struck = screen.getByText('vision').className
    expect(struck).toContain('line-through')
    expect(struck).not.toContain('bg-neutral-200')
  })
})
