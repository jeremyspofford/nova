// Appearance (FR-010, FR-015): resolve the theme setting and the user's color, font, size and
// motion overrides into token values, then apply them to the document root. Overrides only
// change token values, so every component follows them live.
import {
  applyTheme,
  contrastRatio,
  isColor,
  mixHex,
  readableOn,
  resolveTheme,
  type Theme,
  type ThemeChoice,
} from '@nova/ui';

export interface AppearanceSettings {
  theme: ThemeChoice;
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

export function resolveAppearance(s: AppearanceSettings, prefersDark: boolean): ResolvedAppearance {
  const base = resolveTheme(s.theme, prefersDark);
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
    fonts: { '--u-font-ui': s.uiFont || null, '--u-font-code': s.codeFont || null },
    fontScale: s.fontScale,
    motion: s.reducedMotion === 'on' ? 'reduce' : s.reducedMotion === 'off' ? 'full' : null,
  };
}

export function applyAppearance(a: ResolvedAppearance, el: HTMLElement): void {
  applyTheme(a.theme, el);
  for (const [k, v] of Object.entries(a.fonts)) {
    if (v) el.style.setProperty(k, v);
    else el.style.removeProperty(k);
  }
  el.style.setProperty('--u-font-scale', String(a.fontScale));
  if (a.motion) el.dataset.motion = a.motion;
  else delete el.dataset.motion;
}

export interface ContrastWarning {
  pair: string;
  ratio: number;
  minimum: number;
}

/** WCAG 2.2 AA checks for the effective colors (docs/04 §4.4). */
export function contrastWarnings(theme: Theme): ContrastWarning[] {
  const t = theme.tokens;
  const out: ContrastWarning[] = [];
  const check = (fg: string, bg: string, pair: string, minimum: number) => {
    const a = t[fg];
    const b = t[bg];
    if (!a || !b) return;
    const ratio = contrastRatio(a, b);
    if (ratio < minimum) out.push({ pair, ratio, minimum });
  };
  check('--u-text', '--u-bg', 'Text on background', 4.5);
  check('--u-text-muted', '--u-bg', 'Secondary text on background', 4.5);
  check('--u-accent', '--u-bg', 'Accent on background', 3);
  return out;
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

/** The opposite variant, for the "Toggle theme" command. */
export function toggledTheme(current: ThemeChoice, prefersDark: boolean): ThemeChoice {
  if (current === 'high-contrast-dark') return 'high-contrast-light';
  if (current === 'high-contrast-light') return 'high-contrast-dark';
  return resolveTheme(current, prefersDark).variant === 'dark' ? 'light' : 'dark';
}
