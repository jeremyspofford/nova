import { describe, it, expect } from 'vitest'
import type { CatalogRow } from '../../lib/api'
import {
  EMPTY_FACETS,
  applyFacets,
  benchmarkScore,
  capabilityChips,
  isCurrent,
  sortRows,
  suitabilityEntries,
  tagLabel,
} from './catalogFormat'

function row(overrides: Partial<CatalogRow> & { id: string }): CatalogRow {
  const [provider, ...rest] = overrides.id.split(':')
  return {
    provider,
    model: rest.join(':'),
    label: overrides.id,
    kind: provider === 'ollama' ? 'local' : 'cloud',
    sources: [{ key: provider === 'ollama' ? 'ollama-show' : 'provider-listing', fetched_at: 't' }],
    facts: {},
    capabilities: {},
    suitability: {},
    actions: [],
    ...overrides,
  }
}

const LOCAL = row({
  id: 'ollama:qwen3:8b',
  installed: true,
  facts: {
    size_bytes: { value: 5_225_388_164, basis: 'declared', source: 'ollama-tags' },
    params_b: { value: 8.19, basis: 'declared', source: 'ollama-show' },
    context_length: { value: 40960, basis: 'declared', source: 'ollama-show' },
    family: { value: 'qwen3', basis: 'declared', source: 'ollama-show' },
  },
  capabilities: {
    tools: { value: true, basis: 'declared', source: 'ollama-show' },
    thinking: { value: true, basis: 'declared', source: 'ollama-show' },
  },
  suitability: {
    'coding:inferred': { value: true, basis: 'inferred', source: 'name', note: 'name' },
    chat: { value: true, basis: 'vetted', source: 'curated', at: '2026-08-29' },
  },
})

const CLOUD = row({
  id: 'openrouter:openai/gpt-x',
  facts: {
    context_length: { value: 1_050_000, basis: 'declared', source: 'provider-listing' },
    price_prompt: { value: 0.00001, basis: 'declared', source: 'provider-listing' },
    price_completion: { value: 0.00005, basis: 'declared', source: 'provider-listing' },
  },
  capabilities: {
    tools: { value: true, basis: 'declared', source: 'provider-listing' },
    vision: { value: true, basis: 'declared', source: 'provider-listing' },
  },
  suitability: {
    coding: { value: 76.9, basis: 'declared', source: 'provider-listing', note: 'third-party' },
  },
})

const HUB = row({
  id: 'ollama:hf.co/unsloth/Qwen3-Coder-30B-GGUF',
  kind: 'hub',
  installed: false,
  sources: [{ key: 'hf-hub', fetched_at: 't' }],
  facts: { params_b: { value: 30.5, basis: 'declared', source: 'hf-hub' } },
  capabilities: { tools: { value: true, basis: 'inferred', source: 'hf-hub', note: 'chat_template mentions tools' } },
  suitability: {},
})

const AVAILABLE = row({ id: 'ollama:qwen3:4b', installed: false, facts: {} })

describe('catalogFormat — tabs and text', () => {
  it('tabs split by kind and installed state', () => {
    const rows = [LOCAL, CLOUD, HUB, AVAILABLE]
    expect(applyFacets(rows, { ...EMPTY_FACETS, tab: 'installed' }).rows.map(r => r.id)).toEqual(['ollama:qwen3:8b'])
    expect(applyFacets(rows, { ...EMPTY_FACETS, tab: 'available' }).rows.map(r => r.id)).toEqual([HUB.id, AVAILABLE.id])
    expect(applyFacets(rows, { ...EMPTY_FACETS, tab: 'cloud' }).rows.map(r => r.id)).toEqual([CLOUD.id])
    expect(applyFacets(rows, EMPTY_FACETS).rows).toHaveLength(4)
  })

  it('text matches id, label or family', () => {
    expect(applyFacets([LOCAL, CLOUD], { ...EMPTY_FACETS, text: 'QWEN' }).rows.map(r => r.id)).toEqual([LOCAL.id])
    expect(applyFacets([LOCAL, CLOUD], { ...EMPTY_FACETS, text: 'gpt' }).rows.map(r => r.id)).toEqual([CLOUD.id])
  })
})

