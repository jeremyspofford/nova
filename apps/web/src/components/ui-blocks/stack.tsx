// ui-blocks/stack.tsx — children laid out top to bottom (S54a T4).
import { z } from 'zod'
import clsx from 'clsx'
import { Child, children, type AnyNode } from './tree'
import type { BlockDef } from './types'

// Gap words, not pixel values: spacing stays on the app's scale.
export const GAP = { sm: 'gap-1', md: 'gap-2', lg: 'gap-4' } as const

const schema = z.strictObject({
  type: z.literal('stack'),
  children,
  gap: z.enum(['sm', 'md', 'lg']).optional(),
})

type Props = z.infer<typeof schema>

function Render({ children: kids, gap = 'md' }: Props) {
  return (
    <div data-block="stack" className={clsx('flex min-w-0 flex-col', GAP[gap])}>
      {(kids as AnyNode[]).map((node, i) => (
        <Child key={i} node={node} />
      ))}
    </div>
  )
}

export const block: BlockDef = {
  type: 'stack',
  schema,
  describe: 'A vertical group: children drawn top to bottom; gap sm|md|lg.',
  example: {
    type: 'stack',
    children: [
      { type: 'title', text: 'Three parts', size: 'sm' },
      { type: 'text', text: 'Source, build, and release.' },
    ],
  },
  Render,
}
