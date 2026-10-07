import { describe, it, expect } from 'vitest'
import type { SetupCard } from '../../lib/api'
import type { StreamEvent } from '../../lib/streamChat'
import {
  chatReducer,
  emptyChat,
  type ChatAction,
  type ChatState,
  type ChatRow,
  type FetchedMessage,
} from './chatReducer'

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

  // `agent: null` on every meta event below — S12: the meta event always
  // states who ran the turn (type-level pin moved 2026-09-08).
  it('records the model and conversation from the meta frame', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'meta', conversationId: 'c7', model: 'qwen3:4b', turnId: 't1', agent: null },
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
      event: { type: 'meta', conversationId: 'c7', model: 'qwen3:8b', turnId: 't1', agent: null },
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
      event: { type: 'meta', conversationId: 'c7', model: 'qwen3:14b', turnId: 't2', agent: null },
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

  it('carries a progress percent on the marker, and drops it when the next frame has none', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'progress', detail: '42%', percent: 42 },
    })
    expect(messages(state)[1].activity).toEqual({
      tool: 'model_pull',
      status: 'progress',
      detail: '42%',
      percent: 42,
    })
    // The marker is REPLACED, never merged: a later frame with no percent
    // means the call stopped knowing its fraction, so the bar goes back to
    // indeterminate rather than staying stuck at the last number it saw.
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'progress', detail: 'verifying' },
    })
    expect(messages(state)[1].activity).toEqual({
      tool: 'model_pull',
      status: 'progress',
      detail: 'verifying',
    })
    expect(messages(state)[1].activity).not.toHaveProperty('percent')
  })

  it('a usage frame puts the turn\'s cost on the pending row; null stays null', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: {
        type: 'usage',
        usage: { rounds: 1, priced_rounds: 1, cost_usd: 0.0013, cost_basis: ['provider-reported'], prompt_tokens: 1, completion_tokens: 1, unmetered_rounds: 0, local_rounds: 0, unrecorded_rounds: 0 },
      },
    })
    expect(messages(state)[1].cost).toBe(0.0013)
    state = chatReducer(state, {
      type: 'event',
      event: {
        type: 'usage',
        usage: { rounds: 1, priced_rounds: 0, cost_usd: null, cost_basis: [], prompt_tokens: 0, completion_tokens: 0, unmetered_rounds: 1, local_rounds: 1, unrecorded_rounds: 0 },
      },
    })
    expect(messages(state)[1].cost).toBeNull()
  })

  it('a route frame keeps the gateway\'s reason and who answered on the pending row', () => {
    let state = started()
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'route', route: { role: 'chat', link: 2, reason: 'fell back to link 2', servedBy: 'hub:qwen3:8b' } },
    })
    expect(messages(state)[1].routeReason).toBe('fell back to link 2')
    expect(messages(state)[1].servedBy).toBe('hub:qwen3:8b')
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
      event: { type: 'meta', conversationId: 'c1', model: 'qwen3:8b', turnId: 't1', agent: null },
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
      event: { type: 'served', servedBy: 'hub:qwen3:8b' },
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


describe('chatReducer — agents (S12): who wrote the row, and what she delegated', () => {
  type Relay = Partial<Omit<Extract<StreamEvent, { type: 'activity' }>, 'type' | 'tool' | 'status'>>
  const meta = (agent: string | null): ChatAction => ({
    type: 'event',
    event: { type: 'meta', conversationId: 'c1', model: '', turnId: 't1', agent },
  })
  const delegate = (status: string, extra: Relay = {}): ChatAction => ({
    type: 'event',
    event: { type: 'activity', tool: 'delegate_to_agent', status, ...extra },
  })
  const step = (step: string, stepStatus: string) =>
    delegate('progress', { agent: 'coder', agentTurnId: 't-child', step, stepStatus, detail: 'coder is working…' })

  it('the meta frame names the agent on the pending row; null is Nova', () => {
    let state = chatReducer(started(), meta('coder'))
    expect(messages(state).map(m => m.agent)).toEqual([null, 'coder'])
    state = chatReducer(started(), meta(null))
    expect(messages(state)[1].agent).toBeNull()
  })

  it('a row starts with no agent and no delegation, and a meta outside a turn names nothing', () => {
    const fresh = messages(started())[1]
    expect([fresh.agent, fresh.delegation, fresh.delegationsDone, fresh.delegations]).toEqual([null, null, [], []])
    const state = chatReducer(emptyChat(), meta('coder'))
    expect(state.rows).toEqual([])
  })

  it('start → 3 steps → ok builds the delegation and closes it ok', () => {
    let state = started()
    state = chatReducer(state, delegate('start'))
    expect(messages(state)[1].delegation).toEqual({ agent: null, turnId: null, steps: [], dropped: 0, status: 'working' })
    // The delegate tool's own start is a plain tool start on the marker too.
    expect(messages(state)[1].activity).toEqual({ tool: 'delegate_to_agent', status: 'start' })
    state = chatReducer(state, step('start', 'start'))
    state = chatReducer(state, step('workspace_write_file', 'start'))
    state = chatReducer(state, step('workspace_write_file', 'ok'))
    expect(messages(state)[1].delegation).toEqual({
      agent: 'coder',
      turnId: 't-child',
      steps: [
        { step: 'start', status: 'start' },
        { step: 'workspace_write_file', status: 'start' },
        { step: 'workspace_write_file', status: 'ok' },
      ],
      dropped: 0,
      status: 'working',
    })
    state = chatReducer(state, delegate('ok'))
    expect(messages(state)[1].delegation?.status).toBe('ok')
    expect(messages(state)[1].delegation?.steps).toHaveLength(3)
    // ...and the tool's ok clears the transient marker, as for any tool.
    expect(messages(state)[1].activity).toBeNull()
  })

  it('250 steps keeps the first 200 and counts the other 50 as dropped', () => {
    let state = chatReducer(started(), delegate('start'))
    for (let i = 0; i < 250; i++) state = chatReducer(state, step(`tool_${i}`, 'ok'))
    const d = messages(state)[1].delegation
    expect(d?.steps).toHaveLength(200)
    expect(d?.steps[199].step).toBe('tool_199')
    expect(d?.dropped).toBe(50)
  })

  it('the delegate tool\'s error frame closes the delegation as error, keeping its steps', () => {
    let state = chatReducer(started(), delegate('start'))
    state = chatReducer(state, step('fetch_url', 'error'))
    state = chatReducer(state, delegate('error', { reason: 'agent coder did not finish — status error' }))
    expect(messages(state)[1].delegation).toEqual({
      agent: 'coder',
      turnId: 't-child',
      steps: [{ step: 'fetch_url', status: 'error' }],
      dropped: 0,
      status: 'error',
    })
    // The stated reason is on the marker, where the bubble reads it.
    expect(messages(state)[1].activity?.reason).toBe('agent coder did not finish — status error')
  })

  it('a plain tool\'s activity never opens a delegation, and a step after a close changes nothing', () => {
    let state = chatReducer(started(), { type: 'event', event: { type: 'activity', tool: 'get_time', status: 'start' } })
    state = chatReducer(state, { type: 'event', event: { type: 'activity', tool: 'get_time', status: 'progress', step: 'x', stepStatus: 'ok' } })
    expect(messages(state)[1].delegation).toBeNull()
    state = chatReducer(state, delegate('ok'))
    expect(messages(state)[1].delegation).toBeNull()
    state = chatReducer(state, delegate('start'))
    state = chatReducer(state, delegate('ok'))
    const closed = messages(state)[1].delegation
    state = chatReducer(state, step('late', 'ok'))
    expect(messages(state)[1].delegation).toBe(closed)
  })

  it('a second start after a close opens a new delegation and keeps the finished one in order', () => {
    let state = chatReducer(started(), delegate('start'))
    state = chatReducer(state, step('a', 'ok'))
    state = chatReducer(state, delegate('ok'))
    state = chatReducer(state, delegate('start'))
    state = chatReducer(state, delegate('progress', { agent: 'mailer', agentTurnId: 't2', step: 'b', stepStatus: 'ok' }))
    const row = messages(state)[1]
    expect(row.delegationsDone.map(d => [d.agent, d.status, d.steps.length])).toEqual([['coder', 'ok', 1]])
    expect(row.delegation).toEqual({ agent: 'mailer', turnId: 't2', steps: [{ step: 'b', status: 'ok' }], dropped: 0, status: 'working' })
  })

  it('a delegation still open when the turn ends is marked interrupted — a result was never stated', () => {
    let state = chatReducer(started(), { type: 'event', event: { type: 'delta', text: 'hmm' } })
    state = chatReducer(state, delegate('start'))
    state = chatReducer(state, step('a', 'start'))
    const done = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(messages(done)[1].delegation?.status).toBe('interrupted')
    const dropped = chatReducer(state, { type: 'event', event: { type: 'interrupted', reason: 'socket hang up' } })
    expect(messages(dropped)[1].delegation?.status).toBe('interrupted')
    const failed = chatReducer(state, { type: 'event', event: { type: 'error', reason: 'stream died' } })
    expect(messages(failed)[1].delegation?.status).toBe('interrupted')
    // A closed one is left exactly as it closed.
    const closedThenDone = chatReducer(chatReducer(state, delegate('ok')), { type: 'event', event: { type: 'done' } })
    expect(messages(closedThenDone)[1].delegation?.status).toBe('ok')
  })

  it('fetched rows keep agent and delegations verbatim, null/empty when the server stated none', () => {
    const state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: '@coder fix it', agent: null, delegations: [] },
        { id: 'a1', role: 'assistant', content: 'fixed', agent: 'coder', delegations: [] },
        {
          id: 'a2',
          role: 'assistant',
          content: 'I asked coder',
          agent: null,
          delegations: [{ agent: 'coder', agent_turn_id: 't-child', status: 'ok', files: ['agents/coder/notes.md'] }],
        },
        { id: 'a3', role: 'assistant', content: 'older core' },
      ],
    })
    const rows = messages(state)
    expect(rows.map(r => r.agent)).toEqual([null, 'coder', null, null])
    expect(rows[2].delegations).toEqual([{ agent: 'coder', agent_turn_id: 't-child', status: 'ok', files: ['agents/coder/notes.md'] }])
    expect(rows[3].delegations).toEqual([])
    // A fetched row never carries a live delegation.
    expect(rows.every(r => r.delegation === null && r.delegationsDone.length === 0)).toBe(true)
  })

  it('the idle poll sees an agent badge or a delegation the store lacks as news, and the same ones as none', () => {
    const state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat' }],
    })
    const same = chatReducer(state, {
      type: 'idlePolled',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat' }],
      observedRows: state.rows,
    })
    expect(same).toBe(state)
    const badged = chatReducer(state, {
      type: 'idlePolled',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat', agent: 'coder' },
      ],
      observedRows: state.rows,
    })
    expect(messages(badged)[1].agent).toBe('coder')
  })
})

