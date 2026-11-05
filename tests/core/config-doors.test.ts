// Config onboarding, door 1: a file is checked and shown as a diff before anything applies; a
// broken file applies nothing; secrets and the hub's own settings are left out, saying why; a
// change to privacy or what asks first is tier 3; export is the same format back out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../src/core/db.ts';
import { Profile } from '../../src/core/profile.ts';
import { FORMAT, configRoutes, exportFile, plan } from '../../src/core/config-doors.ts';
import { CoreError } from '../../src/core/errors.ts';

const setup = () => { const db = new Db(':memory:'); db.migrate(); const p = new Profile(db); const said: string[] = []; return { p, said, routes: configRoutes({ profile: p, log: (s) => said.push(s) }) }; };
const route = (r: ReturnType<typeof configRoutes>, path: string) => r.find((x) => x.path === path)!;
const call = (r: ReturnType<typeof configRoutes>, path: string, body: Record<string, unknown>) => route(r, path).handle({ params: {}, query: new URLSearchParams(), body, headers: {}, who: { principal: { kind: 'console' }, listener: 'console', address: 'console' } as never });

test('a file is checked first: the diff, secrets and hub settings left out, saying why', () => {
  const { p } = setup();
  p.set('user', 'timezone', 'UTC', 'settings');
  const r = plan(p, { format: FORMAT, settings: { user: { timezone: 'America/New_York', name: 'Alex' }, mesh: { failover: 'auto' }, identity: { api_key: 'not-in-a-file' }, tuning: { note: 'sk-abcdefghijklmnopqrstuvwxyz' } } });
  assert.deepEqual(r.problems, []);
  const by = Object.fromEntries(r.changes.map((c) => [c.key, c]));
  assert.deepEqual([by['user.timezone']!.from, by['user.timezone']!.to, by['user.timezone']!.layer], ['UTC', 'America/New_York', 'pack']);
  assert.equal(by['user.name']!.from, undefined);
  assert.match(by['mesh.failover']!.refused!, /Settings › Devices/);
  assert.match(by['identity.api_key']!.refused!, /Secrets never go in a configuration file/);
  assert.match(by['tuning.note']!.refused!, /Secrets never go/);
  assert.equal(r.tier, 2);
});

test('a broken file applies nothing; an unknown section gets the nearest name', () => {
  const { p, routes } = setup();
  assert.match(plan(p, { format: 'other', settings: {} }).problems[0]!, /isn’t a Nova configuration/);
  assert.deepEqual(plan(p, { format: FORMAT, settings: { usr: { name: 'x' } } }).problems, ['There is no section called “usr”. Did you mean “user”?']);
  assert.throws(() => call(routes, '/config/apply', { file: { format: FORMAT, settings: { usr: { name: 'x' }, user: { name: 'Alex' } } } }), (e: unknown) => e instanceof CoreError && /nothing changed/.test(e.message));
  assert.equal(p.get('user', 'name'), undefined, 'nothing applied from a file with a problem');
});

test('privacy or what asks first is tier 3; applied lines are logged; export round-trips', () => {
  const { p, routes, said } = setup();
  const file = { format: FORMAT, settings: { privacy: { default: 'cloud-allowed' }, user: { name: 'Alex' } } };
  assert.equal(plan(p, file).tier, 3);
  assert.throws(() => call(routes, '/config/apply', { file }), /tier 3/);
  const out = call(routes, '/config/apply', { file, confirm: true }) as { applied: number };
  assert.equal(out.applied, 2);
  assert.equal(p.get('privacy', 'default'), 'cloud-allowed');
  assert.deepEqual(said, ['Imported 2 settings from a configuration file.']);
  const back = exportFile(p);
  assert.equal(back.format, FORMAT);
  assert.deepEqual(back.settings, { user: { name: 'Alex' }, privacy: { default: 'cloud-allowed' } });
  assert.deepEqual(plan(p, back).changes, [], 'importing the export changes nothing');
});
