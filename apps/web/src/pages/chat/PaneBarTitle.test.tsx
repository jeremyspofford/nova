import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MobileTitleSlot } from '../../components/layout/PageHeader'
import { PaneBarTitle } from './PaneBarTitle'

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

  it('marks the main session', () => {
    const slot = withSlot(<PaneBarTitle label="the main one" main show />)
    expect(within(slot).getByTitle(/main session/i)).toBeDefined()
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
