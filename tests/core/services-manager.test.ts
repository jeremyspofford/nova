// The Service Manager (M10e), against a recording driver, so its own rules are what is tested: it
// validates first, picks the first driver that can run a definition, registers each version once,
// asks before promotion (typed, every time) and offers only a version that passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceManager, consoleDefinition, type ServiceDefinition, type ServiceDriver, type ServicePlan, type ServiceStatus } from '../../src/core/index.ts';
import { standIn } from '../support/services.ts';

const home = () => mkdtempSync(join(tmpdir(), 'nova-services-'));

// A driver that records what it was asked and keeps statuses in memory.
function recording(name: string, o: { available?: boolean; refuse?: (d: ServiceDefinition) => string | null; apply?: 'ready' | 'failed' | 'rolled_back' } = {}) {
  const calls: string[] = [];
  const st = new Map<string, ServiceStatus>();
  const driver: ServiceDriver = {
    name,
    available: () => (o.available === false ? { ok: false, said: `${name} isn’t here.` } : { ok: true, said: 'here' }),
    plan(def): ServicePlan {
      const why = o.refuse?.(def) ?? null;
      const command = Object.values(def.artifact.program ?? {})[0]?.command;
      return { driver: name, service: def.service, version: def.version, tier: 2, ok: !why, refused: why ? [why] : [], where: 'test', steps: [], ...(command ? { command: ['/nova/node', ...command.slice(1)] } : {}) };
    },
    async apply(def) {
      calls.push(`apply ${def.service}@${def.version}`);
      const s = st.get(def.service) ?? { service: def.service, driver: name, live: null, previous: null, soak_until: null, held: null, health: { ok: null, checked_at: null, said: null }, stable: {}, versions: [], history: [] };
      s.versions = [...s.versions.filter((v) => v.version !== def.version), { version: def.version, status: o.apply ?? 'ready', since: '', said: null, ports: null, pid: null }];
      st.set(def.service, s);
      return { ok: o.apply !== 'failed', said: 'applied' };
    },
    status: (service) => [...st.values()].filter((s) => !service || s.service === service),
    async switch(service, version) {
      calls.push(`switch ${service}@${version}`);
      const s = st.get(service)!;
      s.previous = s.live;
      s.live = version;
      return { ok: true, said: 'switched' };
    },
    async rollback(service, r) {
      calls.push(`rollback ${service} auto=${r.auto}`);
      const s = st.get(service)!;
      s.live = s.previous;
      s.previous = null;
      return { ok: true, said: 'back' };
    },
  };
  return { driver, calls };
}

test('a definition that doesn’t validate never reaches a driver, and says why', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  const r = await m.deploy({ ...standIn({ version: '1', port: 18081 }), secrets: ['plain-value'] });
  assert.equal(r.ok, false);
  assert.match(r.said, /written as its value/);
  assert.deepEqual(d.calls, []);
});

test('the first driver that can run it is used; an unavailable one is passed over; a refusal says which driver and why', async () => {
  const off = recording('k3s', { available: false });
  const picky = recording('picky', { refuse: (def) => (def.artifact.image ? null : 'It has no image.') });
  const sup = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [off.driver, picky.driver, sup.driver] });
  const p = m.plan(standIn({ version: '1', port: 18082 }));
  assert.ok(p.ok && p.driver.name === 'supervisor', 'the supervisor ran it');
  const none = new ServiceManager({ dir: home(), drivers: [picky.driver] });
  const r = await none.deploy(standIn({ version: '1', port: 18083 }));
  assert.equal(r.ok, false);
  assert.match(r.said, /The picky driver can’t run stand-in 1: It has no image\./);
  assert.deepEqual(picky.calls, []);
});

test('each version is registered once: the same version with a different definition is refused', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  assert.equal((await m.deploy(standIn({ version: '1', port: 18084 }), undefined, 'stand-in@1')).ok, true);
  assert.deepEqual(m.versions('stand-in'), ['1']);
  assert.equal(m.definition('stand-in', '1')!.ports[0]!.port, 18084);
  const again = await m.deploy(standIn({ version: '1', port: 18085 }));
  assert.equal(again.ok, false);
  assert.match(again.said, /already registered with a different definition. A changed service is a new version/);
  assert.equal((await m.deploy(standIn({ version: '1', port: 18084 }), undefined, 'stand-in@1')).ok, true, 'the same one again is fine');
});

test('promotion asks every time, typed: tier 2 for a service, tier 3 for the console or anything with secrets', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  await m.deploy(standIn({ version: '1', port: 18086 }), undefined, 'stand-in@1');
  for (const confirm of [undefined, true, 'yes', 'stand-in@2']) {
    const r = await m.promote('stand-in', '1', confirm);
    assert.equal(r.ok, false, String(confirm));
    assert.equal(r.tier, 2);
    assert.match(r.said, /asks first: type stand-in@1/);
  }
  assert.ok(!d.calls.some((c) => c.startsWith('switch')), 'nothing moved');
  const ok = await m.promote('stand-in', '1', 'stand-in@1');
  assert.equal(ok.ok, true, ok.said);
  assert.deepEqual(d.calls, ['apply stand-in@1', 'switch stand-in@1']);

  const sec = recording('supervisor');
  const m3 = new ServiceManager({ dir: home(), drivers: [sec.driver] });
  await m3.deploy(consoleDefinition({ version: 'v2', port: 4317 }));
  const c = await m3.promote('nova-console', 'v2', 'yes');
  assert.equal(c.tier, 3);
  assert.match(c.said, /tier 3.*confirmed every time/);
});

