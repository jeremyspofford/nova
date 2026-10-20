// Theme files and links (FR-011, docs/14 §2.2, contracts/schemas/theme.json). A theme is checked
// against the schema before it is kept. It keeps the tokens a theme may set (the color roles as
// hex colors, the radii) and its two fonts, each a plain CSS value by the marketplace's and the
// SDK's rule, so a value can never escape its property; anything else is ignored, and missing
// tokens fall back to the base theme. Links carry the theme as base64url JSON:
// nova://theme?data=<data>. Messages (FR-016): the checks' words read in the active locale.
import { defineMessages } from '@nova/i18n';
import { THEME_ID } from '@nova/shared';
import { THEME_FONTS, THEME_TOKENS, isColor, type Theme, type ThemeChoice } from '@nova/ui';
import {
  builtinTheme,
  contrastWarnings,
  customLook,
  themeFontOk,
  themeValueOk,
  type ContrastWarning,
} from '../appearance.ts';

export const THEME_FILE_TEXT = defineMessages('settings.themeFile', {
  notObject: 'A theme is a JSON object.',
  unknownField: 'Unknown field “{field}”.',
  schemaVersion: 'schemaVersion must be 1.',
  id: 'id must be lowercase words joined by dots, like com.example.midnight.',
  name: 'name must be 1 to 100 characters.',
  variant: 'variant must be light, dark or system.',
  extends: 'extends must be the id of a built-in theme.',
  tokens: 'tokens must be an object of CSS variables.',
  tokenPrefix: 'Token “{token}” must start with --u-.',
  tokenString: 'Token {token} must be a string.',
  fonts: 'fonts must be an object.',
  fontPrefix: 'Font “{font}” must start with --u-font-.',
  fontString: 'Font {font} must be a string.',
  pasteSomething: 'Paste a theme link or theme JSON.',
  notThemeLink: 'That link is not a theme link.',
  noTheme: 'That link does not contain a theme.',
  tooLarge: 'That theme is too large.',
  notJson: 'That is not valid JSON.',
  defaultName: 'My theme',
});
const S = THEME_FILE_TEXT;

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
  if (!isRecord(value)) return { ok: false, errors: [S.notObject] };
  const errors: string[] = [];
  const ignored: string[] = [];
  for (const k of Object.keys(value)) if (!FIELDS.has(k)) errors.push(S.unknownField({ field: k }));
  if (value.schemaVersion !== 1) errors.push(S.schemaVersion);
  const id = value.id;
  if (typeof id !== 'string' || !THEME_ID.test(id)) errors.push(S.id);
  const name = value.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) errors.push(S.name);
  const variant = value.variant;
  if (variant !== 'light' && variant !== 'dark' && variant !== 'system') errors.push(S.variant);
  if (value.extends !== undefined && typeof value.extends !== 'string') errors.push(S.extends);

  const tokens: Record<string, string> = {};
  if (!isRecord(value.tokens)) errors.push(S.tokens);
  else
    for (const [k, v] of Object.entries(value.tokens)) {
      if (!k.startsWith('--u-')) errors.push(S.tokenPrefix({ token: k }));
      else if (typeof v !== 'string') errors.push(S.tokenString({ token: k }));
      else if (themeValueOk(k, v.trim()))
        tokens[k] = isColor(v.trim()) ? v.trim().toLowerCase() : v.trim();
      else ignored.push(k);
    }

  const fonts: Record<string, string> = {};
  if (value.fonts !== undefined) {
    if (!isRecord(value.fonts)) errors.push(S.fonts);
    else
      for (const [k, v] of Object.entries(value.fonts)) {
        if (!k.startsWith('--u-font-')) errors.push(S.fontPrefix({ font: k }));
        else if (typeof v !== 'string') errors.push(S.fontString({ font: k }));
        else if (themeFontOk(k, v.trim())) fonts[k] = v.trim();
        else ignored.push(k);
      }
  }
  if (errors.length) return { ok: false, errors };

  const base = typeof value.extends === 'string' ? builtinTheme(value.extends) : null;
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

/** Contrast of a custom theme as it would look (its tokens over its base). */
export function themeContrast(theme: Theme, prefersDark: boolean): ContrastWarning[] {
  return contrastWarnings(customLook(theme, prefersDark));
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
  if (!t) return { ok: false, errors: [S.pasteSomething] };
  let json: string | null = t;
  if (!t.startsWith('{')) {
    let data = t;
    if (/^(web\+)?nova:/i.test(t)) {
      const q = t.indexOf('?');
      const head = t.slice(0, q < 0 ? undefined : q).replace(/^(web\+)?nova:\/*/i, '');
      if (head.replace(/\/+$/, '').toLowerCase() !== 'theme' || q < 0)
        return { ok: false, errors: [S.notThemeLink] };
      data = new URLSearchParams(t.slice(q + 1)).get('data') ?? '';
    }
    if (!data || data.length > THEME_DATA_MAX) return { ok: false, errors: [S.noTheme] };
    json = fromBase64Url(data);
    if (json === null) return { ok: false, errors: [S.noTheme] };
  }
  if (json.length > THEME_MAX_CHARS) return { ok: false, errors: [S.tooLarge] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, errors: [S.notJson] };
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
  for (const k of THEME_TOKENS) {
    const v = effective.tokens[k];
    if (themeValueOk(k, v)) tokens[k] = v;
  }
  const f: Record<string, string> = {};
  for (const k of THEME_FONTS) {
    const v = fonts[k];
    if (themeFontOk(k, v)) f[k] = v;
  }
  const n = name.trim() || S.defaultName;
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

/** The saved theme with this id, if it is still saved and still passes the check. */
export function savedTheme(
  id: string | null,
  list: readonly Record<string, unknown>[],
): Theme | null {
  if (!id) return null;
  return storedThemes(list.filter((t) => t.id === id))[0] ?? null;
}

/**
 * The base theme setting a custom theme builds on: the built-in it extends, else its variant
 * (`appearance.theme`, so falling back from the saved theme lands on its base, FR-011).
 */
export function themeBase(theme: Theme): ThemeChoice {
  const ext = theme.extends ? builtinTheme(theme.extends) : null;
  return ext ? (ext.id.replace(/^nova\./, '') as ThemeChoice) : theme.variant;
}
