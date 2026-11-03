import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as link from '../../src/core/resilience/link.ts';
import { createCore, ensureMark } from '../../src/core/index.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { startBroker, stopBroker } from '../../src/broker/spawn.ts';

test('private Core bootstrap asks parent over IPC, accepts only fixed role context and rejects malformed delivery', async () => {
  assert.equal(typeof (link as any).ipcBroker, 'function');
  const token = 'a'.repeat(64);
  for (const context of [{ socket: '/tmp/private-broker.sock', token }, null, { socket: '/tmp/private-broker.sock', token, supervisor: 'b'.repeat(64) }, { socket: '', token }, { socket: '/tmp/x', token: 'bad' }]) {
    const proc = new EventEmitter() as any;
    const sent: unknown[] = [];
    proc.send = (m: unknown) => { sent.push(m); queueMicrotask(() => proc.emit('message', { nova: 'broker', context })); };
    const pending = (link as any).ipcBroker(proc, { NOVA_SUPERVISED: '1' });
    if (context === null || Object.keys(context).length === 2 && context.socket && context.token === token) assert.deepEqual(await pending, context);
    else await assert.rejects(() => pending, /broker.*context/i);
    assert.deepEqual(sent, [{ nova: 'broker-ready' }]);
    assert.equal(proc.listenerCount('message'), 0);
    assert.equal(proc.listenerCount('disconnect'), 0);
  }
  assert.equal(await (link as any).ipcBroker(new EventEmitter(), {}), null);
});

test('Core owns only its metadata client, closes it permanently, and standalone Core honestly has no broker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-core-broker-')); const home = join(root, 'home'); ensureMark(home);
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file', pipe: true });
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const core = createCore({ home, version: 'test', trustedOrigin: () => true, vault: { mode: 'file', keychain: null }, broker: client } as any);
  let closed = false;
  try {
    assert.equal((core as any).broker, client);
    assert.equal((await (core as any).broker.listRefs()).ok, true);
    assert.ok(!JSON.stringify(client).includes(b.tokens.core));
    await core.close(); closed = true;
    await assert.rejects(() => client.listRefs(), /closed/i);
    const standalone = createCore({ home: join(root, 'standalone'), version: 'test', trustedOrigin: () => true, vault: { mode: 'file', keychain: null } });
    try { assert.equal((standalone as any).broker, null); } finally { await standalone.close(); }
  } finally { if (!closed) await core.close(); client.close(); await stopBroker(b); rmSync(root, { recursive: true, force: true }); }
});

test('a deliberately closed metadata client cannot reconnect with its retained role token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-client-close-'));
  const b = await startBroker(join(root, 'broker'), { keyMode: 'file', pipe: true });
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  try {
    assert.equal((await client.listRefs()).ok, true); client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(() => client.listRefs(), /closed/i);
  } finally { client.close(); await stopBroker(b); rmSync(root, { recursive: true, force: true }); }
});

test('closing during the initial metadata handshake settles the pending caller without reconnecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-client-close-opening-'));
  const b = await startBroker(join(root, 'broker'), { keyMode: 'file', pipe: true });
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  try {
    const pending = client.listRefs(); client.close();
    await assert.rejects(() => pending, /closed/i);
    await assert.rejects(() => client.state(), /closed/i);
  } finally { client.close(); await stopBroker(b); rmSync(root, { recursive: true, force: true }); }
});
