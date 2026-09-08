import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { InboxPage } from './InboxPage'
import { noticeFixture } from './noticeFixture'
import type { Notice, NoticeListing } from '../../lib/api'

/** The listing the page reads, with the server's own unseen count. */
function listing(notices: Notice[], unseen?: number): NoticeListing {
  return {
    notices,
    // Default to something the page could NOT have derived from the rows, so
    // a test that sees this number knows it came from the server.
    unseen_count: unseen ?? notices.filter(n => n.seen_at === null).length,
  }
}

function fakeApi(page: () => NoticeListing = () => listing([])) {
  return {
    listNotices: vi.fn(async (_opts: { limit?: number } = {}) => page()),
    markNoticeSeen: vi.fn(async () => {}),
    muteNotice: vi.fn(async () => {}),
  }
}

const NEVER = 1_000_000

function renderPage(api: ReturnType<typeof fakeApi>, pollMs = NEVER) {
  return render(<InboxPage api={api} pollMs={pollMs} />)
}

describe('InboxPage — the record of what she noticed', () => {
  it('shows the empty state when no check has found anything', async () => {
    renderPage(fakeApi())
    expect(await screen.findByText(/nothing noticed yet/i)).toBeDefined()
    expect(screen.getByText(/the checks ran and found nothing/i)).toBeDefined()
  })

  it('renders a row per notice: the title, the check, the facts, when it was seen, and whether it is still true', async () => {
    const api = fakeApi(() =>
      listing([
        noticeFixture({
          id: 'n1',
          check_name: 'stack_service_unreachable',
          title: 'the gateway is not answering',
          facts: { service: 'gateway', tries: 3 },
          urgent: true,
          first_seen_at: new Date(Date.now() - 3 * 60_000).toISOString(),
          last_seen_at: new Date(Date.now() - 60_000).toISOString(),
        }),
        noticeFixture({
          id: 'n2',
          check_name: 'timer_failing',
          title: 'the backup timer has failed 4 nights running',
          cleared_at: new Date(Date.now() - 30_000).toISOString(),
          state: 'delivered',
          delivery: { chat: { ok: true } },
        }),
      ]),
    )
    renderPage(api)
    const list = await screen.findByTestId('inbox-list')

    const first = within(list).getByTestId('notice-row-n1')
    expect(within(first).getByText('the gateway is not answering')).toBeDefined()
    expect(within(first).getByText('stack_service_unreachable')).toBeDefined()
    expect(within(first).getByTestId('urgent-badge').textContent).toBe('urgent')
    expect(within(first).getByTestId('live-pill').textContent).toBe('still true')
    expect(within(first).getByTestId('state-badge').textContent).toBe('not told yet')
    const facts = within(first).getByTestId('notice-facts')
    expect(facts.textContent).toContain('service: gateway')
    expect(facts.textContent).toContain('tries: 3')
    expect(within(first).getByText(/first seen 3m ago/)).toBeDefined()
    expect(within(first).getByText(/last seen 1m ago/)).toBeDefined()
    // Nothing has been attempted, so the row says that rather than showing
    // a delivery line nobody reported.
    expect(within(first).getByTestId('no-delivery-yet')).toBeDefined()

    const second = within(list).getByTestId('notice-row-n2')
    expect(within(second).getByTestId('live-pill').textContent).toBe('cleared')
    expect(within(second).getByTestId('cleared-at')).toBeDefined()
    expect(within(second).getByTestId('state-badge').textContent).toBe('told you')
    expect(within(second).getByTestId('delivery-lines').textContent).toContain('chat: delivered')
    expect(within(second).queryByTestId('urgent-badge')).toBeNull()

    // The order the server gave, never re-sorted here.
    expect(within(list).getAllByTestId(/^notice-row-/).map(r => r.getAttribute('data-testid')))
      .toEqual(['notice-row-n1', 'notice-row-n2'])
  })

  it('shows what she DID about it and links the turn that is the account of it', async () => {
    renderPage(
      fakeApi(() =>
        listing([
          noticeFixture({
            id: 'n1',
            acted: true,
            acted_note: 'restarted the gateway container and confirmed it answered',
            acted_turn_id: 'turn-7',
          }),
        ]),
      ),
    )
    const row = await screen.findByTestId('notice-row-n1')
    expect(within(row).getByTestId('acted-line').textContent).toContain('restarted the gateway container')
    const link = within(row).getByTestId('acted-trace-link')
    expect(link.getAttribute('href')).toBe('/activity?turn=turn-7')
  })

  it('renders no trace link for a notice she did not act on', async () => {
    renderPage(fakeApi(() => listing([noticeFixture({ id: 'n1', acted: false })])))
    const row = await screen.findByTestId('notice-row-n1')
    expect(within(row).queryByTestId('acted-line')).toBeNull()
    expect(within(row).queryByTestId('acted-trace-link')).toBeNull()
  })

  it('counts sightings only above one, and says the count came from the server', async () => {
    renderPage(
      fakeApi(() =>
        listing(
          [noticeFixture({ id: 'n1', repeats: 5 }), noticeFixture({ id: 'n2', repeats: 1 })],
          9,
        ),
      ),
    )
    const first = await screen.findByTestId('notice-row-n1')
    expect(within(first).getByTestId('sightings').textContent).toBe('seen 5 times by the checks')
    expect(within(screen.getByTestId('notice-row-n2')).queryByTestId('sightings')).toBeNull()
    // 9 is the server's count over every row — not 2, which is all this page
    // could have counted for itself.
    expect(screen.getByTestId('unseen-count').textContent).toContain('9 unread')
  })

  it('states a failed delivery in the server\'s own words', async () => {
    renderPage(
      fakeApi(() =>
        listing([
          noticeFixture({
            id: 'n1',
            state: 'failed',
            failed_reason: 'the chat row was not there when it was read back',
          }),
        ]),
      ),
    )
    const row = await screen.findByTestId('notice-row-n1')
    expect(within(row).getByTestId('state-badge').textContent).toBe('not delivered')
    expect(within(row).getByTestId('delivery-lines').textContent).toContain(
      'the chat row was not there when it was read back',
    )
  })

  // The unread count is over EVERY row, so a list that silently stopped at the
  // page size would disagree with the number above it and say nothing about
  // why.
  it('says so when the page it asked for came back full', async () => {
    const api = fakeApi(() => listing([noticeFixture({ id: 'n1' })], 12))
    render(<InboxPage api={api} pollMs={NEVER} pageSize={1} />)
    expect((await screen.findByTestId('page-is-full')).textContent).toContain('1 most recently seen')
    expect(api.listNotices).toHaveBeenCalledWith({ limit: 1 })
  })

  it('says nothing about older notices when the page came back short', async () => {
    render(<InboxPage api={fakeApi(() => listing([noticeFixture({ id: 'n1' })]))} pollMs={NEVER} pageSize={5} />)
    await screen.findByTestId('notice-row-n1')
    expect(screen.queryByTestId('page-is-full')).toBeNull()
  })

  it('a failed load states the reason in an alert and shows no empty state', async () => {
    const api = fakeApi()
    api.listNotices = vi.fn(async () => {
      throw new Error('core is not answering (503)')
    })
    renderPage(api)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('503'))
    expect(screen.queryByText(/nothing noticed yet/i)).toBeNull()
    expect(screen.queryByTestId('inbox-skeleton')).toBeNull()
  })
})

