// Appearance (FR-010, FR-011, FR-015): resolve the theme setting, or the saved theme in use, and
// the user's color, font, size and motion overrides into token values, then apply them to the
// document root. Overrides only change token values, so every component follows them live.
import { SAFE_THEME_VALUE } from '@nova/shared';
import {
  BUILTIN_THEMES,
  COLOR_TOKENS,
  RADIUS_TOKENS,
  THEME_FONTS,
  THEME_TOKENS,
  applyTheme,
  contrastRatio,
  dark,
  isColor,
  light,
  mixHex,
  readableOn,
  resolveTheme,
  type Theme,
  type ThemeChoice,
} from '@nova/ui';
import { CONTRAST_TEXT } from './strings.ts';

export interface AppearanceSettings {
  theme: ThemeChoice;
  /**
   * The saved theme in use (`appearance.customTheme`, FR-011), already checked: it replaces
   * `theme` and is applied token for token over its own base. The color overrides still go on top.
   */
  custom?: Theme | null;
  accent: string | null;
  background: string | null;
  foreground: string | null;
  uiFont: string | null;
  codeFont: string | null;
  fontScale: number;
  reducedMotion: 'system' | 'on' | 'off';
}

export interface ResolvedAppearance {
  theme: Theme;
  /** Font stacks; null means the tokens.css default. */
  fonts: { '--u-font-ui': string | null; '--u-font-code': string | null };
  fontScale: number;
  /** 'reduce' or 'full' when the setting overrides the OS; null follows the OS. */
  motion: 'reduce' | 'full' | null;
}

/** A built-in theme by id: `nova.dark` or just `dark`. */
export function builtinTheme(id: string): Theme | null {
  return BUILTIN_THEMES.find((t) => t.id === id || t.id === `nova.${id}`) ?? null;
}

/**
 * The built-in a custom theme builds on: the one it extends, else its variant's (a `system`
 * theme follows the device's light or dark setting).
 */
export function customBase(theme: Theme, prefersDark: boolean): Theme {
  const ext = theme.extends ? builtinTheme(theme.extends) : null;
  if (ext) return ext;
  if (theme.variant === 'light') return light;
  if (theme.variant === 'dark') return dark;
  return prefersDark ? dark : light;
}

/**
 * Whether a theme may set `token` to `value` (FR-011, docs/14 §2.2): a theme token, a plain CSS
 * value by the marketplace's and the SDK's rule, and for a color role a hex color Nova can check
 * for contrast.
 */
export function themeValueOk(token: string, value: unknown): value is string {
  if (typeof value !== 'string' || !THEME_TOKENS.includes(token)) return false;
  if (!SAFE_THEME_VALUE.test(value)) return false;
  return (COLOR_TOKENS as readonly string[]).includes(token) ? isColor(value) : true;
}

/** Whether a theme may set the font `key` to `value`. */
export function themeFontOk(key: string, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (THEME_FONTS as readonly string[]).includes(key) &&
    SAFE_THEME_VALUE.test(value)
  );
}

/**
 * A custom theme as it looks (FR-011): every token it sets that passes the check, over its base;
 * tokens it does not set, and those it may not, come from the base. A `system` theme takes the
 * light or dark of its base.
 */
export function customLook(theme: Theme, prefersDark: boolean): Theme {
  const base = customBase(theme, prefersDark);
  const tokens = { ...base.tokens };
  for (const [k, v] of Object.entries(theme.tokens)) if (themeValueOk(k, v)) tokens[k] = v;
  const fonts: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.fonts ?? {})) if (themeFontOk(k, v)) fonts[k] = v;
  return {
    schemaVersion: 1,
    id: theme.id,
    name: theme.name,
    variant: theme.variant === 'system' ? base.variant : theme.variant,
    extends: base.id,
    tokens,
    ...(Object.keys(fonts).length ? { fonts } : {}),
  };
}

export function resolveAppearance(s: AppearanceSettings, prefersDark: boolean): ResolvedAppearance {
  const { fonts: themeFonts, ...base } = s.custom
    ? customLook(s.custom, prefersDark)
    : resolveTheme(s.theme, prefersDark);
  const tokens = { ...base.tokens };
  const bg = s.background && isColor(s.background) ? s.background : null;
  const fg = s.foreground && isColor(s.foreground) ? s.foreground : null;
  const accent = s.accent && isColor(s.accent) ? s.accent : null;
  if (bg || fg) {
    const b = bg ?? tokens['--u-bg'] ?? '#000000';
    const f = fg ?? tokens['--u-text'] ?? '#ffffff';
    // Derive surfaces and borders from the chosen pair so the palette stays coherent.
    tokens['--u-bg'] = b;
    tokens['--u-text'] = f;
    tokens['--u-surface'] = mixHex(b, f, 0.04);
    tokens['--u-surface-2'] = mixHex(b, f, 0.08);
    tokens['--u-border'] = mixHex(b, f, 0.2);
    tokens['--u-text-muted'] = mixHex(f, b, 0.28);
  }
  if (accent) {
    tokens['--u-accent'] = accent;
    tokens['--u-accent-contrast'] = readableOn(accent);
  }
  return {
    theme: { ...base, tokens },
    // The user's own font wins; a saved theme's font fills in where there is none.
    fonts: {
      '--u-font-ui': s.uiFont || themeFonts?.['--u-font-ui'] || null,
      '--u-font-code': s.codeFont || themeFonts?.['--u-font-code'] || null,
    },
    fontScale: s.fontScale,
    motion: s.reducedMotion === 'on' ? 'reduce' : s.reducedMotion === 'off' ? 'full' : null,
  };
}

