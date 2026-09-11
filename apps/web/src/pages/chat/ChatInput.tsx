import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp, Bot } from 'lucide-react'
import { listAgents as apiListAgents, type AgentSummary } from '../../lib/api'
import { autocompleteMatches, matchCommand, type Command } from '../../lib/commands'
import { completeMention, mentionMatches, mentionQuery } from '../../lib/mentions'
import { readLocal, writeLocal } from '../../lib/storage'

/**
 * The chat composer: a textarea, a send button, and two autocompletes. The
 * slash-command one is a pure projection of the command registry
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
 *
 * The `@` autocomplete (S12) offers the agents the same way, on a leading `@`
 * token only (lib/mentions.ts — the same discipline). Its one difference:
 * choosing an option — Enter, Tab, or a click — only ever COMPLETES the input
 * to "@name " and never sends, because a mention is the start of a message,
 * not a whole one. Who actually runs the turn is core's decision, made from
 * the message it receives; the browser only offers names it read from
 * GET /api/v1/agents, and if that read fails the menu simply never opens.
 *
 * `api` is a dependency-injection seam, the ChatPage/ActivityPage idiom:
 * production uses the real client (the DEFAULT_API default); a test injects
 * a fake roster.
 *
 * `draftKey` (S15) is where the unsent text lives between mounts. ChatPage is
 * a route element, so a trip to Settings unmounts this composer and used to
 * take half a typed message with it. The key is per person and conversation
 * (ChatPage composes it), so two conversations never show each other's
 * half-written text. Undefined means "no conversation resolved yet" — typing
 * still works, and the text is adopted into the draft the moment a key
 * arrives, rather than being wiped by it.
 */

interface ChatInputApi {
  listAgents: typeof apiListAgents
}

const DEFAULT_API: ChatInputApi = { listAgents: apiListAgents }