describe('InboxPage — the two controls, and only those two', () => {
  it('marks a notice seen through the api and re-reads the listing', async () => {
    let seen = false
    const api = fakeApi(() =>
      listing([noticeFixture({ id: 'n1', seen_at: seen ? new Date().toISOString() : null })]),
    )
    api.markNoticeSeen = vi.fn(async () => {
      seen = true
    })
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')
    fireEvent.click(within(row).getByRole('button', { name: 'Mark seen' }))

    await waitFor(() => expect(api.markNoticeSeen).toHaveBeenCalledWith('n1'))
    // The row shown after the write is the server's, re-read — never patched
    // locally.
    await waitFor(() => expect(api.listNotices).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(
        (within(screen.getByTestId('notice-row-n1')).getByRole('button', {
          name: 'Seen',
        }) as HTMLButtonElement).disabled,
      ).toBe(true),
    )
  })

  it('mutes and unmutes through the api, re-reading each time', async () => {
    let muted = false
    const api = fakeApi(() => listing([noticeFixture({ id: 'n1', state: muted ? 'muted' : 'raised' })]))
    api.muteNotice = vi.fn(async (_id: string, next: boolean) => {
      muted = next
    })
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')
    fireEvent.click(within(row).getByRole('button', { name: 'Mute' }))

    await waitFor(() => expect(api.muteNotice).toHaveBeenCalledWith('n1', true))
    await waitFor(() =>
      expect(within(screen.getByTestId('notice-row-n1')).getByTestId('state-badge').textContent).toBe(
        'muted',
      ),
    )
    expect(api.listNotices).toHaveBeenCalledTimes(2)

    fireEvent.click(within(screen.getByTestId('notice-row-n1')).getByRole('button', { name: 'Unmute' }))
    await waitFor(() => expect(api.muteNotice).toHaveBeenCalledWith('n1', false))
    await waitFor(() =>
      expect(within(screen.getByTestId('notice-row-n1')).getByTestId('state-badge').textContent).toBe(
        'not told yet',
      ),
    )
    expect(api.listNotices).toHaveBeenCalledTimes(3)
  })

  it('a refused write states core\'s words on that row and changes nothing else', async () => {
    const api = fakeApi(() => listing([noticeFixture({ id: 'n1' })]))
    api.muteNotice = vi.fn(async () => {
      throw new Error('no notice with id n1')
    })
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')
    fireEvent.click(within(row).getByRole('button', { name: 'Mute' }))
    await waitFor(() =>
      expect(within(screen.getByTestId('notice-row-n1')).getByRole('alert').textContent).toBe(
        'no notice with id n1',
      ),
    )
    // A refusal is not a re-read: the list is exactly as it was.
    expect(api.listNotices).toHaveBeenCalledTimes(1)
    expect(within(screen.getByTestId('notice-row-n1')).getByTestId('state-badge').textContent).toBe(
      'not told yet',
    )
  })

  // The house rule, pinned on the surface: this page reads and silences. An
  // approve/deny/dismiss control here would be an authorization decision the
  // owner ruled out on 2026-09-03 (services/core/tests/test_no_approvals.py
  // is the same line of code on the other side).
  it('offers a read receipt and a mute, and no approval of any kind', async () => {
    renderPage(fakeApi(() => listing([noticeFixture({ id: 'n1' })])))
    const row = await screen.findByTestId('notice-row-n1')
    const labels = within(row)
      .getAllByRole('button')
      .map(b => b.textContent?.trim())
    expect(labels).toEqual(['Mark seen', 'Mute'])
    for (const forbidden of [/approve/i, /deny/i, /reject/i, /dismiss/i, /allow/i]) {
      expect(within(row).queryByRole('button', { name: forbidden })).toBeNull()
    }
  })
})

describe('InboxPage — the light poll', () => {
  it('re-reads on the interval so a notice raised while the page is open appears', async () => {
    let raised = false
    const api = fakeApi(() => listing(raised ? [noticeFixture({ id: 'n1' })] : []))
    renderPage(api, 10)
    await screen.findByText(/nothing noticed yet/i)
    raised = true
    await waitFor(() => expect(screen.getByTestId('notice-row-n1')).toBeDefined())
  })

  it('stops polling after unmount', async () => {
    const api = fakeApi(() => listing([noticeFixture()]))
    const { unmount } = renderPage(api, 10)
    await waitFor(() => expect(api.listNotices.mock.calls.length).toBeGreaterThanOrEqual(3))
    unmount()
    const atUnmount = api.listNotices.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(api.listNotices.mock.calls.length).toBe(atUnmount)
  })
})
