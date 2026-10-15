// ui-blocks/icon.tsx — one lucide icon in a theme tone (S54a T3).
//
// The name is checked for shape by `iconName` (kebab-case, so never an
// emoji) and drawn through BlockIcon's curated map; a well-formed name the
// map lacks draws nothing rather than failing the whole block.
import { z } from 'zod'
import { BlockIcon, iconName, tone, type TONES } from './tokens'
import type { BlockDef } from './types'

// Theme text colours per tone; neutral is the secondary ink, not a grey hex.
const TONE: Record<(typeof TONES)[number], string> = {
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-content-secondary',
}

const schema = z.strictObject({
  type: z.literal('icon'),
  name: iconName,
  tone: tone.optional(),
})

type Props = z.infer<typeof schema>

function Render({ name, tone: t = 'neutral' }: Props) {
  return (
    <span data-block="icon" className={`inline-flex ${TONE[t]}`}>
      <BlockIcon name={name} />
    </span>
  )
}

export const block: BlockDef = {
  type: 'icon',
  schema,
  describe: 'One icon by lucide name (from the icon list only, never an emoji); tone accent|success|warning|danger|neutral.',
  example: { type: 'icon', name: 'lightbulb', tone: 'accent' },
  Render,
}
