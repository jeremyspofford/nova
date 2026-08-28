import { memo } from 'react'
import { AlertTriangle, Unplug } from 'lucide-react'
import type { ErrorRow, MessageRow } from './chatReducer'

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="waiting for the model">
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce" />
    </span>
  )
}

export const MessageBubble = memo(function MessageBubble({ row }: { row: MessageRow }) {
  if (row.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="message-user">
        <div className="max-w-[85%] md:max-w-[75%]">
          <div className="glass-card text-content-primary whitespace-pre-wrap rounded-tl-2xl rounded-tr-sm rounded-br-2xl rounded-bl-2xl px-4 py-3 text-body leading-relaxed">
            {row.text}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3 items-start" data-testid="message-assistant">
      <div className="shrink-0 mt-0.5">
        <div className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold select-none bg-accent-dim text-accent">
          N
        </div>
      </div>
      <div className="flex-1 min-w-0 pb-1">
        <div className="text-body leading-relaxed text-content-primary whitespace-pre-wrap break-words">
          {row.text ? row.text : row.streaming ? <LoadingDots /> : null}
        </div>
        {/* A cut-off turn keeps whatever really arrived and says it was cut
            off — the alternative is a truncated answer that reads complete. */}
        {row.interrupted && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-caption text-amber-600 dark:text-amber-400">
            <Unplug size={12} className="shrink-0" />
            Interrupted — the connection dropped before this reply finished.
          </p>
        )}
      </div>
    </div>
  )
})

/**
 * A failed turn. Deliberately not an assistant bubble: an error rendered as
 * speech is the model appearing to say something it never said.
 */
export function ErrorBubble({ row }: { row: ErrorRow }) {
  return (
    <div
      role="alert"
      data-testid="message-error"
      className="flex items-start gap-2 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
    >
      <AlertTriangle size={15} className="shrink-0 mt-0.5" />
      <span className="min-w-0 break-words">{row.reason}</span>
    </div>
  )
}
