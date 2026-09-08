import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../../stores/auth-store'
import { UnseenNoticesProvider } from '../../hooks/useUnseenNotices'
import type { NoticeListing } from '../../lib/api'

/** Sign an owner in, so the whole System group renders. */
function mockAuth() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/auth/state')
        ? { has_users: true }
        : { person: { id: 'p1', name: 'Ada', role: 'owner' } }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response
    }),
  )
}

const NEVER = 1_000_000

function renderSidebar(listNotices: () => Promise<NoticeListing>) {
  mockAuth()
  return render(
    <MemoryRouter>
      <AuthProvider>
        <UnseenNoticesProvider listNotices={listNotices} pollMs={NEVER}>
          <Sidebar collapsed={false} onToggle={() => {}} />
        </UnseenNoticesProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** The Inbox nav entry, whichever surface it is on. */
function inboxLink(): HTMLElement {
  return screen.getByRole('link', { name: /inbox/i })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Sidebar — the Inbox badge (S11)', () => {
  it('shows the count the SERVER stated, on the Inbox entry only', async () => {
    // 4 unread over rows this page never saw: the badge is the server's
    // number, not a count of anything the browser is holding.
    renderSidebar(async () => ({ notices: [], unseen_count: 4 }))
    await waitFor(() => expect(screen.getByTestId('nav-count-badge').textContent).toBe('4'))
    expect(within(inboxLink()).getByTestId('nav-count-badge')).toBeDefined()
    // Exactly one entry carries a count.
    expect(screen.getAllByTestId('nav-count-badge')).toHaveLength(1)
  })

  it('shows no badge when nothing is unread', async () => {
    renderSidebar(async () => ({ notices: [], unseen_count: 0 }))
    await waitFor(() => expect(inboxLink()).toBeDefined())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(screen.queryByTestId('nav-count-badge')).toBeNull()
  })

  // An unknown count is not zero. A nav item that silently shows no badge
  // because core is down would read as "nothing is waiting" — a success claim
  // nobody checked — so the reason is stated on the entry itself.
  it('states an unreadable count on the entry rather than implying an empty inbox', async () => {
    renderSidebar(async () => {
      throw new Error('core is not answering')
    })
    await waitFor(() =>
      expect(inboxLink().getAttribute('title')).toBe(
        'the unread count could not be read — core is not answering',
      ),
    )
    expect(screen.queryByTestId('nav-count-badge')).toBeNull()
  })

  it('renders no badge at all outside the provider — a bare shell knows nothing', async () => {
    mockAuth()
    render(
      <MemoryRouter>
        <AuthProvider>
          <Sidebar collapsed={false} onToggle={() => {}} />
        </AuthProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(inboxLink()).toBeDefined())
    expect(screen.queryByTestId('nav-count-badge')).toBeNull()
    expect(inboxLink().getAttribute('href')).toBe('/inbox')
  })
})
