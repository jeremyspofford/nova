// RFC 5545 recurrence rules, the subset schedules use (FR-055, ADR-079): FREQ MINUTELY..YEARLY,
// INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY (negative counts from the month end), BYDAY (with
// ordinals such as 1MO or -1FR for MONTHLY and YEARLY), BYHOUR, BYMINUTE, BYSECOND and WKST.
// DTSTART is the schedule's start (or its creation), read in the schedule's time zone; parts it
// does not give come from DTSTART, as RFC 5545 says. Like most implementations, DTSTART counts as
// an occurrence only when it matches the rule. Evaluation produces local wall-clock times.
import { NovaError } from '@nova/shared';
import {
  DAY,
  HOUR,
  MINUTE,
  SECOND,
  dayIndex,
  daysInMonth,
  fieldsOf,
  weekdayOf,
  type LocalFields,
} from './zone.ts';

export type Freq = 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
const FREQS: readonly Freq[] = ['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const UNSUPPORTED = new Set(['BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'DTSTART', 'RDATE', 'EXDATE']);

export interface ByDay {
  /** 0 = Sunday. */
  wd: number;
  /** The nth such weekday of the month or year (negative from the end); null = every one. */
  n: number | null;
}

export type Until = { kind: 'instant'; at: number } | { kind: 'local'; naive: number };

export interface RRule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: Until | null;
  byMonth: number[] | null;
  byMonthDay: number[] | null;
  byDay: ByDay[] | null;
  byHour: number[] | null;
  byMinute: number[] | null;
  bySecond: number[] | null;
  /** Week start, 0 = Sunday (default Monday). */
  wkst: number;
}

export const MAX_COUNT = 100_000;

function invalid(message: string): NovaError {
  return new NovaError('validation', `when.rrule: ${message}`, {
    details: { field: 'when.rrule' },
  });
}

export function parseRrule(text: string): RRule {
  const body = text.trim().replace(/^RRULE:/i, '');
  const seen = new Map<string, string>();
  for (const part of body.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) throw invalid(`"${part}" is not NAME=VALUE`);
    const name = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1).trim();
    if (seen.has(name)) throw invalid(`${name} is given twice`);
    if (UNSUPPORTED.has(name)) throw invalid(`${name} is not supported`);
    seen.set(name, val);
  }
  const freqText = seen.get('FREQ')?.toUpperCase();
  if (!freqText) throw invalid('FREQ is required');
  if (freqText === 'SECONDLY')
    throw invalid('FREQ=SECONDLY is not supported (at most once a minute)');
  if (!(FREQS as readonly string[]).includes(freqText)) throw invalid(`unknown FREQ ${freqText}`);
  const freq = freqText as Freq;
  const rule: RRule = {
    freq,
    interval: 1,
    count: null,
    until: null,
    byMonth: null,
    byMonthDay: null,
    byDay: null,
    byHour: null,
    byMinute: null,
    bySecond: null,
    wkst: 1,
  };
  for (const [name, val] of seen) {
    switch (name) {
      case 'FREQ':
        break;
      case 'INTERVAL':
        rule.interval = integer(name, val, 1, 10_000);
        break;
      case 'COUNT':
        rule.count = integer(name, val, 1, MAX_COUNT);
        break;
      case 'UNTIL':
        rule.until = parseUntil(val);
        break;
      case 'BYMONTH':
        rule.byMonth = list(name, val, (v) => integer(name, v, 1, 12));
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = list(name, val, (v) => {
          const n = integer(name, v, -31, 31);
          if (n === 0) throw invalid('BYMONTHDAY cannot be 0');
          return n;
        });
        break;
      case 'BYDAY':
        rule.byDay = byDayList(val, freq);
        break;
      case 'BYHOUR':
        rule.byHour = list(name, val, (v) => integer(name, v, 0, 23));
        break;
      case 'BYMINUTE':
        rule.byMinute = list(name, val, (v) => integer(name, v, 0, 59));
        break;
      case 'BYSECOND':
        rule.bySecond = list(name, val, (v) => integer(name, v, 0, 59));
        break;
      case 'WKST': {
        const wd = WEEKDAYS.indexOf(val.toUpperCase());
        if (wd < 0) throw invalid(`WKST ${val} is not a weekday`);
        rule.wkst = wd;
        break;
      }
      default:
        throw invalid(`unknown part ${name}`);
    }
  }
  if (rule.count !== null && rule.until !== null)
    throw invalid('COUNT and UNTIL cannot both be given');
  if (freq === 'WEEKLY' && rule.byMonthDay) throw invalid('BYMONTHDAY does not apply to WEEKLY');
  return rule;
}

