import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  getActiveConversation as apiGetActiveConversation,
  getMessages as apiGetMessages,
} from '../../lib/api'
import { useChatStore } from '../../stores/chat-store'
import { ChatInput } from './ChatInput'
import { ErrorBubble, MessageBubble } from './MessageBubble'

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
 * `api` is a dependency-injection seam, the same idiom as ActivityPage's:
 * production uses the real client (the DEFAULT_API default); a test injects
 * fakes. `pollIntervalMs`/`maxPollMs` are injectable so a test can drive the
 * poll on real timers without waiting seconds.
 */

interface ChatApi {
  getActiveConversation: typeof apiGetActiveConversation
  getMessages: typeof apiGetMessages
}

const DEFAULT_API: ChatApi = {
  getActiveConversation: apiGetActiveConversation,
  getMessages: apiGetMessages,
}

// How often to ask core whether the in-flight turn has landed, and how long
// to keep asking before giving up and showing whatever is there. The ceiling
// tracks core's own gateway read budget (GATEWAY_TIMEOUT read=300s) so the
// poll never gives up before the turn itself possibly could.
const POLL_INTERVAL_MS = 1500
const MAX_POLL_MS = 300_000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function ChatPage({
  initialModel,
  api = DEFAULT_API,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxPollMs = MAX_POLL_MS,
}: {
  initialModel?: string
  api?: ChatApi
  pollIntervalMs?: number
  maxPollMs?: number
}) {
  const { state, sendMessage, loadConversation, resolveServerTurn } = useChatStore()
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

        // A hard refresh leaves the store empty but a turn still running in
        // core. Poll for it — but only if the store is not ALREADY streaming
        // this turn itself (the in-app-nav case, which the surviving store
        // handles without any polling).
        if (conversation.pending_turn && !streamingRef.current) {
          setResponding(true)
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
      const deadline = Date.now() + maxPollMs
      while (live && Date.now() < deadline) {
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
        } catch {
          // A transient read failure is not a finished turn — keep polling.
          continue
        }
        if (!live) return
        if (!active.pending_turn) {
          // The turn closed: fetch the now-complete history and resolve it.
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
      // Gave up (deadline) or unmounted: clear the indicator. Whatever is in
      // the store is shown; nothing is invented.
      if (live) setResponding(false)
    }

    return () => {
      live = false
    }
  }, [api, loadConversation, resolveServerTurn, pollIntervalMs, maxPollMs])

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
      <header className="shrink-0 flex items-center justify-between gap-3 px-4 md:px-8 h-14 border-b border-border-subtle">
        <h1 className="text-h3 text-content-primary">Chat</h1>
        {model && (
          <span
            className="font-mono text-micro text-content-tertiary truncate"
            title="serving model"
            data-testid="chat-model"
          >
            {model}
          </span>
        )}
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
        <div className="mx-auto max-w-none md:max-w-3xl">
          <ChatInput onSubmit={sendMessage} disabled={state.streaming} />
        </div>
      </div>
    </div>
  )
}
