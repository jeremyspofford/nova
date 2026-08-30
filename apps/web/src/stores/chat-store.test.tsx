import { describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { ChatProvider, useChatStore } from './chat-store'
import type { ChatState } from '../pages/chat/chatReducer'
import type { ConsentCard } from '../lib/consentCard'
import { continuationMessage } from '../lib/consentCard'

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
    expect(probe.store!.state).toEqual({
      rows: [],
      streaming: false,
      conversationId: null,
      model: null,
      pendingId: null,
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
 * S3-T2's approve→executor reconciliation (ruling S3-R4): the kernel never
 * runs the action at decide time, so decideConsent's own job is (a) call the
 * decide API and publish the result into the row (b) — on a SUCCESSFUL
 * approve tied to the conversation currently open — fire a real continuation
 * turn so the model re-issues the same call and the funnel burns the
 * now-approved consent. `consentsApi` is the same DI seam as `fetchImpl`:
 * production uses the real api.decideConsent, these tests inject a spy.
 */
describe('ChatProvider — decideConsent (S3-T2: approve has an executor)', () => {
  function card(overrides: Partial<ConsentCard> = {}): ConsentCard {
    return {
      consent_id: 'c-1',
      action_class: 'fetch_url',
      args_hash: 'hash',
      args: { url: 'https://example.com/pricing' },
      summary: 'Run fetch_url with url=https://example.com/pricing',
      status: 'pending',
      conversation_id: 'conv-1',
      requested_by: { person_id: 'p-1', agent: 'chat' },
      created_at: '2026-08-30T00:00:00Z',
      expires_at: '2026-08-31T00:00:00Z',
      ...overrides,
    }
  }

  it('approving a card tied to the open conversation sends a real, traced continuation turn', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} consentsApi={{ decideConsent: decideConsentApi }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))

    await act(async () => {
      await probe.store!.decideConsent(card(), 'approve')
    })

    expect(decideConsentApi).toHaveBeenCalledWith('c-1', 'approve')
    // A real chat turn — the same fetch sendMessage always uses, not a
    // separate/fake "it happened" path.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/chat/stream')
    const body = JSON.parse(String(init.body))
    expect(body.message).toBe(continuationMessage(card({ status: 'approved' })))
    expect(body.conversation_id).toBe('conv-1')
    expect(probe.store!.state.streaming).toBe(true)
  })

  it('denying a card never sends a continuation', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const decideConsentApi = vi.fn(async () => card({ status: 'denied' }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} consentsApi={{ decideConsent: decideConsentApi }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))

    await act(async () => {
      await probe.store!.decideConsent(card(), 'deny')
    })

    expect(decideConsentApi).toHaveBeenCalledWith('c-1', 'deny')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(probe.store!.state.streaming).toBe(false)
  })

  it('approving a card from a DIFFERENT conversation than the one open here does not continue it', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const decideConsentApi = vi.fn(async () => card({ status: 'approved', conversation_id: 'other-convo' }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} consentsApi={{ decideConsent: decideConsentApi }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))

    await act(async () => {
      await probe.store!.decideConsent(card({ conversation_id: 'other-convo' }), 'approve')
    })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('approving while a live turn is already streaming does not clobber it with a continuation', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const decideConsentApi = vi.fn(async () => card({ status: 'approved' }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} consentsApi={{ decideConsent: decideConsentApi }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))
    act(() => probe.store!.sendMessage('already talking'))
    await tick()
    expect(probe.store!.state.streaming).toBe(true)

    await act(async () => {
      await probe.store!.decideConsent(card(), 'approve')
    })

    // Only the one fetch — the live turn's own — ever went out.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('publishes the decided card onto a matching consent row already in the transcript', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const decideConsentApi = vi.fn(async () => card({ status: 'denied' }))
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} consentsApi={{ decideConsent: decideConsentApi }}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))
    act(() => probe.store!.sendMessage('check the pricing page'))
    await tick()
    stream.push(`data: {"consent":${JSON.stringify(card())}}\n\n`)
    await tick()
    const row = probe.store!.state.rows.find(r => r.kind === 'consent')
    expect(row && row.kind === 'consent' && row.card.status).toBe('pending')

    await act(async () => {
      await probe.store!.decideConsent(card(), 'deny')
    })

    const updated = probe.store!.state.rows.find(r => r.kind === 'consent')
    expect(updated && updated.kind === 'consent' && updated.card.status).toBe('denied')
  })
})

