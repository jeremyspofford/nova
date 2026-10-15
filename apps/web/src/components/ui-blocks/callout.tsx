// ui-blocks/callout.tsx — a note, warning or tip set apart from the prose (S54a T6).
//
// The kind picks a whole theme class set and an icon; nothing she writes can
// reach a colour.
import { z } from 'zod'
import clsx from 'clsx'
import { LIMITS } from './validate'
import { BlockIcon } from './tokens'
import { Banner } from '../ui/Banner'
import type { BlockDef } from './types'

const KINDS = ['note', 'warning', 'tip'] as const

// The box is the app's one tinted, bordered message box (ui/Banner), so a
// callout matches every other note in the app; the kind picks its tone.
const KIND: Record<(typeof KINDS)[number], { tone: 'info' | 'warning' | 'success'; ink: string; icon: string }> = {
  note: { tone: 'info', ink: 'text-info', icon: 'info' },
  warning: { tone: 'warning', ink: 'text-warning', icon: 'alert-triangle' },
  tip: { tone: 'success', ink: 'text-success', icon: 'lightbulb' },
}

const schema = z.strictObject({
  type: z.literal('callout'),
  kind: z.enum(KINDS),
  title: z.string().min(1).max(LIMITS.strings.short).optional(),
  text: z.string().min(1).max(LIMITS.strings.long),
})

type Props = z.infer<typeof schema>

function Render({ kind, title, text }: Props) {
  const k = KIND[kind]
  return (
    <Banner
      tone={k.tone}
      role="note"
      data-block="callout"
      data-kind={kind}
      className="flex min-w-0 items-start gap-2.5"
    >
      <BlockIcon name={k.icon} className={clsx('mt-0.5', k.ink)} />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title && <span className="text-body font-semibold text-content-primary">{title}</span>}
        <p className="m-0 text-compact text-content-primary">{text}</p>
      </div>
    </Banner>
  )
}

export const block: BlockDef = {
  type: 'callout',
  schema,
  describe: 'A boxed aside; kind note|warning|tip, optional title, one short text.',
  example: { type: 'callout', kind: 'tip', title: 'Start small', text: 'Automate one boring step end to end before adding agents.' },
  Render,
}
