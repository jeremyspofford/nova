// ui-blocks/steps.tsx — a numbered flow of stacked cards with arrows between (S54a T5).
//
// The shape the ChatGPT "software factory" reply drew as its five-step flow:
// each step a card with an icon, a bold title and a caption, an arrow icon
// leading into every step after the first. Items are plain data (no `type`),
// so a steps block is one node however many items it holds.
import { z } from 'zod'
import { LIMITS } from './validate'
import { BlockIcon, iconName } from './tokens'
import type { BlockDef } from './types'

// A flow longer than this is a list, not a diagram; the cap also keeps one
// block's height bounded in the bubble.
const MAX_ITEMS = 8

const item = z.strictObject({
  title: z.string().min(1).max(LIMITS.strings.short),
  caption: z.string().min(1).max(LIMITS.strings.long).optional(),
  icon: iconName.optional(),
})

const schema = z.strictObject({
  type: z.literal('steps'),
  items: z.array(item).min(1).max(MAX_ITEMS),
})

type Props = z.infer<typeof schema>

function Render({ items }: Props) {
  return (
    <ol data-block="steps" className="m-0 flex list-none flex-col p-0">
      {items.map((it, i) => (
        <li key={i} className="flex flex-col items-stretch">
          {i > 0 && (
            <span data-arrow className="flex justify-center py-1 text-content-tertiary">
              <BlockIcon name="arrow-down" />
            </span>
          )}
          <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface-card p-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-dim text-caption font-semibold text-accent">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-2 text-body font-semibold text-content-primary">
                {it.icon && <BlockIcon name={it.icon} className="text-accent" />}
                <span className="min-w-0 break-words">{it.title}</span>
              </div>
              {it.caption && <p className="m-0 text-compact text-content-secondary">{it.caption}</p>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

export const block: BlockDef = {
  type: 'steps',
  schema,
  describe: 'A numbered flow of 1-8 steps drawn as cards with arrows between; each item {title, caption?, icon?}.',
  example: {
    type: 'steps',
    items: [
      { icon: 'lightbulb', title: 'Idea or requirement', caption: 'A feature request or bug report' },
      { icon: 'bot', title: 'AI development agents', caption: 'Plan, write, review, fix' },
      { icon: 'rocket', title: 'Release', caption: 'Checked, merged and deployed' },
    ],
  },
  Render,
}
