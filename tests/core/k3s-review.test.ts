import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { K3sDriver, serviceExpected, type ClusterTools } from '../../src/core/index.ts';
import { simulatedK3s } from '../support/k3s.ts';

async function livePair(h: Awaited<ReturnType<typeof simulatedK3s>>, soak?: number) {
  assert.equal((await h.driver.apply(h.definition('1'))).ok, true);
  assert.equal((await h.driver.switch('echo', '1')).ok, true);
  assert.equal((await h.driver.apply({ ...h.definition('2'), ...(soak === undefined ? {} : { soak_s: soak }) })).ok, true);
}

test('queued approved state and changed previous rollback target are checked inside serialization', async () => {
  const h = await simulatedK3s();
  try {
    await livePair(h);
    const expected = serviceExpected(h.driver.status('echo')[0]!);
    let release!: () => void;
    let entered!: () => void;
    const atCanary = new Promise<void>(r => { entered = r; });
    h.clock.onSleep = async () => { h.clock.onSleep = null; entered(); await new Promise<void>(r => { release = r; }); };
    const switching = h.driver.switch('echo', '2', undefined, expected);
    await atCanary;
    const queued = h.driver.rollback('echo', { auto: false, reason: 'approved old state', expected });
    release();
    assert.equal((await switching).ok, true);
    assert.equal((await queued).ok, false);
    assert.equal(await h.serving(), '2');
    const approved = serviceExpected(h.driver.status('echo')[0]!);
    h.change(s => { s.services.echo!.previous = null; s.services.echo!.revision++; });
    assert.equal((await h.driver.rollback('echo', { auto: false, reason: 'stale previous', expected: approved })).ok, false);
    assert.equal(await h.serving(), '2');
  } finally { await h.close(); }
});

