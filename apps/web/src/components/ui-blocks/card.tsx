// ui-blocks/card.tsx — a bordered panel around its children, optionally toned (S54a T4).
//
// A tone picks a whole class pair from the theme (border + dim fill), so a
// toned card follows the owner's palette and dark mode; there is no prop a
// colour value could reach.
import { z } from 'zod'
import clsx from 'clsx'
import { Child, children, type AnyNode } from './tree'
import { tone, type TONES } from './tokens'
import type { BlockDef } from './types'

const TONE: Record<(typeof TONES)[number], string> = {
  accent: 'border-accent/40 bg-accent-dim',
  success: 'border-success/40 bg-success-dim',
  warning: 'border-warning/40 bg-warning-dim',
  danger: 'border-danger/40 bg-danger-dim',
  neutral: 'border-neutral-500/30 bg-surface-elevated',
}

const schema = z.strictObject({
  type: z.literal('card'),
  children,
  tone: tone.optional(),
})

type Props = z.infer<typeof schema>

function Render({ children: kids, tone: t }: Props) {
  return (
    <div
      data-block="card"
      className={clsx('flex min-w-0 flex-col gap-2 rounded-lg border p-3', t ? TONE[t] : 'border-border bg-surface-card')}
    >
      {(kids as AnyNode[]).map((node, i) => (
        <Child key={i} node={node} />
      ))}
    </div>
  )
}

export const block: BlockDef = {
  type: 'card',
  schema,
  describe: 'A bordered panel grouping its children; optional tone accent|success|warning|danger|neutral.',
  example: {
    type: 'card',
    tone: 'accent',
    children: [
      { type: 'title', text: 'Start here', size: 'sm' },
      { type: 'text', text: 'Automate the build before anything else.' },
    ],
  },
  Render,
}
