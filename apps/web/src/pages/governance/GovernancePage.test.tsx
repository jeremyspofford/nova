import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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

  // S42b Task 29, carry E1 (Task 15/16): a re-pair (decision 4) rebinds a
  // live device's row to a new key — core writes device.repaired beside
  // device.enrolled and device.revoked (governance.py). This page is a
  // record of what happened, never a decision, so the assertion here is
  // only that the kind renders, verbatim, with SOME colour of its own
  // rather than falling through to the no-colour-for-this-kind default.
  it('device.repaired renders verbatim, with its own colour (not the no-colour fallback)', async () => {
    const getGovernanceEvents = vi.fn(async () => [
      event({ id: 'e-10', kind: 'device.repaired' }),
      event({ id: 'e-9', kind: 'future.kind' }),
    ])
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByText('device.repaired')).toBeTruthy())
    const repairedRow = screen.getByTestId('governance-row-e-10')
    const unknownRow = screen.getByTestId('governance-row-e-9')
    const repairedBadge = within(repairedRow).getByText('device.repaired')
    const unknownBadge = within(unknownRow).getByText('future.kind')
    // Pinned apart, not just rendered: device.repaired must not share the
    // unstyled fallback a kind this page has never heard of gets.
    expect(repairedBadge.className).not.toBe(unknownBadge.className)
  })

  it('a failed load states the reason', async () => {
    const getGovernanceEvents = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
  })

  it('renders the tools an mcp.server_connected event left out, capped, with the overflow count', async () => {
    // Fix round 1, item 2 (ruling T10-A): the governance ledger is the
    // durable record of which tools a connect left out and why — this page
    // is where that survives once the add form that first showed it closes.
    const getGovernanceEvents = vi.fn(async () => [
      event({
        id: 'e-mcp',
        kind: 'mcp.server_connected',
        meta: {
          name: 'github',
          rejected: [
            { name: 'bad_tool_1', reason: 'no description' },
            { name: 'bad_tool_2', reason: 'args schema is not an object' },
          ],
          rejected_more: 5,
        },
      }),
    ])
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByText('bad_tool_1')).toBeTruthy())
    expect(screen.getByText(/no description/)).toBeTruthy()
    expect(screen.getByText('bad_tool_2')).toBeTruthy()
    expect(screen.getByText(/args schema is not an object/)).toBeTruthy()
    expect(screen.getByText(/and 5 more/)).toBeTruthy()
  })

  it('an mcp.server_connected event with nothing rejected renders no such list', async () => {
    const getGovernanceEvents = vi.fn(async () => [
      event({ id: 'e-mcp-2', kind: 'mcp.server_connected', meta: { name: 'github' } }),
    ])
    render(<GovernancePage api={{ getGovernanceEvents }} />)
    await waitFor(() => expect(screen.getByText('mcp.server_connected')).toBeTruthy())
    expect(screen.queryByTestId('governance-rejected-e-mcp-2')).toBeNull()
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