test('two driver owners cannot consume the same expected state twice', async () => {
  const h = await simulatedK3s();
  try {
    await livePair(h);
    const other = h.another();
    await other.refresh('echo');
    const expected = serviceExpected(h.driver.status('echo')[0]!);
    const results = await Promise.all([h.driver.switch('echo', '2', undefined, expected), other.switch('echo', '2', undefined, expected)]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(await h.serving(), '2');
  } finally { await h.close(); }
});

test('server rejects drift between the driver read and the atomic selector update', async () => {
  const h = await simulatedK3s();
  try {
    await h.driver.apply(h.definition('1'));
    const tools: ClusterTools = { available: h.tools.available, execute: async (op, signal) => {
      if (op.operation === 'switch') h.change(s => { s.services.echo!.revision++; });
      return h.tools.execute(op, signal);
    } };
    const driver = new K3sDriver({ ...h.options, tools });
    try { assert.equal((await driver.switch('echo', '1')).ok, false); assert.equal(await h.serving(), null); }
    finally { await driver.close(); }
  } finally { await h.close(); }
});

test('fresh failures, malformed, stale and out-of-order status never freshen prior health/readiness', async () => {
  const h = await simulatedK3s();
  try {
    await h.driver.apply(h.definition('1'));
    const before = h.driver.status('echo')[0]!;
    const row = h.read().services.echo!;
    for (const corrupt of [null, {}, { ...row, observed_at: 'bad' }, { ...row, sequence: row.sequence - 1 }, { ...row, observed_at: new Date(h.clock.now() - 60_000).toISOString(), sequence: row.sequence + 10 }, { ...row, versions: [{ ...row.versions[0], ready: true, replicas: 0 }] }]) {
      // null is an actual invalid JSON response, not an absent override.
      h.change(s => { s.statusOverride = corrupt; });
      h.clock.advance(100);
      assert.equal((await h.driver.refresh('echo')).ok, false);
      const after = h.driver.status('echo')[0]!;
      assert.equal(after.observed_at, before.observed_at);
      assert.deepEqual(after.readiness, before.readiness);
      assert.deepEqual(after.health, before.health);
      assert.ok(after.failure);
    }
    h.change(s => { delete s.statusOverride; });
    assert.equal((await h.driver.refresh('echo')).ok, true);
    assert.equal(h.driver.status('echo')[0]!.failure, null);
  } finally { await h.close(); }
});

test('soak uses observed health: unknown keeps previous, healthy expiry removes it, failure rolls back without prepare', async () => {
  const h = await simulatedK3s();
  try {
    await livePair(h, 30);
    await h.driver.switch('echo', '2');
    h.change(s => { s.unknown = ['2']; }); h.clock.advance(30_001);
    await h.driver.refresh('echo');
    assert.equal(h.driver.status('echo')[0]!.health.ok, null);
    assert.equal(h.driver.status('echo')[0]!.previous, '1');
    h.change(s => { s.unknown = []; });
    await h.driver.refresh('echo');
    assert.equal(h.driver.status('echo')[0]!.previous, null);
    assert.equal(h.driver.status('echo')[0]!.versions.find(v => v.version === '1')!.status, 'removed');
  } finally { await h.close(); }
  const failed = await simulatedK3s();
  try {
    await livePair(failed); await failed.driver.switch('echo', '2');
    const prepared = failed.calls().filter(c => c.operation === 'prepare').length;
    failed.change(s => { s.unhealthy = ['2']; });
    failed.clock.advance(5000); failed.clock.fire();
    await failed.driver.refresh('echo');
    assert.equal(await failed.serving(), '1');
    assert.equal(failed.calls().filter(c => c.operation === 'prepare').length, prepared);
  } finally { await failed.close(); }
});

test('missing network authority, unsafe probe paths and redirects refuse with no escaping request', async () => {
  const h = await simulatedK3s();
  try {
    const noAuthority = new K3sDriver({ ...h.options, authorizeNetwork: undefined });
    assert.equal((await noAuthority.apply(h.definition('1'))).ok, false);
    assert.deepEqual(h.calls(), []); await noAuthority.close();
    for (const path of ['//127.0.0.1:1/', '/%2f%2finvalid', '/a/../stable', '/a\\b']) {
      assert.equal((await h.driver.apply({ ...h.definition('1'), health: { http: path, every_s: 5 } })).ok, false);
    }
    assert.deepEqual(h.calls(), []);
    assert.equal((await h.driver.apply({ ...h.definition('1'), contract_tests: ['http:/redirect'] })).ok, false);
    assert.equal(h.driver.status('echo')[0]!.versions[0]!.status, 'failed');
    assert.throws(() => new K3sDriver({ ...h.options, probeOrigin: 'http://invalid.example/' }), /loopback/);
  } finally { await h.close(); }
});

test('immutable definitions survive restart; close cancels timers; uncertain completion is reconciled without replay', async () => {
  const h = await simulatedK3s();
  try {
    const tools: ClusterTools = { available: h.tools.available, execute: async (op, signal) => { const result = await h.tools.execute(op, signal); if (op.operation === 'prepare') throw new Error('lost reply'); return result; } };
    const uncertain = new K3sDriver({ ...h.options, tools });
    assert.equal((await uncertain.apply(h.definition('1'))).ok, false);
    assert.equal((await uncertain.apply(h.definition('1'))).ok, false);
    assert.equal(h.calls().filter(c => c.tool === 'kubectl' && c.operation === 'prepare').length, 1);
    await uncertain.close();
    assert.equal((await h.driver.apply({ ...h.definition('1'), health: { http: '/changed', every_s: 5 } })).ok, false);
    const restarted = h.another(); await restarted.refresh('echo');
    assert.equal(restarted.status('echo')[0]!.versions[0]!.status, 'alongside');
    assert.equal((await restarted.switch('echo', '1')).ok, false);
    assert.equal((await restarted.apply(h.definition('2'))).ok, true);
    assert.equal((await restarted.switch('echo', '2')).ok, true);
    await restarted.close();
    assert.equal(h.clock.timers.size, 0);
    const calls = h.calls().length; h.clock.advance(10_000); h.clock.fire();
    assert.equal(h.calls().length, calls);
  } finally { await h.close(); }
});

test('ambient kubeconfig and fake executable PATH cannot activate a default driver', async () => {
  const h = await simulatedK3s();
  const old = { HOME: process.env.HOME, PATH: process.env.PATH, KUBECONFIG: process.env.KUBECONFIG };
  try {
    mkdirSync(join(h.home, '.kube'));
    const path = join(h.home, '.kube', 'config'); writeFileSync(path, 'untrusted-exec-plugin credential-canary');
    process.env.HOME = h.home; process.env.PATH = h.bin; process.env.KUBECONFIG = path;
    const d = new K3sDriver({ cluster: h.cluster, directory: h.directory });
    assert.equal((await d.apply(h.definition('1'))).ok, false);
    assert.equal((await d.refresh('echo')).ok, false);
    assert.deepEqual(d.status(), []); assert.deepEqual(h.calls(), []);
    assert.equal(readFileSync(path, 'utf8'), 'untrusted-exec-plugin credential-canary');
    await d.close();
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await h.close(); }
});

test('independent observation provenance rejects missing health time and regressed readiness time', async () => {
  const h = await simulatedK3s();
  try {
    await h.driver.apply(h.definition('1'));
    const before = h.driver.status('echo')[0]!;
    const row = h.read().services.echo!;
    for (const version of [{ ...row.versions[0]!, health: { ok: true, checked_at: null, said: null } }, { ...row.versions[0]!, ready_at: new Date(h.clock.now() - 60_000).toISOString() }]) {
      h.change(s => { s.statusOverride = { ...row, sequence: row.sequence + 100, versions: [version] }; });
      assert.equal((await h.driver.refresh('echo')).ok, false);
      assert.deepEqual(h.driver.status('echo')[0]!.readiness, before.readiness);
    }
  } finally { await h.close(); }
});

test('failed periodic observation stays armed to observe restored control plane', async () => {
  const h = await simulatedK3s();
  try {
    await h.driver.apply(h.definition('1')); await h.driver.switch('echo', '1');
    h.change(s => { s.reachable = false; });
    h.clock.advance(5000); h.clock.fire();
    assert.equal((await h.driver.refresh('echo')).ok, false);
    assert.equal(h.clock.timers.size, 1, 'failure does not disable subsequent observation');
    h.change(s => { s.reachable = true; });
    h.clock.advance(5000); h.clock.fire();
    await h.driver.refresh('echo');
    assert.equal(h.driver.status('echo')[0]!.failure, null);
  } finally { await h.close(); }
});

test('clock exercises three five-second readiness samples and full 120-second canary; closing cancels in-flight work', async () => {
  const h = await simulatedK3s();
  try {
    const start = h.clock.now();
    await h.driver.apply(h.definition('1'));
    assert.equal(h.clock.now() - start, 10_000);
    const ready = h.driver.status('echo')[0]!.readiness[0]!.checked_at;
    await h.driver.switch('echo', '1');
    assert.equal(h.clock.now() - start, 130_000);
    assert.equal(h.driver.status('echo')[0]!.readiness[0]!.checked_at, ready);
    assert.notEqual(h.driver.status('echo')[0]!.health.checked_at, ready);
    await h.driver.apply(h.definition('2'));
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; });
    h.clock.onSleep = async () => { h.clock.onSleep = null; entered(); await new Promise<void>(r => { release = r; }); };
    const pending = h.driver.switch('echo', '2'); await enteredPromise;
    await h.driver.close(); release();
    assert.equal((await pending).ok, false);
    assert.equal(h.clock.timers.size, 0);
    const calls = h.calls().length;
    assert.equal((await h.driver.rollback('echo', { auto: false, reason: 'closed' })).ok, false);
    assert.equal(h.calls().length, calls);
  } finally { await h.close(); }
});