/**
 * The queue (S15). A message sent while a turn runs is ACCEPTED, not refused
 * and not run concurrently. It is held apart from the transcript — it is not a
 * message anybody has answered yet — so the server's list can stay
 * authoritative without any of the duplicate-row merging that the transcript
 * paths do.
 */
describe('chatReducer — messages accepted while a turn runs', () => {
  const queuedEvent = {
    type: 'queued' as const,
    id: 'q1',
    conversationId: 'c1',
    body: 'actually, 12b is fine',
    ahead: 0,
  }

  it('holds an accepted message apart from the transcript, and leaves the live turn alone', () => {
    let state = chatReducer(started(), {
      type: 'event',
      event: { type: 'meta', conversationId: 'c1', model: 'm', turnId: 't-1', agent: null },
    })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'working' } })
    const rowsBefore = state.rows
    state = chatReducer(state, { type: 'event', event: queuedEvent })

    expect(state.queued).toEqual([{ id: 'q1', body: 'actually, 12b is fine', ahead: 0 }])
    expect(state.rows).toBe(rowsBefore)
    expect(state.streaming).toBe(true)
    expect(state.pendingId).not.toBeNull()
    expect(state.turnId).toBe('t-1')
  })

  it('takes one back without touching the others', () => {
    let state = chatReducer(emptyChat(), { type: 'event', event: queuedEvent })
    state = chatReducer(state, {
      type: 'event',
      event: { ...queuedEvent, id: 'q2', body: 'and another', ahead: 1 },
    })
    state = chatReducer(state, { type: 'unqueued', id: 'q1' })
    expect(state.queued).toEqual([{ id: 'q2', body: 'and another', ahead: 1 }])
    // An id that is not there changes nothing, and changes no identity either.
    const same = chatReducer(state, { type: 'unqueued', id: 'nope' })
    expect(same).toBe(state)
  })

  it('takes the server list as the truth, because the server is what runs them', () => {
    let state = chatReducer(emptyChat(), { type: 'event', event: queuedEvent })
    state = chatReducer(state, {
      type: 'queueSynced',
      queued: [{ id: 'q2', body: 'the only one left', ahead: 0 }],
    })
    expect(state.queued).toEqual([{ id: 'q2', body: 'the only one left', ahead: 0 }])
    // An unchanged list is not a new state: this arrives on every poll tick and
    // a fresh array each time would re-render the composer continuously.
    const again = chatReducer(state, {
      type: 'queueSynced',
      queued: [{ id: 'q2', body: 'the only one left', ahead: 0 }],
    })
    expect(again).toBe(state)
  })

  it('survives the poll that resolves a turn, because the queue has not run yet', () => {
    let state = chatReducer(emptyChat(), { type: 'loaded', conversationId: 'c1', messages: [] })
    state = chatReducer(state, { type: 'event', event: queuedEvent })
    state = chatReducer(state, {
      type: 'pollResolved',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: 'the first thing' },
        { id: 'a1', role: 'assistant', content: 'the first answer' },
      ],
    })
    expect(state.queued).toEqual([{ id: 'q1', body: 'actually, 12b is fine', ahead: 0 }])
    expect(messages(state)).toHaveLength(2)
  })

  it('keeps an accepted message through a clear, because the server will still run it', () => {
    // Clearing empties the transcript; it does not withdraw what core already
    // accepted, any more than it stops the turn in flight (S2c: a disconnect
    // means finish). Dropping the chip here would be the store claiming a
    // cancellation nobody performed.
    let state = chatReducer(emptyChat(), { type: 'loaded', conversationId: 'c1', messages: [] })
    state = chatReducer(state, { type: 'event', event: queuedEvent })
    expect(chatReducer(state, { type: 'cleared', conversationId: 'c1' }).queued).toEqual([
      { id: 'q1', body: 'actually, 12b is fine', ahead: 0 },
    ])
  })

  it('drops it on reset, which is a different person at the keyboard', () => {
    let state = chatReducer(emptyChat(), { type: 'loaded', conversationId: 'c1', messages: [] })
    state = chatReducer(state, { type: 'event', event: queuedEvent })
    expect(chatReducer(state, { type: 'reset' }).queued).toEqual([])
  })
})

