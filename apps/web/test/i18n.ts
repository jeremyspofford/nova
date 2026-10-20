// Localization test helpers (FR-016, D9). `renderInLocale` renders a screen in a locale (usually
// the pseudo-locale `en-XA`); `expectFullyLocalized` then fails on any visible text or accessible
// name that did not come through messages, listing each offender. Fixture data (titles, names the
// fakes return) is passed as `data`; numbers, URLs, `ext:`/`mcp:`-style ids, the product name,
// `<kbd>`/`<code>`/`<pre>`, single-letter key caps and anything under `translate="no"` are
// allowed. The checks live in @nova/i18n/testing, shared with packages/ui.
import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { expect, onTestFinished } from 'vitest';
import { loadLocale, localeDirection, setLocale } from '@nova/i18n';
import { findUnlocalized, type LocalizedOptions } from '@nova/i18n/testing';
import { pinLocale } from '../src/i18n/I18nProvider.tsx';

/** Make `locale` active (catalogs loaded, `<html lang dir>` set) until the test ends. */
export async function activateTestLocale(locale: string): Promise<void> {
  await loadLocale(locale);
  setLocale(locale);
  pinLocale(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDirection(locale);
  onTestFinished(resetTestLocale);
}

/** Back to English (what every other test expects). */
export function resetTestLocale(): void {
  pinLocale(null);
  setLocale('en');
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  try {
    window.localStorage.removeItem('nova.locale');
  } catch {
    // storage unavailable
  }
}

/**
 * Render `ui` in `locale`: works for a single component (messages read the active locale) and for
 * the whole `<App>` (its provider follows the pinned locale, whatever the setting says).
 */
export async function renderInLocale(
  locale: string,
  ui: ReactElement,
  opts?: Omit<RenderOptions, 'queries'>,
) {
  await activateTestLocale(locale);
  return render(ui, opts);
}

export { findUnlocalized, unlocalizedResidue, type LocalizedOptions } from '@nova/i18n/testing';

/** Fail, listing each offender, unless everything under `container` is localized. */
export function expectFullyLocalized(container: Element, opts: LocalizedOptions = {}): void {
  const misses = findUnlocalized(container, opts);
  expect(misses, `Not localized:\n  - ${misses.join('\n  - ')}`).toEqual([]);
}
