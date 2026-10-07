import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatPage } from './ChatPage'
import { ChatProvider } from '../../stores/chat-store'
import { ApiError } from '../../lib/api'
import type {
  ClearedConversation,
  Conversation,
  RewindMode,
  RewindResult,
  StoredMessage,
  StoredRewind,
} from '../../lib/api'

/**
 * The durable-turn recovery path (S2c): after a HARD REFRESH mid-reply the
 * store is gone, so ChatPage asks core whether the active conversation still
 * has a turn in flight (pending_turn) and, if so, polls until the finished
 * reply lands — then renders it, once, with no second manual refresh. Plus
 * Part C: opening the conversation lands on the newest message.
 *
 * `api` and the poll interval are injected (the same DI idiom the other
 * pages use), so these run on real timers in a few milliseconds.
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: null,
    created_at: '',
    pending_turn: false,
    pending_turn_id: null,
    queued: [],
    ...overrides,
  }
}

function stored(id: string, role: string, content: string): StoredMessage {
  return { id, role, content, created_at: '' }
}

/** A no-op streaming fetch — these tests never call sendMessage, but the
 * provider still wants a fetch seam rather than the real one. */
const noopFetch = vi.fn(
  async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '',
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    }) as unknown as Response,
)

function renderChat(api: {
  getActiveConversation: () => Promise<Conversation>
  getMessages: (id: string) => Promise<StoredMessage[]>
}) {
  return render(
    <MemoryRouter>
      <ChatProvider fetchImpl={noopFetch}>
        <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
      </ChatProvider>
    </MemoryRouter>,
  )
}

/**
 * A test's api fake, completed (S24).
 *
 * ChatPage's surface grew two methods and `getMessages` now answers
 * `{messages, threads}` — a room's reply counts ride with the transcript,
 * because they come from the same read. Every test here supplies the two it
 * cares about and this fills in the rest: `getConversationState` falls back
 * to the active conversation (no test below lands inside a room), and
 * `openThread` throws, so a test that unexpectedly opens one fails loudly
 * instead of silently navigating.
 */
function fakeApi(api: {
  getActiveConversation: () => Promise<Conversation>
  getMessages: (id: string) => Promise<StoredMessage[]>
  getConversationState?: (id: string) => Promise<Conversation>
  openThread?: (
    conversationId: string,
    messageId: string,
  ) => Promise<Conversation & { parent_message_id: string; created: boolean }>
}) {
  return {
    getActiveConversation: api.getActiveConversation,
    getMessages: async (id: string) => ({
      messages: await api.getMessages(id),
      threads: {} as Record<string, number>,
    }),
    getConversationState:
      api.getConversationState ?? (async () => api.getActiveConversation()),
    openThread:
      api.openThread ??
      (async () => {
        throw new Error('this test did not expect a room to be opened')
      }),
  } as never
}

function assistantBubbles() {
  return screen.queryAllByTestId('message-assistant')
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView; Part C calls it on a bottom
  // anchor, so give it a spy to observe.
  ;(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ChatPage — recovering a turn that finished server-side', () => {
  it('shows a responding state for an in-flight turn, then renders the full reply exactly once', async () => {
    let activeCalls = 0
    let messageCalls = 0
    const api = {
      getActiveConversation: vi.fn(async () => {
        activeCalls += 1
        // In flight at mount and on the first poll; done thereafter.
        return conversation({ pending_turn: activeCalls < 2 })
      }),
      getMessages: vi.fn(async () => {
        messageCalls += 1
        // The assistant reply has not been persisted yet at mount; it lands
        // by the time the poll fetches history again.
        return messageCalls < 2
          ? [stored('u1', 'user', 'hello')]
          : [stored('u1', 'user', 'hello'), stored('a1', 'assistant', 'the full durable reply')]
      }),
    }

    renderChat(api)

    // The subtle "still responding" line appears while polling.
    expect(await screen.findByTestId('chat-responding')).toBeDefined()

    // The finished reply arrives on its own and the responding line clears.
    const reply = await screen.findByText('the full durable reply')
    expect(reply).toBeDefined()
    await waitFor(() => expect(screen.queryByTestId('chat-responding')).toBeNull())

    // Exactly one assistant bubble — the poll resolved into the same row, it
    // did not add a second.
    expect(assistantBubbles()).toHaveLength(1)
  })

  it('renders a turn that had already completed while away, once, with no polling', async () => {
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
      getMessages: vi.fn(async () => [
        stored('u1', 'user', 'hello'),
        stored('a1', 'assistant', 'already finished'),
      ]),
    }

    renderChat(api)

    expect(await screen.findByText('already finished')).toBeDefined()
    expect(assistantBubbles()).toHaveLength(1)
    // Never entered the responding state — the turn was already done.
    expect(screen.queryByTestId('chat-responding')).toBeNull()
    // active is read once (mount); no poll loop.
    expect(api.getActiveConversation).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate bubbles across mount-load, poll, and resolve', async () => {
    let activeCalls = 0
    const api = {
      getActiveConversation: vi.fn(async () => {
        activeCalls += 1
        return conversation({ pending_turn: activeCalls < 2 })
      }),
      getMessages: vi.fn(async () => [
        stored('u1', 'user', 'hello'),
        stored('a1', 'assistant', 'the durable answer'),
      ]),
    }

    renderChat(api)

    await screen.findByText('the durable answer')
    await waitFor(() => expect(screen.queryByTestId('chat-responding')).toBeNull())

    // One user bubble and one assistant bubble — the mount load, the poll and
    // the resolve all reconcile into the same rows.
    expect(assistantBubbles()).toHaveLength(1)
    expect(screen.getAllByTestId('message-user')).toHaveLength(1)
  })
})

