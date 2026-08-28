import { describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { ChatProvider, useChatStore } from './chat-store'
import type { ChatState } from '../pages/chat/chatReducer'

/**
 * The nav bug (S1 carries, S2-R4): the SSE stream used to be owned by
 * ChatPage, so navigating away unmounted it and aborted the fetch — the
 * server correctly read that as a disconnect and cancelled generation. The
 * fix lifts ownership into this store, mounted above the router, so a
 * consumer's unmount can never touch the request.
 *
 * These tests drive a hand-controlled ReadableStream reader so a chunk can
 * be pushed AFTER the consumer that called sendMessage has unmounted —
 * proving the fetch and the accumulation both keep going regardless.
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
