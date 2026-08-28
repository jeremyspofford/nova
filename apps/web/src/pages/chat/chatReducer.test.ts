import { describe, it, expect } from 'vitest'
import { chatReducer, emptyChat, type ChatState, type ChatRow } from './chatReducer'

function started(): ChatState {
  return chatReducer(emptyChat(), {
    type: 'send',
    userId: 'u1',
    assistantId: 'a1',
    text: 'hello',
  })
}

function messages(state: ChatState): Extract<ChatRow, { kind: 'message' }>[] {
  return state.rows.filter((r): r is Extract<ChatRow, { kind: 'message' }> => r.kind === 'message')
}

function errors(state: ChatState): Extract<ChatRow, { kind: 'error' }>[] {
  return state.rows.filter((r): r is Extract<ChatRow, { kind: 'error' }> => r.kind === 'error')
}

describe('chatReducer — loading history', () => {
  it('maps the server rows oldest-first and stores the conversation', () => {
    const state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [
        { id: 'm1', role: 'user', content: 'hi' },
        { id: 'm2', role: 'assistant', content: 'hello there' },
      ],
    })
    expect(state.conversationId).toBe('c1')
    expect(messages(state).map(m => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello there'],
    ])
    expect(state.streaming).toBe(false)
  })
})

describe('chatReducer — a healthy turn', () => {
  it('opens a user row and an empty streaming assistant row', () => {
    const state = started()
    expect(messages(state).map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages(state)[1].text).toBe('')
    expect(messages(state)[1].streaming).toBe(true)
    expect(state.streaming).toBe(true)
  })

  it('accumulates deltas into the assistant row', () => {
    let state = started()
    for (const text of ['He', 'llo', ' there']) {
      state = chatReducer(state, { type: 'event', event: { type: 'delta', text } })
    }
    expect(messages(state)[1].text).toBe('Hello there')
    expect(state.streaming).toBe(true)
  })

  it('records the model and conversation from the meta frame', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'meta', conversationId: 'c7', model: 'qwen3:4b', turnId: 't1' },
    })
    expect(state.model).toBe('qwen3:4b')
    expect(state.conversationId).toBe('c7')
  })

  it('closes the assistant row on [DONE]', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'done text' } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(messages(state)[1].streaming).toBe(false)
    expect(state.streaming).toBe(false)
    expect(errors(state)).toHaveLength(0)
  })
})

describe('chatReducer — failure is never an assistant bubble', () => {
  it('replaces an empty assistant row with a distinct error row', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'error', reason: 'could not reach the gateway' },
    })
    expect(messages(state).map(m => m.role)).toEqual(['user'])
    expect(errors(state)).toHaveLength(1)
    expect(errors(state)[0].reason).toBe('could not reach the gateway')
    expect(state.streaming).toBe(false)
  })

  it('keeps text that really streamed and adds the error row after it', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'partial' } })
    state = chatReducer(state, { type: 'event', event: { type: 'error', reason: 'stream died' } })
    expect(messages(state)[1].text).toBe('partial')
    expect(messages(state)[1].streaming).toBe(false)
    expect(errors(state)[0].reason).toBe('stream died')
    expect(state.rows[state.rows.length - 1].kind).toBe('error')
  })

  it('ignores the [DONE] that follows an error frame', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'error', reason: 'boom' } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(errors(state)).toHaveLength(1)
    expect(state.streaming).toBe(false)
  })

  it('refuses to leave an empty assistant bubble when [DONE] arrives with no text', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(messages(state).map(m => m.role)).toEqual(['user'])
    expect(errors(state)).toHaveLength(1)
    expect(errors(state)[0].reason).toMatch(/without a reply/i)
  })
})