/**
 * Stop (S15). A turn the owner stopped is not a turn that failed: the text he
 * watched stays, the note says where it stopped, and no red error row appears.
 * The turn id has to be on the state for the button to have something to
 * address — the meta frame is where it comes from.
 */
describe('chatReducer — the owner stopped the turn', () => {
  const meta = {
    type: 'meta' as const,
    conversationId: 'c1',
    model: 'qwen3:8b',
    turnId: 't-1',
    agent: null,
  }

  it('keeps the turn id from the meta frame and drops it when the turn ends', () => {
    let state = chatReducer(started(), { type: 'event', event: meta })
    expect(state.turnId).toBe('t-1')
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'hi' } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(state.turnId).toBeNull()
  })

  it('a new send clears the previous turn id, so Stop can never address a finished turn', () => {
    let state = chatReducer(started(), { type: 'event', event: meta })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    state = chatReducer(state, { type: 'send', userId: 'u2', assistantId: 'a2', text: 'again' })
    expect(state.turnId).toBeNull()
  })

  it('settles the pending row with the note, keeping the text that was watched', () => {
    let state = chatReducer(started(), { type: 'event', event: meta })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'delta', text: 'I will now do ' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'stopped', note: 'Stopped while running model_pull — you asked to stop it.' },
    })

    const row = messages(state)[1]
    expect(row.text).toBe('I will now do ')
    expect(row.stoppedNote).toBe('Stopped while running model_pull — you asked to stop it.')
    expect(row.streaming).toBe(false)
    expect(row.interrupted).toBe(false)
    expect(row.activity).toBeNull()
    expect(errors(state)).toEqual([])
    expect(state.streaming).toBe(false)
    expect(state.pendingId).toBeNull()
    expect(state.turnId).toBeNull()
  })

  it('a stop with no text yet is a note, never "finished without a reply"', () => {
    let state = chatReducer(started(), { type: 'event', event: meta })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'activity', tool: 'model_pull', status: 'start' },
    })
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'stopped', note: 'Stopped while running model_pull.' },
    })
    // The DONE frame always follows a stop; it must not turn the settled row
    // into a failure for having no prose.
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })

    expect(errors(state)).toEqual([])
    expect(messages(state)[1].stoppedNote).toBe('Stopped while running model_pull.')
    expect(messages(state)[1].text).toBe('')
  })
})

describe('chatReducer — thinking', () => {
  const think = (state: ChatState, text: string) =>
    chatReducer(state, { type: 'event', event: { type: 'thinking', text } })

  it('accumulates thinking on the pending row without touching its text', () => {
    // Two separate fields on purpose. The row's `text` is what gets
    // persisted and what every honesty guard reads; reasoning is neither.
    let state = started()
    state = think(state, 'Okay')
    state = think(state, ', so')

    const rows = messages(state)
    const row = rows[rows.length - 1]
    expect(row.thinking).toBe('Okay, so')
    expect(row.text).toBe('')
  })

  it('a reply arriving leaves the thinking where it is, in its own field', () => {
    let state = think(started(), 'hmm')
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'four' } })

    const rows = messages(state)
    const row = rows[rows.length - 1]
    expect(row.text).toBe('four')
    expect(row.thinking).toBe('hmm')
  })

  it('a row reconciled from history carries no thinking at all', () => {
    // It is live-only, so a reload must not invent one.
    const rows = messages(started())
    expect(rows[rows.length - 1].thinking).toBe('')
  })
})

/**
 * S24: a frame belongs to the conversation its stream was started for.
 *
 * Before threads there was one conversation on screen and every frame
 * belonged to it. Now: stream in the hallway, tap a stub, and the hallway's
 * remaining deltas would be appended to the ROOM's pending bubble — her
 * answer about the grocery list arriving inside a room about a failing
 * timer. Dropped by identity rather than by arrival order, because the owner
 * can switch back and forth while both are mid-turn and no ordering rule
 * survives that.
 */
describe('chatReducer — frames are keyed to their conversation', () => {
  const inConversation = (id: string): ChatState =>
    chatReducer(started(), {
      type: 'event',
      event: { type: 'meta', conversationId: id, model: 'm', turnId: 't1', agent: null },
    })

  it('drops a delta from a conversation that is no longer on screen', () => {
    const state = inConversation('room-1')
    const after = chatReducer(state, {
      type: 'event',
      event: { type: 'delta', text: 'from the hallway' },
      conversationId: 'hallway',
    })

    expect(after).toBe(state)
    const rowsAfter = messages(after)
    expect(rowsAfter[rowsAfter.length - 1].text).not.toContain('from the hallway')
  })

  it('keeps a delta from the conversation that IS on screen', () => {
    const state = inConversation('room-1')
    const after = chatReducer(state, {
      type: 'event',
      event: { type: 'delta', text: 'about this room' },
      conversationId: 'room-1',
    })

    const rows = messages(after)
    expect(rows[rows.length - 1].text).toContain('about this room')
  })

  it('accepts a stream that started before the conversation had an id', () => {
    // The first message of a brand-new chat: the id arrives on the meta
    // frame, so there was nothing to key on and nothing it could belong to.
    const after = chatReducer(started(), {
      type: 'event',
      event: { type: 'delta', text: 'hello' },
      conversationId: null,
    })
    const rows = messages(after)
    expect(rows[rows.length - 1].text).toContain('hello')
  })

  it('accepts an unkeyed event, so nothing that predates S24 breaks', () => {
    const after = chatReducer(started(), {
      type: 'event',
      event: { type: 'delta', text: 'hello' },
    })
    const rows = messages(after)
    expect(rows[rows.length - 1].text).toContain('hello')
  })
})