test('rollback restores all observed replicas of a retained floating version', async () => {
  const h = await simulatedK3s();
  const cluster = structuredClone(h.cluster);
  const extra = structuredClone(cluster.devices[0]!); extra.id = 'linux-two'; extra.name = 'Linux two';
  cluster.devices = [...cluster.devices, extra];
  h.change(s => { const node = structuredClone(s.nodes[0]!); node.labels['nova/device'] = 'linux-two'; s.nodes.push(node); });
  const driver = new K3sDriver({ ...h.options, cluster });
  try {
    const def = (version: string) => ({ ...h.definition(version), placement: { mode: 'floating' as const, replicas: 2 } });
    assert.equal((await driver.apply(def('1'))).ok, true);
    assert.equal((await driver.switch('echo', '1')).ok, true);
    assert.equal((await driver.apply(def('2'))).ok, true);
    assert.equal((await driver.switch('echo', '2')).ok, true);
    assert.equal((await driver.rollback('echo', { auto: false, reason: 'retain scale' })).ok, true);
    assert.equal(h.read().services.echo!.versions.find(v => v.version === '1')!.replicas, 2);
  } finally { await driver.close(); await h.close(); }
});

for (const ok of [true, false]) test(`fix1 I1: fresh control-plane status with stale ${ok} health cannot authorize automatic effects`, async () => {
  const h = await simulatedK3s();
  let observer: K3sDriver | undefined;
  try {
    await livePair(h, 30); await h.driver.switch('echo', '2');
    const original = h.driver.status('echo')[0]!;
    let checkedAt = original.health.checked_at!;
    h.clock.advance(600_000);
    const tools: ClusterTools = { available: h.tools.available, execute: async (op, signal) => {
      const snapshot = await h.tools.execute(op, signal);
      if (op.operation === 'status') snapshot.versions.find(v => v.version === snapshot.live)!.health = { ok, checked_at: checkedAt, said: null };
      return snapshot;
    } };
    observer = new K3sDriver({ ...h.options, tools });
    const before = h.calls().length;
    assert.equal((await observer.refresh('echo')).ok, true);
    assert.deepEqual(h.calls().slice(before).filter(c => c.operation !== 'status'), [], 'old health cannot change routing or remove the kept resource');
    assert.equal(await h.serving(), '2');
    const stale = observer.status('echo')[0]!;
    assert.deepEqual([stale.live, stale.previous], ['2', '1']);
    assert.equal(stale.observed_at, new Date(h.clock.now()).toISOString());
    assert.deepEqual(stale.health, { ok, checked_at: original.health.checked_at, said: null });
    assert.deepEqual(stale.readiness, original.readiness);
    assert.equal(stale.failure, null);
    assert.equal(h.read().services.echo!.versions.find(v => v.version === '1')!.status, 'kept');

    // The inclusive 15-second boundary is independently measured evidence, not snapshot time.
    checkedAt = new Date(h.clock.now() - (ok ? 0 : 15_000)).toISOString();
    if (!ok) h.change(s => { s.unhealthy = ['2']; });
    const beforeFresh = h.calls().length;
    assert.equal((await observer.refresh('echo')).ok, true);
    assert.deepEqual(h.calls().slice(beforeFresh).filter(c => c.operation !== 'status').map(c => c.operation), [ok ? 'remove' : 'rollback']);
    assert.equal(await h.serving(), ok ? '2' : '1');
    assert.equal(observer.status('echo')[0]!.previous, null);
  } finally { await observer?.close(); await h.close(); }
});

