// Five-field cron expressions, in the person's timezone: parse, find the next
// run, and say it in words. "0 7 * * 1-5" → "Weekdays at 7:00 AM".
//
// Times are matched on the wall clock of the timezone. A time skipped by a
// daylight-saving change runs just after the change; a time that happens
// twice runs once, the first time.

export class CronError extends Error {}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of the week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

function value(token, f) {
  const named = f.names?.indexOf(token.toLowerCase());
  if (named >= 0) return named + (f.name === 'month' ? 1 : 0);
  if (!/^\d+$/.test(token)) throw new CronError(`“${token}” isn't a valid ${f.name}.`);
  const n = Number(token);
  if (n < f.min || n > f.max) throw new CronError(`${n} is out of range for the ${f.name} (${f.min}–${f.max}).`);
  return n;
}

function field(text, f) {
  const out = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`“${part}” has a step that isn't a whole number.`);
    let lo;
    let hi;
    if (range === '*') { lo = f.min; hi = f.max; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map((t) => value(t, f)); }
    else { lo = value(range, f); hi = stepText === undefined ? lo : f.max; }
    if (lo > hi) throw new CronError(`“${part}” runs backwards.`);
    for (let n = lo; n <= hi; n += step) out.add(f.name === 'day of the week' && n === 7 ? 0 : n);
  }
  return out;
}

export function parseCron(expr) {
  const text = String(expr ?? '').trim();
  const parts = (MACROS[text.toLowerCase()] ?? text).split(/\s+/);
  if (parts.length !== 5) throw new CronError('A schedule needs five parts: minute, hour, day of the month, month, day of the week.');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]));
  return { expr: parts.join(' '), parts, minute, hour, dom, month, dow, domAll: parts[2] === '*', dowAll: parts[4] === '*' };
}

// ---- wall clock ------------------------------------------------------------

const formatters = new Map();
function formatter(timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }));
  }
  return formatters.get(timezone);
}

// The wall-clock time at an instant, as a UTC timestamp with the same fields.
export function wallOf(instant, timezone) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
}

// The first instant whose wall-clock time is at or after `wall`.
function instantOf(wall, timezone) {
  const offset = (t) => wallOf(t, timezone) - Math.floor(t / 60_000) * 60_000;
  const candidates = [...new Set([wall - offset(wall), wall - offset(wall - offset(wall))])]
    .filter((t) => wallOf(t, timezone) >= wall)
    .sort((a, b) => a - b);
  return candidates[0] ?? wall - offset(wall);
}

const matchesDay = (c, d) => {
  const dom = c.dom.has(d.getUTCDate());
  const dow = c.dow.has(d.getUTCDay());
  // Classic cron: when both are restricted, either one will do.
  if (!c.domAll && !c.dowAll) return dom || dow;
  return dom && dow;
};

// The next run strictly after `after`, or null if the schedule never runs.
export function nextRun(cron, after, timezone) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const from = new Date(after).getTime();
  const d = new Date(Math.floor(wallOf(from, timezone) / 60_000) * 60_000 + 60_000);
  const limit = d.getTime() + 8 * 366 * 86_400_000;
  while (d.getTime() < limit) {
    if (!c.month.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0); continue; }
    if (!matchesDay(c, d)) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0); continue; }
    if (!c.hour.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0); continue; }
    if (!c.minute.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1); continue; }
    const at = instantOf(d.getTime(), timezone);
    if (at > from) return new Date(at);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

// The latest run at or before `now`, looking back no further than `since`.
export function lastRun(cron, since, now, timezone) {
  let at = nextRun(cron, since, timezone);
  let last = null;
  for (let i = 0; at && at <= now && i < 20_000; i++) { last = at; at = nextRun(cron, at, timezone); }
  return last;
}

// ---- in words ----------------------------------------------------------------

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sorted = (set) => [...set].sort((a, b) => a - b);
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export const timeOfDay = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

function daysPhrase(c) {
  const dow = sorted(c.dow);
  const dom = sorted(c.dom);
  const months = sorted(c.month);
  const everyMonth = months.length === 12;
  if (c.domAll && c.dowAll) return everyMonth ? 'Every day' : `Every day in ${and(months.map((m) => MONTHS[m - 1]))}`;
  if (!everyMonth && !(c.domAll === false && c.dowAll && months.length === 1)) return null;
  if (c.domAll) {
    if (dow.join() === '1,2,3,4,5') return 'Weekdays';
    if (dow.join() === '0,6') return 'Weekends';
    return and(dow.map((d) => DAYS[d]));
  }
  if (!c.dowAll || dom.length > 3) return null;
  if (months.length === 1) return `Every year on ${MONTHS[months[0] - 1]} ${and(dom.map(String))}`;
  return `On the ${and(dom.map(ordinal))} of every month`;
}

// "Weekdays" → "on weekdays", for the phrases that put the days second.
function onDays(days) {
  if (days === 'Every day') return '';
  if (days.startsWith('Every year')) return null;
  if (days === 'Weekdays' || days === 'Weekends') return ` on ${days.toLowerCase()}`;
  return ` ${days.startsWith('On ') ? days.replace(/^On/, 'on') : `on ${days}`}`;
}

export function describeCron(expr) {
  let c;
  try { c = parseCron(expr); } catch { return 'On a schedule Nova can’t read'; }
  const custom = `On a custom schedule (${c.expr})`;
  const minutes = sorted(c.minute);
  const hours = sorted(c.hour);
  const days = daysPhrase(c);
  if (!days) return custom;
  if (minutes.length === 1 && hours.length <= 4) return `${days} at ${and(hours.map((h) => timeOfDay(h, minutes[0])))}`;
  const on = onDays(days);
  if (on === null) return custom;
  const step = (text) => Number(text.match(/^\*\/(\d+)$/)?.[1] ?? 0);
  if (c.parts[1] === '*' && minutes.length === 1) return `Every hour${minutes[0] ? ` at :${String(minutes[0]).padStart(2, '0')}` : ', on the hour'}${on ? `,${on}` : ''}`;
  if (c.parts[1] === '*' && step(c.parts[0])) return `Every ${step(c.parts[0])} minutes${on}`;
  if (minutes.length === 1 && step(c.parts[1])) return `Every ${step(c.parts[1])} hours${on}`;
  return custom;
}
