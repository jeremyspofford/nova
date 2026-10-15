// ui-blocks/row.tsx — children side by side, wrapping on narrow screens (S54a T4).
//
// flex-wrap rather than a fixed column count: a chat bubble on a phone is
// narrow, and a row that cannot wrap would scroll sideways or clip.
import { z } from 'zod'
import clsx from 'clsx'
import { Child, children, type AnyNode } from './tree'
import { GAP } from './stack'
import type { BlockDef } from './types'

const schema = z.strictObject({
  type: z.literal('row'),
  children,
  gap: z.enum(['sm', 'md', 'lg']).optional(),
})

type Props = z.infer<typeof schema>

function Render({ children: kids, gap = 'md' }: Props) {
  return (
    <div data-block="row" className={clsx('flex min-w-0 flex-wrap items-center', GAP[gap])}>
      {(kids as AnyNode[]).map((node, i) => (
        <Child key={i} node={node} />
      ))}
    </div>
  )
}

export const block: BlockDef = {
  type: 'row',
  schema,
  describe: 'A horizontal group: children side by side, wrapping when narrow; gap sm|md|lg.',
  example: {
    type: 'row',
    children: [
      { type: 'icon', name: 'rocket', tone: 'accent' },
      { type: 'text', text: 'Ship small changes often.' },
      { type: 'badge', text: 'Tip', tone: 'accent' },
    ],
  },
  Render,
}
