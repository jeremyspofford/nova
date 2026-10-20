import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contracts } from '@nova/contracts';
import {
  BUILTIN_THEMES,
  COLOR_TOKENS,
  RADIUS_TOKENS,
  THEME_FONTS,
  THEME_TOKENS,
  applyTheme,
  contrastRatio,
  dark,
  light,
  mergeTheme,
  mixHex,
  parseHex,
  resolveTheme,
  type Theme,
} from '../src/index.ts';

// jsdom gives import.meta.url an http: scheme, so use the directory Vitest provides.
const here = import.meta.dirname;
const validate = contracts().validator('theme.json');

describe('built-in themes', () => {
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s matches contracts/schemas/theme.json',
    (_id, theme) => {
      const r = validate(theme);
      expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    },
  );

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s defines every color token',
    (_id, theme) => {
      for (const token of COLOR_TOKENS)
        expect(theme.tokens[token], token).toMatch(/^#[0-9a-f]{6}$/i);
    },
  );

  // WCAG 2.2 AA (docs/04 §4.4, docs/16 §7): body text 4.5:1, UI components and focus 3:1.
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s meets contrast floors',
    (_id, theme) => {
      const t = theme.tokens;
      const body = ['--u-text', '--u-text-muted'] as const;
      for (const bg of ['--u-bg', '--u-surface', '--u-surface-2'] as const) {
        for (const fg of body)
          expect(contrastRatio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const ui of [
          '--u-accent',
          '--u-focus',
          '--u-danger',
          '--u-success',
          '--u-info',
          '--u-warn',
        ] as const) {
          expect(contrastRatio(t[ui]!, t[bg]!), `${ui} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
      expect(
        contrastRatio(t['--u-accent-contrast']!, t['--u-accent']!),
        'accent text',
      ).toBeGreaterThanOrEqual(4.5);
      // The edge of a field (--u-control-border in tokens.css: 70 % text-muted, 30 % border)
      // stands out 3:1 from every surface it sits on (WCAG 1.4.11).
      const edge = mixHex(t['--u-border']!, t['--u-text-muted']!, 0.7);
      for (const bg of ['--u-bg', '--u-surface', '--u-surface-2'] as const)
        expect(contrastRatio(edge, t[bg]!), `field edge on ${bg}`).toBeGreaterThanOrEqual(3);
    },
  );

  it('derives the field edge in tokens.css from the theme', () => {
    const css = readFileSync(join(here, '../src/tokens.css'), 'utf8');
    expect(css).toContain(
      '--u-control-border: color-mix(in srgb, var(--u-text-muted) 70%, var(--u-border));',
    );
    expect(css).toMatch(/\.nv-input \{[^}]*border: 1px solid var\(--u-control-border\)/);
  });
});

describe('theme helpers', () => {
  it('resolves "system" from the OS preference', () => {
    expect(resolveTheme('system', true)).toBe(dark);
    expect(resolveTheme('system', false)).toBe(light);
    expect(resolveTheme('high-contrast-dark', false).id).toBe('nova.high-contrast-dark');
    expect(resolveTheme('high-contrast-light', true).id).toBe('nova.high-contrast-light');
    expect(resolveTheme('light', true)).toBe(light);
    expect(resolveTheme('dark', false)).toBe(dark);
  });

  it('merges a custom theme: unknown tokens dropped, missing ones inherited, bad colors ignored', () => {
    const custom: Theme = {
      schemaVersion: 1,
      id: 'com.example.midnight',
      name: 'Midnight',
      variant: 'dark',
      tokens: { '--u-bg': '#08090c', '--u-unknown': '#ffffff', '--u-accent': 'red' },
      fonts: { '--u-font-code': '"Fira Code", monospace' },
    };
    const m = mergeTheme(custom);
    expect(m.tokens['--u-bg']).toBe('#08090c');
    expect(m.tokens['--u-accent']).toBe(dark.tokens['--u-accent']);
    expect(m.tokens['--u-unknown']).toBeUndefined();
    expect(m.fonts?.['--u-font-code']).toContain('Fira Code');
    expect(mergeTheme({ ...custom, variant: 'light', fonts: undefined }).tokens['--u-text']).toBe(
      light.tokens['--u-text'],
    );
  });

  // FR-011: what a custom theme may set; every one is a token tokens.css defines.
  it('lists the theme tokens: the color roles and the radii', () => {
    expect(THEME_TOKENS).toEqual([...COLOR_TOKENS, ...RADIUS_TOKENS]);
    const css = readFileSync(join(here, '../src/tokens.css'), 'utf8');
    for (const token of [...THEME_TOKENS, ...THEME_FONTS])
      expect(css, token).toContain(`${token}:`);
    expect(THEME_TOKENS).not.toContain('--u-text-md');
    expect(THEME_TOKENS).not.toContain('--u-dur');
  });

  it('applies tokens to an element', () => {
    const el = document.createElement('div');
    applyTheme({ ...light, fonts: { '--u-font-ui': 'serif' } }, el);
    expect(el.style.getPropertyValue('--u-bg')).toBe('#ffffff');
    expect(el.style.getPropertyValue('--u-font-ui')).toBe('serif');
    expect(el.dataset.theme).toBe('nova.light');
    applyTheme(dark, el);
    expect(el.style.colorScheme).toBe('dark');
  });

  it('parses short and long hex colors', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(() => parseHex('blue')).toThrow(TypeError);
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
  });
});

// docs/14 §2.2: "No hard-coded colors in components; a lint rule enforces token usage."
describe('no hard-coded colors', () => {
  const srcDir = join(here, '../src/components/');
  it.each(readdirSync(srcDir))('%s uses tokens only', (file) => {
    const text = readFileSync(join(srcDir, file), 'utf8');
    expect(text).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
