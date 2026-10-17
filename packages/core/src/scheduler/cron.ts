// Five-field cron (minute hour day-of-month month day-of-week) with lists, ranges, steps, month and
// weekday names and the @hourly/@daily/@weekly/@monthly/@yearly shorthands (FR-055). As in
// classic cron, when both day fields are restricted a day matches either; when one starts with
// `*`, both must match. Evaluation produces local wall-clock times; zone.ts maps them to instants.
import { NovaError } from '@nova/shared';
import { DAY, HOUR, MINUTE, fieldsOf } from './zone.ts';

export interface CronRule {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  /** 0 = Sunday. */
  weekdays: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** The first name's value (months are 1-based, weekdays 0-based). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is Sunday too.
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

function invalid(message: string): NovaError {
  return new NovaError('validation', `when.cron: ${message}`, { details: { field: 'when.cron' } });
}

export function parseCron(text: string): CronRule {
  const trimmed = text.trim();
  if (trimmed.startsWith('@')) {
    const expanded = MACROS[trimmed.toLowerCase()];
    if (!expanded) throw invalid(`unknown shorthand ${trimmed}`);
    return parseCron(expanded);
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5)
    throw invalid(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  const values = parts.map((p, i) => parseField(p, FIELDS[i]!));
  const weekdays = new Set([...values[4]!].map((d) => d % 7));
  return {
    minutes: [...values[0]!].sort((a, b) => a - b),
    hours: [...values[1]!].sort((a, b) => a - b),
    days: values[2]!,
    months: values[3]!,
    weekdays,
    domStar: parts[2]!.startsWith('*'),
    dowStar: parts[4]!.startsWith('*'),
  };
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(',')) {
    if (!item) throw invalid(`empty item in the ${spec.name} field`);
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined) throw invalid(`"${item}" in the ${spec.name} field has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw invalid(`step "${stepText}" in the ${spec.name} field must be a positive number`);
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = spec.min;
      hi = spec.name === 'day-of-week' ? 6 : spec.max;
    } else {
      const bounds = (range ?? '').split('-');
      if (bounds.length > 2 || bounds.some((b) => b === ''))
        throw invalid(`"${item}" is not a value or range in the ${spec.name} field`);
      lo = value(bounds[0]!, spec);
      hi = bounds.length === 2 ? value(bounds[1]!, spec) : stepText !== undefined ? spec.max : lo;
      if (hi < lo) throw invalid(`range "${range ?? ''}" in the ${spec.name} field runs backwards`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function value(text: string, spec: FieldSpec): number {
  let v: number;
  if (/^\d+$/.test(text)) v = Number(text);
  else {
    const idx = spec.names?.indexOf(text.toUpperCase()) ?? -1;
    if (idx < 0) throw invalid(`"${text}" is not valid in the ${spec.name} field`);
    v = idx + (spec.nameBase ?? 0);
  }
  if (v < spec.min || v > spec.max)
    throw invalid(`${text} is out of range ${spec.min}-${spec.max} in the ${spec.name} field`);
  return v;
}

/** Whether a local calendar day matches the day fields. */
export function cronDayMatches(rule: CronRule, day: number): boolean {
  const f = fieldsOf(day * DAY);
  if (!rule.months.has(f.mo)) return false;
  const dom = rule.days.has(f.d);
  const dow = rule.weekdays.has(f.wd);
  return rule.domStar || rule.dowStar ? dom && dow : dom || dow;
}

/**
 * Local times the rule fires at, ascending, from `fromNaive` on, for at most `horizonDays`
 * days (a rule like 30 February never matches; the horizon ends the search).
 */
export function* cronTimes(
  rule: CronRule,
  fromNaive: number,
  horizonDays: number,
): Generator<number> {
  const first = Math.floor(fromNaive / DAY);
  for (let day = first; day <= first + horizonDays; day++) {
    if (!cronDayMatches(rule, day)) continue;
    const base = day * DAY;
    for (const h of rule.hours) {
      for (const mi of rule.minutes) {
        const t = base + h * HOUR + mi * MINUTE;
        if (t >= fromNaive) yield t;
      }
    }
  }
}
