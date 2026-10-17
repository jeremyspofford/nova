// Schedule rules (FR-055, ADR-079): cron, RRULE, intervals and one-shots evaluated in the
// schedule's time zone with Intl, across DST gaps and folds (New York, London, Lord Howe's 30-min
// shift), leap days, month ends, COUNT, UNTIL, endsAt, and validation that names the field.
import { describe, expect, it } from 'vitest';
import { isNovaError, type ScheduleWhen } from '@nova/shared';
import {
  assertFires,
  compileRecurrence,
  isTimeZone,
  offsetAt,
  parseCron,
  parseRrule,
  resolveLocal,
  windowOf,
  type RecurrenceInput,
} from '../src/index.ts';

const T = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

function rule(when: ScheduleWhen, timezone = 'UTC', over: Partial<RecurrenceInput> = {}) {
  return compileRecurrence({
    when,
    timezone,
    startsAt: null,
    endsAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
}

/** The first `n` fires after `after`, as ISO strings. */
function fires(r: ReturnType<typeof rule>, after: string, n: number): string[] {
  const out: string[] = [];
  for (const at of r.after(T(after))) {
    out.push(iso(at));
    if (out.length >= n) break;
  }
  return out;
}

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (isNovaError(err) && err.code === 'validation')
      return (err.details as { field?: string } | undefined)?.field;
    throw err;
  }
  return undefined;
}

describe('time zones', () => {
  it('accepts IANA names and refuses offsets and unknown zones', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Etc/GMT+5')).toBe(true);
    expect(isTimeZone('+05:00')).toBe(false);
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });

  it('reads offsets, including seconds of old local mean time', () => {
    expect(offsetAt('UTC', T('2026-06-01T00:00:00Z'))).toBe(0);
    expect(offsetAt('America/New_York', T('2026-06-01T00:00:00Z'))).toBe(-4 * 3600_000);
    expect(offsetAt('Australia/Lord_Howe', T('2026-06-01T00:00:00Z'))).toBe(10.5 * 3600_000);
    expect(offsetAt('America/New_York', T('1850-01-01T00:00:00Z'))).toBe(
      -(4 * 3600 + 56 * 60 + 2) * 1000,
    );
  });

  it('resolves gaps to the end of the gap and folds to the first occurrence', () => {
    const naive = (s: string) => T(`${s}Z`);
    // New York, 8 March 2026: 02:00 EST jumps to 03:00 EDT (07:00Z).
    expect(iso(resolveLocal('America/New_York', naive('2026-03-08T02:30:00')))).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    // 1 November 2026: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(iso(resolveLocal('America/New_York', naive('2026-11-01T01:30:00')))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(iso(resolveLocal('America/New_York', naive('2026-07-01T12:00:00')))).toBe(
      '2026-07-01T16:00:00.000Z',
    );
  });
});

