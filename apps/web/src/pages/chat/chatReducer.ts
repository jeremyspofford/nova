import type { Delegation } from '../../lib/api'
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
export type ActivityMarker = {
  tool: string
  status: string
  reason?: string
  detail?: string
  /** How far through the call is, 0..100, when it knows (S15). Absent means
   * indeterminate — the bar shimmers rather than sitting at zero, and a frame
   * that stops reporting a fraction drops back to that rather than freezing
   * the last number it happened to see. */
  percent?: number
} | null

/** The tool whose activity frames open, feed and close a delegation. */
export const DELEGATE_TOOL = 'delegate_to_agent'

/** How many of a delegation's steps the row keeps; the rest are counted in
 * `dropped`, never silently lost — a 500-step child turn still says how
 * many steps it took, it just does not hold every row in memory. */
export const MAX_DELEGATION_STEPS = 200

/** A delegation as THIS store watched it happen (S12): built from the
 * delegate_to_agent activity frames of a turn it streamed, so it is the
 * live view — the child's steps as the relay stated them, capped. Never
 * persisted: a fetched row carries `delegations` (the ledger's derived
 * record, below) instead, and the two never coexist on one row.
 *
 * `agent` is null until a frame names it: the delegate tool's own `start`
 * frame is a plain tool start (no agent), the name arrives on the first
 * relayed progress frame. `status` is 'working' from that start until the
 * tool's own ok/error frame closes it; 'interrupted' is this STORE's
 * finding — the turn ended (done, error, dropped connection, or a second
 * start) while the delegation was still open, so no result was ever
 * stated. It is never a claim about what the child turn did. */
export type LiveDelegation = {
  agent: string | null
  turnId: string | null
  steps: { step: string; status: string }[]
  dropped: number
  status: 'working' | 'ok' | 'error' | 'interrupted'
}

export type MessageRow = {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
  interrupted: boolean
  /** The note a STOPPED turn ended with (S15), when the owner pressed Stop:
   * where it stopped, and what that does and does not mean about the work.
   * Distinct from `interrupted`, which is this store's finding that a stream
   * died — a stop is deliberate, said by the server, and not a failure. Never
   * persisted: the server writes the same words into the assistant row, so a
   * reload shows the note as part of the text. */
  stoppedNote: string | null
  activity: ActivityMarker
  /** `provider:model` as the gateway stated it on this turn's trace (the
   * `served_by` frame live, `served_by` on the fetched row after). null
   * until stated — never the model setting, never a guess. */
  servedBy: string | null
  /** The turn's cost in USD (S10): live from the `usage` frame, or
   * `cost_usd` on the fetched row. null until stated, and null when no
   * round was priced — a local or unmetered turn has no dollars. */
  cost: number | null
  /** The gateway's stated reason when the answer came from a fallback
   * link (S10-2): live from the `route` frame, `route_reason` on a
   * fetched row. null when link 1 served. */
  routeReason: string | null
  /** `turns.kind` of the turn that wrote this row, as GET .../messages
   * derived it (`turn_kind`, S9). A 'reminder' or 'scheduled' row earns the
   * bubble's small label; everything else — 'chat', null (a user row, a
   * pre-turn-link row), a kind this client has not met — shows none. Only
   * ever set from a fetched row: a row this store streamed itself is a chat
   * turn by construction and stays null. */
  turnKind: string | null
  /** The agent that wrote this row (S12): the `meta` frame's `agent` live
   * (an `@coder …` turn runs entirely as the agent), `agent` on the
   * fetched row after. null for Nova's own replies and for user rows —
   * never inferred from the text, never from what the owner typed. */
  agent: string | null
  /** The delegation in flight on this row, or the last one this store
   * watched close (S12). One at a time: core dispatches calls
   * sequentially, so a second `start` moves this into `delegationsDone`. */
  delegation: LiveDelegation | null
  /** Delegations this store watched to completion before a later one
   * opened on the same row, in order. */
  delegationsDone: LiveDelegation[]
  /** The ledger's record of this row's delegations, verbatim from the
   * fetched row (S12). Only ever set from a fetched row — a streamed row
   * has the live `delegation` instead — and it is what survives a reload. */
  delegations: Delegation[]
}