test('only a version that passed its contract tests and health is offered', async () => {
  // Failed: never registered, so never offered.
  const d = recording('supervisor', { apply: 'failed' });
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  assert.equal((await m.deploy(standIn({ version: '1', port: 18087 }), undefined, 'stand-in@1')).ok, false);
  assert.match((await m.promote('stand-in', '1', 'stand-in@1')).said, /isn’t registered/);
  // Registered once, but not ready now (rolled back since): the manager itself refuses it.
  const r = recording('supervisor', { apply: 'rolled_back' });
  const m2 = new ServiceManager({ dir: home(), drivers: [r.driver] });
  assert.equal((await m2.deploy(standIn({ version: '1', port: 18087 }), undefined, 'stand-in@1')).ok, true);
  const p = await m2.promote('stand-in', '1', 'stand-in@1');
  assert.equal(p.ok, false);
  assert.match(p.said, /isn’t ready to promote \(it is rolled back\)/);
  assert.ok(!r.calls.some((c) => c.startsWith('switch')), 'never switched');
});

test('deploying a command no approved version has run asks first, typed, and shows it word for word; the approved command doesn’t ask', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  const v1 = standIn({ version: '1', port: 18089 });
  for (const confirm of [undefined, true, 'yes', 'stand-in@2']) {
    const r = await m.deploy(v1, undefined, confirm);
    assert.equal(r.ok, false, String(confirm));
    assert.equal(r.asks, true);
    assert.equal(r.tier, 2);
    assert.match(r.said, /runs a command no approved version of it has run: "\/nova\/node" "fake-service\.js"\. Running it, even alongside with no traffic, asks first \(tier 2\): type stand-in@1\./);
  }
  assert.deepEqual(d.calls, [], 'nothing ran');
  assert.equal((await m.deploy(v1, undefined, 'stand-in@1')).ok, true);
  assert.equal((await m.promote('stand-in', '1', 'stand-in@1')).ok, true);
  // 2 runs exactly 1's command: nothing new, no ask.
  assert.equal((await m.deploy(standIn({ version: '2', port: 18089 }))).ok, true);
  // 3 changes it: asked again, naming what the approved version is.
  const v3 = standIn({ version: '3', port: 18089, flags: ['--debug'] });
  const r3 = await m.deploy(v3);
  assert.equal(r3.ok, false);
  assert.match(r3.said, /runs a command that 1, the approved version, doesn’t: "\/nova\/node" "fake-service\.js" "--debug"/);
  assert.equal((await m.deploy(v3, undefined, 'stand-in@3')).ok, true);
  // Secrets or OS permissions make it tier 3.
  const v4 = standIn({ version: '4', port: 18089, flags: ['--x'], extra: { os_permissions: ['screen-recording'] } });
  assert.equal((await m.deploy(v4)).tier, 3);
});

test('a version is registered only once it has passed: one that failed can be deployed again, corrected', async () => {
  let fail = true;
  const d = recording('supervisor');
  const apply = d.driver.apply.bind(d.driver);
  d.driver.apply = async (def, say) => { const r = await apply(def, say); return fail ? { ok: false, said: 'its tests failed' } : r; };
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  assert.equal((await m.deploy(standIn({ version: '1', port: 18090 }), undefined, 'stand-in@1')).ok, false);
  assert.deepEqual(m.versions('stand-in'), [], 'not registered');
  fail = false;
  const fixed = await m.deploy(standIn({ version: '1', port: 18091 }), undefined, 'stand-in@1');
  assert.equal(fixed.ok, true, fixed.said);
  assert.equal(m.definition('stand-in', '1')!.ports[0]!.port, 18091);
});

test('a rollback the person asks for wants the word rollback, and something kept to go back to', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  await m.deploy(standIn({ version: '1', port: 18088 }), undefined, 'stand-in@1');
  await m.promote('stand-in', '1', 'stand-in@1');
  assert.match((await m.rollback('stand-in', 'rollback')).said, /no previous version kept/);
  await m.deploy(standIn({ version: '2', port: 18088 }));
  await m.promote('stand-in', '2', 'stand-in@2');
  assert.match((await m.rollback('stand-in', true)).said, /type rollback/);
  const r = await m.rollback('stand-in', 'rollback');
  assert.equal(r.ok, true, r.said);
  assert.equal(d.calls.at(-1), 'rollback stand-in auto=false');
  assert.equal(m.status()[0]!.live, '1');
});