function integer(name: string, text: string, min: number, max: number): number {
  if (!/^[+-]?\d+$/.test(text)) throw invalid(`${name} value "${text}" is not a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw invalid(`${name} value ${n} is out of range ${min}..${max}`);
  return n;
}

function list(name: string, text: string, item: (v: string) => number): number[] {
  if (!text) throw invalid(`${name} is empty`);
  return [...new Set(text.split(',').map((v) => item(v.trim())))].sort((a, b) => a - b);
}

function byDayList(text: string, freq: Freq): ByDay[] {
  if (!text) throw invalid('BYDAY is empty');
  return text.split(',').map((raw) => {
    const m = /^([+-]?\d{1,2})?([A-Za-z]{2})$/.exec(raw.trim());
    const wd = m ? WEEKDAYS.indexOf(m[2]!.toUpperCase()) : -1;
    if (!m || wd < 0) throw invalid(`BYDAY value "${raw}" is not a weekday like MO or -1FR`);
    if (m[1] === undefined) return { wd, n: null };
    const n = Number(m[1]);
    if (freq !== 'MONTHLY' && freq !== 'YEARLY')
      throw invalid(`BYDAY ordinals like ${raw} need FREQ=MONTHLY or YEARLY`);
    const limit = freq === 'MONTHLY' ? 5 : 53;
    if (n === 0 || Math.abs(n) > limit)
      throw invalid(`BYDAY ordinal ${n} is out of range ±1..${limit}`);
    return { wd, n };
  });
}

function parseUntil(text: string): Until {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text);
  if (!m) throw invalid(`UNTIL "${text}" is not a date (YYYYMMDD) or date-time (YYYYMMDDTHHMMSSZ)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo))
    throw invalid(`UNTIL "${text}" is not a real date`);
  if (m[4] === undefined) {
    // A date: through the end of that local day.
    return { kind: 'local', naive: Date.UTC(y, mo - 1, d, 23, 59, 59) };
  }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (h > 23 || mi > 59 || s > 59) throw invalid(`UNTIL "${text}" is not a real time`);
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  return m[7] ? { kind: 'instant', at: naive } : { kind: 'local', naive };
}

// ---- evaluation ------------------------------------------------------------------------------

/** Bounds of one search: periods past the horizon or beyond the cap end it. */
export interface SearchLimits {
  horizonNaive: number;
  maxPeriods: number;
}

/**
 * Local times the rule produces, ascending, from DTSTART (`dtNaive`) on and no earlier than
 * `fromNaive` (callers with COUNT start at DTSTART, since every occurrence counts).
 */
export function* rruleTimes(
  rule: RRule,
  dtNaive: number,
  fromNaive: number,
  limits: SearchLimits,
): Generator<number> {
  const dt = fieldsOf(dtNaive);
  const start = Math.max(dtNaive, fromNaive);
  const times = timesOfDay(rule, dt);
  let periods = 0;
  const done = (periodStart: number) =>
    periodStart > limits.horizonNaive || ++periods > limits.maxPeriods;

  switch (rule.freq) {
    case 'YEARLY': {
      const from = fieldsOf(start).y;
      let k = Math.max(0, Math.floor((from - dt.y) / rule.interval));
      for (;;) {
        const y = dt.y + k * rule.interval;
        if (done(Date.UTC(y, 0, 1))) return;
        yield* expand(yearDays(rule, dt, y), times, dtNaive, fromNaive);
        k++;
      }
    }
    case 'MONTHLY': {
      const f = fieldsOf(start);
      const base = dt.y * 12 + dt.mo - 1;
      let k = Math.max(0, Math.floor((f.y * 12 + f.mo - 1 - base) / rule.interval));
      for (;;) {
        const idx = base + k * rule.interval;
        const y = Math.floor(idx / 12);
        const mo = (idx % 12) + 1;
        if (done(Date.UTC(y, mo - 1, 1))) return;
        if (!rule.byMonth || rule.byMonth.includes(mo))
          yield* expand(monthDays(rule, dt, y, mo), times, dtNaive, fromNaive);
        k++;
      }
    }
    case 'WEEKLY': {
      const dtDay = Math.floor(dtNaive / DAY);
      const week0 = dtDay - ((weekdayOf(dtDay) - rule.wkst + 7) % 7);
      const span = 7 * rule.interval;
      let k = Math.max(0, Math.floor((Math.floor(start / DAY) - week0) / span));
      const weekdays = rule.byDay ? rule.byDay.map((b) => b.wd) : [dt.wd];
      for (;;) {
        const ws = week0 + k * span;
        if (done(ws * DAY)) return;
        const days = [...new Set(weekdays.map((wd) => ws + ((wd - rule.wkst + 7) % 7)))]
          .filter((day) => !rule.byMonth || rule.byMonth.includes(fieldsOf(day * DAY).mo))
          .sort((a, b) => a - b);
        yield* expand(days, times, dtNaive, fromNaive);
        k++;
      }
    }
    case 'DAILY': {
      const dtDay = Math.floor(dtNaive / DAY);
      let k = Math.max(0, Math.floor((Math.floor(start / DAY) - dtDay) / rule.interval));
      for (;;) {
        const day = dtDay + k * rule.interval;
        if (done(day * DAY)) return;
        if (dayPasses(rule, day)) yield* expand([day], times, dtNaive, fromNaive);
        k++;
      }
    }
    case 'HOURLY':
    case 'MINUTELY': {
      const unit = rule.freq === 'HOURLY' ? HOUR : MINUTE;
      const base = Math.floor(dtNaive / unit) * unit;
      const step = rule.interval * unit;
      let k = Math.max(0, Math.floor((start - base) / step));
      const minutes = rule.byMinute ?? [dt.mi];
      const seconds = rule.bySecond ?? [dt.s];
      for (;;) {
        const p = base + k * step;
        if (done(p)) return;
        const day = Math.floor(p / DAY);
        if (!dayPasses(rule, day)) {
          // Skip the rest of a day that cannot match.
          k = Math.max(k + 1, Math.ceil(((day + 1) * DAY - base) / step));
          continue;
        }
        const f = fieldsOf(p);
        if (rule.byHour && !rule.byHour.includes(f.h)) {
          k = Math.max(k + 1, Math.ceil((Math.floor(p / HOUR + 1) * HOUR - base) / step));
          continue;
        }
        if (rule.freq === 'HOURLY') {
          for (const mi of minutes)
            for (const s of seconds) {
              const t = p + mi * MINUTE + s * SECOND;
              if (t >= dtNaive && t >= fromNaive) yield t;
            }
        } else if (!rule.byMinute || rule.byMinute.includes(f.mi)) {
          for (const s of seconds) {
            const t = p + s * SECOND;
            if (t >= dtNaive && t >= fromNaive) yield t;
          }
        }
        k++;
      }
    }
  }
}