export function ChatInput({
  onSubmit,
  disabled,
  draftKey,
  queueing = false,
  api = DEFAULT_API,
}: {
  onSubmit: (text: string) => void
  disabled: boolean
  draftKey?: string
  /** A turn is running, so sending QUEUES rather than asks (S15). Changes what
   * the send button says it will do; it does not gate anything, because the
   * server is what decides, and it may well have finished by the time the
   * request lands. */
  queueing?: boolean
  api?: ChatInputApi
}) {
  const [input, setInput] = useState(() => (draftKey ? readLocal(draftKey, '') : ''))
  // Esc sets this to hide a dropdown that still has matches; any edit to the
  // input clears it again, so typing more re-opens the suggestions.
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The draft. Written on every edit and removed the moment the message is
  // sent, so storage only ever holds text that was NOT sent — a draft cannot
  // come back to haunt a conversation it already went to.
  const saveDraft = (value: string) => {
    if (draftKey) writeLocal(draftKey, value === '' ? null : value)
  }
  // A conversation switch is a deliberate event; the same key re-rendering is
  // not one. And a key ARRIVING where there was none (ChatPage resolves the
  // conversation a tick after it mounts) adopts whatever is already typed
  // instead of wiping it — the one case where a reset would lose real text.
  const inputRef = useRef(input)
  inputRef.current = input
  const keyRef = useRef<string | undefined>(draftKey)
  useEffect(() => {
    if (draftKey === keyRef.current) return
    const previous = keyRef.current
    keyRef.current = draftKey
    if (draftKey === undefined) return
    const stored = readLocal(draftKey, '')
    if (stored) setInput(stored)
    else if (previous === undefined && inputRef.current) writeLocal(draftKey, inputRef.current)
    else setInput('')
  }, [draftKey])

  // The roster the `@` menu offers (S12): asked for ONCE, the first time the
  // input becomes a leading-@ token, and kept for the life of this composer.
  // null until then — and null for good if the read failed, which is a menu
  // that never opens, not an error to show: the browser only offers names,
  // core decides who runs the turn ("@nobody hi" sends as an ordinary
  // message and Nova says there is no such agent).
  const [agents, setAgents] = useState<AgentSummary[] | null>(null)
  const agentsAsked = useRef(false)
  // Unmount guard for the roster read. Set true on every mount (not just
  // declared true) so StrictMode's mount → cleanup → mount in dev does not
  // leave it false for the composer's whole life.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const query = mentionQuery(input)
  useEffect(() => {
    if (query === null || agentsAsked.current) return
    agentsAsked.current = true
    api
      .listAgents()
      .then(list => {
        if (mounted.current) setAgents(list)
      })
      .catch(() => {
        /* the menu never opens — see above */
      })
  }, [query, api])

  const matches = autocompleteMatches(input)
  const mentions = mentionMatches(query, agents)
  // The two can never both have matches: an input starts with "/" or "@",
  // not both.
  const showDropdown = !disabled && !dismissed && matches.length > 0
  const showMentions = !disabled && !dismissed && mentions.length > 0
  const optionCount = showDropdown ? matches.length : showMentions ? mentions.length : 0
  // Guard the index against a shrinking match list between renders.
  const activeIndex = Math.min(highlight, Math.max(0, optionCount - 1))

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
    saveDraft('')
    setInput('')
    setDismissed(true)
    setHighlight(0)
    requestAnimationFrame(resize)
    onSubmit(text)
  }

  const changeInput = (value: string) => {
    setInput(value)
    saveDraft(value)
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

  /** Enter/Tab/click on an agent: complete to "@name " — never send. The
   * trailing space closes the token, so the menu stands down by itself. */
  const chooseMention = (agent: AgentSummary) => {
    changeInput(completeMention(agent.name))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown || showMentions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight(h => (Math.min(h, optionCount - 1) + 1) % optionCount)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight(h => (Math.min(h, optionCount - 1) - 1 + optionCount) % optionCount)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
      if (showMentions) {
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          chooseMention(mentions[activeIndex])
          return
        }
      } else {
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
    }
    // Dropdown closed: the ordinary composer behaviour, Enter sends.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const menuClass =
    'absolute bottom-full left-0 right-0 mb-2 z-50 max-h-60 overflow-y-auto custom-scrollbar rounded-2xl border border-border bg-surface-card shadow-lg py-1 glass-overlay dark:border-white/[0.10]'
  const optionClass = (active: boolean) =>
    clsx(
      'flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors duration-fast',
      active ? 'bg-surface-card-hover' : 'hover:bg-surface-card-hover',
    )

  return (
    <div className="relative">
      {showDropdown && (
        <div role="listbox" data-testid="command-autocomplete" className={menuClass}>
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
              className={optionClass(i === activeIndex)}
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

      {showMentions && (
        <div role="listbox" data-testid="mention-autocomplete" className={menuClass}>
          {mentions.map((agent, i) => (
            <button
              key={agent.name}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              data-testid={`mention-option-${agent.name}`}
              // Complete on pointer-down (before the textarea blurs) — the
              // same as picking it with Enter. Never sends.
              onMouseDown={e => {
                e.preventDefault()
                chooseMention(agent)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={optionClass(i === activeIndex)}
            >
              <span className="inline-flex items-center gap-1.5 font-mono text-compact text-content-primary">
                <Bot size={12} className="shrink-0 text-accent" />@{agent.name}
              </span>
              <span className="text-caption text-content-tertiary">{agent.purpose}</span>
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
          placeholder="Message Nova…  (type / for commands, @ for an agent)"
          aria-label="Message Nova"
          rows={1}
          className="w-full bg-transparent resize-none text-content-primary placeholder:text-content-tertiary outline-none px-4 pt-4 pb-2"
          style={{ minHeight: '44px', maxHeight: '240px', fontSize: '16px' }}
        />
        <div className="flex items-center justify-end gap-2 px-3 pb-3 pt-1">
          {queueing && (
            <span data-testid="will-queue" className="text-caption text-content-tertiary">
              Nova is working — this will go next
            </span>
          )}
          <button
            type="submit"
            disabled={!input.trim() || disabled}
            aria-label={queueing ? 'Queue message' : 'Send message'}
            title={
              queueing
                ? 'Nova is working, so this is queued and runs when she finishes'
                : undefined
            }
            className={clsx(
              'flex items-center justify-center rounded-full h-9 w-9 transition-colors duration-fast',
              input.trim() && !disabled
                ? 'bg-accent text-on-accent hover:bg-accent-hover'
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
