import { createContext, useCallback, useContext, useReducer, useRef, type ReactNode } from 'react'
import { streamChat, type FetchLike } from '../lib/streamChat'
import { chatReducer, emptyChat, type ChatState } from '../pages/chat/chatReducer'

/**
 * Chat-stream ownership, lifted above the router (the theme-store pattern in
 * this app is prior art: a Provider mounted once, above whatever routes come
 * and go beneath it).
 *
 * The bug this exists to fix (S1 carries, owner hit it live): the SSE stream
 * used to be owned by ChatPage itself, so navigating to Settings unmounted
 * it and aborted the in-flight fetch. The server reads an abort as a genuine
 * disconnect — that is CORRECT and unchanged (ruling S2-R4) — so the fix is
 * entirely on this side: the send lifecycle (the AbortController, the `for
 * await` loop over streamChat, every dispatch of an accumulating delta) now
 * lives in this Provider, not in the page. A page can subscribe and
 * unsubscribe as often as it likes; nothing about that touches the request.
 *
 * ChatPage calls `loadConversation` on every mount with whatever it just
 * fetched. The reducer's `reconcile` action (see chatReducer.ts) is what
 * decides whether that fetch is trusted — it never is, for a conversation
 * this store already lived through, because the store's own view of that
 * conversation is always at least as current as a fetch taken after the
 * fact.
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
}: {
  children: ReactNode
  /** Test seam only — production always uses the real fetch. */
  fetchImpl?: FetchLike
}) {
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChat)
  // Read inside the send loop via a ref, not the `state` closed over at call
  // time: the loop outlives any particular render, and a page that remounts
  // mid-turn must not restart it with a stale conversationId.
  const stateRef = useRef(state)
  stateRef.current = state
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(
    (text: string) => {
      const userId = nextId('u')
      const assistantId = nextId('a')
      dispatch({ type: 'send', userId, assistantId, text })

      const controller = new AbortController()
      abortRef.current = controller
      const conversationId = stateRef.current.conversationId

      ;(async () => {
        try {
          for await (const event of streamChat(
            { message: text, conversationId, signal: controller.signal },
            fetchImpl,
          )) {
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