test('fix1 I1: stale boundary, future and absent health evidence preserve their source ages without effects', async () => {
  const h = await simulatedK3s();
  try {
    await livePair(h, 30); await h.driver.switch('echo', '2');
    h.clock.advance(600_000);
    const originalReadiness = h.driver.status('echo')[0]!.readiness;
    const cases = [
      { ok: true, offset: -15_001 }, { ok: false, offset: -15_001 },
      { ok: true, offset: 1 }, { ok: false, offset: 1 },
      { ok: null, offset: null },
    ];
    for (const evidence of cases) {
      const health = { ok: evidence.ok, checked_at: evidence.offset === null ? null : new Date(h.clock.now() + evidence.offset).toISOString(), said: null };
      const tools: ClusterTools = { available: h.tools.available, execute: async (op, signal) => {
        const snapshot = await h.tools.execute(op, signal);
        if (op.operation === 'status') {
          // Existing snapshot validation tolerates <=1s clock skew. A measurement in that
          // permitted future window must still never authorize an automatic health effect.
          snapshot.observed_at = new Date(h.clock.now() + Math.max(0, evidence.offset ?? 0)).toISOString();
          snapshot.versions.find(v => v.version === snapshot.live)!.health = health;
        }
        return snapshot;
      } };
      const observer = new K3sDriver({ ...h.options, tools });
      try {
        const before = h.calls().length;
        assert.equal((await observer.refresh('echo')).ok, true);
        assert.deepEqual(h.calls().slice(before).filter(c => c.operation !== 'status'), [], JSON.stringify(evidence));
        const status = observer.status('echo')[0]!;
        assert.deepEqual([status.live, status.previous], ['2', '1']);
        assert.deepEqual(status.health, health);
        assert.deepEqual(status.readiness, originalReadiness);
        assert.equal(status.failure, null);
        assert.equal(await h.serving(), '2');
      } finally { await observer.close(); }
    }
  } finally { await h.close(); }
});

