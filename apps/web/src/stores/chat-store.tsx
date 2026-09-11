import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { clearConversation as apiClearConversation } from '../lib/api'
import { matchCommand } from '../lib/commands'
import {
  failureReason,
  parseQueued,
  statedRefusal,
  streamChat,
  type FetchLike,
} from '../lib/streamChat'
import {
  chatReducer,
  emptyChat,
  type ChatRow,
  type ChatState,
  type FetchedMessage,
  type QueuedMessage,
} from '../pages/chat/chatReducer'

/**
 * Chat-stream ownership, lifted out of ChatPage so a turn keeps running when
 * the page that started it goes away — the theme-store pattern in this app
 * is prior art for a Provider whose lifecycle is not tied to one page. It
 * is mounted at the authenticated-routes boundary in App.tsx: above the
 * `/chat` <-> `/settings` swap (so a turn survives that navigation), but
 * below sign-in/sign-out (so it does NOT survive a change of who is signed
 * in). Before this existed, the SSE stream was owned by ChatPage itself, so
 * navigating to Settings unmounted it and aborted the in-flight fetch — the
 * server reads an abort as a genuine disconnect, which was always correct
 * server-side behavior, so the fix is entirely client-side: the
 * AbortController and the `for await` loop over streamChat now live here,
 * and a page can subscribe and unsubscribe from this Provider as often as
 * it likes without touching either. (Ruling S2-R4.)
 *
 * ChatPage calls `loadConversation` on every mount with whatever it just
 * fetched. The reducer's `reconcile` action (chatReducer.ts) decides
 * whether that fetch is trusted — it never is, for a conversation this
 * store already lived through, because the store's own view of that
 * conversation is always at least as current as a fetch taken after the
 * fact.
 *
 * A browser tab is not one conversation, though — it is whoever is
 * currently signed into it, and a stream started by one person must never
 * write into a transcript another person is now looking at. `personId`
 * carries the signed-in identity so this store can enforce that itself
 * (see the `identityRef` guard in `sendMessage` below), on top of — not
 * instead of — being unmounted on sign-out by its placement in App.tsx:
 * placement is a fact about the component tree, so a future refactor that
 * moves this Provider without noticing the safety implication would
 * silently drop that protection; the guard here does not depend on where
 * the Provider happens to be mounted.
 */

