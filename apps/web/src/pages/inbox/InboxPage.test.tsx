import { describe, it, expect, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { InboxPage } from './InboxPage'
import { noticeFixture } from './noticeFixture'
import type { Notice, NoticeDigest, NoticeListing } from '../../lib/api'

/** The listing the page reads, with the server's own unseen count. */
function listing(notices: Notice[], unseen?: number, muted = 0): NoticeListing {
  return {
    notices,
    // Default to something the page could NOT have derived from the rows, so
    // a test that sees this number knows it came from the server.
    unseen_count: unseen ?? notices.filter(n => n.seen_at === null).length,
    // Counted by the server over every row, including the ones this page is
    // not holding — which is the whole point of the muted tab (S25.1.2).
    muted_count: muted,
  }
}

function fakeApi(page: () => NoticeListing = () => listing([])) {
  return {
    listNotices: vi.fn(async (_opts: { limit?: number; muted?: boolean } = {}) => page()),
    markNoticeSeen: vi.fn(async () => {}),
    listNoticeDigests: vi.fn(
      async (): Promise<{ digests: NoticeDigest[]; not_told_yet: Notice[] }> => ({
        digests: [],
        not_told_yet: [],
      }),
    ),
    talkAboutNotice: vi.fn(async () => ({
      conversation_id: 'room-1',
      parent_message_id: 'm1',
      created: true,
    })),
    muteNotice: vi.fn(async () => {}),
  }
}

const NEVER = 1_000_000

/** Where the router is, rendered into the page so a test can read it. The
 * app navigates for real; MemoryRouter never touches window.location, so
 * without this "it went to the room" would be unfalsifiable. */
function Where() {
  const location = useLocation()
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>
}

function renderPage(
  api: ReturnType<typeof fakeApi>,
  pollMs = NEVER,
  props: { pageSize?: number } = {},
) {
  // A router, because a card's facts carry links (S25.2.2) and "talk about
  // this" navigates (S25.2.4). The page is always inside one in the app, so
  // without it these would work in production and throw only here.
  return render(
    <MemoryRouter>
      <InboxPage api={api} pollMs={pollMs} {...props} />
      <Where />
    </MemoryRouter>,
  )
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
    renderPage(api, NEVER, { pageSize: 1 })
    expect((await screen.findByTestId('page-is-full')).textContent).toContain('1 most recent')
    expect(api.listNotices).toHaveBeenCalledWith({ limit: 1, muted: false })
  })

  it('says nothing about older notices when the page came back short', async () => {
    renderPage(fakeApi(() => listing([noticeFixture({ id: 'n1' })])), NEVER, { pageSize: 5 })
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
    // The server answers with BOTH facts, and the page reads `silenced` for
    // the button — the state is what the badge renders (S25.1.2).
    const api = fakeApi(() =>
      listing([
        noticeFixture({ id: 'n1', state: muted ? 'muted' : 'raised', silenced: muted }),
      ]),
    )
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
    // "Talk about this" joined them in S25.2.4 and is the same kind of
    // thing: it opens a conversation. None of the three decides anything.
    expect(labels).toEqual(['Talk about this', 'Mark seen', 'Mute'])
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

describe('InboxPage — the muted half of the table (S25.1.2)', () => {
  it('offers the muted tab only when the server says something is muted', async () => {
    const quiet = fakeApi(() => listing([noticeFixture({ id: 'n1' })], 1, 0))
    const { unmount } = renderPage(quiet)
    await screen.findByTestId('notice-row-n1')
    // Nothing is muted, so there is no half to switch to and no tab to
    // explain — the page does not grow controls for rows that do not exist.
    // The tab bar is always there — Inbox and "What you were told" are
    // always meaningful — but the MUTED tab is not, because a tab that can
    // only ever be empty is furniture.
    expect(screen.getByTestId('inbox-tabs')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Muted/ })).toBeNull()
    unmount()

    const api = fakeApi(() => listing([noticeFixture({ id: 'n1' })], 1, 3))
    renderPage(api)
    // The COUNT is the point: an unlabelled tab is one nobody clicks, and
    // rows behind a filter nobody opens are as gone as deleted ones.
    expect(await screen.findByRole('button', { name: 'Muted (3)' })).toBeTruthy()
  })

  it('asks the server for the other half rather than filtering the page it holds', async () => {
    const api = fakeApi(() => listing([noticeFixture({ id: 'n1' })], 1, 2))
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Muted (2)' }))

    // A muted row may be far outside this page of rows — the count is over
    // EVERY row — so the switch is a read, never a client-side filter.
    await waitFor(() =>
      expect(api.listNotices).toHaveBeenCalledWith(expect.objectContaining({ muted: true })),
    )
  })

  it('says the muted view is empty in its own words, not "nothing noticed yet"', async () => {
    const api = fakeApi(() => listing([], 0, 1))
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Muted (1)' }))

    await waitFor(() => expect(screen.getByText(/nothing is muted/i)).toBeTruthy())
    expect(screen.queryByText(/nothing noticed yet/i)).toBeNull()
  })
})

