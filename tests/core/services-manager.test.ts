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
function recording(name: string, o: { available?: boolean; refuse?: (d: ServiceDefinition) => string | null; apply?: 'ready' | 'failed' } = {}) {
  const calls: string[] = [];
  const st = new Map<string, ServiceStatus>();
  const driver: ServiceDriver = {
    name,
    available: () => (o.available === false ? { ok: false, said: `${name} isn’t here.` } : { ok: true, said: 'here' }),
    plan(def): ServicePlan {
      const why = o.refuse?.(def) ?? null;
      return { driver: name, service: def.service, version: def.version, tier: 2, ok: !why, refused: why ? [why] : [], where: 'test', steps: [] };
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
  assert.equal((await m.deploy(standIn({ version: '1', port: 18084 }))).ok, true);
  assert.deepEqual(m.versions('stand-in'), ['1']);
  assert.equal(m.definition('stand-in', '1')!.ports[0]!.port, 18084);
  const again = await m.deploy(standIn({ version: '1', port: 18085 }));
  assert.equal(again.ok, false);
  assert.match(again.said, /already registered with a different definition. A changed service is a new version/);
  assert.equal((await m.deploy(standIn({ version: '1', port: 18084 }))).ok, true, 'the same one again is fine');
});

test('promotion asks every time, typed: tier 2 for a service, tier 3 for the console or anything with secrets', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  await m.deploy(standIn({ version: '1', port: 18086 }));
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
  const d = recording('supervisor', { apply: 'failed' });
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  const r = await m.deploy(standIn({ version: '1', port: 18087 }));
  assert.equal(r.ok, false);
  const p = await m.promote('stand-in', '1', 'stand-in@1');
  assert.equal(p.ok, false);
  assert.match(p.said, /isn’t ready to promote \(it is failed\)/);
  assert.ok(!d.calls.some((c) => c.startsWith('switch')), 'never switched');
  assert.match((await m.promote('stand-in', '9', 'stand-in@9')).said, /isn’t registered/);
});

test('a rollback the person asks for wants the word rollback, and something kept to go back to', async () => {
  const d = recording('supervisor');
  const m = new ServiceManager({ dir: home(), drivers: [d.driver] });
  await m.deploy(standIn({ version: '1', port: 18088 }));
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