/**
 * S3-T3's folded fix (T2 review Important #2): an approved card whose
 * continuation never fired — decided from the Approvals page (a different
 * conversation than whatever this tab has open, or none open at all), or
 * decided while this store was already mid-turn — needs an explicit "go
 * ahead" the operator can trigger from anywhere. `resumeApprovedCard` is
 * that trigger: it makes sure the store's own conversation matches the
 * card's (fetching it via the injected `chatApi` seam when it does not
 * already), then sends the SAME real continuation turn decideConsent's
 * auto-fire path sends — never a fake "it happened".
 */
describe('ChatProvider — resumeApprovedCard (S3-T3: go ahead on an approved card)', () => {
  function card(overrides: Partial<ConsentCard> = {}): ConsentCard {
    return {
      consent_id: 'c-1',
      action_class: 'fetch_url',
      args_hash: 'hash',
      args: { url: 'https://example.com/pricing' },
      summary: 'Run fetch_url with url=https://example.com/pricing',
      status: 'approved',
      conversation_id: 'conv-1',
      requested_by: { person_id: 'p-1', agent: 'chat' },
      created_at: '2026-08-30T00:00:00Z',
      expires_at: '2026-08-31T00:00:00Z',
      ...overrides,
    }
  }

  it('sends the continuation directly when the right conversation is already open', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const chatApi = {
      getActiveConversation: vi.fn(),
      getMessages: vi.fn(),
    }
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} chatApi={chatApi}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))

    await act(async () => {
      await probe.store!.resumeApprovedCard(card())
    })

    expect(chatApi.getActiveConversation).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).message).toBe(continuationMessage(card()))
    expect(probe.store!.state.streaming).toBe(true)
  })

  it('fetches and loads the active conversation first when a different (or no) one is open', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const chatApi = {
      getActiveConversation: vi.fn(async () => ({
        id: 'conv-1',
        title: null,
        created_at: '2026-08-30T00:00:00Z',
        pending_turn: false,
      })),
      getMessages: vi.fn(async () => [
        { id: 'u1', role: 'user', content: 'earlier', created_at: '2026-08-30T00:00:00Z' },
      ]),
    }
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} chatApi={chatApi}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    // Nothing loaded yet — simulates arriving from the Approvals page with no
    // conversation open in this tab at all.
    expect(probe.store!.state.conversationId).toBeNull()

    await act(async () => {
      await probe.store!.resumeApprovedCard(card())
    })

    expect(chatApi.getActiveConversation).toHaveBeenCalledTimes(1)
    expect(chatApi.getMessages).toHaveBeenCalledWith('conv-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).message).toBe(continuationMessage(card()))
    expect(probe.store!.state.streaming).toBe(true)
  })

  it('refuses to fire a second continuation while a turn is already streaming', async () => {
    const stream = controlledStream()
    const { fetchImpl } = fakeStreamingFetch(stream)
    const chatApi = { getActiveConversation: vi.fn(), getMessages: vi.fn() }
    const probe: { store: ReturnType<typeof useChatStore> | null } = { store: null }

    render(
      <ChatProvider fetchImpl={fetchImpl} chatApi={chatApi}>
        <Probe probe={probe} />
      </ChatProvider>,
    )
    act(() => probe.store!.loadConversation('conv-1', []))
    act(() => probe.store!.sendMessage('already talking'))
    await tick()
    expect(probe.store!.state.streaming).toBe(true)

    await expect(probe.store!.resumeApprovedCard(card())).rejects.toThrow(/already running/i)
    // Only the live turn's own fetch ever went out — no second, clobbering one.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