describe('chatReducer — the context gauge survives a reload', () => {
  const fetched = (id: string, role: string, prompt_tokens?: number) => ({
    id, role, content: 'x', ...(prompt_tokens === undefined ? {} : { prompt_tokens }),
  })

  it('adopts the NEWEST answered turn\'s prompt size', () => {
    // Only the last turn's figure describes the context as it now stands;
    // an older, smaller one would under-report it.
    const state = chatReducer(emptyChat(), {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [fetched('a', 'assistant', 4000), fetched('b', 'user'), fetched('c', 'assistant', 9000)],
    })
    expect(state.promptTokens).toBe(9000)
  })

  it('reports null when no turn stated one, rather than zero', () => {
    // A null is not an empty context — it is a turn nobody measured.
    const state = chatReducer(emptyChat(), {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [fetched('a', 'user'), fetched('b', 'assistant')],
    })
    expect(state.promptTokens).toBeNull()
  })

  it('a live usage frame replaces it', () => {
    let state = chatReducer(emptyChat(), {
      type: 'reconcile',
      conversationId: 'c1',
      messages: [fetched('a', 'assistant', 4000)],
    })
    state = chatReducer(state, { type: 'send', userId: 'u', assistantId: 'a2', text: 'hi' })
    state = chatReducer(state, {
      type: 'event',
      event: {
        type: 'usage',
        usage: {
          rounds: 1,
          priced_rounds: 1,
          cost_usd: 0,
          cost_basis: [],
          prompt_tokens: 12_000,
          completion_tokens: 40,
          unmetered_rounds: 0,
          local_rounds: 1,
          unrecorded_rounds: 0,
        },
      },
    })
    expect(state.promptTokens).toBe(12_000)
  })
})

const LIVE = {
  kind: 'setup_qr' as const,
  setup: 'add_machine',
  address: 'https://nova.fake-tailnet.ts.net',
  url: 'https://nova.fake-tailnet.ts.net/add#ABCD-2345',
  code: 'ABCD-2345',
  expires_at: '2026-09-25T14:10:00+00:00',
}
const REDRAWN = {
  kind: 'setup_qr' as const,
  setup: 'add_machine',
  address: 'https://nova.fake-tailnet.ts.net',
  url: 'https://nova.fake-tailnet.ts.net/add',
  code_shown: true,
  expires_at: '2026-09-25T14:10:00+00:00',
}

function withMeta(): ChatState {
  return chatReducer(started(), {
    type: 'event',
    event: { type: 'meta', conversationId: 'c1', model: 'qwen3:8b', turnId: 't1', agent: null },
  })
}

describe('setup cards (S47)', () => {
  it('a card frame lands on the pending row', () => {
    const state = chatReducer(withMeta(), { type: 'event', event: { type: 'card', card: LIVE } })
    expect(messages(state)[1].cards).toEqual([LIVE])
  })

  it('a reply that is only a card is kept, never replaced by "no reply"', () => {
    let state = chatReducer(withMeta(), { type: 'event', event: { type: 'card', card: LIVE } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    expect(errors(state)).toEqual([])
    expect(messages(state)[1].cards).toEqual([LIVE])
  })

  it('a fetched row carries its cards verbatim, and none when the server stated none', () => {
    const state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: 'add my laptop' },
        { id: 'a1', role: 'assistant', content: 'Scan the card.', cards: [REDRAWN] },
        { id: 'a2', role: 'assistant', content: 'older core' },
      ],
    })
    expect(messages(state)[1].cards).toEqual([REDRAWN])
    expect(messages(state)[2].cards).toEqual([])
  })

  it('the idle poll keeps a live code on the card the server redrew without one (Review Focus 4)', () => {
    let state = chatReducer(withMeta(), { type: 'event', event: { type: 'delta', text: 'Scan the card.' } })
    state = chatReducer(state, { type: 'event', event: { type: 'card', card: LIVE } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    const fetched = [
      { id: 'srv-u', role: 'user', content: 'hello' },
      { id: 'srv-a', role: 'assistant', content: 'Scan the card.', turn_kind: 'chat', cards: [REDRAWN] },
    ]
    const once = chatReducer(state, { type: 'idlePolled', conversationId: 'c1', messages: fetched, observedRows: state.rows })
    expect(messages(once)[1].cards[0].code).toBe('ABCD-2345')
    const twice = chatReducer(once, { type: 'idlePolled', conversationId: 'c1', messages: fetched, observedRows: once.rows })
    expect(messages(twice)[1].cards[0].code).toBe('ABCD-2345')
    expect(twice).toBe(once)
  })

  it('keeps a live code whose server twin has not landed yet, then attaches it once the twin arrives (round 1, Important #2)', () => {
    // The span that would persist the card lands in close_turn AFTER [DONE],
    // and a failed close is only logged — a poll can land in that gap, where
    // the message row itself exists (matched by turn_kind='chat') but its
    // `cards` have not caught up yet. Dropping the live card here would take
    // a still-valid code off the screen for no reason the owner caused.
    let state = chatReducer(withMeta(), { type: 'event', event: { type: 'delta', text: 'Scan the card.' } })
    state = chatReducer(state, { type: 'event', event: { type: 'card', card: LIVE } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })

    // (a) No twin at all yet — the live card, code and all, survives.
    const noCardsYet = [
      { id: 'srv-u', role: 'user', content: 'hello' },
      { id: 'srv-a', role: 'assistant', content: 'Scan the card.', turn_kind: 'chat' },
    ]
    const once = chatReducer(state, { type: 'idlePolled', conversationId: 'c1', messages: noCardsYet, observedRows: state.rows })
    expect(messages(once)[1].cards).toEqual([LIVE])

    // (b) The next poll brings the twin: the code attaches to it — one
    // card, never two.
    const withTwin = [
      { id: 'srv-u', role: 'user', content: 'hello' },
      { id: 'srv-a', role: 'assistant', content: 'Scan the card.', turn_kind: 'chat', cards: [REDRAWN] },
    ]
    const twice = chatReducer(once, { type: 'idlePolled', conversationId: 'c1', messages: withTwin, observedRows: once.rows })
    expect(messages(twice)[1].cards).toHaveLength(1)
    expect(messages(twice)[1].cards[0].code).toBe('ABCD-2345')

    // (c) A third, identical poll is a no-op.
    const thrice = chatReducer(twice, { type: 'idlePolled', conversationId: 'c1', messages: withTwin, observedRows: twice.rows })
    expect(thrice).toBe(twice)
  })

  it('matches each of two live cards to its own twin by expiry — in order, each twin used once (round 1, Folded Minor #3)', () => {
    const CARD_A = {
      kind: 'setup_qr' as const,
      setup: 'add_machine',
      address: 'https://nova.fake-tailnet.ts.net',
      url: 'https://nova.fake-tailnet.ts.net/add#AAAA-1111',
      code: 'AAAA-1111',
      expires_at: '2026-09-25T14:10:00+00:00',
    }
    const CARD_B = {
      kind: 'setup_qr' as const,
      setup: 'add_machine',
      address: 'https://nova.fake-tailnet.ts.net',
      url: 'https://nova.fake-tailnet.ts.net/add#BBBB-2222',
      code: 'BBBB-2222',
      expires_at: '2026-09-25T15:00:00+00:00',
    }
    const REDRAWN_A = {
      kind: 'setup_qr' as const,
      setup: 'add_machine',
      address: 'https://nova.fake-tailnet.ts.net',
      url: 'https://nova.fake-tailnet.ts.net/add',
      code_shown: true,
      expires_at: '2026-09-25T14:10:00+00:00',
    }
    const REDRAWN_B = {
      kind: 'setup_qr' as const,
      setup: 'add_machine',
      address: 'https://nova.fake-tailnet.ts.net',
      url: 'https://nova.fake-tailnet.ts.net/add',
      code_shown: true,
      expires_at: '2026-09-25T15:00:00+00:00',
    }

    let state = chatReducer(withMeta(), { type: 'event', event: { type: 'delta', text: 'Two machines to add.' } })
    state = chatReducer(state, { type: 'event', event: { type: 'card', card: CARD_A } })
    state = chatReducer(state, { type: 'event', event: { type: 'card', card: CARD_B } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })

    const fetched = [
      { id: 'srv-u', role: 'user', content: 'hello' },
      { id: 'srv-a', role: 'assistant', content: 'Two machines to add.', turn_kind: 'chat', cards: [REDRAWN_A, REDRAWN_B] },
    ]
    const polled = chatReducer(state, { type: 'idlePolled', conversationId: 'c1', messages: fetched, observedRows: state.rows })
    expect(messages(polled)[1].cards).toEqual([
      { ...REDRAWN_A, code: 'AAAA-1111', url: CARD_A.url },
      { ...REDRAWN_B, code: 'BBBB-2222', url: CARD_B.url },
    ])
  })

  it('the idle poll treats a new card as news', () => {
    const state = chatReducer(emptyChat(), {
      type: 'loaded',
      conversationId: 'c1',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat' }],
    })
    const carded = chatReducer(state, {
      type: 'idlePolled',
      conversationId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat', cards: [REDRAWN] },
      ],
      observedRows: state.rows,
    })
    expect(messages(carded)[1].cards).toEqual([REDRAWN])
  })
})