describe('ChatPage — a turn that ended in error shows the statement core persisted', () => {
  // The 2026-09-04 17:11 silence, from the page's side: after a reload the
  // poll ran, the turn ended 'error' with a stated failure persisted as its
  // assistant row, and the page had to render it — not go quiet. Fake timers,
  // because the turn outlives the 300 s ceiling the poll used to give up at:
  // reverting to that ceiling makes this test fail, which is the point.
  const STATEMENT =
    "I didn't get a response from qwen3.8:27b (ollama): nothing arrived from the gateway " +
    'for 300 s (its read timeout — ReadTimeout). Nothing was run. Try again, or check the ' +
    'model in Settings → Models.'
  const IN_FLIGHT_MS = 320_000

  it('keeps polling for as long as core says the turn is in flight, then renders the statement', async () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      const stillRunning = () => Date.now() - start < IN_FLIGHT_MS
      const api = {
        getActiveConversation: vi.fn(async () => conversation({ pending_turn: stillRunning() })),
        getMessages: vi.fn(async () =>
          stillRunning()
            ? [stored('u1', 'user', 'list files in my workspace directory')]
            : [
                stored('u1', 'user', 'list files in my workspace directory'),
                stored('a1', 'assistant', STATEMENT),
              ],
        ),
      }

      render(
        <MemoryRouter>
          <ChatProvider fetchImpl={noopFetch}>
            <ChatPage api={fakeApi(api)} />
          </ChatProvider>
        </MemoryRouter>,
      )
      // The mount load resolves: in flight, so the responding line is up.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByTestId('chat-responding')).toBeDefined()

      // 330 s later the turn has closed (at 320 s) and the poll has seen it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(IN_FLIGHT_MS + 10_000)
      })
      expect(screen.getByText(/nothing arrived from the gateway for 300 s/)).toBeDefined()
      expect(screen.queryByTestId('chat-responding')).toBeNull()
      expect(assistantBubbles()).toHaveLength(1)
      // It polled the whole way — never gave up and left the page quiet.
      expect(api.getActiveConversation.mock.calls.length).toBeGreaterThan(IN_FLIGHT_MS / 1500 - 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops claiming "still responding" when core cannot be read, and says so', async () => {
    // "Still responding" is a claim the page can only back while it can READ
    // pending_turn. One good read, then core goes away: after a bounded run
    // of failed checks the line must come down and the failure be stated —
    // never an indicator asserting a fact nobody can see.
    vi.useFakeTimers()
    try {
      let calls = 0
      const api = {
        getActiveConversation: vi.fn(async () => {
          calls += 1
          if (calls === 1) return conversation({ pending_turn: true })
          throw new Error('connect ECONNREFUSED')
        }),
        getMessages: vi.fn(async () => [stored('u1', 'user', 'list files in my workspace directory')]),
      }
      render(
        <MemoryRouter>
          <ChatProvider fetchImpl={noopFetch}>
            <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
          </ChatProvider>
        </MemoryRouter>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByTestId('chat-responding')).toBeDefined()

      // A few failures are tolerated — still responding, no error yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 3)
      })
      expect(screen.getByTestId('chat-responding')).toBeDefined()
      expect(screen.queryByText(/could not be reached/)).toBeNull()

      // Past the bound the claim comes down and the failure is stated.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 20)
      })
      expect(screen.queryByTestId('chat-responding')).toBeNull()
      expect(screen.getByText(/could not be reached for \d+ checks in a row/)).toBeDefined()
      expect(screen.getByText(/ECONNREFUSED/)).toBeDefined()
      // ...and it stopped polling: no unbounded retry loop behind the scenes.
      const after = api.getActiveConversation.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 20)
      })
      expect(api.getActiveConversation.mock.calls.length).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ChatPage — Clear chat button (with a light confirm)', () => {
  function renderChatWithClear(
    api: {
      getActiveConversation: () => Promise<Conversation>
      getMessages: (id: string) => Promise<StoredMessage[]>
    },
    clearConversation: (id: string) => Promise<ClearedConversation>,
  ) {
    return render(
      <MemoryRouter>
        <ChatProvider fetchImpl={noopFetch} conversationsApi={{ clearConversation }}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )
  }

  const loadedApi = {
    getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
    getMessages: vi.fn(async () => [
      stored('u1', 'user', 'hello'),
      stored('a1', 'assistant', 'a real reply'),
    ]),
  }

  it('clears the transcript on confirm — calls the API, then shows the empty state', async () => {
    const clearConversation = vi.fn(async () => ({ id: 'c1', cleared: 2 }))
    renderChatWithClear(loadedApi, clearConversation)

    // The conversation loads with two messages.
    await screen.findByText('a real reply')
    expect(assistantBubbles()).toHaveLength(1)

    // One click arms the confirm (destructive → never fires on a single click);
    // the API has not been touched yet.
    fireEvent.click(screen.getByTestId('chat-clear'))
    expect(screen.getByTestId('chat-clear-confirm')).toBeDefined()
    expect(clearConversation).not.toHaveBeenCalled()

    // Confirm actually clears.
    fireEvent.click(screen.getByTestId('chat-clear-confirm'))

    await waitFor(() => expect(clearConversation).toHaveBeenCalledWith('c1'))
    // The transcript empties and the empty state appears (UI reset only after ok).
    await screen.findByText('Nothing here yet. Say something.')
    expect(assistantBubbles()).toHaveLength(0)
  })

  it('renders the Clear control (and model selector) in the input control row, not the header', async () => {
    const clearConversation = vi.fn(async () => ({ id: 'c1', cleared: 2 }))
    renderChatWithClear(loadedApi, clearConversation)
    await screen.findByText('a real reply')

    // The Clear control now lives in the input-adjacent control row...
    const controls = screen.getByTestId('chat-controls')
    expect(within(controls).getByTestId('chat-clear')).toBeDefined()
    expect(within(controls).getByTestId('chat-model')).toBeDefined()

    // ...and the header no longer carries the Clear control or the model badge.
    const header = screen.getByTestId('chat-header')
    expect(within(header).queryByTestId('chat-clear')).toBeNull()
    expect(within(header).queryByTestId('chat-model')).toBeNull()
  })

  it('cancel dismisses the confirm without clearing anything', async () => {
    const clearConversation = vi.fn(async () => ({ id: 'c1', cleared: 2 }))
    renderChatWithClear(loadedApi, clearConversation)

    await screen.findByText('a real reply')
    fireEvent.click(screen.getByTestId('chat-clear'))
    fireEvent.click(screen.getByTestId('chat-clear-cancel'))

    expect(clearConversation).not.toHaveBeenCalled()
    // The confirm is gone and the plain Clear button is back; the transcript stays.
    expect(screen.queryByTestId('chat-clear-confirm')).toBeNull()
    expect(screen.getByTestId('chat-clear')).toBeDefined()
    expect(assistantBubbles()).toHaveLength(1)
  })
})

