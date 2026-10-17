// Built-in themes (docs/14 §2.2). Components read only these tokens; no colors are hard-coded
// anywhere else (a lint check in test/no-hardcoded-colors.test.ts enforces it).

export interface Theme {
  schemaVersion: 1;
  id: string;
  name: string;
  variant: 'light' | 'dark' | 'system';
  extends?: string;
  tokens: Record<string, string>;
  fonts?: Record<string, string>;
}

/** Tokens every complete theme must define (docs/04 §4.1 color roles). */
export const COLOR_TOKENS = [
  '--u-bg',
  '--u-surface',
  '--u-surface-2',
  '--u-border',
  '--u-text',
  '--u-text-muted',
  '--u-accent',
  '--u-accent-contrast',
  '--u-success',
  '--u-warn',
  '--u-danger',
  '--u-info',
  '--u-focus',
] as const;

export const dark: Theme = {
  schemaVersion: 1,
  id: 'nova.dark',
  name: 'Dark',
  variant: 'dark',
  tokens: {
    '--u-bg': '#0e0f12',
    '--u-surface': '#16181d',
    '--u-surface-2': '#1d2026',
    '--u-border': '#2a2e37',
    '--u-text': '#e8eaf0',
    '--u-text-muted': '#a3aab8',
    '--u-accent': '#7d98ff',
    '--u-accent-contrast': '#0b0d12',
    '--u-success': '#4cc764',
    '--u-warn': '#e3b341',
    '--u-danger': '#ff7b72',
    '--u-info': '#79b8ff',
    '--u-focus': '#9cb2ff',
  },
};

export const light: Theme = {
  schemaVersion: 1,
  id: 'nova.light',
  name: 'Light',
  variant: 'light',
  tokens: {
    '--u-bg': '#ffffff',
    '--u-surface': '#f6f7f9',
    '--u-surface-2': '#eceef2',
    '--u-border': '#d0d5dd',
    '--u-text': '#16181d',
    '--u-text-muted': '#555d6b',
    '--u-accent': '#3451d1',
    '--u-accent-contrast': '#ffffff',
    '--u-success': '#1a7f37',
    '--u-warn': '#8a5a00',
    '--u-danger': '#c4291c',
    '--u-info': '#0b5cad',
    '--u-focus': '#3451d1',
  },
};

export const highContrastDark: Theme = {
  schemaVersion: 1,
  id: 'nova.high-contrast-dark',
  name: 'High contrast (dark)',
  variant: 'dark',
  tokens: {
    '--u-bg': '#000000',
    '--u-surface': '#0a0a0a',
    '--u-surface-2': '#141414',
    '--u-border': '#ffffff',
    '--u-text': '#ffffff',
    '--u-text-muted': '#e0e0e0',
    '--u-accent': '#ffd60a',
    '--u-accent-contrast': '#000000',
    '--u-success': '#5cff7a',
    '--u-warn': '#ffd60a',
    '--u-danger': '#ff8a80',
    '--u-info': '#8ecbff',
    '--u-focus': '#ffd60a',
  },
};

export const highContrastLight: Theme = {
  schemaVersion: 1,
  id: 'nova.high-contrast-light',
  name: 'High contrast (light)',
  variant: 'light',
  tokens: {
    '--u-bg': '#ffffff',
    '--u-surface': '#ffffff',
    '--u-surface-2': '#f0f0f0',
    '--u-border': '#000000',
    '--u-text': '#000000',
    '--u-text-muted': '#1f1f1f',
    '--u-accent': '#0030a8',
    '--u-accent-contrast': '#ffffff',
    '--u-success': '#005a1f',
    '--u-warn': '#5c3b00',
    '--u-danger': '#9b0000',
    '--u-info': '#00448c',
    '--u-focus': '#0030a8',
  },
};

export const BUILTIN_THEMES: readonly Theme[] = [light, dark, highContrastLight, highContrastDark];

export type ThemeChoice =
  'system' | 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';

/** Resolve a user choice to a concrete theme, following the OS preference for "system". */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  switch (choice) {
    case 'system':
      return prefersDark ? dark : light;
    case 'light':
      return light;
    case 'dark':
      return dark;
    case 'high-contrast-light':
      return highContrastLight;
    case 'high-contrast-dark':
      return highContrastDark;
  }
}

/**
 * Merge a custom theme over its base: unknown tokens are dropped, missing tokens fall back to the
 * base theme (docs/14 §2.2).
 */
export function mergeTheme(
  custom: Theme,
  base: Theme = custom.variant === 'light' ? light : dark,
): Theme {
  const tokens: Record<string, string> = { ...base.tokens };
  for (const [k, v] of Object.entries(custom.tokens)) {
    if (k in base.tokens && isColor(v)) tokens[k] = v;
  }
  const merged: Theme = {
    ...base,
    id: custom.id,
    name: custom.name,
    variant: custom.variant,
    tokens,
  };
  if (custom.fonts) merged.fonts = { ...base.fonts, ...custom.fonts };
  return merged;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export function isColor(value: string): boolean {
  return HEX.test(value);
}

/** Apply a theme's tokens to an element's style (normally `document.documentElement`). */
export function applyTheme(theme: Theme, el: HTMLElement): void {
  for (const [k, v] of Object.entries(theme.tokens)) el.style.setProperty(k, v);
  for (const [k, v] of Object.entries(theme.fonts ?? {})) el.style.setProperty(k, v);
  el.dataset.theme = theme.id;
  el.style.colorScheme = theme.variant === 'light' ? 'light' : 'dark';
}