export type ErrorRow = {
  kind: 'error'
  id: string
  reason: string
}

export type ChatRow = MessageRow | ErrorRow

/** A message core has ACCEPTED but not yet answered (S15): the owner sent it
 * while a turn was running, so it waits and runs by itself when that turn ends.
 *
 * Held apart from `rows` on purpose. It is not a message anybody has answered,
 * so putting it in the transcript would mean the two transcript-merging paths
 * (`pollResolved` replaces every row; `idlePolled` matches client rows to
 * server rows by text) each had to get it right — and they disagree, so it
 * would show twice or vanish. Out here the SERVER's list is simply the truth
 * and `queueSynced` adopts it. */
export type QueuedMessage = {
  id: string
  body: string
  /** How many accepted messages run before this one. 0 means it is next. */
  ahead: number
}

export interface ChatState {
  rows: ChatRow[]
  streaming: boolean
  conversationId: string | null
  model: string | null
  /** The assistant row currently being filled, if a turn is in flight. */
  pendingId: string | null
  /** The server's id for the turn in flight, from the meta frame (S15) — what
   * Stop addresses. Cleared the moment the turn ends and on every new send, so
   * the button can never be pointed at a turn that has already finished. */
  turnId: string | null
  /** Messages core accepted while a turn was running, oldest first (S15). */
  queued: QueuedMessage[]
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
  // The turn a RELOADED tab found already running server-side (S15), learned
  // from /conversations/active rather than from a meta frame this tab never
  // saw. It sets the turn id and nothing else — no row, no streaming flag; the
  // pending-turn poll still owns the transcript. Without it, the one case that
  // most needs Stop (a tab that came back to a hung turn) is the one case that
  // cannot reach it. null when the poll resolves.
  | { type: 'serverTurn'; turnId: string | null }
  // The owner took an accepted message back (S15). Dispatched only AFTER the
  // server confirms the cancellation, the clearChat discipline: never a fake
  // success, because a chip that vanished while the message still ran would be
  // the worst possible lie about a queue.
  | { type: 'unqueued'; id: string }
  // The server's list of accepted-but-unanswered messages, adopted whole. It is
  // the truth: the server is what runs them, and this arrives on every poll
  // tick, so an unchanged list must return the SAME state or the composer
  // re-renders for ever.
  | { type: 'queueSynced'; queued: QueuedMessage[] }
  // A send made while a turn was running that core did not accept (S15). It gets
  // its OWN error row rather than going through the `error` event, which would
  // replace the LIVE turn's bubble — a failure to queue must not take down the
  // reply the owner is reading.
  | { type: 'queueFailed'; reason: string }
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
  cost_usd?: number | null
  route_reason?: string | null
  agent?: string | null
  delegations?: Delegation[]
}

export const NO_REPLY = 'the turn finished without a reply'

export function emptyChat(): ChatState {
  return {
    rows: [],
    streaming: false,
    conversationId: null,
    model: null,
    pendingId: null,
    turnId: null,
    queued: [],
  }
}

function sameQueue(a: QueuedMessage[], b: QueuedMessage[]): boolean {
  return (
    a.length === b.length &&
    a.every((q, i) => q.id === b[i].id && q.body === b[i].body && q.ahead === b[i].ahead)
  )
}

function message(row: Partial<MessageRow> & { id: string; role: MessageRow['role'] }): MessageRow {
  return {
    kind: 'message',
    text: '',
    streaming: false,
    interrupted: false,
    stoppedNote: null,
    activity: null,
    servedBy: null,
    cost: null,
    routeReason: null,
    turnKind: null,
    agent: null,
    delegation: null,
    delegationsDone: [],
    delegations: [],
    ...row,
  }
}

type ActivityEvent = Extract<StreamEvent, { type: 'activity' }>

/**
 * The delegation state machine (S12), fed only delegate_to_agent frames.
 *   start            → a new working delegation (whatever was open is done:
 *                      closed as it was, or 'interrupted' if it never was)
 *   progress + step  → append the step, or count it once the cap is hit;
 *                      the first frame that names the agent/turn names it
 *   ok / error       → close the open one with that status
 * A close with nothing open, or a step after a close, changes nothing —
 * there is no delegation for it to describe.
 */