describe('ChatPage — Part C: opening the conversation lands on the newest message', () => {
  it('scrolls to the bottom anchor once the conversation has loaded', async () => {
    const spy = (HTMLElement.prototype as unknown as { scrollIntoView: ReturnType<typeof vi.fn> })
      .scrollIntoView
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
      getMessages: vi.fn(async () => [
        stored('u1', 'user', 'first'),
        stored('a1', 'assistant', 'last, and this should be in view'),
      ]),
    }

    renderChat(api)

    // Once the loaded rows are in the DOM, the bottom anchor is scrolled into
    // view — the fix for landing at the TOP of a returned-to conversation.
    await screen.findByText('last, and this should be in view')
    await waitFor(() => expect(spy).toHaveBeenCalled())
  })
})

describe('ChatPage — the idle poll (S9): a firing that lands while he is looking', () => {
  // A reminder's row is written by the scheduler, not streamed to this store,
  // and core never marks it in flight — so neither the live stream nor the
  // pending-turn poll can show it. The idle poll does: every idlePollMs while
  // nothing is in flight, fetch the transcript and merge what is new.
  function stored(id: string, role: string, content: string, turnKind?: string): StoredMessage {
    return { id, role, content, created_at: '', turn_kind: turnKind }
  }

  function renderIdle(
    api: {
      getActiveConversation: () => Promise<Conversation>
      getMessages: (id: string) => Promise<StoredMessage[]>
    },
    fetchImpl = noopFetch,
  ) {
    return render(
      <MemoryRouter>
        <ChatProvider fetchImpl={fetchImpl}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} idlePollMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )
  }

  it('appends a row that arrives on a later poll, labelled, exactly once — nothing already shown is duplicated', async () => {
    // The reminder lands server-side when THIS test says so — a flag rather
    // than a call count, so the assertions about the state before it are
    // never racing a 5 ms poll.
    let reminderLanded = false
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
      getMessages: vi.fn(async () => {
        const history = [
          stored('u1', 'user', 'remind me in two minutes to stretch', undefined),
          stored('a1', 'assistant', 'Done — once, Sat 6 Sep 2026 14:32 EDT (in 2 minutes).', 'chat'),
        ]
        return reminderLanded
          ? [...history, stored('r1', 'assistant', 'Reminder: stretch', 'reminder')]
          : history
      }),
    }
    renderIdle(api)

    await screen.findByText(/once, Sat 6 Sep 2026/)
    expect(assistantBubbles()).toHaveLength(1)

    // Idle polls that learn nothing change nothing.
    await waitFor(() => expect(api.getMessages.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(assistantBubbles()).toHaveLength(1)
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()

    // Now the reminder fires; the next poll brings it, with the label the
    // row's kind earns.
    reminderLanded = true
    await screen.findByText('Reminder: stretch')
    expect(screen.getByTestId('turn-kind-label').textContent).toBe('Reminder')

    // Two assistant bubbles (the confirmation and the reminder), one user
    // bubble — the rows the poll already knew were not added again.
    expect(assistantBubbles()).toHaveLength(2)
    expect(screen.getAllByTestId('message-user')).toHaveLength(1)

    // ...and staying on the page keeps it that way: later polls that learn
    // nothing new change nothing.
    const callsAfterLanding = api.getMessages.mock.calls.length
    await waitFor(() => expect(api.getMessages.mock.calls.length).toBeGreaterThan(callsAfterLanding + 1))
    expect(assistantBubbles()).toHaveLength(2)
  })

  it('does not poll while a live turn streams, and resumes once it is over', async () => {
    // A fetch whose stream never yields: the store stays `streaming` for as
    // long as this test wants it to.
    let release: () => void = () => {}
    const held = new Promise<{ done: true }>(resolve => {
      release = () => resolve({ done: true })
    })
    const hangingFetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '',
          body: { getReader: () => ({ read: () => held, cancel: async () => {} }) },
        }) as unknown as Response,
    )
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
      getMessages: vi.fn(async () => [stored('u1', 'user', 'hello'), stored('a1', 'assistant', 'hi')]),
    }
    const view = renderIdle(api, hangingFetch)
    await screen.findByText('hi')

    // Idle: the poll is running.
    await waitFor(() => expect(api.getMessages.mock.calls.length).toBeGreaterThanOrEqual(3))

    // The owner sends: the store streams, and the poll must stop.
    const textarea = screen.getByLabelText('Message Nova')
    fireEvent.change(textarea, { target: { value: 'and now?' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() =>
      expect(view.getByTestId('chat-page').getAttribute('data-streaming')).toBe('true'),
    )
    const callsWhenStreamingBegan = api.getMessages.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 50))
    // Allowing for one tick that was already scheduled when the send landed.
    expect(api.getMessages.mock.calls.length).toBeLessThanOrEqual(callsWhenStreamingBegan + 1)

    // The turn ends (the stream closes): polling resumes.
    release()
    await waitFor(() =>
      expect(view.getByTestId('chat-page').getAttribute('data-streaming')).toBe('false'),
    )
    const callsAfterTurn = api.getMessages.mock.calls.length
    await waitFor(() => expect(api.getMessages.mock.calls.length).toBeGreaterThan(callsAfterTurn + 1))
  })

  it('stops polling on unmount — the interval is cleared', async () => {
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
      getMessages: vi.fn(async () => [stored('u1', 'user', 'hello'), stored('a1', 'assistant', 'hi')]),
    }
    const { unmount } = renderIdle(api)
    await waitFor(() => expect(api.getMessages.mock.calls.length).toBeGreaterThanOrEqual(3))
    unmount()
    const atUnmount = api.getMessages.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(api.getMessages.mock.calls.length).toBe(atUnmount)
  })
})

/**
 * The queue (S15). The composer used to go dead while Nova worked. Now it stays
 * live, what the owner sends is shown as accepted, and the list comes from the
 * server on every poll tick — because the server is what runs them.
 */
