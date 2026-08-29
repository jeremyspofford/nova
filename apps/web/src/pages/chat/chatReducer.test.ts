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
  // By the time ChatPage remounts, the store already lived through whatever
  // happened to this conversation in real time — a fetch taken while away
  // can only be stale or exactly caught up, never more current than what
  // was actually streamed. So a reconcile against the SAME conversation the
  // store already holds is a no-op; only a genuinely different (or
  // first-ever) conversation replaces the rows, exactly like `loaded`. (The
  // store surviving a route change at all is ruling S2-R4.)

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

describe('chatReducer — resolving a turn that finished server-side (pollResolved)', () => {
  // The durable-turn case (S2c): the operator hard-refreshed mid-reply, so
  // core finished the turn detached and persisted the full answer. The fresh
  // page loads history (only the user message so far), sees pending_turn, and
  // polls; when core reports the turn done, ChatPage fetches the now-complete
  // history and dispatches this. Because the store never streamed this turn,
  // the fetch is authoritative — it replaces the rows, resolving the pending
  // reply into the SAME set, never a duplicate.

  it('replaces the pre-reply history with the finished reply, exactly once', () => {
    // Fresh page after a hard refresh: history had only the user's message.
    let state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    })
    expect(messages(state).map(m => m.role)).toEqual(['user'])

    // The poll resolves: the assistant reply has landed in the DB.
    state = chatReducer(state, {
      type: 'pollResolved',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: 'hello' },
        { id: 'a1', role: 'assistant', content: 'the full durable reply' },
      ],
    })

    expect(messages(state).map(m => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'the full durable reply'],
    ])
    // The assistant reply is a settled row, not a still-streaming one.
    expect(messages(state)[1].streaming).toBe(false)
    expect(state.streaming).toBe(false)
  })

  it('is dropped if the operator has since started their own live turn', () => {
    let state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    })
    // A new live turn begins before the poll comes back.
    state = chatReducer(state, { type: 'send', userId: 'u2', assistantId: 'a2', text: 'wait, this' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'live' } })
    expect(state.streaming).toBe(true)

    // The late poll result must not clobber the live turn.
    state = chatReducer(state, {
      type: 'pollResolved',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    })

    expect(state.streaming).toBe(true)
    const live = messages(state).find(m => m.id === 'a2')
    expect(live && live.text).toBe('live')
  })

  it('is dropped if it names a conversation the store has since left', () => {
    const state = chatReducer(
      chatReducer(emptyChat(), {
        type: 'loaded',
        conversationId: 'c2',
        messages: [{ id: 'm1', role: 'user', content: 'current conversation' }],
      }),
      {
        type: 'pollResolved',
        conversationId: 'c1',
        messages: [{ id: 'x', role: 'assistant', content: 'stale' }],
      },
    )
    expect(state.conversationId).toBe('c2')
    expect(messages(state).map(m => m.text)).toEqual(['current conversation'])
  })
})

describe('chatReducer — live tool activity in the pending bubble', () => {
  // The chat store already tolerates {"activity":{tool,status}} frames
  // (streamChat's forward-compat); this is where they become something the
  // pending bubble can show — a transient line, never persisted, cleared
  // the moment the call resolves or the bubble itself finishes.

  it('a start frame puts a transient activity marker on the pending row', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'workspace_write_file', status: 'start' },
    })
    expect(messages(state)[1].activity).toEqual({ tool: 'workspace_write_file', status: 'start' })
  })

  it('an ok frame clears the marker — the call resolved cleanly', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'get_time', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'get_time', status: 'ok' },
    })
    expect(messages(state)[1].activity).toBeNull()
  })

  it('an error frame replaces the marker with a stated failure, it does not clear', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'workspace_read_file', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'workspace_read_file', status: 'error' },
    })
    expect(messages(state)[1].activity).toEqual({ tool: 'workspace_read_file', status: 'error' })
  })

  it('a second call in the same round replaces the marker, one at a time', () => {
    let state = started()
    for (const status of ['start', 'ok'] as const) {
      state = chatReducer(state, { type: 'event', event: { type: 'activity', tool: 'a', status } })
    }
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'b', status: 'start' },
    })
    expect(messages(state)[1].activity).toEqual({ tool: 'b', status: 'start' })
  })

  it('is absent on a freshly opened bubble, before any activity frame arrives', () => {
    const state = started()
    expect(messages(state)[1].activity).toBeNull()
  })

  it('an activity frame is a no-op once the turn has no pending row', () => {
    // Defensive: a frame that somehow arrives after [DONE] must not throw
    // or resurrect a finished bubble.
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'get_time', status: 'start' },
    })
    expect(state.pendingId).toBeNull()
  })

  it('the marker is cleared once the bubble finishes, even after an error frame', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'still working' } })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'workspace_read_file', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'workspace_read_file', status: 'error' },
    })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(messages(state)[1].activity).toBeNull()
  })

  it('the marker is cleared on an interrupted turn too', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'get_time', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'interrupted', reason: 'connection lost' },
    })
    expect(messages(state)[1].activity).toBeNull()
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
