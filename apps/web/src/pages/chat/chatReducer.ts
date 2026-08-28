import type { StreamEvent } from '../../lib/streamChat'

/**
 * The chat transcript as a pure reduction over stream events.
 *
 * The rule the whole file exists to enforce: a failure is never an assistant
 * bubble. An error frame produces its own row; a turn that ends without a
 * reply produces an error row rather than an empty bubble; a dropped
 * connection keeps whatever text really arrived and says it was cut off.
 */

export type MessageRow = {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
  interrupted: boolean
}

export type ErrorRow = {
  kind: 'error'
  id: string
  reason: string
}

export type ChatRow = MessageRow | ErrorRow

export interface ChatState {
  rows: ChatRow[]
  streaming: boolean
  conversationId: string | null
  model: string | null
  /** The assistant row currently being filled, if a turn is in flight. */
  pendingId: string | null
}

export type ChatAction =
  | {
      type: 'loaded'
      conversationId: string
      messages: { id: string; role: string; content: string }[]
    }
  | { type: 'send'; userId: string; assistantId: string; text: string }
  | { type: 'event'; event: StreamEvent }

export const NO_REPLY = 'the turn finished without a reply'

export function emptyChat(): ChatState {
  return { rows: [], streaming: false, conversationId: null, model: null, pendingId: null }
}

function message(row: Partial<MessageRow> & { id: string; role: MessageRow['role'] }): MessageRow {
  return { kind: 'message', text: '', streaming: false, interrupted: false, ...row }
}

function withPending(state: ChatState, apply: (row: MessageRow) => MessageRow): ChatState {
  return {
    ...state,
    rows: state.rows.map(row =>
      row.kind === 'message' && row.id === state.pendingId ? apply(row) : row,
    ),
  }
}

function pendingRow(state: ChatState): MessageRow | null {
  const row = state.rows.find(r => r.kind === 'message' && r.id === state.pendingId)
  return row && row.kind === 'message' ? row : null
}

/** Drop the in-flight assistant row and put a stated failure in its place. */
function replacePendingWithError(state: ChatState, reason: string): ChatState {
  const pending = pendingRow(state)
  const errorRow: ErrorRow = { kind: 'error', id: `${state.pendingId}:error`, reason }
  // Text that really streamed is kept — deleting it would hide what the model
  // actually said before it failed.
  const keptRows =
    pending && pending.text
      ? state.rows.map(row => (row === pending ? { ...pending, streaming: false } : row))
      : state.rows.filter(row => row !== pending)
  return { ...state, rows: [...keptRows, errorRow], streaming: false, pendingId: null }
}

function applyEvent(state: ChatState, event: StreamEvent): ChatState {
  switch (event.type) {
    case 'meta':
      return {
        ...state,
        conversationId: event.conversationId || state.conversationId,
        model: event.model || state.model,
      }

    case 'delta':
      if (state.pendingId === null) return state
      return withPending(state, row => ({ ...row, text: row.text + event.text }))

    case 'error':
      if (state.pendingId === null) {
        return {
          ...state,
          rows: [...state.rows, { kind: 'error', id: `err-${state.rows.length}`, reason: event.reason }],
          streaming: false,
        }
      }
      return replacePendingWithError(state, event.reason)

    case 'done': {
      if (state.pendingId === null) return { ...state, streaming: false }
      const pending = pendingRow(state)
      // No text and no error frame: still a failure, said out loud.
      if (pending && !pending.text) return replacePendingWithError(state, NO_REPLY)
      return { ...withPending(state, row => ({ ...row, streaming: false })), streaming: false, pendingId: null }
    }

    case 'interrupted': {
      if (state.pendingId === null) return { ...state, streaming: false }
      return {
        ...withPending(state, row => ({ ...row, streaming: false, interrupted: true })),
        streaming: false,
        pendingId: null,
      }
    }
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'loaded':
      return {
        ...emptyChat(),
        conversationId: action.conversationId,
        model: state.model,
        rows: action.messages.map(m =>
          message({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', text: m.content }),
        ),
      }

    case 'send':
      return {
        ...state,
        rows: [
          ...state.rows,
          message({ id: action.userId, role: 'user', text: action.text }),
          message({ id: action.assistantId, role: 'assistant', streaming: true }),
        ],
        streaming: true,
        pendingId: action.assistantId,
      }

    case 'event':
      return applyEvent(state, action.event)
  }
}
