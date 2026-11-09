// Config onboarding, door 1 (owner direction 2026-11-04; design #303): a configuration file in and
// out. One source of truth stays the profile store: a file is only an import and export format.
// Importing is checked first and shown as a diff; nothing is applied from a file that doesn't
// validate, and a line with a secret in it is always left out (secrets live in the vault, named by
// secret:// references). Personal sections are "your pack"; the hub's own sections are set through
// their checked screens, so an imported file can't change them.
import { CoreError } from './errors.ts';
import { SECTIONS, type Profile, type Section, type Source } from './profile.ts';
import { FIELDS, invalid } from './config-schema.ts';
import type { Route } from './api.ts';

export const FORMAT = 'nova-config/1';
const PACK: readonly Section[] = ['identity', 'user', 'tuning', 'privacy', 'policy', 'appearance'];
const HUB: Record<string, string> = {
  mesh: 'Settings › Devices', providers: 'Settings › Models and providers', capture: 'Settings › Capture',
  models: 'Settings › Models and providers', backups: 'Settings › Backups and changes',
};
// Loosening these is tier 3: what stays local, and what asks first.
const GATES: readonly Section[] = ['privacy', 'policy'];
const SECRET_NAME = /(^|[_-])(key|token|secret|password|passwd|passphrase|api[_-]?key|credential)s?$/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}|^[A-Za-z0-9+/_-]{40,}={0,2}$/;
const MAX_BYTES = 256 * 1024;

export interface Change { key: string; section: string; name: string; from?: unknown; to?: unknown; layer: 'pack' | 'hub'; refused?: string }
export interface Plan { changes: Change[]; problems: string[]; tier: 2 | 3 }

const hasSecret = (v: unknown): boolean => typeof v === 'string' ? SECRET_VALUE.test(v) && !v.startsWith('secret://')
  : Array.isArray(v) ? v.some(hasSecret) : !!v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => (SECRET_NAME.test(k) && typeof x === 'string' && !x.startsWith('secret://')) || hasSecret(x)) : false;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// The nearest section name, for "did you mean".
function nearest(name: string): string | null {
  const d = (a: string, b: string) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) m[0]![j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i]![j] = Math.min(m[i - 1]![j]! + 1, m[i]![j - 1]! + 1, m[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); return m[a.length]![b.length]!; };
  const best = SECTIONS.filter((s) => s !== 'setup').map((s) => [s, d(name, s)] as const).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

// What a file would change, checked: file-level problems (nothing applies), and per line, the
// change or why it is left out.
export function plan(profile: Profile, file: unknown): Plan {
  const problems: string[] = [];
  const changes: Change[] = [];
  if (!file || typeof file !== 'object' || Array.isArray(file)) return { changes, problems: ['A configuration file is a JSON object.'], tier: 2 };
  const f = file as Record<string, unknown>;
  if (JSON.stringify(f).length > MAX_BYTES) problems.push(`The file is over ${MAX_BYTES / 1024} KB; a configuration is much smaller.`);
  if (f.format !== FORMAT) problems.push(`This isn’t a Nova configuration (“format” must be “${FORMAT}”; it says ${f.format === undefined ? 'nothing' : `“${String(f.format)}”`}).`);
  const settings = f.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) problems.push('“settings” must be an object of sections, each an object of settings.');
  if (problems.length) return { changes, problems, tier: 2 };
  for (const [section, values] of Object.entries(settings as Record<string, unknown>)) {
    if (!SECTIONS.includes(section as Section) || section === 'setup') {
      const near = nearest(section);
      problems.push(`There is no section called “${section}”.${near ? ` Did you mean “${near}”?` : ''}`);
      continue;
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) { problems.push(`“${section}” must be an object of settings.`); continue; }
    for (const [name, to] of Object.entries(values as Record<string, unknown>)) {
      const key = `${section}.${name}`;
      const from = profile.get(section as Section, name);
      const base = { key, section, name, from, to, layer: (section in HUB ? 'hub' : 'pack') as Change['layer'] };
      const wrong = invalid(key, to);
      if (SECRET_NAME.test(name) || hasSecret(to)) changes.push({ key, section, name, layer: base.layer, refused: 'This line had a key or password in it. Secrets never go in a configuration file, so it was left out. Add it in Settings › Connections, where it goes to the vault.' });
      else if (section in HUB) changes.push({ ...base, refused: `The hub’s own settings are changed in ${HUB[section]}, where they are checked; this line was left out.` });
      else if (section === 'appearance' && name !== 'mode') changes.push({ ...base, refused: 'Designs are chosen in Settings › Appearance, so they are checked and can be rolled back; this line was left out.' });
      else if (section === 'policy' && name === 'task_tests') changes.push({ ...base, refused: 'Whether test commands ask first is set in Settings › Models and providers; this line was left out.' });
      else if (section === 'policy' && name === 'approvals') changes.push({ ...base, refused: 'Approval tiers are set through /api/v1/approvals, where floors and confirmations are checked; this line was left out.' });
      else if (to === undefined || to === null) changes.push({ ...base, refused: 'An empty value changes nothing; to go back to a default, use “Use the default” in Settings.' });
      // A value the schema says doesn't fit: the whole thing applies nothing (design #303).
      else if (wrong) problems.push(wrong);
      else if (!same(from, to)) changes.push(base);
    }
  }
  const applied = changes.filter((c) => !c.refused);
  return { changes, problems, tier: applied.some((c) => GATES.includes(c.section as Section)) ? 3 : 2 };
}

