// ui-blocks/choices.tsx — radio questions whose button sends one ordinary user
// message (S54a T7 + T8).
//
// LOCKED: a submit composes text and hands it to the chat's own send path
// (ctx.onSend), exactly as if he had typed it. The block names no tool, route
// or URL, and nothing here can reach one: the only output is a string.
import { useContext, useId, useState } from 'react'
import { z } from 'zod'
import clsx from 'clsx'
import { Button } from '../ui/Button'
import { LIMITS } from './validate'
import { UiBlocksContext } from './context'
import type { BlockDef } from './types'

/** question id -> chosen option value. */
export type Selections = Record<string, string>

// A form longer than this is an interview, not a choice; ids are plain words
// so a {placeholder} in the message is unambiguous.
const MAX_QUESTIONS = 6
const MAX_OPTIONS = 8
const ID = /^[a-z][a-z0-9_-]*$/
const PLACEHOLDER = /\{([^{}]*)\}/g

const option = z.strictObject({
  value: z.string().min(1).max(LIMITS.strings.short),
  label: z.string().min(1).max(LIMITS.strings.short),
})

const question = z
  .strictObject({
    id: z.string().regex(ID).max(32),
    label: z.string().min(1).max(LIMITS.strings.short),
    options: z.array(option).min(2).max(MAX_OPTIONS),
    default: z.string().min(1).max(LIMITS.strings.short).optional(),
  })
  .refine((q) => new Set(q.options.map((o) => o.value)).size === q.options.length, {
    message: 'option values must be unique within a question',
    path: ['options'],
  })
  .refine((q) => q.default === undefined || q.options.some((o) => o.value === q.default), {
    message: '"default" must be one of its option values',
    path: ['default'],
  })

const schema = z
  .strictObject({
    type: z.literal('choices'),
    questions: z.array(question).min(1).max(MAX_QUESTIONS),
    submit: z.strictObject({
      label: z.string().min(1).max(LIMITS.strings.short),
      message: z.string().min(1).max(LIMITS.strings.long),
    }),
  })
  .superRefine((b, ctx) => {
    // A "/"-led message would run as a slash command (/clear empties the
    // chat) from a button whose label does not say so (T7b).
    if (isCommand(b.submit.message)) {
      ctx.addIssue({ code: 'custom', message: 'submit.message must not start with "/"', path: ['submit', 'message'] })
    }
    const ids = b.questions.map((q) => q.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'question ids must be unique', path: ['questions'] })
    }
    for (const name of placeholders(b.submit.message)) {
      if (!ids.includes(name)) {
        ctx.addIssue({ code: 'custom', message: `{${name}} in submit.message names no question`, path: ['submit', 'message'] })
        return
      }
    }
  })

type Props = z.infer<typeof schema>
type Question = Props['questions'][number]

/** Read as a slash command by the chat input (lib/commands.ts ignores leading space). */
function isCommand(text: string): boolean {
  return text.trimStart().startsWith('/')
}

function placeholders(message: string): string[] {
  return Array.from(message.matchAll(PLACEHOLDER), (m) => m[1])
}

/** The option value this question resolves to: a valid selection, else its default. */
function chosen(q: Question, selections: Selections): string | undefined {
  const own = Object.prototype.hasOwnProperty.call(selections, q.id) ? selections[q.id] : undefined
  if (own !== undefined && q.options.some((o) => o.value === own)) return own
  return q.default
}

/** The submit message with every {id} filled by the chosen option LABEL; null when one is unanswered or the text would be a slash command. */
export function composeMessage(block: unknown, selections: Selections): string | null {
  const parsed = schema.safeParse(block)
  if (!parsed.success) return null
  const { questions, submit } = parsed.data
  const labels = new Map<string, string>()
  for (const q of questions) {
    const v = chosen(q, selections)
    const label = q.options.find((o) => o.value === v)?.label
    if (label !== undefined) labels.set(q.id, label)
  }
  for (const name of placeholders(submit.message)) if (!labels.has(name)) return null
  const text = submit.message.replace(PLACEHOLDER, (_, name: string) => labels.get(name) as string)
  // A label can still lead with "/" ("{cmd}" filled by "/clear"): that text
  // never reaches onSend.
  return isCommand(text) ? null : text
}

function Render(props: Props) {
  const ctx = useContext(UiBlocksContext)
  const uid = useId()
  const [selections, setSelections] = useState<Selections>({})
  const [sent, setSent] = useState(false)

  const frozen = sent || ctx?.answered === true
  const composed = composeMessage(props, selections)
  const canSend = ctx !== null && !ctx.streaming && !frozen && composed !== null

  const submit = () => {
    if (!canSend || composed === null) return
    setSent(true)
    ctx.onSend(composed)
  }

  return (
    <div data-block="choices" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-card p-3">
      {props.questions.map((q, qi) => {
        const labelId = `${uid}-q${qi}`
        const value = chosen(q, selections)
        return (
          <div key={q.id} className="flex flex-col gap-1.5">
            <span id={labelId} className="text-body font-semibold text-content-primary">
              {q.label}
            </span>
            <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-1.5">
              {q.options.map((o) => (
                <label
                  key={o.value}
                  className={clsx(
                    'inline-flex items-center gap-2.5 select-none',
                    frozen ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  )}
                >
                  <input
                    type="radio"
                    name={labelId}
                    value={o.value}
                    checked={value === o.value}
                    disabled={frozen}
                    onChange={() => setSelections((s) => ({ ...s, [q.id]: o.value }))}
                    className="h-4 w-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-500/40"
                  />
                  <span className="min-w-0 break-words text-compact text-content-primary">{o.label}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
      <div>
        <Button type="button" size="sm" disabled={!canSend} onClick={submit}>
          {props.submit.label}
        </Button>
      </div>
    </div>
  )
}

export const block: BlockDef = {
  type: 'choices',
  schema,
  describe:
    'Radio questions he answers, then one button sends submit.message as his own chat message with each {id} replaced by the chosen option label; questions 1-6 {id, label, options [{value, label}] 2-8, default?}; submit.message never starts with "/".',
  example: {
    type: 'choices',
    questions: [
      {
        id: 'goal',
        label: 'What should it produce?',
        options: [
          { value: 'personal', label: 'Tools for myself' },
          { value: 'both', label: 'Both' },
        ],
        default: 'both',
      },
      {
        id: 'model',
        label: 'Where do models run?',
        options: [
          { value: 'local', label: 'On my machines' },
          { value: 'cloud', label: 'Cloud APIs' },
        ],
      },
    ],
    submit: { label: 'Design it', message: 'Design it for me. Goal: {goal}. Models: {model}.' },
  },
  Render,
}
