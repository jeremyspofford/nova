// ui-blocks/divider.tsx — a horizontal rule between parts of a block (S54a T3).
//
// It takes no props at all: a strict empty schema means anything beyond
// `type` (a colour, a thickness) is an error, not a silent no-op.
import { z } from 'zod'
import type { BlockDef } from './types'

const schema = z.strictObject({ type: z.literal('divider') })

function Render() {
  return <hr data-block="divider" className="my-1 border-0 border-t border-border" />
}

export const block: BlockDef = {
  type: 'divider',
  schema,
  describe: 'A thin horizontal line separating parts of a block; no other fields.',
  example: { type: 'divider' },
  Render,
}
