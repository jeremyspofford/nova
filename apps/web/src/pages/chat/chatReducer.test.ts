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

  // The frontend half of the mid-session model-switch property (S2e T1):
  // core reads chat.model fresh per turn (proven server-side in
  // services/core/tests/test_chat.py), and this is what makes that visible —
  // a later meta frame's model REPLACES the earlier one rather than the
  // badge sticking to whatever the conversation opened with.
  it('a later turn’s meta frame replaces the model an earlier turn reported', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'meta', conversationId: 'c7', model: 'qwen3:8b', turnId: 't1' },
    })
    expect(state.model).toBe('qwen3:8b')

    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    state = chatReducer(state, {
      type: 'send',
      userId: 'u2',
      assistantId: 'a2',
      text: 'and now?',
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'meta', conversationId: 'c7', model: 'qwen3:14b', turnId: 't2' },
    })
    expect(state.model).toBe('qwen3:14b')
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

  it('a progress frame replaces the marker with the tool\'s own words, the latest winning', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'progress', detail: 'pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)' },
    })
    expect(messages(state)[1].activity).toEqual({ tool: 'model_pull', status: 'progress', detail: 'pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)' })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'progress', detail: 'pulling qwen3:4b — 100% (2.3 GB of 2.3 GB)' },
    })
    expect(messages(state)[1].activity?.detail).toBe('pulling qwen3:4b — 100% (2.3 GB of 2.3 GB)')
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'ok' },
    })
    expect(messages(state)[1].activity).toBeNull()
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

  it('an error frame carrying a reason puts it on the marker unchanged', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'device_run', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: {
        type: 'activity',
        tool: 'device_run',
        status: 'error',
        reason: 'could not run tree: executable file not found in $PATH',
      },
    })
    expect(messages(state)[1].activity).toEqual({
      tool: 'device_run',
      status: 'error',
      reason: 'could not run tree: executable file not found in $PATH',
    })
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

// Slice 2f Fix A: a Settings->Models switch has to be visible in chat
// immediately, with no message sent — but `model` otherwise only updates
// from a server-confirmed turn (the 'meta' event above). `modelSwitched` is
// the one other writer: it sets `model` directly (not "event.model ||
// state.model" like 'meta' does), because the switch itself is the fact,
// not a hint to merge with whatever was there before.
describe('chatReducer — a Settings model switch (modelSwitched)', () => {
  it('sets model directly, with no turn required', () => {
    const state = chatReducer(emptyChat(), { type: 'modelSwitched', model: 'qwen3:14b' })
    expect(state.model).toBe('qwen3:14b')
  })

  it('overrides a stale model left over from an earlier turn in this same conversation', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'meta', conversationId: 'c1', model: 'qwen3:8b', turnId: 't1' },
    })
    expect(state.model).toBe('qwen3:8b')

    state = chatReducer(state, { type: 'modelSwitched', model: 'qwen3.8:27b' })
    expect(state.model).toBe('qwen3.8:27b')
  })

  it('touches nothing else about the conversation in flight', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'partial' } })
    state = chatReducer(state, { type: 'modelSwitched', model: 'qwen3:14b' })
    expect(messages(state)[1].text).toBe('partial')
    expect(state.streaming).toBe(true)
  })
})


describe('chatReducer — who answered (S10-pre)', () => {
  it('a served_by event badges the pending row and nothing else', () => {
    let state = started()
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'hi' } })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'served', servedBy: 'openrouter:anthropic/claude-sonnet-5' },
    })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(messages(state).map(m => [m.role, m.servedBy])).toEqual([
      ['user', null],
      ['assistant', 'openrouter:anthropic/claude-sonnet-5'],
    ])
  })

  it('a row starts with no badge and a served event outside a turn is ignored', () => {
    const state = chatReducer(emptyChat(), {
      type: 'event',
      event: { type: 'served', servedBy: 'ollama:qwen3:8b' },
    })
    expect(state.rows).toEqual([])
    expect(messages(started()).every(m => m.servedBy === null)).toBe(true)
  })

  it('fetched history carries the server-derived badge, null when it stated none', () => {
    const state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [
        { id: 'm1', role: 'user', content: 'hi', served_by: null },
        { id: 'm2', role: 'assistant', content: 'hello', served_by: 'anthropic:claude-opus-5' },
        { id: 'm3', role: 'assistant', content: 'older row' },
      ],
    })
    expect(messages(state).map(m => m.servedBy)).toEqual([null, 'anthropic:claude-opus-5', null])
  })
})

