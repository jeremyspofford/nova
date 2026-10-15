import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MobileTitleSlot } from '../../components/layout/PageHeader'
import { PaneBarTitle, PaneTitle } from './PaneBarTitle'

// 2026-10-11: below lg the chat draws no header of its own, so the phone's
// top bar sat empty beside the menu button. The session's name goes there.

function withSlot(ui: React.ReactNode) {
  const slot = document.createElement('div')
  slot.setAttribute('data-testid', 'slot')
  document.body.append(slot)
  render(<MobileTitleSlot.Provider value={slot}>{ui}</MobileTitleSlot.Provider>)
  return slot
}

describe('PaneBarTitle', () => {
  it("puts the session's name in the top bar", () => {
    const slot = withSlot(<PaneBarTitle label="help me setup nova" main={false} show />)
    expect(within(slot).getByRole('heading', { name: 'help me setup nova' })).toBeDefined()
  })

  it('shows only the main tag for the main session, never its old name', () => {
    // Owner, 2026-10-15: the main chat is "main", not the name it once had.
    const slot = withSlot(<PaneBarTitle label="the main one" main show />)
    expect(within(slot).getByTestId('main-tag').textContent).toBe('main')
    expect(slot.textContent).not.toContain('the main one')
  })

  it('draws nothing for a pane that is not the one in front', () => {
    const slot = withSlot(<PaneBarTitle label="side pane" main={false} show={false} />)
    expect(slot.textContent).toBe('')
  })

  it('draws nothing without a top bar (desktop has the pane header)', () => {
    render(<PaneBarTitle label="desk" main={false} show />)
    expect(screen.queryByText('desk')).toBeNull()
  })
})

describe('PaneTitle (the desktop pane header)', () => {
  it('names an ordinary session, with no main tag', () => {
    render(<PaneTitle label="update the agent" main={false} />)
    expect(screen.getByRole('heading', { name: 'update the agent' })).toBeDefined()
    expect(screen.queryByTestId('main-tag')).toBeNull()
  })

  it('draws the main session as the tag alone', () => {
    const { container } = render(<PaneTitle label="primary" main />)
    expect(screen.getByTestId('main-tag').textContent).toBe('main')
    expect(container.textContent).not.toContain('primary')
  })
})
