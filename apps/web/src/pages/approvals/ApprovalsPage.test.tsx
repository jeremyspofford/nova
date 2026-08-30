import { describe, it, expect, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ApprovalsPage } from './ApprovalsPage'
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

function renderPage(
  props: Partial<React.ComponentProps<typeof ApprovalsPage>> = {},
  decideConsentApi = vi.fn(async () => card({ status: 'approved' })),
  chatApi: { getActiveConversation: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> } = {
    getActiveConversation: vi.fn(),
    getMessages: vi.fn(),
  },
) {
  return render(
    <MemoryRouter initialEntries={['/approvals']}>
      <ChatProvider consentsApi={{ decideConsent: decideConsentApi }} chatApi={chatApi}>
        <Routes>
          <Route path="/approvals" element={<ApprovalsPage {...props} />} />
          <Route path="/chat" element={<div data-testid="chat-page-stub">chat</div>} />
        </Routes>
      </ChatProvider>
    </MemoryRouter>,
  )
}

describe('ApprovalsPage', () => {
  it('shows a skeleton while loading', () => {
    const getConsents = vi.fn(() => new Promise<ConsentCard[]>(() => {}))
    renderPage({ api: { getConsents } })
    expect(screen.getByTestId('approvals-skeleton')).toBeTruthy()
  })

  it('an empty pending set shows EmptyState', async () => {
    const getConsents = vi.fn(async () => [])
    renderPage({ api: { getConsents } })
    await waitFor(() => expect(screen.getByText(/nothing/i)).toBeTruthy())
  })

  it('lists pending cards with their summaries', async () => {
    const getConsents = vi.fn(async () => [card()])
    renderPage({ api: { getConsents } })
    await waitFor(() =>
      expect(screen.getByText(/Run fetch_url with url=https:\/\/example\.com\/pricing/)).toBeTruthy(),
    )
  })

  it('denying removes the card from the pending list (terminal, per ruling S3-R4)', async () => {
    const getConsents = vi.fn(async () => [card()])
    const decideConsentApi = vi.fn(async () => card({ status: 'denied' }))
    renderPage({ api: { getConsents } }, decideConsentApi)
    await waitFor(() => screen.getByRole('button', { name: /deny/i }))

    fireEvent.click(screen.getByRole('button', { name: /deny/i }))

    await waitFor(() => expect(decideConsentApi).toHaveBeenCalledWith('c-1', 'deny'))
    await waitFor(() => expect(screen.queryByTestId('approval-card-c-1')).toBeNull())
    expect(screen.getByText(/nothing/i)).toBeTruthy()
  })

  it('approving from here (a different — or no — conversation than any open chat) keeps the card visible with Go ahead, not removed', async () => {
    // S3-T3's folded fix: approving does not itself run the action (ruling
    // S3-R4), and deciding from THIS page never auto-continues (the T2
    // review's Important #2) — the card must stay visible with an explicit
    // way to trigger the re-attempt, never silently vanish as if it ran.
    const getConsents = vi.fn(async () => [card()])
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    renderPage({ api: { getConsents } }, decideConsentApi)
    await waitFor(() => screen.getByRole('button', { name: /^approve$/i }))

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(decideConsentApi).toHaveBeenCalledWith('c-1', 'approve'))
    await waitFor(() => expect(screen.getByTestId('approval-card-c-1')).toBeTruthy())
    expect(screen.getByRole('button', { name: /go ahead/i })).toBeTruthy()
    expect(screen.queryByText(/nothing/i)).toBeNull()
  })

  it('clicking Go ahead triggers the re-attempt and navigates to chat to watch it run', async () => {
    const getConsents = vi.fn(async () => [card()])
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    const getActiveConversation = vi.fn(async () => ({
      id: 'conv-1',
      title: null,
      created_at: '2026-08-30T00:00:00Z',
      pending_turn: false,
    }))
    const getMessages = vi.fn(async () => [])
    renderPage({ api: { getConsents } }, decideConsentApi, { getActiveConversation, getMessages })

    await waitFor(() => screen.getByRole('button', { name: /^approve$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => screen.getByRole('button', { name: /go ahead/i }))

    fireEvent.click(screen.getByRole('button', { name: /go ahead/i }))

    await waitFor(() => expect(getActiveConversation).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('chat-page-stub')).toBeTruthy())
    await waitFor(() => expect(screen.queryByTestId('approval-card-c-1')).toBeNull())
  })

  it('a failed load states the reason', async () => {
    const getConsents = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    renderPage({ api: { getConsents } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
  })

  it('a failed decide states the reason and keeps the card pending', async () => {
    const getConsents = vi.fn(async () => [card()])
    const decideConsentApi = vi.fn(async () => {
      throw new Error('the server refused the turn (404)')
    })
    renderPage({ api: { getConsents } }, decideConsentApi)
    await waitFor(() => screen.getByRole('button', { name: /deny/i }))

    fireEvent.click(screen.getByRole('button', { name: /deny/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('404'))
    expect(screen.getByTestId('approval-card-c-1')).toBeTruthy()
  })

  it('a failed Go ahead states the reason and keeps the card visible', async () => {
    const getConsents = vi.fn(async () => [card()])
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    const getActiveConversation = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    const getMessages = vi.fn()
    renderPage({ api: { getConsents } }, decideConsentApi, { getActiveConversation, getMessages })

    await waitFor(() => screen.getByRole('button', { name: /^approve$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => screen.getByRole('button', { name: /go ahead/i }))

    fireEvent.click(screen.getByRole('button', { name: /go ahead/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
    expect(screen.getByTestId('approval-card-c-1')).toBeTruthy()
  })
})
