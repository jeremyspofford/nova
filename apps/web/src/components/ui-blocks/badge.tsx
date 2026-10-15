// ui-blocks/badge.tsx — a small labelled pill in a theme tone (S54a T3).
//
// The status tones use the app's *-dim fills so a badge reads the same as
// the pills elsewhere in the UI and follows light/dark mode with the theme.
import { z } from 'zod'
import { LIMITS } from './validate'
import { tone, type TONES } from './tokens'
import type { BlockDef } from './types'

const TONE: Record<(typeof TONES)[number], string> = {
  accent: 'bg-accent-dim text-accent',
  success: 'bg-success-dim text-success',
  warning: 'bg-warning-dim text-warning',
  danger: 'bg-danger-dim text-danger',
  neutral: 'bg-surface-elevated text-content-secondary',
}

const schema = z.strictObject({
  type: z.literal('badge'),
  text: z.string().min(1).max(LIMITS.strings.short),
  tone: tone.optional(),
})

type Props = z.infer<typeof schema>

function Render({ text, tone: t = 'neutral' }: Props) {
  return (
    <span data-block="badge" className={`inline-flex items-center rounded-full px-2 py-0.5 text-caption font-medium ${TONE[t]}`}>
      {text}
    </span>
  )
}

export const block: BlockDef = {
  type: 'badge',
  schema,
  describe: 'A short label pill (status, tag, version); tone accent|success|warning|danger|neutral.',
  example: { type: 'badge', text: 'Recommended', tone: 'success' },
  Render,
}
