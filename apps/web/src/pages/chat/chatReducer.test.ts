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
