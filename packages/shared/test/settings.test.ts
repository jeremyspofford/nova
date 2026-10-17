import { describe, expect, it } from 'vitest';
import {
  checkSettingWrite,
  isSettingKey,
  resolveAll,
  resolveSetting,
  SETTINGS,
} from '../src/settings.ts';

describe('settings precedence (docs/14 §1)', () => {
  it('falls back to the built-in default', () => {
    expect(resolveSetting('appearance.theme', {})).toEqual({
      key: 'appearance.theme',
      value: 'system',
      source: 'default',
      locked: false,
    });
  });

  it('orders global < project < managed, and managed locks', () => {
    const layers = {
      global: { 'appearance.theme': 'dark' },
      project: { 'appearance.theme': 'light' },
    };
    expect(resolveSetting('appearance.theme', layers).source).toBe('project');
    expect(resolveSetting('appearance.theme', { global: layers.global }).value).toBe('dark');
    const managed = resolveSetting('appearance.theme', {
      ...layers,
      managed: { 'appearance.theme': 'high-contrast-dark' },
    });
    expect(managed).toMatchObject({ value: 'high-contrast-dark', source: 'managed', locked: true });
  });

  it('ignores project values for security keys', () => {
    const r = resolveSetting('network.egressAllow', {
      global: { 'network.egressAllow': ['api.example.com'] },
      project: { 'network.egressAllow': ['evil.example'] },
    });
    expect(r).toMatchObject({ value: ['api.example.com'], source: 'global' });
  });

  it('skips invalid stored values instead of failing', () => {
    expect(
      resolveSetting('appearance.fontScale', { global: { 'appearance.fontScale': 9 } }).value,
    ).toBe(1);
    expect(
      resolveSetting('appearance.theme', { managed: { 'appearance.theme': 'neon' } }).source,
    ).toBe('default');
  });

  it('resolves every registered key', () => {
    expect(resolveAll({}).map((r) => r.key)).toEqual(Object.keys(SETTINGS));
    expect(isSettingKey('appearance.theme')).toBe(true);
    expect(isSettingKey('constructor')).toBe(false);
  });
});

describe('checkSettingWrite', () => {
  it('accepts valid writes and returns the parsed value', () => {
    expect(checkSettingWrite('general.followUp', 'steer', 'global', {})).toEqual({
      ok: true,
      value: 'steer',
    });
  });

  it('rejects unknown keys, bad values, managed keys and security keys per project', () => {
    expect(checkSettingWrite('nope', 1, 'global', {})).toMatchObject({
      ok: false,
      error: 'unknown_key',
    });
    expect(checkSettingWrite('appearance.fontScale', 5, 'global', {})).toMatchObject({
      ok: false,
      error: 'invalid_value',
    });
    expect(
      checkSettingWrite('appearance.theme', 'dark', 'global', {
        managed: { 'appearance.theme': 'light' },
      }),
    ).toMatchObject({ ok: false, error: 'managed' });
    expect(checkSettingWrite('privacy.telemetry', true, 'project', {})).toMatchObject({
      ok: false,
      error: 'security_key_in_project',
    });
    expect(checkSettingWrite('network.egressAllow', ['*'], 'global', {})).toMatchObject({
      ok: false,
      error: 'invalid_value',
    });
  });
});

describe('setting value types', () => {
  it('keeps enum settings as literal unions', () => {
    const r = resolveSetting('appearance.theme', {});
    // Compile-time check: assigning a non-member must be a type error.
    // @ts-expect-error 'neon' is not a theme
    const bad: typeof r.value = 'neon';
    expect([r.value, bad]).toEqual(['system', 'neon']);
  });
});
