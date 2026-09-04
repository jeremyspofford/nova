import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ActivityPage } from './ActivityPage'
import type { ActivityTurn, ActivityTurnDetail } from '../../lib/api'

function turn(overrides: Partial<ActivityTurn> = {}): ActivityTurn {
  return {
    id: 't1',
    kind: 'chat',
    model: 'qwen3:8b',
    status: 'ok',
    started_at: new Date().toISOString(),
    duration_ms: 1200,
    tool_call_count: 0,
    llm_round_count: 1,
    conversation_id: 'c1',
    ...overrides,
  }
}

function detail(overrides: Partial<ActivityTurnDetail> = {}): ActivityTurnDetail {
  return {
    turn: turn(),
    spans: [],
    ...overrides,
  }
}

function fakeApi(turns: ActivityTurn[][], details: Record<string, ActivityTurnDetail> = {}) {
  let call = 0
  return {
    getActivity: vi.fn(async () => turns[Math.min(call++, turns.length - 1)]),
    getActivityTurn: vi.fn(async (id: string) => {
      const found = details[id]
      if (!found) throw new Error(`no detail stubbed for ${id}`)
      return found
    }),
  }
}

/** A promise this test can settle whenever it wants — for pinning down
 * behaviour that depends on a fetch NOT having resolved yet. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ActivityPage — the list', () => {
  it('shows the EmptyState when there is nothing yet', async () => {
    render(<ActivityPage api={fakeApi([[]])} />)
    expect(await screen.findByText(/nothing yet/i)).toBeDefined()
  })

  it('renders a row per turn with its status badge, model and duration', async () => {
    render(
      <ActivityPage
        api={fakeApi([[turn({ id: 't1', model: 'qwen3:8b', status: 'ok', duration_ms: 482 })]])}
      />,
    )
    const row = await screen.findByTestId('activity-row-t1')
    expect(within(row).getByText('ok')).toBeDefined()
    expect(within(row).getByText('qwen3:8b')).toBeDefined()
    expect(within(row).getByText('482ms')).toBeDefined()
  })

  it('renders a NULL status as unfinished, never coerced to ok or error', async () => {
    render(<ActivityPage api={fakeApi([[turn({ id: 't1', status: null, duration_ms: null })]])} />)
    const row = await screen.findByTestId('activity-row-t1')
    expect(within(row).getByText('unfinished')).toBeDefined()
    expect(within(row).queryByText('ok')).toBeNull()
    expect(within(row).queryByText('error')).toBeNull()
  })

  it('shows a tool-call count badge only when there were any', async () => {
    render(
      <ActivityPage
        api={fakeApi([
          [turn({ id: 't1', tool_call_count: 3 }), turn({ id: 't2', tool_call_count: 0 })],
        ])}
      />,
    )
    const withTools = await screen.findByTestId('activity-row-t1')
    const withoutTools = screen.getByTestId('activity-row-t2')
    expect(within(withTools).getByTestId('tool-count-badge').textContent).toContain('3')
    expect(within(withoutTools).queryByTestId('tool-count-badge')).toBeNull()
  })

  it('renders absent duration as absent, never a fake 0ms', async () => {
    render(<ActivityPage api={fakeApi([[turn({ id: 't1', duration_ms: null, status: null })]])} />)
    const row = await screen.findByTestId('activity-row-t1')
    expect(within(row).queryByText('0ms')).toBeNull()
  })
})

describe('ActivityPage — load more via the cursor', () => {
  it('fetches the next page using the last row as the cursor, and appends', async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => turn({ id: `a${i}` }))
    const page2 = [turn({ id: 'b0' })]
    const api = fakeApi([page1, page2])
    // pageSize=2 so the fixture's 2-row first page reads as "maybe more"
    // (the real default is 50 — the component takes it as a prop
    // precisely so this boundary is testable without 50 fake rows).
    render(<ActivityPage api={api} pageSize={2} />)

    await screen.findByTestId('activity-row-a0')
    const loadMore = await screen.findByRole('button', { name: /load more/i })
    fireEvent.click(loadMore)

    await screen.findByTestId('activity-row-b0')
    expect(api.getActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: 'a1', limit: 2 }),
    )
    // Nothing already on screen disappears.
    expect(screen.getByTestId('activity-row-a0')).toBeDefined()
  })

  it('hides Load more once a page comes back shorter than the page size', async () => {
    const short = [turn({ id: 'only-one' })]
    render(<ActivityPage api={fakeApi([short])} pageSize={2} />)
    await screen.findByTestId('activity-row-only-one')
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })
})

describe('ActivityPage — drill-in', () => {
  it('expands a row to fetch and show its spans, both args_redacted shapes', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], {
      t1: detail({
        spans: [
          {
            kind: 'llm_call',
            name: 'qwen3:8b',
            started_at: new Date().toISOString(),
            duration_ms: 900,
            meta: { round: 1, model: 'qwen3:8b', prompt_tokens: 120, completion_tokens: 40 },
          },
          {
            kind: 'tool',
            name: 'workspace_write_file',
            started_at: new Date().toISOString(),
            duration_ms: 15,
            meta: {
              ok: true,
              args_redacted: { path: 'a.md', content: 'hi' },
              result_head: 'Wrote a.md (2 bytes)',
            },
          },
          {
            kind: 'tool',
            name: 'workspace_write_file',
            started_at: new Date().toISOString(),
            duration_ms: 3,
            meta: {
              ok: false,
              args_redacted: 'xxx… (+4800 more chars, 5000 total)',
              result_head: 'Error: too many keys — re-issue the call',
            },
          },
        ],
      }),
    })
    render(<ActivityPage api={api} />)

    const row = await screen.findByTestId('activity-row-t1')
    fireEvent.click(row)

    const panel = await screen.findByTestId('activity-detail-t1')
    // The panel appears the instant the row expands (loading state first);
    // wait for the fetch to actually resolve into content before asserting
    // on it, rather than racing the loading Skeleton.
    await within(panel).findByText(/round 1/i)
    expect(api.getActivityTurn).toHaveBeenCalledWith('t1')

    // llm_call: round, model, tokens, duration.
    expect(within(panel).getByText(/round 1/i)).toBeDefined()
    expect(within(panel).getByText(/120/)).toBeDefined()
    expect(within(panel).getByText(/40/)).toBeDefined()

    // tool span 1: the object shape, rendered as key:value.
    expect(within(panel).getByText(/path: a\.md/)).toBeDefined()
    expect(within(panel).getByText(/Wrote a\.md/)).toBeDefined()

    // tool span 2: the clipped-string shape, rendered verbatim.
    expect(within(panel).getByText('xxx… (+4800 more chars, 5000 total)')).toBeDefined()
    expect(within(panel).getByText(/too many keys/)).toBeDefined()
  })

  it('omits tokens entirely when the gateway did not report them, never as 0 in / 0 out', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], {
      t1: detail({
        spans: [
          {
            kind: 'llm_call',
            name: 'qwen3:8b',
            started_at: new Date().toISOString(),
            duration_ms: 900,
            // No prompt_tokens/completion_tokens — a backend that never
            // reported usage, not one that reported zero.
            meta: { round: 1, model: 'qwen3:8b' },
          },
        ],
      }),
    })
    render(<ActivityPage api={api} />)
    const row = await screen.findByTestId('activity-row-t1')
    fireEvent.click(row)

    const panel = await screen.findByTestId('activity-detail-t1')
    await within(panel).findByText(/round 1/i)
    expect(within(panel).queryByText(/in \//)).toBeNull()
    expect(within(panel).queryByText('0')).toBeNull()
  })

  it('collapses on a second click without re-fetching', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], { t1: detail() })
    render(<ActivityPage api={api} />)
    const row = await screen.findByTestId('activity-row-t1')

    fireEvent.click(row)
    await screen.findByTestId('activity-detail-t1')
    fireEvent.click(row)
    expect(screen.queryByTestId('activity-detail-t1')).toBeNull()

    fireEvent.click(row)
    await screen.findByTestId('activity-detail-t1')
    expect(api.getActivityTurn).toHaveBeenCalledTimes(1)
  })
})

describe('ActivityPage — the workspace span-path link', () => {
  it('links a workspace_write_file span whose args survived as the object shape', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], {
      t1: detail({
        spans: [
          {
            kind: 'tool',
            name: 'workspace_write_file',
            started_at: new Date().toISOString(),
            duration_ms: 15,
            meta: {
              ok: true,
              args_redacted: { path: 'lists/groceries.md', content: 'hi' },
              result_head: 'Wrote lists/groceries.md (2 bytes)',
            },
          },
        ],
      }),
    })
    render(<ActivityPage api={api} />)
    fireEvent.click(await screen.findByTestId('activity-row-t1'))
    const panel = await screen.findByTestId('activity-detail-t1')

    const link = await within(panel).findByRole('link', { name: 'lists/groceries.md' })
    expect(link.getAttribute('href')).toBe('/files?path=lists%2Fgroceries.md')
  })

  it('links a workspace_read_file span the same way', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], {
      t1: detail({
        spans: [
          {
            kind: 'tool',
            name: 'workspace_read_file',
            started_at: new Date().toISOString(),
            duration_ms: 3,
            meta: { ok: true, args_redacted: { path: 'notes.md' }, result_head: 'hi' },
          },
        ],
      }),
    })
    render(<ActivityPage api={api} />)
    fireEvent.click(await screen.findByTestId('activity-row-t1'))
    const panel = await screen.findByTestId('activity-detail-t1')
    expect(await within(panel).findByRole('link', { name: 'notes.md' })).toBeDefined()
  })

  it('renders no link when args_redacted degraded to the clipped-string shape', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], {
      t1: detail({
        spans: [
          {
            kind: 'tool',
            name: 'workspace_write_file',
            started_at: new Date().toISOString(),
            duration_ms: 3,
            meta: {
              ok: false,
              args_redacted: 'xxx… (+4800 more chars, 5000 total)',
              result_head: 'Error: too many keys — re-issue the call',
            },
          },
        ],
      }),
    })
    render(<ActivityPage api={api} />)
    fireEvent.click(await screen.findByTestId('activity-row-t1'))
    const panel = await screen.findByTestId('activity-detail-t1')
    await within(panel).findByText('xxx… (+4800 more chars, 5000 total)')
    expect(within(panel).queryByRole('link')).toBeNull()
  })

  it('renders no link for a tool that is not workspace-path-scoped', async () => {
    const api = fakeApi([[turn({ id: 't1' })]], {
      t1: detail({
        spans: [
          {
            kind: 'tool',
            name: 'get_time',
            started_at: new Date().toISOString(),
            duration_ms: 3,
            meta: { ok: true, args_redacted: {}, result_head: '14:02' },
          },
        ],
      }),
    })
    render(<ActivityPage api={api} />)
    fireEvent.click(await screen.findByTestId('activity-row-t1'))
    const panel = await screen.findByTestId('activity-detail-t1')
    await within(panel).findByText('get_time')
    expect(within(panel).queryByRole('link')).toBeNull()
  })
})

describe('ActivityPage — drill-in races', () => {
  // A row expanded and then abandoned (collapsed, or the operator jumps to
  // a different row) before its fetch resolves must not be stuck showing
  // the loading Skeleton forever the next time it is opened — the fetch
  // that would have filled it in was thrown away along with the request,
  // so re-expanding has to ask again.

  it('re-expanding a row abandoned mid-fetch retries instead of hanging forever', async () => {
    const first = deferred<ActivityTurnDetail>()
    let calls = 0
    const api = {
      getActivity: vi.fn(async () => [turn({ id: 't1' })]),
      getActivityTurn: vi.fn((_id: string) => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve(detail())
      }),
    }
    render(<ActivityPage api={api} />)
    const row = await screen.findByTestId('activity-row-t1')

    fireEvent.click(row) // expand — starts the first fetch, which never settles here
    await screen.findByTestId('activity-detail-t1')
    fireEvent.click(row) // collapse before that fetch resolves
    expect(screen.queryByTestId('activity-detail-t1')).toBeNull()

    fireEvent.click(row) // re-expand: must be a NEW request, not the abandoned one
    const panel = await screen.findByTestId('activity-detail-t1')
    await within(panel).findByText(/no spans were recorded/i)
    expect(api.getActivityTurn).toHaveBeenCalledTimes(2)

    // The first, abandoned fetch resolving late must never land on screen.
    first.resolve(
      detail({
        spans: [
          {
            kind: 'tool',
            name: 'stale-from-abandoned-fetch',
            started_at: new Date().toISOString(),
            duration_ms: 1,
            meta: {},
          },
        ],
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText('stale-from-abandoned-fetch')).toBeNull()
  })

  it('switching straight from one expanded row to another shows the second, never a stale first', async () => {
    const aFetch = deferred<ActivityTurnDetail>()
    const api = {
      getActivity: vi.fn(async () => [turn({ id: 'a' }), turn({ id: 'b' })]),
      getActivityTurn: vi.fn((id: string) => {
        if (id === 'a') return aFetch.promise
        return Promise.resolve(
          detail({
            spans: [
              {
                kind: 'tool',
                name: 'b-tool',
                started_at: new Date().toISOString(),
                duration_ms: 1,
                meta: { ok: true, result_head: 'done' },
              },
            ],
          }),
        )
      }),
    }
    render(<ActivityPage api={api} />)
    const rowA = await screen.findByTestId('activity-row-a')
    const rowB = await screen.findByTestId('activity-row-b')

    fireEvent.click(rowA) // expand A — its fetch is held open
    await screen.findByTestId('activity-detail-a')
    fireEvent.click(rowB) // straight to B, without collapsing A first

    const panelB = await screen.findByTestId('activity-detail-b')
    await within(panelB).findByText('b-tool')
    expect(screen.queryByTestId('activity-detail-a')).toBeNull()

    // A's fetch finally resolves after the switch — it must not resurrect
    // A's panel or otherwise disturb what B is now showing.
    aFetch.resolve(
      detail({
        spans: [
          {
            kind: 'tool',
            name: 'stale-a-tool',
            started_at: new Date().toISOString(),
            duration_ms: 1,
            meta: {},
          },
        ],
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByTestId('activity-detail-a')).toBeNull()
    expect(screen.queryByText('stale-a-tool')).toBeNull()
    expect(screen.getByTestId('activity-detail-b')).toBeDefined()
  })
})