describe('ChatPage — messages waiting their turn', () => {
  it('keeps the composer live while a turn runs, and says the next one will queue', async () => {
    // A stream that never finishes: the turn stays in flight, which is exactly
    // the state in which the composer used to be dead.
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '',
          body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
        }) as unknown as Response,
    )
    const api = {
      getActiveConversation: vi.fn(async () => conversation()),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    render(
      <MemoryRouter>
        <ChatProvider fetchImpl={fetchImpl as never}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )
    const textarea = await waitFor(() => screen.getByLabelText('Message Nova'))
    fireEvent.change(textarea, { target: { value: 'pull gemma4:26b' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('will-queue')).toBeDefined())
    // Still typable, and the send control is live for a second message.
    expect(textarea.hasAttribute('disabled')).toBe(false)
    fireEvent.change(textarea, { target: { value: 'actually, 12b' } })
    expect(screen.getByLabelText('Queue message').hasAttribute('disabled')).toBe(false)
  })

  it('shows what the server says is waiting, and takes one back on request', async () => {
    // The server stops listing a message once it has been taken back —
    // so the fake does too. It used to keep returning q1 forever, which
    // made the assertion below a RACE: the click removed the chip locally
    // and the next poll (5 ms later) put it straight back from a server
    // still insisting it was queued. That reddened roughly one full-suite
    // run in four and never failed alone, because alone the assertion won
    // the race. The neighbouring 'clears a chip once the server says the
    // message has run' test already models the server this way.
    let waiting = [{ id: 'q1', conversation_id: 'c1', body: 'actually, 12b is fine', ahead: 0 }]
    const deletes: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      deletes.push(url)
      if (url.endsWith('/q1')) waiting = []
      return { ok: true, status: 200, text: async () => '{"cancelled":true}' } as unknown as Response
    })
    const api = {
      getActiveConversation: vi.fn(async () =>
        conversation({
          pending_turn: true,
          pending_turn_id: 't-1',
          queued: waiting,
        }),
      ),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    render(
      <MemoryRouter>
        <ChatProvider fetchImpl={fetchImpl as never}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    const chip = await waitFor(() => screen.getByTestId('queued-q1'))
    expect(chip.textContent).toContain('actually, 12b is fine')
    await act(async () => {
      fireEvent.click(screen.getByTestId('unqueue-q1'))
    })
    expect(deletes).toContain('/api/v1/chat/queued/q1')
    // The chip goes and STAYS gone, because the server has stopped listing
    // it. No window to tune: there is nothing left to race.
    await waitFor(() => expect(screen.queryByTestId('queued-q1')).toBeNull())
  })

  it('clears a chip once the server says the message has run', async () => {
    // Nothing is streaming here: the queued message became a turn server-side
    // and this tab is not reading it. Without a watch the chip would sit there
    // saying a message is still waiting that has already been answered.
    let waiting = [{ id: 'q1', conversation_id: 'c1', body: 'the second thing', ahead: 0 }]
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ queued: waiting })),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    renderChat(api)
    await waitFor(() => expect(screen.getByTestId('queued-q1')).toBeDefined())

    waiting = []
    await waitFor(() => expect(screen.queryByTestId('queued-q1')).toBeNull(), { timeout: 2000 })
  })

  it('shows nothing when nothing is waiting', async () => {
    const api = {
      getActiveConversation: vi.fn(async () => conversation()),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    renderChat(api)
    await waitFor(() => expect(api.getMessages).toHaveBeenCalled())
    expect(screen.queryByTestId('queued-list')).toBeNull()
  })
})

/**
 * Stop (S15). Two paths have to reach it, and the second is the one that
 * matters most: a tab that RELOADED into a running turn has no meta frame and
 * so no turn id of its own. It learns the id from /conversations/active, which
 * is why "still responding" is now something you can act on rather than only
 * watch.
 */
describe('ChatPage — stopping the turn', () => {
  it('offers no stop when nothing is running', async () => {
    renderChat({
      getActiveConversation: vi.fn(async () => conversation()),
      getMessages: vi.fn(async () => []),
    })
    await waitFor(() => expect(screen.getByLabelText('Message Nova')).toBeDefined())
    expect(screen.queryByTestId('stop-turn')).toBeNull()
  })

  it('offers a stop over a turn this tab reloaded into, and asks core for THAT turn', async () => {
    const stops: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      stops.push(url)
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response
    })
    const api = {
      // Still running at mount, and still running on every poll — the hang.
      getActiveConversation: vi.fn(async () =>
        conversation({ pending_turn: true, pending_turn_id: 't-hung' }),
      ),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    render(
      <MemoryRouter>
        <ChatProvider fetchImpl={fetchImpl as never}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    const stop = await waitFor(() => screen.getByTestId('stop-turn'))
    expect(screen.getByTestId('chat-responding')).toBeDefined()
    await act(async () => {
      fireEvent.click(stop)
    })
    expect(stops).toContain('/api/v1/chat/turns/t-hung/stop')
  })
})

/**
 * The draft (S15). ChatPage is a route element, so navigating to Settings and
 * back unmounts it — this is the wiring that keeps the unsent text, keyed on
 * the conversation the page actually resolved.
 */
