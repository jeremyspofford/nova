/** models.ts decides how every model picker groups and orders its options.
 *  "Local first" is a product decision (the top of a picker is a
 *  recommendation), so its ordering is pinned here, not left to luck. */
import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../api';
import { groupModels, isLocalProvider, providerGroupLabel, providerName } from '../models';

const m = (provider: string, id: string): ModelInfo =>
  ({ provider, id, name: id } as unknown as ModelInfo);

describe('providerName', () => {
  it('uses the shipped display names', () => {
    expect(providerName('ollama')).toBe('Ollama');
    expect(providerName('openrouter')).toBe('OpenRouter');
  });

  it('falls back to a capitalised slug for providers registered later', () => {
    expect(providerName('acme')).toBe('Acme');
    expect(providerName('')).toBe('Other');
  });
});

describe('providerGroupLabel', () => {
  it('says where it runs before who makes it', () => {
    expect(providerGroupLabel('ollama')).toBe('On this machine — Ollama');
    expect(providerGroupLabel('anthropic')).toBe('Cloud — Anthropic');
  });

  it('never guesses local for `custom` — the expensive direction to be wrong in', () => {
    expect(isLocalProvider('custom')).toBe(false);
    expect(providerGroupLabel('custom')).toBe('Cloud — Custom endpoint');
  });
});

describe('groupModels', () => {
  it('groups by provider with local providers first', () => {
    const groups = groupModels([
      m('anthropic', 'claude-sonnet-4-6'),
      m('ollama', 'qwen3:8b'),
      m('anthropic', 'claude-haiku-4-5'),
      m('openrouter', 'z-ai/glm-5.2'),
    ]);
    expect(groups.map(g => g.slug)).toEqual(['ollama', 'anthropic', 'openrouter']);
    expect(groups[1].models.map(x => x.id))
      .toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5']);
  });

  it('keeps the caller-given order within a group — the backend already sorted', () => {
    const groups = groupModels([m('ollama', 'b'), m('ollama', 'a')]);
    expect(groups[0].models.map(x => x.id)).toEqual(['b', 'a']);
  });

  it('buckets a missing provider under `other` instead of crashing', () => {
    const groups = groupModels([m('', 'mystery')]);
    expect(groups[0].slug).toBe('other');
    expect(groups[0].label).toBe('Cloud — Other');
  });
});
