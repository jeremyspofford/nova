// ui-blocks/tree.tsx — the seam that lets containers hold any primitive (S54a T4).
//
// Containers need the full node schema and renderer for their children, and
// node.tsx needs every container to build them: importing each other would
// be an ES-module cycle, and whichever file loaded first would read the
// other's `block` before it exists. So containers depend only on this file,
// and node.tsx installs the real schema and renderer here once every
// primitive has loaded. Nothing here imports a block.
import { z, type ZodType } from 'zod'
import type { ComponentType } from 'react'

export type AnyNode = { type: string } & Record<string, unknown>

type Tree = { schema: ZodType; Render: ComponentType<{ node: AnyNode }> }

let tree: Tree | null = null

/** Called once by node.tsx after every primitive is defined. */
export function installTree(t: Tree) {
  tree = t
}

// Resolved at parse time, not import time. If node.tsx never loaded, every
// child fails with a stated reason instead of throwing out of safeParse:
// validateBlock promises an error string, never an exception.
const notInstalled = z.never({ error: 'block registry not loaded' })

/** One child node of any primitive type (recursive). */
export const childNode: ZodType = z.lazy(() => tree?.schema ?? notInstalled)

/** A container's children: at least one; the 40-node limit caps the rest. */
export const children = z.array(childNode).min(1)

/** Draws one child through the installed renderer. */
export function Child({ node }: { node: AnyNode }) {
  if (!tree) return null
  const R = tree.Render
  return <R node={node} />
}
