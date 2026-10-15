// ui-blocks/validate.ts — parse and check one ```nova-ui fence (S54a T1).
//
// A fence is model-written text, so every step here returns an error string
// instead of throwing: the caller (UiBlock) shows the fence as code plus that
// one line, and a bad block can never blank the bubble or crash the render.
import type { ZodType } from 'zod'

/** Hard limits every block is held to before its own schema runs. */
export const LIMITS = {
  maxDepth: 4,
  maxNodes: 40,
  /** Caps the per-component schemas apply to their strings. */
  strings: { short: 80, long: 400 },
} as const

/** What validateBlock needs from a registry entry. */
export type RegistryEntry = { schema: ZodType }
export type Registry = Record<string, RegistryEntry>

export type ValidateResult =
  | { ok: true; block: { type: string } & Record<string, unknown> }
  | { ok: false; error: string }

type Obj = Record<string, unknown>

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A node is any plain object that names its component in a string `type`. */
const isNode = (v: unknown): v is Obj => isObject(v) && typeof v.type === 'string'

/** The values one level down: array items or object fields. */
const childrenOf = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : isObject(v) ? Object.values(v) : []

/** Objects carrying a string `type`, counted anywhere in the value. */
export function countNodes(value: unknown): number {
  const own = isNode(value) ? 1 : 0
  return childrenOf(value).reduce<number>((n, c) => n + countNodes(c), own)
}

/** Nesting depth of typed nodes; a lone node is depth 1. */
export function depthOf(value: unknown): number {
  // Untyped objects and arrays are transparent: an `items: [{title}]` list
  // inside a composite is that composite's data, not another level.
  const below = childrenOf(value).reduce<number>((d, c) => Math.max(d, depthOf(c)), 0)
  return below + (isNode(value) ? 1 : 0)
}

export function validateBlock(source: string, registry: Registry): ValidateResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${oneLine(e instanceof Error ? e.message : String(e))}` }
  }
  if (!isObject(parsed)) return { ok: false, error: 'a block must be one JSON object' }
  if (typeof parsed.type !== 'string' || parsed.type === '') {
    return { ok: false, error: 'missing "type"' }
  }
  // Own-property lookup: a `type` of "constructor" or "__proto__" must read
  // as unknown, not resolve to something on Object.prototype.
  const entry = Object.prototype.hasOwnProperty.call(registry, parsed.type) ? registry[parsed.type] : undefined
  if (!entry) return { ok: false, error: `unknown type "${oneLine(parsed.type)}"` }

  // Limits run before the schema so a permissive container schema (children
  // of any shape) cannot hide a block that is too deep or too wide.
  const depth = depthOf(parsed)
  if (depth > LIMITS.maxDepth) {
    return { ok: false, error: `nesting depth ${depth} is over the limit of ${LIMITS.maxDepth}` }
  }
  const nodes = countNodes(parsed)
  if (nodes > LIMITS.maxNodes) {
    return { ok: false, error: `${nodes} nodes is over the limit of ${LIMITS.maxNodes}` }
  }

  const result = entry.schema.safeParse(parsed)
  if (!result.success) {
    // One line, the first issue only: the caption under the code fallback is
    // a pointer to what broke, not a full report.
    const issue = result.error.issues[0]
    const path = issue.path.length ? issue.path.map(String).join('.') : '(block)'
    return { ok: false, error: `${path}: ${oneLine(issue.message)}` }
  }
  return { ok: true, block: result.data as { type: string } & Obj }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
