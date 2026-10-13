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

/** The model part of a `provider:model` id, read as a name: the provider is
 * cut at the FIRST colon (a local tag after it stays: `hub:qwen3:8b` reads
 * `qwen3:8b`), then a vendor path at the last slash
 * (`openrouter:google/gemini-3.8-flash` reads `gemini-3.8-flash`). An id with
 * neither comes back unchanged. Not title-cased: the slug IS the model's name.
 * The full id is the caller's to keep (a title), never thrown away. */
export function modelName(id: string): string {
  const model = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
}