describe('catalogFormat — capability and suitability facets honour the basis', () => {
  it('an inferred capability satisfies the filter only when inferred are included', () => {
    const off = applyFacets([LOCAL, CLOUD, HUB], { ...EMPTY_FACETS, capability: 'tools' })
    expect(off.rows.map(r => r.id)).toEqual([LOCAL.id, CLOUD.id])
    const on = applyFacets([LOCAL, CLOUD, HUB], { ...EMPTY_FACETS, capability: 'tools', includeInferred: true })
    expect(on.rows.map(r => r.id)).toEqual([LOCAL.id, CLOUD.id, HUB.id])
  })

  it('suitability finds every basis under a name and applies the same rule', () => {
    expect(suitabilityEntries(LOCAL, 'coding').map(e => e.basis)).toEqual(['inferred'])
    const off = applyFacets([LOCAL, CLOUD], { ...EMPTY_FACETS, suitability: 'coding' })
    expect(off.rows.map(r => r.id)).toEqual([CLOUD.id])
    const on = applyFacets([LOCAL, CLOUD], { ...EMPTY_FACETS, suitability: 'coding', includeInferred: true })
    expect(on.rows.map(r => r.id)).toEqual([LOCAL.id, CLOUD.id])
    expect(applyFacets([LOCAL, CLOUD], { ...EMPTY_FACETS, suitability: 'chat' }).rows.map(r => r.id)).toEqual([LOCAL.id])
  })
})

describe('catalogFormat — numeric facets exclude AND count rows lacking the fact', () => {
  it('size, params, context and price', () => {
    const rows = [LOCAL, CLOUD, HUB, AVAILABLE]
    const size = applyFacets(rows, { ...EMPTY_FACETS, maxSizeGb: 10 })
    expect(size.rows.map(r => r.id)).toEqual([LOCAL.id])
    expect(size.hidden.noSize).toBe(3)
    const tight = applyFacets(rows, { ...EMPTY_FACETS, maxSizeGb: 1 })
    expect(tight.rows).toEqual([])
    const params = applyFacets(rows, { ...EMPTY_FACETS, maxParamsB: 10 })
    expect(params.rows.map(r => r.id)).toEqual([LOCAL.id])
    expect(params.hidden.noParams).toBe(2)
    const ctx = applyFacets(rows, { ...EMPTY_FACETS, minContextK: 128 })
    expect(ctx.rows.map(r => r.id)).toEqual([CLOUD.id])
    expect(ctx.hidden.noContext).toBe(2)
    const price = applyFacets(rows, { ...EMPTY_FACETS, maxPricePerM: 5 })
    expect(price.rows).toEqual([])
    expect(price.hidden.noPrice).toBe(3)
    expect(applyFacets(rows, { ...EMPTY_FACETS, maxPricePerM: 10 }).rows.map(r => r.id)).toEqual([CLOUD.id])
  })
})

describe('catalogFormat — sorting puts the absent last, both ways', () => {
  it('by size and by price', () => {
    const rows = [CLOUD, HUB, LOCAL]
    // Only LOCAL states a size; the two absent rows follow it in BOTH
    // directions, ordered among themselves by label.
    expect(sortRows(rows, 'size_bytes', 'asc').map(r => r.id)).toEqual([LOCAL.id, HUB.id, CLOUD.id])
    expect(sortRows(rows, 'size_bytes', 'desc').map(r => r.id)).toEqual([LOCAL.id, HUB.id, CLOUD.id])
    expect(sortRows(rows, 'params_b', 'desc').map(r => r.id)).toEqual([HUB.id, LOCAL.id, CLOUD.id])
    expect(sortRows(rows, 'price_prompt', 'asc').map(r => r.id)).toEqual([CLOUD.id, HUB.id, LOCAL.id])
  })

  it('by coding ignores inferred entries', () => {
    expect(sortRows([LOCAL, CLOUD], 'coding', 'desc').map(r => r.id)).toEqual([CLOUD.id, LOCAL.id])
    expect(sortRows([LOCAL, CLOUD], 'name', 'asc').map(r => r.id)).toEqual([LOCAL.id, CLOUD.id])
  })
})

