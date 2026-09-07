import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SchedulesPage } from './SchedulesPage'
import type { Timer, TimerFiring } from '../../lib/api'

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()

function timer(overrides: Partial<Timer> = {}): Timer {
  return {
    id: 't1',
    kind: 'reminder',
    title: 'stretch',
    payload: { message: 'stretch', device: null },
    schedule: { kind: 'once', at: '2026-09-06T14:32' },
    schedule_words: 'once, Sat 6 Sep 2026 14:32 EDT (in 2 minutes)',
    timezone: 'America/New_York',
    next_fire_at: inMinutes(2),
    paused_at: null,
    paused_reason: null,
    consecutive_failures: 0,
    created_via: 'chat',
    created_at: new Date().toISOString(),
    last_firing: null,
    ...overrides,
  }
}

function firing(overrides: Partial<TimerFiring> = {}): TimerFiring {
  const started = new Date(Date.now() - 60_000).toISOString()
  return {
    id: 'f1',
    timer_id: 't1',
    scheduled_for: started,
    started_at: started,
    ended_at: new Date(Date.now() - 59_000).toISOString(),
    status: 'ok',
    reason: null,
    turn_id: 'turn-1234-5678',
    delivery: { chat: { ok: true }, devices: [] },
    ...overrides,
  }
}

/** Successive `listTimers` answers come from `pages` in order (the last one
 * repeats); firings are stubbed per timer id. Every mutation answers with a
 * plausible row unless a test overrides it. */
function fakeApi(pages: Timer[][], firings: Record<string, TimerFiring[]> = {}) {
  let call = 0
  return {
    listTimers: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
    listTimerFirings: vi.fn(async (id: string) => firings[id] ?? []),
    pauseTimer: vi.fn(async (id: string, reason?: string) =>
      timer({ id, paused_at: new Date().toISOString(), paused_reason: reason ?? 'paused' }),
    ),
    resumeTimer: vi.fn(async (id: string) => timer({ id, paused_at: null, paused_reason: null })),
    fireTimer: vi.fn(async (id: string) => firing({ id: `fired-${id}`, timer_id: id })),
    deleteTimer: vi.fn(async () => {}),
  }
}

const NEVER = 1_000_000

