// Formatting in the active locale (D9): never `toLocaleString()` without a locale and never a
// hand-built English plural. English output keeps the compact forms the UI already used
// ("1.5 MB", "2 min 5 s"); other locales use Intl's own words. Under a pseudo-locale the English
// output is transformed like message text, so a value formatted outside `fmt` stands out.
import { getLocale, intlLocale } from './locale.ts';
import { isPseudoLocale, pseudoText } from './pseudo.ts';

export type DateInput = Date | number | string;

function toDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

function finish(locale: string, text: string): string {
  return isPseudoLocale(locale) ? pseudoText(locale, text) : text;
}

function english(locale: string): boolean {
  return intlLocale(locale).split('-')[0] === 'en';
}

const cache = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (v === undefined) {
    v = make();
    cache.set(key, v);
  }
  return v;
}
const numberFormat = (locale: string, opts: Intl.NumberFormatOptions = {}) =>
  cached(`n|${locale}|${JSON.stringify(opts)}`, () => new Intl.NumberFormat(locale, opts));
const dateFormat = (locale: string, opts: Intl.DateTimeFormatOptions) =>
  cached(`d|${locale}|${JSON.stringify(opts)}`, () => new Intl.DateTimeFormat(locale, opts));

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
const BYTE_SYMBOLS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

type DurationUnit = 'hour' | 'minute' | 'second' | 'millisecond';
const DURATION_SYMBOLS: Record<DurationUnit, string> = {
  hour: 'h',
  minute: 'min',
  second: 's',
  millisecond: 'ms',
};

function unit(locale: string, value: number, u: DurationUnit, digits = 0): string {
  const lc = intlLocale(locale);
  if (english(locale)) {
    const n = numberFormat(lc, { maximumFractionDigits: digits }).format(value);
    return `${n} ${DURATION_SYMBOLS[u]}`;
  }
  return numberFormat(lc, {
    style: 'unit',
    unit: u,
    unitDisplay: 'short',
    maximumFractionDigits: digits,
  }).format(value);
}

const RELATIVE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number, number]> = [
  // unit, seconds per unit, use this unit below this many seconds
  ['second', 1, 45],
  ['minute', 60, 45 * 60],
  ['hour', 3600, 22 * 3600],
  ['day', 86_400, 26 * 86_400],
  ['month', 30 * 86_400, 320 * 86_400],
  ['year', 365 * 86_400, Infinity],
];

export const fmt = {
  /** A number with the locale's digits and separators. */
  number(n: number, opts?: Intl.NumberFormatOptions): string {
    const locale = getLocale();
    return finish(locale, numberFormat(intlLocale(locale), opts).format(n));
  },

  /** A ratio as a percentage: `fmt.percent(0.25)` is "25%". */
  percent(ratio: number, opts?: Intl.NumberFormatOptions): string {
    const locale = getLocale();
    const f = numberFormat(intlLocale(locale), {
      style: 'percent',
      maximumFractionDigits: 0,
      ...opts,
    });
    return finish(locale, f.format(ratio));
  },

  /** A size in bytes, base 1024: "512 B", "1.5 KB", "12 MB". */
  bytes(n: number): string {
    const locale = getLocale();
    const lc = intlLocale(locale);
    let v = Math.max(0, n);
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 || v >= 10 ? 0 : 1;
    const text = english(locale)
      ? `${numberFormat(lc, { maximumFractionDigits: digits }).format(v)} ${BYTE_SYMBOLS[i]}`
      : numberFormat(lc, {
          style: 'unit',
          unit: BYTE_UNITS[i],
          unitDisplay: 'short',
          maximumFractionDigits: digits,
        }).format(v);
    return finish(locale, text);
  },

  /** A calendar date; medium style unless `opts` says otherwise. */
  date(d: DateInput, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
    const locale = getLocale();
    return finish(locale, dateFormat(intlLocale(locale), opts).format(toDate(d)));
  },

  /** A time of day; short style unless `opts` says otherwise. */
  time(d: DateInput, opts: Intl.DateTimeFormatOptions = { timeStyle: 'short' }): string {
    const locale = getLocale();
    return finish(locale, dateFormat(intlLocale(locale), opts).format(toDate(d)));
  },

  /** A date and time; medium date and short time unless `opts` says otherwise. */
  dateTime(
    d: DateInput,
    opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  ): string {
    const locale = getLocale();
    return finish(locale, dateFormat(intlLocale(locale), opts).format(toDate(d)));
  },

  /** How long ago or ahead `d` is: "now", "5 minutes ago", "in 2 days", "yesterday". */
  relative(
    d: DateInput,
    opts: { now?: number; style?: Intl.RelativeTimeFormatStyle } = {},
  ): string {
    const locale = getLocale();
    const lc = intlLocale(locale);
    const seconds = (toDate(d).getTime() - (opts.now ?? Date.now())) / 1000;
    const abs = Math.abs(seconds);
    const [u, per] = RELATIVE_STEPS.find(([, , below]) => abs < below) ?? ['year', 31_536_000];
    const f = cached(
      `r|${lc}|${opts.style ?? 'long'}`,
      () => new Intl.RelativeTimeFormat(lc, { numeric: 'auto', style: opts.style ?? 'long' }),
    );
    const value = u === 'second' ? 0 : Math.round(seconds / per);
    return finish(locale, f.format(value, u));
  },

  /** A list joined the locale's way: "a, b, and c". */
  list(
    items: readonly string[],
    opts: { type?: Intl.ListFormatType; style?: Intl.ListFormatStyle } = {},
  ): string {
    const locale = getLocale();
    const lc = intlLocale(locale);
    const f = cached(
      `l|${lc}|${opts.type ?? 'conjunction'}|${opts.style ?? 'long'}`,
      () =>
        new Intl.ListFormat(lc, { type: opts.type ?? 'conjunction', style: opts.style ?? 'long' }),
    );
    // Items are usually names or already-translated labels; only the joining words change.
    const joined = f.formatToParts(items);
    return joined.map((p) => (p.type === 'literal' ? finish(locale, p.value) : p.value)).join('');
  },

  /** A duration in milliseconds: "450 ms", "1.5 s", "2 min 5 s", "1 h 5 min". */
  duration(ms: number): string {
    const locale = getLocale();
    const v = Math.max(0, ms);
    let text: string;
    if (v < 1000) text = unit(locale, Math.round(v), 'millisecond');
    else if (v < 60_000) text = unit(locale, v / 1000, 'second', v < 10_000 ? 1 : 0);
    else if (v < 3_600_000) {
      const m = Math.floor(v / 60_000);
      const s = Math.round((v % 60_000) / 1000);
      text = s
        ? `${unit(locale, m, 'minute')} ${unit(locale, s, 'second')}`
        : unit(locale, m, 'minute');
    } else {
      const h = Math.floor(v / 3_600_000);
      const m = Math.round((v % 3_600_000) / 60_000);
      text = m
        ? `${unit(locale, h, 'hour')} ${unit(locale, m, 'minute')}`
        : unit(locale, h, 'hour');
    }
    return finish(locale, text);
  },
};
