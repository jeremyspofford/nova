import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  return { id: 'c1', title: null, created_at: '', pending_turn: false, ...overrides }
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
      <ChatPage api={api} pollIntervalMs={5} maxPollMs={2000} />
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
        <ChatPage api={api} pollIntervalMs={5} maxPollMs={2000} />
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