function delegationAfter(
  row: MessageRow,
  event: ActivityEvent,
): Pick<MessageRow, 'delegation' | 'delegationsDone'> {
  const current = row.delegation
  if (event.status === 'start') {
    const done = current
      ? [...row.delegationsDone, current.status === 'working' ? { ...current, status: 'interrupted' as const } : current]
      : row.delegationsDone
    return {
      delegation: {
        agent: event.agent ?? null,
        turnId: event.agentTurnId ?? null,
        steps: [],
        dropped: 0,
        status: 'working',
      },
      delegationsDone: done,
    }
  }
  if (!current || current.status !== 'working') {
    return { delegation: current, delegationsDone: row.delegationsDone }
  }
  if (event.status === 'ok' || event.status === 'error') {
    return { delegation: { ...current, status: event.status }, delegationsDone: row.delegationsDone }
  }
  const named: LiveDelegation = {
    ...current,
    agent: current.agent ?? event.agent ?? null,
    turnId: current.turnId ?? event.agentTurnId ?? null,
  }
  if (event.step === undefined) return { delegation: named, delegationsDone: row.delegationsDone }
  const entry = { step: event.step, status: event.stepStatus ?? event.status }
  return {
    delegation:
      named.steps.length < MAX_DELEGATION_STEPS
        ? { ...named, steps: [...named.steps, entry] }
        : { ...named, dropped: named.dropped + 1 },
    delegationsDone: row.delegationsDone,
  }
}

/** The turn is over. A delegation still 'working' never had its result
 * stated — say so ('interrupted', this store's finding) rather than leave
 * a spinner on a finished bubble. A closed one is left exactly as it is. */
function settleDelegation(row: MessageRow): MessageRow {
  if (!row.delegation || row.delegation.status !== 'working') return row
  return { ...row, delegation: { ...row.delegation, status: 'interrupted' } }
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
          row === pending ? settleDelegation({ ...pending, streaming: false, activity: null }) : row,
        )
      : state.rows.filter(row => row !== pending)
  return { ...state, rows: [...keptRows, errorRow], streaming: false, pendingId: null }
}

