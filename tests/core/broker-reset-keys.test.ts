import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as keys from '../../src/broker/keystore.ts';

test('fixed broker reset removes both exact device accounts, never reads values, and refuses retained runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-broker-key-reset-'));
  const id = 'f0e1d2c3-1234-4567-8901-123456789abc';
  const accounts: string[] = [];
  const fake = (account: string): keys.KeyStore => ({ kind: 'keychain', name: 'private fake', available: () => ({ ok: true, detail: '' }), read: () => { throw Error('reset must not read keys'); }, write: () => { throw Error('reset must not create keys'); }, remove: () => { accounts.push(account); } });
  writeFileSync(join(dir, 'device.json'), JSON.stringify({ id }));
  try {
    assert.equal(typeof (keys as any).removeDeviceKeys, 'function');
    mkdirSync(join(dir, 'run/programs/retained'), { recursive: true });
    assert.throws(() => (keys as any).removeDeviceKeys(dir, fake), /operator recovery/);
    assert.deepEqual(accounts, []);
    rmSync(join(dir, 'run/programs/retained'), { recursive: true });
    (keys as any).removeDeviceKeys(dir, fake);
    assert.deepEqual(accounts, [`device-${id}`, `sign-${id}`]);
    assert.ok(existsSync(join(dir, 'device.json')), 'record survives until authenticated home reset deletes directory');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('keychain deletion failure is propagated, never silently reported as reset success', () => {
  const commands: string[][] = [];
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const store = keys.keychainStore('nova-broker', 'device-test', { platform, env: { DBUS_SESSION_BUS_ADDRESS: 'private-fake' }, run: (_cmd, args) => { commands.push(args); return { code: 7, stdout: '', stderr: 'private injected denial', error: null }; } });
    assert.throws(() => store!.remove(), /keychain/);
  }
  assert.equal(commands.length, 3);
});

test('Windows reset does not interpret ambiguous exit 44 as item absence; removal uses metadata only', () => {
  let script = '';
  const store = keys.keychainStore('nova-broker', 'device-test', { platform: 'win32', run: (_cmd, args) => { script = args.at(-1)!; return { code: 44, stdout: '', stderr: '', error: null }; } });
  assert.throws(() => store!.remove(), /keychain/);
  assert.ok(!script.includes('RetrievePassword'));
  assert.ok(!script.includes('catch { exit 44 }'));
});

test('documented missing entry and repeated successful deletion remain idempotent', () => {
  for (const [platform, code] of [['linux', 1], ['darwin', 44], ['win32', 0]] as const) {
    const store = keys.keychainStore('nova-broker', 'device-test', { platform, run: () => ({ code, stdout: '', stderr: '', error: null }) });
    assert.doesNotThrow(() => { store!.remove(); store!.remove(); });
  }
});

test('broker bootstrap refuses a symlinked storage directory before touching its target', async () => {
  const { symlinkSync } = await import('node:fs');
  const { startBroker } = await import('../../src/broker/spawn.ts');
  const root = mkdtempSync(join(tmpdir(), 'nova-broker-link-'));
  const target = join(root, 'foreign'); mkdirSync(target);
  const dir = join(root, 'broker'); symlinkSync(target, dir);
  let child: Awaited<ReturnType<typeof startBroker>> | undefined;
  try {
    await assert.rejects(async () => { child = await startBroker(dir, { keyMode: 'file', pipe: true }); }, /directory|symlink/i);
    assert.equal(existsSync(join(target, 'device.json')), false);
  } finally {
    if (child) { child.child.kill(); await child.stopped; }
    rmSync(root, { recursive: true, force: true });
  }
});
