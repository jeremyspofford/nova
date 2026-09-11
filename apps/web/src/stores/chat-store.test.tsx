import { describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { ChatProvider, useChatStore } from './chat-store'
import type { ChatState } from '../pages/chat/chatReducer'

/**
 * The nav bug: the SSE stream used to be owned by ChatPage, so navigating
 * away unmounted it and aborted the fetch — the server correctly read that
 * as a disconnect and cancelled generation. The fix lifts ownership into
 * this store, mounted at the authenticated-routes boundary (above the
 * /chat <-> /settings swap, so it survives that navigation), so a page
 * unmounting can never touch the request. (S1 carries #9, ruling S2-R4.)
 *
 * The first block of tests below drives a hand-controlled ReadableStream
 * reader so a chunk can be pushed AFTER the consumer that called
 * sendMessage has unmounted — proving the fetch and the accumulation both
 * keep going regardless. The second block (further down) proves the other
 * side of the same boundary: the store must NOT survive a change of who is
 * signed in, so a stream started by one person can never write into a
 * transcript another person is now looking at.
 */

function controlledStream() {
  const encoder = new TextEncoder()
  type Chunk = { done: boolean; value?: Uint8Array }
  const queue: Chunk[] = []
  let waiting: ((c: Chunk) => void) | null = null

  function deliver(chunk: Chunk) {
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve(chunk)
    } else {
      queue.push(chunk)
    }
  }

  return {
    push(text: string) {
      deliver({ done: false, value: encoder.encode(text) })
    },
    end() {
      deliver({ done: true, value: undefined })
    },
    reader: {
      read(): Promise<Chunk> {
        return new Promise(resolve => {
          const next = queue.shift()
          if (next) resolve(next)
          else waiting = resolve
        })
      },
      cancel: async () => {},
    },
  }
}

function fakeStreamingFetch(stream: ReturnType<typeof controlledStream>) {
  const seenSignals: (AbortSignal | undefined)[] = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    seenSignals.push(init.signal ?? undefined)
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: { getReader: () => stream.reader },
    } as unknown as Response
  })
  return { fetchImpl, seenSignals }
}

/** One controlled stream per call, in order — for tests where two separate
 * `sendMessage` calls (two separate people's turns) each need their own
 * independently-controllable fake response. */
function multiStreamFetch(streams: ReturnType<typeof controlledStream>[]) {
  const seenSignals: (AbortSignal | undefined)[] = []
  let next = 0
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const stream = streams[next++]
    seenSignals.push(init.signal ?? undefined)
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: { getReader: () => stream.reader },
    } as unknown as Response
  })
  return { fetchImpl, seenSignals }
}

/** Renders nothing; just publishes the current store onto `probe`. */
function Probe({ probe }: { probe: { store: ReturnType<typeof useChatStore> | null } }) {
  probe.store = useChatStore()
  return null
}