export function exportFile(profile: Profile) {
  const settings = Object.fromEntries(PACK.map((s) => [s, Object.fromEntries(Object.entries(profile.section(s)).filter(([k, v]) => !SECRET_NAME.test(k) && !hasSecret(v)))]).filter(([, v]) => Object.keys(v as object).length));
  return { format: FORMAT, exported_at: new Date().toISOString(), settings };
}

interface Opts { profile: Profile; log: (said: string, keys: string[]) => void; timezone?: () => string }
const many = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const TIER3 = 'This changes what stays private or what asks first (tier 3): confirm it every time (confirm: true).';

// Every door applies through here: nothing at all if anything is wrong, tier 3 only when confirmed.
function applyChecked(o: Opts, file: unknown, confirm: unknown, source: Source, what: string, said: (n: number) => string) {
  const p = plan(o.profile, file);
  if (p.problems.length) throw new CoreError('validation', `${what} can’t be used, so nothing changed.`, p.problems);
  if (p.tier === 3 && confirm !== true) throw new CoreError('validation', TIER3);
  const applied = p.changes.filter((c) => !c.refused);
  for (const c of applied) o.profile.set(c.section as Section, c.name, c.to, source);
  if (applied.length) o.log(said(applied.length), applied.map((c) => c.key));
  return { ...p, applied: applied.length };
}

// Your settings as Settings draws them: each schema key with its value now, the default under it,
// and the layer that set it. Only one overlay exists today (the profile: your pack); "This hub"
// comes with the hub's own layer.
export function fieldsNow(profile: Profile, zone: string) {
  return FIELDS.map((f) => {
    const set = profile.get(f.section, f.name);
    const fallback = f.key === 'user.timezone' ? zone : f.default;
    // The value in force is always offered, even spelt another way (a chat may say "asia/tokyo").
    const options = f.type === 'timezone'
      ? [...new Set([set, fallback, 'UTC', ...Intl.supportedValuesOf('timeZone')])].filter((z): z is string => typeof z === 'string').map((z): [string, string] => [z, z])
      : f.options;
    return { ...f, options, default: fallback, value: set ?? fallback, layer: set === undefined ? 'default' : 'pack', tier: GATES.includes(f.section) ? 3 : 2 };
  });
}

export function configRoutes(o: Opts): Route[] {
  return [
    { method: 'GET', path: '/config/export', summary: 'Your settings as a configuration file (your pack): no secrets, only what you changed from the defaults.', handle: () => exportFile(o.profile) },
    { method: 'POST', path: '/config/import', summary: 'Check a configuration file and show what it would change, line by line; nothing is applied.', body: '{file}', handle: ({ body }) => plan(o.profile, body.file) },
    {
      method: 'POST', path: '/config/apply', summary: 'Apply a checked configuration file. Tier 2; tier 3 ({confirm: true}) when it changes privacy or what asks first.', body: '{file, confirm?}',
      handle: ({ body }) => applyChecked(o, body.file, body.confirm, 'import', 'This file', (n) => `Imported ${many(n, 'setting')} from a configuration file.`),
    },
    // ---- door 2: Settings drawn from the schema, and the guided questions ----
    { method: 'GET', path: '/config/schema', summary: 'Your own settings as Settings draws them: each with its words, what it allows, its value now, its default and the layer that set it.', handle: () => ({ fields: fieldsNow(o.profile, o.timezone?.() ?? 'UTC') }) },
    {
      method: 'POST', path: '/config/settings', summary: 'Save settings from Settings or the guided questions, through the same check as a file. Tier 2; tier 3 ({confirm: true}) when it changes privacy or what asks first.', body: '{settings, confirm?}',
      handle: ({ body }) => applyChecked(o, { format: FORMAT, settings: body.settings }, body.confirm, 'settings', 'These settings', (n) => `Changed ${many(n, 'setting')} in Settings.`),
    },
    {
      method: 'POST', path: '/config/reset', summary: 'Put one of your settings back to Nova’s default: its record is deleted, so the default shows through. Tier 3 ({confirm: true}) for privacy or what asks first.', body: '{key, confirm?}',
      handle: ({ body }) => {
        const f = FIELDS.find((x) => x.key === body.key);
        if (!f) throw new CoreError('validation', `“${String(body.key)}” isn’t one of your settings that can go back to a default.`);
        if (GATES.includes(f.section) && body.confirm !== true) throw new CoreError('validation', TIER3);
        const removed = o.profile.delete(f.section, f.name);
        if (removed) o.log(`Put “${f.label}” back to Nova’s default.`, [f.key]);
        return { key: f.key, removed };
      },
    },
  ];
}
