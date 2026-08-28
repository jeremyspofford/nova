import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { getActiveConversation, getMessages } from '../../lib/api'
import { streamChat } from '../../lib/streamChat'
import { chatReducer, emptyChat } from './chatReducer'
import { ChatInput } from './ChatInput'
import { ErrorBubble, MessageBubble } from './MessageBubble'

let seq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`

/**
 * One conversation, streamed. The transcript itself lives in chatReducer —
 * this component is the wiring: load the active conversation, push stream
 * events into the reducer, keep the view scrolled.
 */
export function ChatPage({ initialModel }: { initialModel?: string }) {
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChat)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const conversationRef = useRef<string | null>(null)
  conversationRef.current = state.conversationId

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const conversation = await getActiveConversation()
        const messages = await getMessages(conversation.id)
        if (!live) return
        dispatch({ type: 'loaded', conversationId: conversation.id, messages })
      } catch (err) {
        // History is unreadable, but a turn can still be taken: core resolves
        // the active conversation itself when none is named.
        if (live) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // Do not yank the view away from someone reading further up.
    if (distanceFromBottom < 200) el.scrollTop = el.scrollHeight
  }, [state.rows])

  const handleSubmit = useCallback(async (text: string) => {
    const assistantId = nextId('a')
    dispatch({ type: 'send', userId: nextId('u'), assistantId, text })

    const controller = new AbortController()
    abortRef.current = controller
    try {
      for await (const event of streamChat({
        message: text,
        conversationId: conversationRef.current,
        signal: controller.signal,
      })) {
        dispatch({ type: 'event', event })
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [])

  const model = state.model || initialModel || ''

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-root dark:bg-transparent">
      <header className="shrink-0 flex items-center justify-between gap-3 px-4 md:px-8 h-14 border-b border-border-subtle">
        <h1 className="text-h3 text-content-primary">Chat</h1>
        {model && (
          <span className="font-mono text-micro text-content-tertiary truncate" title="serving model">
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

          {!loading && !loadError && state.rows.length === 0 && (
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
        </div>
      </div>

      <div className="shrink-0 w-full px-2 md:px-8 pb-[max(env(safe-area-inset-bottom),0.5rem)] md:pb-4">
        <div className="mx-auto max-w-none md:max-w-3xl">
          <ChatInput onSubmit={handleSubmit} disabled={state.streaming} />
        </div>
      </div>
    </div>
  )
}
