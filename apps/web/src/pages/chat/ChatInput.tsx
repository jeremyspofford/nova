import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp } from 'lucide-react'

/**
 * The S1 composer: a textarea and a send button. Attachments, voice, the
 * research toggles and the model picker are later slices — the pill shape and
 * behaviour are kept so they have somewhere to land.
 */
export function ChatInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void
  disabled: boolean
}) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus()
  }, [disabled])

  const submit = () => {
    const text = input.trim()
    if (!text || disabled) return
    setInput('')
    requestAnimationFrame(resize)
    onSubmit(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
      className="glass-card rounded-3xl border border-border-subtle overflow-hidden"
    >
      <textarea
        ref={textareaRef}
        value={input}
        onChange={e => {
          setInput(e.target.value)
          resize()
        }}
        onKeyDown={handleKeyDown}
        placeholder="Message Nova…"
        aria-label="Message Nova"
        rows={1}
        className="w-full bg-transparent resize-none text-content-primary placeholder:text-content-tertiary outline-none px-4 pt-4 pb-2"
        style={{ minHeight: '44px', maxHeight: '240px', fontSize: '16px' }}
      />
      <div className="flex items-center justify-end px-3 pb-3 pt-1">
        <button
          type="submit"
          disabled={!input.trim() || disabled}
          aria-label="Send message"
          className={clsx(
            'flex items-center justify-center rounded-full h-9 w-9 transition-colors duration-fast',
            input.trim() && !disabled
              ? 'bg-accent text-neutral-950 hover:bg-accent-hover'
              : 'bg-surface-elevated text-content-tertiary cursor-not-allowed',
          )}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </form>
  )
}
