import type { CatalogBasis, CatalogFact, CatalogRow } from '../../lib/api'
import { LOCAL_PROVIDER } from '../settings/modelsFormat'

/**
 * The catalogue's pure logic: facets, sorting, "is this the current model",
 * and how a fact's basis is shown. The rules that matter:
 *
 *   - a row that lacks a fact is EXCLUDED when a facet on that fact is set,
 *     and COUNTED — the page says "12 rows have no stated size and are
 *     hidden by the size filter". Nothing is hidden silently.
 *   - an inferred tag never satisfies a filter unless the owner ticked
 *     "include inferred"; it never counts as a declared one.
 *   - sorting puts rows without the sort fact LAST, in both directions.
 */

export const CAPABILITY_KEYS = ['tools', 'vision', 'audio', 'thinking', 'embedding'] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export const SUITABILITY_KEYS = [
  'chat',
  'coding',
  'agentic',
  'reasoning',
  'writing',
  'vision',
  'long_context',
  'multilingual',
  'summarization',
] as const

export type CatalogTab = 'installed' | 'available' | 'cloud' | 'all'

export interface Facets {
  tab: CatalogTab
  text: string
  source: string | null
  capability: CapabilityKey | null
  suitability: string | null
  includeInferred: boolean
  maxSizeGb: number | null
  maxParamsB: number | null
  minContextK: number | null
  maxPricePerM: number | null
}

export const EMPTY_FACETS: Facets = {
  tab: 'all',
  text: '',
  source: null,
  capability: null,
  suitability: null,
  includeInferred: false,
  maxSizeGb: null,
  maxParamsB: null,
  minContextK: null,
  maxPricePerM: null,
}

export type SortKey =
  | 'name'
  | 'size_bytes'
  | 'params_b'
  | 'context_length'
  | 'price_prompt'
  | 'price_completion'
  | 'downloads'
  | 'coding'

export interface HiddenCounts {
  noSize: number
  noParams: number
  noContext: number
  noPrice: number
}

/** A numeric fact's value — STATED only, unless inferred numbers were
 * asked for. An estimate (a Hub row's ≈ size) is not a fact a filter may
 * read by default; it counts as absent and is reported as such. */
function num(row: CatalogRow, key: string, includeInferred = false): number | null {
  const fact = row.facts[key]
  if (!fact || typeof fact.value !== 'number') return null
  if (fact.basis === 'inferred' && !includeInferred) return null
  return fact.value
}

/** Every suitability entry for `name`, regardless of basis (the row keys
 * them `name` or `name:basis` when two bases coexist). */
export function suitabilityEntries(row: CatalogRow, name: string): CatalogFact<number | boolean>[] {
  return Object.entries(row.suitability)
    .filter(([key]) => key === name || key.startsWith(`${name}:`))
    .map(([, fact]) => fact)
}

function inTab(row: CatalogRow, tab: CatalogTab): boolean {
  switch (tab) {
    case 'installed':
      return row.kind === 'local' && row.installed === true
    case 'available':
      // A hub repo the host already holds is listed by its INSTALLED row
      // (hf.co/org/repo:Q4_K_M under Installed), not offered again here.
      return row.installed !== true && (row.kind === 'local' || row.kind === 'hub')
    case 'cloud':
      return row.kind === 'cloud'
    case 'all':
      return true
  }
}

function usable(fact: CatalogFact | undefined, includeInferred: boolean): boolean {
  if (!fact) return false
  if (fact.basis === 'inferred' && !includeInferred) return false
  return fact.value !== false && fact.value !== null && fact.value !== undefined
}