describe('ChatPage — the composer keeps an unsent draft', () => {
  const api = {
    getActiveConversation: vi.fn(async () => conversation({ id: 'c-draft' })),
    getMessages: vi.fn(async () => [] as StoredMessage[]),
  }

  it('restores what was typed after the page is unmounted and mounted again', async () => {
    const { unmount } = renderChat(api)
    await waitFor(() => expect(screen.getByLabelText('Message Nova')).toBeDefined())
    fireEvent.change(screen.getByLabelText('Message Nova'), {
      target: { value: 'can you pull gemma4:26b' },
    })
    unmount()

    renderChat(api)
    await waitFor(() =>
      expect((screen.getByLabelText('Message Nova') as HTMLTextAreaElement).value).toBe(
        'can you pull gemma4:26b',
      ),
    )
  })

  it('keys the draft on the conversation, so another conversation opens empty', async () => {
    const { unmount } = renderChat(api)
    await waitFor(() => expect(screen.getByLabelText('Message Nova')).toBeDefined())
    fireEvent.change(screen.getByLabelText('Message Nova'), { target: { value: 'for c-draft' } })
    unmount()

    const other = {
      getActiveConversation: vi.fn(async () => conversation({ id: 'c-other' })),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    renderChat(other)
    await waitFor(() => expect(other.getMessages).toHaveBeenCalled())
    expect((screen.getByLabelText('Message Nova') as HTMLTextAreaElement).value).toBe('')
  })
})


/**
 * S24 — a room is a URL.
 *
 * `/chat?thread=<conversation-id>`: a query parameter on the existing route
 * rather than a new path, because a new path would re-break the three
 * 2026-09-15 phone fixes on arrival (the fullWidth layout, the Chat
 * highlight, the composer's bottom padding), all of which hold by
 * construction on `/chat`.
 */
describe('ChatPage — rooms', () => {
  const room: Conversation = {
    id: 'room-1',
    title: null,
    created_at: '',
    pending_turn: false,
    pending_turn_id: null,
    queued: [],
    parent_message_id: 'a1',
  }

  function api(overrides: Record<string, unknown> = {}) {
    return {
      getActiveConversation: vi.fn(async () => conversation()),
      getMessages: vi.fn(async () => [
        stored('u1', 'user', 'morning'),
        stored('a1', 'assistant', 'Two timers have failed.'),
      ]),
      ...overrides,
    }
  }

  it('draws a stub under a message that offers a room, and none under one that does not', async () => {
    const fake = api({
      getMessages: vi.fn(async () => ({
        messages: [stored('u1', 'user', 'morning'), stored('a1', 'assistant', 'Two timers have failed.')],
        threads: { a1: 0 },
      })),
    })
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fake as never} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    const stubs = await screen.findAllByTestId('thread-stub')
    expect(stubs).toHaveLength(1)
    // 0 replies reads as an invitation, not as a count of nothing: the room
    // is opened on the first tap.
    expect(stubs[0].textContent).toContain('Talk about this')
  })

  it('a stub with replies says how many, and never previews the newest one', async () => {
    // A count, because previewing the latest reply would put a room's
    // content back in the hallway — exactly the interleaving rooms remove.
    const fake = api({
      getMessages: vi.fn(async () => ({
        messages: [stored('a1', 'assistant', 'Two timers have failed.')],
        threads: { a1: 3 },
      })),
    })
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fake as never} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    const stub = await screen.findByTestId('thread-stub')
    expect(stub.textContent).toContain('3 replies')
  })

  it('opening a stub navigates to the room it made', async () => {
    const openThread = vi.fn(async () => ({ ...room, created: true }))
    const getConversationState = vi.fn(async () => room)
    const fake = api({
      getMessages: vi.fn(async (id: string) =>
        id === 'room-1'
          ? { messages: [stored('r1', 'user', 'which one?')], threads: {} }
          : {
              messages: [stored('a1', 'assistant', 'Two timers have failed.')],
              threads: { a1: 0 },
            },
      ),
      openThread,
      getConversationState,
    })
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fake as never} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTestId('thread-stub'))

    await waitFor(() => expect(openThread).toHaveBeenCalledWith('c1', 'a1'))
    // And the page is now showing the ROOM, with its own way out.
    expect(await screen.findByTestId('thread-header')).toBeTruthy()
    await waitFor(() => expect(getConversationState).toHaveBeenCalledWith('room-1'))
  })

  it('a room the URL names loads without going through the hallway', async () => {
    // What a relaunch inside a room does, and what makes the iOS back
    // gesture the OS back.
    const getConversationState = vi.fn(async () => room)
    const fake = api({
      getConversationState,
      getMessages: vi.fn(async () => ({
        messages: [stored('r1', 'user', 'which one?')],
        threads: {},
      })),
    })
    render(
      <MemoryRouter initialEntries={['/chat?thread=room-1']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fake as never} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('thread-header')).toBeTruthy()
    expect(getConversationState).toHaveBeenCalledWith('room-1')
    expect(fake.getActiveConversation).not.toHaveBeenCalled()
  })

  it('a room shows no stubs of its own — rooms off rooms are a filing system', async () => {
    const fake = api({
      getConversationState: vi.fn(async () => room),
      getMessages: vi.fn(async () => ({
        messages: [stored('r1', 'assistant', 'the 7am backup')],
        threads: { r1: 2 },
      })),
    })
    render(
      <MemoryRouter initialEntries={['/chat?thread=room-1']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fake as never} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    await screen.findByTestId('thread-header')
    expect(screen.queryByTestId('thread-stub')).toBeNull()
  })

  it('falls back to the hallway when the room the URL names is gone', async () => {
    // Cleared from another device. Falling back beats stranding the page on
    // an error: the hallway always exists.
    const fake = api({
      getConversationState: vi.fn(async () => {
        throw new Error('no conversation room-1 here')
      }),
      getMessages: vi.fn(async () => ({
        messages: [stored('a1', 'assistant', 'Two timers have failed.')],
        threads: {},
      })),
    })
    render(
      <MemoryRouter initialEntries={['/chat?thread=room-1']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fake as never} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Two timers have failed.')).toBeTruthy()
    expect(fake.getActiveConversation).toHaveBeenCalled()
  })

  it('the hallway has no room header at all', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={fakeApi(api())} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Two timers have failed.')
    expect(screen.queryByTestId('thread-header')).toBeNull()
  })
})

/**
 * Up-arrow recall (chat rewind T6): ChatPage hands the composer his live user
 * messages from what it loaded — never an assistant row, never a rewind
 * marker (a role='user' row core composed, carrying `rewind`) — and a message
 * just sent is recallable on the next ArrowUp.
 */
