import { describe, expect, it } from 'vitest';
import { isUnlocalized } from '../src/residue.ts';

describe('the localization residue check', () => {
  it('allows fixture data, also inside an address or an id', () => {
    expect(isUnlocalized('Reach https://api.example.com/status', ['api.example.com'])).toBe(true);
    expect(isUnlocalized('https://api.example.com/status', ['api.example.com'])).toBe(false);
    expect(isUnlocalized('sha256:9f2c…41ab', ['sha256:9f2c…41ab'])).toBe(false);
    expect(isUnlocalized('Nova: mcp:docs/search')).toBe(false);
    expect(isUnlocalized('Plain words')).toBe(true);
  });
});
