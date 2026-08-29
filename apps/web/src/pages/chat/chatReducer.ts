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
  | {
      type: 'reconcile'
      conversationId: string
      messages: { id: string; role: string; content: string }[]
    }
  | { type: 'reset' }

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

function fromFetchedMessages(
  state: ChatState,
  conversationId: string,
  messages: { id: string; role: string; content: string }[],
): ChatState {
  return {
    ...emptyChat(),
    conversationId,
    model: state.model,
    rows: messages.map(m =>
      message({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', text: m.content }),
    ),
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'loaded':
      return fromFetchedMessages(state, action.conversationId, action.messages)

    case 'reconcile':
      // A page that just remounted always re-fetches history, but that
      // fetch is only trusted when it names a DIFFERENT conversation (or
      // this is the first load ever): if the store already holds the SAME
      // conversation, it lived through whatever happened to it in real
      // time — still streaming, or already resolved to its final rows —
      // so the fetch can only be stale or exactly caught up, never more
      // current. That is what makes a mid-stream remount show the live
      // partial continuing (not a stale snapshot missing the in-flight
      // reply) and a completed-while-away remount show the finished
      // exchange exactly once (the fetch would repeat rows the store
      // already has, and would silently drop a turn that failed
      // client-side and so never reached the database). A genuinely
      // different conversation still replaces the rows, exactly like
      // `loaded`. (The store surviving a route change in the first place
      // is ruling S2-R4.)
      if (state.conversationId === action.conversationId) return state
      return fromFetchedMessages(state, action.conversationId, action.messages)

    case 'reset':
      return emptyChat()

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
