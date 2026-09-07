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
  /** `provider:model` as the gateway stated it on this turn's trace (the
   * `served_by` frame live, `served_by` on the fetched row after). null
   * until stated — never the model setting, never a guess. */
  servedBy: string | null
  /** `turns.kind` of the turn that wrote this row, as GET .../messages
   * derived it (`turn_kind`, S9). A 'reminder' or 'scheduled' row earns the
   * bubble's small label; everything else — 'chat', null (a user row, a
   * pre-turn-link row), a kind this client has not met — shows none. Only
   * ever set from a fetched row: a row this store streamed itself is a chat
   * turn by construction and stays null. */
  turnKind: string | null
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
      messages: FetchedMessage[]
    }
  | { type: 'send'; userId: string; assistantId: string; text: string }
  | { type: 'event'; event: StreamEvent }
  | {
      type: 'reconcile'
      conversationId: string
      messages: FetchedMessage[]
    }
  | {
      type: 'pollResolved'
      conversationId: string
      messages: FetchedMessage[]
    }
  // The idle poll (S9): history fetched while NO turn was in flight, merged
  // by id — see `mergeServerRows`. `observedRows` is `state.rows` as it was
  // when the fetch was ISSUED; a transcript that moved in between makes the
  // fetch stale, and the reducer drops it rather than guess.
  | {
      type: 'idlePolled'
      conversationId: string
      messages: FetchedMessage[]
      observedRows: ChatRow[]
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

/** What GET .../messages hands back (lib/api StoredMessage, minus the
 * fields this reducer does not read). */
export type FetchedMessage = {
  id: string
  role: string
  content: string
  served_by?: string | null
  turn_kind?: string | null
}

export const NO_REPLY = 'the turn finished without a reply' 

export function emptyChat(): ChatState {
  return { rows: [], streaming: false, conversationId: null, model: null, pendingId: null }
}

function message(row: Partial<MessageRow> & { id: string; role: MessageRow['role'] }): MessageRow {
  return {
    kind: 'message',
    text: '',
    streaming: false,
    interrupted: false,
    activity: null,
    servedBy: null,
    turnKind: null,
    ...row,
  }
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

    case 'served':
      if (state.pendingId === null) return state
      return withPending(state, row => ({ ...row, servedBy: event.servedBy }))

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

/** One persisted row as GET .../messages handed it back. Never streaming,
 * never interrupted, no activity marker — the durable record of what ran is
 * the Activity page, not the transcript (see ActivityMarker). */
function serverRow(m: FetchedMessage): MessageRow {
  return message({
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    text: m.content,
    servedBy: m.served_by ?? null,
    turnKind: m.turn_kind ?? null,
  })
}

function fromFetchedMessages(
  state: ChatState,
  conversationId: string,
  messages: FetchedMessage[],
): ChatState {
  return {
    ...emptyChat(),
    conversationId,
    model: state.model,
    rows: messages.map(serverRow),
  }
}

/**
 * A fetched assistant row that this store could have streamed itself. This
 * store only ever opens chat turns (POST /chat/stream), so a row whose
 * turn_kind names a DIFFERENT kind — a reminder, a scheduled turn — cannot be
 * the persisted copy of a reply it streamed. A null kind (a row older than the
 * turn link, or a core that has not learned to state one yet) is not evidence
 * either way and is allowed through.
 */
function couldBeOurReply(row: MessageRow): boolean {
  return row.role === 'assistant' && (row.turnKind === null || row.turnKind === 'chat')
}

/**
 * Merge the server's transcript into the store's, by id, for the idle poll.
 *
 * The problem this solves: the store's rows are a MIX. Rows it loaded from the
 * server carry server ids; rows it streamed itself carry client ids (`u-…`,
 * `a-…`) the server never learns; error rows and /help notes exist only here.
 * So neither "append every fetched id we don't hold" (would duplicate every
 * live exchange) nor "replace with the fetch" (would erase a stated failure
 * and the text of a send that never reached the server, 15 s after he read
 * them) is honest.
 *
 * Instead the fetched list is the spine — the persisted truth, in order —
 * and the store's rows are walked to decide what each one means against it:
 *   - a row whose id IS in the spine is that spine row (nothing to do);
 *   - a client user row is matched to the first unclaimed spine user row at or
 *     after the cursor with the SAME text (core persists `message.strip()`
 *     before the stream starts and ChatInput trims before sending, so equality
 *     is exact); the client assistant row that follows it is the spine
 *     assistant row right after — whose text may be the without_markup'd or
 *     completed version, which is the version that is true — but never a row
 *     whose kind says it was not a chat turn (`couldBeOurReply`);
 *   - anything unmatched — an error row, a /help note, a send the server never
 *     persisted and its partial reply — is a client-only row and is KEPT,
 *     anchored after the spine row it followed.
 * Spine rows nothing claimed — a reminder that fired, a scheduled turn's
 * reply, a turn from another tab — are the new rows, and they land exactly
 * where the server placed them. Nothing is ever shown twice: a spine row is
 * emitted once, and a client row is either represented by its spine row or
 * kept as itself, never both.
 *
 * Two things this deliberately lets go of, the same way `pollResolved` and
 * `reconcile` do: a streamed row's `interrupted` marker (the spine row that
 * replaces it is the persisted text, which is the truth, and carries no such
 * flag), and a client-only assistant note (/help) that sits directly after a
 * user row the server later answered — the reply that really ran takes its
 * place, exactly as a reload would.
 */
function mergeServerRows(rows: ChatRow[], fetched: FetchedMessage[]): ChatRow[] {
  const spine = fetched.map(serverRow)
  const spineIndex = new Map(spine.map((row, i) => [row.id, i] as const))
  const claimed = new Set<number>()
  // Client-only rows, keyed by how many spine rows precede them.
  const inserts = new Map<number, ChatRow[]>()
  const keep = (cursor: number, row: ChatRow) => {
    const bucket = inserts.get(cursor)
    if (bucket) bucket.push(row)
    else inserts.set(cursor, [row])
  }
  const firstUnclaimedUser = (from: number, text: string): number => {
    const wanted = text.trim()
    for (let j = from; j < spine.length; j++) {
      const candidate = spine[j]
      if (claimed.has(j) || candidate.role !== 'user') continue
      if (candidate.text.trim() === wanted) return j
    }
    return -1
  }

  let cursor = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    // The spine index this store row stands for: by id when the server
    // handed it to us, by text for a user row we sent ourselves.
    let resolved = -1
    if (row.kind === 'message') {
      const known = spineIndex.get(row.id)
      if (known !== undefined) resolved = known
      else if (row.role === 'user') resolved = firstUnclaimedUser(cursor, row.text)
    }
    if (resolved === -1) {
      keep(cursor, row)
      continue
    }
    claimed.add(resolved)
    cursor = resolved + 1
    // A client assistant row directly after a resolved USER row is that
    // turn's reply. This holds whether the user row resolved by text (first
    // poll after a live turn) or by id (a later poll: the user row was
    // re-keyed on the first poll while the server still held no reply, and
    // the reply it streamed stayed under its client id) — otherwise the
    // reply core finished later would land as a SECOND assistant row.
    if (spine[resolved].role !== 'user') continue
    const next = rows[i + 1]
    if (
      next === undefined ||
      next.kind !== 'message' ||
      next.role !== 'assistant' ||
      spineIndex.has(next.id)
    ) {
      continue
    }
    i += 1
    const reply = spine[cursor]
    if (reply !== undefined && !claimed.has(cursor) && couldBeOurReply(reply)) {
      claimed.add(cursor)
      cursor += 1
    } else {
      // The server holds no reply for this turn (yet, or ever): what really
      // streamed here stays, after its user row.
      keep(cursor, next)
    }
  }

  const merged: ChatRow[] = []
  for (let k = 0; k <= spine.length; k++) {
    const bucket = inserts.get(k)
    if (bucket) merged.push(...bucket)
    if (k < spine.length) merged.push(spine[k])
  }
  return merged
}

/** Structurally the same transcript — so a poll that learned nothing new
 * returns the SAME state object and nothing downstream re-renders. */
function sameRows(a: ChatRow[], b: ChatRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, i) => {
    const other = b[i]
    if (row.kind !== other.kind || row.id !== other.id) return false
    if (row.kind === 'error' || other.kind === 'error') {
      return row.kind === 'error' && other.kind === 'error' && row.reason === other.reason
    }
    return (
      row.text === other.text &&
      row.servedBy === other.servedBy &&
      row.turnKind === other.turnKind &&
      row.streaming === other.streaming &&
      row.interrupted === other.interrupted
    )
  })
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

    case 'idlePolled':
      // A live turn owns the transcript; the poll is not even issued while
      // one streams, but a fetch that was in flight when a send began must
      // not land either.
      if (state.streaming) return state
      // A stale poll naming a conversation we have since left.
      if (state.conversationId !== action.conversationId) return state
      // The transcript moved while this fetch was in flight — a send, a
      // clear, a local note. What came back describes a server the store has
      // since acted on (a clear it has emptied; a send it is about to see
      // persisted), so it is dropped, never merged: the next poll asks again.
      if (state.rows !== action.observedRows) return state
      {
        const merged = mergeServerRows(state.rows, action.messages)
        return sameRows(merged, state.rows) ? state : { ...state, rows: merged }
      }

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
