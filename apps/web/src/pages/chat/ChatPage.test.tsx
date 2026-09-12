import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatPage } from './ChatPage'
import { ChatProvider } from '../../stores/chat-store'
import type { ClearedConversation, Conversation, StoredMessage } from '../../lib/api'

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
    <ChatProvider fetchImpl={noopFetch}>
      <ChatPage api={api} pollIntervalMs={5} />
    </ChatProvider>,
  )
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
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={api} />
        </ChatProvider>,
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
        <ChatProvider fetchImpl={noopFetch}>
          <ChatPage api={api} pollIntervalMs={5} />
        </ChatProvider>,
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
      <ChatProvider fetchImpl={noopFetch} conversationsApi={{ clearConversation }}>
        <ChatPage api={api} pollIntervalMs={5} />
      </ChatProvider>,
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
      <ChatProvider fetchImpl={fetchImpl}>
        <ChatPage api={api} pollIntervalMs={5} idlePollMs={5} />
      </ChatProvider>,
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
      <ChatProvider fetchImpl={fetchImpl as never}>
        <ChatPage api={api} pollIntervalMs={5} />
      </ChatProvider>,
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
    const deletes: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      deletes.push(url)
      return { ok: true, status: 200, text: async () => '{"cancelled":true}' } as unknown as Response
    })
    const api = {
      getActiveConversation: vi.fn(async () =>
        conversation({
          pending_turn: true,
          pending_turn_id: 't-1',
          queued: [{ id: 'q1', conversation_id: 'c1', body: 'actually, 12b is fine', ahead: 0 }],
        }),
      ),
      getMessages: vi.fn(async () => [] as StoredMessage[]),
    }
    render(
      <ChatProvider fetchImpl={fetchImpl as never}>
        <ChatPage api={api} pollIntervalMs={5} />
      </ChatProvider>,
    )

    const chip = await waitFor(() => screen.getByTestId('queued-q1'))
    expect(chip.textContent).toContain('actually, 12b is fine')
    await act(async () => {
      fireEvent.click(screen.getByTestId('unqueue-q1'))
    })
    expect(deletes).toContain('/api/v1/chat/queued/q1')
    // 2026-09-12: this one flakes in the FULL suite and never alone — the
    // take-back is a request, a re-read and a re-render, and waitFor's default
    // second is not always enough when sixty files are sharing the machine. A
    // longer window, not a weaker assertion: the chip still has to go.
    await waitFor(() => expect(screen.queryByTestId('queued-q1')).toBeNull(), { timeout: 5000 })
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
      <ChatProvider fetchImpl={fetchImpl as never}>
        <ChatPage api={api} pollIntervalMs={5} />
      </ChatProvider>,
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