describe('ChatPage — up-arrow recall reads his sent messages', () => {
  function marker(id: string): StoredMessage {
    return {
      ...stored(id, 'user', 'The owner rewound this conversation to "first ask".'),
      rewind: {
        id: 'r1',
        mode: 'chat',
        target_message_id: 'u1',
        withdrawn: 2,
        undone: [],
        not_undone: [],
      },
    }
  }

  it('recalls his loaded user rows newest first, skipping replies and the rewind marker', async () => {
    const api = {
      getActiveConversation: vi.fn(async () => conversation()),
      getMessages: vi.fn(async () => [
        stored('u1', 'user', 'first ask'),
        stored('a1', 'assistant', 'first answer'),
        stored('u2', 'user', 'second ask'),
        stored('a2', 'assistant', 'second answer'),
        marker('m1'),
      ]),
    }
    renderChat(api)
    await screen.findByText('second answer')
    const textarea = screen.getByLabelText('Message Nova') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('second ask')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('first ask')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('first ask')
  })

  it('a message just sent is recallable on the next ArrowUp', async () => {
    // A stream that never finishes, so the sent row stays exactly as sent.
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '',
          body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
        }) as unknown as Response,
    )
    const api = {
      getActiveConversation: vi.fn(async () => conversation()),
      getMessages: vi.fn(async () => [stored('u1', 'user', 'an older ask')]),
    }
    render(
      <MemoryRouter>
        <ChatProvider fetchImpl={fetchImpl as never}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )
    await screen.findByText('an older ask')
    const textarea = screen.getByLabelText('Message Nova') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'list my timers' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('list my timers')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('an older ask')
  })
})

/**
 * Chat rewind (T7): a Rewind control on each of his stored messages, a
 * two-option choice, core's result shown after the transcript reloads, and a
 * refusal that changes nothing. `api.rewind` is injected beside the rest.
 */
