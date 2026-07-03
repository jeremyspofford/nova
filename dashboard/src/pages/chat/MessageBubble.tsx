import { memo, useMemo, useState } from 'react'
import { useNovaIdentity } from '../../hooks/useNovaIdentity'
import { useIsMobile } from '../../hooks/useIsMobile'
import { FileText, Brain, ChevronRight } from 'lucide-react'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import { ActivityFeed } from '../../components/ActivityFeed'
import { cleanToolArtifacts } from '../../utils/cleanToolArtifacts'
import type { Message } from '../../stores/chat-store'

type TextSize = 'small' | 'medium' | 'large'

const TEXT_SIZE_CLASSES: Record<TextSize, string> = {
  small: 'text-compact leading-relaxed',
  medium: 'text-body leading-relaxed',
  large: 'text-[16px] leading-relaxed',
}

const MOBILE_TEXT_SIZE_CLASSES: Record<TextSize, string> = {
  small: 'text-body leading-relaxed',
  medium: 'text-[16px] leading-[1.65]',
  large: 'text-[17px] leading-[1.65]',
}

const VOICE_TEXT_CLASS = 'text-[20px] leading-[1.6]'

/**
 * Live "thinking" block — the model's planning prose from tool rounds.
 * Auto-expanded while the model is still working with no answer yet; once the
 * answer starts, it collapses to a one-line disclosure the user can re-open.
 */
function ThinkingBlock({ text, streaming, hasAnswer }: { text: string; streaming: boolean; hasAnswer: boolean }) {
  const autoOpen = streaming && !hasAnswer
  const [open, setOpen] = useState(autoOpen)
  // Follow the auto state until the user interacts (once answer lands, collapse).
  const [touched, setTouched] = useState(false)
  const expanded = touched ? open : autoOpen

  return (
    <div className="mb-2">
      <button
        onClick={() => { setTouched(true); setOpen(!expanded) }}
        className="flex items-center gap-1.5 text-caption text-content-tertiary hover:text-content-secondary transition-colors"
      >
        <Brain size={12} className="shrink-0 text-amber-400/70" />
        <span>{streaming && !hasAnswer ? 'Thinking' : 'Thought process'}</span>
        <ChevronRight size={11} className={clsx('shrink-0 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="mt-1.5 pl-2 border-l-2 border-amber-400/20 text-caption text-content-tertiary whitespace-pre-wrap leading-relaxed">
          {text}
        </div>
      )}
    </div>
  )
}

function LoadingDots({ thinking }: { thinking: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      <span className={clsx('h-1.5 w-1.5 rounded-full animate-bounce [animation-delay:-0.3s]', thinking ? 'bg-amber-400' : 'bg-accent')} />
      <span className={clsx('h-1.5 w-1.5 rounded-full animate-bounce [animation-delay:-0.15s]', thinking ? 'bg-amber-400' : 'bg-accent')} />
      <span className={clsx('h-1.5 w-1.5 rounded-full animate-bounce', thinking ? 'bg-amber-400' : 'bg-accent')} />
    </span>
  )
}

export const MessageBubble = memo(function MessageBubble({
  message,
  conversationMode = false,
}: {
  message: Message
  conversationMode?: boolean
}) {
  const { avatarUrl, isDefaultAvatar } = useNovaIdentity()
  const isMobile = useIsMobile()
  const isUser = message.role === 'user'
  const isThinking = !isUser && !!message.isStreaming && !message.content
  const textSize = (localStorage.getItem('nova_text_size') as TextSize) || 'medium'
  const isVoiceActive = conversationMode && message.isStreaming && !isUser
  const cleanedContent = useMemo(
    () => !isUser && message.content ? cleanToolArtifacts(message.content) : message.content,
    [isUser, message.content],
  )

  const textClass = isVoiceActive
    ? VOICE_TEXT_CLASS
    : isMobile
      ? MOBILE_TEXT_SIZE_CLASSES[textSize]
      : TEXT_SIZE_CLASSES[textSize]

  // ── User message — glass-card bubble, right-aligned ──
  if (isUser) {
    return (
      <div className="group flex justify-end">
        <div className={isMobile ? 'max-w-[85%]' : 'max-w-[75%] md:max-w-prose'}>
          <div className={clsx(
            textClass,
            isMobile
              ? 'bg-stone-800 text-content-primary whitespace-pre-wrap rounded-2xl px-4 py-3'
              : 'glass-card text-content-primary whitespace-pre-wrap rounded-tl-2xl rounded-tr-sm rounded-br-2xl rounded-bl-2xl px-4 py-3',
          )}>
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {message.attachments.map(att =>
                  att.type === 'image' && att.previewUrl ? (
                    <img key={att.id} src={att.previewUrl} alt={att.file.name} className="max-w-[200px] max-h-[150px] rounded-sm object-cover" />
                  ) : (
                    <span key={att.id} className="inline-flex items-center gap-1 rounded-xs bg-accent-500/20 px-2 py-1 text-micro">
                      <FileText size={12} />{att.file.name}
                    </span>
                  ),
                )}
              </div>
            )}
            {cleanedContent || '\u2014'}
          </div>
          <p className={clsx(
            'mt-1 font-mono text-[10px] text-content-tertiary/60 px-1 text-right',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-fast',
          )}>
            {format(message.timestamp, 'h:mm a')}
          </p>
        </div>
      </div>
    )
  }

  // ── Assistant message — no bubble, flowing text with avatar dot ──
  return (
    <div className="group flex gap-3 items-start">
      {/* Avatar */}
      <div className="shrink-0 mt-0.5">
        {isDefaultAvatar ? (
          <div className={clsx(
            'h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold select-none',
            isThinking ? 'bg-amber-500/20 text-amber-400' : 'bg-teal-500/20 text-teal-400',
          )}>
            N
          </div>
        ) : (
          <img src={avatarUrl} alt="Nova" className={clsx(
            'h-6 w-6 rounded-full object-cover',
            isThinking && 'ring-2 ring-amber-500/40',
          )} />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-1">
        {message.activitySteps && message.activitySteps.length > 0 && (
          <ActivityFeed
            steps={message.activitySteps}
            collapsed={message.activityCollapsed ?? false}
            isStreaming={message.isStreaming ?? false}
          />
        )}

        {message.thinking && (
          <ThinkingBlock
            text={message.thinking}
            streaming={message.isStreaming ?? false}
            hasAnswer={!!cleanedContent}
          />
        )}

        <div className={clsx(
          textClass,
          'text-content-primary markdown-body overflow-x-auto',
          isThinking && 'text-amber-200/80',
        )}>
          {cleanedContent ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanedContent}</ReactMarkdown>
          ) : message.isStreaming ? (
            <LoadingDots thinking={isThinking} />
          ) : '\u2014'}
        </div>

        {/* Footer — visible on hover only */}
        <p className="mt-2 font-mono text-[10px] text-content-tertiary/60 opacity-0 group-hover:opacity-100 transition-opacity duration-fast">
          {format(message.timestamp, 'h:mm a')}
          {message.modelUsed && (
            <span className="ml-1.5">
              &middot; {message.modelUsed}
              {message.category && (
                <span className="text-content-tertiary/50"> ({message.category})</span>
              )}
            </span>
          )}
        </p>
      </div>
    </div>
  )
})