export function applyFacets(rows: CatalogRow[], facets: Facets): { rows: CatalogRow[]; hidden: HiddenCounts } {
  const hidden: HiddenCounts = { noSize: 0, noParams: 0, noContext: 0, noPrice: 0 }
  const q = facets.text.trim().toLowerCase()
  const out = rows.filter(row => {
    if (!inTab(row, facets.tab)) return false
    if (facets.source && !row.sources.some(s => s.key === facets.source) && row.provider !== facets.source) {
      return false
    }
    if (q) {
      const family = row.facts.family?.value
      const hay = [row.id, row.label, typeof family === 'string' ? family : ''].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (facets.capability && !usable(row.capabilities[facets.capability], facets.includeInferred)) {
      return false
    }
    if (facets.suitability) {
      const entries = suitabilityEntries(row, facets.suitability)
      if (!entries.some(e => usable(e, facets.includeInferred))) return false
    }
    if (facets.maxSizeGb !== null) {
      const bytes = num(row, 'size_bytes', facets.includeInferred)
      if (bytes === null) {
        hidden.noSize += 1
        return false
      }
      if (bytes > facets.maxSizeGb * 1024 ** 3) return false
    }
    if (facets.maxParamsB !== null) {
      const params = num(row, 'params_b', facets.includeInferred)
      if (params === null) {
        hidden.noParams += 1
        return false
      }
      if (params > facets.maxParamsB) return false
    }
    if (facets.minContextK !== null) {
      const ctx = num(row, 'context_length', facets.includeInferred)
      if (ctx === null) {
        hidden.noContext += 1
        return false
      }
      if (ctx < facets.minContextK * 1000) return false
    }
    if (facets.maxPricePerM !== null) {
      const price = num(row, 'price_prompt', facets.includeInferred)
      if (price === null) {
        hidden.noPrice += 1
        return false
      }
      if (price * 1_000_000 > facets.maxPricePerM) return false
    }
    return true
  })
  return { rows: out, hidden }
}

function sortValue(row: CatalogRow, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return row.label.toLowerCase()
    case 'coding': {
      const declared = suitabilityEntries(row, 'coding').find(
        e => e.basis !== 'inferred' && typeof e.value === 'number',
      )
      return declared ? (declared.value as number) : null
    }
    default:
      return num(row, key)
  }
}

/** Rows without the sort fact go LAST in both directions — an absent
 * number is not a small one. */
export function sortRows(rows: CatalogRow[], key: SortKey, dir: 'asc' | 'desc'): CatalogRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (va === null && vb === null) return a.label.localeCompare(b.label)
    if (va === null) return 1
    if (vb === null) return -1
    if (typeof va === 'string' && typeof vb === 'string') return sign * va.localeCompare(vb)
    return sign * ((va as number) - (vb as number))
  })
}

/** A pre-registry bare `chat.model` (no provider prefix) still means the
 * bundled ollama, so the local row for it reads as current. */
export function isCurrent(row: CatalogRow, chatModel: string): boolean {
  if (!chatModel) return false
  if (row.id === chatModel) return true
  return row.provider === LOCAL_PROVIDER && chatModel === row.model
}

export const BASIS_MARK: Record<CatalogBasis, string> = {
  declared: '',
  inferred: '?',
  vetted: '✓',
  measured: '●',
}

/** How a tag is labelled: `coding?` (inferred), `coding 77` (a declared
 * number), `coding ✓ 2026-08-29` (vetted), `agent_quality 86% ●` (measured). */
export function tagLabel(name: string, fact: CatalogFact<number | boolean>): string {
  const value = fact.value
  if (fact.basis === 'inferred') return `${name}?`
  if (fact.basis === 'measured' && typeof value === 'number') {
    return `${name} ${Math.round(value * 100)}% ●`
  }
  if (fact.basis === 'vetted') return fact.at ? `${name} ✓ ${fact.at.slice(0, 10)}` : `${name} ✓`
  if (typeof value === 'number') return `${name} ${Math.round(value)}`
  return name
}

/** The capability chips a row shows — declared and inferred, each marked. */
/** One chip per stated capability. A stated `false` is a fact too ("no
 * tools", declared by the source) and renders; an ABSENT key is not a
 * denial and renders nothing. */
export function capabilityChips(row: CatalogRow): { key: string; label: string; basis: CatalogBasis; note?: string; value: boolean }[] {
  return Object.entries(row.capabilities ?? {})
    .filter(([, fact]) => fact.value === true || fact.value === false)
    .map(([key, fact]) => ({
      key,
      label: fact.value === false ? `no ${key}` : fact.basis === 'inferred' ? `${key}?` : key,
      basis: fact.basis,
      note: fact.note,
      value: fact.value === true,
    }))
}

/** What the page says when a row states no capability at all. */
export const NOT_STATED = 'not stated'
