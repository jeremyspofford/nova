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
import { streamChat, type FetchLike } from '../lib/streamChat'
import { chatReducer, emptyChat, type ChatState } from '../pages/chat/chatReducer'

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
  loadConversation: (
    conversationId: string,
    messages: { id: string; role: string; content: string }[],
  ) => void
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
  resolveServerTurn: (
    conversationId: string,
    messages: { id: string; role: string; content: string }[],
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
    [fetchImpl, clearChat, appendLocalMessage],
  )

  const loadConversation = useCallback(
    (conversationId: string, messages: { id: string; role: string; content: string }[]) => {
      dispatch({ type: 'reconcile', conversationId, messages })
    },
    [],
  )

  const resolveServerTurn = useCallback(
    (conversationId: string, messages: { id: string; role: string; content: string }[]) => {
      dispatch({ type: 'pollResolved', conversationId, messages })
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
        setModel,
        clearChat,
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
