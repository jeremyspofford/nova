// ui-blocks/text.tsx — a paragraph of plain text (S54a T3).
//
// The text is rendered as a React string child, so markup she writes (<b>,
// <img onerror>) shows as literal characters; there is no path from a block
// string to HTML. Size, tone and weight are closed words mapped to theme
// classes below, never colours or CSS she supplies.
import { z } from 'zod'
import clsx from 'clsx'
import { LIMITS } from './validate'
import type { BlockDef } from './types'

const SIZE = { sm: 'text-compact', md: 'text-body' } as const
const TONE = { primary: 'text-content-primary', secondary: 'text-content-secondary' } as const
const WEIGHT = { normal: 'font-normal', medium: 'font-medium', semibold: 'font-semibold' } as const

// Strict so an extra `style` / `className` / `html` fails validation instead
// of being silently dropped: a block that tried to style itself is a block
// the model got wrong, and the caption should say so.
const schema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).max(LIMITS.strings.long),
  size: z.enum(['sm', 'md']).optional(),
  tone: z.enum(['primary', 'secondary']).optional(),
  weight: z.enum(['normal', 'medium', 'semibold']).optional(),
})

type Props = z.infer<typeof schema>

function Render({ text, size = 'md', tone = 'primary', weight = 'normal' }: Props) {
  return (
    <p data-block="text" className={clsx('m-0', SIZE[size], TONE[tone], WEIGHT[weight])}>
      {text}
    </p>
  )
}

export const block: BlockDef = {
  type: 'text',
  schema,
  describe: 'A short paragraph of plain text (no markdown inside); size sm|md, tone primary|secondary, weight normal|medium|semibold.',
  example: { type: 'text', text: 'Each stage hands a checked artifact to the next.', tone: 'secondary' },
  Render,
}