async function tick() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ChatProvider', () => {
  it('does not abort the in-flight request when the component that started it unmounts', async () => {
    const stream = controlledStream()
    const { fetchImpl, seenSignals } = fakeStreamingFetch(stream)
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    const { rerender } = render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    act(() => probe.store!.sendMessage('hello'))
    await tick()
    stream.push('data: {"t":"He"}\n\n')
    await tick()
    expect(probe.store!.state.streaming).toBe(true)

    // Simulate ChatPage unmounting on navigation — the sender is gone, but
    // the provider (mounted above the router) and this reader persist.
    rerender(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    expect(seenSignals[0]?.aborted).toBe(false)

    // Deltas keep accumulating after the "unmount".
    stream.push('data: {"t":"llo"}\n\n')
    await tick()
    stream.push('data: [DONE]\n\n')
    stream.end()
    await tick()

    expect(seenSignals[0]?.aborted).toBe(false)
    expect(probe.store!.state.streaming).toBe(false)
    const assistant = probe.store!.state.rows.find(r => r.kind === 'message' && r.role === 'assistant')
    expect(assistant && assistant.kind === 'message' && assistant.text).toBe('Hello')
  })

  it('loadConversation reconciles rather than blindly replacing a live turn (mid-stream remount)', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    // ChatPage's own mount effect: an initial load of an empty conversation.
    act(() => probe.store!.loadConversation('c1', []))
    act(() => probe.store!.sendMessage('hello'))
    await tick()
    stream.push('data: {"t":"partial"}\n\n')
    await tick()
    expect(probe.store!.state.streaming).toBe(true)

    // ChatPage remounts (simulating a return from /settings) and re-fetches
    // — the persisted history only has the user's message, since the
    // assistant reply has not finished yet.
    act(() =>
      probe.store!.loadConversation('c1', [{ id: 'u1', role: 'user', content: 'hello' }]),
    )

    const rowsAfterReconcile = probe.store!.state.rows
    expect(rowsAfterReconcile.filter(r => r.kind === 'message' && r.role === 'user')).toHaveLength(1)
    const assistantRow = rowsAfterReconcile.find(r => r.kind === 'message' && r.role === 'assistant')
    expect(assistantRow && assistantRow.kind === 'message' && assistantRow.text).toBe('partial')
    expect(probe.store!.state.streaming).toBe(true)

    stream.push('data: [DONE]\n\n')
    stream.end()
    await tick()
    expect(probe.store!.state.streaming).toBe(false)
  })

  it('loadConversation reconciles a completed-while-away turn without duplicating it', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    act(() => probe.store!.loadConversation('c1', []))
    act(() => probe.store!.sendMessage('hello'))
    await tick()
    stream.push('data: {"t":"full reply"}\n\n')
    stream.push('data: [DONE]\n\n')
    stream.end()
    await tick()
    expect(probe.store!.state.streaming).toBe(false)

    // ChatPage remounts after the turn finished entirely while it was gone.
    // The fetch now reflects both persisted messages — reconciling must not
    // add a second copy of either.
    act(() =>
      probe.store!.loadConversation('c1', [
        { id: 'u1', role: 'user', content: 'hello' },
        { id: 'a1', role: 'assistant', content: 'full reply' },
      ]),
    )

    const finalState: ChatState = probe.store!.state
    const assistantRows = finalState.rows.filter(r => r.kind === 'message' && r.role === 'assistant')
    expect(assistantRows).toHaveLength(1)
    expect(assistantRows[0].kind === 'message' && assistantRows[0].text).toBe('full reply')
  })
})

/**
 * The identity boundary: a browser tab is not one conversation, it is
 * whoever is currently signed into it. Placing ChatProvider correctly (at
 * the authenticated-routes boundary in App.tsx, so it unmounts on sign-out
 * and remounts fresh on the next sign-in) is one line of defense; this
 * store also carries its own guard, independent of where it happens to be
 * mounted, in case a future refactor puts it somewhere that does not
 * naturally unmount on identity change. `personId` is the signed-in
 * person's id (or null, signed out): whenever it changes, the current
 * in-flight request is aborted, the transcript is reset, and — the part
 * an abort alone cannot guarantee, since one event already in flight can
 * still land after `.abort()` is called — no event from a stream started
 * under the previous identity is ever dispatched again, however late it
 * arrives.
 */