describe('cron', () => {
  it('fires a daily time across the New York spring gap and fall fold', () => {
    const r = rule({ cron: '30 2 * * *' }, 'America/New_York');
    expect(fires(r, '2026-03-07T12:00:00Z', 2)).toEqual([
      '2026-03-08T07:00:00.000Z', // 02:30 does not exist: 03:00 EDT
      '2026-03-09T06:30:00.000Z',
    ]);
    const fold = rule({ cron: '30 1 * * *' }, 'America/New_York');
    expect(fires(fold, '2026-10-31T12:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z', // the first 01:30 only
      '2026-11-02T06:30:00.000Z',
    ]);
  });

  it('fires hourly once per local hour across both New York changes', () => {
    const r = rule({ cron: '0 * * * *' }, 'America/New_York');
    expect(fires(r, '2026-11-01T03:30:00Z', 4)).toEqual([
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
      // 01:00 EST (06:00Z) repeats a local time and does not fire again.
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
    expect(fires(r, '2026-03-08T04:30:00Z', 4)).toEqual([
      '2026-03-08T05:00:00.000Z',
      '2026-03-08T06:00:00.000Z',
      // 02:00 does not exist; it and 03:00 fire once, at the change.
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
    ]);
  });

  it('handles Europe/London', () => {
    const r = rule({ cron: '30 1 * * *' }, 'Europe/London');
    expect(fires(r, '2026-03-28T12:00:00Z', 2)).toEqual([
      '2026-03-29T01:00:00.000Z', // 01:30 GMT does not exist: 02:00 BST
      '2026-03-30T00:30:00.000Z',
    ]);
    expect(fires(r, '2026-10-24T12:00:00Z', 2)).toEqual([
      '2026-10-25T00:30:00.000Z', // first 01:30 (BST)
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('handles the 30-minute shift of Australia/Lord_Howe', () => {
    const gap = rule({ cron: '15 2 * * *' }, 'Australia/Lord_Howe');
    expect(fires(gap, '2026-10-02T00:00:00Z', 3)).toEqual([
      '2026-10-02T15:45:00.000Z', // 02:15 at +10:30
      '2026-10-03T15:30:00.000Z', // 02:15 skipped (02:00 → 02:30): fires at 02:30 +11:00
      '2026-10-04T15:15:00.000Z', // 02:15 at +11:00
    ]);
    const fold = rule({ cron: '45 1 * * *' }, 'Australia/Lord_Howe');
    expect(fires(fold, '2026-04-04T00:00:00Z', 2)).toEqual([
      '2026-04-04T14:45:00.000Z', // the first 01:45 (+11:00); the repeat at 15:15Z does not fire
      '2026-04-05T15:15:00.000Z',
    ]);
  });

  it('fires on 29 February only in leap years', () => {
    const r = rule({ cron: '0 9 29 2 *' });
    expect(fires(r, '2026-01-01T00:00:00Z', 2)).toEqual([
      '2028-02-29T09:00:00.000Z',
      '2032-02-29T09:00:00.000Z',
    ]);
  });

  it('supports lists, ranges, steps, names and shorthands', () => {
    const r = rule({ cron: '*/20 9-10 * jan-mar MON-FRI' });
    expect(fires(r, '2026-01-02T09:30:00Z', 5)).toEqual([
      '2026-01-02T09:40:00.000Z',
      '2026-01-02T10:00:00.000Z',
      '2026-01-02T10:20:00.000Z',
      '2026-01-02T10:40:00.000Z',
      '2026-01-05T09:00:00.000Z', // Monday; the weekend is skipped
    ]);
    expect(fires(rule({ cron: '@weekly' }), '2026-01-01T00:00:00Z', 1)).toEqual([
      '2026-01-04T00:00:00.000Z',
    ]);
    expect(fires(rule({ cron: '@yearly' }), '2026-01-01T00:00:00Z', 1)).toEqual([
      '2027-01-01T00:00:00.000Z',
    ]);
    expect(fires(rule({ cron: '@hourly' }), '2026-01-01T00:00:00Z', 1)).toEqual([
      '2026-01-01T01:00:00.000Z',
    ]);
    expect(fires(rule({ cron: '0 0 1,15 * *' }), '2026-01-01T00:00:00Z', 2)).toEqual([
      '2026-01-15T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ]);
    // 7 is Sunday too; `5/10` is 5, 15, 25, ...
    expect(parseCron('5/10 0 * * 7').weekdays).toEqual(new Set([0]));
    expect(parseCron('5/10 0 * * 7').minutes).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('matches either day field when both are restricted, both when one is a star', () => {
    const either = rule({ cron: '0 0 13 * FRI' });
    expect(fires(either, '2026-02-01T00:00:00Z', 3)).toEqual([
      '2026-02-06T00:00:00.000Z', // Friday
      '2026-02-13T00:00:00.000Z', // the 13th (also a Friday)
      '2026-02-20T00:00:00.000Z',
    ]);
    const both = rule({ cron: '0 0 */2 * FRI' });
    // Odd days that are Fridays.
    expect(fires(both, '2026-02-01T00:00:00Z', 2)).toEqual([
      '2026-02-13T00:00:00.000Z',
      '2026-02-27T00:00:00.000Z',
    ]);
  });

  it('respects startsAt and endsAt', () => {
    const r = rule({ cron: '0 12 * * *' }, 'UTC', {
      startsAt: '2026-05-03T00:00:00Z',
      endsAt: '2026-05-04T12:00:00Z',
    });
    expect(fires(r, '2026-05-01T00:00:00Z', 5)).toEqual([
      '2026-05-03T12:00:00.000Z',
      '2026-05-04T12:00:00.000Z',
    ]);
  });

  it('names the field of a bad cron', () => {
    for (const bad of [
      '61 * * * *',
      '* * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '1,,2 * * * *',
      '@reboot',
      '* * * FOO *',
      '1/2/3 * * * *',
      '-5 * * * *',
    ]) {
      expect(
        fieldOf(() => rule({ cron: bad })),
        bad,
      ).toBe('when.cron');
    }
  });
});

describe('RRULE', () => {
  it('keeps the wall-clock time of DTSTART across DST', () => {
    const r = rule({ rrule: 'FREQ=DAILY' }, 'America/New_York', {
      startsAt: '2026-03-07T14:30:00Z', // 09:30 EST
    });
    expect(fires(r, '2026-03-07T00:00:00Z', 3)).toEqual([
      '2026-03-07T14:30:00.000Z',
      '2026-03-08T13:30:00.000Z', // 09:30 EDT
      '2026-03-09T13:30:00.000Z',
    ]);
  });

  it('expands HOURLY across a gap without firing twice', () => {
    const r = rule({ rrule: 'RRULE:FREQ=HOURLY;BYMINUTE=0' }, 'America/New_York', {
      startsAt: '2026-03-08T05:00:00Z',
    });
    expect(fires(r, '2026-03-08T04:00:00Z', 4)).toEqual([
      '2026-03-08T05:00:00.000Z',
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
    ]);
  });

  it('fires on the last day of each month with BYMONTHDAY=-1', () => {
    const r = rule(
      { rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18;BYMINUTE=0;BYSECOND=0' },
      'Europe/London',
      {
        startsAt: '2026-01-01T00:00:00Z',
      },
    );
    expect(fires(r, '2026-01-01T00:00:00Z', 4)).toEqual([
      '2026-01-31T18:00:00.000Z',
      '2026-02-28T18:00:00.000Z',
      '2026-03-31T17:00:00.000Z', // 18:00 BST
      '2026-04-30T17:00:00.000Z',
    ]);
    expect(fires(r, '2028-02-01T00:00:00Z', 1)).toEqual(['2028-02-29T18:00:00.000Z']);
  });

  it('skips 29 February in common years for a yearly rule', () => {
    const r = rule({ rrule: 'FREQ=YEARLY' }, 'UTC', { startsAt: '2024-02-29T09:00:00Z' });
    expect(fires(r, '2024-03-01T00:00:00Z', 2)).toEqual([
      '2028-02-29T09:00:00.000Z',
      '2032-02-29T09:00:00.000Z',
    ]);
  });

  it('stops after COUNT fires, counted from DTSTART', () => {
    const r = rule({ rrule: 'FREQ=DAILY;COUNT=3' }, 'UTC', { startsAt: '2026-05-01T08:00:00Z' });
    expect(fires(r, '2026-04-30T00:00:00Z', 5)).toEqual([
      '2026-05-01T08:00:00.000Z',
      '2026-05-02T08:00:00.000Z',
      '2026-05-03T08:00:00.000Z',
    ]);
    expect(r.next(T('2026-05-02T09:00:00Z'))).toBe(T('2026-05-03T08:00:00Z'));
    expect(r.next(T('2026-05-03T08:00:00Z'))).toBeNull();
  });

  it('stops at UNTIL, inclusive, as a UTC time, a local time or a date', () => {
    const r = rule({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260520T090000Z' }, 'UTC', {
      startsAt: '2026-05-04T09:00:00Z',
    });
    expect(fires(r, '2026-05-01T00:00:00Z', 10)).toEqual([
      '2026-05-04T09:00:00.000Z',
      '2026-05-06T09:00:00.000Z',
      '2026-05-11T09:00:00.000Z',
      '2026-05-13T09:00:00.000Z',
      '2026-05-18T09:00:00.000Z',
      '2026-05-20T09:00:00.000Z',
    ]);
    const date = rule({ rrule: 'FREQ=DAILY;UNTIL=20260503' }, 'Europe/London', {
      startsAt: '2026-05-01T20:00:00Z',
    });
    expect(fires(date, '2026-05-01T00:00:00Z', 5)).toHaveLength(3);
    const local = rule({ rrule: 'FREQ=DAILY;UNTIL=20260502T205959' }, 'Europe/London', {
      startsAt: '2026-05-01T20:00:00Z', // 21:00 BST
    });
    expect(fires(local, '2026-05-01T00:00:00Z', 5)).toEqual(['2026-05-01T20:00:00.000Z']);
  });

  it('supports weekday ordinals', () => {
    const first = rule({ rrule: 'FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0' }, 'UTC', {
      startsAt: '2026-01-01T00:00:00Z',
    });
    expect(fires(first, '2026-01-01T00:00:00Z', 3)).toEqual([
      '2026-01-05T09:00:00.000Z',
      '2026-02-02T09:00:00.000Z',
      '2026-03-02T09:00:00.000Z',
    ]);
    const last = rule({ rrule: 'FREQ=MONTHLY;BYDAY=-1FR' }, 'UTC', {
      startsAt: '2026-01-01T17:00:00Z',
    });
    expect(fires(last, '2026-01-01T00:00:00Z', 3)).toEqual([
      '2026-01-30T17:00:00.000Z',
      '2026-02-27T17:00:00.000Z',
      '2026-03-27T17:00:00.000Z',
    ]);
    const thanksgiving = rule({ rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH' }, 'UTC', {
      startsAt: '2026-01-01T12:00:00Z',
    });
    expect(fires(thanksgiving, '2026-01-01T00:00:00Z', 2)).toEqual([
      '2026-11-26T12:00:00.000Z',
      '2027-11-25T12:00:00.000Z',
    ]);
    const lastOfYear = rule({ rrule: 'FREQ=YEARLY;BYDAY=-1SU' }, 'UTC', {
      startsAt: '2026-01-01T12:00:00Z',
    });
    expect(fires(lastOfYear, '2026-01-01T00:00:00Z', 1)).toEqual(['2026-12-27T12:00:00.000Z']);
  });

  it('honours INTERVAL, BYMONTH, BYMONTHDAY with BYDAY and WKST', () => {
    const fortnight = rule({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH' }, 'UTC', {
      startsAt: '2026-01-06T10:00:00Z',
    });
    expect(fires(fortnight, '2026-01-01T00:00:00Z', 4)).toEqual([
      '2026-01-06T10:00:00.000Z',
      '2026-01-08T10:00:00.000Z',
      '2026-01-20T10:00:00.000Z',
      '2026-01-22T10:00:00.000Z',
    ]);
    const friday13 = rule({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR' }, 'UTC', {
      startsAt: '2026-01-01T00:00:00Z',
    });
    expect(fires(friday13, '2026-01-01T00:00:00Z', 2)).toEqual([
      '2026-02-13T00:00:00.000Z',
      '2026-03-13T00:00:00.000Z',
    ]);
    const quarterly = rule({ rrule: 'FREQ=YEARLY;BYMONTH=1,4,7,10;BYMONTHDAY=1' }, 'UTC', {
      startsAt: '2026-01-01T06:00:00Z',
    });
    expect(fires(quarterly, '2026-01-02T00:00:00Z', 2)).toEqual([
      '2026-04-01T06:00:00.000Z',
      '2026-07-01T06:00:00.000Z',
    ]);
    const firsts = rule({ rrule: 'FREQ=YEARLY;BYMONTHDAY=1' }, 'UTC', {
      startsAt: '2026-01-01T06:00:00Z',
    });
    expect(fires(firsts, '2026-01-02T00:00:00Z', 1)).toEqual(['2026-02-01T06:00:00.000Z']);
    const weekdays = rule({ rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYMONTH=1' }, 'UTC', {
      startsAt: '2026-01-30T07:00:00Z',
    });
    expect(fires(weekdays, '2026-01-30T00:00:00Z', 2)).toEqual([
      '2026-01-30T07:00:00.000Z',
      '2027-01-01T07:00:00.000Z',
    ]);
    const sundayWeeks = rule({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU' }, 'UTC', {
      startsAt: '2026-01-04T08:00:00Z', // a Sunday
    });
    expect(fires(sundayWeeks, '2026-01-01T00:00:00Z', 3)).toEqual([
      '2026-01-04T08:00:00.000Z',
      '2026-01-05T08:00:00.000Z',
      '2026-01-18T08:00:00.000Z',
    ]);
    const minutely = rule({ rrule: 'FREQ=MINUTELY;INTERVAL=30;BYHOUR=9' }, 'UTC', {
      startsAt: '2026-01-01T08:00:00Z',
    });
    expect(fires(minutely, '2026-01-01T08:00:00Z', 3)).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-01T09:30:00.000Z',
      '2026-01-02T09:00:00.000Z',
    ]);
    const hourlyWeekend = rule({ rrule: 'FREQ=HOURLY;INTERVAL=6;BYDAY=SA' }, 'UTC', {
      startsAt: '2026-01-01T00:00:00Z', // a Thursday
    });
    expect(fires(hourlyWeekend, '2026-01-01T00:00:00Z', 2)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-03T06:00:00.000Z',
    ]);
  });

  it('names the field of a bad rule', () => {
    for (const bad of [
      'FREQ=SECONDLY',
      'FREQ=FORTNIGHTLY',
      'INTERVAL=2',
      'FREQ=DAILY;BYSETPOS=1',
      'FREQ=DAILY;COUNT=2;UNTIL=20270101',
      'FREQ=WEEKLY;BYDAY=1MO',
      'FREQ=MONTHLY;BYDAY=6MO',
      'FREQ=WEEKLY;BYMONTHDAY=1',
      'FREQ=DAILY;BYMONTHDAY=0',
      'FREQ=DAILY;BYHOUR=24',
      'FREQ=DAILY;INTERVAL=0',
      'FREQ=DAILY;UNTIL=2027-01-01',
      'FREQ=DAILY;UNTIL=20270230',
      'FREQ=DAILY;FREQ=WEEKLY',
      'FREQ=DAILY;BYDAY=XX',
      'FREQ=DAILY;WKST=XX',
      'FREQ=DAILY;FOO=1',
      'FREQ=DAILY;BYMONTH=',
      'FREQ=DAILY;junk',
    ]) {
      expect(
        fieldOf(() => rule({ rrule: bad })),
        bad,
      ).toBe('when.rrule');
    }
    expect(parseRrule('freq=daily;byday=-1fr'.replace('daily', 'monthly')).byDay).toEqual([
      { wd: 5, n: -1 },
    ]);
  });
});

describe('intervals and one-shots', () => {
  it('counts an interval from startsAt or from creation', () => {
    const r = rule({ intervalSeconds: 3600 }, 'UTC', { startsAt: '2026-05-01T00:30:00Z' });
    expect(fires(r, '2026-04-30T00:00:00Z', 2)).toEqual([
      '2026-05-01T00:30:00.000Z',
      '2026-05-01T01:30:00.000Z',
    ]);
    expect(r.next(T('2026-05-01T01:30:00Z'))).toBe(T('2026-05-01T02:30:00Z'));
    const fromCreation = rule({ intervalSeconds: 600 }, 'UTC', {
      createdAt: '2026-05-01T00:00:00Z',
      endsAt: '2026-05-01T00:20:00Z',
    });
    expect(fires(fromCreation, '2026-05-01T00:00:00Z', 5)).toEqual([
      '2026-05-01T00:10:00.000Z',
      '2026-05-01T00:20:00.000Z',
    ]);
    expect(fieldOf(() => rule({ intervalSeconds: 30 }))).toBe('when.intervalSeconds');
  });

  it('fires a one-shot once', () => {
    const r = rule({ at: '2026-06-01T10:00:00+02:00' });
    expect(fires(r, '2026-05-01T00:00:00Z', 3)).toEqual(['2026-06-01T08:00:00.000Z']);
    expect(r.next(T('2026-06-01T08:00:00Z'))).toBeNull();
  });
});

describe('validation', () => {
  const now = T('2026-05-01T00:00:00Z');

  it('names the time zone and dates', () => {
    expect(fieldOf(() => rule({ cron: '* * * * *' }, 'Mars/Base'))).toBe('timezone');
    expect(fieldOf(() => rule({ cron: '* * * * *' }, '+05:00'))).toBe('timezone');
    expect(
      fieldOf(() =>
        rule({ cron: '* * * * *' }, 'UTC', {
          startsAt: '2026-05-02T00:00:00Z',
          endsAt: '2026-05-01T00:00:00Z',
        }),
      ),
    ).toBe('endsAt');
    expect(fieldOf(() => rule({ cron: '* * * * *' }, 'UTC', { startsAt: 'yesterday' }))).toBe(
      'startsAt',
    );
  });

  it('refuses rules that never fire, a past one-shot and fires closer than a minute', () => {
    const check = (when: ScheduleWhen, over: Partial<RecurrenceInput> = {}) =>
      fieldOf(() => assertFires(rule(when, 'UTC', over), when, now));
    expect(check({ cron: '0 0 30 2 *' })).toBe('when.cron');
    expect(check({ cron: '0 0 31 4 *' })).toBe('when.cron');
    expect(check({ at: '2026-04-01T00:00:00Z' })).toBe('when.at');
    expect(check({ rrule: 'FREQ=MINUTELY;BYSECOND=0,30' })).toBe('when.rrule');
    expect(check({ rrule: 'FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30' })).toBe('when.rrule');
    expect(check({ rrule: 'FREQ=DAILY;COUNT=2' }, { startsAt: '2026-01-01T00:00:00Z' })).toBe(
      'when.rrule',
    );
    expect(check({ cron: '* * * * *' })).toBeUndefined();
    expect(assertFires(rule({ cron: '0 * * * *' }), { cron: '0 * * * *' }, now)).toBe(
      T('2026-05-01T01:00:00Z'),
    );
  });
});

describe('missed-fire windows', () => {
  it('reports the first, the last and the count within a range', () => {
    const r = rule({ cron: '0 9 * * *' });
    expect(windowOf(r, T('2026-05-01T00:00:00Z'), T('2026-05-04T08:00:00Z'), 1000)).toEqual({
      first: T('2026-05-01T09:00:00Z'),
      last: T('2026-05-03T09:00:00Z'),
      count: 3,
    });
    expect(windowOf(r, T('2026-05-01T10:00:00Z'), T('2026-05-01T11:00:00Z'), 1000)).toBeNull();
    expect(windowOf(r, T('2026-05-02T00:00:00Z'), T('2026-05-01T00:00:00Z'), 1000)).toBeNull();
    expect(
      windowOf(
        rule({ cron: '* * * * *' }),
        T('2026-05-01T00:00:00Z'),
        T('2026-05-02T00:00:00Z'),
        10,
      )?.count,
    ).toBe(10);
  });
});
