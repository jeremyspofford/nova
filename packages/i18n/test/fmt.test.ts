import { afterEach, describe, expect, it } from 'vitest';
import { fmt, resetI18n, setLocale } from '../src/index.ts';

afterEach(() => resetI18n());

const when = new Date(Date.UTC(2026, 9, 5, 14, 30));
const utc = { timeZone: 'UTC' } as const;

describe('fmt under en', () => {
  it('formats numbers, percents and bytes', () => {
    expect(fmt.number(1234.5)).toBe('1,234.5');
    expect(fmt.percent(0.256)).toBe('26%');
    expect(fmt.bytes(512)).toBe('512 B');
    expect(fmt.bytes(1536)).toBe('1.5 KB');
    expect(fmt.bytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(fmt.bytes(3 * 1024 ** 4)).toBe('3 TB');
  });

  it('formats dates and times', () => {
    expect(fmt.date(when, { dateStyle: 'medium', ...utc })).toBe('Oct 5, 2026');
    expect(fmt.time(when, { timeStyle: 'short', ...utc })).toMatch(/^2:30\sPM$/);
    expect(
      fmt.dateTime(when.toISOString(), { dateStyle: 'short', timeStyle: 'short', ...utc }),
    ).toMatch(/^10\/5\/26, 2:30\sPM$/);
  });

  it('formats relative times', () => {
    const now = when.getTime();
    expect(fmt.relative(now - 10_000, { now })).toBe('now');
    expect(fmt.relative(now - 5 * 60_000, { now })).toBe('5 minutes ago');
    expect(fmt.relative(now + 2 * 3_600_000, { now })).toBe('in 2 hours');
    expect(fmt.relative(now - 86_400_000, { now })).toBe('yesterday');
    expect(fmt.relative(now - 400 * 86_400_000, { now })).toBe('last year');
  });

  it('formats lists and durations', () => {
    expect(fmt.list(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(fmt.list(['a', 'b'], { type: 'disjunction' })).toBe('a or b');
    expect(fmt.duration(450)).toBe('450 ms');
    expect(fmt.duration(1500)).toBe('1.5 s');
    expect(fmt.duration(42_000)).toBe('42 s');
    expect(fmt.duration(125_000)).toBe('2 min 5 s');
    expect(fmt.duration(120_000)).toBe('2 min');
    expect(fmt.duration(3_900_000)).toBe('1 h 5 min');
  });
});

describe('fmt under ar', () => {
  it('uses Arabic words, separators and list joining', () => {
    setLocale('ar');
    expect(fmt.list(['a', 'b'])).toBe('a وb');
    expect(fmt.relative(when.getTime() - 5 * 60_000, { now: when.getTime() })).toBe('قبل 5 دقائق');
    expect(fmt.bytes(1536)).toMatch(/كيلوبايت/);
    expect(fmt.duration(1500)).toMatch(/ث/);
    expect(fmt.date(when, { dateStyle: 'long', ...utc })).toMatch(/أكتوبر/);
    expect(fmt.percent(0.5)).toMatch(/50/);
  });
});

describe('fmt under the pseudo-locales', () => {
  it('accents English output under en-XA so unformatted values stand out', () => {
    setLocale('en-XA');
    expect(fmt.date(when, { dateStyle: 'medium', ...utc })).toBe('Öçţ 5, 2026');
    expect(fmt.bytes(1536)).toBe('1.5 ĶƁ');
    expect(fmt.list(['Pat', 'Sam'])).toBe('Pat åñð Sam');
  });

  it('mirrors words under ar-XB', () => {
    setLocale('ar-XB');
    expect(fmt.duration(450)).toMatch(/\u202Ems\u202C/);
  });
});