let seq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`

interface ChatStore {
  state: ChatState
  sendMessage: (text: string) => void
  loadConversation: (conversationId: string, messages: FetchedMessage[]) => void
  /**
   * Resolve a turn that finished SERVER-SIDE — one this store never streamed
   * (the durable-turn case: a hard refresh mid-reply, so core finished the
   * turn detached and persisted the full answer). ChatPage's in-flight poll
   * calls this with the now-complete history once core reports the turn done.
   * Unlike loadConversation's reconcile, the fetched rows are authoritative
   * here (the store did not live through this turn), so they replace the
   * pre-reply rows — resolving the pending reply into the same set, never a
   * duplicate. The reducer still drops it if the store has since started its
   * own live turn or moved to another conversation.
   */
  resolveServerTurn: (conversationId: string, messages: FetchedMessage[]) => void
  /**
   * The idle poll's hand-off (S9): history fetched while NO turn was in
   * flight, merged into the transcript by id (chatReducer's `idlePolled`) —
   * rows the server has that this store does not (a reminder that fired, a
   * scheduled turn's reply) appear in server order; rows this store streamed
   * itself are recognised, never shown twice; client-only rows (a stated
   * failure, a /help note) are kept. `observedRows` is the transcript as it
   * was when the fetch was issued — if it moved in between, the reducer drops
   * the result and the next poll asks again.
   */
  syncFromServer: (
    conversationId: string,
    messages: FetchedMessage[],
    observedRows: ChatRow[],
  ) => void
  /**
   * Slice 2f Fix A: a successful Settings->Models switch calls this so the
   * chat badge updates immediately, with no message sent — `state.model`
   * is the single source ChatPage's badge and Settings' "current" marker
   * both read (SettingsPage bridges the two: see its own docstring).
   */
  setModel: (model: string) => void
  /**
   * Clear the open conversation's transcript — the "Clear chat" button and the
   * `/clear` (alias `/reset`) slash command both land here. Aborts any turn in
   * flight, calls the clear API, and ONLY on its ok empties the store to the
   * conversation's empty state (never a fake success — the UI resets after the
   * server confirms). A no-op with nothing loaded yet. The command is parsed in
   * sendMessage: a whole-message `/clear` routes here instead of streaming; a
   * message merely containing "/clear" sends normally (see lib/commands.ts).
   */
  clearChat: () => Promise<void>
  /**
   * Ask core to stop the turn in flight (S15). A no-op when this tab is not
   * streaming one. It ASKS and nothing more: core ends the turn and sends the
   * `stopped` frame, and that frame is what settles the row — so the store
   * never shows an ending it has only requested. Aborting locally instead
   * would be a disconnect, which ruling S2c-R1 defines as "finish".
   */
  stopTurn: () => Promise<void>
  /**
   * Record the turn a RELOADED tab found already running server-side (S15),
   * learned from /conversations/active. It only gives `stopTurn` something to
   * address — the pending-turn poll still owns the transcript. Pass null once
   * the poll resolves.
   */
  noteServerTurn: (turnId: string | null) => void
  /**
   * Take back a message core accepted but has not run (S15). Rejects with the
   * server's own words when it refuses — a message already being answered
   * cannot be withdrawn, and the chip must stay rather than imply it was.
   */
  unqueue: (id: string) => Promise<void>
  /** Adopt the server's list of accepted-but-unanswered messages. The server is
   * what runs them, so its list is the truth; ChatPage hands this the `queued`
   * field of /conversations/active on every poll tick. */
  syncQueue: (queued: QueuedMessage[]) => void
}

/** The DI seam for the clear-chat call — same idiom as `fetchImpl`: production
 * uses the real api.clearConversation, tests inject a spy. */
interface ConversationsApi {
  clearConversation: typeof apiClearConversation
}

const ChatContext = createContext<ChatStore | null>(null)

export function ChatProvider({
  children,
  fetchImpl,
  personId = null,
  conversationsApi = { clearConversation: apiClearConversation },
}: {
  children: ReactNode
  /** Test seam only — production always uses the real fetch. */
  fetchImpl?: FetchLike
  /** The signed-in person's id, or null when signed out. */
  personId?: string | null
  /** Test seam only — production always uses the real api.clearConversation. */
  conversationsApi?: ConversationsApi
}) {
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChat)
  // Read inside the send loop via a ref, not the `state` closed over at call
  // time: the loop outlives any particular render, and a page that remounts
  // mid-turn must not restart it with a stale conversationId.
  const stateRef = useRef(state)
  stateRef.current = state
  const abortRef = useRef<AbortController | null>(null)

  // Updated synchronously during render (not in an effect) so it already
  // reflects the new identity by the time any event dispatched THIS render
  // is checked below — an effect fires a tick later, which would let one
  // more event slip through under the old identity first.
  const identityRef = useRef(personId)
  identityRef.current = personId

  // Distinguishes "personId changed" from "this is the first render" — the
  // sentinel starts undefined and personId itself is `string | null`, so
  // the two can never collide.
  const previousIdentity = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const isChange = previousIdentity.current !== undefined && previousIdentity.current !== personId
    previousIdentity.current = personId
    if (isChange) {
      // Whoever is signed in now inherits a blank transcript, never the
      // previous person's — belt to the guard's suspenders in sendMessage,
      // for the case this Provider is ever mounted somewhere that does not
      // naturally unmount on identity change.
      dispatch({ type: 'reset' })
    }
    return () => {
      // Runs on every identity change (before the effect above runs again)
      // AND on unmount — either way, whatever this identity had in flight
      // stops being fetched the moment it stops being current.
      abortRef.current?.abort()
    }
  }, [personId])

  const clearChat = useCallback(async () => {
    const conversationId = stateRef.current.conversationId
    if (!conversationId) {
      // Nothing loaded in this tab yet — there is nothing on the server to
      // clear. Still empty any local rows so the UI is consistent.
      dispatch({ type: 'reset' })
      return
    }
    // Stop any turn in flight first: its late frames must not land into a
    // transcript we are about to empty.
    abortRef.current?.abort()
    await conversationsApi.clearConversation(conversationId)
    // Only after the server confirms the delete — no fake success.
    dispatch({ type: 'cleared', conversationId })
  }, [conversationsApi])

  const noteServerTurn = useCallback((turnId: string | null) => {
    dispatch({ type: 'serverTurn', turnId })
  }, [])

  /** Send while a turn is already running (S15).
   *
   * Its own fetch, deliberately not `streamChat`'s event loop: those events are
   * written for the row being filled in, and feeding a `done` or an `error` from
   * THIS request into the reducer would settle — or destroy — the live turn's
   * bubble. Nothing here touches `abortRef`, `pendingId` or `streaming` either.
   *
   * The SERVER decides which it was. A 202 is an accepted message and becomes a
   * chip. A 200 means the turn ended between the check and the request, so core
   * started this message as a real turn instead: the turn finishes and persists
   * regardless of who is reading (S2c), `pending_turn` is true meanwhile, and
   * this tab picks the reply up through the same poll a reload uses — rather
   * than this path inventing a second way to render a live turn.
   */
  const queueMessage = useCallback(
    async (text: string) => {
      const send: FetchLike = fetchImpl ?? (((url, init) => fetch(url, init)) as FetchLike)
      const conversationId = stateRef.current.conversationId
      const body: Record<string, unknown> = { message: text }
      if (conversationId) body.conversation_id = conversationId
      let response: Response
      try {
        response = await send('/api/v1/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        })
      } catch (err) {
        dispatch({ type: 'queueFailed', reason: `could not reach Nova — ${failureReason(err)}` })
        return
      }
      if (response.status === 202) {
        const queued = parseQueued(await response.text())
        if (queued === null) {
          dispatch({
            type: 'queueFailed',
            reason: 'Nova accepted that message but described it in a way this page cannot read',
          })
          return
        }
        dispatch({ type: 'event', event: queued })
        return
      }
      if (!response.ok) {
        dispatch({ type: 'queueFailed', reason: await statedRefusal(response) })
        return
      }
      // A 200: core started it. Nothing to render here — the reply lands through
      // the pending-turn poll, the same path a reloaded tab uses.
    },
    [fetchImpl],
  )

  const unqueue = useCallback(
    async (id: string) => {
      const send: FetchLike = fetchImpl ?? (((url, init) => fetch(url, init)) as FetchLike)
      const response = await send(`/api/v1/chat/queued/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (!response.ok) {
        // The message is still going to run; a chip that vanished here would say
        // the opposite. Same discipline as clearChat: never a fake success.
        throw new Error(await statedRefusal(response))
      }
      dispatch({ type: 'unqueued', id })
    },
    [fetchImpl],
  )

  const syncQueue = useCallback((queued: QueuedMessage[]) => {
    dispatch({ type: 'queueSynced', queued })
  }, [])

  const stopTurn = useCallback(async () => {
    const turnId = stateRef.current.turnId
    // No turn id means no turn this tab is streaming — nothing to stop, and
    // nothing to ask about. Read from the ref, not a closed-over render.
    if (!turnId) return
    // Asked, never assumed. The request does NOT abort the local stream and
    // does not settle the row: core ends the turn and sends the `stopped`
    // frame, and THAT is what the reducer acts on. Aborting here instead would
    // be the browser claiming an ending it only requested — and a disconnect
    // means "finish", not "stop" (ruling S2c-R1).
    const send: FetchLike = fetchImpl ?? (((url, init) => fetch(url, init)) as FetchLike)
    await send(`/api/v1/chat/turns/${turnId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    })
  }, [fetchImpl])

  // A local, un-sent assistant row (the /help listing). Never streamed to the
  // model, never persisted — see chatReducer's 'localMessage'.
  const appendLocalMessage = useCallback((text: string) => {
    dispatch({ type: 'localMessage', id: nextId('local'), text })
  }, [])

  const sendMessage = useCallback(
    (text: string) => {
      const command = matchCommand(text)
      if (command) {
        // A whole-message slash command (e.g. /clear, /help) is a command, not a
        // turn: run its registered effect instead of streaming to the model. The
        // parser is the registry's own (lib/commands.ts), so a message that
        // merely CONTAINS "/clear" mid-text still sends normally.
        command.run({ clearChat, appendLocalMessage })
        return
      }
      if (stateRef.current.streaming) {
        // A turn is already running, so this message is for the queue (S15).
        // Read from the ref, not a render's closure: the composer can be a
        // render behind, and the SERVER decides anyway — if the turn has in fact
        // ended, core starts this message and queueMessage says what happens
        // then. The live turn's state is not touched on this path.
        void queueMessage(text)
        return
      }
      const userId = nextId('u')
      const assistantId = nextId('a')
      dispatch({ type: 'send', userId, assistantId, text })

      const controller = new AbortController()
      abortRef.current = controller
      const conversationId = stateRef.current.conversationId
      const startedForIdentity = identityRef.current

      ;(async () => {
        try {
          for await (const event of streamChat(
            { message: text, conversationId, signal: controller.signal },
            fetchImpl,
          )) {
            // The identity effect above aborts the underlying request the
            // moment it stops being current, but one event already in
            // flight can still resolve after that — this is what actually
            // guarantees it never reaches the reducer, independent of
            // timing. Breaking here also runs streamChat's own cleanup
            // (its `finally` cancels the reader), so nothing is leaked.
            if (identityRef.current !== startedForIdentity) break
            dispatch({ type: 'event', event })
          }
        } finally {
          if (abortRef.current === controller) abortRef.current = null
        }
      })()
    },
    [fetchImpl, clearChat, appendLocalMessage, queueMessage],
  )

  const loadConversation = useCallback((conversationId: string, messages: FetchedMessage[]) => {
    dispatch({ type: 'reconcile', conversationId, messages })
  }, [])

  const resolveServerTurn = useCallback((conversationId: string, messages: FetchedMessage[]) => {
    dispatch({ type: 'pollResolved', conversationId, messages })
  }, [])

  const syncFromServer = useCallback(
    (conversationId: string, messages: FetchedMessage[], observedRows: ChatRow[]) => {
      dispatch({ type: 'idlePolled', conversationId, messages, observedRows })
    },
    [],
  )

  const setModel = useCallback((model: string) => {
    dispatch({ type: 'modelSwitched', model })
  }, [])

  return (
    <ChatContext.Provider
      value={{
        state,
        sendMessage,
        loadConversation,
        resolveServerTurn,
        syncFromServer,
        setModel,
        clearChat,
        stopTurn,
        noteServerTurn,
        unqueue,
        syncQueue,
      }}
    >
      {children}
    </ChatContext.Provider>
  )
}

export function useChatStore(): ChatStore {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatStore must be used within ChatProvider')
  return ctx
}
