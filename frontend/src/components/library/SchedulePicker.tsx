/** When should this run? — a picker, not a number of minutes.
 *
 *  Jeremy, 2026-08-06: "scheduling things shouldn't just be a number of
 *  minutes, we should be able to set a date, or every monday, things like
 *  that, just like I might on apple's reminders app."
 *
 *  He hit it the same evening: he asked Nova to remind him "tomorrow", the
 *  only field that existed was `interval_minutes`, and tomorrow became a
 *  reminder that fires every day forever at whatever o'clock he happened to
 *  ask. Nothing in the UI could say otherwise either.
 *
 *  THE SHAPES ARE THE BACKEND'S. `every` and its fields mirror
 *  backend/app/schedules.py exactly, so the object this builds is the object
 *  that gets validated — no translation layer to drift. Anything this widget
 *  cannot express is still refused by field on the server with a sentence
 *  saying what to write instead.
 */
import { Schedule } from '../../api';

const DAYS: Array<[string, string]> = [
  ['mon', 'M'], ['tue', 'T'], ['wed', 'W'], ['thu', 'T'],
  ['fri', 'F'], ['sat', 'S'], ['sun', 'S'],
];

const KINDS: Array<[Schedule['every'], string]> = [
  ['once', 'Once'],
  ['day', 'Daily'],
  ['week', 'Weekly'],
  ['month', 'Monthly'],
  ['hour', 'Hourly'],
  ['minutes', 'Every N min'],
];

function today(): string {
  // Local date, not toISOString(): that converts to UTC first, so anyone west
  // of Greenwich gets yesterday for most of the evening.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A sensible spec for a kind the operator just picked, so switching tabs
 *  never lands on something the server would refuse. */
export function defaultsFor(every: Schedule['every']): Schedule {
  switch (every) {
    case 'once': return { every: 'once', date: tomorrow(), at: '09:00' };
    case 'day': return { every: 'day', at: '09:00' };
    case 'week': return { every: 'week', on: ['mon'], at: '09:00' };
    case 'month': return { every: 'month', day: 1, at: '09:00' };
    case 'hour': return { every: 'hour', n: 6, minute: 0 };
    default: return { every: 'minutes', n: 60 };
  }
}

/** The same sentence the backend's `describe()` produces, so the card, the
 *  tool result and this picker cannot disagree about what was set. */
export function describeSchedule(s: Schedule | null, intervalMinutes: number): string {
  if (!s) return `every ${intervalMinutes} minutes`;
  switch (s.every) {
    case 'minutes': return `every ${s.n} minutes`;
    case 'hour':
      return s.n === 1
        ? `every hour at :${String(s.minute).padStart(2, '0')}`
        : `every ${s.n} hours at :${String(s.minute).padStart(2, '0')}`;
    case 'day': return `every day at ${s.at}`;
    case 'week':
      return `every ${s.on.map(d => d[0].toUpperCase() + d.slice(1)).join(', ')} at ${s.at}`;
    case 'month': return `on day ${s.day} of each month at ${s.at}`;
    case 'once': return `once, on ${s.date} at ${s.at}`;
  }
}

export function SchedulePicker({ value, onChange }: {
  value: Schedule;
  onChange: (s: Schedule) => void;
}) {
  const time = (
    <input type="time" className="nova-input w-32"
      value={'at' in value ? value.at : '09:00'}
      onChange={e => onChange({ ...value, at: e.target.value } as Schedule)} />
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button"
            onClick={() => onChange(defaultsFor(k))}
            className={`px-2 py-1 rounded text-xs border ${
              value.every === k
                ? 'bg-nova-accent/20 border-nova-accent text-nova-fg'
                : 'border-nova-border text-nova-muted hover:text-nova-fg'}`}>
            {label}
          </button>
        ))}
      </div>

      {value.every === 'once' && (
        <div className="flex items-center gap-2">
          <input type="date" className="nova-input w-44" min={today()}
            value={value.date}
            onChange={e => onChange({ ...value, date: e.target.value })} />
          {time}
        </div>
      )}

      {value.every === 'day' && <div className="flex gap-2">{time}</div>}

      {value.every === 'week' && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1">
            {DAYS.map(([d, label], i) => (
              <button key={d} type="button"
                title={d}
                onClick={() => {
                  const on = value.on.includes(d)
                    ? value.on.filter(x => x !== d)
                    : [...value.on, d];
                  // Never empty: the server refuses `on: []`, and a picker
                  // that lets you reach a refused state is a picker that
                  // fails on save instead of at the click.
                  onChange({ ...value, on: on.length ? on : [d] });
                }}
                className={`w-7 h-7 rounded-full text-xs border ${
                  value.on.includes(d)
                    ? 'bg-nova-accent/20 border-nova-accent text-nova-fg'
                    : 'border-nova-border text-nova-muted'}`}>
                {label}{i === 1 || i === 3 ? '' : ''}
              </button>
            ))}
          </div>
          {time}
        </div>
      )}

      {value.every === 'month' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-nova-muted">day</span>
          <input type="number" min={1} max={31} className="nova-input w-20"
            value={value.day}
            onChange={e => onChange({ ...value, day: Math.min(31, Math.max(1, parseInt(e.target.value || '1'))) })} />
          {time}
          <span className="text-xs text-nova-muted">
            a day past the end of a short month runs on its last day
          </span>
        </div>
      )}

      {value.every === 'hour' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-nova-muted">every</span>
          <input type="number" min={1} max={23} className="nova-input w-20"
            value={value.n}
            onChange={e => onChange({ ...value, n: Math.max(1, parseInt(e.target.value || '1')) })} />
          <span className="text-xs text-nova-muted">hours, at minute</span>
          <input type="number" min={0} max={59} className="nova-input w-20"
            value={value.minute}
            onChange={e => onChange({ ...value, minute: Math.min(59, Math.max(0, parseInt(e.target.value || '0'))) })} />
        </div>
      )}

      {value.every === 'minutes' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-nova-muted">every</span>
          <input type="number" min={5} className="nova-input w-24"
            value={value.n}
            onChange={e => onChange({ ...value, n: Math.max(5, parseInt(e.target.value || '5')) })} />
          <span className="text-xs text-nova-muted">minutes (minimum 5)</span>
        </div>
      )}

      <div className="text-xs text-nova-muted">
        Runs {describeSchedule(value, 0)}
        {value.every === 'once' && ' — then switches itself off'}
        . Times are your local clock.
      </div>
    </div>
  );
}
