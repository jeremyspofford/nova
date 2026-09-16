import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp, Bot, Paperclip, X } from 'lucide-react'
import {
  listAgents as apiListAgents,
  uploadAttachment as apiUploadAttachment,
  type AgentSummary,
} from '../../lib/api'
import { pastedName } from './pastedName'
import { autocompleteMatches, matchCommand, type Command } from '../../lib/commands'
import { completeMention, mentionMatches, mentionQuery } from '../../lib/mentions'
import { readLocal, writeLocal } from '../../lib/storage'
import { useIsMobile } from '../../hooks/useIsMobile'

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
  uploadAttachment: typeof apiUploadAttachment
}

const DEFAULT_API: ChatInputApi = {
  listAgents: apiListAgents,
  uploadAttachment: apiUploadAttachment,
}

/** One file on its way in, or already there (S28).
 *
 * `status` exists because an upload takes TIME — a phone photo over a slow
 * connection is seconds — and a chip that looks ready before its bytes have
 * landed is a message he can send with an id the server has never heard of.
 * Sending waits for `ready`. */
interface Pending {
  key: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'failed'
  /** Core's id, once it exists. This is what the message carries. */
  id?: string
  /** Core's own sentence, when it refused. Shown verbatim on the chip. */
  error?: string
}

export function ChatInput({
  onSubmit,
  disabled,
  draftKey,
  queueing = false,
  api = DEFAULT_API,
  conversationId,
}: {
  onSubmit: (text: string, attachmentIds?: string[]) => void
  disabled: boolean
  draftKey?: string
  /** A turn is running, so sending QUEUES rather than asks (S15). Changes what
   * the send button says it will do; it does not gate anything, because the
   * server is what decides, and it may well have finished by the time the
   * request lands. */
  queueing?: boolean
  api?: ChatInputApi
  /** Which conversation a file belongs to (S28). Absent until the first
   * conversation loads, and attaching is simply not offered until then —
   * an upload with nowhere to go is a file that lands in a folder named
   * after nothing. */
  conversationId?: string | null
}) {
  const [input, setInput] = useState(() => (draftKey ? readLocal(draftKey, '') : ''))
  // S28: files on their way in. Composer state, not page state — they belong
  // to the message being written, and abandoning a draft abandons them.
  const [pending, setPending] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // Esc sets this to hide a dropdown that still has matches; any edit to the
  // input clears it again, so typing more re-opens the suggestions.
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isMobile = useIsMobile()

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

  // An upload still in flight, or one that failed. Sending is held for the
  // first and not for the second: a failed chip has already said why, and
  // blocking the message on it would trap him behind a file he cannot fix.
  const uploading = pending.some(p => p.status === 'uploading')
  const ready = pending.filter(p => p.status === 'ready' && p.id)

  const submit = (raw?: string) => {
    const text = (raw ?? input).trim()
    // A file alone is a message: "here, look at this" with no words is a
    // thing people send. Text is required only when nothing is attached.
    if ((!text && ready.length === 0) || disabled || uploading) return
    saveDraft('')
    setInput('')
    setPending([])
    setDismissed(true)
    setHighlight(0)
    requestAnimationFrame(resize)
    onSubmit(text, ready.map(p => p.id!))
  }

  /** Take one file: show it immediately, upload it, keep whatever core says.
   *
   * The chip appears BEFORE the upload finishes, because a phone photo takes
   * seconds and a composer that does nothing for three seconds reads as
   * broken. It cannot be sent until the id exists — `submit` waits — so what
   * he sees is honest about the state without pretending it is done. */
  const take = async (file: File) => {
    if (!conversationId) return
    const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`
    const name = pastedName(file)
    setPending(prev => [...prev, { key, name, size: file.size, status: 'uploading' }])
    try {
      // Renamed on the way IN, so the name core stores, the chip here, and
      // the name she sees in the turn are one name.
      const sending = name === file.name ? file : new File([file], name, { type: file.type })
      const got = await api.uploadAttachment(conversationId, sending)
      setPending(prev =>
        prev.map(p => (p.key === key ? { ...p, status: 'ready', id: got.id, name: got.filename } : p)),
      )
    } catch (err) {
      // Core's own sentence — the ceiling and the size for something too
      // big. "Upload failed" with no number is how someone tries the same
      // photo three times.
      const why = err instanceof Error ? err.message : String(err)
      setPending(prev => prev.map(p => (p.key === key ? { ...p, status: 'failed', error: why } : p)))
    }
  }

  const takeAll = (files: FileList | File[] | null | undefined) => {
    for (const file of Array.from(files ?? [])) void take(file)
  }

  /** PASTE — the one he asked for by name: copy a screenshot, paste it here.
   *
   * `clipboardData.files` is empty for a screenshot in some browsers, so the
   * items are walked instead. Text pastes fall through untouched: this only
   * intercepts when the clipboard actually carries a FILE, and pasting a
   * paragraph must keep working exactly as it did. */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!conversationId) return
    const files: File[] = []
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    if (files.length === 0) return
    // Only now: a clipboard with no file in it is a text paste and belongs
    // to the textarea.
    e.preventDefault()
    takeAll(files)
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
        className={clsx(
          'glass-card rounded-3xl border overflow-hidden transition-colors',
          dragging ? 'border-accent bg-accent-dim/30' : 'border-border-subtle',
        )}
        // DROP: the second way in, and the one with no button to find. The
        // whole composer is the target rather than a strip inside it —
        // dropping a file "near" the box is what people actually do.
        onDragOver={e => {
          if (!conversationId) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={e => {
          // Only when the pointer has really left the composer: dragging
          // across a child fires dragleave for the child.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDragging(false)
        }}
        onDrop={e => {
          if (!conversationId) return
          e.preventDefault()
          setDragging(false)
          takeAll(e.dataTransfer?.files)
        }}
      >
        {/* WHAT IS ATTACHED, above the text he is writing about it. Each chip
            says its own state: a spinner while the bytes are still going up
            (a phone photo is seconds), core's own sentence when it refused,
            and a name he recognises when it landed. */}
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3" data-testid="attachment-chips">
            {pending.map(file => (
              <span
                key={file.key}
                data-testid={`attachment-${file.status}`}
                title={file.error ?? file.name}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-micro',
                  file.status === 'failed'
                    ? 'bg-danger-dim text-danger'
                    : 'bg-surface-card text-content-secondary',
                )}
              >
                <Paperclip size={11} className="shrink-0" />
                <span className="max-w-[14rem] truncate">{file.name}</span>
                {file.status === 'uploading' && (
                  <span className="text-content-tertiary">sending…</span>
                )}
                {file.status === 'failed' && (
                  <span className="max-w-[18rem] truncate">— {file.error}</span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setPending(prev => prev.filter(p => p.key !== file.key))}
                  className="ml-0.5 text-content-tertiary hover:text-content-primary"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* The queue hint gets its own line only while it applies; it used to
            share a permanent row with the send button, which put the button
            UNDER the text and made a one-line composer ~120px tall on a
            phone. The button now sits inline at the end of the text, the way
            every phone messaging app does it. */}
        {queueing && (
          <div className="px-4 pt-3 -mb-1">
            <span data-testid="will-queue" className="text-caption text-content-tertiary">
              Nova is working — this will go next
            </span>
          </div>
        )}
        <div className="flex items-end gap-2 pr-2 pb-2">
        {/* The paperclip: the way in that can be FOUND. Drop and paste are
            faster once you know they work, and neither advertises itself. */}
        {conversationId && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={e => {
                takeAll(e.target.files)
                // Cleared so picking the same file twice in a row still
                // fires a change event.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              aria-label="Attach a file"
              title="Attach a file — you can also paste a screenshot or drop one here"
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
              className="shrink-0 self-end mb-1.5 ml-2 p-2 rounded-lg text-content-tertiary hover:text-content-primary hover:bg-surface-card transition-colors disabled:opacity-50"
            >
              <Paperclip size={18} />
            </button>
          </>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => changeInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          /* The hint is desktop-only: at 393px the full string wraps inside a
             rows={1} textarea and is clipped mid-word, so a phone reads
             "…(type / for commands, @ for" and stops. Seen on the owner's
             iPhone, 2026-09-15. The affordances still work on mobile; a
             truncated sentence advertises them worse than silence. */
          placeholder={
            isMobile ? 'Message Nova…' : 'Message Nova…  (type / for commands, @ for an agent)'
          }
          aria-label="Message Nova"
          rows={1}
          className="flex-1 min-w-0 bg-transparent resize-none text-content-primary placeholder:text-content-tertiary outline-none px-4 py-3"
          style={{ minHeight: '44px', maxHeight: '240px', fontSize: '16px' }}
        />
          <button
            type="submit"
            disabled={(!input.trim() && ready.length === 0) || disabled || uploading}
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
