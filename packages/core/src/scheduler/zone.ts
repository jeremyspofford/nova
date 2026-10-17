// Wall-clock time in an IANA time zone with Intl only (docs/09 §6, FR-055; no tz dependency).
// Local times are handled as "naive" epoch milliseconds: the UTC reading of the wall-clock fields,
// so calendar arithmetic is plain Date.UTC math. Resolving a local time to an instant follows the
// schedule rules: a local time that does not exist (the spring-forward gap) resolves to the next
// valid instant, the end of the gap; a repeated local time (the fall-back fold) resolves to its
// first occurrence, so it fires once.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const OFFSET = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/;

const formats = new Map<string, Intl.DateTimeFormat>();
/** Day number → the zone's offset when it is constant around that local day, else null. */
const dayOffsets = new Map<string, number | null>();
const MAX_CACHED_DAYS = 20_000;

/** An IANA zone name Intl knows ("Europe/London", "UTC"); fixed offsets like "+05:00" are not. */
export function isTimeZone(tz: string): boolean {
  if (tz.length > 100 || !IANA_NAME.test(tz)) return false;
  try {
    formatFor(tz);
    return true;
  } catch {
    return false;
  }
}

function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
      year: 'numeric',
    });
    formats.set(tz, f);
  }
  return f;
}

/** The zone's UTC offset at an instant, in milliseconds (local minus UTC). */
export function offsetAt(tz: string, instant: number): number {
  const part = formatFor(tz)
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = OFFSET.exec(part ?? '');
  if (!m) throw new RangeError(`unexpected offset "${part ?? ''}" for ${tz}`);
  if (!m[1]) return 0;
  const ms = Number(m[2]) * HOUR + Number(m[3] ?? 0) * MINUTE + Number(m[4] ?? 0) * SECOND;
  return m[1] === '-' ? -ms : ms;
}

/** The wall-clock reading of an instant, as naive milliseconds. */
export function naiveOf(tz: string, instant: number): number {
  return instant + offsetAt(tz, instant);
}

/**
 * The instant a local wall-clock time stands for: the only one, the first of two in a fold, or
 * the end of the gap when the local time does not exist.
 */
export function resolveLocal(tz: string, naive: number): number {
  const day = Math.floor(naive / DAY);
  const key = `${tz}|${day}`;
  let constant = dayOffsets.get(key);
  if (constant === undefined) {
    // Any instant a local time of this day can map to lies within a day of it (offsets stay
    // under 15 hours), so equal offsets on both sides and in the middle mean no transition.
    const start = day * DAY;
    const a = offsetAt(tz, start - DAY);
    const b = offsetAt(tz, start + DAY / 2);
    const c = offsetAt(tz, start + 2 * DAY);
    constant = a === b && b === c ? a : null;
    if (dayOffsets.size >= MAX_CACHED_DAYS) dayOffsets.clear();
    dayOffsets.set(key, constant);
  }
  if (constant !== null) return naive - constant;
  const before = offsetAt(tz, naive - DAY);
  const after = offsetAt(tz, naive + DAY);
  const valid = [...new Set([before, after])]
    .map((o) => naive - o)
    .filter((inst) => naiveOf(tz, inst) === naive)
    .sort((x, y) => x - y);
  if (valid.length) return valid[0]!;
  // A gap: the local time was skipped. The transition lies between the reading with the later
  // offset (before the change) and the one with the earlier offset (after it).
  let lo = Math.min(naive - before, naive - after);
  let hi = Math.max(naive - before, naive - after);
  const target = offsetAt(tz, hi);
  while (hi - lo > SECOND) {
    const mid = lo + Math.floor((hi - lo) / 2 / SECOND) * SECOND;
    if (mid <= lo) break;
    if (offsetAt(tz, mid) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Calendar fields of a naive time (month 1-12, weekday 0 = Sunday). */
export interface LocalFields {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  wd: number;
}

export function fieldsOf(naive: number): LocalFields {
  const t = new Date(naive);
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    s: t.getUTCSeconds(),
    wd: t.getUTCDay(),
  };
}

/** Days since the epoch of a calendar date (month 1-12). */
export function dayIndex(y: number, mo: number, d: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d) / DAY);
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Weekday of a day index, 0 = Sunday. */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}
