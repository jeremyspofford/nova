import type { StreamEvent } from '../../lib/streamChat'

/**
 * The chat transcript as a pure reduction over stream events.
 *
 * The rule the whole file exists to enforce: a failure is never an assistant
 * bubble. An error frame produces its own row; a turn that ends without a
 * reply produces an error row rather than an empty bubble; a dropped
 * connection keeps whatever text really arrived and says it was cut off.
 */

/** The pending bubble's transient tool-call indicator. `status` is
 * whatever the server sent (chat.py only ever sends 'start' or 'error'
 * through here — 'ok' resolves the call cleanly and clears this back to
 * null instead of being a status worth showing), kept as `string` rather
 * than a narrower literal so an unrecognised value still renders as
 * something rather than being cast into a lie. `reason`, when the server
 * stated one on an 'error' status, is what lets the bubble say WHAT failed
 * instead of the unbackable claim that the call "did not finish" — a tool
 * that raised a stated refusal finished; it just didn't succeed. Never
 * persisted: reconciling from fetched history always starts a row at
 * `null` (see `message()` below), because the durable record of what ran
 * is the Activity page, not the chat transcript. */
export type ActivityMarker = { tool: string; status: string; reason?: string } | null

export type MessageRow = {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
  interrupted: boolean
  activity: ActivityMarker
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
  | {
      type: 'pollResolved'
      conversationId: string
      messages: { id: string; role: string; content: string }[]
    }
  | { type: 'reset' }
  // Clear-chat (button or the /clear slash command): the operator emptied THIS
  // conversation's transcript. Dispatched by chat-store.tsx only AFTER the clear
  // API returns ok — never a fake success. Keeps the conversation open (its id
  // and model), just with no rows, so the empty state shows for the same chat.
  | { type: 'cleared'; conversationId: string }
  | { type: 'modelSwitched'; model: string }
  // A local, un-sent assistant row — the /help command prints the command
  // listing this way (see lib/commands.ts). It never streams to the model and
  // is not persisted server-side: it is a client-only note, so a reconcile or
  // reload naturally drops it, which is correct for ephemeral help text.
  | { type: 'localMessage'; id: string; text: string }

export const NO_REPLY = 'the turn finished without a reply'

export function emptyChat(): ChatState {
  return { rows: [], streaming: false, conversationId: null, model: null, pendingId: null }
}

function message(row: Partial<MessageRow> & { id: string; role: MessageRow['role'] }): MessageRow {
  return { kind: 'message', text: '', streaming: false, interrupted: false, activity: null, ...row }
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
      ? state.rows.map(row =>
          row === pending ? { ...pending, streaming: false, activity: null } : row,
        )
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

    case 'activity':
      if (state.pendingId === null) return state
      return withPending(state, row => ({
        ...row,
        // 'ok' is not shown — it clears the line, same as it never
        // happened, because a call that resolved cleanly is not something
        // the pending bubble needs to keep saying. 'start' and 'error' are
        // the two states someone reading the bubble actually needs.
        activity:
          event.status === 'ok'
            ? null
            : { tool: event.tool, status: event.status, reason: event.reason },
      }))

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
      return {
        ...withPending(state, row => ({ ...row, streaming: false, activity: null })),
        streaming: false,
        pendingId: null,
      }
    }

    case 'interrupted': {
      if (state.pendingId === null) return { ...state, streaming: false }
      return {
        ...withPending(state, row => ({
          ...row,
          streaming: false,
          interrupted: true,
          activity: null,
        })),
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

    case 'pollResolved':
      // A turn that finished SERVER-SIDE — one this store never streamed
      // itself (the durable-turn case: the operator hard-refreshed mid-reply,
      // so core finished the turn detached and persisted the full answer).
      // ChatPage polls until core reports the turn done, then hands the
      // fetched history here. Unlike `reconcile` (which distrusts a
      // same-conversation fetch because the store lived through that turn in
      // real time), this fetch IS authoritative: the store did NOT stream
      // this turn, so the persisted rows are strictly more current than the
      // pre-reply rows it is holding. It replaces them, resolving the pending
      // reply into the SAME row set — no duplicate bubble. Two guards keep it
      // from ever clobbering live local state:
      //   - a stale poll naming a conversation we have since left is ignored;
      //   - if the store is now streaming its OWN turn (the operator asked
      //     something new while the poll was in flight), the live turn wins
      //     and the poll result is dropped.
      if (state.streaming) return state
      if (state.conversationId !== action.conversationId) return state
      return fromFetchedMessages(state, action.conversationId, action.messages)

    case 'reset':
      return emptyChat()

    case 'cleared':
      // Same shape a just-loaded empty conversation has: no rows, streaming
      // off, pending cleared — but the conversation itself (id) stays open and
      // the model badge is preserved. fromFetchedMessages with no messages is
      // exactly that.
      return fromFetchedMessages(state, action.conversationId, [])

    // Slice 2f Fix A: a Settings->Models switch, not a server event — sets
    // `model` DIRECTLY (never "action.model || state.model" the way the
    // 'meta' event merges) because the switch itself is the new fact, and
    // must win over whatever an earlier turn in this same conversation left
    // behind. Everything else about the conversation in flight is untouched.
    case 'modelSwitched':
      return { ...state, model: action.model }

    case 'localMessage':
      return {
        ...state,
        rows: [...state.rows, message({ id: action.id, role: 'assistant', text: action.text })],
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
