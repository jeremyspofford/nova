// The person's capture rules (CONTEXT-AND-CAPTURE), as pure functions so they can be tested alone:
// what is never stored (private contexts, exclusions per app, site, space and time window), and
// which space an event belongs to, decided only by signals the person set. Ambiguous activity stays
// unclassified: two signals that disagree, or none, mean no space, never a guess. Folder paths are
// never a signal.
import { CoreError } from '../errors.ts';
import { wallOf } from '../../cron.js';

export const KINDS = ['screen', 'audio', 'meeting', 'browser', 'app-activity', 'sensor'] as const;
export type Kind = (typeof KINDS)[number];

// What an exclusion or signal is checked against.
export interface Facts { kind: Kind; at: string; device_id: string; source_id: string; app: string | null; window_title: string | null; url: string | null; space?: string | null }

export const SPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAME = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 200;

// ---- private contexts ---------------------------------------------------------------------------

// Private and incognito windows as browsers title them. A source can also mark an event private
// itself; either way it is dropped before anything is stored.
const PRIVATE_TITLE = /\b(incognito|inprivate|private browsing|private window)\b|\(private\)/i;

export function isPrivate(raw: { private?: unknown; incognito?: unknown }, f: Pick<Facts, 'app' | 'window_title'>): boolean {
  return raw.private === true || raw.incognito === true || PRIVATE_TITLE.test(f.window_title ?? '') || PRIVATE_TITLE.test(f.app ?? '');
}

// ---- time windows ---------------------------------------------------------------------------------

export interface Window { days?: number[]; start: string; end: string }

const minutes = (hhmm: string) => { const m = HHMM.exec(hhmm)!; return Number(m[1]) * 60 + Number(m[2]); };

// Whether an instant falls in a weekly window, in the person's time zone. A window whose end is
// before its start runs past midnight (22:00–06:00), and belongs to the day it starts on.
export function inWindow(at: string, w: Window, timezone: string): boolean {
  const wall = new Date(wallOf(Date.parse(at), timezone));
  const day = wall.getUTCDay();
  const m = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const s = minutes(w.start);
  const e = minutes(w.end);
  const days = w.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
  if (s === e) return days.includes(day);
  if (s < e) return days.includes(day) && m >= s && m < e;
  return (days.includes(day) && m >= s) || (days.includes((day + 6) % 7) && m < e);
}

