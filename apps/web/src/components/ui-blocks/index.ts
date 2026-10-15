// ui-blocks/index.ts — the registry: every block type she may draw (S54a T9).
//
// One list, keyed by each block's own `type`. Adding a component is adding
// its file to this list; validateBlock, UiBlock and the exported catalog
// (her prompt) all read it, so nothing else names the vocabulary.
import type { BlockDef } from './types'
import { PRIMITIVES } from './node'
import { block as steps } from './steps'
import { block as layers } from './layers'
import { block as timeline } from './timeline'
import { block as compare } from './compare'
import { block as callout } from './callout'
import { block as choices } from './choices'

const ALL: BlockDef[] = [...PRIMITIVES, steps, layers, timeline, compare, callout, choices]

export const UI_BLOCKS: Record<string, BlockDef> = Object.fromEntries(ALL.map((b) => [b.type, b]))
