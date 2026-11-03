// Interrupted legacy-vault rekey recovery: synthetic files/keys in temporary homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../../src/core/vault.ts';
import { readOldVault, removeFromOldVault, withOldVaultLock } from '../../src/broker/oldvault.ts';
import { C, Person, inProcess, tmp } from '../support/broker-support.ts';

function interrupted() {
  const home = tmp('nova-broker-migration-recovery-');
  const legacy = new Vault({ home, mode: 'file' });
  legacy.put('provider/REMOVED', C('already-moved'));
  legacy.put('provider/KEEP', C('still-to-move'));
  legacy.put('nova/backup-key', C('core-owned'));
  const file = join(home, 'vault/secrets.json');
  const before = readFileSync(file);
  withOldVaultLock(home, () => {
    const old = readOldVault(home)!;
    try { assert.deepEqual(removeFromOldVault(home, old, ['provider/REMOVED']), ['provider/REMOVED']); }
    finally { old.key.fill(0); }
  });
  const next = readFileSync(file);
  // Reconstruct the writer's persisted state after saving the new key and before its rename.
  writeFileSync(file, before);
  writeFileSync(`${file}.tmp`, next, { mode: 0o600 });
  return { home, file, before, next };
}

async function broker(home: string) {
  const b = inProcess(join(home, 'broker'));
  const p = new Person(b.call);
  await p.setup();
  return { ...b, p };
}

const stage = { source: { migrate: 'stage' } };

// An independently authenticated different vault under the same synthetic saved key. Merely
// changing the id would also break GCM authentication and could not catch a missing same-id check.
function unrelated(home: string): Buffer {
  const key = readFileSync(join(home, 'vault/key'));
  try {
    const id = randomUUID();
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from(`nova-vault-v1|${id}`));
    const data = Buffer.concat([c.update(JSON.stringify({ 'provider/PLANTED': C('unrelated') })), c.final()]);
    return Buffer.from(JSON.stringify({ v: 1, id, alg: 'aes-256-gcm', fp: createHash('sha256').update(key).digest('hex').slice(0, 16), nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }));
  } finally { key.fill(0); }
}

test('broker migration resumes an interrupted authenticated rekey without reopening the old vault in core', async () => {
  const f = interrupted();
  const b = await broker(f.home);
  try {
    const staged = await b.call('create', stage);
    assert.equal(staged.ok, true, JSON.stringify(staged));
    assert.equal(staged.outcome.staged, 1, 'only the still-unmigrated credential is staged');
    assert.deepEqual(readFileSync(f.file), f.next, 'the authenticated pending file is promoted');
    assert.equal(existsSync(`${f.file}.tmp`), false);
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    const committed = await b.p.approve('create', { source: { migrate: 'commit' } });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.deepEqual(committed.outcome.migrated, ['provider/KEEP']);
    assert.equal(committed.outcome.removed, 1);
    withOldVaultLock(f.home, () => {
      const old = readOldVault(f.home)!;
      try { assert.deepEqual([...old.map], [['nova/backup-key', C('core-owned')]], 'core-owned key remains; removed credentials are never resurrected'); }
      finally { old.key.fill(0); }
    });
  } finally { b.broker.lock(); }
});

for (const kind of ['malformed', 'tampered', 'different-id', 'wrong-format'] as const) {
  test(`pending legacy rekey recovery refuses ${kind} ciphertext without changing any file or key`, async () => {
    const f = interrupted();
    const parsed = JSON.parse(f.next.toString('utf8'));
    const bad = kind === 'malformed' ? Buffer.from('{not json')
      : kind === 'different-id' ? unrelated(f.home)
      : Buffer.from(JSON.stringify(kind === 'wrong-format' ? { ...parsed, alg: 'aes-128-gcm' }
        : { ...parsed, tag: Buffer.alloc(16).toString('base64') }));
    writeFileSync(`${f.file}.tmp`, bad);
    const key = readFileSync(join(f.home, 'vault/key'));
    const b = await broker(f.home);
    try {
      const refused = await b.call('create', stage);
      assert.equal(refused.error, 'failed');
      assert.deepEqual(readFileSync(f.file), f.before);
      assert.deepEqual(readFileSync(`${f.file}.tmp`), bad);
      assert.deepEqual(readFileSync(join(f.home, 'vault/key')), key);
      assert.deepEqual((await b.call('list_refs')).refs, []);
    } finally { key.fill(0); b.broker.lock(); }
  });
}

test('pending rekey recovery never bypasses an existing legacy writer lock', async () => {
  const f = interrupted();
  const b = await broker(f.home);
  const lock = join(f.home, 'vault/.writer-lock');
  mkdirSync(lock);
  try {
    assert.equal((await b.call('create', stage)).error, 'failed');
    assert.deepEqual(readFileSync(f.file), f.before);
    assert.deepEqual(readFileSync(`${f.file}.tmp`), f.next);
    assert.equal(existsSync(lock), true, 'an existing lock is never removed or stolen');
  } finally { rmSync(lock, { recursive: true }); }
  try { assert.equal((await b.call('create', stage)).ok, true, 'recovery proceeds after the writer releases its lock'); }
  finally { b.broker.lock(); }
});

test('an openable current legacy file is never replaced by unrelated pending ciphertext', async () => {
  const f = interrupted();
  writeFileSync(f.file, f.next);
  const other = unrelated(f.home);
  writeFileSync(`${f.file}.tmp`, other);
  const b = await broker(f.home);
  try {
    const staged = await b.call('create', stage);
    assert.equal(staged.ok, true);
    assert.equal(staged.outcome.staged, 1);
    assert.deepEqual(readFileSync(f.file), f.next);
    assert.deepEqual(readFileSync(`${f.file}.tmp`), other);
  } finally { b.broker.lock(); }
});
