// B6: committed reads are independent of writer locks; recovery and key housekeeping are not.
// All ciphertext, keys, homes and keychain implementations below are private synthetic fixtures.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_KEY_NOTICE, Vault, type KeyStore } from '../../src/core/vault.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'nova-vault-b6-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = new Vault({ home, mode: 'file' });
  vault.put('provider/KEEP', 'synthetic-keep-value');
  return { home, vault, file: vault.file, tmp: `${vault.file}.tmp`, key: join(vault.dir, 'key'), lock: join(vault.dir, '.writer-lock') };
}

function interrupted(t: TestContext) {
  const f = fixture(t);
  f.vault.put('provider/REMOVED', 'synthetic-removed-value');
  const before = readFileSync(f.file);
  f.vault.delete('provider/REMOVED');
  const next = readFileSync(f.file);
  writeFileSync(f.file, before);
  writeFileSync(f.tmp, next);
  return { ...f, before, next };
}

function unrelated(key: Buffer): Buffer {
  const id = randomUUID(), nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(`nova-vault-v1|${id}`));
  const data = Buffer.concat([c.update(JSON.stringify({ 'provider/PLANTED': 'synthetic-planted' })), c.final()]);
  return Buffer.from(JSON.stringify({ v: 1, id, alg: 'aes-256-gcm', fp: createHash('sha256').update(key).digest('hex').slice(0, 16), nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }));
}

for (const warm of [false, true]) for (const verb of ['get', 'has', 'list', 'status'] as const) {
  test(`B6: ${warm ? 'warm' : 'cold'} ${verb} reads valid committed data under a stale lock without changing pending bytes`, (t) => {
    const f = fixture(t);
    const reader = new Vault({ home: f.home, mode: 'file' });
    if (warm) assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
    const before = readFileSync(f.file), key = readFileSync(f.key), pending = unrelated(key);
    writeFileSync(f.tmp, pending);
    mkdirSync(f.lock);
    writeFileSync(join(f.lock, 'owner'), 'synthetic-stale-writer');
    if (verb === 'get') assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
    if (verb === 'has') assert.equal(reader.has('provider/KEEP'), true);
    if (verb === 'list') assert.deepEqual(reader.list(), ['provider/KEEP']);
    if (verb === 'status') assert.deepEqual([reader.status().ok, reader.status().secrets, reader.status().notice], [true, 1, FILE_KEY_NOTICE]);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(readFileSync(f.tmp), pending);
    assert.deepEqual(readFileSync(f.key), key);
    assert.equal(readFileSync(join(f.lock, 'owner'), 'utf8'), 'synthetic-stale-writer');
  });
}

test('B6: committed reads leave unrelated pending ciphertext alone even without a writer lock', (t) => {
  const f = fixture(t), pending = unrelated(readFileSync(f.key));
  writeFileSync(f.tmp, pending);
  assert.equal(new Vault({ home: f.home, mode: 'file' }).get('provider/KEEP'), 'synthetic-keep-value');
  assert.deepEqual(readFileSync(f.tmp), pending);
  assert.equal(existsSync(f.lock), false);
});

test('B6: warm reads observe another cooperating writer and never resurrect its deleted entries', (t) => {
  const f = fixture(t), reader = new Vault({ home: f.home, mode: 'file' });
  assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
  f.vault.put('provider/KEEP', 'synthetic-new-value');
  f.vault.put('provider/NEW', 'synthetic-added-value');
  assert.equal(reader.get('provider/KEEP'), 'synthetic-new-value');
  assert.deepEqual(reader.list(), ['provider/KEEP', 'provider/NEW']);
  f.vault.delete('provider/KEEP');
  assert.equal(reader.has('provider/KEEP'), false);
  assert.equal(reader.status().secrets, 1);
  reader.put('provider/LATEST', 'synthetic-latest-value');
  assert.deepEqual(f.vault.list(), ['provider/LATEST', 'provider/NEW']);
  f.vault.clear();
  assert.deepEqual(reader.list(), []);
});

