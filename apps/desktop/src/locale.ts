// Which language the shell speaks (FR-016): signed in to a Hub, the Hub's `appearance.locale`
// setting, so menus, the tray and notifications match the web UI; otherwise (no Hub, signed out,
// a member whose Hub refuses its settings, or `system`) the operating system's languages, the
// first one Nova has. Pseudo-locales only when the setting names one.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogLoader } from '@nova/i18n';
import { LOCALE_TAGS, type LocaleTag } from '@nova/shared';

const PSEUDO: readonly string[] = ['en-XA', 'ar-XB'];

/** The locale for a Hub setting (or none) and the system's preferred languages. */
export function resolveDesktopLocale(
  hubSetting: string | null | undefined,
  systemLanguages: readonly string[],
): LocaleTag {
  if (
    hubSetting &&
    hubSetting !== 'system' &&
    (LOCALE_TAGS as readonly string[]).includes(hubSetting)
  )
    return hubSetting as LocaleTag;
  const real = LOCALE_TAGS.filter((t) => !PSEUDO.includes(t));
  for (const lang of systemLanguages) {
    const lower = lang.toLowerCase().replace('_', '-');
    const exact = real.find((t) => t.toLowerCase() === lower);
    if (exact) return exact;
    const base = real.find((t) => t === lower.split('-')[0]);
    if (base) return base;
  }
  return 'en';
}

/**
 * The translation catalogs the web app ships (`apps/web/src/i18n/locales/<locale>/<ns>.json`),
 * the one place translations live. Run from source, the shell reads them there.
 */
export const CATALOG_DIR = join(import.meta.dirname, '..', '..', 'web', 'src', 'i18n', 'locales');

/** Load a locale's catalogs from `dir`; a missing folder means no translations (English shows). */
export function catalogDirLoader(dir: string): CatalogLoader {
  return (locale) => {
    const folder = join(dir, locale);
    if (!existsSync(folder)) return Promise.resolve([]);
    try {
      return Promise.resolve(
        readdirSync(folder)
          .filter((f) => f.endsWith('.json'))
          .map((f) => ({
            namespace: f.slice(0, -'.json'.length),
            entries: JSON.parse(readFileSync(join(folder, f), 'utf8')) as Record<string, string>,
          })),
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
