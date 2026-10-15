// ui-blocks/export.ts — the registry as data for core (S54a T11).
//
// exportRegistry turns UI_BLOCKS into {limits, icons, blocks}, which
// export.test.ts writes to services/core/app/ui_blocks.json (UPDATE_UI_BLOCKS=1)
// and diffs on every run. Core builds her prompt's catalog and its persist
// check from that file, so registering a block reaches both with no other edit.
//
// Refinements (placeholder ids, unique values, LIMITS) do not survive
// z.toJSONSchema; the limits travel here as data and core re-checks them.
import { z } from 'zod'
import type { BlockDef } from './types'
import { UI_BLOCKS } from './index'
import { LIMITS } from './validate'
import { ICONS } from './tokens'

export type ExportedBlock = {
  type: string
  describe: string
  example: { type: string } & Record<string, unknown>
  /** z.toJSONSchema of the block's zod schema. */
  schema: Record<string, unknown>
}

export type ExportedRegistry = {
  limits: Record<string, unknown>
  icons: string[]
  blocks: ExportedBlock[]
}

export function exportRegistry(registry: Record<string, BlockDef> = UI_BLOCKS): ExportedRegistry {
  return {
    limits: JSON.parse(JSON.stringify(LIMITS)) as Record<string, unknown>,
    icons: Object.keys(ICONS).sort(),
    blocks: Object.values(registry).map((def) => ({
      type: def.type,
      describe: def.describe,
      example: def.example,
      schema: JSON.parse(JSON.stringify(z.toJSONSchema(def.schema, { unrepresentable: 'any' }))) as Record<
        string,
        unknown
      >,
    })),
  }
}