test('B6: every mutator refuses an existing lock and leaves the committed vault intact', (t) => {
  const f = fixture(t), before = readFileSync(f.file), key = readFileSync(f.key);
  mkdirSync(f.lock);
  const changes = [() => f.vault.put('provider/NEW', 'synthetic-new'), () => f.vault.delete('provider/KEEP'),
    () => f.vault.deletePrefix('provider/'), () => f.vault.reset(true), () => f.vault.forgetKeys(),
    () => f.vault.adopt(before.toString(), key.toString('base64')), () => f.vault.clear()];
  for (const change of changes) {
    assert.throws(change, /busy with a writer or migration/);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(readFileSync(f.key), key);
    assert.equal(existsSync(f.lock), true);
  }
});

test('B6: interrupted authenticated rekey requires the exclusive lock and publishes only after recovery', (t) => {
  const f = interrupted(t), reader = new Vault({ home: f.home, mode: 'file' });
  const key = readFileSync(f.key);
  mkdirSync(f.lock);
  assert.throws(() => reader.get('provider/KEEP'), /busy with a writer or migration/);
  assert.equal(reader.status().ok, false);
  assert.deepEqual(readFileSync(f.file), f.before);
  assert.deepEqual(readFileSync(f.tmp), f.next);
  assert.deepEqual(readFileSync(f.key), key);
  assert.equal(existsSync(f.lock), true);
  rmSync(f.lock, { recursive: true });
  assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
  assert.equal(reader.has('provider/REMOVED'), false);
  assert.deepEqual(readFileSync(f.file), f.next);
  assert.equal(existsSync(f.tmp), false);
  assert.equal(existsSync(f.lock), false);
});

for (const kind of ['malformed', 'tampered', 'different-id'] as const) {
  test(`B6: pending ${kind} rekey never authenticates or replaces the committed file`, (t) => {
    const f = interrupted(t), key = readFileSync(f.key);
    const bad = kind === 'malformed' ? Buffer.from('{') : kind === 'different-id' ? unrelated(key)
      : Buffer.from(JSON.stringify({ ...JSON.parse(f.next.toString()), tag: Buffer.alloc(16).toString('base64') }));
    writeFileSync(f.tmp, bad);
    assert.throws(() => new Vault({ home: f.home, mode: 'file' }).get('provider/KEEP'), /can’t find the key/);
    assert.deepEqual(readFileSync(f.file), f.before);
    assert.deepEqual(readFileSync(f.tmp), bad);
    assert.deepEqual(readFileSync(f.key), key);
  });
}

for (const duplicate of [false, true]) {
  test(`B6: ${duplicate ? 'duplicate key removal' : 'file key promotion'} waits for serialization without blocking reads`, (t) => {
    const f = fixture(t), diskKey = readFileSync(f.key);
    let stored: Buffer | null = duplicate ? diskKey : null;
    const kc: KeyStore = { kind: 'keychain', name: 'synthetic-keychain', available: () => ({ ok: true, detail: 'test' }),
      read: () => stored,
      write: (key) => { assert.equal(existsSync(f.lock), true, 'promotion holds the writer lock'); stored = Buffer.from(key); },
      remove: () => { stored = null; } };
    const reader = new Vault({ home: f.home, mode: 'auto', keychain: () => kc });
    mkdirSync(f.lock);
    assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
    assert.deepEqual(readFileSync(f.key), diskKey, 'optional housekeeping cannot remove the key under someone else’s lock');
    assert.equal(existsSync(f.lock), true);
    rmSync(f.lock, { recursive: true });
    assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
    assert.equal(reader.status().key, 'keychain');
    assert.equal(existsSync(f.key), false);
    assert.deepEqual(stored, diskKey);
  });
}

