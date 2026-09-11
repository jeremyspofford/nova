import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Clock, Square, X } from 'lucide-react'
import {
  getActiveConversation as apiGetActiveConversation,
  getMessages as apiGetMessages,
} from '../../lib/api'
import { useChatStore } from '../../stores/chat-store'
import { ChatControls } from './ChatControls'
import { ChatInput } from './ChatInput'
import { ErrorBubble, MessageBubble } from './MessageBubble'
import type { Conversation } from '../../lib/api'
import type { QueuedMessage } from './chatReducer'

/** The server's accepted-but-unanswered list, in the store's own shape. One
 * translation, so the page never half-adopts the wire format. */
function asQueued(conversation: Conversation): QueuedMessage[] {
  return (conversation.queued ?? []).map(q => ({ id: q.id, body: q.body, ahead: q.ahead }))
}

/**
 * One conversation, streamed. The transcript and the send lifecycle both
 * live in the chat store (stores/chat-store.tsx), mounted above the router
 * so a turn survives this component unmounting — this component is the
 * wiring: load the active conversation on mount, reconcile it into the
 * store, keep the view scrolled.
 *
 * The durable-turn slice (S2c) adds a second recovery path: a HARD REFRESH
 * tears down the store entirely, so the surviving-store trick cannot help.
 * Instead core finishes the turn server-side and this page, on mount, asks
 * whether the active conversation has a turn still in flight (pending_turn).
 * If it does, it shows a subtle "still responding" line and POLLS until the
 * turn lands, then resolves the finished reply into the store — so the
 * operator returns and the complete answer appears with no second refresh.
 *
 * The poll runs for exactly as long as core says the turn is in flight. It
 * used to give up after 300 s — "the gateway's read budget", the reasoning
 * went — but a turn is not one gateway call: it is up to max_tool_rounds of
 * them plus redirects, each with its own 300 s of allowed silence, and the
 * poll's clock starts at the RELOAD, not at the send. A refresh a second
 * after sending, followed by a 300 s timeout, had the poll giving up ~1 s
 * before the turn closed, and the page went quiet with the turn's stated
 * failure sitting unread in the database (the 2026-09-04 17:11 silence).
 * pending_turn is derived from a set that dies with the core process, so it
 * can never be true forever; the honest client reads it and does not guess.
 *
 * The scheduling slice (S9) adds a THIRD path, for rows this store never
 * streamed and core never marks in flight: a reminder or scheduled turn that a
 * timer firing lands in this conversation while the page is open. While
 * nothing is in flight here — not streaming, not polling a pending turn — an
 * idle poll asks core for the transcript every `idlePollMs` and merges what is
 * new through the reducer's `idlePolled` (chatReducer.ts's mergeServerRows),
 * so the reminder appears without a reload, once, in the place core put it.
 *
 * `api` is a dependency-injection seam, the same idiom as ActivityPage's:
 * production uses the real client (the DEFAULT_API default); a test injects
 * fakes. `pollIntervalMs` and `idlePollMs` are injectable so a test can drive
 * either poll on real timers without waiting seconds.
 */

interface ChatApi {
  getActiveConversation: typeof apiGetActiveConversation
  getMessages: typeof apiGetMessages
}

const DEFAULT_API: ChatApi = {
  getActiveConversation: apiGetActiveConversation,
  getMessages: apiGetMessages,
}

// How often to ask core whether the in-flight turn has landed. There is no
// ceiling: the server's pending_turn is the fact, and the poll stops when it
// says so or when this page unmounts (see the docstring above).
const POLL_INTERVAL_MS = 1500

// How often, while idle, to ask core whether a timer firing has landed a row
// here (S9). The scheduler ticks once a minute, so 15 s is the same cadence
// the Schedules and Devices pages refresh at — a reminder is seen within a
// quarter of the tick that delivered it.
const IDLE_POLL_MS = 15_000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
// How many consecutive failed pending_turn reads the page tolerates before it
// stops asserting "still responding" — a claim it can no longer back.
const MAX_POLL_FAILURES = 8

