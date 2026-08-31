import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp } from 'lucide-react'
import { autocompleteMatches, matchCommand, type Command } from '../../lib/commands'

/**
 * The chat composer: a textarea, a send button, and a slash-command
 * autocomplete. The autocomplete is a pure projection of the command registry
 * (lib/commands.ts) — the same list the whole-message parser and /help read —
 * so a command added there shows up here for free.
 *
 * The autocomplete only appears while the input is a leading-slash token
 * (`isSlashQuery`, via `autocompleteMatches`): a normal message, or a "/" in the
 * middle of a sentence, never opens it. When it is open the arrow keys move the
 * selection, Enter completes the highlighted command (or runs it once the input
 * IS the whole command), Esc dismisses it, and clicking a row runs that command.
 * When it is closed, Enter behaves exactly as before — it sends — so Enter is
 * never hijacked away from sending an ordinary message.
 */
export function ChatInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void
  disabled: boolean
}) {
  const [input, setInput] = useState('')
  // Esc sets this to hide a dropdown that still has matches; any edit to the
  // input clears it again, so typing more re-opens the suggestions.
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const matches = autocompleteMatches(input)
  const showDropdown = !disabled && !dismissed && matches.length > 0
  // Guard the index against a shrinking match list between renders.
  const activeIndex = Math.min(highlight, Math.max(0, matches.length - 1))

  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus()
  }, [disabled])

  const submit = (raw?: string) => {
    const text = (raw ?? input).trim()
    if (!text || disabled) return
    setInput('')
    setDismissed(true)
    setHighlight(0)
    requestAnimationFrame(resize)
    onSubmit(text)
  }

  const changeInput = (value: string) => {
    setInput(value)
    setDismissed(false)
    setHighlight(0)
    resize()
  }

  /** Enter/click on a suggestion: run it if the input already IS the whole
   * command (exact match), otherwise complete the input to the command's name. */
  const chooseFromKeyboard = (cmd: Command) => {
    if (matchCommand(input)) submit()
    else changeInput(cmd.name)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight(h => (Math.min(h, matches.length - 1) + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight(h => (Math.min(h, matches.length - 1) - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
      if (e.key === 'Tab') {
        // Tab completes without running, so it never accidentally clears a chat.
        e.preventDefault()
        changeInput(matches[activeIndex].name)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        chooseFromKeyboard(matches[activeIndex])
        return
      }
    }
    // Dropdown closed: the ordinary composer behaviour, Enter sends.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="relative">
      {showDropdown && (
        <div
          role="listbox"
          data-testid="command-autocomplete"
          className="absolute bottom-full left-0 right-0 mb-2 z-50 max-h-60 overflow-y-auto custom-scrollbar rounded-2xl border border-border bg-surface-card shadow-lg py-1 glass-overlay dark:border-white/[0.10]"
        >
          {matches.map((cmd, i) => (
            <button
              key={cmd.name}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              data-testid={`command-option-${cmd.name}`}
              // Run on pointer-down (before the textarea blurs) so a click on a
              // suggestion behaves the same as picking it and pressing Enter.
              onMouseDown={e => {
                e.preventDefault()
                submit(cmd.name)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={clsx(
                'flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors duration-fast',
                i === activeIndex ? 'bg-surface-card-hover' : 'hover:bg-surface-card-hover',
              )}
            >
              <span className="font-mono text-compact text-content-primary">
                {cmd.name}
                {cmd.aliases && cmd.aliases.length > 0 && (
                  <span className="text-content-tertiary"> {cmd.aliases.join(', ')}</span>
                )}
              </span>
              <span className="text-caption text-content-tertiary">{cmd.summary}</span>
            </button>
          ))}
        </div>
      )}

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
          onChange={e => changeInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Nova…  (type / for commands)"
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
    </div>
  )
}
