import { describe, it, expect } from 'vitest'
import { mergeModels } from './modelsFormat'
import type { SuggestedModel } from '../../lib/api'

function curated(overrides: Partial<SuggestedModel> = {}): SuggestedModel {
  return {
    slug: 'qwen3:8b',
    label: 'Qwen3 8B',
    params_b: 8,
    min_vram_gb: 10,
    note: 'a solid daily driver',
    ...overrides,
  }
}

describe('mergeModels', () => {
  it('marks the curated entry matching chat.model as current', () => {
    const merged = mergeModels('qwen3:8b', ['qwen3:8b'], [curated()])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ slug: 'qwen3:8b', isCurrent: true, installed: true, curated: true })
  })

  it('marks a curated, not-yet-installed model as available to pull', () => {
    const merged = mergeModels('qwen3:8b', ['qwen3:8b'], [curated(), curated({ slug: 'qwen3:14b', label: 'Qwen3 14B' })])
    const notInstalled = merged.find(m => m.slug === 'qwen3:14b')
    expect(notInstalled).toMatchObject({ installed: false, curated: true, isCurrent: false })
  })

  it('includes an installed model that is not in the curated set', () => {
    const merged = mergeModels('qwen3:8b', ['qwen3:8b', 'llama3.4:9b'], [curated()])
    const extra = merged.find(m => m.slug === 'llama3.4:9b')
    expect(extra).toMatchObject({ installed: true, curated: false, isCurrent: false, label: 'llama3.4:9b' })
  })

  // A cloud/remote backend's chat.model rarely appears in the local curated
  // catalog or an installed-models list at all — it must still show up,
  // marked current, rather than the "current model" going unrepresented.
  it('surfaces chat.model as its own entry even when neither curated nor installed lists it', () => {
    const merged = mergeModels('gpt-4o-mini', [], [curated()])
    const current = merged.find(m => m.slug === 'gpt-4o-mini')
    expect(current).toMatchObject({ isCurrent: true, curated: false, installed: false })
  })

  it('does not duplicate a slug present in both the curated and installed lists', () => {
    const merged = mergeModels('qwen3:8b', ['qwen3:8b'], [curated()])
    expect(merged.filter(m => m.slug === 'qwen3:8b')).toHaveLength(1)
  })

  it('treats a null installed list (the fetch failed) as nothing confirmed installed', () => {
    const merged = mergeModels('qwen3:8b', null, [curated()])
    expect(merged[0]).toMatchObject({ installed: false, isCurrent: true })
  })

  it('sorts current first, then installed, then available to pull', () => {
    const merged = mergeModels(
      'qwen3:14b',
      ['qwen3:14b', 'qwen3:4b'],
      [curated({ slug: 'qwen3:27b', label: 'Qwen3 27B' }), curated({ slug: 'qwen3:14b', label: 'Qwen3 14B' }), curated({ slug: 'qwen3:4b', label: 'Qwen3 4B' })],
    )
    expect(merged.map(m => m.slug)).toEqual(['qwen3:14b', 'qwen3:4b', 'qwen3:27b'])
  })
})
