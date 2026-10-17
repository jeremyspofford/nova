import { describe, expect, it } from 'vitest';
import { modelRef, nodeModelRef, parseAnyModelRef, presetRef } from '../src/index.ts';

describe('model refs', () => {
  it('parses account, node and preset refs', () => {
    expect(parseAnyModelRef(modelRef('pa1', 'gpt-x/mini'))).toEqual({
      kind: 'account',
      providerAccountId: 'pa1',
      modelId: 'gpt-x/mini',
    });
    expect(parseAnyModelRef(nodeModelRef('n1', 'llama3:8b'))).toEqual({
      kind: 'node',
      nodeId: 'n1',
      modelId: 'llama3:8b',
    });
    expect(parseAnyModelRef(presetRef('fast'))).toEqual({ kind: 'preset', presetId: 'fast' });
  });

  it('rejects malformed refs', () => {
    for (const bad of ['', 'nomodel', '/x', 'pa1/', 'node:', 'node:n1', 'preset:', 'preset:Bad!'])
      expect(parseAnyModelRef(bad)).toBeNull();
  });
});