describe('chatReducer — reconciling a fetched history against a live store', () => {
  // The store survives navigation (S2-R4): by the time ChatPage remounts,
  // the store already lived through whatever happened to this conversation
  // in real time — a fetch taken while away can only be stale or exactly
  // caught up, never more current than what was actually streamed. So a
  // reconcile against the SAME conversation the store already holds is a
  // no-op; only a genuinely different (or first-ever) conversation replaces
  // the rows, exactly like `loaded`.

  it('replaces empty/unseen state with the fetched history, like loaded', () => {
    const state = chatReducer(emptyChat(), {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [{ id: 'm1', role: 'user', content: 'hi' }],
    })
    expect(state.conversationId).toBe('c1')
    expect(messages(state).map(m => [m.role, m.text])).toEqual([['user', 'hi']])
  })

  it('replaces rows when the fetched conversation differs from the one the store holds', () => {
    const loaded = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [{ id: 'm1', role: 'user', content: 'old conversation' }],
    })
    const state = chatReducer(loaded, {
      type: 'reconcile',
      conversationId: 'c2',
      messages: [{ id: 'm2', role: 'user', content: 'a different conversation' }],
    })
    expect(state.conversationId).toBe('c2')
    expect(messages(state).map(m => m.text)).toEqual(['a different conversation'])
  })

  it('mid-stream return: ignores the fetch and keeps the live partial continuing, no duplicate bubbles', () => {
    let state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [],
    })
    state = chatReducer(state, { type: 'send', userId: 'u1', assistantId: 'a1', text: 'hello' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'partial rep' } })
    expect(state.streaming).toBe(true)

    // The fetch taken on remount only sees the persisted user message — the
    // assistant reply has not been persisted yet because the turn has not
    // finished. Reconciling against it must not lose or duplicate anything.
    state = chatReducer(state, {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    })

    expect(state.streaming).toBe(true)
    expect(messages(state).map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages(state)[1].text).toBe('partial rep')
    expect(messages(state)[1].streaming).toBe(true)

    // The stream keeps accumulating after the reconcile, same as if the
    // remount had never happened.
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'ly' } })
    expect(messages(state)[1].text).toBe('partial reply')
  })

  it('completed-while-away: ignores the fetch and shows the store\'s finished reply exactly once', () => {
    let state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [],
    })
    state = chatReducer(state, { type: 'send', userId: 'u1', assistantId: 'a1', text: 'hello' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'full reply' } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(state.streaming).toBe(false)

    // By the time ChatPage remounts, core has already persisted both
    // messages — the fetch reflects them too, which must not double them up.
    state = chatReducer(state, {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: 'hello' },
        { id: 'a1', role: 'assistant', content: 'full reply' },
      ],
    })

    expect(messages(state).map(m => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'full reply'],
    ])
    expect(errors(state)).toHaveLength(0)
  })

  it('a turn that errored while away keeps the local error row — the fetch alone would lose it', () => {
    let state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [],
    })
    state = chatReducer(state, { type: 'send', userId: 'u1', assistantId: 'a1', text: 'hello' })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'error', reason: 'the gateway refused the request' },
    })

    // A failed turn never persists an assistant row server-side, so the
    // fetch only ever sees the user message.
    state = chatReducer(state, {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    })

    expect(messages(state).map(m => m.role)).toEqual(['user'])
    expect(errors(state)).toHaveLength(1)
    expect(errors(state)[0].reason).toBe('the gateway refused the request')
  })
})

describe('chatReducer — a dropped connection', () => {
  it('keeps the partial text and marks it interrupted', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'half a th' } })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'interrupted', reason: 'socket hang up' },
    })
    const assistant = messages(state)[1]
    expect(assistant.text).toBe('half a th')
    expect(assistant.interrupted).toBe(true)
    expect(assistant.streaming).toBe(false)
    expect(state.streaming).toBe(false)
    expect(errors(state)).toHaveLength(0)
  })

  it('marks an interruption before any text without inventing content', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'interrupted', reason: 'connection lost' },
    })
    const assistant = messages(state)[1]
    expect(assistant.text).toBe('')
    expect(assistant.interrupted).toBe(true)
  })
})