describe('InboxPage — a subject you can go and look at (S25.2.2)', () => {
  it('renders a linkable fact as a link to the page that opens it', async () => {
    const api = fakeApi(() =>
      listing([noticeFixture({ id: 'n1', facts: { timer_id: '0b39fae3', kind: 'scheduled' } })]),
    )
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')

    const link = within(row).getByRole('link', { name: '0b39fae3' })
    // `?timer=` is a parameter SchedulesPage actually reads (App.tsx's
    // SchedulesRoute), so following this opens that timer rather than
    // dropping him on a list to search.
    expect(link.getAttribute('href')).toBe('/schedules?timer=0b39fae3')
    // The value is still core's, verbatim — a link changes where a click
    // goes, never what the evidence says.
    expect(link.textContent).toBe('0b39fae3')
  })

  it('leaves a fact with nowhere to go as plain text', async () => {
    const api = fakeApi(() => listing([noticeFixture({ id: 'n1', facts: { kind: 'scheduled' } })]))
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')

    expect(within(row).queryByRole('link')).toBeNull()
    expect(within(row).getByTestId('notice-facts').textContent).toContain('scheduled')
  })
})

describe('InboxPage — talk about this (S25.2.4)', () => {
  it('opens the room off the message that told him, and goes there', async () => {
    const api = fakeApi(() =>
      listing([noticeFixture({ id: 'n1', delivered_message_id: 'm7', state: 'delivered' })]),
    )
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')

    fireEvent.click(within(row).getByTestId('talk-about'))

    await waitFor(() => expect(api.talkAboutNotice).toHaveBeenCalledWith('n1'))
    // The room core answered with — never one the page composed from the
    // message id, which would be the client inventing a conversation.
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/chat?thread=room-1'),
    )
  })

  it('offers the control disabled when nothing has carried it to him yet', async () => {
    const api = fakeApi(() => listing([noticeFixture({ id: 'n1', delivered_message_id: null })]))
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')

    const button = within(row).getByTestId('talk-about')
    // Disabled rather than hidden: the reason is a fact about the world, and
    // a control that vanishes leaves him wondering why this card is
    // different from the one above it.
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('no message to talk under')
    fireEvent.click(button)
    expect(api.talkAboutNotice).not.toHaveBeenCalled()
  })

  it('states a refusal on the row rather than navigating', async () => {
    const api = fakeApi(() =>
      listing([noticeFixture({ id: 'n1', delivered_message_id: 'm7', state: 'delivered' })]),
    )
    api.talkAboutNotice = vi.fn(async () => {
      throw new Error('this notice has not been delivered, so there is no message to talk under')
    })
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')

    fireEvent.click(within(row).getByTestId('talk-about'))

    await waitFor(() =>
      expect(within(row).getByText(/no message to talk under/)).toBeTruthy(),
    )
  })

  it('says when NOVA silenced something, not just that it is silenced', async () => {
    const api = fakeApi(() =>
      listing([noticeFixture({ id: 'n1', silenced: true, muted_by: null })], 0, 1),
    )
    renderPage(api)
    const row = await screen.findByTestId('notice-row-n1')

    // A silence he did not ask for must not look like one he did.
    expect(within(row).getByTestId('silence-line').textContent).toContain('Nova silenced this')
  })
})

describe('InboxPage — what you were told, and when (S25 Q4)', () => {
  const told = (over: Partial<Notice> = {}) =>
    noticeFixture({ state: 'delivered', delivered_message_id: 'm7', ...over })

  function withDigests(groups: unknown[], notTold: Notice[] = []) {
    const api = fakeApi(() => listing([]))
    api.listNoticeDigests = vi.fn(async () => ({
      digests: groups as NoticeDigest[],
      not_told_yet: notTold,
    }))
    return api
  }

  it('groups the cards under the telling that carried them', async () => {
    const api = withDigests([
      {
        message_id: 'm7',
        delivered_at: new Date(Date.now() - 3 * 60_000).toISOString(),
        notices: [told({ id: 'n1', title: 'the disk is full' }), told({ id: 'n2' })],
      },
    ])
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: 'What you were told' }))

    const group = await screen.findByTestId('digest-m7')
    // The COUNT is the point of a telling: "she told you two things", not
    // two cards that happen to be adjacent.
    expect(group.textContent).toContain('2 things')
    expect(within(group).getByText('the disk is full')).toBeTruthy()
    // The same card as every other view — a card that says different things
    // on two pages is two cards.
    expect(within(group).getAllByTestId(/^notice-row-/)).toHaveLength(2)
  })

  it('files what nothing has carried under "not told yet", not under the newest telling', async () => {
    const api = withDigests(
      [{ message_id: 'm7', delivered_at: new Date().toISOString(), notices: [told({ id: 'n1' })] }],
      [noticeFixture({ id: 'n9', title: 'nobody has been told this' })],
    )
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: 'What you were told' }))

    const waiting = await screen.findByTestId('not-told-yet')
    expect(within(waiting).getByText('nobody has been told this')).toBeTruthy()
    expect(within(screen.getByTestId('digest-m7')).queryByText('nobody has been told this')).toBeNull()
  })

  it('says nothing has been carried rather than showing an empty page', async () => {
    renderPage(withDigests([]))
    fireEvent.click(await screen.findByRole('button', { name: 'What you were told' }))

    await waitFor(() => expect(screen.getByText(/nothing has been carried to you yet/i)).toBeTruthy())
  })

  it('reads the tellings from the server rather than regrouping the page it holds', async () => {
    // A digest is derived from `delivered_message_id` on the server. Grouping
    // client-side would quietly invent tellings out of whatever page of rows
    // happened to be loaded.
    const api = withDigests([])
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: 'What you were told' }))

    await waitFor(() => expect(api.listNoticeDigests).toHaveBeenCalled())
  })
})