function checkWindow(w: Record<string, unknown>, at: string): Window {
  if (typeof w.start !== 'string' || !HHMM.test(w.start) || typeof w.end !== 'string' || !HHMM.test(w.end)) throw new CoreError('validation', `${at} needs a start and an end, like 12:00 and 13:00.`);
  if (w.days !== undefined && (!Array.isArray(w.days) || !w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) throw new CoreError('validation', `${at}.days are weekdays from 0 (Sunday) to 6 (Saturday).`);
  return { start: w.start, end: w.end, ...(Array.isArray(w.days) && w.days.length ? { days: [...new Set(w.days as number[])].sort() } : {}) };
}

// ---- exclusions -------------------------------------------------------------------------------------

export const EXCLUSION_KINDS = ['app', 'site', 'space', 'time'] as const;
export type Exclusion =
  | { kind: 'app'; app: string; source?: string }
  | { kind: 'site'; site: string; source?: string }
  | { kind: 'space'; space: string; source?: string }
  | { kind: 'time'; window: Window; source?: string };

export function checkExclusions(v: unknown): Exclusion[] {
  if (!Array.isArray(v) || v.length > 200) throw new CoreError('validation', 'exclusions is a list of up to 200 rules.');
  return v.map((x, i): Exclusion => {
    const e = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const at = `exclusions[${i}]`;
    const source = e.source === undefined || e.source === null ? {} : typeof e.source === 'string' && e.source ? { source: e.source } : (() => { throw new CoreError('validation', `${at}.source names a capture source, or is left out for all of them.`); })();
    switch (e.kind) {
      case 'app': if (!NAME(e.app)) throw new CoreError('validation', `${at} names an app.`); return { kind: 'app', app: String(e.app).trim(), ...source };
      case 'site': {
        const site = String(e.site ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(site)) throw new CoreError('validation', `${at} names a site, like example.org.`);
        return { kind: 'site', site, ...source };
      }
      case 'space': if (typeof e.space !== 'string' || !SPACE.test(e.space)) throw new CoreError('validation', `${at} names a space in lowercase letters, digits, - or _.`); return { kind: 'space', space: e.space, ...source };
      case 'time': return { kind: 'time', window: checkWindow((typeof e.window === 'object' && e.window !== null ? e.window : {}) as Record<string, unknown>, `${at}.window`), ...source };
      default: throw new CoreError('validation', `${at}.kind is one of ${EXCLUSION_KINDS.join(', ')}.`);
    }
  });
}

const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

// The exclusion that keeps an event out, or null. A site matches the event's address, or a window
// title that names it (screen text often comes without the address).
export function excludedBy(f: Facts, rules: Exclusion[], timezone: string): Exclusion | null {
  const host = hostOf(f.url);
  const title = (f.window_title ?? '').toLowerCase();
  for (const r of rules) {
    if (r.source && r.source !== f.source_id) continue;
    if (r.kind === 'app' && f.app && f.app.toLowerCase() === r.app.toLowerCase()) return r;
    if (r.kind === 'site' && ((host && (host === r.site || host.endsWith(`.${r.site}`))) || title.includes(r.site))) return r;
    if (r.kind === 'space' && f.space === r.space) return r;
    if (r.kind === 'time' && inWindow(f.at, r.window, timezone)) return r;
  }
  return null;
}

export const describeExclusion = (e: Exclusion): string =>
  e.kind === 'app' ? `the app ${e.app}` : e.kind === 'site' ? `the site ${e.site}` : e.kind === 'space' ? `the ${e.space} space` : `${e.window.start}–${e.window.end}${e.window.days ? ` on ${e.window.days.map((d) => DAY[d]).join(', ')}` : ' every day'}`;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- classification ---------------------------------------------------------------------------------

// The signals the person configures. "calendar" is a weekly block of time they name (their working
// hours, say); a calendar connection, when Nova has one, feeds the same signal. The explicit switch
// is kept separately (Switch) and wins over all of these while it is on.
export const SIGNAL_KINDS = ['app', 'device', 'calendar'] as const;
export type Signal =
  | { kind: 'app'; app: string; space: string }
  | { kind: 'device'; device: string; space: string }
  | { kind: 'calendar'; window: Window; space: string };
export interface Switch { space: string; since: string; until?: string | null }

export function checkSignals(v: unknown): Signal[] {
  if (!Array.isArray(v) || v.length > 200) throw new CoreError('validation', 'signals is a list of up to 200 rules.');
  return v.map((x, i): Signal => {
    const s = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const at = `signals[${i}]`;
    if (typeof s.space !== 'string' || !SPACE.test(s.space)) throw new CoreError('validation', `${at}.space is a space’s name in lowercase letters, digits, - or _.`);
    if (s.kind === 'app') { if (!NAME(s.app)) throw new CoreError('validation', `${at} names an app.`); return { kind: 'app', app: String(s.app).trim(), space: s.space }; }
    if (s.kind === 'device') { if (!NAME(s.device)) throw new CoreError('validation', `${at} names a device by its id.`); return { kind: 'device', device: String(s.device).trim(), space: s.space }; }
    if (s.kind === 'calendar') return { kind: 'calendar', window: checkWindow((typeof s.window === 'object' && s.window !== null ? s.window : {}) as Record<string, unknown>, `${at}.window`), space: s.space };
    throw new CoreError('validation', `${at}.kind is one of ${SIGNAL_KINDS.join(', ')}. Folder paths are never used.`);
  });
}

export function checkSwitch(v: unknown): Switch | null {
  if (v === null) return null;
  const s = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (typeof s.space !== 'string' || !SPACE.test(s.space)) throw new CoreError('validation', 'The switch names a space, or is null to turn it off.');
  const time = (t: unknown, what: string) => { if (typeof t !== 'string' || Number.isNaN(Date.parse(t))) throw new CoreError('validation', `${what} must be a time, like 2026-01-31T09:00:00Z.`); return new Date(t).toISOString(); };
  return { space: s.space, since: time(s.since, 'since'), ...(s.until == null ? {} : { until: time(s.until, 'until') }) };
}

// The space an event belongs to and why, or null when nothing the person set says, or what they
// set disagrees. The explicit switch wins while it is on.
export function classify(f: Facts, signals: Signal[], sw: Switch | null, timezone: string): { space: string; by: string } | null {
  if (sw && f.at >= sw.since && (!sw.until || f.at < sw.until)) return { space: sw.space, by: 'switch' };
  const hits = signals.filter((s) =>
    (s.kind === 'app' && !!f.app && f.app.toLowerCase() === s.app.toLowerCase())
    || (s.kind === 'device' && f.device_id === s.device)
    || (s.kind === 'calendar' && inWindow(f.at, s.window, timezone)));
  const spaces = new Set(hits.map((h) => h.space));
  if (spaces.size !== 1) return null;
  const [space] = spaces;
  return { space: space!, by: `signal:${[...new Set(hits.map((h) => h.kind))].join('+')}` };
}