describe('chatReducer — the idle poll merges the server transcript by id (S9)', () => {
  // The store's rows are a MIX: server-id rows it loaded, client-id rows it
  // streamed (`u-…`/`a-…`, ids the server never learns), and client-only rows
  // (a stated failure, a /help note). The fetched list is the persisted truth
  // in order. The merge must show every server row once, every client-only
  // row once, and never a live exchange twice.
  const server = (id: string, role: string, content: string, turn_kind?: string) => ({
    id,
    role,
    content,
    turn_kind,
  })

  function loaded(...messages: ReturnType<typeof server>[]): ChatState {
    return chatReducer(emptyChat(), { type: 'loaded', conversationId: 'c1', messages })
  }

  function polled(state: ChatState, messages: ReturnType<typeof server>[], conversationId = 'c1') {
    return chatReducer(state, {
      type: 'idlePolled',
      conversationId,
      messages,
      observedRows: state.rows,
    })
  }

  /** A whole live exchange streamed through this store: client ids. */
  function streamed(state: ChatState, userId: string, assistantId: string, ask: string, reply: string) {
    let next = chatReducer(state, { type: 'send', userId, assistantId, text: ask })
    next = chatReducer(next, { type: 'event', event: { type: 'delta', text: reply } })
    return chatReducer(next, { type: 'event', event: { type: 'done' } })
  }

  it('appends a row the server has that the store does not — a reminder — where the server put it', () => {
    const state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'))
    const next = polled(state, [
      server('u1', 'user', 'hi'),
      server('a1', 'assistant', 'hello'),
      server('r1', 'assistant', 'Reminder: stretch', 'reminder'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a1', 'r1'])
    const reminder = messages(next)[2]
    expect(reminder.turnKind).toBe('reminder')
    expect(reminder.text).toBe('Reminder: stretch')
  })

  it('returns the SAME state object when the poll learned nothing new', () => {
    const state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello', 'chat'))
    const next = polled(state, [server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello', 'chat')])
    expect(next).toBe(state)
  })

  it('recognises a live exchange it streamed itself in the server rows — shown once, now under its server ids', () => {
    let state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'))
    state = streamed(state, 'u-live', 'a-live', 'remind me in two minutes to stretch', 'Done — in 2 minutes.')
    expect(state.rows.map(r => r.id)).toEqual(['u1', 'a1', 'u-live', 'a-live'])

    const next = polled(state, [
      server('u1', 'user', 'hi'),
      server('a1', 'assistant', 'hello'),
      server('u2', 'user', 'remind me in two minutes to stretch'),
      server('a2', 'assistant', 'Done — in 2 minutes.', 'chat'),
      server('r1', 'assistant', 'Reminder: stretch', 'reminder'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'r1'])
    expect(messages(next).filter(m => m.role === 'assistant')).toHaveLength(3)
    // A second poll with the same answer is a no-op.
    expect(polled(next, [
      server('u1', 'user', 'hi'),
      server('a1', 'assistant', 'hello'),
      server('u2', 'user', 'remind me in two minutes to stretch'),
      server('a2', 'assistant', 'Done — in 2 minutes.', 'chat'),
      server('r1', 'assistant', 'Reminder: stretch', 'reminder'),
    ])).toBe(next)
  })

  it('takes the server\'s text for a reply it streamed — the persisted version is the true one', () => {
    // Core strips tool-call markup at the persist boundary (without_markup),
    // so the durable reply can be shorter than what streamed. Once the server
    // has it, that is the row.
    let state = loaded()
    state = streamed(state, 'u-live', 'a-live', 'list files', 'Here: a.md <tool_call>…</tool_call>')
    const next = polled(state, [
      server('u1', 'user', 'list files'),
      server('a1', 'assistant', 'Here: a.md', 'chat'),
    ])
    expect(messages(next).map(m => [m.id, m.text])).toEqual([
      ['u1', 'list files'],
      ['a1', 'Here: a.md'],
    ])
  })

  it('keeps a stated failure and the text of a send the server never persisted, and still appends the reminder after them', () => {
    let state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'))
    state = chatReducer(state, { type: 'send', userId: 'u-lost', assistantId: 'a-lost', text: 'are you there?' })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'error', reason: 'could not reach Nova — Failed to fetch' },
    })
    expect(state.rows.map(r => r.id)).toEqual(['u1', 'a1', 'u-lost', 'a-lost:error'])

    // The server never saw that send; a reminder has since landed.
    const next = polled(state, [
      server('u1', 'user', 'hi'),
      server('a1', 'assistant', 'hello'),
      server('r1', 'assistant', 'Reminder: stretch', 'reminder'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a1', 'u-lost', 'a-lost:error', 'r1'])
    expect(errors(next)[0].reason).toBe('could not reach Nova — Failed to fetch')
  })

  it('completes a partial reply from the server\'s row when core finished the turn, keeping the failure note', () => {
    let state = loaded()
    state = chatReducer(state, { type: 'send', userId: 'u-live', assistantId: 'a-live', text: 'tell me a story' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'Once upon' } })
    state = chatReducer(state, { type: 'event', event: { type: 'error', reason: 'stream died' } })
    expect(state.rows.map(r => r.id)).toEqual(['u-live', 'a-live', 'a-live:error'])

    const next = polled(state, [
      server('u1', 'user', 'tell me a story'),
      server('a1', 'assistant', 'Once upon a time, the whole thing.', 'chat'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a1', 'a-live:error'])
    expect(messages(next)[1].text).toBe('Once upon a time, the whole thing.')
  })

  it('claims the reply on a LATER poll when the first poll re-keyed the user row before core had finished the turn', () => {
    let state = loaded()
    state = chatReducer(state, { type: 'send', userId: 'u-live', assistantId: 'a-live', text: 'tell me a story' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'Once upon' } })
    state = chatReducer(state, { type: 'event', event: { type: 'error', reason: 'stream died' } })

    // Poll 1: the server has his message but no reply yet (the durable turn
    // is still running). The user row is re-keyed; what streamed stays.
    state = polled(state, [server('u1', 'user', 'tell me a story')])
    expect(state.rows.map(r => r.id)).toEqual(['u1', 'a-live', 'a-live:error'])

    // Poll 2: core finished the turn. The reply must COMPLETE the row that
    // streamed, not land beside it as a second assistant bubble.
    const next = polled(state, [
      server('u1', 'user', 'tell me a story'),
      server('a1', 'assistant', 'Once upon a time, the whole thing.', 'chat'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a1', 'a-live:error'])
    expect(messages(next).filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(messages(next)[1].text).toBe('Once upon a time, the whole thing.')

    // And a third identical poll learns nothing.
    expect(polled(next, [
      server('u1', 'user', 'tell me a story'),
      server('a1', 'assistant', 'Once upon a time, the whole thing.', 'chat'),
    ])).toBe(next)
  })

  it('never mistakes a reminder for the reply of a turn it streamed — the kind says it was not a chat turn', () => {
    let state = loaded()
    state = chatReducer(state, { type: 'send', userId: 'u-live', assistantId: 'a-live', text: 'hello?' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'partial' } })
    state = chatReducer(state, { type: 'event', event: { type: 'error', reason: 'stream died' } })

    // The server persisted his message, no reply, and then a reminder fired.
    const next = polled(state, [
      server('u1', 'user', 'hello?'),
      server('r1', 'assistant', 'Reminder: stretch', 'reminder'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a-live', 'a-live:error', 'r1'])
    expect(messages(next).find(m => m.id === 'a-live')?.text).toBe('partial')
    expect(messages(next).find(m => m.id === 'r1')?.turnKind).toBe('reminder')
  })

  it('keeps a /help note where it was, with new server rows after it', () => {
    let state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'))
    state = chatReducer(state, { type: 'localMessage', id: 'local-help', text: '/clear — …' })
    const next = polled(state, [
      server('u1', 'user', 'hi'),
      server('a1', 'assistant', 'hello'),
      server('r1', 'assistant', 'Reminder: stretch', 'reminder'),
    ])
    expect(next.rows.map(r => r.id)).toEqual(['u1', 'a1', 'local-help', 'r1'])
  })

  it('is dropped while a turn streams — the live turn owns the transcript', () => {
    let state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'))
    state = chatReducer(state, { type: 'send', userId: 'u-live', assistantId: 'a-live', text: 'go' })
    // `observedRows` is the CURRENT rows, so the staleness guard passes and
    // only the streaming guard can drop this.
    const next = chatReducer(state, {
      type: 'idlePolled',
      conversationId: 'c1',
      messages: [server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'), server('r1', 'assistant', 'R', 'reminder')],
      observedRows: state.rows,
    })
    expect(next).toBe(state)
  })

  it('is dropped when it names a conversation the store has since left', () => {
    const state = loaded(server('u1', 'user', 'hi'))
    expect(polled(state, [server('u1', 'user', 'hi'), server('r1', 'assistant', 'R', 'reminder')], 'c-other')).toBe(state)
  })

  it('is dropped when the transcript moved while the fetch was in flight — a clear must stay cleared', () => {
    let state = loaded(server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello'))
    const observedAtIssue = state.rows
    // The owner clears the chat while the fetch (issued against the old
    // transcript) is still in flight...
    state = chatReducer(state, { type: 'cleared', conversationId: 'c1' })
    expect(state.rows).toEqual([])
    // ...and the stale answer arrives. It must not resurrect the rows.
    const next = chatReducer(state, {
      type: 'idlePolled',
      conversationId: 'c1',
      messages: [server('u1', 'user', 'hi'), server('a1', 'assistant', 'hello')],
      observedRows: observedAtIssue,
    })
    expect(next).toBe(state)
    expect(next.rows).toEqual([])
  })

  it('loads turn_kind onto fetched rows and leaves it null on rows it streams itself', () => {
    let state = loaded(server('r1', 'assistant', 'Reminder: stretch', 'reminder'))
    expect(messages(state)[0].turnKind).toBe('reminder')
    state = streamed(state, 'u-live', 'a-live', 'hi', 'hello')
    expect(messages(state).slice(1).map(m => m.turnKind)).toEqual([null, null])
  })
})

