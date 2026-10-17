// Theme files and links (FR-011, docs/14 §2.2, contracts/schemas/theme.json). A theme is checked
// against the schema before it is kept; color tokens that are not known color roles, or whose
// values are not hex colors, are dropped (unknown tokens are ignored, missing ones fall back to
// the base theme), and fonts must be plain font lists so a value can never escape its property.
// Links carry the theme as base64url JSON: nova://theme?data=<data>.
import {
  BUILTIN_THEMES,
  COLOR_TOKENS,
  dark,
  isColor,
  light,
  mergeTheme,
  resolveTheme,
  type Theme,
} from '@nova/ui';
import { contrastWarnings, type ContrastWarning } from '../appearance.ts';

export const THEME_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const FONT_STACK = /^[\w\s,'"-]+$/;
const FONT_KEYS = ['--u-font-ui', '--u-font-code'];
const FIELDS = new Set(['schemaVersion', 'id', 'name', 'variant', 'extends', 'tokens', 'fonts']);
/** Longest theme JSON accepted, and the longest link data (base64 of that). */
export const THEME_MAX_CHARS = 32_000;
export const THEME_DATA_MAX = 44_000;

export type ThemeCheck =
  { ok: true; theme: Theme; ignored: string[] } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate a parsed theme file; the result keeps only what Nova applies. */
export function checkTheme(value: unknown): ThemeCheck {
  if (!isRecord(value)) return { ok: false, errors: ['A theme is a JSON object.'] };
  const errors: string[] = [];
  const ignored: string[] = [];
  for (const k of Object.keys(value)) if (!FIELDS.has(k)) errors.push(`Unknown field “${k}”.`);
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  const id = value.id;
  if (typeof id !== 'string' || !THEME_ID.test(id))
    errors.push('id must be lowercase words joined by dots, like com.example.midnight.');
  const name = value.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 100)
    errors.push('name must be 1 to 100 characters.');
  const variant = value.variant;
  if (variant !== 'light' && variant !== 'dark' && variant !== 'system')
    errors.push('variant must be light, dark or system.');
  if (value.extends !== undefined && typeof value.extends !== 'string')
    errors.push('extends must be the id of a built-in theme.');

  const tokens: Record<string, string> = {};
  if (!isRecord(value.tokens)) errors.push('tokens must be an object of CSS variables.');
  else
    for (const [k, v] of Object.entries(value.tokens)) {
      if (!k.startsWith('--u-')) errors.push(`Token “${k}” must start with --u-.`);
      else if (typeof v !== 'string') errors.push(`Token ${k} must be a string.`);
      else if ((COLOR_TOKENS as readonly string[]).includes(k) && isColor(v))
        tokens[k] = v.toLowerCase();
      else ignored.push(k);
    }

  const fonts: Record<string, string> = {};
  if (value.fonts !== undefined) {
    if (!isRecord(value.fonts)) errors.push('fonts must be an object.');
    else
      for (const [k, v] of Object.entries(value.fonts)) {
        if (!k.startsWith('--u-font-')) errors.push(`Font “${k}” must start with --u-font-.`);
        else if (typeof v !== 'string') errors.push(`Font ${k} must be a string.`);
        else if (FONT_KEYS.includes(k) && v.length <= 200 && FONT_STACK.test(v.trim()))
          fonts[k] = v.trim();
        else ignored.push(k);
      }
  }
  if (errors.length) return { ok: false, errors };

  const base = typeof value.extends === 'string' ? builtinById(value.extends) : null;
  if (typeof value.extends === 'string' && !base) ignored.push('extends');
  const theme: Theme = {
    schemaVersion: 1,
    id: id as string,
    name: (name as string).trim(),
    variant: variant as Theme['variant'],
    ...(base ? { extends: base.id } : {}),
    tokens,
    ...(Object.keys(fonts).length ? { fonts } : {}),
  };
  return { ok: true, theme, ignored };
}

function builtinById(id: string): Theme | null {
  return BUILTIN_THEMES.find((t) => t.id === id || t.id === `nova.${id}`) ?? null;
}

/** The theme as it would look: its tokens over its base (or the variant's built-in). */
export function resolveCustom(theme: Theme, prefersDark: boolean): Theme {
  const base =
    (theme.extends ? builtinById(theme.extends) : null) ??
    (theme.variant === 'light'
      ? light
      : theme.variant === 'dark'
        ? dark
        : prefersDark
          ? dark
          : light);
  return mergeTheme(theme, base);
}

