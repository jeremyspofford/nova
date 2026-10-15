// ui-blocks/compare.tsx — two to four option columns with pros and cons (S54a T6).
import { z } from 'zod'
import { LIMITS } from './validate'
import { BlockIcon } from './tokens'
import type { BlockDef } from './types'

const point = z.string().min(1).max(LIMITS.strings.short)

const option = z.strictObject({
  title: z.string().min(1).max(LIMITS.strings.short),
  summary: z.string().min(1).max(LIMITS.strings.long).optional(),
  pros: z.array(point).max(6).optional(),
  cons: z.array(point).max(6).optional(),
})

const schema = z.strictObject({
  type: z.literal('compare'),
  options: z.array(option).min(2).max(4),
})

type Props = z.infer<typeof schema>

function Points({ list, icon, tone }: { list?: string[]; icon: string; tone: string }) {
  if (!list?.length) return null
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {list.map((p, i) => (
        <li key={i} className="flex items-start gap-1.5 text-compact text-content-secondary">
          <BlockIcon name={icon} className={`mt-0.5 ${tone}`} />
          <span className="min-w-0 break-words">{p}</span>
        </li>
      ))}
    </ul>
  )
}

function Render({ options }: Props) {
  return (
    <div data-block="compare" className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
      {options.map((o, i) => (
        <div key={i} data-option className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface-card p-3">
          <span className="break-words text-body font-semibold text-content-primary">{o.title}</span>
          {o.summary && <p className="m-0 text-compact text-content-secondary">{o.summary}</p>}
          <Points list={o.pros} icon="check" tone="text-success" />
          <Points list={o.cons} icon="x" tone="text-danger" />
        </div>
      ))}
    </div>
  )
}

export const block: BlockDef = {
  type: 'compare',
  schema,
  describe: 'Side-by-side columns for 2-4 options; each option {title, summary?, pros? (<=6), cons? (<=6)}.',
  example: {
    type: 'compare',
    options: [
      { title: 'Local model', summary: 'Runs on your own GPU.', pros: ['Private', 'No per-token cost'], cons: ['Slower on big tasks'] },
      { title: 'Cloud model', summary: 'Runs on a provider.', pros: ['Strongest reasoning'], cons: ['Costs per token', 'Data leaves the machine'] },
    ],
  },
  Render,
}