// card-keeps-commands T1. A machine card's live frame carries more than its
// code: the command for each OS (the code inside each), where each was walked,
// one note per OS and the hub build's version. Core's redraw (conversations.py
// _card_json) carries none of those, by design. While this tab holds the live
// card, an idle poll must not cut it down to the redraw: the owner watched her
// command vanish about 15 s after her reply (the first idle poll), with
// "No command:" in its place.
const CARD_ORIGIN = 'https://nova.example.com'

/** The parts of a live machine card the tab keeps for as long as it holds the card. */
const LIVE_PARTS = ['code', 'url', 'commands', 'walks', 'notes', 'version', 'machine', 'for_os', 'expires_at'] as const

function liveParts(card: SetupCard): Record<string, unknown> {
  return Object.fromEntries(LIVE_PARTS.map(key => [key, card[key]]))
}

/** `card` carries each of the nine parts exactly as `live`'s frame did. */
function expectWhole(card: SetupCard | undefined, live: SetupCard) {
  // A fixture missing a part would let the same part missing on `card` pass unseen.
  for (const key of LIVE_PARTS) expect(live[key], `the live frame's ${key}`).toBeTruthy()
  expect(card, 'the card').toBeDefined()
  expect(liveParts(card as SetupCard)).toEqual(liveParts(live))
}

/** A machine card as its live frame carries it (services/core/app/tools/setup.py,
 *  send_machine_card): the code in its url and in every command. Its walks and
 *  notes name the machine, so two cards never share one. */
function machineCard(code: string, expiresAt: string, machine: string, forOs: string): SetupCard {
  return {
    kind: 'setup_qr',
    setup: 'add_machine',
    address: CARD_ORIGIN,
    url: `${CARD_ORIGIN}/add#${code}`,
    code,
    expires_at: expiresAt,
    machine,
    for_os: forOs,
    commands: {
      linux: `curl -fsSL -o novad ${CARD_ORIGIN}/api/v1/agent/dist/novad-linux-amd64 && ./novad install --hub ${CARD_ORIGIN} --code ${code}`,
      macos: `curl -fsSL -o novad ${CARD_ORIGIN}/api/v1/agent/dist/novad-darwin-arm64 && ./novad install --hub ${CARD_ORIGIN} --code ${code}`,
      windows: `curl.exe -fsSL -o novad.exe ${CARD_ORIGIN}/api/v1/agent/dist/novad-windows-amd64.exe; ./novad.exe install --hub ${CARD_ORIGIN} --code ${code}`,
    },
    walks: {
      linux: `Linux: walked on real hardware (${machine})`,
      macos: `macOS: built and tested in CI, not walked on a Mac (${machine})`,
      windows: `Windows: walked on real hardware (${machine})`,
    },
    notes: {
      linux: `The Linux note (${machine}).`,
      macos: `The macOS note (${machine}).`,
      windows: `The Windows note (${machine}).`,
    },
    version: '0.0.0-example',
  }
}

/** Core's redraw of `live` (services/core/app/conversations.py _card_json): the
 *  url without the code, code_shown, expires_at, machine, for_os and that OS's
 *  walk. Never the code, commands, walks, notes or version. */
function redrawOf(live: SetupCard) {
  return {
    kind: 'setup_qr' as const,
    setup: live.setup,
    address: live.address,
    url: live.url.split('#')[0],
    code_shown: true,
    expires_at: live.expires_at,
    machine: live.machine,
    for_os: live.for_os,
    walk: live.walks?.[live.for_os ?? ''],
  }
}

/** GET .../messages for the one turn, as core lists it: his ask and her reply,
 *  new objects on every call, as each fetch parses its own. */
function turnRows(cards: SetupCard[], reply: Partial<FetchedMessage> = {}): FetchedMessage[] {
  return JSON.parse(
    JSON.stringify([
      { id: 'srv-u', role: 'user', content: 'hello', served_by: null, cards: [] },
      { id: 'srv-a', role: 'assistant', content: 'Scan the card.', turn_kind: 'chat', served_by: null, cards, ...reply },
    ]),
  )
}

/** This tab streams her reply with these card frames, then the turn ends. */
function streamedWith(...cards: SetupCard[]): ChatState {
  let state = chatReducer(withMeta(), { type: 'event', event: { type: 'delta', text: 'Scan the card.' } })
  for (const card of cards) {
    // A copy: streamChat builds each card afresh from its frame.
    state = chatReducer(state, { type: 'event', event: { type: 'card', card: JSON.parse(JSON.stringify(card)) } })
  }
  return chatReducer(state, { type: 'event', event: { type: 'done' } })
}

function idlePoll(state: ChatState, rows: FetchedMessage[]): ChatState {
  return chatReducer(state, { type: 'idlePolled', conversationId: 'c1', messages: rows, observedRows: state.rows })
}

/** Her reply as it streamed, tool-call markup and all. Core stores it without
 *  the markup (without_markup), so the store's copy says something else. */
const STREAMED_WITH_MARKUP = 'Scan the card. <tool_call>…</tool_call>'

/** He typed /help, then asked, and this tab streamed her reply (with markup)
 *  and `card`: the store holds local-0, u1, a1, so the card's row sits one
 *  place further down the store than in core's list. */
