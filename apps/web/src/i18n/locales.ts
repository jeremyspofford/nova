// The interface languages (FR-016, D9) and how the `appearance.locale` setting picks one. Each
// language is listed by its own name (an autonym, never translated); Arabic is a partial draft
// that falls back to English, and the two pseudo-locales are for testing.
import { LOCALE_TAGS, type LocaleTag } from '@nova/shared';
import { defineMessages } from '@nova/i18n';

export const SOURCE_LOCALE: LocaleTag = 'en';

export interface LocaleInfo {
  tag: LocaleTag;
  /** The language's own name, shown as is in every locale. */
  name: string;
  /** Only part of the interface is translated; the rest shows in English. */
  partial?: boolean;
  /** A pseudo-locale for testing, never chosen for "system". */
  testing?: boolean;
}

export const LOCALES: readonly LocaleInfo[] = [
  { tag: 'en', name: 'English' },
  { tag: 'ar', name: 'العربية', partial: true },
  { tag: 'en-XA', name: 'Ëñĝļîšĥ (en-XA)', testing: true },
  { tag: 'ar-XB', name: 'Ŕîĝĥţ-ţö-ļéƒţ (ar-XB)', testing: true },
];

export const LANGUAGE_TEXT = defineMessages('i18n.language', {
  label: 'Language',
  hint: 'The language of menus, buttons and messages. Hub messages stay in English for now.',
  system: 'System ({name})',
  partial: '{name} (partly translated)',
  testing: 'For testing',
  saveFailed: 'Could not change the language: {reason}',
  /** Said in the new language once the shell has switched; `name` is its own name. */
  changed: 'Language changed to {name}.',
});

export function isLocaleTag(tag: string): tag is LocaleTag {
  return (LOCALE_TAGS as readonly string[]).includes(tag);
}

export function localeInfo(tag: string): LocaleInfo | undefined {
  return LOCALES.find((l) => l.tag === tag);
}

/** The device's preferred languages, most preferred first. */
export function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * The locale a preference selects: a supported tag as is; `system` (or anything unknown) is the
 * first of the device's languages Nova has, matched exactly or by base language, else English.
 * Pseudo-locales are never picked for `system`.
 */
export function resolveLocale(preference: string, languages: readonly string[]): LocaleTag {
  if (preference !== 'system' && isLocaleTag(preference)) return preference;
  const real = LOCALES.filter((l) => !l.testing);
  for (const lang of languages) {
    const lower = lang.toLowerCase();
    const exact = real.find((l) => l.tag.toLowerCase() === lower);
    if (exact) return exact.tag;
    const base = real.find((l) => l.tag === lower.split('-')[0]);
    if (base) return base.tag;
  }
  return SOURCE_LOCALE;
}
