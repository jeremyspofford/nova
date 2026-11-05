// Config onboarding, door 2: the schema names the personal keys Nova really reads, with the same
// choices and defaults; Settings is drawn from it with each key's layer; a value that doesn't fit
// is a problem at every door and nothing applies; saving is the same checked path as a file; and
// "Use the default" deletes the key so the default shows through, tier 3 for privacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../src/core/db.ts';
import { Profile } from '../../src/core/profile.ts';
import { PRIVACY_MODES } from '../../src/core/envelope.ts';
import { DIRECTNESS, PROACTIVITY, WARMTH, identityOf } from '../../src/core/identity.ts';
import { FIELDS } from '../../src/core/config-schema.ts';
import { FORMAT, configRoutes, fieldsNow, plan } from '../../src/core/config-doors.ts';
import { CoreError } from '../../src/core/errors.ts';

const setup = () => { const db = new Db(':memory:'); db.migrate(); const p = new Profile(db); const said: string[] = []; return { p, said, routes: configRoutes({ profile: p, timezone: () => 'Europe/Berlin', log: (s) => said.push(s) }) }; };
const call = (r: ReturnType<typeof configRoutes>, path: string, body: Record<string, unknown>) => r.find((x) => x.path === path)!.handle({ params: {}, query: new URLSearchParams(), body, headers: {}, who: { principal: { kind: 'console' }, listener: 'console', address: 'console' } as never });
const field = (k: string) => FIELDS.find((f) => f.key === k)!;

test('the schema names keys Nova reads, with the same choices and defaults', () => {
  const opts = (k: string) => field(k).options!.map(([v]) => v);
  assert.deepEqual(opts('tuning.directness'), Object.keys(DIRECTNESS));
  assert.deepEqual(opts('tuning.warmth'), Object.keys(WARMTH));
  assert.deepEqual(opts('tuning.proactivity'), Object.keys(PROACTIVITY));
  assert.deepEqual(opts('privacy.default'), [...PRIVACY_MODES]);
  const { p } = setup();
  const i = identityOf(p);
  for (const [k, v] of [['identity.name', i.name], ['tuning.directness', i.directness], ['tuning.warmth', i.warmth], ['tuning.proactivity', i.proactivity], ['privacy.default', p.privacyDefault()]] as const) assert.equal(field(k).default, v, k);
});

test('Settings is drawn from it: the value, the default under it, and the layer that set it', () => {
  const { p } = setup();
  p.set('tuning', 'directness', 'blunt', 'setup');
  const f = Object.fromEntries(fieldsNow(p, 'Europe/Berlin').map((x) => [x.key, x]));
  assert.deepEqual([f['tuning.directness']!.value, f['tuning.directness']!.default, f['tuning.directness']!.layer], ['blunt', 'balanced', 'pack']);
  assert.deepEqual([f['user.timezone']!.value, f['user.timezone']!.layer], ['Europe/Berlin', 'default']);
  assert.ok(f['user.timezone']!.options!.some(([z]) => z === 'UTC'));
  assert.deepEqual([f['privacy.default']!.tier, f['policy.quiet_hours']!.tier, f['user.name']!.tier], [3, 3, 2]);
});

test('a value that doesn’t fit is a problem at every door, said plainly, and nothing applies', () => {
  const { p, routes } = setup();
  const r = plan(p, { format: FORMAT, settings: { tuning: { directness: 'very' }, policy: { quiet_hours: 'soon' }, user: { timezone: 'Mars/Olympus', name: 'Sam' } } });
  const all = r.problems.join(' ');
  assert.equal(r.problems.length, 3);
  assert.match(all, /“Directness” is one of “gentle”, “balanced”, “blunt” \(it says “very”\)/);
  assert.match(all, /“Quiet hours” are a start and an end, like 22:00–07:00 \(it says “soon”\)/);
  assert.match(all, /“Timezone” is a timezone/);
  assert.throws(() => call(routes, '/config/settings', { settings: { tuning: { directness: 'very' }, user: { name: 'Sam' } } }), (e: unknown) => e instanceof CoreError && /nothing changed/.test(e.message));
  assert.equal(p.get('user', 'name'), undefined, 'nothing applied');
  assert.deepEqual(plan(p, { format: FORMAT, settings: { tuning: { note: 'anything' }, user: { timezone: 'asia/tokyo' } } }).problems, [], 'unnamed keys pass as before; a zone in any case is a zone');
});

test('saving from Settings is the same checked path: tier 3 for privacy or policy, logged', () => {
  const { p, routes, said } = setup();
  const settings = { policy: { quiet_hours: { start: '22:00', end: '07:00' } }, tuning: { directness: 'blunt' } };
  assert.throws(() => call(routes, '/config/settings', { settings }), /tier 3/);
  assert.equal(p.get('tuning', 'directness'), undefined);
  assert.equal((call(routes, '/config/settings', { settings, confirm: true }) as { applied: number }).applied, 2);
  assert.deepEqual(p.get('policy', 'quiet_hours'), { start: '22:00', end: '07:00' });
  assert.equal((call(routes, '/config/settings', { settings: { tuning: { directness: 'gentle' } } }) as { applied: number }).applied, 1, 'tier 2 needs no confirm');
  assert.deepEqual(said, ['Changed 2 settings in Settings.', 'Changed 1 setting in Settings.']);
});

test('“Use the default” deletes the key so the default shows through; privacy asks every time', () => {
  const { p, routes, said } = setup();
  const seen: unknown[] = [];
  p.on('change', (c) => seen.push(c));
  p.set('tuning', 'directness', 'blunt', 'settings');
  p.set('privacy', 'default', 'cloud-allowed', 'settings');
  assert.deepEqual(call(routes, '/config/reset', { key: 'tuning.directness' }), { key: 'tuning.directness', removed: true });
  assert.equal(p.get('tuning', 'directness'), undefined);
  assert.equal(identityOf(p).directness, 'balanced');
  assert.throws(() => call(routes, '/config/reset', { key: 'privacy.default' }), /tier 3/);
  assert.equal(p.privacyDefault(), 'cloud-allowed', 'not without confirming');
  call(routes, '/config/reset', { key: 'privacy.default', confirm: true });
  assert.equal(p.privacyDefault(), 'local-only');
  assert.deepEqual(call(routes, '/config/reset', { key: 'tuning.directness' }), { key: 'tuning.directness', removed: false }, 'already the default: nothing to delete, nothing logged');
  assert.throws(() => call(routes, '/config/reset', { key: 'mesh.failover' }), /isn’t one of your settings/);
  assert.deepEqual(said, ['Put “Directness” back to Nova’s default.', 'Put “Privacy” back to Nova’s default.']);
  assert.deepEqual(seen, [{ section: 'tuning', key: 'directness' }, { section: 'privacy', key: 'default' }, { section: 'tuning', key: 'directness' }, { section: 'privacy', key: 'default' }], 'a delete is a change like any other');
});