function streamedAfterHelp(card: SetupCard): ChatState {
  let state = chatReducer(emptyChat(), { type: 'localMessage', id: 'local-0', text: '/help: the commands you can type' })
  state = chatReducer(state, { type: 'send', userId: 'u1', assistantId: 'a1', text: 'hello' })
  state = chatReducer(state, {
    type: 'event',
    event: { type: 'meta', conversationId: 'c1', model: 'qwen3:8b', turnId: 't1', agent: null },
  })
  state = chatReducer(state, { type: 'event', event: { type: 'delta', text: STREAMED_WITH_MARKUP } })
  // A copy: streamChat builds each card afresh from its frame.
  state = chatReducer(state, { type: 'event', event: { type: 'card', card: JSON.parse(JSON.stringify(card)) } })
  state = chatReducer(state, { type: 'event', event: { type: 'done' } })
  expect(state.rows.map(row => row.id)).toEqual(['local-0', 'u1', 'a1'])
  expect(messages(state)[2].text).toBe(STREAMED_WITH_MARKUP)
  // A fixture whose stored reply said the same would not show a match by her text.
  expect(turnRows([])[1].content).not.toBe(STREAMED_WITH_MARKUP)
  return state
}

describe('setup cards (S47): a card this tab streamed stays whole through idle polls', () => {
  const LIVE = machineCard('WXYZ2345', '2026-09-25T14:10:00.123456+00:00', 'EXAMPLE-DESKTOP', 'windows')

  it('one idle poll that brings core\'s code-less redraw keeps every part the live frame carried', () => {
    const polled = idlePoll(streamedWith(LIVE), turnRows([redrawOf(LIVE)]))
    // The poll was adopted: the rows are core's now, and her reply is there once.
    expect(polled.rows.map(row => row.id)).toEqual(['srv-u', 'srv-a'])
    const cards = messages(polled)[1].cards
    expect(cards).toHaveLength(1)
    expectWhole(cards[0], LIVE)
  })

  it('poll after poll: a second and a third identical poll are no news, and the card is still whole after each', () => {
    const once = idlePoll(streamedWith(LIVE), turnRows([redrawOf(LIVE)]))
    const twice = idlePoll(once, turnRows([redrawOf(LIVE)]))
    const thrice = idlePoll(twice, turnRows([redrawOf(LIVE)]))
    expect(twice).toBe(once)
    expect(thrice).toBe(twice)
    for (const state of [once, twice, thrice]) {
      expect(messages(state)[1].cards).toHaveLength(1)
      expectWhole(messages(state)[1].cards[0], LIVE)
    }
  })

  it('a twin that lands late: the poll before it keeps the live card whole, and the poll that brings it, alone or with the row\'s served_by, leaves one whole card', () => {
    // close_turn writes the turn's spans after [DONE], in one transaction: a
    // poll can find her reply with no card and no served_by yet, and the next
    // one brings both.
    const before = idlePoll(streamedWith(LIVE), turnRows([]))
    expect(before.rows.map(row => row.id)).toEqual(['srv-u', 'srv-a'])
    expect(messages(before)[1].cards).toHaveLength(1)
    expectWhole(messages(before)[1].cards[0], LIVE)

    const twinAlone = idlePoll(before, turnRows([redrawOf(LIVE)]))
    expect(messages(twinAlone)[1].cards).toHaveLength(1)
    expectWhole(messages(twinAlone)[1].cards[0], LIVE)

    const twinAndServedBy = idlePoll(before, turnRows([redrawOf(LIVE)], { served_by: 'ollama:qwen3:8b' }))
    // News on the row, so this poll is adopted rather than dropped as no news.
    expect(messages(twinAndServedBy)[1].servedBy).toBe('ollama:qwen3:8b')
    expect(messages(twinAndServedBy)[1].cards).toHaveLength(1)
    expectWhole(messages(twinAndServedBy)[1].cards[0], LIVE)
  })

  it('two live cards in one row each keep their own parts, never crossed, whichever order core lists their twins in', () => {
    const A = machineCard('AAAA2345', '2026-09-25T14:10:00.123456+00:00', 'EXAMPLE-LAPTOP', 'linux')
    const B = machineCard('BBBB6789', '2026-09-25T15:00:00.654321+00:00', 'EXAMPLE-DESKTOP', 'windows')
    const streamed = streamedWith(A, B)
    for (const twins of [[redrawOf(A), redrawOf(B)], [redrawOf(B), redrawOf(A)]]) {
      const cards = messages(idlePoll(streamed, turnRows(twins)))[1].cards
      expect(cards).toHaveLength(2)
      expectWhole(cards.find(card => card.code === A.code), A)
      expectWhole(cards.find(card => card.code === B.code), B)
    }
  })

  it('two live cards in one row each lie over their own twin (same expiry), in the place core lists it, never over the other\'s', () => {
    // Every part a live frame carries wins over its twin, so a live card laid
    // over the OTHER card's twin still shows its own nine parts. What gives a
    // crossed pairing away is the twin's own parts (code_shown, and the walk
    // core redrew for that card's OS) and the twin's place in core's list.
    const A = machineCard('AAAA2345', '2026-09-25T14:10:00.123456+00:00', 'EXAMPLE-LAPTOP', 'linux')
    const B = machineCard('BBBB6789', '2026-09-25T15:00:00.654321+00:00', 'EXAMPLE-DESKTOP', 'windows')
    // A fixture whose two redraws shared a walk could not show a crossed one.
    expect(redrawOf(A).walk).not.toBe(redrawOf(B).walk)
    const streamed = streamedWith(A, B)
    for (const [first, second] of [[A, B], [B, A]]) {
      const cards = messages(idlePoll(streamed, turnRows([redrawOf(first), redrawOf(second)])))[1].cards
      expect(cards).toEqual([
        { ...redrawOf(first), ...first },
        { ...redrawOf(second), ...second },
      ])
    }
  })

  it('a store that never streamed the card (a reload) draws core\'s redraw exactly, poll after poll, while the tab that streamed it keeps it whole', () => {
    // A reload: the card reaches this store only as core's redraw.
    let reloaded = chatReducer(emptyChat(), { type: 'loaded', conversationId: 'c1', messages: turnRows([redrawOf(LIVE)]) })
    for (let poll = 0; poll < 3; poll++) reloaded = idlePoll(reloaded, turnRows([redrawOf(LIVE)]))
    const redrawn = messages(reloaded)[1].cards
    expect(redrawn).toEqual([redrawOf(LIVE)])
    for (const key of ['code', 'commands', 'walks', 'notes', 'version'] as const) {
      expect(redrawn[0][key], `a reloaded card's ${key}`).toBeUndefined()
    }
    // The same rows, polled into the tab that streamed the card, leave it whole.
    const streamed = idlePoll(streamedWith(LIVE), turnRows([redrawOf(LIVE)]))
    expectWhole(messages(streamed)[1].cards[0], LIVE)
  })

  it('the card\'s row is found by his text and the reply right after it, then by its id, never by its place or her text: with a /help note before the turn and her reply stored without its markup, the card stays whole poll after poll', () => {
    const streamed = streamedAfterHelp(LIVE)
    const stored = turnRows([redrawOf(LIVE)])[1].content
    const once = idlePoll(streamed, turnRows([redrawOf(LIVE)]))
    const twice = idlePoll(once, turnRows([redrawOf(LIVE)]))
    for (const [poll, state] of [['first poll', once], ['second poll', twice]] as const) {
      // The note stays where it was, and the turn is core's now: her reply
      // once, in core's words, one place further down than in core's list.
      expect(state.rows.map(row => row.id), poll).toEqual(['local-0', 'srv-u', 'srv-a'])
      expect(messages(state)[2].text, poll).toBe(stored)
      expect(messages(state)[2].cards, poll).toHaveLength(1)
      expectWhole(messages(state)[2].cards[0], LIVE)
    }
  })
})