describe('SchedulesPage — the list', () => {
  it('shows a skeleton while loading', () => {
    const api = fakeApi([[]])
    api.listTimers = vi.fn(() => new Promise<Timer[]>(() => {}))
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    expect(screen.getByTestId('schedules-skeleton')).toBeDefined()
  })

  it('shows the EmptyState when there is nothing yet', async () => {
    render(<SchedulesPage api={fakeApi([[]])} pollMs={NEVER} />)
    expect(await screen.findByText(/no schedules yet/i)).toBeDefined()
  })

  it('renders a row per timer with its kind, title, the server\'s words, next fire and status', async () => {
    render(
      <SchedulesPage
        api={fakeApi([
          [
            timer({ id: 't1', kind: 'reminder', title: 'stretch' }),
            timer({
              id: 't2',
              kind: 'scheduled',
              title: 'calendar',
              schedule_words: 'every day at 07:00 America/New_York, next Sun 7 Sep',
              next_fire_at: inMinutes(3 * 60),
            }),
            timer({
              id: 't3',
              kind: 'job',
              title: 'retention',
              payload: { handler: 'retention' },
              schedule_words: 'every day at 03:30 UTC',
              created_via: 'system',
              timezone: 'UTC',
            }),
          ],
        ])}
        pollMs={NEVER}
      />,
    )
    const row1 = await screen.findByTestId('schedules-row-t1')
    expect(within(row1).getByText('reminder')).toBeDefined()
    expect(within(row1).getByText('stretch')).toBeDefined()
    expect(within(row1).getByText('once, Sat 6 Sep 2026 14:32 EDT (in 2 minutes)')).toBeDefined()
    expect(within(row1).getByText('in 2m')).toBeDefined()
    expect(within(row1).getByText('active')).toBeDefined()

    const row2 = screen.getByTestId('schedules-row-t2')
    expect(within(row2).getByText('scheduled')).toBeDefined()
    expect(within(row2).getByText('every day at 07:00 America/New_York, next Sun 7 Sep')).toBeDefined()
    expect(within(row2).getByText('in 3h')).toBeDefined()

    const row3 = screen.getByTestId('schedules-row-t3')
    expect(within(row3).getByText('job')).toBeDefined()
    expect(within(row3).getByText('retention')).toBeDefined()
    // Rows in the order the server gave them.
    expect(screen.getAllByTestId(/^schedules-row-/).map(r => r.getAttribute('data-testid'))).toEqual([
      'schedules-row-t1',
      'schedules-row-t2',
      'schedules-row-t3',
    ])
  })

  it('a timer that has never fired shows an absence for its last outcome, never an ok', async () => {
    render(<SchedulesPage api={fakeApi([[timer({ id: 't1', last_firing: null })]])} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')
    expect(within(row).getByTitle('never fired')).toBeDefined()
    expect(within(row).queryByText('ok')).toBeNull()
  })

  it('shows the last firing\'s outcome and a paused row as paused, with core\'s own reason on it', async () => {
    render(
      <SchedulesPage
        api={fakeApi([
          [
            timer({
              id: 't1',
              paused_at: new Date().toISOString(),
              paused_reason: 'paused after 5 consecutive failures: no such device',
              consecutive_failures: 5,
              last_firing: { status: 'error', ended_at: new Date().toISOString(), reason: 'no such device' },
            }),
          ],
        ])}
        pollMs={NEVER}
      />,
    )
    const row = await screen.findByTestId('schedules-row-t1')
    expect(within(row).getAllByText('paused').length).toBeGreaterThan(0)
    expect(within(row).getByText('error')).toBeDefined()
    expect(within(row).getByTestId('consecutive-failures').textContent).toBe('5 failures in a row')
    // Paused rows offer Resume, not Pause.
    expect(within(row).getByRole('button', { name: /resume/i })).toBeDefined()
    expect(within(row).queryByRole('button', { name: /^pause$/i })).toBeNull()
    // Run now cannot run a paused row (core refuses fire_now with 409): the
    // button states that up front rather than offering a call that cannot run.
    const runNow = within(row).getByRole('button', { name: /run now/i })
    expect(runNow).toHaveProperty('disabled', true)
    expect(runNow.getAttribute('title')).toMatch(/paused — resume it to run it/i)
    // The detail states the reason verbatim.
    fireEvent.click(row)
    const detail = await screen.findByTestId('schedules-detail-t1')
    expect(within(detail).getByTestId('paused-reason').textContent).toContain(
      'paused after 5 consecutive failures: no such device',
    )
  })

  it('a finished once (next_fire_at NULL) reads finished, with no next fire invented', async () => {
    render(
      <SchedulesPage api={fakeApi([[timer({ id: 't1', next_fire_at: null })]])} pollMs={NEVER} />,
    )
    const row = await screen.findByTestId('schedules-row-t1')
    expect(within(row).getByText('finished')).toBeDefined()
    expect(within(row).queryByText(/^in /)).toBeNull()
  })

  it('a failed load states the reason in an alert', async () => {
    const api = fakeApi([[]])
    api.listTimers = vi.fn(async () => {
      throw new Error('the server refused the turn (500)')
    })
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
    expect(screen.queryByTestId('schedules-skeleton')).toBeNull()
  })
})

describe('SchedulesPage — load more via the cursor', () => {
  it('fetches the next page using the last row as the cursor, and appends', async () => {
    const page1 = [timer({ id: 'a0' }), timer({ id: 'a1' })]
    const page2 = [timer({ id: 'b0' })]
    const api = fakeApi([page1, page2])
    render(<SchedulesPage api={api} pageSize={2} pollMs={NEVER} />)

    await screen.findByTestId('schedules-row-a0')
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }))

    await screen.findByTestId('schedules-row-b0')
    expect(api.listTimers).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'a1', limit: 2 }))
    expect(screen.getByTestId('schedules-row-a0')).toBeDefined()
    // The second page was short: exhausted, no further Load more.
    expect(screen.queryByRole('button', { name: /^load more$/i })).toBeNull()
  })

  it('hides Load more once a page comes back shorter than the page size', async () => {
    render(<SchedulesPage api={fakeApi([[timer({ id: 'only' })]])} pageSize={2} pollMs={NEVER} />)
    await screen.findByTestId('schedules-row-only')
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })
})

