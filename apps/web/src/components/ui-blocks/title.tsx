// ui-blocks/title.tsx — a heading line inside a block (S54a T3).
//
// Drawn as role="heading" on a div rather than an <h2>/<h3>: a block sits
// inside a reply that already has its own markdown headings, and the level
// here is visual, so it maps to the app's h2..h4 type scale only.
import { z } from 'zod'
import { LIMITS } from './validate'
import type { BlockDef } from './types'

const SIZE = { sm: 'text-h4', md: 'text-h3', lg: 'text-h2' } as const
const LEVEL = { sm: 4, md: 3, lg: 2 } as const

const schema = z.strictObject({
  type: z.literal('title'),
  text: z.string().min(1).max(LIMITS.strings.short),
  size: z.enum(['sm', 'md', 'lg']).optional(),
})

type Props = z.infer<typeof schema>

function Render({ text, size = 'md' }: Props) {
  return (
    <div data-block="title" role="heading" aria-level={LEVEL[size]} className={`${SIZE[size]} text-content-primary`}>
      {text}
    </div>
  )
}

export const block: BlockDef = {
  type: 'title',
  schema,
  describe: 'A one-line heading inside a block; size sm|md|lg.',
  example: { type: 'title', text: 'How the pieces fit', size: 'md' },
  Render,
}
