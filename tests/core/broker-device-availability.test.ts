// Public identity availability with a private in-memory key-store fixture; no OS keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Broker } from '../../src/broker/broker.ts';
import { startBroker, stopBroker, type Started } from '../../src/broker/spawn.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import type { KeyStore } from '../../src/broker/keystore.ts';
import { Person, PASS, kdf, tmp } from '../support/broker-support.ts';

for (const mode of ['missing', 'mismatched', 'unavailable'] as const) test(`FR4 ${mode} private store keeps locked startup and stable public identity`, async () => {
  const home = tmp('nova-device-availability-');
  const keys = new Map<string, Buffer>();
  let fault = false, writes = 0;
  const deviceStore = (account: string): KeyStore => ({
    kind: 'keychain', name: 'private fake key store', available: () => ({ ok: !fault, detail: 'fixture' }),
    read: () => {
      if (fault && account.startsWith('device-')) {
        if (mode === 'unavailable') throw new Error('public fixture store unavailable');
        return mode === 'missing' ? null : Buffer.alloc(32, 7);
      }
      return keys.has(account) ? Buffer.from(keys.get(account)!) : null;
    },
    write: key => { if (fault && mode === 'unavailable') throw new Error('public fixture write unavailable'); writes++; keys.set(account, Buffer.from(key)); fault = false; }, remove: () => { keys.delete(account); },
  });
  let b: Broker | undefined;
  try {
    b = new Broker({ dir: join(home, 'broker'), deviceStore, kdf: kdf() }); b.start();
    const call = async (m: string, f = {}) => b!.handle('core', { id: 1, m: m as never, ...f });
    const person = new Person(call); await person.setup();
    const before = b.state(); b.store.lock(); fault = true;
    const beforeWrites = writes;
    b = new Broker({ dir: join(home, 'broker'), deviceStore }); b.start();
    const state = await person.state();
    assert.equal(state.locked, true); assert.equal(state.exists, true);
    assert.equal(state.device_id, before.device_id); assert.equal(state.device_key_fingerprint, before.device_key_fingerprint);
    assert.equal(writes, beforeWrites, 'startup/status never resets or replaces a private key');
    // The existing person-factor contract remains usable once the store can accept renewal.
    if (mode === 'unavailable') {
      assert.equal((await call('unlock', { passphrase: await person.factor('passphrase', PASS) })).refused, 'locked');
      assert.equal(b.state().locked, true, 'failed renewal cannot leave a partially unlocked broker');
      assert.equal(writes, beforeWrites);
      fault = false;
    }
    const opened = await call('unlock', { passphrase: await person.factor('passphrase', PASS) });
    assert.equal(opened.ok, true); assert.equal(b.state().locked, false);
    assert.equal(b.state().device_id, before.device_id);
  } finally { b?.store.lock(); rmSync(home, { recursive: true, force: true }); }
});

test('FR4 actual permission-mode broker remains reachable after its private file key is missing', async () => {
  const home = tmp('nova-device-ipc-'), dir = join(home, 'broker');
  let b: Started | undefined, client: BrokerClient | undefined;
  try {
    b = await startBroker(dir, { keyMode: 'file', pipe: false });
    client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
    const person = new Person((m, f = {}) => client!.call(m, f)); await person.setup();
    const before = await client.state();
    client.close(); await stopBroker(b); b = undefined;
    rmSync(join(dir, 'device.key'));
    b = await startBroker(dir, { keyMode: 'file', pipe: false });
    client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
    const state = await client.state();
    assert.equal(state.locked, true); assert.equal(state.device_key_fingerprint, before.device_key_fingerprint);
    assert.equal((await client.call('unlock', { passphrase: await person.factor('passphrase', PASS) })).ok, true);
    assert.equal((await client.state()).device_id, before.device_id);
    assert.equal((await client.state()).locked, false);
  } finally { client?.close(); if (b) await stopBroker(b); rmSync(home, { recursive: true, force: true }); }
});
