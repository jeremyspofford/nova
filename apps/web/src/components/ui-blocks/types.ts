// ui-blocks/types.ts — the shape every registered block file exports (S54a).
import type { ComponentType } from 'react'
import type { ZodType } from 'zod'

/** One registered component: its schema, a prompt line, an example, and how it draws. */
export type BlockDef = {
  type: string
  schema: ZodType
  /** One line for her prompt: when to use it. */
  describe: string
  /** One valid instance, used by the tests and exported to her prompt. */
  example: { type: string } & Record<string, unknown>
  /** Props = the schema's output (the parsed node). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Render: ComponentType<any>
}
