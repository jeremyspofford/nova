import { describe, it, expect } from 'vitest'
import { modelName } from './modelFormat'
import { shortModelName } from '../pages/chat/ModelSelector'

describe('T19 — modelName: a provider:model id read as the model', () => {
  it('C1: drops the provider (up to the FIRST colon) and the vendor path (up to the last slash)', () => {
    expect(modelName('openrouter:google/gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(modelName('anthropic:claude-opus-5')).toBe('claude-opus-5')
    expect(modelName('openrouter:anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('C1: a local id keeps its tag — only the first colon is the provider\'s', () => {
    expect(modelName('hub:qwen3:8b')).toBe('qwen3:8b')
    expect(modelName('dell:qwen3.6:27b')).toBe('qwen3.6:27b')
    expect(modelName('openrouter:meta-llama/llama-4:free')).toBe('llama-4:free')
  })

  // COVERAGE (T19 GREEN): only a path with two slashes tells the LAST slash
  // from the first — every id above has one.
  it('C1: a nested vendor path is cut at its LAST slash', () => {
    expect(modelName('openrouter:org/team/model-x')).toBe('model-x')
  })

  it('C1: an id with no provider and no vendor path comes back unchanged', () => {
    expect(modelName('gpt-x')).toBe('gpt-x')
  })

  it('C2: one formatter — the chat trigger\'s shortModelName reads every id the same', () => {
    const ids = [
      'openrouter:google/gemini-3.8-flash',
      'hub:qwen3:8b',
      'anthropic:claude-opus-5',
      'openrouter:meta-llama/llama-4:free',
      'qwen3:8b',
      'gpt-x',
    ]
    for (const id of ids) expect(shortModelName(id), id).toBe(modelName(id))
    // The pick still reads as a name, not blank (a stub '' agrees with nothing real).
    expect(modelName('openrouter:google/gemini-3.8-flash')).not.toBe('')
  })
})
