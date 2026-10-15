// ui-blocks/node.tsx — every primitive, the recursive node schema, and RenderNode (S54a T4).
//
// This is the one file that imports all primitives; it then installs the
// schema and renderer into tree.tsx so containers can hold any of them
// without importing this file back (see tree.tsx for why).
import { z, type ZodType } from 'zod'
import type { BlockDef } from './types'
import { installTree, type AnyNode } from './tree'
import { block as text } from './text'
import { block as title } from './title'
import { block as icon } from './icon'
import { block as divider } from './divider'
import { block as badge } from './badge'
import { block as stack } from './stack'
import { block as row } from './row'
import { block as card } from './card'

/** Every primitive (leaves + containers), in registry order. */
export const PRIMITIVES: BlockDef[] = [text, title, icon, divider, badge, stack, row, card]

const BY_TYPE: Record<string, BlockDef> = Object.fromEntries(PRIMITIVES.map((b) => [b.type, b]))

/** Any primitive node, recursively (containers' children use this). */
// Discriminated on `type` so a bad child reports against its own schema (or
// as an unknown type) instead of zod's "matched none of eight" union error.
export const nodeSchema: ZodType = z.discriminatedUnion(
  'type',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PRIMITIVES.map((b) => b.schema) as any,
)

/** Draws one primitive node by its `type`; unknown types draw nothing. */
export function RenderNode({ node }: { node: AnyNode }) {
  // Own-property lookup: a model-written type of "constructor" must not
  // resolve to Object.prototype's function and get rendered as a component.
  const def = Object.prototype.hasOwnProperty.call(BY_TYPE, node.type) ? BY_TYPE[node.type] : undefined
  if (!def) return null
  return <def.Render {...node} />
}

installTree({ schema: nodeSchema, Render: RenderNode })