test('B6: ordinary keychain reads never acquire a writer lock', (t) => {
  const f = fixture(t), key = readFileSync(f.key);
  rmSync(f.key);
  const kc: KeyStore = { kind: 'keychain', name: 'synthetic-keychain', available: () => ({ ok: true, detail: 'test' }),
    read: () => { assert.equal(existsSync(f.lock), false, 'read must not create a lock'); return key; },
    write: () => assert.fail('read must not write the key'), remove: () => assert.fail('read must not remove the key') };
  const reader = new Vault({ home: f.home, mode: 'auto', keychain: () => kc });
  assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
  assert.equal(reader.has('provider/KEEP'), true);
  assert.deepEqual(reader.list(), ['provider/KEEP']);
  assert.equal(reader.status().ok, true);
});

test('B6: failed deletion never caches an uncommitted map', (t) => {
  const f = fixture(t);
  let key: Buffer = readFileSync(f.key);
  let fail = false;
  rmSync(f.key);
  const kc: KeyStore = { kind: 'keychain', name: 'synthetic-keychain', available: () => ({ ok: true, detail: 'test' }),
    read: () => key, write: (next) => { if (fail) throw new Error('synthetic store failure'); key = next; }, remove: () => {} };
  const reader = new Vault({ home: f.home, mode: 'auto', keychain: () => kc });
  reader.put('provider/OTHER', 'synthetic-other');
  const before = readFileSync(f.file);
  fail = true;
  assert.throws(() => reader.delete('provider/KEEP'), /synthetic store failure/);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
  assert.deepEqual(reader.list(), ['provider/KEEP', 'provider/OTHER']);
});

test('B6: a warm reader authenticates changed ciphertext and notices a lost key', (t) => {
  const f = fixture(t), reader = new Vault({ home: f.home, mode: 'file' });
  assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
  const before = readFileSync(f.file), key = readFileSync(f.key);
  writeFileSync(f.file, JSON.stringify({ ...JSON.parse(before.toString()), tag: Buffer.alloc(16).toString('base64') }));
  assert.throws(() => reader.get('provider/KEEP'), /doesn’t open with its key/);
  writeFileSync(f.file, before);
  rmSync(f.key);
  assert.equal(reader.status().ok, false);
  assert.throws(() => reader.get('provider/KEEP'), /can’t find the key/);
  writeFileSync(f.key, key);
  assert.equal(reader.get('provider/KEEP'), 'synthetic-keep-value');
});

test('B6: key-file promotion waits until committed ciphertext authenticates', (t) => {
  const f = fixture(t), key = readFileSync(f.key);
  writeFileSync(f.file, JSON.stringify({ ...JSON.parse(readFileSync(f.file, 'utf8')), tag: Buffer.alloc(16).toString('base64') }));
  let stored: Buffer | null = null;
  const kc: KeyStore = { kind: 'keychain', name: 'synthetic-keychain', available: () => ({ ok: true, detail: 'test' }),
    read: () => stored, write: (next) => { stored = next; }, remove: () => {} };
  assert.throws(() => new Vault({ home: f.home, mode: 'auto', keychain: () => kc }).get('provider/KEEP'), /doesn’t open with its key/);
  assert.deepEqual(readFileSync(f.key), key);
  assert.equal(stored, null);
});

test('B6: recovery revalidates pending authentication after acquiring the writer lock', (t) => {
  const f = interrupted(t), key = readFileSync(f.key);
  const bad = Buffer.from(JSON.stringify({ ...JSON.parse(f.next.toString()), tag: Buffer.alloc(16).toString('base64') }));
  rmSync(f.key);
  const kc: KeyStore = { kind: 'keychain', name: 'synthetic-keychain', available: () => ({ ok: true, detail: 'test' }),
    read: () => { if (existsSync(f.lock)) writeFileSync(f.tmp, bad); return key; },
    write: () => assert.fail('recovery must not write the key'), remove: () => {} };
  assert.throws(() => new Vault({ home: f.home, mode: 'auto', keychain: () => kc }).get('provider/KEEP'), /can’t find the key/);
  assert.deepEqual(readFileSync(f.file), f.before);
  assert.deepEqual(readFileSync(f.tmp), bad);
  assert.equal(existsSync(f.lock), false);
});
