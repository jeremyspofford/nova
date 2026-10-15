// ui-blocks/layers.tsx — a divided list of layers: icon, title, secondary line, body (S54a T5).
//
// The architecture list from the ChatGPT reply: one row per layer, rows
// separated by theme dividers. Items are plain data, not nested nodes.
import { z } from 'zod'
import { LIMITS } from './validate'
import { BlockIcon, iconName } from './tokens'
import type { BlockDef } from './types'

const MAX_ITEMS = 8

const item = z.strictObject({
  title: z.string().min(1).max(LIMITS.strings.short),
  secondary: z.string().min(1).max(LIMITS.strings.short).optional(),
  body: z.string().min(1).max(LIMITS.strings.long).optional(),
  icon: iconName.optional(),
})

const schema = z.strictObject({
  type: z.literal('layers'),
  items: z.array(item).min(1).max(MAX_ITEMS),
})

type Props = z.infer<typeof schema>

function Render({ items }: Props) {
  return (
    <ul data-block="layers" className="m-0 list-none divide-y divide-border rounded-lg border border-border bg-surface-card p-0">
      {items.map((it, i) => (
        <li key={i} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
          {it.icon && (
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-dim text-accent">
              <BlockIcon name={it.icon} />
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="break-words text-body font-semibold text-content-primary">{it.title}</span>
            {it.secondary && <span className="text-caption text-content-tertiary">{it.secondary}</span>}
            {it.body && <p className="m-0 text-compact text-content-secondary">{it.body}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

export const block: BlockDef = {
  type: 'layers',
  schema,
  describe: 'A divided list of 1-8 layers or parts; each item {title, secondary?, body?, icon?}.',
  example: {
    type: 'layers',
    items: [
      { icon: 'git-branch', title: 'Source', secondary: 'Layer 1', body: 'One repo, small changes, every change reviewed.' },
      { icon: 'workflow', title: 'Pipeline', secondary: 'Layer 2', body: 'Build, test and scan on every push.' },
      { icon: 'server', title: 'Runtime', secondary: 'Layer 3', body: 'Deploys you can roll back in one step.' },
    ],
  },
  Render,
}