// card-keeps-commands T2. pollResolved is the authoritative replace that a
// rewind's reload and the pending-turn poll's resolve both dispatch (ChatPage
// rewindTo and pollForReply, through chat-store's resolveServerTurn). Its rows
// are core's, so her reply carries core's code-less redraw. A card this tab
// streamed must stay whole on that row all the same, whether the store holds
// the row under the client id it streamed it with or the server id an idle
// poll gave it. A card whose row the fetch no longer holds goes with its row.

/** A later turn as core lists it: his next message and her reply to it. */
function laterTurn(): FetchedMessage[] {
  return [
    { id: 'srv-u2', role: 'user', content: 'and the laptop?', served_by: null, cards: [] },
    { id: 'srv-a2', role: 'assistant', content: 'The laptop is next.', turn_kind: 'chat', served_by: null, cards: [] },
  ]
}

/** Core's rewind marker (services/core/app/rewinds.py): a row core composes,
 *  role 'user' with `rewind` set, listed right after the message it rewound
 *  to. GET .../messages leaves out every row the rewind withdrew. */
function rewindMarker(target: FetchedMessage, withdrawn: number): FetchedMessage {
  return {
    id: 'srv-m',
    role: 'user',
    content:
      `[rewind] The owner rewound this conversation to his message "${target.content}"` +
      ` - ${withdrawn} later ${withdrawn === 1 ? 'message' : 'messages'} withdrawn. Chat only: no actions were reverted.`,
    served_by: null,
    turn_kind: null,
    cards: [],
    rewind: { id: 'rw-1', mode: 'chat', target_message_id: target.id, withdrawn, undone: [], not_undone: [] },
  }
}

function resolvePoll(state: ChatState, rows: FetchedMessage[]): ChatState {
  return chatReducer(state, { type: 'pollResolved', conversationId: 'c1', messages: rows })
}

/** This tab streamed `cards` on her reply and holds that turn under its client
 *  ids (u1/a1: no idle poll since the stream ended), or under its server ids
 *  (srv-u/srv-a: an idle poll that brought `twins` on her reply re-keyed it). */
function heldUnder(ids: 'client ids' | 'server ids', cards: SetupCard[], twins: SetupCard[]): ChatState {
  const streamed = streamedWith(...cards)
  const state = ids === 'client ids' ? streamed : idlePoll(streamed, turnRows(twins))
  expect(state.rows.map(row => row.id), ids).toEqual(ids === 'client ids' ? ['u1', 'a1'] : ['srv-u', 'srv-a'])
  return state
}

