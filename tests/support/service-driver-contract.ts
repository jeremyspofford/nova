// What every service driver must do (docs/plans/M10-orchestration.md, Point 1: "the driver interface
// is exercised by both drivers' tests"). The supervisor driver runs it now
// (tests/supervisor/services-contract.test.ts); the K3s driver (M10j) runs the same suite. A harness
// gives the driver, definitions of a stand-in service, a way to reach it on its stable port, and
// its teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceDefinition, ServiceDriver } from '../../src/core/index.ts';

export interface DriverHarness {
  driver: ServiceDriver;
  // A healthy version; `failContract`: one whose contract tests fail.
  definition(version: string, o?: { failContract?: boolean }): ServiceDefinition;
  // Which version answers on the service's stable port now, or null for none.
  serving(): Promise<string | null>;
  close(): Promise<void>;
}

const STAGES = ['install', 'prepare', 'alongside', 'tests', 'sandbox', 'smoke', 'health', 'approval', 'switch', 'canary', 'promote'];

export function serviceDriverContract(name: string, make: () => Promise<DriverHarness>): void {
  test(`${name} driver contract: available, and a plan in the stages’ order with its tier`, async () => {
    const h = await make();
    try {
      assert.equal(h.driver.available().ok, true, h.driver.available().said);
      const def = h.definition('1.0.0');
      const plan = h.driver.plan(def);
      assert.equal(plan.ok, true, plan.refused.join(' '));
      assert.equal(plan.driver, h.driver.name);
      assert.deepEqual([plan.service, plan.version], [def.service, def.version]);
      assert.ok([2, 3].includes(plan.tier));
      const order = plan.steps.map((s) => STAGES.indexOf(s.step));
      assert.ok(order.every((i) => i >= 0), 'every step is a stage');
      assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in the stages’ order');
      for (const want of ['alongside', 'tests', 'health', 'approval', 'canary', 'promote']) assert.ok(plan.steps.some((s) => s.step === want), want);
    } finally {
      await h.close();
    }
  });

  test(`${name} driver contract: apply never moves traffic; only a ready version switches; rollback is one step back`, async () => {
    const h = await make();
    try {
      const svc = h.definition('1.0.0').service;
      assert.equal((await h.driver.apply(h.definition('1.0.0'))).ok, true);
      assert.equal(await h.serving(), null, 'apply gave it no traffic');
      assert.equal(h.driver.status(svc)[0]!.versions.find((v) => v.version === '1.0.0')!.status, 'ready');
      const s1 = await h.driver.switch(svc, '1.0.0');
      assert.equal(s1.ok, true, s1.said);
      assert.equal(await h.serving(), '1.0.0');

      // A version that fails its contract tests is never ready, and switch refuses it.
      const bad = await h.driver.apply(h.definition('1.0.1', { failContract: true }));
      assert.equal(bad.ok, false);
      assert.notEqual(h.driver.status(svc)[0]!.versions.find((v) => v.version === '1.0.1')!.status, 'ready');
      const refused = await h.driver.switch(svc, '1.0.1');
      assert.equal(refused.ok, false);
      assert.match(refused.said, /isn’t ready/);
      assert.equal(await h.serving(), '1.0.0', 'still the live version');

      assert.equal((await h.driver.apply(h.definition('2.0.0'))).ok, true);
      assert.equal(await h.serving(), '1.0.0', 'applying 2.0.0 moved nothing');
      assert.equal((await h.driver.switch(svc, '2.0.0')).ok, true);
      assert.equal(await h.serving(), '2.0.0');
      const st = h.driver.status(svc)[0]!;
      assert.deepEqual([st.live, st.previous], ['2.0.0', '1.0.0']);

      const back = await h.driver.rollback(svc, { auto: false, reason: 'The contract test asked.' });
      assert.equal(back.ok, true, back.said);
      assert.equal(await h.serving(), '1.0.0');
      const after = h.driver.status(svc)[0]!;
      assert.deepEqual([after.live, after.previous], ['1.0.0', null]);
      assert.equal((await h.driver.rollback(svc, { auto: false, reason: 'again' })).ok, false, 'nothing kept to go back to now');
    } finally {
      await h.close();
    }
  });
}