describe('ChatPage — rewinding to one of his messages (chat rewind T7)', () => {
  const U1 = '0b6f8f1e-0000-4000-8000-0000000000a1'
  const A1 = '0b6f8f1e-0000-4000-8000-0000000000b1'
  const U2 = '0b6f8f1e-0000-4000-8000-0000000000a2'
  const A2 = '0b6f8f1e-0000-4000-8000-0000000000b2'
  const M1 = '0b6f8f1e-0000-4000-8000-0000000000c1'

  const before = () => [
    stored(U1, 'user', 'first ask'),
    stored(A1, 'assistant', 'first answer'),
    stored(U2, 'user', 'second ask'),
    stored(A2, 'assistant', 'second answer'),
  ]

  function markerRow(rewind: Partial<StoredRewind> = {}): StoredMessage {
    return {
      ...stored(M1, 'user', '(the marker core composed)'),
      rewind: {
        id: 'r1',
        mode: 'chat',
        target_message_id: U1,
        withdrawn: 3,
        undone: [],
        not_undone: [],
        ...rewind,
      },
    }
  }

  function result(overrides: Partial<RewindResult> = {}): RewindResult {
    return {
      rewind_id: 'r1',
      marker_message_id: M1,
      mode: 'chat',
      withdrawn: 3,
      undone: [],
      not_undone: [],
      ...overrides,
    }
  }

  /** The page wired to fakes: `before()` on the first load, `after` on every
   *  load after it (the reload a rewind does). */
  function renderRewind({
    after = [stored(U1, 'user', 'first ask'), stored(A1, 'assistant', 'first answer'), markerRow()],
    rewind = vi.fn(async (_c: string, _m: string, mode: RewindMode) => result({ mode })),
    active = conversation(),
    fetchImpl = noopFetch,
    entries = ['/chat'],
  }: {
    after?: StoredMessage[]
    rewind?: (c: string, m: string, mode: RewindMode) => Promise<RewindResult>
    active?: Conversation
    fetchImpl?: unknown
    entries?: string[]
  } = {}) {
    let loads = 0
    const fake = {
      getActiveConversation: vi.fn(async () => active),
      getConversationState: vi.fn(async () => active),
      getMessages: vi.fn(async () => {
        loads += 1
        return { messages: loads === 1 ? before() : after, threads: {} }
      }),
      openThread: vi.fn(async () => {
        throw new Error('this test did not expect a room to be opened')
      }),
      rewind: vi.fn(rewind),
    }
    render(
      <MemoryRouter initialEntries={entries}>
        <ChatProvider fetchImpl={fetchImpl as never}>
          <ChatPage api={fake as never} pollIntervalMs={5} idlePollMs={60_000} />
        </ChatProvider>
      </MemoryRouter>,
    )
    return fake
  }

  function bubble(id: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    expect(el, `the bubble for ${id}`).not.toBeNull()
    return el!
  }
  function rewindIn(id: string): HTMLButtonElement | null {
    return within(bubble(id)).queryByRole('button', { name: /rewind/i }) as HTMLButtonElement | null
  }
  function mustRewindIn(id: string): HTMLButtonElement {
    const button = rewindIn(id)
    expect(button, `a Rewind button on ${id}`).not.toBeNull()
    return button!
  }
  async function choose(id: string, mode: RewindMode) {
    fireEvent.click(mustRewindIn(id))
    await act(async () => {
      fireEvent.click(screen.getByTestId(`rewind-option-${mode}`))
    })
  }

  it('every loaded message of his offers Rewind; her replies and the marker offer none', async () => {
    renderRewind()
    await screen.findByText('second answer')
    const all = screen.queryAllByRole('button', { name: /rewind/i })
    expect(all).toHaveLength(2)
    expect(rewindIn(U1)).not.toBeNull()
    expect(rewindIn(U2)).not.toBeNull()
    expect(rewindIn(A1)).toBeNull()
    expect(rewindIn(A2)).toBeNull()
  })

  it('a message just sent offers no Rewind until a reload gives it its server id', async () => {
    const neverEnds = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '',
          body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
        }) as unknown as Response,
    )
    renderRewind({ fetchImpl: neverEnds })
    await screen.findByText('second answer')
    const textarea = screen.getByLabelText('Message Nova') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'list my timers' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    const sent = (await screen.findByText('list my timers')).closest<HTMLElement>('[data-testid="message-user"]')!
    // His stored rows still offer one (disabled under the running turn)...
    expect(screen.queryAllByRole('button', { name: /rewind/i })).toHaveLength(2)
    // ...the client-id row does not: core has never heard of that id.
    expect(within(sent).queryByRole('button', { name: /rewind/i })).toBeNull()
  })

  it('"chat only" calls core once with that message and mode, reloads, and shows the result without an undo section', async () => {
    const fake = renderRewind()
    await screen.findByText('second answer')
    await choose(U1, 'chat')

    expect(fake.rewind).toHaveBeenCalledTimes(1)
    expect(fake.rewind).toHaveBeenCalledWith('c1', U1, 'chat')
    // The transcript reloads from core: the withdrawn rows leave, the marker arrives.
    await waitFor(() => expect(screen.queryByText('second ask')).toBeNull())
    expect(screen.queryByText('second answer')).toBeNull()
    expect(fake.getMessages).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('rewind-marker')).toBeDefined()
    const panel = await screen.findByTestId('rewind-result')
    expect(panel.textContent).toContain('3')
    expect(within(panel).queryByTestId('rewind-undone')).toBeNull()
    expect(within(panel).queryByTestId('rewind-not-undone')).toBeNull()
  })

  it('"chat + her executions" shows each undone action (tool + line) and each not-undone one (tool or "unknown" + reason)', async () => {
    const fake = renderRewind({
      after: [stored(U1, 'user', 'first ask'), markerRow({ mode: 'executions' })],
      rewind: async () =>
        result({
          mode: 'executions',
          undone: [{ tool: 'workspace_write_file', action_id: 'x1', line: 'restored notes.md to its prior bytes' }],
          not_undone: [
            { tool: 'device_run', action_id: 'x2', reason: 'a command already run on a device cannot be taken back' },
            { tool: null, turn_id: 't9', reason: 'that turn never closed; its actions were not recorded' },
          ],
        }),
    })
    await screen.findByText('second answer')
    await choose(U2, 'executions')

    expect(fake.rewind).toHaveBeenCalledWith('c1', U2, 'executions')
    const panel = await screen.findByTestId('rewind-result')
    const undone = within(panel).getByTestId('rewind-undone')
    expect(undone.textContent).toContain('workspace_write_file')
    expect(undone.textContent).toContain('restored notes.md to its prior bytes')
    const notUndone = within(panel).getByTestId('rewind-not-undone')
    expect(notUndone.textContent).toContain('device_run')
    expect(notUndone.textContent).toContain('a command already run on a device cannot be taken back')
    expect(notUndone.textContent).toContain('unknown')
    expect(notUndone.textContent).toContain('that turn never closed; its actions were not recorded')
  })

  it('"chat + her executions" that undid and listed nothing says "nothing to undo"', async () => {
    renderRewind({ after: [stored(U1, 'user', 'first ask'), markerRow({ mode: 'executions' })] })
    await screen.findByText('second answer')
    await choose(U1, 'executions')
    const panel = await screen.findByTestId('rewind-result')
    expect(panel.textContent).toMatch(/nothing to undo/i)
  })

  it('a refused rewind shows core\'s stated reason and changes the transcript not at all', async () => {
    const reason = 'a turn is still running in this conversation; rewind when it ends'
    const fake = renderRewind({
      rewind: async () => {
        throw new ApiError(409, reason)
      },
    })
    await screen.findByText('second answer')
    await choose(U1, 'chat')

    await waitFor(() => expect(screen.getByTestId('chat-page').textContent).toContain(reason))
    // No reload-as-success and no optimistic removal.
    expect(fake.getMessages).toHaveBeenCalledTimes(1)
    expect(screen.getByText('second ask')).toBeDefined()
    expect(screen.getByText('second answer')).toBeDefined()
    expect(screen.queryByTestId('rewind-result')).toBeNull()
    expect(screen.queryByTestId('rewind-marker')).toBeNull()
  })

  it('while this tab streams a turn, every Rewind control is disabled', async () => {
    const neverEnds = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '',
          body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
        }) as unknown as Response,
    )
    renderRewind({ fetchImpl: neverEnds })
    await screen.findByText('second answer')
    expect(mustRewindIn(U1).disabled).toBe(false)
    const textarea = screen.getByLabelText('Message Nova') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'list my timers' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('chat-page').dataset.streaming).toBe('true'))
    expect(mustRewindIn(U1).disabled).toBe(true)
    expect(mustRewindIn(U2).disabled).toBe(true)
  })

  it('while a turn this tab reloaded into is still responding, every Rewind control is disabled', async () => {
    renderRewind({ active: conversation({ pending_turn: true, pending_turn_id: 't-running' }) })
    await screen.findByTestId('chat-responding')
    await screen.findByText('second answer')
    expect(mustRewindIn(U1).disabled).toBe(true)
    expect(mustRewindIn(U2).disabled).toBe(true)
  })

  it('the result stays until he dismisses it; the divider keeps the facts after', async () => {
    renderRewind()
    await screen.findByText('second answer')
    await choose(U1, 'chat')
    await screen.findByTestId('rewind-result')
    fireEvent.click(screen.getByTestId('rewind-result-dismiss'))
    expect(screen.queryByTestId('rewind-result')).toBeNull()
    expect(screen.getByTestId('rewind-marker')).toBeDefined()
  })

  it('a room offers no Rewind, though the hallway does', async () => {
    const room: Conversation = { ...conversation({ id: 'room-1' }), parent_message_id: A1 }
    // The hallway first, as a positive control...
    renderRewind()
    await screen.findByText('second answer')
    expect(screen.queryAllByRole('button', { name: /rewind/i })).toHaveLength(2)
    cleanup()
    // ...then the same rows inside a room.
    renderRewind({ active: room, entries: ['/chat?thread=room-1'] })
    await screen.findByTestId('thread-header')
    await screen.findByText('second answer')
    expect(screen.queryAllByRole('button', { name: /rewind/i })).toHaveLength(0)
  })

  it('"chat only" states no undo facts at all, not even "nothing to undo", in the panel or the divider', async () => {
    renderRewind()
    await screen.findByText('second answer')
    await choose(U1, 'chat')
    const panel = await screen.findByTestId('rewind-result')
    expect(panel.textContent).not.toMatch(/nothing to undo/i)
    expect(screen.getByTestId('rewind-marker').textContent).not.toMatch(/nothing to undo/i)
  })

  it('a rewind that ran but whose reload failed says so with the reason, and still states what core did', async () => {
    const fake = renderRewind()
    await screen.findByText('second answer')
    fake.getMessages.mockImplementation(async () => {
      throw new ApiError(502, 'core did not answer the messages read')
    })
    await choose(U1, 'chat')

    // Core DID rewind: its result is shown, never hidden behind the failure...
    await screen.findByTestId('rewind-result')
    expect(fake.rewind).toHaveBeenCalledTimes(1)
    expect(fake.getMessages).toHaveBeenCalledTimes(2)
    // ...and the failed reload is stated, with its reason — a stale
    // transcript must never read as the reloaded one.
    const page = screen.getByTestId('chat-page')
    await waitFor(() => expect(page.textContent).toContain('core did not answer the messages read'))
    expect(page.textContent).toMatch(/could not be reloaded/i)
    expect(page.textContent).not.toMatch(/Rewind refused/i)
  })
})

