import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { ChatPage } from './ChatPage'
import { ChatProvider } from '../../stores/chat-store'
import type { Conversation, StoredMessage } from '../../lib/api'

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