export function applyAppearance(a: ResolvedAppearance, el: HTMLElement): void {
  applyTheme(a.theme, el);
  // Built-in themes set no radii: one a saved theme set goes back to tokens.css when it stops.
  for (const k of RADIUS_TOKENS) if (!(k in a.theme.tokens)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(a.fonts)) {
    if (v) el.style.setProperty(k, v);
    else el.style.removeProperty(k);
  }
  el.style.setProperty('--u-font-scale', String(a.fontScale));
  if (a.motion) el.dataset.motion = a.motion;
  else delete el.dataset.motion;
}

export interface ContrastWarning {
  /** Which pair failed: body text, secondary text or the accent, each on the background. */
  id: 'body' | 'muted' | 'accent';
  /** The pair's name in the active locale. */
  pair: string;
  ratio: number;
  minimum: number;
}

/** WCAG 2.2 AA checks for the effective colors (docs/04 §4.4). */
export function contrastWarnings(theme: Theme): ContrastWarning[] {
  const t = theme.tokens;
  const out: ContrastWarning[] = [];
  const check = (fg: string, bg: string, id: ContrastWarning['id'], minimum: number) => {
    const a = t[fg];
    const b = t[bg];
    if (!a || !b || !isColor(a) || !isColor(b)) return;
    const ratio = contrastRatio(a, b);
    if (ratio < minimum) out.push({ id, pair: CONTRAST_TEXT[id], ratio, minimum });
  };
  check('--u-text', '--u-bg', 'body', 4.5);
  check('--u-text-muted', '--u-bg', 'muted', 4.5);
  check('--u-accent', '--u-bg', 'accent', 3);
  return out;
}

/** The body text check alone (WCAG AA 4.5:1, text on background): null when it passes. */
export function bodyTextContrast(theme: Theme): ContrastWarning | null {
  return contrastWarnings(theme).find((w) => w.id === 'body') ?? null;
}

const THEME_CACHE_KEY = 'nova.theme';
const THEME_CHOICES: readonly ThemeChoice[] = [
  'system',
  'light',
  'dark',
  'high-contrast-light',
  'high-contrast-dark',
];

/** The last theme, cached per device so first paint matches before settings load. */
export function readCachedTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_CACHE_KEY);
    return v && (THEME_CHOICES as readonly string[]).includes(v) ? (v as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

export function writeCachedTheme(t: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, t);
  } catch {
    // private mode or blocked storage: the theme still applies for this session
  }
}

const LOOK_CACHE_KEY = 'nova.look';

/**
 * The whole look last applied (the base or saved theme with the color overrides, fonts, size and
 * motion), cached per device with the OS darkness it was resolved for, so the first paint before
 * settings load matches it, a saved theme included.
 */
export function writeCachedLook(look: ResolvedAppearance, prefersDark: boolean): void {
  try {
    window.localStorage.setItem(LOOK_CACHE_KEY, JSON.stringify({ dark: prefersDark, look }));
  } catch {
    // private mode or blocked storage: first paint uses the cached base theme
  }
}

/** Mirrors the font-stack rule of the settings (a cached value is checked again before use). */
const FONT_STACK = /^[\w\s,'"-]{1,200}$/;

const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string');

/** The cached look, or null when there is none, it is malformed, or the OS darkness changed. */
export function readCachedLook(prefersDark: boolean): ResolvedAppearance | null {
  try {
    const raw = window.localStorage.getItem(LOOK_CACHE_KEY);
    if (!raw) return null;
    const { dark, look } = JSON.parse(raw) as {
      dark?: unknown;
      look?: Partial<ResolvedAppearance>;
    };
    if (dark !== prefersDark || !look?.theme || !isStringMap(look.theme.tokens)) return null;
    const tokens = Object.fromEntries(
      Object.entries(look.theme.tokens).filter(([k]) => k.startsWith('--u-')),
    );
    const fonts = look.fonts ?? { '--u-font-ui': null, '--u-font-code': null };
    const font = (v: unknown) => (typeof v === 'string' && FONT_STACK.test(v) ? v : null);
    return {
      theme: { ...look.theme, tokens },
      fonts: {
        '--u-font-ui': font(fonts['--u-font-ui']),
        '--u-font-code': font(fonts['--u-font-code']),
      },
      fontScale:
        typeof look.fontScale === 'number' && look.fontScale >= 0.75 && look.fontScale <= 2
          ? look.fontScale
          : 1,
      motion: look.motion === 'reduce' || look.motion === 'full' ? look.motion : null,
    };
  } catch {
    return null;
  }
}

/** The opposite variant, for the "Toggle theme" command. */
export function toggledTheme(current: ThemeChoice, prefersDark: boolean): ThemeChoice {
  if (current === 'high-contrast-dark') return 'high-contrast-light';
  if (current === 'high-contrast-light') return 'high-contrast-dark';
  return resolveTheme(current, prefersDark).variant === 'dark' ? 'light' : 'dark';
}