describe('ChatProvider — the identity boundary (sign-out, or someone else signing in)', () => {
  it('a stream still in flight when its owner signs out is aborted and stops updating the store', async () => {
    const stream = controlledStream()
    const { fetchImpl, seenSignals } = fakeStreamingFetch(stream)
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    const { rerender } = render(
      <ChatProvider fetchImpl={fetchImpl} personId="person-a">
        <Probe probe={probe} />
      </ChatProvider>,
    )

    act(() => probe.store!.sendMessage('hello'))
    await tick()
    stream.push('data: {"t":"partial"}\n\n')
    await tick()
    expect(probe.store!.state.streaming).toBe(true)

    // Signing out: personId goes from "person-a" to null.
    rerender(
      <ChatProvider fetchImpl={fetchImpl} personId={null}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    expect(seenSignals[0]?.aborted).toBe(true)
    // The WHOLE state, enumerated on purpose: nothing of the previous person's
    // turn may survive a change of who is signed in. `turnId` joined the shape
    // with Stop (S15), and a stale one here would aim the button at a stranger's
    // turn — so it is pinned to null like the rest.
    expect(probe.store!.state).toEqual({
      rows: [],
      streaming: false,
      conversationId: null,
      model: null,
      pendingId: null,
      turnId: null,
      queued: [],
    })

    // Whatever was already in flight when the abort fired must not land
    // either, however late it arrives.
    stream.push('data: {"t":"more from the old owner"}\n\n')
    stream.push('data: {"error":"a stray failure from the old owner"}\n\n')
    stream.push('data: [DONE]\n\n')
    stream.end()
    await tick()

    expect(probe.store!.state.rows).toEqual([])
  })

  it("a second person signing in gets a clean transcript, immune to the first person's delayed frames", async () => {
    const streamA = controlledStream()
    const streamB = controlledStream()
    const { fetchImpl } = multiStreamFetch([streamA, streamB])
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    const { rerender } = render(
      <ChatProvider fetchImpl={fetchImpl} personId="person-a">
        <Probe probe={probe} />
      </ChatProvider>,
    )

    act(() => probe.store!.loadConversation('a-convo', []))
    act(() => probe.store!.sendMessage("A's message"))
    await tick()
    streamA.push('data: {"t":"A is mid-reply"}\n\n')
    await tick()

    // A signs out mid-stream, then B signs in — both on the same tab.
    rerender(
      <ChatProvider fetchImpl={fetchImpl} personId={null}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    rerender(
      <ChatProvider fetchImpl={fetchImpl} personId="person-b">
        <Probe probe={probe} />
      </ChatProvider>,
    )
    expect(probe.store!.state.rows).toEqual([])

    act(() => probe.store!.loadConversation('b-convo', []))
    act(() => probe.store!.sendMessage("B's message"))
    await tick()

    // (b) A delayed meta frame from A's abandoned stream must not rewrite
    // conversationId back to A's conversation — which would send B's NEXT
    // message into A's conversation, since sendMessage reads the
    // conversationId fresh at send time.
    streamA.push(
      'data: {"meta":{"conversation_id":"a-convo","model":"m","turn_id":"a-turn"}}\n\n',
    )
    await tick()
    expect(probe.store!.state.conversationId).toBe('b-convo')

    // (c) A's delta/done, arriving after B's own turn has started, must
    // never write into B's bubble (matched only by bare pendingId equality
    // in the reducer, which the store-level guard has to prevent reaching
    // at all).
    streamA.push('data: {"t":"A leaked into B"}\n\n')
    streamA.push('data: [DONE]\n\n')
    streamA.end()
    await tick()

    const bAssistant = probe.store!.state.rows.find(
      r => r.kind === 'message' && r.role === 'assistant',
    )
    expect(bAssistant && bAssistant.kind === 'message' && bAssistant.text).not.toContain(
      'A leaked into B',
    )
    expect(probe.store!.state.streaming).toBe(true) // B's own turn is still genuinely open

    // B's own stream still works normally throughout.
    streamB.push('data: {"t":"hi, B"}\n\n')
    streamB.push('data: [DONE]\n\n')
    streamB.end()
    await tick()

    expect(probe.store!.state.streaming).toBe(false)
    const finalAssistant = probe.store!.state.rows.find(
      r => r.kind === 'message' && r.role === 'assistant',
    )
    expect(finalAssistant && finalAssistant.kind === 'message' && finalAssistant.text).toBe(
      'hi, B',
    )
    expect(probe.store!.state.conversationId).toBe('b-convo')
  })
})

/**
 * Clear chat: the "Clear chat" button and the `/clear` (alias `/reset`) slash
 * command both land in clearChat, which calls the clear API and — only on its
 * ok — empties the store to the conversation's empty state. `conversationsApi`
 * is the same DI seam as `fetchImpl`. The load-bearing behaviours: the command
 * is recognised only as a WHOLE message (mid-text "/clear" is an ordinary turn),
 * clearing is never a chat turn (no fetch), and a failed clear never fakes
 * success (the transcript stays put).
 */
describe('ChatProvider — clearChat + the /clear slash command', () => {
  const loaded = [
    { id: 'u1', role: 'user', content: 'hi' },
    { id: 'a1', role: 'assistant', content: 'hello' },
  ]

  it('clearChat calls the clear API and empties the open conversation', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const clearConversation = vi.fn(async () => ({ id: 'conv-1', cleared: 2 }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} conversationsApi={{ clearConversation }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', loaded))
    expect(probe.store!.state.rows).toHaveLength(2)

    await act(async () => {
      await probe.store!.clearChat()
    })

    expect(clearConversation).toHaveBeenCalledWith('conv-1')
    expect(probe.store!.state.rows).toEqual([]) // empty state
    expect(probe.store!.state.conversationId).toBe('conv-1') // same chat, still open
    expect(fetchImpl).not.toHaveBeenCalled() // clearing is not a chat turn
  })

  it('a whole-message /clear routes to clearChat and is NOT sent as a turn', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const clearConversation = vi.fn(async () => ({ id: 'conv-1', cleared: 2 }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} conversationsApi={{ clearConversation }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', loaded))

    act(() => probe.store!.sendMessage('/clear'))
    await tick()

    expect(clearConversation).toHaveBeenCalledWith('conv-1')
    expect(fetchImpl).not.toHaveBeenCalled() // never streamed to the model
    expect(probe.store!.state.rows).toEqual([]) // empty state after
  })

  it('/reset is accepted as an alias for /clear', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const clearConversation = vi.fn(async () => ({ id: 'conv-1', cleared: 2 }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} conversationsApi={{ clearConversation }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', loaded))

    act(() => probe.store!.sendMessage('/reset'))
    await tick()

    expect(clearConversation).toHaveBeenCalledWith('conv-1')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(probe.store!.state.rows).toEqual([])
  })

  it('a message CONTAINING /clear mid-text is sent normally, not treated as a command', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const clearConversation = vi.fn(async () => ({ id: 'conv-1', cleared: 0 }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} conversationsApi={{ clearConversation }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))

    act(() => probe.store!.sendMessage('please run /clear when you are done'))
    await tick()

    expect(clearConversation).not.toHaveBeenCalled() // not a command
    expect(fetchImpl).toHaveBeenCalledTimes(1) // a real turn went out
    expect(probe.store!.state.streaming).toBe(true)
    const userRow = probe.store!.state.rows.find(r => r.kind === 'message' && r.role === 'user')
    expect(userRow && userRow.kind === 'message' && userRow.text).toBe(
      'please run /clear when you are done',
    )
  })

  it('does not fake success — a failed clear surfaces and leaves the transcript intact', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const clearConversation = vi.fn(async () => {
      throw new Error('server said no')
    })
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} conversationsApi={{ clearConversation }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', loaded))

    await act(async () => {
      await expect(probe.store!.clearChat()).rejects.toThrow(/server said no/)
    })

    expect(probe.store!.state.rows).toHaveLength(2) // unchanged — no fake empty
  })
})

/**
 * The queue (S15). The composer used to be dead while Nova worked, so a
 * correction typed during a long tool call had nowhere to go. Now a send while
 * a turn is in flight goes through the same route and the SERVER decides: a 202
 * means accepted, and the live stream it arrives alongside must not be disturbed
 * by it.
 */
describe('ChatProvider — sending while a turn is already running', () => {
  it('keeps the live turn intact and adds the accepted message beside it', async () => {
    const stream = controlledStream()
    const posts: { url: string; body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: init.body })
      if (posts.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          body: { getReader: () => stream.reader },
        } as unknown as Response
      }
      return {
        ok: true,
        status: 202,
        text: async () =>
          JSON.stringify({
            queued: { id: 'q1', conversation_id: 'c1', body: 'actually, 12b', ahead: 0 },
          }),
      } as unknown as Response
    })

    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }
    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    await act(async () => {
      probe.store!.sendMessage('pull gemma4:26b')
    })
    stream.push('data: {"meta":{"conversation_id":"c1","model":"m","turn_id":"t-1"}}\n\n')
    stream.push('data: {"t":"starting the pull"}\n\n')
    await tick()

    await act(async () => {
      probe.store!.sendMessage('actually, 12b')
    })
    await tick()

    const state: ChatState = probe.store!.state
    expect(state.queued).toEqual([{ id: 'q1', body: 'actually, 12b', ahead: 0 }])
    // The live turn is untouched: still streaming, still the same pending row,
    // still the same turn id for Stop to address.
    expect(state.streaming).toBe(true)
    expect(state.turnId).toBe('t-1')
    const assistant = state.rows.filter(r => r.kind === 'message' && r.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({ text: 'starting the pull', streaming: true })
    // And the second message is NOT a user bubble — it has not been answered.
    const users = state.rows.filter(r => r.kind === 'message' && r.role === 'user')
    expect(users.map(u => (u as { text: string }).text)).toEqual(['pull gemma4:26b'])

    // The original stream still finishes normally afterwards.
    stream.push('data: [DONE]\n\n')
    stream.end()
    await tick()
    expect(probe.store!.state.streaming).toBe(false)
    expect(probe.store!.state.queued).toHaveLength(1)
  })

  it('takes a message back only after the server confirms it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/queued/')) {
        return { ok: true, status: 200, text: async () => '{"cancelled":true}' } as unknown as Response
      }
      return {
        ok: true,
        status: 202,
        text: async () =>
          JSON.stringify({ queued: { id: 'q1', conversation_id: 'c1', body: 'oops', ahead: 0 } }),
      } as unknown as Response
    })
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }
    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    await act(async () => {
      probe.store!.sendMessage('oops')
    })
    await tick()
    expect(probe.store!.state.queued).toHaveLength(1)

    await act(async () => {
      await probe.store!.unqueue('q1')
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/chat/queued/q1', expect.anything())
    expect(probe.store!.state.queued).toEqual([])
  })

  it('keeps the message when the server refuses to take it back', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/queued/')) {
        return {
          ok: false,
          status: 409,
          text: async () => '{"error":"already being answered"}',
        } as unknown as Response
      }
      return {
        ok: true,
        status: 202,
        text: async () =>
          JSON.stringify({ queued: { id: 'q1', conversation_id: 'c1', body: 'too late', ahead: 0 } }),
      } as unknown as Response
    })
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }
    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    await act(async () => {
      probe.store!.sendMessage('too late')
    })
    await tick()

    await act(async () => {
      await expect(probe.store!.unqueue('q1')).rejects.toThrow(/already being answered/)
    })
    // Still there: the message is still going to run, and a chip that vanished
    // would say otherwise.
    expect(probe.store!.state.queued).toHaveLength(1)
  })
})