describe('catalogFormat — current and labels', () => {
  it('a qualified or a pre-registry bare chat.model marks the local row', () => {
    expect(isCurrent(LOCAL, 'ollama:qwen3:8b')).toBe(true)
    expect(isCurrent(LOCAL, 'qwen3:8b')).toBe(true)
    expect(isCurrent(CLOUD, 'openrouter:openai/gpt-x')).toBe(true)
    expect(isCurrent(CLOUD, 'openai/gpt-x')).toBe(false)
    expect(isCurrent(LOCAL, '')).toBe(false)
  })

  it('tags are labelled by basis', () => {
    expect(tagLabel('coding', { value: true, basis: 'inferred', source: 'name' })).toBe('coding?')
    expect(tagLabel('coding', { value: 76.9, basis: 'declared', source: 'provider-listing' })).toBe('coding 77')
    expect(tagLabel('chat', { value: true, basis: 'vetted', source: 'curated', at: '2026-08-29T00:00:00Z' })).toBe('chat ✓ 2026-08-29')
    expect(tagLabel('agent_quality', { value: 0.857, basis: 'measured', source: 'core-evals' })).toBe('agent_quality 86% ●')
    expect(capabilityChips(HUB)).toEqual([
      { key: 'tools', label: 'tools?', basis: 'inferred', note: 'chat_template mentions tools', value: true },
    ])
    expect(capabilityChips(LOCAL).map(c => c.label)).toEqual(['tools', 'thinking'])
    // A stated false is a fact and renders; an absent key is not a denial.
    const denied = row({
      id: 'openrouter:x/y',
      capabilities: { tools: { value: false, basis: 'declared', source: 'provider-listing' } },
    })
    expect(capabilityChips(denied).map(c => [c.label, c.value])).toEqual([['no tools', false]])
    expect(capabilityChips(row({ id: 'openrouter:x/z' }))).toEqual([])
  })

  it('an inferred number is not a stated one: the size facet leaves it out and counts it unless inferred is included', () => {
    const estimated = row({
      id: 'ollama:hf.co/o/r',
      kind: 'hub',
      facts: { size_bytes: { value: 2_000_000_000, basis: 'inferred', source: 'hf-hub', note: '≈ Q4_K_M' } },
    })
    const stated = row({ id: 'ollama:x:1b', installed: false, facts: { size_bytes: { value: 1_000_000_000, basis: 'declared', source: 'ollama-tags' } } })
    const off = applyFacets([estimated, stated], { ...EMPTY_FACETS, tab: 'available', maxSizeGb: 3 })
    expect(off.rows.map(r => r.id)).toEqual(['ollama:x:1b'])
    expect(off.hidden.noSize).toBe(1)
    const on = applyFacets([estimated, stated], { ...EMPTY_FACETS, tab: 'available', maxSizeGb: 3, includeInferred: true })
    expect(on.rows.map(r => r.id)).toEqual(['ollama:hf.co/o/r', 'ollama:x:1b'])
    expect(on.hidden.noSize).toBe(0)
  })

  it('a benchmark score is a numeric, non-inferred suitability entry under the index name', () => {
    expect(benchmarkScore(CLOUD, 'coding')?.value).toBe(76.9)
    expect(benchmarkScore(CLOUD, 'intelligence')).toBeNull()
    expect(benchmarkScore(LOCAL, 'coding')).toBeNull() // inferred "coding?" is not a score
    const scored = row({ id: 'openrouter:x/y', suitability: { intelligence: { value: 53, basis: 'declared', source: 'provider-listing' }, agentic: { value: 50, basis: 'declared', source: 'provider-listing' } } })
    expect(sortRows([CLOUD, scored], 'intelligence', 'desc').map(r => r.id)).toEqual(['openrouter:x/y', CLOUD.id])
    expect(sortRows([CLOUD, scored], 'agentic', 'asc').map(r => r.id)).toEqual(['openrouter:x/y', CLOUD.id])
  })
})