describe('SchedulesPage — the controls call core and show the row it answered with', () => {
  it('Pause calls the API and the row re-renders paused, offering Resume', async () => {
    const api = fakeApi([[timer({ id: 't1' })]])
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')

    fireEvent.click(within(row).getByRole('button', { name: /^pause$/i }))
    await waitFor(() => expect(api.pauseTimer).toHaveBeenCalledWith('t1', expect.any(String)))
    await waitFor(() => expect(within(row).getByRole('button', { name: /resume/i })).toBeDefined())
    expect(within(row).getAllByText('paused').length).toBeGreaterThan(0)
    // Clicking a control never toggled the row open.
    expect(screen.queryByTestId('schedules-detail-t1')).toBeNull()
  })

  it('Resume calls the API and the row re-renders active with its next fire', async () => {
    const api = fakeApi([
      [timer({ id: 't1', paused_at: new Date().toISOString(), paused_reason: 'paused from the Schedules page' })],
    ])
    api.resumeTimer = vi.fn(async (id: string) => timer({ id, next_fire_at: inMinutes(5) }))
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')

    fireEvent.click(within(row).getByRole('button', { name: /resume/i }))
    await waitFor(() => expect(api.resumeTimer).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(within(row).getByText('active')).toBeDefined())
    expect(within(row).getByText('in 5m')).toBeDefined()
  })

  it('Run now calls fire, shows the firing core returned, and re-reads the list', async () => {
    const before = timer({ id: 't1', last_firing: null })
    const after = timer({
      id: 't1',
      last_firing: { status: 'ok', ended_at: new Date().toISOString(), reason: null },
    })
    const api = fakeApi([[before], [after]])
    api.fireTimer = vi.fn(async (id: string) => firing({ id: 'f-now', timer_id: id, status: 'ok' }))
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')

    fireEvent.click(within(row).getByRole('button', { name: /run now/i }))
    await waitFor(() => expect(api.fireTimer).toHaveBeenCalledWith('t1'))
    // The tick's own result row, in core's words...
    const note = await screen.findByTestId('ran-now')
    expect(note.textContent).toContain('ok')
    // ...and the list was re-read: the row now carries a last outcome.
    await waitFor(() => expect(api.listTimers).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(screen.getByTestId('schedules-row-t1')).getByText('ok')).toBeDefined())
  })

  it('Run now states a refused firing as refused, with core\'s reason', async () => {
    const api = fakeApi([[timer({ id: 't1', kind: 'job', title: 'nope', payload: { handler: 'nope' } })]])
    api.fireTimer = vi.fn(async (id: string) =>
      firing({ id: 'f-now', timer_id: id, status: 'refused', reason: 'no job handler named nope' }),
    )
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')
    fireEvent.click(within(row).getByRole('button', { name: /run now/i }))
    const note = await screen.findByTestId('ran-now')
    expect(note.textContent).toContain('refused')
    expect(note.textContent).toContain('no job handler named nope')
  })

  it('a control core refuses keeps the row and states the reason on it', async () => {
    const api = fakeApi([[timer({ id: 't1' })]])
    api.pauseTimer = vi.fn(async () => {
      throw new Error('timer not found (404)')
    })
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')
    fireEvent.click(within(row).getByRole('button', { name: /^pause$/i }))
    const note = await screen.findByTestId('schedules-note-t1')
    expect(note.textContent).toContain('Could not pause: timer not found (404)')
    // Still there, still active — nothing was pretended.
    expect(within(screen.getByTestId('schedules-row-t1')).getByText('active')).toBeDefined()
  })

  it('Delete confirms first — one click does not call the API; the confirm does, and the row goes', async () => {
    const api = fakeApi([[timer({ id: 't1', title: 'stretch' }), timer({ id: 't2', title: 'other' })]])
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')

    fireEvent.click(within(row).getByRole('button', { name: /delete/i }))
    expect(api.deleteTimer).not.toHaveBeenCalled()
    expect(screen.getByText('Delete “stretch”?')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /delete schedule/i }))
    await waitFor(() => expect(api.deleteTimer).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(screen.queryByTestId('schedules-row-t1')).toBeNull())
    expect(screen.getByTestId('schedules-row-t2')).toBeDefined()
  })

  it('Cancel in the confirm deletes nothing', async () => {
    const api = fakeApi([[timer({ id: 't1' })]])
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')
    fireEvent.click(within(row).getByRole('button', { name: /delete/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(api.deleteTimer).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete “stretch”?')).toBeNull()
    expect(screen.getByTestId('schedules-row-t1')).toBeDefined()
  })

  it('a job row offers Pause and Run now but no Delete — ensure_jobs would re-seed it at the next start', async () => {
    const api = fakeApi([
      [timer({ id: 'j1', kind: 'job', title: 'retention', payload: { handler: 'retention' }, created_via: 'system' })],
    ])
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-j1')
    expect(within(row).getByRole('button', { name: /^pause$/i })).toBeDefined()
    expect(within(row).getByRole('button', { name: /run now/i })).toBeDefined()
    expect(within(row).queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

describe('SchedulesPage — drill-in: firings with per-channel delivery', () => {
  it('expands a row to fetch its firings and show each channel\'s own verdict', async () => {
    const api = fakeApi([[timer({ id: 't1' })]], {
      t1: [
        firing({
          id: 'f2',
          status: 'ok',
          delivery: {
            chat: { ok: true },
            devices: [
              { name: 'laptop', ok: true },
              { name: 'phone', ok: false, reason: 'offline' },
            ],
          },
        }),
        firing({
          id: 'f1',
          status: 'error',
          reason: 'conversation was deleted',
          delivery: { chat: { ok: false, reason: 'conversation was deleted' }, devices: [] },
        }),
      ],
    })
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')
    fireEvent.click(row)

    const detail = await screen.findByTestId('schedules-detail-t1')
    const f2 = await within(detail).findByTestId('schedules-firing-f2')
    expect(api.listTimerFirings).toHaveBeenCalledWith('t1', expect.objectContaining({ limit: 50 }))
    expect(within(f2).getByText('ok')).toBeDefined()
    expect(within(f2).getByText('chat: delivered')).toBeDefined()
    expect(within(f2).getByText('device laptop: delivered')).toBeDefined()
    expect(within(f2).getByText('device phone: offline')).toBeDefined()
    expect(within(f2).getByText(/turn turn-123/)).toBeDefined()

    const f1 = within(detail).getByTestId('schedules-firing-f1')
    expect(within(f1).getByText('error')).toBeDefined()
    expect(within(f1).getByText('chat: failed — conversation was deleted')).toBeDefined()
    // Order as the server gave it: newest first.
    expect(within(detail).getAllByTestId(/^schedules-firing-/).map(el => el.getAttribute('data-testid'))).toEqual([
      'schedules-firing-f2',
      'schedules-firing-f1',
    ])
  })

  it('a reminder that found no connected device states that as a fact, not a failure', async () => {
    const api = fakeApi([[timer({ id: 't1' })]], {
      t1: [
        firing({
          id: 'f1',
          delivery: { chat: { ok: true }, devices: [], note: 'no paired device was connected' },
        }),
      ],
    })
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    fireEvent.click(await screen.findByTestId('schedules-row-t1'))
    const detail = await screen.findByTestId('schedules-detail-t1')
    await within(detail).findByText('no paired device was connected')
    expect(within(detail).queryByText(/failed/)).toBeNull()
  })

  it('shows the reminder\'s words, the zone and how it was created; a never-fired timer says so', async () => {
    const api = fakeApi([[timer({ id: 't1', payload: { message: 'stretch', device: null } })]])
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    fireEvent.click(await screen.findByTestId('schedules-row-t1'))
    const detail = await screen.findByTestId('schedules-detail-t1')
    await within(detail).findByText(/no firings yet/i)
    expect(within(detail).getByText('“stretch” — to chat and every connected device')).toBeDefined()
    expect(within(detail).getByText(/America\/New_York/)).toBeDefined()
    expect(within(detail).getByText(/via chat/)).toBeDefined()
  })

  it('collapses on a second click without re-fetching', async () => {
    const api = fakeApi([[timer({ id: 't1' })]], { t1: [firing()] })
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    const row = await screen.findByTestId('schedules-row-t1')
    fireEvent.click(row)
    await screen.findByTestId('schedules-firing-f1')
    fireEvent.click(row)
    expect(screen.queryByTestId('schedules-detail-t1')).toBeNull()
    fireEvent.click(row)
    await screen.findByTestId('schedules-firing-f1')
    expect(api.listTimerFirings).toHaveBeenCalledTimes(1)
  })

  it('pages firings by the last firing\'s id', async () => {
    const api = fakeApi([[timer({ id: 't1' })]])
    api.listTimerFirings = vi
      .fn()
      .mockResolvedValueOnce([firing({ id: 'f3' }), firing({ id: 'f2' })])
      .mockResolvedValueOnce([firing({ id: 'f1' })])
    render(<SchedulesPage api={api} pageSize={2} pollMs={NEVER} />)
    fireEvent.click(await screen.findByTestId('schedules-row-t1'))
    const detail = await screen.findByTestId('schedules-detail-t1')
    await within(detail).findByTestId('schedules-firing-f2')

    fireEvent.click(within(detail).getByRole('button', { name: /load more firings/i }))
    await within(detail).findByTestId('schedules-firing-f1')
    expect(api.listTimerFirings).toHaveBeenLastCalledWith('t1', expect.objectContaining({ before: 'f2', limit: 2 }))
    expect(within(detail).queryByRole('button', { name: /load more firings/i })).toBeNull()
  })

  it('a firings fetch that fails states the reason inside the row', async () => {
    const api = fakeApi([[timer({ id: 't1' })]])
    api.listTimerFirings = vi.fn(async () => {
      throw new Error('timer not found (404)')
    })
    render(<SchedulesPage api={api} pollMs={NEVER} />)
    fireEvent.click(await screen.findByTestId('schedules-row-t1'))
    const detail = await screen.findByTestId('schedules-detail-t1')
    await within(detail).findByText(/Could not load firings: timer not found \(404\)/)
  })
})

describe('SchedulesPage — the light poll', () => {
  it('re-reads the list on the interval, so a fired reminder\'s outcome appears with no operator action', async () => {
    const first = timer({ id: 't1', last_firing: null })
    const later = timer({
      id: 't1',
      next_fire_at: null,
      last_firing: { status: 'ok', ended_at: new Date().toISOString(), reason: null },
    })
    // The firing happens when THIS test says so — a flag, not a call count,
    // so the "never fired" assertion is never racing a 10 ms poll.
    let fired = false
    const api = fakeApi([[first]])
    api.listTimers = vi.fn(async () => (fired ? [later] : [first]))
    render(<SchedulesPage api={api} pollMs={10} />)
    const row = await screen.findByTestId('schedules-row-t1')
    expect(within(row).getByTitle('never fired')).toBeDefined()
    await waitFor(() => expect(api.listTimers.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(within(screen.getByTestId('schedules-row-t1')).getByTitle('never fired')).toBeDefined()

    fired = true
    await waitFor(() => expect(within(screen.getByTestId('schedules-row-t1')).getByText('ok')).toBeDefined())
    expect(within(screen.getByTestId('schedules-row-t1')).getByText('finished')).toBeDefined()
  })

  it('a poll whose firings re-read fails keeps the history shown and states why it may be behind', async () => {
    let broken = false
    const api = fakeApi([[timer({ id: 't1' })]])
    api.listTimerFirings = vi.fn(async () => {
      if (broken) throw new Error('timer not found (404)')
      return [firing({ id: 'f1' })]
    })
    render(<SchedulesPage api={api} pollMs={10} />)
    fireEvent.click(await screen.findByTestId('schedules-row-t1'))
    const detail = await screen.findByTestId('schedules-detail-t1')
    await within(detail).findByTestId('schedules-firing-f1')
    expect(within(detail).queryByTestId('firings-stale')).toBeNull()

    broken = true
    const stale = await within(detail).findByTestId('firings-stale')
    expect(stale.textContent).toContain('timer not found (404)')
    // The history it last knew is still there — a blip is not "no firings".
    expect(within(detail).getByTestId('schedules-firing-f1')).toBeDefined()

    // The next read that succeeds clears the statement.
    broken = false
    await waitFor(() => expect(within(detail).queryByTestId('firings-stale')).toBeNull())
  })

  it('a poll re-reads the expanded row\'s firings too, so history fills in while it is open', async () => {
    let fired = false
    const api = fakeApi([[timer({ id: 't1' })]])
    api.listTimerFirings = vi.fn(async () => (fired ? [firing({ id: 'f-new' })] : []))
    render(<SchedulesPage api={api} pollMs={10} />)
    fireEvent.click(await screen.findByTestId('schedules-row-t1'))
    const detail = await screen.findByTestId('schedules-detail-t1')
    await within(detail).findByText(/no firings yet/i)
    await waitFor(() => expect(api.listTimerFirings.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(within(detail).getByText(/no firings yet/i)).toBeDefined()

    fired = true
    await within(detail).findByTestId('schedules-firing-f-new')
  })

  it('stops polling after unmount', async () => {
    const api = fakeApi([[timer({ id: 't1' })]])
    const { unmount } = render(<SchedulesPage api={api} pollMs={10} />)
    await waitFor(() => expect(api.listTimers.mock.calls.length).toBeGreaterThanOrEqual(3))
    unmount()
    const atUnmount = api.listTimers.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(api.listTimers.mock.calls.length).toBe(atUnmount)
  })
})
