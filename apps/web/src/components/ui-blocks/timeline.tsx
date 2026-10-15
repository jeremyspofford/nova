// ui-blocks/timeline.tsx — rows of a big label beside a title and body (S54a T5).
//
// The week-by-week plan from the ChatGPT reply: a label column ("Week 1")
// set large on the left, the step's title and body beside it.
import { z } from 'zod'
import { LIMITS } from './validate'
import type { BlockDef } from './types'

const MAX_ITEMS = 8

const item = z.strictObject({
  label: z.string().min(1).max(LIMITS.strings.short),
  title: z.string().min(1).max(LIMITS.strings.short),
  body: z.string().min(1).max(LIMITS.strings.long).optional(),
})

const schema = z.strictObject({
  type: z.literal('timeline'),
  items: z.array(item).min(1).max(MAX_ITEMS),
})

type Props = z.infer<typeof schema>

function Render({ items }: Props) {
  return (
    <ol data-block="timeline" className="m-0 flex list-none flex-col divide-y divide-border p-0">
      {items.map((it, i) => (
        <li key={i} className="grid grid-cols-[minmax(4.5rem,auto)_1fr] gap-3 py-2.5">
          <span className="break-words text-h3 text-accent">{it.label}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="break-words text-body font-semibold text-content-primary">{it.title}</span>
            {it.body && <p className="m-0 text-compact text-content-secondary">{it.body}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

export const block: BlockDef = {
  type: 'timeline',
  schema,
  describe: 'A dated or phased plan of 1-8 rows; each item {label (e.g. "Week 1"), title, body?}.',
  example: {
    type: 'timeline',
    items: [
      { label: 'Week 1', title: 'Automate the build', body: 'One command builds and tests from a clean checkout.' },
      { label: 'Week 2', title: 'Add an agent', body: 'Let it open small pull requests you review.' },
    ],
  },
  Render,
}