/** Times within a day for DAILY and longer periods, as milliseconds after midnight, ascending. */
function timesOfDay(rule: RRule, dt: LocalFields): number[] {
  const out: number[] = [];
  for (const h of rule.byHour ?? [dt.h])
    for (const mi of rule.byMinute ?? [dt.mi])
      for (const s of rule.bySecond ?? [dt.s]) out.push(h * HOUR + mi * MINUTE + s * SECOND);
  return out.sort((a, b) => a - b);
}

function* expand(days: number[], times: number[], dtNaive: number, fromNaive: number) {
  for (const day of days)
    for (const t of times) {
      const naive = day * DAY + t;
      if (naive >= dtNaive && naive >= fromNaive) yield naive;
    }
}

/** BYMONTH, BYMONTHDAY and BYDAY as limits (DAILY and shorter periods). */
function dayPasses(rule: RRule, day: number): boolean {
  const f = fieldsOf(day * DAY);
  if (rule.byMonth && !rule.byMonth.includes(f.mo)) return false;
  if (rule.byMonthDay) {
    const dim = daysInMonth(f.y, f.mo);
    if (!rule.byMonthDay.some((v) => (v > 0 ? v : dim + v + 1) === f.d)) return false;
  }
  if (rule.byDay && !rule.byDay.some((b) => b.wd === f.wd)) return false;
  return true;
}

/** Days (day indexes) of one month that match, ascending. */
function monthDays(rule: RRule, dt: LocalFields, y: number, mo: number): number[] {
  const first = dayIndex(y, mo, 1);
  const dim = daysInMonth(y, mo);
  let days: number[];
  if (rule.byMonthDay) {
    days = rule.byMonthDay
      .map((v) => (v > 0 ? v : dim + v + 1))
      .filter((d) => d >= 1 && d <= dim)
      .map((d) => first + d - 1);
    if (rule.byDay) {
      const allowed = new Set(byDayIn(first, first + dim, rule.byDay));
      days = days.filter((d) => allowed.has(d));
    }
  } else if (rule.byDay) {
    days = byDayIn(first, first + dim, rule.byDay);
  } else {
    // An invalid date (the 31st of a 30-day month) is skipped, as RFC 5545 says.
    days = dt.d <= dim ? [first + dt.d - 1] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Days of one year that match, ascending (BYDAY ordinals count within the year without BYMONTH). */
function yearDays(rule: RRule, dt: LocalFields, y: number): number[] {
  if (rule.byMonth) return rule.byMonth.flatMap((mo) => monthDays(rule, dt, y, mo));
  if (rule.byMonthDay) {
    let days: number[] = [];
    for (let mo = 1; mo <= 12; mo++) days.push(...monthDays({ ...rule, byDay: null }, dt, y, mo));
    if (rule.byDay) {
      const allowed = new Set(byDayIn(dayIndex(y, 1, 1), dayIndex(y + 1, 1, 1), rule.byDay));
      days = days.filter((d) => allowed.has(d));
    }
    return days;
  }
  if (rule.byDay) return byDayIn(dayIndex(y, 1, 1), dayIndex(y + 1, 1, 1), rule.byDay);
  return dt.d <= daysInMonth(y, dt.mo) ? [dayIndex(y, dt.mo, dt.d)] : [];
}

/** Days in [from, to) matching BYDAY entries, ascending. */
function byDayIn(from: number, to: number, byDay: ByDay[]): number[] {
  const out = new Set<number>();
  for (const b of byDay) {
    const firstOfWd = from + ((b.wd - weekdayOf(from) + 7) % 7);
    const all: number[] = [];
    for (let d = firstOfWd; d < to; d += 7) all.push(d);
    if (b.n === null) for (const d of all) out.add(d);
    else {
      const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
      if (pick !== undefined) out.add(pick);
    }
  }
  return [...out].sort((a, b) => a - b);
}
