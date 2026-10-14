/**
 * Formatting a model's stated facts for a person. Shared by Settings →
 * Providers and the Models catalogue so a price or a context length reads
 * the same everywhere. Every helper returns null when the fact is ABSENT —
 * the caller prints "not stated", never a zero.
 */

export interface PricedLike {
  pricing?: { prompt?: number; completion?: number }
}

export interface ContextLike {
  context_length?: number
}

/** USD per MILLION tokens from a per-token price — what people actually
 * compare — or null when the provider stated nothing. */
export function formatPrice<T extends PricedLike>(model: T): string | null {
  const p = model.pricing
  if (!p || (p.prompt === undefined && p.completion === undefined)) return null
  const per = (v: number | undefined) =>
    v === undefined ? '–' : `$${(v * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return `${per(p.prompt)} / ${per(p.completion)} per 1M`
}

export function formatContext<T extends ContextLike>(model: T): string | null {
  if (!model.context_length) return null
  const k = model.context_length / 1000
  return k >= 1000
    ? `${(k / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M ctx`
    : `${Math.round(k)}K ctx`
}

/** Parameter count in billions, e.g. 8.19 → "8.2B". */
export function formatParams(paramsB: number): string {
  return paramsB >= 100 ? `${Math.round(paramsB)}B` : `${paramsB.toFixed(1).replace(/\.0$/, '')}B`
}

/** What modelName reads for an id that is empty or blank — a span or turn
 * that recorded no model says so, never an empty name. */
export const MODEL_NOT_STATED = 'model not stated'

/** A provider (or machine link) name as the gateway accepts one
 * (services/gateway/app/providers.py NAME_RE): lowercase letters, digits,
 * `_` and `-`, no dot, no slash. */
const PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** An ollama tag on a BARE local id: a size (`8b`, `27b`, `0.6b`,
 * `70b-instruct-q4_K_M`) or `latest`. A provider's model is never one. */
const LOCAL_TAG = /^(\d|latest$)/

/** The model part of a `provider:model` id, read as a name: the provider is
 * cut at the FIRST colon (a local tag after it stays: `hub:qwen3:8b` and
 * `dell:qwen3:8b` read `qwen3:8b`), then a vendor path at the last slash
 * (`openrouter:google/gemini-3.8-flash` reads `gemini-3.8-flash`).
 *
 * Bare ids are real (live turn_spans, 10-13: `qwen3:8b`, `qwen3.8:27b`) and
 * their one colon is the ollama TAG, not a provider: a head the gateway would
 * never accept as a provider name (`qwen3.8`), or a single tail that reads as
 * a tag (`8b`, `latest`), keeps the whole id. An id with neither colon nor
 * slash comes back unchanged; an empty one reads MODEL_NOT_STATED. Not
 * title-cased: the slug IS the model's name. The full id is the caller's to
 * keep (a title), never thrown away. */
export function modelName(id: string): string {
  if (!id.trim()) return MODEL_NOT_STATED
  const { model } = splitId(id)
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
}

/** The provider (or machine link) of a `provider:model` id — the part
 * modelName cuts off — or null for a bare id, read by the same rule:
 * `dell:qwen3:8b` is `dell`, `openrouter:google/gemini-3.8-flash` is
 * `openrouter`, bare `qwen3:8b` and `qwen3.8:27b` have none. */
export function modelProvider(id: string): string | null {
  return splitId(id).provider
}

/** Two model names that read the same apart: a name shared by more than one
 * id in `ids` reads "<name> (<provider>)", a bare id its name alone, and a
 * name unique in the list no provider. If that still leaves two labels the
 * same (two bare ids whose vendor paths differ), those read their full ids.
 * Returns a label per id, in a Map keyed by the id. */
export function distinctModelNames(ids: string[]): Map<string, string> {
  const count = (labels: string[]) => {
    const n = new Map<string, number>()
    for (const l of labels) n.set(l, (n.get(l) ?? 0) + 1)
    return n
  }
  const names = ids.map(modelName)
  const shared = count(names)
  const labels = ids.map((id, i) => {
    const provider = modelProvider(id)
    return (shared.get(names[i]) ?? 0) > 1 && provider ? `${names[i]} (${provider})` : names[i]
  })
  const still = count(labels)
  return new Map(ids.map((id, i) => [id, (still.get(labels[i]) ?? 0) > 1 ? id : labels[i]]))
}

function splitId(id: string): { provider: string | null; model: string } {
  const colon = id.indexOf(':')
  if (colon > 0) {
    const head = id.slice(0, colon)
    const tail = id.slice(colon + 1)
    const bare = !PROVIDER_NAME.test(head) || LOCAL_TAG.test(tail)
    if (!bare) return { provider: head, model: tail }
  }
  return { provider: null, model: id }
}
