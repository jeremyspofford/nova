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
// ended_at and text are optional: a time window is checked against the whole stretch when the
// source says when it ended, and a site against the screen text when the app is a browser.
export interface Facts { kind: Kind; at: string; ended_at?: string | null; device_id: string; source_id: string; app: string | null; window_title: string | null; url: string | null; text?: string | null; space?: string | null }

export const SPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAME = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 200;

// ---- private contexts ---------------------------------------------------------------------------

// Private and incognito windows, as the major browsers title them in English, French, German,
// Spanish, Italian, Portuguese and Dutch (and a few more). Best effort: a browser in another
// language, or one that doesn't put its private marker in the window title, isn't recognised, which
// is why Settings › Capture recommends Screenpipe's own ignored-windows setting too. Accents and
// case are folded first, so "Navigation privée" and "NAVIGATION PRIVEE" are the same. A source can
// also mark an event private itself; either way it is dropped before anything is stored.
const PRIVATE_MARKERS = [
  // Chrome, Chromium, Edge, Brave, Opera, Vivaldi: incognito and InPrivate, in most languages.
  'incognito', 'inkognito', 'inprivate',
  // English (Firefox, Safari, Brave, Opera, Vivaldi), and Firefox's own page.
  'private browsing', 'privatebrowsing', 'private window', 'private tab', '(private)',
  // French.
  'navigation privee', 'fenetre privee', 'onglet prive',
  // German.
  'privater modus', 'privates fenster', 'privates surfen', 'privater tab', 'privates tab',
  // Spanish.
  'navegacion privada', 'ventana privada', 'pestana privada',
  // Italian.
  'navigazione anonima', 'navigazione privata', 'finestra privata', 'finestra anonima', 'scheda privata',
  // Portuguese (Portugal and Brazil).
  'navegacao privada', 'navegacao privativa', 'navegacao anonima', 'janela privada', 'janela privativa', 'janela anonima', 'guia anonima', 'aba anonima',
  // Dutch.
  'privenavigatie', 'privevenster', 'prive-venster', 'prive venster', 'privetabblad',
  // A few more where Firefox and Chrome use their own words.
  'przegladanie prywatne', 'okno prywatne', 'privat surfning', 'privat fonster',
];
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');

// Checked on what the source sent, before anything is clipped: browsers put the marker at the end
// of a long title, past where a stored title would be cut.
export function isPrivate(raw: { private?: unknown; incognito?: unknown }, f: { app?: unknown; window_title?: unknown; url?: unknown }): boolean {
  if (raw.private === true || raw.incognito === true) return true;
  return [f.window_title, f.app, f.url].some((v) => typeof v === 'string' && PRIVATE_MARKERS.some((m) => fold(v).includes(m)));
}

// An instant only when the text says its own time zone (Z or an offset): "2026-10-29 10:00", with
// none, would be read in the server's zone, which is nobody's.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
export function instant(v: unknown): string | null {
  if (typeof v !== 'string' || !INSTANT.test(v.trim())) return null;
  const t = Date.parse(v.trim().replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
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

// Whether any moment from `at` to `ended` falls in a weekly window. A window starts and ends on a
// minute, so checking each minute's start is exact; a stretch of a week or more meets every window.
export function overlapsWindow(at: string, ended: string | null | undefined, w: Window, timezone: string): boolean {
  if (inWindow(at, w, timezone)) return true;
  const a = Date.parse(at);
  const b = ended ? Date.parse(ended) : NaN;
  if (Number.isNaN(b) || b <= a) return false;
  if (b - a >= 7 * 86_400_000) return true;
  for (let t = Math.floor(a / 60_000) * 60_000 + 60_000; t <= b; t += 60_000) {
    if (inWindow(new Date(t).toISOString(), w, timezone)) return true;
  }
  return false;
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
        const site = String(e.site ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.+$/, '').replace(/^www\./, '');
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(site)) throw new CoreError('validation', `${at} names a site, like example.org.`);
        return { kind: 'site', site, ...source };
      }
      case 'space': if (typeof e.space !== 'string' || !SPACE.test(e.space)) throw new CoreError('validation', `${at} names a space in lowercase letters, digits, - or _.`); return { kind: 'space', space: e.space, ...source };
      case 'time': return { kind: 'time', window: checkWindow((typeof e.window === 'object' && e.window !== null ? e.window : {}) as Record<string, unknown>, `${at}.window`), ...source };
      default: throw new CoreError('validation', `${at}.kind is one of ${EXCLUSION_KINDS.join(', ')}.`);
    }
  });
}

// A trailing dot ("bank.example.") is the same host, written fully qualified.
const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, ''); } catch { return null; }
};

// An app's name as people and operating systems vary it: case, extra spaces, a .exe or .app on the
// end. "Signal", "signal.exe" and "Signal.app" are one app.
export const appName = (v: string): string => v.trim().toLowerCase().replace(/\.(exe|app)$/, '').replace(/\s+/g, ' ').trim();
// An exclusion also covers the app's editions: "Signal" keeps out "Signal Beta" too. A word prefix,
// so "Signalling Tool" is a different app.
const appCovers = (rule: string, app: string) => { const r = appName(rule); const a = appName(app); return a === r || a.startsWith(`${r} `); };

// Browsers, by the names their windows report, so a site can be recognised in their screen text.
const BROWSER = /\b(browser|chrome|chromium|firefox|safari|edge|msedge|brave|opera|vivaldi|arc|librewolf|waterfox|zen|orion|duckduckgo|yandex|epiphany|floorp|mullvad)\b/;
// The site as a host in text: any subdomain, a trailing dot allowed, never part of a longer name
// ("notbank.example").
const hostIn = (site: string, text: string) => new RegExp(`(^|[^a-z0-9.-])([a-z0-9-]+\\.)*${site.replace(/\./g, '\\.')}\\.?($|[^a-z0-9-])`).test(text.toLowerCase());

// The exclusion that keeps an event out, or null. A site matches the event's address, a window
// title that names it (screen text often comes without the address), or, in a browser, the screen
// text itself. An app exclusion can't keep out audio, which has no app: a time window or a space
// can, and a time window covers the event's whole stretch when the source says when it ended.
export function excludedBy(f: Facts, rules: Exclusion[], timezone: string): Exclusion | null {
  const host = hostOf(f.url);
  const title = f.window_title ?? '';
  const browser = !!f.app && BROWSER.test(appName(f.app));
  for (const r of rules) {
    if (r.source && r.source !== f.source_id) continue;
    if (r.kind === 'app' && f.app && appCovers(r.app, f.app)) return r;
    if (r.kind === 'site' && ((host && (host === r.site || host.endsWith(`.${r.site}`))) || hostIn(r.site, title) || (browser && !!f.text && hostIn(r.site, f.text)))) return r;
    if (r.kind === 'space' && f.space === r.space) return r;
    if (r.kind === 'time' && overlapsWindow(f.at, f.ended_at, r.window, timezone)) return r;
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
    (s.kind === 'app' && !!f.app && appName(f.app) === appName(s.app))
    || (s.kind === 'device' && f.device_id === s.device)
    || (s.kind === 'calendar' && inWindow(f.at, s.window, timezone)));
  const spaces = new Set(hits.map((h) => h.space));
  if (spaces.size !== 1) return null;
  const [space] = spaces;
  return { space: space!, by: `signal:${[...new Set(hits.map((h) => h.kind))].join('+')}` };
}