export function themeContrast(theme: Theme, prefersDark: boolean): ContrastWarning[] {
  return contrastWarnings(resolveCustom(theme, prefersDark));
}

export function themeJson(theme: Theme): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}

function toBase64Url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string | null {
  // A `+` may have arrived as a space through a query string.
  const std = data.trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(std)) return null;
  try {
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Link data for a theme: base64url of its JSON. */
export function themeData(theme: Theme): string {
  return toBase64Url(JSON.stringify(theme));
}

export function themeLink(theme: Theme): string {
  return `nova://theme?data=${themeData(theme)}`;
}

/** Parse pasted text: theme JSON, a nova:// or web+nova:// theme link, or bare link data. */
export function readTheme(text: string): ThemeCheck {
  const t = text.trim();
  if (!t) return { ok: false, errors: ['Paste a theme link or theme JSON.'] };
  let json: string | null = t;
  if (!t.startsWith('{')) {
    let data = t;
    if (/^(web\+)?nova:/i.test(t)) {
      const q = t.indexOf('?');
      const head = t.slice(0, q < 0 ? undefined : q).replace(/^(web\+)?nova:\/*/i, '');
      if (head.replace(/\/+$/, '').toLowerCase() !== 'theme' || q < 0)
        return { ok: false, errors: ['That link is not a theme link.'] };
      data = new URLSearchParams(t.slice(q + 1)).get('data') ?? '';
    }
    if (!data || data.length > THEME_DATA_MAX)
      return { ok: false, errors: ['That link does not contain a theme.'] };
    json = fromBase64Url(data);
    if (json === null) return { ok: false, errors: ['That link does not contain a theme.'] };
  }
  if (json.length > THEME_MAX_CHARS) return { ok: false, errors: ['That theme is too large.'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, errors: ['That is not valid JSON.'] };
  }
  return checkTheme(parsed);
}

/** A theme id from a display name: `user.<slug>`. */
export function themeIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `user.${slug || 'theme'}`;
}

/** The current appearance as a theme file. */
export function exportTheme(
  effective: Theme,
  fonts: Record<string, string | null>,
  name: string,
  baseId: string,
): Theme {
  const tokens: Record<string, string> = {};
  for (const k of COLOR_TOKENS) {
    const v = effective.tokens[k];
    if (v && isColor(v)) tokens[k] = v;
  }
  const f: Record<string, string> = {};
  for (const [k, v] of Object.entries(fonts)) if (v && FONT_KEYS.includes(k)) f[k] = v;
  const n = name.trim() || 'My theme';
  return {
    schemaVersion: 1,
    id: themeIdFor(n),
    name: n,
    variant: effective.variant === 'light' ? 'light' : 'dark',
    extends: baseId,
    tokens,
    ...(Object.keys(f).length ? { fonts: f } : {}),
  };
}

/** Stored custom themes that still pass the check (a bad row is skipped, never applied). */
export function storedThemes(list: readonly Record<string, unknown>[]): Theme[] {
  const out: Theme[] = [];
  for (const raw of list) {
    const c = checkTheme(raw);
    if (c.ok) out.push(c.theme);
  }
  return out;
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * Appearance settings that make a custom theme the current look: its base, and its background,
 * text and accent colors and fonts as overrides where they differ from the base (the other
 * tokens derive from them, FR-010).
 */
export function themeSettings(
  theme: Theme,
  prefersDark: boolean,
): {
  base: 'system' | 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';
  accent: string | null;
  background: string | null;
  foreground: string | null;
  uiFont: string | null;
  codeFont: string | null;
} {
  const ext = theme.extends ? builtinById(theme.extends) : null;
  const base = ext
    ? (ext.id.replace(/^nova\./, '') as
        'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark')
    : theme.variant;
  const baseTokens = resolveTheme(base, prefersDark).tokens;
  const hex = (k: string) => {
    const v = theme.tokens[k]?.toLowerCase();
    return v && HEX6.test(v) && v !== baseTokens[k]?.toLowerCase() ? v : null;
  };
  return {
    base,
    accent: hex('--u-accent'),
    background: hex('--u-bg'),
    foreground: hex('--u-text'),
    uiFont: theme.fonts?.['--u-font-ui'] ?? null,
    codeFont: theme.fonts?.['--u-font-code'] ?? null,
  };
}
