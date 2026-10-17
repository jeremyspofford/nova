// When a schedule fires (docs/09 §6, FR-055, ADR-079): cron, RRULE, a fixed interval or one
// instant, evaluated in the schedule's IANA time zone. Fires never come before `startsAt` or after
// `endsAt`. Everything is validated with errors that name the field.
import { NovaError, type ScheduleWhen } from '@nova/shared';
import { cronTimes, parseCron } from './cron.ts';
import { parseRrule, rruleTimes } from './rrule.ts';
import { DAY, MINUTE, isTimeZone, naiveOf, resolveLocal } from './zone.ts';

/** How far ahead a search looks: 12 years covers 29 February rules (8-year gaps). */
const HORIZON_DAYS = 366 * 12;
const MAX_PERIODS = 2_000_000;
/** No rule may fire more often than once a minute. */
export const MIN_GAP_MS = MINUTE;

export interface RecurrenceInput {
  when: ScheduleWhen;
  timezone: string;
  startsAt: string | null;
  endsAt: string | null;
  /** The schedule's creation: the RRULE DTSTART and the interval's anchor without startsAt. */
  createdAt: string;
}

export interface Recurrence {
  /** Fire instants (epoch ms) strictly after `after`, ascending. */
  after(after: number): Generator<number, void>;
  /** The first fire strictly after `after`, or null when there is none. */
  next(after: number): number | null;
}

export function fieldError(field: string, message: string): NovaError {
  return new NovaError('validation', `${field}: ${message}`, { details: { field } });
}

function instant(field: string, value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw fieldError(field, `"${value}" is not a date-time`);
  return t;
}

/** Compile a schedule's rule; throws `validation` naming the field that is wrong. */
export function compileRecurrence(input: RecurrenceInput): Recurrence {
  const tz = input.timezone;
  if (!isTimeZone(tz))
    throw fieldError('timezone', `"${tz}" is not an IANA time zone such as Europe/London`);
  const startsAt = instant('startsAt', input.startsAt);
  const endsAt = instant('endsAt', input.endsAt);
  const created = instant('createdAt', input.createdAt) ?? 0;
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt)
    throw fieldError('endsAt', 'must be after startsAt');
  const within = (at: number) =>
    (startsAt === null || at >= startsAt) && (endsAt === null || at <= endsAt);
  const when = input.when;
  let gen: (after: number) => Generator<number, void>;

  if ('cron' in when) {
    const rule = parseCron(when.cron);
    gen = function* (after) {
      const from = Math.max(after, startsAt ?? after);
      let last = -Infinity;
      for (const naive of cronTimes(rule, naiveOf(tz, from) - DAY, HORIZON_DAYS)) {
        const at = resolveLocal(tz, naive);
        if (at <= after || at <= last || (startsAt !== null && at < startsAt)) continue;
        if (endsAt !== null && at > endsAt) return;
        last = at;
        yield at;
      }
    };
  } else if ('rrule' in when) {
    const rule = parseRrule(when.rrule);
    const dtInstant = startsAt ?? created;
    const dtNaive = naiveOf(tz, dtInstant);
    gen = function* (after) {
      // With COUNT every occurrence from DTSTART counts, so the walk starts there.
      const fromNaive =
        rule.count !== null ? dtNaive : naiveOf(tz, Math.max(after, dtInstant)) - DAY;
      const limits = {
        horizonNaive: Math.max(fromNaive, naiveOf(tz, after)) + HORIZON_DAYS * DAY,
        maxPeriods: MAX_PERIODS,
      };
      let n = 0;
      let last = -Infinity;
      for (const naive of rruleTimes(rule, dtNaive, fromNaive, limits)) {
        if (rule.until?.kind === 'local' && naive > rule.until.naive) return;
        const at = resolveLocal(tz, naive);
        if (at <= last || at < dtInstant) continue;
        if (rule.until?.kind === 'instant' && at > rule.until.at) return;
        if (endsAt !== null && at > endsAt) return;
        last = at;
        if (rule.count !== null && ++n > rule.count) return;
        if (at > after) yield at;
      }
    };
  } else if ('intervalSeconds' in when) {
    if (!Number.isInteger(when.intervalSeconds) || when.intervalSeconds < 60)
      throw fieldError('when.intervalSeconds', 'must be a whole number of seconds, at least 60');
    const anchor = startsAt ?? created;
    const step = when.intervalSeconds * 1000;
    gen = function* (after) {
      let k = after < anchor ? 0 : Math.floor((after - anchor) / step) + 1;
      for (;;) {
        const at = anchor + k * step;
        if (endsAt !== null && at > endsAt) return;
        yield at;
        k++;
      }
    };
  } else {
    const at = instant('when.at', when.at)!;
    gen = function* (after) {
      if (at > after && within(at)) yield at;
    };
  }

  return {
    after: gen,
    next(after) {
      for (const at of gen(after)) return at;
      return null;
    },
  };
}

/** The field a rule's errors name: `when.cron`, `when.rrule`, ... */
export function whenField(when: ScheduleWhen): string {
  return `when.${Object.keys(when)[0] ?? 'cron'}`;
}

/**
 * A rule that can fire: it has a fire after `now`, and no two fires closer than a minute. A
 * one-shot in the past and a rule whose COUNT or UNTIL is spent both fail here.
 */
export function assertFires(rec: Recurrence, when: ScheduleWhen, now: number): number {
  const field = whenField(when);
  const sample: number[] = [];
  for (const at of rec.after(now)) {
    sample.push(at);
    if (sample.length >= 25) break;
  }
  if (!sample.length)
    throw fieldError(
      field,
      'at' in when
        ? 'is in the past'
        : 'the rule has no future fires (check the dates and the end)',
    );
  for (let i = 1; i < sample.length; i++) {
    if (sample[i]! - sample[i - 1]! < MIN_GAP_MS)
      throw fieldError(field, 'fires more often than once a minute');
  }
  return sample[0]!;
}

/** Missed fires in a range: the first, the last and how many (ADR-079). */
export interface FireWindow {
  first: number;
  last: number;
  count: number;
}

/** Fires in [from, to], counted up to `cap` (a capped count is a lower bound). */
export function windowOf(
  rec: Recurrence,
  from: number,
  to: number,
  cap: number,
): FireWindow | null {
  if (to < from) return null;
  let first: number | null = null;
  let last = 0;
  let count = 0;
  for (const at of rec.after(from - 1)) {
    if (at > to) break;
    first ??= at;
    last = at;
    if (++count >= cap) break;
  }
  return first === null ? null : { first, last, count };
}
