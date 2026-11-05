// Your own settings' schema (config onboarding, door 2; drafted in docs/plans/config-schema-2026-11-04.md):
// the personal keys Nova really reads today, in plain words, with what each allows and its
// default. Settings is drawn from it, the guided questions are its steps, and every door (a file,
// the form, a chat) checks a value against it before anything applies. A key it doesn't name
// passes as before; the hub's own sections never come through here.
import { DEFAULTS } from './identity.ts';
import { validTimezone } from './setup.ts';
import type { Section } from './profile.ts';

export interface Field {
  key: string; section: Section; name: string;
  step: string;                       // the guided question it is asked in
  label: string; help: string;
  type: 'text' | 'timezone' | 'choice' | 'hours';
  options?: [string, string][];       // choice: [value, words]
  max?: number;                       // text: as identityOf cuts it
  default: unknown;                   // null: nothing set; user.timezone's is the hub's (config-doors.ts)
}

const WHERE = 'Where and when';
const TALK = 'How Nova talks';
const PRIVACY = 'Privacy';

export const FIELDS: readonly Field[] = [
  { key: 'user.timezone', section: 'user', name: 'timezone', step: WHERE, label: 'Timezone', help: 'Times, schedules and quiet hours follow it.', type: 'timezone', default: null },
  // Read by triggers.ts #quiet: a message that can wait is held until they end.
  { key: 'policy.quiet_hours', section: 'policy', name: 'quiet_hours', step: WHERE, label: 'Quiet hours', help: 'Messages that can wait are held until they end. Write them like 22:00–07:00.', type: 'hours', default: null },
  { key: 'user.name', section: 'user', name: 'name', step: TALK, label: 'Your name', help: 'Your name, as Nova knows it.', type: 'text', max: 80, default: null },
  { key: 'user.address_as', section: 'user', name: 'address_as', step: TALK, label: 'What Nova calls you', help: 'Only if it isn’t your name.', type: 'text', max: 80, default: null },
  { key: 'identity.name', section: 'identity', name: 'name', step: TALK, label: 'Nova’s name', help: 'Only the name changes; the charter stays.', type: 'text', max: 40, default: DEFAULTS.name },
  { key: 'tuning.directness', section: 'tuning', name: 'directness', step: TALK, label: 'Directness', help: 'Telling you when Nova thinks something’s wrong isn’t adjustable; this is how it says it.', type: 'choice', options: [['gentle', 'Gently'], ['balanced', 'Plainly'], ['blunt', 'Bluntly']], default: DEFAULTS.directness },
  { key: 'tuning.warmth', section: 'tuning', name: 'warmth', step: TALK, label: 'Warmth', help: 'How Nova sounds when it talks to you.', type: 'choice', options: [['reserved', 'Even and professional'], ['warm', 'Warm']], default: DEFAULTS.warmth },
  { key: 'tuning.proactivity', section: 'tuning', name: 'proactivity', step: TALK, label: 'Speaking up', help: 'Whether Nova brings things up on its own, within your policy.', type: 'choice', options: [['quiet', 'Only when asked'], ['ask-first', 'Offers, and asks before acting'], ['proactive', 'Brings up what matters']], default: DEFAULTS.proactivity },
  { key: 'privacy.default', section: 'privacy', name: 'default', step: PRIVACY, label: 'Privacy', help: 'The default for every task. A task can be stricter, never looser.', type: 'choice', options: [['local-only', 'Local-only'], ['local-preferred', 'Local first'], ['cloud-allowed', 'Cloud allowed']], default: 'local-only' },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const said = (v: unknown) => (typeof v === 'string' ? (v.trim() ? `“${v.slice(0, 40)}”` : 'nothing') : (JSON.stringify(v) ?? 'nothing').slice(0, 60));

// Why a value can't be used for this key, in plain words; null when it can, or when the schema
// doesn't name the key.
export function invalid(key: string, v: unknown): string | null {
  const f = BY_KEY.get(key);
  if (!f) return null;
  const it = `(it says ${said(v)})`;
  if (f.type === 'text') return typeof v === 'string' && v.trim() && v.trim().length <= f.max! && !/[<>{}\n]/.test(v) ? null : `“${f.label}” is a name of up to ${f.max} characters on one line ${it}. To clear it, use “Use the default”.`;
  if (f.type === 'timezone') return typeof v === 'string' && validTimezone(v) ? null : `“${f.label}” is a timezone, like Europe/Berlin or UTC ${it}.`;
  if (f.type === 'choice') return f.options!.some(([o]) => o === v) ? null : `“${f.label}” is one of ${f.options!.map(([o]) => `“${o}”`).join(', ')} ${it}.`;
  const q = v as { start?: unknown; end?: unknown } | null;
  return q && typeof q === 'object' && HHMM.test(String(q.start)) && HHMM.test(String(q.end)) && q.start !== q.end ? null : `“${f.label}” are a start and an end, like 22:00–07:00 ${it}. To have none, use “Use the default”.`;
}
