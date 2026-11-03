// Actual diagnostics route + separate broker: counts/state only, never refs, values or raw errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/index.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { startBroker, stopBroker } from '../../src/broker/spawn.ts';
import { Person, anyForm } from '../support/broker-support.ts';

test('production diagnostics projects fresh broker counts and states without refs, key material or raw failures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nova-broker-diagnostics-')), home = join(root, 'home');
  ensureMark(home);
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file', pipe: true });
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  let nova: ReturnType<typeof createNova> | undefined;
  try {
    nova = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'true', NOVA_AGENT_EGRESS: 'none', NOVA_VAULT_KEY: 'file' }), { broker: client });
    const canary = 'Task6-private-diagnostics-canary-7d934a06';
    await new Promise<void>((r) => nova!.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(nova.server.address() as any).port}`;
    const download = async () => {
      const r = await fetch(`${base}/api/v1/diagnostics`);
      assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-disposition')!, /^attachment;/);
      return await r.json() as any;
    };
    assert.deepEqual((await download()).broker, { available: true, exists: false, locked: true, visible_items: null, unlock_mode: null, device_store: 'file', problem: false });
    const person = new Person((m, f = {}) => client.call(m, f)); await person.setup();
    const created = await person.approve('create', { meta: { name: 'test/PRIVATE_ITEM_NAME', kind: 'secret', class: 'standard' }, source: 'sealed' }, { seal: canary, sealAt: (f, sealed) => ({ ...f, source: { sealed } }) });
    assert.equal(created.ok, true);
    const state = await client.state();
    const bundle = await download();
    assert.deepEqual(bundle.broker, { available: true, exists: true, locked: false, visible_items: 1, unlock_mode: 'auto', device_store: 'file', problem: true });
    for (const value of [canary, 'PRIVATE_ITEM_NAME', String(created.ref), b.tokens.core, b.tokens.supervisor, String(state.entry_key), String(state.boot), String(state.device_id), String(state.vault_id), String(state.device_key_fingerprint)]) {
      assert.equal(anyForm(JSON.stringify(bundle), value), null, 'broker-only data must not enter the bundle');
    }
    await client.lock();
    assert.deepEqual((await download()).broker, { ...bundle.broker, locked: true, visible_items: null });
    const list = client.listRefs.bind(client);
    const detail = `${canary} at ${home}`;
    // Even unexpected metadata/free text cannot bypass the explicit projection.
    for (const answer of [
      { ok: true, state: { exists: true, locked: false, unlock_mode: detail, device_key: detail, problem: detail, entry_key: detail }, refs: [{ name: detail, value: detail }] },
      { refused: 'locked', words: detail },
      { ok: true, state: { exists: detail, locked: false }, refs: [] },
      { ok: true, state: { exists: true, locked: false }, refs: detail },
    ]) {
      t.mock.method(client, 'listRefs', async () => answer as any);
      const projected = (await download()).broker;
      if (answer.state?.exists === true && Array.isArray(answer.refs)) assert.deepEqual(projected, { available: true, exists: true, locked: false, visible_items: 1, unlock_mode: null, device_store: null, problem: true });
      else assert.deepEqual(projected, { available: false, problem: true });
      assert.ok(!JSON.stringify(projected).includes(canary));
      t.mock.restoreAll();
    }
    t.mock.method(client, 'listRefs', async () => { throw new Error(detail); });
    assert.deepEqual((await download()).broker, { available: false, problem: true });
    t.mock.restoreAll();
    // Required legacy secret scan must finish before even optional broker metadata is collected.
    let reads = 0;
    t.mock.method(client, 'listRefs', () => { reads++; return list(); });
    t.mock.method(nova.core.vault, 'list', () => { throw new Error(detail); });
    const refused = await fetch(`${base}/api/v1/diagnostics`);
    assert.equal(refused.status, 503); assert.equal(refused.headers.get('content-disposition'), null);
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    assert.ok(!(await refused.text()).includes(canary)); assert.equal(reads, 0);
    t.mock.restoreAll();
    client.close();
    assert.deepEqual((await download()).broker, { available: false, problem: true });
    nova.core.broker = null;
    assert.deepEqual((await download()).broker, { available: false, problem: false });
  } finally {
    t.mock.restoreAll();
    if (nova?.server.listening) await new Promise<void>((r) => { nova!.server.close(() => r()); nova!.server.closeAllConnections(); });
    await nova?.core.close(); client.close(); await stopBroker(b); rmSync(root, { recursive: true, force: true });
  }
});
