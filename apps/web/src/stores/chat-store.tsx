import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { decideConsent as apiDecideConsent } from '../lib/api'
import type { ConsentCard } from '../lib/consentCard'
import { continuationMessage } from '../lib/consentCard'
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
   * S3-T2's approve→executor reconciliation (ruling S3-R4): the policy
   * kernel never runs the gated action at decide time — only flips the
   * consent's status. So this (a) calls the decide API and publishes the
   * result onto any matching row in the transcript (chatReducer's
   * 'consentDecided'), then (b) on a SUCCESSFUL APPROVE of a card tied to
   * the conversation currently open here, fires a real continuation chat
   * turn (the same sendMessage every other message uses — a traced turn,
   * never a fake "it happened") so the model re-issues the same call and the
   * funnel burns the now-approved consent. Deny never continues. A card
   * belonging to some OTHER conversation, or an approve arriving while this
   * store is already mid-turn, also never continues — there is nothing safe
   * to send into a transcript that is not the one the card was raised in, or
   * that is already busy with a turn of its own.
   */
  decideConsent: (card: ConsentCard, decision: 'approve' | 'deny') => Promise<ConsentCard>
}

/** The DI seam for the decide call — same idiom as `fetchImpl`: production
 * uses the real api.decideConsent, tests inject a spy. */
interface ConsentsApi {
  decideConsent: typeof apiDecideConsent
}

const ChatContext = createContext<ChatStore | null>(null)

export function ChatProvider({
  children,
  fetchImpl,
  personId = null,
  consentsApi = { decideConsent: apiDecideConsent },
}: {
  children: ReactNode
  /** Test seam only — production always uses the real fetch. */
  fetchImpl?: FetchLike
  /** The signed-in person's id, or null when signed out. */
  personId?: string | null
  /** Test seam only — production always uses the real api.decideConsent. */
  consentsApi?: ConsentsApi
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

  const resolveServerTurn = useCallback(
    (conversationId: string, messages: { id: string; role: string; content: string }[]) => {
      dispatch({ type: 'pollResolved', conversationId, messages })
    },
    [],
  )

  const setModel = useCallback((model: string) => {
    dispatch({ type: 'modelSwitched', model })
  }, [])

  const decideConsent = useCallback(
    async (card: ConsentCard, decision: 'approve' | 'deny') => {
      const updated = await consentsApi.decideConsent(card.consent_id, decision)
      dispatch({ type: 'consentDecided', card: updated })
      const sameConversation =
        updated.conversation_id !== null &&
        updated.conversation_id === stateRef.current.conversationId
      if (decision === 'approve' && sameConversation && !stateRef.current.streaming) {
        sendMessage(continuationMessage(updated))
      }
      return updated
    },
    [consentsApi, sendMessage],
  )

  return (
    <ChatContext.Provider
      value={{ state, sendMessage, loadConversation, resolveServerTurn, setModel, decideConsent }}
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
