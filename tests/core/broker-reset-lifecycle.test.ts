import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finishReset, RESET_MARKER } from '../../src/core/resilience/reset.ts';
import { world, open } from './resilience-support.ts';

test('reset cannot erase broker keys or retained owned-run evidence without supervisor cleanup', async () => {
  const w = world('nova-broker-reset-'); const c = open(w.home);
  mkdirSync(join(w.home, 'broker/run/programs/retained'), { recursive: true });
  writeFileSync(join(w.home, 'broker/device.key'), 'private-canary');
  const s = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
  await s.done; await c.close();
  assert.throws(() => finishReset(w.home, { vault: { mode: 'file', keychain: null } }), /broker.*cleanup/i);
  assert.ok(existsSync(join(w.home, RESET_MARKER)));
  assert.equal(readFileSync(join(w.home, 'broker/device.key'), 'utf8'), 'private-canary');
});

test('cleanup attestation for another reset cannot authorize this authenticated marker', async () => {
  const w = world('nova-broker-reset-bind-'); const c = open(w.home);
  mkdirSync(join(w.home, 'broker'), { recursive: true });
  writeFileSync(join(w.home, 'broker/device.key'), 'private-canary');
  const s = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
  await s.done; await c.close();
  assert.throws(() => finishReset(w.home, { vault: { mode: 'file', keychain: null }, brokerCleaned: 'different-reset' as any }), /broker.*cleanup/i);
  assert.ok(existsSync(join(w.home, 'broker/device.key')));
});