function applyEvent(state: ChatState, event: StreamEvent): ChatState {
  switch (event.type) {
    case 'meta': {
      const next = {
        ...state,
        conversationId: event.conversationId || state.conversationId,
        model: event.model || state.model,
        // What Stop addresses (S15). The meta frame is the one place the
        // server states it, and it arrives first.
        turnId: event.turnId || null,
      }
      // Who is writing the pending row (S12): the agent the server named,
      // or null for Nova. Set directly — the meta frame is the one fact.
      return state.pendingId === null ? next : withPending(next, row => ({ ...row, agent: event.agent }))
    }

    // Accepted, not answered (S15) — and NOT a turn, so nothing about the one
    // in flight moves: not `streaming`, not `pendingId`, not `turnId`, not a
    // single row. This event arrives on its own POST, not on the live stream.
    case 'queued':
      return {
        ...state,
        conversationId: state.conversationId ?? event.conversationId ?? null,
        queued: [...state.queued, { id: event.id, body: event.body, ahead: event.ahead }],
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
            : {
                tool: event.tool,
                status: event.status,
                reason: event.reason,
                // A progress frame carries the tool's own words; the marker
                // is REPLACED each time so the bubble shows the latest.
                ...(event.detail !== undefined ? { detail: event.detail } : {}),
                ...(event.percent !== undefined ? { percent: event.percent } : {}),
              },
        // Only the delegate tool's frames touch the delegation (S12); every
        // other tool's frames leave it exactly as it is.
        ...(event.tool === DELEGATE_TOOL ? delegationAfter(row, event) : {}),
      }))

    case 'served':
      if (state.pendingId === null) return state
      return withPending(state, row => ({ ...row, servedBy: event.servedBy }))

    case 'usage':
      if (state.pendingId === null) return state
      return withPending(state, row => ({ ...row, cost: event.usage.cost_usd }))

    case 'route':
      if (state.pendingId === null) return state
      return withPending(state, row => ({
        ...row,
        routeReason: event.route.reason,
        servedBy: event.route.servedBy ?? row.servedBy,
      }))

    case 'error':
      if (state.pendingId === null) {
        return {
          ...state,
          rows: [...state.rows, { kind: 'error', id: `err-${state.rows.length}`, reason: event.reason }],
          streaming: false,
          turnId: null,
        }
      }
      return { ...replacePendingWithError(state, event.reason), turnId: null }

    // The owner pressed Stop and the server ended the turn on purpose (S15).
    // Settled like `done`, not like `error`: the text he watched stays, the
    // note goes on the row, and no red bubble appears — nothing failed. It
    // settles pendingId too, so the `done` frame that always follows cannot
    // re-read an empty-text row as "finished without a reply": a stop during a
    // tool call, before any prose, is a note and not a failure.
    case 'stopped': {
      if (state.pendingId === null) return { ...state, streaming: false, turnId: null }
      return {
        ...withPending(state, row =>
          settleDelegation({
            ...row,
            streaming: false,
            activity: null,
            stoppedNote: event.note,
          }),
        ),
        streaming: false,
        pendingId: null,
        turnId: null,
      }
    }

    case 'done': {
      if (state.pendingId === null) return { ...state, streaming: false, turnId: null }
      const pending = pendingRow(state)
      // No text and no error frame: still a failure, said out loud.
      if (pending && !pending.text) return { ...replacePendingWithError(state, NO_REPLY), turnId: null }
      return {
        ...withPending(state, row => settleDelegation({ ...row, streaming: false, activity: null })),
        streaming: false,
        pendingId: null,
        turnId: null,
      }
    }

    case 'interrupted': {
      if (state.pendingId === null) return { ...state, streaming: false, turnId: null }
      return {
        ...withPending(state, row =>
          settleDelegation({
            ...row,
            streaming: false,
            interrupted: true,
            activity: null,
          }),
        ),
        streaming: false,
        pendingId: null,
        turnId: null,
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
    cost: typeof m.cost_usd === 'number' ? m.cost_usd : null,
    routeReason: typeof m.route_reason === 'string' ? m.route_reason : null,
    turnKind: m.turn_kind ?? null,
    agent: typeof m.agent === 'string' && m.agent ? m.agent : null,
    // Verbatim: the ledger's derived record is the chip's whole source.
    delegations: Array.isArray(m.delegations) ? m.delegations : [],
  })
}

function sameDelegations(a: Delegation[], b: Delegation[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (d, i) =>
      d.agent === b[i].agent &&
      d.agent_turn_id === b[i].agent_turn_id &&
      d.status === b[i].status &&
      d.files.length === b[i].files.length,
  )
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
    // The queue is not part of the transcript and this fetch says nothing about
    // it (S15): a message still waiting has not been answered, so replacing the
    // rows must not drop it. Only `queueSynced`, which reads the server's own
    // list, and `unqueued`, which the server has confirmed, change it.
    queued: state.queued,
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
      row.interrupted === other.interrupted &&
      row.agent === other.agent &&
      sameDelegations(row.delegations, other.delegations)
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

    case 'unqueued': {
      const left = state.queued.filter(q => q.id !== action.id)
      return left.length === state.queued.length ? state : { ...state, queued: left }
    }

    case 'queueSynced':
      return sameQueue(state.queued, action.queued) ? state : { ...state, queued: action.queued }

    case 'queueFailed':
      return {
        ...state,
        rows: [
          ...state.rows,
          { kind: 'error', id: `queue-err-${state.rows.length}`, reason: action.reason },
        ],
      }

    case 'serverTurn':
      // Only the id. A turn this tab is streaming itself always wins: its meta
      // frame is first-hand, and a poll result that arrived late must never
      // re-aim Stop at a turn that has already been replaced.
      if (state.streaming) return state
      return state.turnId === action.turnId ? state : { ...state, turnId: action.turnId }

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
        // The new turn has no id until its meta frame arrives; keeping the
        // previous one would point Stop at a turn that already finished.
        turnId: null,
      }

    case 'event':
      return applyEvent(state, action.event)
  }
}
