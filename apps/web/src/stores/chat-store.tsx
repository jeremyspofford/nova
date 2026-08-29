import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
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
}

const ChatContext = createContext<ChatStore | null>(null)

export function ChatProvider({
  children,
  fetchImpl,
  personId = null,
}: {
  children: ReactNode
  /** Test seam only — production always uses the real fetch. */
  fetchImpl?: FetchLike
  /** The signed-in person's id, or null when signed out. */
  personId?: string | null
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

  const sendMessage = useCallback(
    (text: string) => {
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
    [fetchImpl],
  )

  const loadConversation = useCallback(
    (conversationId: string, messages: { id: string; role: string; content: string }[]) => {
      dispatch({ type: 'reconcile', conversationId, messages })
    },
    [],
  )

  return (
    <ChatContext.Provider value={{ state, sendMessage, loadConversation }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChatStore(): ChatStore {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatStore must be used within ChatProvider')
  return ctx
}
