// Config onboarding, door 1 (owner direction 2026-11-04; design #303): a configuration file in and
// out. One source of truth stays the profile store: a file is only an import and export format.
// Importing is checked first and shown as a diff; nothing is applied from a file that doesn't
// validate, and a line with a secret in it is always left out (secrets live in the vault, named by
// secret:// references). Personal sections are "your pack"; the hub's own sections are set through
// their checked screens, so an imported file can't change them.
import { CoreError } from './errors.ts';
import { SECTIONS, type Profile, type Section } from './profile.ts';
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
      if (SECRET_NAME.test(name) || hasSecret(to)) changes.push({ key, section, name, layer: base.layer, refused: 'This line had a key or password in it. Secrets never go in a configuration file, so it was left out. Add it in Settings › Connections, where it goes to the vault.' });
      else if (section in HUB) changes.push({ ...base, refused: `The hub’s own settings are changed in ${HUB[section]}, where they are checked; this line was left out.` });
      else if (section === 'appearance' && name !== 'mode') changes.push({ ...base, refused: 'Designs are chosen in Settings › Appearance, so they are checked and can be rolled back; this line was left out.' });
      else if (section === 'policy' && name === 'task_tests') changes.push({ ...base, refused: 'Whether test commands ask first is set in Settings › Models and providers; this line was left out.' });
      else if (to === undefined || to === null) changes.push({ ...base, refused: 'An empty value changes nothing; to go back to a default, use “Use the default” in Settings.' });
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

export function configRoutes(o: { profile: Profile; log: (said: string, keys: string[]) => void }): Route[] {
  return [
    { method: 'GET', path: '/config/export', summary: 'Your settings as a configuration file (your pack): no secrets, only what you changed from the defaults.', handle: () => exportFile(o.profile) },
    { method: 'POST', path: '/config/import', summary: 'Check a configuration file and show what it would change, line by line; nothing is applied.', body: '{file}', handle: ({ body }) => plan(o.profile, body.file) },
    {
      method: 'POST', path: '/config/apply', summary: 'Apply a checked configuration file. Tier 2; tier 3 ({confirm: true}) when it changes privacy or what asks first.', body: '{file, confirm?}',
      handle: ({ body }) => {
        const p = plan(o.profile, body.file);
        if (p.problems.length) throw new CoreError('validation', 'This file can’t be used, so nothing changed.', p.problems);
        if (p.tier === 3 && body.confirm !== true) throw new CoreError('validation', 'This changes what stays private or what asks first (tier 3): confirm it every time (confirm: true).');
        const applied = p.changes.filter((c) => !c.refused);
        for (const c of applied) o.profile.set(c.section as Section, c.name, c.to, 'import');
        if (applied.length) o.log(`Imported ${applied.length} setting${applied.length === 1 ? '' : 's'} from a configuration file.`, applied.map((c) => c.key));
        return { ...p, applied: applied.length };
      },
    },
  ];
}
