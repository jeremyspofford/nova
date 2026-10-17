import { describe, expect, it } from 'vitest';
import { Contracts, contracts, listSchemas, loadSchema } from '../src/index.ts';

describe('Contracts', () => {
  it('compiles every schema in contracts/schemas', () => {
    const c = new Contracts();
    expect(c.names.length).toBeGreaterThan(5);
    for (const name of c.names) {
      const s = loadSchema(name);
      expect(s.$schema, name).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(String(s.$id), name).toMatch(/^https:\/\/arialabs\.ai\/schemas\//);
      expect(() => c.validator(name), name).not.toThrow();
    }
    expect(listSchemas()).toEqual(c.names);
  });

  it('validates and reports errors', () => {
    const c = contracts();
    expect(contracts()).toBe(c);
    const theme = { schemaVersion: 1, id: 'com.example.t', name: 'T', variant: 'dark', tokens: {} };
    expect(c.validate('theme.json', theme)).toEqual({ ok: true, errors: [] });
    const bad = c.validate('theme.json', { ...theme, tokens: { color: 'x' } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('refuses unknown schema names', () => {
    expect(() => contracts().validator('nope.json')).toThrow(/unknown schema/);
  });
});
