// Built-in preset generation (FR-221, docs/07 §8.1): deterministic Faster / Balanced / Smarter
// from the available models, with documented heuristics.
import { describe, expect, it } from 'vitest';
import { generatePresets, isChatModel, presetScore, type PresetCandidate } from '../src/index.ts';

const c = (ref: string, over: Partial<PresetCandidate> = {}): PresetCandidate => ({
  ref,
  modelId: ref.slice(ref.indexOf('/') + 1),
  owner: ref.slice(0, ref.indexOf('/')),
  local: false,
  reasoning: false,
  ...over,
});

describe('generatePresets', () => {
  it('uses mock-fast for Faster and Balanced and mock-smart (high) for Smarter offline', () => {
    expect(
      generatePresets([
        c('pa1/mock-fast', { local: true, offline: true }),
        c('pa1/mock-smart', { local: true, offline: true, reasoning: true }),
      ]),
    ).toEqual([
      { id: 'faster', label: 'Faster', strategy: 'single', targets: ['pa1/mock-fast'], rank: 1 },
      {
        id: 'balanced',
        label: 'Balanced',
        strategy: 'single',
        targets: ['pa1/mock-fast'],
        rank: 2,
      },
      {
        id: 'smarter',
        label: 'Smarter',
        strategy: 'single',
        targets: ['pa1/mock-smart'],
        reasoningLevel: 'high',
        rank: 3,
      },
    ]);
  });

  it('spreads real models across the scale with cross-account fallbacks, ignoring the mock', () => {
    const presets = generatePresets([
      c('mock/mock-smart', { offline: true, local: true, reasoning: true }),
      c('oa/gpt-5-mini', { reasoning: true }),
      c('oa/gpt-5', { reasoning: true }),
      c('oa/text-embedding-3-small'),
      c('ol/qwen3:14b', { local: true }),
      c('ol/llama3.2:3b', { local: true }),
    ]);
    expect(presets.map((p) => [p.id, p.targets, p.strategy, p.reasoningLevel ?? null])).toEqual([
      ['faster', ['ol/llama3.2:3b', 'oa/gpt-5-mini'], 'fallback', null],
      ['balanced', ['oa/gpt-5-mini', 'ol/qwen3:14b'], 'fallback', 'medium'],
      ['smarter', ['oa/gpt-5', 'ol/qwen3:14b'], 'fallback', 'high'],
    ]);
  });

  it('gives a reasoning-capable Faster pick reasoning off, and returns nothing without models', () => {
    expect(generatePresets([c('a/o4-mini', { reasoning: true })])[0]).toMatchObject({
      targets: ['a/o4-mini'],
      reasoningLevel: 'off',
    });
    expect(generatePresets([])).toEqual([]);
    expect(generatePresets([c('a/whisper-1'), c('a/tts-1')])).toEqual([]);
  });

  it('scores ids by size and family markers', () => {
    expect(presetScore('claude-haiku-4-5', false)).toBe(20);
    expect(presetScore('claude-opus-4-8', true)).toBe(90);
    expect(presetScore('claude-sonnet-4-5', true)).toBe(60);
    expect(presetScore('qwen3:4b', false)).toBe(15);
    expect(presetScore('llama3.1:8b', false)).toBe(25);
    expect(presetScore('qwen3:14b', false)).toBe(40);
    expect(presetScore('qwen3:32b', false)).toBe(55);
    expect(presetScore('llama3.1:70b', false)).toBe(75);
    expect(presetScore('o3', true)).toBe(90);
    expect(presetScore('gemini-2.5-pro', false)).toBe(80);
    expect(presetScore('gemini-2.5-flash', false)).toBe(20);
    expect(presetScore('gpt-4o-mini', false)).toBe(20);
    expect(presetScore('something', false)).toBe(50);
    expect(isChatModel('text-embedding-3-large')).toBe(false);
    expect(isChatModel('gpt-4.1')).toBe(true);
  });
});
