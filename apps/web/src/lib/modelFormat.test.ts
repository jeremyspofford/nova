import { describe, it, expect } from 'vitest'
import { MODEL_NOT_STATED, modelName } from './modelFormat'
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

// T20 COVERAGE (verification 2-7, orchestrator FINDING 10-13): the model ids
// live turn_spans llm_call rows actually carry (last 30 days) — bare local
// ids are common, and their one colon is the ollama tag, not a provider.
describe('T20 — modelName over the real ids in turn_spans', () => {
  it('every live id reads as its model', () => {
    const live: Array<[string, string]> = [
      ['dell:qwen3:8b', 'qwen3:8b'],
      ['qwen3.8:27b', 'qwen3.8:27b'],
      ['openrouter:google/gemini-3.8-flash', 'gemini-3.8-flash'],
      ['qwen3:8b', 'qwen3:8b'],
      ['hub:qwen3.8:27b', 'qwen3.8:27b'],
      ['ollama:qwen3:8b', 'qwen3:8b'],
      ['openrouter:~z-ai/glm-flash-latest', 'glm-flash-latest'],
    ]
    for (const [id, name] of live) expect(modelName(id), id).toBe(name)
  })

  it('an empty id (152 live rows) reads a stated fallback, never an empty name', () => {
    expect(MODEL_NOT_STATED.trim()).not.toBe('')
    expect(modelName('')).toBe(MODEL_NOT_STATED)
    expect(modelName('  ')).toBe(MODEL_NOT_STATED)
  })

  it('a bare tag reads whole whatever the family\'s name; a provider\'s untagged model is still cut', () => {
    expect(modelName('mistral:7b')).toBe('mistral:7b')
    expect(modelName('llama3:latest')).toBe('llama3:latest')
    expect(modelName('hub:llama3')).toBe('llama3')
    expect(modelName('anthropic:claude-opus-5')).toBe('claude-opus-5')
  })

  it('a head no provider could be named (a dot, a path) is a bare id: its tag stays', () => {
    expect(modelName('qwen3.8:instruct')).toBe('qwen3.8:instruct')
    expect(modelName('hf.co/bartowski/model-gguf:Q4_K_M')).toBe('model-gguf:Q4_K_M')
  })
})