export function ChatPage({
  initialModel,
  api = DEFAULT_API,
  pollIntervalMs = POLL_INTERVAL_MS,
  idlePollMs = IDLE_POLL_MS,
}: {
  initialModel?: string
  api?: ChatApi
  pollIntervalMs?: number
  idlePollMs?: number
}) {
  const {
    state,
    sendMessage,
    loadConversation,
    resolveServerTurn,
    syncFromServer,
    clearChat,
    setModel,
    stopTurn,
    noteServerTurn,
    unqueue,
    syncQueue,
  } = useChatStore()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // True while a turn that finished (or is finishing) server-side is being
  // polled for — the operator hard-refreshed mid-reply and the answer is
  // still on its way. Bumped `resolvedTick` forces a scroll-to-bottom once it
  // lands (see the layout effect below), since the conversation id does not
  // change when the poll resolves.
  const [responding, setResponding] = useState(false)
  const [resolvedTick, setResolvedTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Read the live streaming flag inside the async poll without re-subscribing
  // it as an effect dependency: if the operator starts their OWN turn while we
  // are polling, the live turn wins and the poll must stand down.
  const streamingRef = useRef(state.streaming)
  streamingRef.current = state.streaming

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const conversation = await api.getActiveConversation()
        const messages = await api.getMessages(conversation.id)
        if (!live) return
        // Reconciled, never blindly loaded: if the store already lived
        // through this conversation (a turn still streaming, or one that
        // finished while this page was unmounted), its own rows are trusted
        // over this fetch — see chatReducer's `reconcile` action.
        loadConversation(conversation.id, messages)
        // What core has accepted and not yet answered (S15). Adopted from the
        // server rather than remembered locally, so a tab that reloaded still
        // shows what it queued instead of appearing to have lost it.
        syncQueue(asQueued(conversation))

        // A hard refresh leaves the store empty but a turn still running in
        // core. Poll for it — but only if the store is not ALREADY streaming
        // this turn itself (the in-app-nav case, which the surviving store
        // handles without any polling).
        if (conversation.pending_turn && !streamingRef.current) {
          setResponding(true)
          // Which turn it is (S15) — so the responding line can offer a Stop.
          // This tab never saw that turn's meta frame; the server is the only
          // thing that can tell it the id.
          noteServerTurn(conversation.pending_turn_id)
          await pollForReply(conversation.id)
        }
      } catch (err) {
        // History is unreadable, but a turn can still be taken: core resolves
        // the active conversation itself when none is named.
        if (live) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (live) setLoading(false)
      }
    })()

    async function pollForReply(conversationId: string): Promise<void> {
      let fetchFailures = 0
      while (live) {
        await sleep(pollIntervalMs)
        if (!live) return
        // The operator asked something new while we waited — their live turn
        // owns the transcript now, so drop the poll rather than fight it.
        if (streamingRef.current) {
          setResponding(false)
          return
        }
        let active
        try {
          active = await api.getActiveConversation()
          fetchFailures = 0
        } catch (err) {
          // A transient read failure is not a finished turn — keep polling.
          // But "still responding" is a claim this page can only back while
          // it can READ the fact; after MAX_POLL_FAILURES consecutive
          // failures it stops claiming and says what it knows instead.
          fetchFailures += 1
          if (fetchFailures >= MAX_POLL_FAILURES) {
            setResponding(false)
            setLoadError(
              `Nova's core could not be reached for ${fetchFailures} checks in a row` +
                (err instanceof Error && err.message ? ` (${err.message})` : '') +
                ' — the turn may still be running; reload to check.',
            )
            return
          }
          continue
        }
        if (!live) return
        // Every tick, because the queue moves while this loop runs: a message
        // claimed by its own turn stops being waiting, and the chip has to go
        // when it does (S15).
        syncQueue(asQueued(active))
        if (!active.pending_turn) {
          // The turn closed — and, since S15, the queue behind it has drained
          // too: pending_turn covers both, so this loop cannot stop while an
          // accepted message is still owed an answer.
          try {
            const messages = await api.getMessages(conversationId)
            if (!live) return
            resolveServerTurn(conversationId, messages)
            setResolvedTick(tick => tick + 1)
          } catch {
            /* the reply landed but history is momentarily unreadable — the
               next normal load will show it; stop the responding state. */
          }
          setResponding(false)
          return
        }
      }
      // Unmounted mid-poll: nothing to clear on a page that is gone, and
      // nothing is invented.
    }

    return () => {
      live = false
    }
  }, [api, loadConversation, resolveServerTurn, pollIntervalMs, noteServerTurn, syncQueue])

  // S9 — the idle poll. The interval EXISTS only while nothing is in flight
  // here: history loaded, no pending-turn poll running, and `state.streaming`
  // false — that flag is a dependency, so a send tears the interval down and
  // 'done' brings it back; nothing ever polls under a live turn. A tick that
  // finds a stream started since it was scheduled stands down (streamingRef);
  // a fetch whose transcript moved while it was in flight is dropped by the
  // reducer (observedRows — see chatReducer's `idlePolled`). A failed read is
  // not new content: it is skipped and the next tick asks again — the poll
  // makes no claim there is anything to retract.
  const rowsRef = useRef(state.rows)
  rowsRef.current = state.rows
  useEffect(() => {
    if (loading || responding || state.streaming || state.conversationId === null) return
    const conversationId = state.conversationId
    let live = true
    const id = setInterval(() => {
      if (streamingRef.current) return
      const observedRows = rowsRef.current
      api
        .getMessages(conversationId)
        .then(messages => {
          if (live) syncFromServer(conversationId, messages, observedRows)
        })
        .catch(() => {})
    }, idlePollMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [api, idlePollMs, loading, responding, state.streaming, state.conversationId, syncFromServer])

  // S15 — the queue watch. A message this tab queued mid-turn becomes a real
  // turn server-side once the one in flight ends, and nobody is streaming it:
  // without this the chip would sit there until something else happened to read
  // /conversations/active, claiming a message is still waiting when it has
  // already been answered. Exists only while this tab KNOWS something is
  // waiting and no turn is streaming here (the pending-turn poll already syncs
  // the queue on every tick of its own, so the two never run together).
  useEffect(() => {
    if (loading || responding || state.streaming || state.queued.length === 0) return
    let live = true
    const id = setInterval(() => {
      if (streamingRef.current) return
      api
        .getActiveConversation()
        .then(active => {
          if (!live) return
          syncQueue(asQueued(active))
        })
        // A failed read is not news. The next tick asks again, and nothing is
        // retracted on the strength of a read that did not happen.
        .catch(() => {})
    }, pollIntervalMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [api, pollIntervalMs, loading, responding, state.streaming, state.queued.length, syncQueue])

  // Part C — land on the newest message when the conversation opens, when it
  // changes, and when the in-flight poll resolves. Keyed on those events
  // (conversation id + the resolve tick), NOT on every row change, so a
  // mid-stream delta never yanks the view away from someone reading history.
  // A layout effect so the scroll happens after the rows are in the DOM.
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state.conversationId, resolvedTick])

  // While a reply streams, keep it pinned to the bottom — unless the operator
  // has scrolled up to read, in which case leave them where they are.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 200) el.scrollTop = el.scrollHeight
  }, [state.rows])

  const model = state.model || initialModel || ''

  return (
    <div
      className="flex flex-col h-full min-h-0 bg-surface-root dark:bg-transparent"
      data-testid="chat-page"
      // The reducer's own flag, published on the surface. Anything asking
      // "is the turn over" — a test, a future status indicator — reads the
      // one value that decides it rather than inferring it from the text.
      data-streaming={String(state.streaming)}
    >
      {/* The header carries the title only now — the model indicator and the
          Clear control both moved to the control row by the input (ChatControls
          below), per the owner's ask. There is exactly one of each. */}
      <header
        data-testid="chat-header"
        className="shrink-0 flex items-center justify-between gap-3 px-4 md:px-8 h-14 border-b border-border-subtle"
      >
        <h1 className="text-h3 text-content-primary">Chat</h1>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <div className="mx-auto px-4 md:px-8 py-6 space-y-4 max-w-none md:max-w-3xl">
          {loadError && (
            <div
              role="alert"
              className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
            >
              Could not load this conversation: {loadError}
            </div>
          )}

          {!loading && !loadError && state.rows.length === 0 && !responding && (
            <p className="text-body text-content-tertiary text-center py-10">
              Nothing here yet. Say something.
            </p>
          )}

          {state.rows.map(row =>
            row.kind === 'message' ? (
              <MessageBubble key={row.id} row={row} />
            ) : (
              <ErrorBubble key={row.id} row={row} />
            ),
          )}

          {responding && (
            <p
              className="flex items-center gap-2 text-compact text-content-tertiary"
              data-testid="chat-responding"
              role="status"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-content-tertiary animate-pulse" />
              Nova is still responding…
            </p>
          )}

          {/* Scroll target: landing here means the newest message is in view. */}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>

      <div className="shrink-0 w-full px-2 md:px-8 pb-[max(env(safe-area-inset-bottom),0.5rem)] md:pb-4">
        <div className="mx-auto max-w-none md:max-w-3xl space-y-1.5">
          {/* Stop (S15). Shown whenever a turn is in flight — whether this tab
              is streaming it or found it already running after a reload — and
              only once there is a turn id to address, because a button that
              cannot reach anything is worse than no button. The server ends the
              turn; this only asks. */}
          {(state.streaming || responding) && state.turnId && (
            <div className="flex justify-center">
              <button
                type="button"
                data-testid="stop-turn"
                onClick={() => void stopTurn()}
                title="ask Nova to stop this turn; what she already did is not undone"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-card px-3 py-1 text-caption text-content-secondary transition-colors duration-fast hover:bg-surface-card-hover hover:text-content-primary"
              >
                <Square size={11} className="shrink-0" />
                Stop
              </button>
            </div>
          )}
          {/* What core has accepted and not yet answered (S15). Each one can be
              taken back until its turn starts; the X asks the server and the
              chip goes only when the server agrees. */}
          {state.queued.length > 0 && (
            <ul data-testid="queued-list" className="flex flex-col gap-1">
              {state.queued.map(message => (
                <li
                  key={message.id}
                  data-testid={`queued-${message.id}`}
                  className="flex items-start gap-2 rounded-xl border border-dashed border-border bg-surface-elevated/60 px-3 py-1.5 text-caption text-content-secondary"
                >
                  <Clock size={11} className="mt-1 shrink-0 text-content-tertiary" />
                  <span className="min-w-0 flex-1 break-words">{message.body}</span>
                  <button
                    type="button"
                    data-testid={`unqueue-${message.id}`}
                    aria-label={`don't send "${message.body}"`}
                    title="take this message back"
                    onClick={() => {
                      void unqueue(message.id).catch(reason => setLoadError(String(reason)))
                    }}
                    className="shrink-0 rounded-full p-0.5 text-content-tertiary transition-colors duration-fast hover:bg-surface-card-hover hover:text-content-primary"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ChatInput
            onSubmit={sendMessage}
            // Live while a turn runs (S15): a message sent now is QUEUED, not
            // refused, so the box that used to go dead stays usable. `loading`
            // is the one case where there is genuinely nothing to send to yet.
            disabled={loading}
            queueing={state.streaming || responding}
            // The unsent draft is keyed on the conversation, which is globally
            // unique — so it is already per person, and two conversations never
            // show each other's half-written text. Undefined until the
            // conversation resolves; the composer adopts what is typed in that
            // gap rather than discarding it.
            draftKey={
              state.conversationId ? `nova-chat-draft:${state.conversationId}` : undefined
            }
          />
          {/* The control row lives with the input, not the header: the model
              selector (switch inline) and the Clear control. */}
          <ChatControls currentModel={model} onModelChanged={setModel} clearChat={clearChat} />
        </div>
      </div>
    </div>
  )
}