/**
 * A setup card keeps its command (card-keeps-commands T1). Her machine card's
 * code and per-OS commands reach this tab once, on the live stream; core's
 * GET .../messages redraws the card with neither (the code is a credential and
 * is never stored). The owner watched the command vanish about 15 s after her
 * reply, the first idle poll, with "No command:" in its place.
 */
describe('ChatPage — a setup card this tab streamed keeps its command', () => {
  const ORIGIN = 'https://nova.example.com'
  const CODE = 'WXYZ2345'

  /** A chat stream that sends exactly these frames, then [DONE]. */
  function streamOf(frames: unknown[]) {
    const bytes = new TextEncoder().encode(
      [...frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(''),
    )
    return vi.fn(async () => {
      let sent = false
      return {
        ok: true,
        status: 200,
        text: async () => '',
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: bytes }
            },
            cancel: async () => {},
          }),
        },
      } as unknown as Response
    })
  }

  it('still shows the code and the command for its OS after three idle polls bring core\'s code-less redraw', async () => {
    // SetupPanel hides the command once expires_at is past by the real clock;
    // core states it as Postgres' isoformat, microseconds and all.
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString().replace(/Z$/, '000+00:00')
    // Every line carries the code, as core fills it.
    const commands = {
      linux: `curl -fsSL -o novad ${ORIGIN}/api/v1/agent/dist/novad-linux-amd64 && ./novad install --hub ${ORIGIN} --code ${CODE}`,
      macos: `curl -fsSL -o novad ${ORIGIN}/api/v1/agent/dist/novad-darwin-arm64 && ./novad install --hub ${ORIGIN} --code ${CODE}`,
      windows: `curl.exe -fsSL -o novad.exe ${ORIGIN}/api/v1/agent/dist/novad-windows-amd64.exe; ./novad.exe install --hub ${ORIGIN} --code ${CODE}`,
    }
    const walks = {
      linux: 'Linux: walked on real hardware',
      macos: 'macOS: built and tested in CI, not walked on a Mac',
      windows: 'Windows: walked on real hardware',
    }
    const live = {
      kind: 'setup_qr',
      setup: 'add_machine',
      address: ORIGIN,
      url: `${ORIGIN}/add#${CODE}`,
      code: CODE,
      expires_at: expiresAt,
      machine: 'EXAMPLE-DESKTOP',
      for_os: 'windows',
      commands,
      walks,
      notes: { linux: 'The Linux note.', macos: 'The macOS note.', windows: 'The Windows note.' },
      version: '0.0.0-example',
    }
    // services/core/app/conversations.py _card_json: no code, commands, walks, notes or version.
    const redrawn = {
      kind: 'setup_qr' as const,
      setup: 'add_machine',
      address: ORIGIN,
      url: `${ORIGIN}/add`,
      code_shown: true,
      expires_at: expiresAt,
      machine: 'EXAMPLE-DESKTOP',
      for_os: 'windows',
      walk: walks.windows,
    }
    // Core holds the turn only once the stream has ended: before that every
    // read is the empty conversation. A flag, as the reminder test does: an
    // idle poll that merged the turn's rows before the send would show it twice.
    let persisted = false
    const api = {
      getActiveConversation: vi.fn(async () => conversation({ pending_turn: false })),
      getMessages: vi.fn(
        async (): Promise<StoredMessage[]> =>
          persisted
            ? [
                { id: 'srv-u1', role: 'user', content: 're-pair my desktop', created_at: '', served_by: null, cards: [] },
                {
                  id: 'srv-a1',
                  role: 'assistant',
                  content: 'Here is the card for EXAMPLE-DESKTOP.',
                  created_at: '',
                  turn_kind: 'chat',
                  served_by: 'ollama:qwen3:8b',
                  cards: [redrawn],
                },
              ]
            : [],
      ),
    }
    const fetchImpl = streamOf([
      // The loaded conversation's id, or S24 drops every later frame.
      { meta: { conversation_id: 'c1', model: 'qwen3:8b', turn_id: 't1' } },
      { t: 'Here is the card for EXAMPLE-DESKTOP.' },
      { card: live },
    ])
    render(
      <MemoryRouter>
        <ChatProvider fetchImpl={fetchImpl as never}>
          <ChatPage api={fakeApi(api)} pollIntervalMs={5} idlePollMs={5} />
        </ChatProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Nothing here yet. Say something.')
    const textarea = screen.getByLabelText('Message Nova')
    fireEvent.change(textarea, { target: { value: 're-pair my desktop' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await screen.findByTestId('setup-code')
    await waitFor(() => expect(screen.getByTestId('chat-page').getAttribute('data-streaming')).toBe('false'))

    /** What the card shows: its code, the Windows line (for_os opens that tab), and any "No command:". */
    const shown = () => {
      const panel = screen.getByTestId('setup-panel')
      return {
        code: within(panel).queryByTestId('setup-code')?.textContent ?? null,
        command: within(panel).queryByText(commands.windows) !== null,
        noCommand: screen.queryAllByText(/No command:/).length,
      }
    }
    const whole = { code: 'WXYZ-2345', command: true, noCommand: 0 }

    // Once the stream ends.
    expect(shown()).toEqual(whole)

    // Core has written the turn: every idle poll from here brings its redraw.
    persisted = true
    const atPersist = api.getMessages.mock.calls.length
    // The first such poll re-keys the rows, so the bubble remounts under its
    // server id (queried afresh below, never held from before)...
    await waitFor(() => expect(document.querySelector('[data-message-id="srv-a1"]')).not.toBeNull())
    // ...and at least two more polls follow it.
    await waitFor(() => expect(api.getMessages.mock.calls.length).toBeGreaterThanOrEqual(atPersist + 4))

    expect(assistantBubbles()).toHaveLength(1)
    expect(shown()).toEqual(whole)
  })
})
