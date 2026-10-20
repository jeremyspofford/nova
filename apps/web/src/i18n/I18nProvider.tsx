// The active interface language (FR-016, D9). `LocaleProvider` sits at the root of the app: it
// resolves the preference (the `appearance.locale` setting once signed in, before that the last
// one this device used, else `system`), loads that locale's catalogs lazily, makes it active in
// @nova/i18n and sets `<html lang dir>`. Components read messages at render time; the signed-in
// shell remounts under the locale key so every message re-reads (drafts that matter persist).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  getLocale,
  loadLocale,
  localeDirection,
  setCatalogLoader,
  setLocale,
  subscribe,
  type CatalogEntries,
  type Direction,
} from '@nova/i18n';
import { useSetting } from '../settings.tsx';
import { deviceLanguages, resolveLocale } from './locales.ts';

// ---- catalogs: one lazy chunk per locale and namespace -----------------------------------------

// No type argument on the call: Vitest's module cache skips files containing the exact text
// `import.meta.glob(`, and a cached transform would miss catalogs added later.
const CATALOG_FILES = import.meta.glob('./locales/*/*.json', { import: 'default' }) as Record<
  string,
  () => Promise<CatalogEntries>
>;

export async function loadCatalogFiles(
  locale: string,
): Promise<Array<{ namespace: string; entries: CatalogEntries }>> {
  const prefix = `./locales/${locale}/`;
  const files = Object.entries(CATALOG_FILES).filter(([path]) => path.startsWith(prefix));
  return Promise.all(
    files.map(async ([path, load]) => ({
      namespace: path.slice(prefix.length, -'.json'.length),
      entries: await load(),
    })),
  );
}

setCatalogLoader(loadCatalogFiles);

// ---- a pinned locale (tests, screenshots) --------------------------------------------------------

let pinned: string | null = null;
const pinListeners = new Set<() => void>();

/**
 * Pin the interface to `tag` whatever the setting says (null unpins). For tests and screenshot
 * runs; the pinned locale is never remembered.
 */
export function pinLocale(tag: string | null): void {
  pinned = tag;
  for (const fn of [...pinListeners]) fn();
}

const subscribePin = (fn: () => void) => {
  pinListeners.add(fn);
  return () => {
    pinListeners.delete(fn);
  };
};
const getPinned = () => pinned;

// ---- the remembered preference --------------------------------------------------------------------

const CACHE_KEY = 'nova.locale';

function readCachedPreference(): string | null {
  try {
    return window.localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
}

function writeCachedPreference(value: string): void {
  try {
    if (value === 'system') window.localStorage.removeItem(CACHE_KEY);
    else window.localStorage.setItem(CACHE_KEY, value);
  } catch {
    // storage unavailable: the next start uses the system language until settings load
  }
}

// ---- provider --------------------------------------------------------------------------------------

export interface LocaleState {
  /** The active locale tag. */
  locale: string;
  direction: Direction;
  /** The preference it came from: `system` or a tag. */
  preference: string;
}

interface LocaleControl extends LocaleState {
  setPreference: (preference: string) => void;
}

const Ctx = createContext<LocaleControl | null>(null);

function applyDocument(locale: string): void {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = localeDirection(locale);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(() => readCachedPreference() ?? 'system');
  const pin = useSyncExternalStore(subscribePin, getPinned);
  const wanted = pin ?? resolveLocale(preference, deviceLanguages());
  const active = useSyncExternalStore(subscribe, getLocale);
  // Until the wanted locale is active once, render nothing rather than flash another language;
  // after that, a switch keeps showing the current language while the next one loads.
  const [shown, setShown] = useState(() => getLocale() === wanted);
  if (!shown && active === wanted) setShown(true);
  const ready = shown || active === wanted;

  useLayoutEffect(() => {
    let alive = true;
    const activate = () => {
      if (alive) setLocale(wanted);
    };
    // English and the pseudo-locales need no catalog: switch before paint.
    if (wanted === 'en' || wanted === 'en-XA' || wanted === 'ar-XB') activate();
    else loadLocale(wanted).then(activate, activate);
    return () => {
      alive = false;
    };
  }, [wanted]);

  useLayoutEffect(() => applyDocument(active), [active]);

  const setPreference = useCallback((p: string) => {
    setPreferenceState(p);
    writeCachedPreference(p);
  }, []);

  const value = useMemo<LocaleControl>(
    () => ({ locale: active, direction: localeDirection(active), preference, setPreference }),
    [active, preference, setPreference],
  );
  return <Ctx.Provider value={value}>{ready ? children : null}</Ctx.Provider>;
}

/** The active locale, its direction and the preference; re-renders when the locale changes. */
export function useLocale(): LocaleState {
  const c = useContext(Ctx);
  const active = useSyncExternalStore(subscribe, getLocale);
  return c ?? { locale: active, direction: localeDirection(active), preference: 'system' };
}

/** Inside the settings store: follows `appearance.locale` (renders nothing). */
export function LocaleFromSettings() {
  const preference = useSetting('appearance.locale').value;
  const c = useContext(Ctx);
  const setPreference = c?.setPreference;
  useEffect(() => {
    setPreference?.(preference);
  }, [preference, setPreference]);
  return null;
}
