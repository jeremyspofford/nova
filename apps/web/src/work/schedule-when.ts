// The friendly "when" picker of a schedule (FR-055, docs/09 §6): common cases (daily at a time,
// weekdays, weekly on a day, every N minutes or hours, once) map to cron, an interval or a
// one-shot time; anything else is typed as cron or an RRULE in the advanced field. Rules are
// evaluated by the Hub in the schedule's timezone; this file only builds and describes them.
import type { ScheduleWhen } from '@nova/shared';

export const REPEATS = ['daily', 'weekdays', 'weekly', 'interval', 'once', 'advanced'] as const;
export type Repeat = (typeof REPEATS)[number];

export const REPEAT_TEXT: Record<Repeat, string> = {
  daily: 'Every day',
  weekdays: 'Weekdays (Monday to Friday)',
  weekly: 'Every week',
  interval: 'Every few minutes or hours',
  once: 'Once',
  advanced: 'Advanced (cron or RRULE)',
};

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export interface WhenDraft {
  repeat: Repeat;
  /** HH:MM, 24-hour, for daily, weekdays and weekly. */
  time: string;
  /** 0 = Sunday, for weekly. */
  day: number;
  every: string;
  unit: 'minutes' | 'hours';
  /** A local `datetime-local` value for once. */
  at: string;
  /** Cron or RRULE text for advanced. */
  expr: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A Date as a `datetime-local` value in local time. */
export function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CRON = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/;

/** The picker state for an existing rule; rules it cannot show fall back to advanced. */
export function draftFromWhen(when: ScheduleWhen | null, now: Date): WhenDraft {
  const tomorrow = new Date(now.getTime() + 86_400_000);
  tomorrow.setHours(9, 0, 0, 0);
  const base: WhenDraft = {
    repeat: 'daily',
    time: '09:00',
    day: 1,
    every: '1',
    unit: 'hours',
    at: localDateTime(tomorrow),
    expr: '',
  };
  if (!when) return base;
  if ('cron' in when) {
    const m = CRON.exec(when.cron.trim().replace(/\s+/g, ' '));
    const min = Number(m?.[1]);
    const hour = Number(m?.[2]);
    if (!m || min > 59 || hour > 23) return { ...base, repeat: 'advanced', expr: when.cron };
    const time = `${pad(hour)}:${pad(min)}`;
    if (m[3] === '*') return { ...base, repeat: 'daily', time };
    if (m[3] === '1-5') return { ...base, repeat: 'weekdays', time };
    return { ...base, repeat: 'weekly', time, day: Number(m[3]) };
  }
  if ('rrule' in when) return { ...base, repeat: 'advanced', expr: when.rrule };
  if ('intervalSeconds' in when) {
    const s = when.intervalSeconds;
    return s % 3600 === 0
      ? { ...base, repeat: 'interval', every: String(s / 3600), unit: 'hours' }
      : { ...base, repeat: 'interval', every: String(Math.round(s / 60)), unit: 'minutes' };
  }
  const d = new Date(when.at);
  return { ...base, repeat: 'once', at: Number.isNaN(d.getTime()) ? base.at : localDateTime(d) };
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MAX_INTERVAL = 366 * 86_400;

/** The rule for a picker state, or what to fix. */
export function whenFromDraft(d: WhenDraft): { when: ScheduleWhen } | { error: string } {
  switch (d.repeat) {
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const t = TIME.exec(d.time);
      if (!t) return { error: 'Enter a time, for example 09:00.' };
      const dow = d.repeat === 'daily' ? '*' : d.repeat === 'weekdays' ? '1-5' : String(d.day);
      return { when: { cron: `${Number(t[2])} ${Number(t[1])} * * ${dow}` } };
    }
    case 'interval': {
      const n = Number(d.every);
      const seconds = n * (d.unit === 'hours' ? 3600 : 60);
      if (!/^\d+$/.test(d.every.trim()) || n < 1 || seconds > MAX_INTERVAL)
        return { error: 'Enter a whole number: at least 1 minute and at most 366 days.' };
      return { when: { intervalSeconds: seconds } };
    }
    case 'once': {
      const at = new Date(d.at);
      if (!d.at || Number.isNaN(at.getTime())) return { error: 'Choose a date and time.' };
      return { when: { at: at.toISOString() } };
    }
    case 'advanced': {
      const expr = d.expr.trim();
      if (/^(RRULE:)?FREQ=/i.test(expr)) return { when: { rrule: expr } };
      const fields = expr.split(/\s+/).filter(Boolean).length;
      if (fields < 5 || fields > 6)
        return {
          error: 'Enter a cron expression with five fields, or an RRULE that starts with FREQ=.',
        };
      return { when: { cron: expr } };
    }
  }
}

/** A rule in words: "Every day at 09:00", "Every Monday at 08:30", "Every 2 hours". */
export function whenText(when: ScheduleWhen): string {
  if ('cron' in when || 'intervalSeconds' in when) {
    const d = draftFromWhen(when, new Date(0));
    switch (d.repeat) {
      case 'daily':
        return `Every day at ${d.time}`;
      case 'weekdays':
        return `Weekdays at ${d.time}`;
      case 'weekly':
        return `Every ${WEEKDAYS[d.day] ?? 'week'} at ${d.time}`;
      case 'interval': {
        const n = Number(d.every);
        const unit = d.unit === 'hours' ? 'hour' : 'minute';
        return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
      }
      default:
        return `Cron: ${'cron' in when ? when.cron : ''}`;
    }
  }
  if ('rrule' in when) return `Rule: ${when.rrule}`;
  const at = new Date(when.at);
  return Number.isNaN(at.getTime())
    ? `Once at ${when.at}`
    : `Once on ${at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** The browser's IANA timezone, the default for a new schedule. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA timezone the browser knows, or null when it cannot list them. */
export function knownTimezones(): string[] | null {
  try {
    const list = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    );
    return list?.length ? list : null;
  } catch {
    return null;
  }
}