describe('setup cards (S47): a card this tab streamed stays whole through pollResolved', () => {
  const CODE = 'WXYZ2345'
  const LIVE = machineCard(CODE, '2026-09-25T14:10:00.123456+00:00', 'EXAMPLE-DESKTOP', 'windows')

  it('a rewind to his later message, the card\'s row under its server id: the rows are core\'s, the card on its twin is whole, and an idle poll after it is no news', () => {
    // An idle poll re-keyed the card's turn. He asked again, she answered, and
    // the next idle poll re-keyed that turn too, so his later message is a
    // stored row the rewind control can address.
    let state = heldUnder('server ids', [LIVE], [redrawOf(LIVE)])
    state = chatReducer(state, { type: 'send', userId: 'u2', assistantId: 'a2', text: 'and the laptop?' })
    state = chatReducer(state, { type: 'event', event: { type: 'delta', text: 'The laptop is next.' } })
    state = chatReducer(state, { type: 'event', event: { type: 'done' } })
    state = idlePoll(state, [...turnRows([redrawOf(LIVE)]), ...laterTurn()])
    expect(state.rows.map(row => row.id)).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-a2'])
    expectWhole(messages(state)[1].cards[0], LIVE)

    // He rewinds to that later message: core withdraws her reply to it and
    // lists its marker after it. The reload hands those rows to pollResolved.
    const rewound = (): FetchedMessage[] => {
      const [ask] = laterTurn()
      return [...turnRows([redrawOf(LIVE)]), ask, rewindMarker(ask, 1)]
    }
    const fetched = rewound()
    const resolved = resolvePoll(state, fetched)
    expect(resolved.rows.map(row => row.id)).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-m'])
    expect(messages(resolved).map(m => [m.role, m.text])).toEqual(fetched.map(m => [m.role, m.content]))
    const cards = messages(resolved)[1].cards
    expect(cards).toHaveLength(1)
    expectWhole(cards[0], LIVE)

    // The idle poll after it brings the same rows: no news, and the card is still whole.
    const after = idlePoll(resolved, rewound())
    expect(after).toBe(resolved)
    expect(messages(after)[1].cards).toHaveLength(1)
    expectWhole(messages(after)[1].cards[0], LIVE)
  })

  it('the pending-turn poll\'s resolve, the card\'s turn under its client ids: the rows are core\'s, her reply once, no client row left, and the card on its twin is whole', () => {
    // He left /chat within 15 s of her reply, so no idle poll re-keyed the
    // turn. A /help note and a send core did not take are client-only rows.
    let state = heldUnder('client ids', [LIVE], [])
    state = chatReducer(state, { type: 'localMessage', id: 'local-1', text: '/clear: clear this chat' })
    state = chatReducer(state, { type: 'queueFailed', reason: 'could not reach Nova — Failed to fetch' })
    expect(state.rows.map(row => row.id)).toEqual(['u1', 'a1', 'local-1', 'queue-err-3'])

    // Back on /chat, the pending-turn poll resolves: the card's turn (his same
    // text, core's redraw on her reply), then the turn core had pending.
    const fetched = [...turnRows([redrawOf(LIVE)]), ...laterTurn()]
    const resolved = resolvePoll(state, fetched)
    expect(resolved.rows.map(row => row.id)).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-a2'])
    expect(messages(resolved).map(m => [m.role, m.text])).toEqual(fetched.map(m => [m.role, m.content]))
    expect(messages(resolved).filter(m => m.text === 'Scan the card.')).toHaveLength(1)
    expect(errors(resolved)).toEqual([])
    const cards = messages(resolved)[1].cards
    expect(cards).toHaveLength(1)
    expectWhole(cards[0], LIVE)
  })

  it('the card\'s row is found as the idle poll finds it, by its id or by his text and the reply right after it, never by its place or her text: a /help note before the turn and a reply core stored without its markup leave the card whole, under either id', () => {
    // He typed /help before asking, so the store holds a row core never had and
    // the card's row sits one place further down the store than in core's
    // list. Core also stores her reply without the tool-call markup that
    // streamed (without_markup), so the store's copy of it says something else.
    const streamed = streamedAfterHelp(LIVE)
    const stored = turnRows([redrawOf(LIVE)])[1].content
    const held = {
      'client ids': streamed,
      // An idle poll re-keys the turn and keeps the /help note before it.
      'server ids': idlePoll(streamed, turnRows([redrawOf(LIVE)])),
    }
    for (const ids of ['client ids', 'server ids'] as const) {
      const state = held[ids]
      expect(state.rows.map(row => row.id), ids).toEqual(
        ids === 'client ids' ? ['local-0', 'u1', 'a1'] : ['local-0', 'srv-u', 'srv-a'],
      )
      expect(messages(state)[2].text, ids).toBe(ids === 'client ids' ? STREAMED_WITH_MARKUP : stored)
      expectWhole(messages(state)[2].cards[0], LIVE)

      const resolved = resolvePoll(state, [...turnRows([redrawOf(LIVE)]), ...laterTurn()])
      expect(resolved.rows.map(row => row.id), ids).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-a2'])
      expect(messages(resolved)[1].text, ids).toBe(stored)
      const cards = messages(resolved)[1].cards
      expect(cards, ids).toHaveLength(1)
      expectWhole(cards[0], LIVE)
    }
  })

  it('a card follows its row, under either id: a rewind that withdrew the row leaves no card and no code, and a row with no twin on it keeps the live card whole', () => {
    for (const ids of ['client ids', 'server ids'] as const) {
      // (a) He rewinds to his message in the card's turn: core withdraws her
      // reply, so the fetch ends with his message and core's marker.
      const [ask] = turnRows([redrawOf(LIVE)])
      const withdrawn = resolvePoll(heldUnder(ids, [LIVE], [redrawOf(LIVE)]), [ask, rewindMarker(ask, 1)])
      expect(withdrawn.rows.map(row => row.id), ids).toEqual(['srv-u', 'srv-m'])
      expect(messages(withdrawn).flatMap(m => m.cards), ids).toEqual([])
      expect(JSON.stringify(withdrawn.rows), ids).not.toContain(CODE)
    }
    for (const ids of ['client ids', 'server ids'] as const) {
      // (b) Her reply is there with no twin on it. Only a failed close_turn
      // leaves that, so no poll ever brought one, and the live card stays.
      const held = heldUnder(ids, [LIVE], [])
      expectWhole(messages(held)[1].cards[0], LIVE)
      const kept = resolvePoll(held, [...turnRows([]), ...laterTurn()])
      expect(kept.rows.map(row => row.id), ids).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-a2'])
      const cards = messages(kept)[1].cards
      expect(cards, ids).toHaveLength(1)
      expectWhole(cards[0], LIVE)
    }
  })

  it('two live cards in one row each lie over their own twin, in the place core lists it, whichever order core lists them and whichever id the store holds the row under', () => {
    const A = machineCard('AAAA2345', '2026-09-25T14:10:00.123456+00:00', 'EXAMPLE-LAPTOP', 'linux')
    const B = machineCard('BBBB6789', '2026-09-25T15:00:00.654321+00:00', 'EXAMPLE-DESKTOP', 'windows')
    // A fixture whose two redraws shared a walk could not show a crossed one.
    expect(redrawOf(A).walk).not.toBe(redrawOf(B).walk)
    for (const [first, second] of [[A, B], [B, A]]) {
      for (const ids of ['client ids', 'server ids'] as const) {
        const held = heldUnder(ids, [A, B], [redrawOf(first), redrawOf(second)])
        const resolved = resolvePoll(held, [...turnRows([redrawOf(first), redrawOf(second)]), ...laterTurn()])
        expect(resolved.rows.map(row => row.id), ids).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-a2'])
        expect(messages(resolved)[1].cards, `${ids}, ${first.machine}'s twin listed first`).toEqual([
          { ...redrawOf(first), ...first },
          { ...redrawOf(second), ...second },
        ])
      }
    }
  })

  it('a store that never streamed the card (the S2c hard-refresh resolve) keeps core\'s redraw exactly, while the tab that streamed it keeps it whole', () => {
    const fetched = () => [...turnRows([redrawOf(LIVE)]), ...laterTurn()]
    // A hard refresh: the card reaches this store only as core's redraw, and
    // the pending-turn poll then resolves the turn that was still running.
    const reloaded = chatReducer(emptyChat(), { type: 'loaded', conversationId: 'c1', messages: turnRows([redrawOf(LIVE)]) })
    const resolvedReload = resolvePoll(reloaded, fetched())
    expect(resolvedReload.rows.map(row => row.id)).toEqual(['srv-u', 'srv-a', 'srv-u2', 'srv-a2'])
    const redrawn = messages(resolvedReload)[1].cards
    expect(redrawn).toEqual([redrawOf(LIVE)])
    for (const key of ['code', 'commands', 'walks', 'notes', 'version'] as const) {
      expect(redrawn[0][key], `a reloaded card's ${key}`).toBeUndefined()
    }
    // The same rows, resolved into the tab that streamed the card, leave it whole.
    const streamed = resolvePoll(heldUnder('client ids', [LIVE], []), fetched())
    expectWhole(messages(streamed)[1].cards[0], LIVE)
  })
})

// said-not-done fix round 3 (T6): a `correction` frame is part of the message
// the owner reads — live, not only after a reload re-reads the stored reply.
describe('chatReducer — correction frames', () => {
  const SAID = 'Notepad is now open on your DELL-XPS-8950.'
  const RECORD = '(No device_launch_app or device_run call ran on DELL-XPS-8950 this turn.)'

  function event(state: ChatState, e: StreamEvent): ChatState {
    return chatReducer(state, { type: 'event', event: e })
  }

  it('joins the reply as its own paragraph, exactly as core stores it', () => {
    let state = started()
    state = event(state, { type: 'delta', text: SAID })
    state = event(state, { type: 'correction', text: RECORD })
    state = event(state, { type: 'done' })
    // core appends a correction to the stored reply as "\n\n" + correction
    expect(messages(state)[1].text).toBe(`${SAID}\n\n${RECORD}`)
    expect(messages(state)[1].streaming).toBe(false)
    expect(errors(state)).toEqual([])
  })

  it('keeps each correction, in order, one paragraph each', () => {
    let state = started()
    state = event(state, { type: 'delta', text: 'Here you go:' })
    state = event(state, { type: 'correction', text: '(I wrote device_run as text; it did not run.)' })
    state = event(state, { type: 'correction', text: RECORD })
    expect(messages(state)[1].text).toBe(
      `Here you go:\n\n(I wrote device_run as text; it did not run.)\n\n${RECORD}`,
    )
  })

  it('text that streams after a correction starts its own paragraph', () => {
    // A redirect's note, then the reply it introduces.
    let state = started()
    state = event(state, { type: 'delta', text: 'Looks like the device is still offline.' })
    state = event(state, { type: 'correction', text: 'Checking the device now instead of describing it unchecked.' })
    state = event(state, { type: 'delta', text: 'DELL-XPS-8950 ' })
    state = event(state, { type: 'delta', text: 'is online.' })
    expect(messages(state)[1].text).toBe(
      'Looks like the device is still offline.\n\n' +
        'Checking the device now instead of describing it unchecked.\n\n' +
        'DELL-XPS-8950 is online.',
    )
  })

  it('is a no-op once the turn has no pending row', () => {
    const state = event(emptyChat(), { type: 'correction', text: RECORD })
    expect(state).toEqual(emptyChat())
  })
})
