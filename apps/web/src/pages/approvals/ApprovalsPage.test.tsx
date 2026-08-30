import { describe, it, expect, vi } from 'vitest'
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
) {
  return render(
    <ChatProvider consentsApi={{ decideConsent: decideConsentApi }}>
      <ApprovalsPage {...props} />
    </ChatProvider>,
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

  it('approving removes the card from the pending list', async () => {
    const getConsents = vi.fn(async () => [card()])
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    renderPage({ api: { getConsents } }, decideConsentApi)
    await waitFor(() => screen.getByRole('button', { name: /approve/i }))

    fireEvent.click(screen.getByRole('button', { name: /approve/i }))

    await waitFor(() => expect(decideConsentApi).toHaveBeenCalledWith('c-1', 'approve'))
    await waitFor(() => expect(screen.queryByTestId('approval-card-c-1')).toBeNull())
    expect(screen.getByText(/nothing/i)).toBeTruthy()
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
})
