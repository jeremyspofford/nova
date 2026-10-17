// Display modes for MCP Apps (FR-198, docs/04 §2.9): inline (a height-capped card),
// fullscreen (a dialog over the workspace) and picture-in-picture (a floating panel; one at a
// time, so a second one sends the first back inline). Also the host context an app receives:
// the theme tokens of docs/14 §2.1, locale and display mode.

export type DisplayMode = 'inline' | 'fullscreen' | 'pip';
export const DISPLAY_MODES: readonly DisplayMode[] = ['inline', 'fullscreen', 'pip'];

/** Inline frames report their height; it is kept between these bounds. */
export const INLINE_MIN_HEIGHT = 80;
export const INLINE_MAX_HEIGHT = 600;
export const INLINE_DEFAULT_HEIGHT = 320;

export function clampHeight(h: number): number {
  return Math.round(Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, h)));
}

// ---- the one picture-in-picture app ------------------------------------------------------------

let pipOwner: string | null = null;
const listeners = new Set<() => void>();

export function claimPip(key: string): void {
  if (pipOwner === key) return;
  pipOwner = key;
  for (const fn of [...listeners]) fn();
}

export function releasePip(key: string): void {
  if (pipOwner !== key) return;
  pipOwner = null;
  for (const fn of [...listeners]) fn();
}

export function currentPip(): string | null {
  return pipOwner;
}

export function subscribePip(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- host context ----------------------------------------------------------------------------

/** The theme tokens an app may style itself with (docs/14 §2.1). */
export const THEME_TOKENS = [
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
  '--u-radius-sm',
  '--u-radius-md',
  '--u-radius-lg',
  '--u-space-1',
  '--u-space-2',
  '--u-space-3',
  '--u-space-4',
  '--u-space-6',
  '--u-font-ui',
  '--u-font-code',
  '--u-text-xs',
  '--u-text-sm',
  '--u-text-md',
  '--u-text-lg',
] as const;

export function themeVariables(
  root: HTMLElement = document.documentElement,
): Record<string, string> {
  const computed = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const v = (root.style.getPropertyValue(name) || computed.getPropertyValue(name)).trim();
    if (v) out[name] = v;
  }
  return out;
}

export function themeVariant(root: HTMLElement = document.documentElement): 'light' | 'dark' {
  const scheme = root.style.colorScheme;
  if (scheme === 'light' || scheme === 'dark') return scheme;
  const light =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  return light ? 'light' : 'dark';
}
