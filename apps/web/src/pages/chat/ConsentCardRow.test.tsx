import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConsentCardRow } from './ConsentCardRow'
import { ChatProvider } from '../../stores/chat-store'
import type { ConsentCard } from '../../lib/consentCard'

function card(overrides: Partial<ConsentCard> = {}): ConsentCard {
  return {
    consent_id: 'c-1',
    action_class: 'fetch_url',
    args_hash: 'hash',
    args: { url: 'https://example.com/pricing' },
    summary: 'Run fetch_url with url=https://example.com/pricing',
    status: 'pending',
    conversation_id: 'conv-1',
    requested_by: { person_id: 'p-1', agent: 'chat' },
    created_at: '2026-08-30T00:00:00Z',
    expires_at: '2026-08-31T00:00:00Z',
    ...overrides,
  }
}

describe('ConsentCardRow', () => {
  it('approving calls the store and clears busy with no error on success', async () => {
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    render(
      <ChatProvider consentsApi={{ decideConsent: decideConsentApi }}>
        <ConsentCardRow card={card()} />
      </ChatProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(decideConsentApi).toHaveBeenCalledWith('c-1', 'approve'))
    // Busy clears (the row's own responsibility) and no error is shown. The
    // row's `card` prop is fixed here — a caller (ChatPage) reactively
    // supplying an updated card once the reducer's own consentDecided lands
    // is proven separately (chatReducer.test.ts, chat-store.test.tsx).
    await waitFor(() => {
      const approve = screen.getByRole('button', { name: /approve/i }) as HTMLButtonElement
      expect(approve.disabled).toBe(false)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a failed decide shows the stated reason rather than pretending nothing happened', async () => {
    const decideConsentApi = vi.fn(async () => {
      throw new Error('the server refused the turn (404)')
    })
    render(
      <ChatProvider consentsApi={{ decideConsent: decideConsentApi }}>
        <ConsentCardRow card={card()} />
      </ChatProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('404'))
  })
})