for (const historical of [true, false]) test(`final I2: ${historical ? 'retired history' : 'active resources'} at capacity refuses admission before effects and stays observable`, async () => {
  const h = await simulatedK3s();
  try {
    await livePair(h);
    assert.equal((await h.driver.switch('echo', '2')).ok, true);
    h.change(state => {
      const row = state.services.echo!;
      const template = row.versions[0]!;
      row.versions.push(...Array.from({ length: 62 }, (_, i) => ({ ...structuredClone(template), version: `old${i}`, status: historical ? 'removed' as const : 'alongside' as const, replicas: historical ? 0 : 1, ready: false })));
      row.revision++;
    });
    assert.equal((await h.driver.observe('echo')).ok, true);
    const before = h.read().services.echo!;
    assert.equal(before.versions.length, 64);
    for (let i = 0; i < 3; i++) {
      const calls = h.calls().length;
      const result = await h.driver.apply(h.definition(`beyond${i}`));
      assert.equal(result.ok, false);
      assert.match(result.said, /capacity/i, 'known admission refusal must not be reported as unknown completion');
      assert.equal(h.driver.registry.get('echo', `beyond${i}`), null, 'refused admission does not persist new definitions');
      assert.ok(h.calls().slice(calls).every(c => c.operation === 'status'), 'no Helm, workload or network mutation after admission refusal');
      const row = h.read().services.echo!;
      assert.equal(row.revision, before.revision);
      assert.deepEqual(row.versions, before.versions);
      assert.deepEqual(serviceExpected(row), serviceExpected(before));
      assert.deepEqual(row.last_mutation, before.last_mutation);
      assert.equal((await h.driver.observe('echo')).ok, true);
      assert.equal(await h.serving(), '2');
    }
    // Stopped historical identities are retained for replay protection and definitions stay immutable.
    assert.equal((await h.driver.apply(h.definition('1'))).ok, false);
    assert.equal((await h.driver.apply(h.definition('old0'))).ok, false);
    assert.equal((await h.driver.apply({ ...h.definition('2'), health: { http: '/changed', every_s: 5 } })).ok, false);
    assert.equal((await h.driver.rollback('echo', { auto: false, reason: 'capacity still permits rollback' })).ok, true);
    assert.equal(await h.serving(), '1');
    assert.equal(h.read().services.echo!.versions.length, 64);
  } finally { await h.close(); }
});

for (const operation of ['prepare', 'prepare-workload'] as const) test(`final I2: simulator ${operation} independently rejects a racing capacity overflow before commit`, async () => {
  const h = await simulatedK3s();
  try {
    assert.equal((await h.driver.apply(h.definition('seed'))).ok, true);
    assert.equal((await h.driver.switch('echo', 'seed')).ok, true);
    const values = await h.driver.preview(h.definition('next'), serviceExpected(h.read().services.echo!));
    h.change(state => {
      const row = state.services.echo!;
      row.versions.push(...Array.from({ length: 63 }, (_, i) => ({ ...structuredClone(row.versions[0]!), version: `old${i}`, status: 'removed' as const, replicas: 0, ready: false })));
      row.revision++;
    });
    const before = h.read().services.echo!;
    const request = { cluster: h.cluster.id, namespace: h.cluster.namespace, service: 'echo', operation, values, expected: { revision: before.revision, state: serviceExpected(before) } };
    await assert.rejects(h.raw('kubectl', { ...request, expected: { ...request.expected, revision: before.revision - 1 } }));
    assert.deepEqual(h.read().services.echo, before, 'stale CAS changes no resource evidence');
    await assert.rejects(h.raw('kubectl', request), /capacity/i);
    assert.deepEqual(h.read().services.echo, before, 'capacity admission changes no selector, revision, assignment, history or task evidence');
    assert.equal((await h.driver.observe('echo')).ok, true);
    assert.equal(await h.serving(), 'seed');
  } finally { await h.close(); }
});

test('final I2: the 64th retained version can prepare, promote and roll back without deleting history', async () => {
  const h = await simulatedK3s();
  try {
    assert.equal((await h.driver.apply(h.definition('seed'))).ok, true);
    assert.equal((await h.driver.switch('echo', 'seed')).ok, true);
    h.change(state => {
      const row = state.services.echo!;
      row.versions.push(...Array.from({ length: 62 }, (_, i) => ({ ...structuredClone(row.versions[0]!), version: `old${i}`, status: 'removed' as const, replicas: 0, ready: false })));
      row.revision++;
    });
    const history = h.read().services.echo!.versions.slice(1);
    assert.equal((await h.driver.apply(h.definition('next'))).ok, true);
    const row = h.read().services.echo!;
    assert.equal(row.versions.length, 64);
    assert.equal(row.live, 'seed');
    assert.equal(row.assigned!.version, 'next');
    assert.deepEqual(row.versions.slice(1, -1), history);
    assert.equal((await h.driver.switch('echo', 'next')).ok, true);
    assert.equal((await h.driver.rollback('echo', { auto: false, reason: 'boundary rollback' })).ok, true);
    assert.equal(await h.serving(), 'seed');
    assert.equal((await h.driver.observe('echo')).ok, true);
    assert.equal(h.read().services.echo!.versions.length, 64);
  } finally { await h.close(); }
});
