// The active locale, translation catalogs and message lookup (D9). English is the source and
// lives in code; a catalog adds one locale's translations for one namespace. A message missing
// from the catalog (or one that does not parse) falls back to the English source, formatted with
// English plural rules, so a partial translation never breaks a screen.
import { formatNodes, parseMessage, type MessageNode, type MessageParams } from './icu.ts';
import { isPseudoLocale, pseudoLocalize } from './pseudo.ts';

export const SOURCE_LOCALE = 'en';

export type Direction = 'ltr' | 'rtl';

const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg']);

/** Text direction of a locale, from its (likely) script; `ar-XB` is right to left. */
export function localeDirection(tag: string): Direction {
  if (tag === 'ar-XB') return 'rtl';
  try {
    const script = new Intl.Locale(tag).maximize().script;
    return script && RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

/** The locale Intl formats with: a pseudo-locale formats as English and is transformed after. */
export function intlLocale(tag: string): string {
  return isPseudoLocale(tag) ? SOURCE_LOCALE : tag;
}

// ---- active locale ----------------------------------------------------------------------------

let current = SOURCE_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): string {
  return current;
}

/** Make `tag` the active locale; every message read after this translates into it. */
export function setLocale(tag: string): void {
  let next: string;
  try {
    next = Intl.getCanonicalLocales(tag)[0] ?? SOURCE_LOCALE;
  } catch {
    next = SOURCE_LOCALE;
  }
  if (next === current) return;
  current = next;
  for (const fn of [...listeners]) fn();
}

/** Called after every locale change; returns an unsubscribe function. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- catalogs -----------------------------------------------------------------------------------

/** One locale's translations for one namespace: message key (dotted for nested) → message. */
export type CatalogEntries = Readonly<Record<string, string>>;

const catalogs = new Map<string, Map<string, CatalogEntries>>();

export function registerCatalog(locale: string, namespace: string, entries: CatalogEntries): void {
  let byNs = catalogs.get(locale);
  if (!byNs) {
    byNs = new Map();
    catalogs.set(locale, byNs);
  }
  byNs.set(namespace, { ...(byNs.get(namespace) ?? {}), ...entries });
}

/** Loads a locale's catalogs (for example with a bundler's lazy imports) and returns them. */
export type CatalogLoader = (
  locale: string,
) => Promise<ReadonlyArray<{ namespace: string; entries: CatalogEntries }>>;

let loader: CatalogLoader | null = null;
const loading = new Map<string, Promise<void>>();

export function setCatalogLoader(fn: CatalogLoader | null): void {
  loader = fn;
  loading.clear();
}

/**
 * Load and register a locale's catalogs once (the locale itself and its base language, so `ar-EG`
 * also gets `ar`). The source and pseudo-locales need none. A failed load leaves the locale on the
 * English fallback and can be retried.
 */
export async function loadLocale(locale: string): Promise<void> {
  const tags = catalogTags(locale);
  await Promise.all(
    tags.map((tag) => {
      if (!loader) return Promise.resolve();
      let p = loading.get(tag);
      if (!p) {
        const fn = loader;
        p = fn(tag).then(
          (list) => {
            for (const c of list) registerCatalog(tag, c.namespace, c.entries);
          },
          (err: unknown) => {
            loading.delete(tag);
            throw err;
          },
        );
        loading.set(tag, p);
      }
      return p;
    }),
  );
}

function catalogTags(locale: string): string[] {
  if (locale === SOURCE_LOCALE || isPseudoLocale(locale)) return [];
  const base = locale.split('-')[0] ?? locale;
  return base !== locale && base !== SOURCE_LOCALE ? [locale, base] : [locale];
}

/** Test support: forget every registered catalog and the loader, and return to English. */
export function resetI18n(): void {
  catalogs.clear();
  loading.clear();
  loader = null;
  setLocale(SOURCE_LOCALE);
}

// ---- lookup and formatting ---------------------------------------------------------------------

const parsed = new Map<string, MessageNode[] | null>();
const pseudo = new Map<string, string>();
const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/** Parsed message, cached; null when it does not parse. */
export function parsedMessage(message: string): MessageNode[] | null {
  let nodes = parsed.get(message);
  if (nodes === undefined) {
    try {
      nodes = parseMessage(message);
    } catch {
      nodes = null;
    }
    parsed.set(message, nodes);
  }
  return nodes;
}

const plurals = (locale: string): Intl.PluralRules => {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r;
};

const numbers = (locale: string): Intl.NumberFormat => {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale);
    numberFormats.set(locale, f);
  }
  return f;
};

/** The translation of `namespace`/`key` in `locale` or its base language, if any. */
export function lookupTranslation(locale: string, namespace: string, key: string): string | null {
  for (const tag of catalogTags(locale)) {
    const hit = catalogs.get(tag)?.get(namespace)?.[key];
    if (typeof hit === 'string') return hit;
  }
  return null;
}

/** Format an English source message in English (also the fallback path). */
export function formatSource(source: string, params?: MessageParams): string {
  const nodes = parsedMessage(source);
  if (!nodes) return source;
  return formatNodes(nodes, { locale: SOURCE_LOCALE, params, plurals, number: numbers });
}

/**
 * Translate one message into the active locale (or `locale`): the catalog's translation, the
 * pseudo-locale's transform of the source, or the source itself.
 */
export function translate(
  namespace: string,
  key: string,
  source: string,
  params?: MessageParams,
  locale: string = current,
): string {
  if (locale === SOURCE_LOCALE) return formatSource(source, params);
  if (isPseudoLocale(locale)) {
    const cacheKey = `${locale}:${source}`;
    let message = pseudo.get(cacheKey);
    if (message === undefined) {
      message = pseudoLocalize(source, locale);
      pseudo.set(cacheKey, message);
    }
    const nodes = parsedMessage(message);
    if (!nodes) return formatSource(source, params);
    return formatNodes(nodes, { locale: SOURCE_LOCALE, params, plurals, number: numbers });
  }
  const translated = lookupTranslation(locale, namespace, key);
  const nodes = translated === null ? null : parsedMessage(translated);
  if (!nodes) return formatSource(source, params);
  return formatNodes(nodes, { locale, params, plurals, number: numbers });
}
