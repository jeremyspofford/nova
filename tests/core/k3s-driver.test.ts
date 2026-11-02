import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/core/index.ts';
import { serviceDriverContract } from '../support/service-driver-contract.ts';

// This assertion deliberately precedes the first implementation/harness import: the shared
// contract must fail as a behavioral assertion, rather than a missing-module loader error.
async function harness() {
  assert.equal(typeof core.K3sDriver, 'function', 'K3s must implement the shared six-call driver');
  const { simulatedK3s } = await import('../support/k3s.ts');
  return simulatedK3s();
}
serviceDriverContract('K3s simulation', harness);

test('default K3s driver refuses without discovering ambient tools or credentials', async () => {
  const h = await harness();
  try {
    const d = new core.K3sDriver({ cluster: h.cluster, directory: h.directory });
    assert.equal(d.available().ok, false);
    assert.match(d.available().said, /broker/);
    assert.equal(d.plan(h.definition('1')).ok, false);
    assert.equal((await d.apply(h.definition('1'))).ok, false);
    assert.equal((await d.switch('echo', '1')).ok, false);
    assert.equal((await d.rollback('echo', { auto: false, reason: 'test' })).ok, false);
    assert.deepEqual(h.calls(), []);
    await d.close();
  } finally { await h.close(); }
});

test('safe unsupported modes, secrets and ineligible placements refuse before commands', async () => {
  const h = await harness();
  try {
    for (const extra of [{ alongside: 'none' }, { alongside: 'copy' }, { alongside: 'shadow' }, { secrets: ['secret://echo/token'] }, { state: { volume: 'state' } }, { placement: { mode: 'pinned', device: 'windows' } }, { placement: { mode: 'pinned', device: 'hub', roles: ['compute'] } }, { placement: { mode: 'pinned', device: 'hub', needs: { memory_gb: 999 } } }]) {
      const def = { ...h.definition('1'), ...extra } as core.ServiceDefinition;
      assert.equal(h.driver.plan(def).ok, false, JSON.stringify(extra));
      assert.equal((await h.driver.apply(def)).ok, false);
    }
    assert.deepEqual(h.calls(), []);
  } finally { await h.close(); }
});

test('control-plane loss preserves cached observation ages and blocks mutations while pods still serve', async () => {
  const h = await harness();
  try {
    await h.driver.apply(h.definition('1'));
    await h.driver.switch('echo', '1');
    const before = h.driver.status('echo')[0]!;
    h.change(s => { s.reachable = false; });
    h.clock.advance(30_000);
    assert.equal((await h.driver.refresh('echo')).ok, false);
    assert.equal(await h.serving(), '1');
    const after = h.driver.status('echo')[0]!;
    assert.equal(after.observed_at, before.observed_at);
    assert.equal(after.health.checked_at, before.health.checked_at);
    assert.equal((await h.driver.apply(h.definition('2'))).ok, false);
    assert.equal((await h.driver.switch('echo', '1')).ok, false);
    assert.equal((await h.driver.rollback('echo', { auto: false, reason: 'test' })).ok, false);
    h.change(s => { s.reachable = true; });
    assert.equal((await h.driver.refresh('echo')).ok, true);
  } finally { await h.close(); }
});

test('canary failure restores kept selector without prepare/download; first live failure holds safely', async () => {
  const h = await harness();
  try {
    await h.driver.apply(h.definition('1'));
    await h.driver.switch('echo', '1');
    await h.driver.apply(h.definition('2'));
    const n = h.calls().filter(c => c.operation === 'prepare').length;
    h.clock.onSleep = () => h.change(s => { s.unhealthy = ['2']; });
    assert.equal((await h.driver.switch('echo', '2')).ok, false);
    assert.equal(await h.serving(), '1');
    assert.equal(h.calls().filter(c => c.operation === 'prepare').length, n);
  } finally { await h.close(); }
  const first = await harness();
  try {
    await first.driver.apply(first.definition('1'));
    first.clock.onSleep = () => first.change(s => { s.unhealthy = ['1']; });
    assert.equal((await first.driver.switch('echo', '1')).ok, false);
    assert.equal(await first.serving(), null);
    assert.ok(first.driver.status('echo')[0]!.held);
  } finally { await first.close(); }
});
