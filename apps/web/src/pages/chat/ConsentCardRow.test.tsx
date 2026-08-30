import { useEffect } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConsentCardRow } from './ConsentCardRow'
import { ChatProvider, useChatStore } from '../../stores/chat-store'
import type { ConsentCard } from '../../lib/consentCard'

/** Loads 'conv-1' into the store before the row is interacted with — the
 * ordinary case (ChatPage already reconciled the open conversation) and, for
 * these tests, what keeps resumeApprovedCard's conversation-already-matches
 * branch from reaching for the real (unmocked) conversation-fetch API. */
function LoadsConvOne() {
  const { loadConversation } = useChatStore()
  useEffect(() => loadConversation('conv-1', []), [loadConversation])
  return null
}

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

  it('offers Go ahead on an approved card once the store is idle again (the auto-continue did not fire)', async () => {
    // Rendered already-approved (e.g. decided elsewhere) with no live turn —
    // exactly the case the auto-continuation inside decideConsent never
    // covers: this row's card did not arrive via THIS store's own decide.
    render(
      <ChatProvider>
        <ConsentCardRow card={card({ status: 'approved' })} />
      </ChatProvider>,
    )
    expect(screen.getByRole('button', { name: /go ahead/i })).toBeTruthy()
  })

  it('hides Go ahead while a turn is streaming (the auto-continuation just fired, or another is running)', async () => {
    const stream = { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) }
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '', body: stream }) as unknown as Response)
    function Sender() {
      const { sendMessage } = useChatStore()
      return <button onClick={() => sendMessage('hi')}>go</button>
    }
    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <LoadsConvOne />
        <Sender />
        <ConsentCardRow card={card({ status: 'approved' })} />
      </ChatProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /go ahead/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /go ahead/i })).toBeNull())
  })

  it('clicking Go ahead calls resumeApprovedCard with this card', async () => {
    const stream = { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) }
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      ({ ok: true, status: 200, text: async () => '', body: stream }) as unknown as Response,
    )
    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <LoadsConvOne />
        <ConsentCardRow card={card({ status: 'approved' })} />
      </ChatProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /go ahead/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /go ahead/i }))
    // A real continuation turn went out — the same mechanism decideConsent's
    // auto-fire uses, never a fake "it happened".
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(String(init.body)).message).toContain('approved')
  })
})
