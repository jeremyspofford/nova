import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { GovernancePage } from './GovernancePage'
import type { GovernanceEvent } from '../../lib/api'

// The kinds core writes after the no-approvals ruling (services/core/app/
// governance.py): device.enrolled / device.revoked / device.audit_break. The
// page is a record of what happened, never a decision — the assertions below
// are about ordering and verbatim rendering, not about any kind's meaning.
function event(overrides: Partial<GovernanceEvent> = {}): GovernanceEvent {
  return {
    id: 'e-1',
    kind: 'device.enrolled',
    actor: 'p-1',
    subject_ref: 'd-1',
    meta: {},
    created_at: '2026-08-30T00:00:00Z',
    ...overrides,
  }
}

describe('GovernancePage', () => {
  it('shows a skeleton while loading', () => {
    const getGovernanceEvents = vi.fn(() => new Promise<GovernanceEvent[]>(() => {}))
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    expect(screen.getByTestId('governance-skeleton')).toBeTruthy()
  })

  it('an empty ledger shows EmptyState', async () => {
    const getGovernanceEvents = vi.fn(async () => [])
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByText(/nothing/i)).toBeTruthy())
  })

  it('lists events newest-first, verbatim (kind, actor, time)', async () => {
    const getGovernanceEvents = vi.fn(async () => [
      event({ id: 'e-2', kind: 'device.audit_break', actor: null }),
      event({ id: 'e-1', kind: 'device.enrolled', actor: 'p-1' }),
    ])
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByText('device.audit_break')).toBeTruthy())
    expect(screen.getByText('device.enrolled')).toBeTruthy()
    expect(screen.getByText('p-1')).toBeTruthy()
    // Rows in the order the server gave them — the server's newest-first is
    // the page's newest-first, never re-sorted client-side.
    const rows = screen.getAllByTestId(/governance-row-/)
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
      'governance-row-e-2',
      'governance-row-e-1',
    ])
  })

  it('a kind this page has no colour for still renders, verbatim — never hidden', async () => {
    const getGovernanceEvents = vi.fn(async () => [event({ id: 'e-9', kind: 'future.kind' })])
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByText('future.kind')).toBeTruthy())
  })

  it('a failed load states the reason', async () => {
    const getGovernanceEvents = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
  })

  it('loads another page, older, appended after the current rows', async () => {
    const first = Array.from({ length: 3 }, (_, i) => event({ id: `e-${i}` }))
    const second = [event({ id: 'e-old' })]
    const getGovernanceEvents = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    render(<GovernancePage api={{ getGovernanceEvents }} pageSize={3} />)

    await waitFor(() => expect(getGovernanceEvents).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))

    await waitFor(() => expect(getGovernanceEvents).toHaveBeenCalledTimes(2))
    expect(getGovernanceEvents.mock.calls[1][0]).toEqual(
      expect.objectContaining({ before: 'e-2' }),
    )
  })
})
