// The appearance settings as one value (FR-010, FR-011), and the effect that applies them to the
// document root. The shell applies them once (useApplyAppearance); Settings → Appearance reads the
// same value to preview, check and export the look. A saved theme in use (`appearance.customTheme`)
// replaces the base theme while it is saved; an id no longer saved falls back to the base.
import { useEffect } from 'react';
import {
  applyAppearance,
  resolveAppearance,
  writeCachedLook,
  writeCachedTheme,
} from './appearance.ts';
import type { AppearanceSettings } from './appearance.ts';
import { savedTheme } from './settings/theme-file.ts';
import { useSettings, type SettingValue, type SettingsStore } from './settings.tsx';

export function useAppearanceSettings(): AppearanceSettings {
  const settings = useSettings();
  return {
    theme: settings.get('appearance.theme').value,
    custom: savedTheme(
      settings.get('appearance.customTheme').value,
      settings.get('appearance.customThemes').value,
    ),
    accent: settings.get('appearance.accent').value,
    background: settings.get('appearance.background').value,
    foreground: settings.get('appearance.foreground').value,
    uiFont: settings.get('appearance.uiFont').value,
    codeFont: settings.get('appearance.codeFont').value,
    fontScale: settings.get('appearance.fontScale').value,
    reducedMotion: settings.get('appearance.reducedMotion').value,
  };
}

/** Apply the appearance settings to the document root whenever they change; returns them. */
export function useApplyAppearance(prefersDark: boolean): AppearanceSettings {
  const appearance = useAppearanceSettings();
  // A string key, because the object changes identity on every render.
  const key = JSON.stringify(appearance);
  useEffect(() => {
    const a = JSON.parse(key) as AppearanceSettings;
    const look = resolveAppearance(a, prefersDark);
    applyAppearance(look, document.documentElement);
    writeCachedTheme(a.theme);
    // The whole look too, so the next first paint matches it, a saved theme included.
    writeCachedLook(look, prefersDark);
  }, [key, prefersDark]);
  return appearance;
}

/** The settings that, changed by hand, stop using a saved theme (FR-011). */
export type HandSetKey =
  'appearance.theme' | 'appearance.accent' | 'appearance.background' | 'appearance.foreground';

/**
 * Change the base theme, the accent or a color by hand: the saved theme in use, if any, stops
 * (unless managed policy holds it), so the change shows instead of a palette that hides it.
 */
export async function setLookByHand<K extends HandSetKey>(
  settings: SettingsStore,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const custom = settings.get('appearance.customTheme');
  await settings.set(key, value);
  if (custom.value !== null && !custom.locked) await settings.set('appearance.customTheme', null);
}