/**
 * Stop (S15). The SERVER ends the turn, not the browser: the old way to make a
 * reply stop was to navigate away, and ruling S2c-R1 deliberately made that
 * mean "finish". So Stop asks core, and the turn's own `stopped` frame is what
 * settles the row — the store never fakes the ending it asked for.
 */
describe('ChatProvider — stopping a turn', () => {
  it('asks core to stop the turn the meta frame named, and lets the stream settle it', async () => {
    const stream = controlledStream()
    const posts: string[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      posts.push(url)
      if (url.includes('/stop')) {
        return {
          ok: true,
          status: 200,
          text: async () => '{"stopped":true,"status":"stopped"}',
          json: async () => ({ stopped: true, status: 'stopped' }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        body: { getReader: () => stream.reader },
        signal: init.signal,
      } as unknown as Response
    })

    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }
    render(
      <ChatProvider fetchImpl={fetchImpl}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    await act(async () => {
      probe.store!.sendMessage('go on then')
    })
    stream.push('data: {"meta":{"conversation_id":"c1","model":"m","turn_id":"t-42"}}\n\n')
    stream.push('data: {"t":"I will now do "}\n\n')
    await tick()
    expect(probe.store!.state.turnId).toBe('t-42')

    await act(async () => {
      await probe.store!.stopTurn()
    })
    expect(posts).toContain('/api/v1/chat/turns/t-42/stop')
    // Asking is not ending: the row is still streaming until the server says
    // otherwise, so the store cannot claim a stop it has not been told about.
    expect(probe.store!.state.streaming).toBe(true)

    stream.push('data: {"stopped":"Stopped while writing the reply — you asked to stop it."}\n\n')
    stream.push('data: [DONE]\n\n')
    stream.end()
    await tick()

    const state: ChatState = probe.store!.state
    expect(state.streaming).toBe(false)
    const assistant = state.rows.filter(r => r.kind === 'message' && r.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({
      text: 'I will now do ',
      stoppedNote: 'Stopped while writing the reply — you asked to stop it.',
    })
    expect(state.rows.some(r => r.kind === 'error')).toBe(false)
  })

  it('does nothing at all when no turn is in flight', async () => {
    const fetchImpl = vi.fn()
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }
    render(
      <ChatProvider fetchImpl={fetchImpl as never}>
        <Probe probe={probe} />
      </ChatProvider>,
    )

    await act(async () => {
      await probe.store!.stopTurn()
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
