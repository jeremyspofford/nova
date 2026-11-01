// Nova Vault's store (docs/plans/vault-broker.md §10; gate item 7): Argon2id from Node's standard
// library at RFC 9106's floor or above, per-item encryption, every factor, tamper and swap, a
// deleted item that no older copy opens, a rotation cut short, and holder sync with device wraps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argon2Sync, randomBytes } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KDF_FLOOR, argon2id, calibrate, entryKey, openEnvelope } from '../../src/broker/crypto.ts';
import { fileStores } from '../../src/broker/keystore.ts';
import { Store, type Meta } from '../../src/broker/store.ts';
import { sealValue } from '../../src/broker/seal.ts';
import { C, PASS, anyForm, kdf, tmp } from '../support/broker-support.ts';

const meta = (name: string, kind = 'api_key'): Meta => ({ name, aliases: [`secret://${name}`], kind, origin: null, username: null, class: 'standard', per_use: false, created_at: new Date().toISOString(), last_used: null, last_rotated: null, bindings: [], policy: { length: 24, alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789' } });
const store = (dir = join(tmp(), 'broker')) => new Store({ dir, kdf: kdf(), deviceStore: fileStores(dir) });
const allText = (dir: string): string => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'latin1')).join('\n');

test('Argon2id is Node’s own (RFC 9106 test vector), and the broker never goes below the floor', () => {
  // RFC 9106 §5.3: Argon2id, password 32×0x01, salt 16×0x02, secret 8×0x03, AD 12×0x04, t=3, m=32, p=4.
  const tag = argon2Sync('argon2id', { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4), passes: 3, memory: 32, parallelism: 4, tagLength: 32 });
  assert.equal(tag.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  assert.deepEqual(KDF_FLOOR, { m: 65536, t: 3, p: 4 }, 'RFC 9106’s second recommended setting');
  assert.throws(() => argon2id(Buffer.from('x'), { alg: 'argon2id', m: 32768, t: 3, p: 4, salt: randomBytes(16).toString('base64') }), /floor/);
  const k = calibrate(1, KDF_FLOOR.m);
  assert.ok(k.m >= KDF_FLOOR.m && k.t >= 3 && k.p >= 4, 'calibration starts at the floor');
  const s = store();
  s.create({ passphrase: Buffer.from(PASS) });
  const h = JSON.parse(readFileSync(join(s.dir, 'vault.json'), 'utf8'));
  assert.equal(h.kdf.alg, 'argon2id');
  assert.ok(h.kdf.m >= 65536 && h.kdf.t >= 3 && h.kdf.p >= 4, 'the parameters are recorded in the header');
});

test('every factor opens the vault, a wrong one doesn’t, and each item is sealed on its own', () => {
  const dir = join(tmp(), 'broker');
  const recovery = randomBytes(32);
  const prf = randomBytes(32);
  let s = store(dir);
  s.create({ passphrase: Buffer.from(PASS), recovery, passkeys: [{ id: 'pk1', prf, public_key: 'x', rp_id: 'localhost', origins: ['https://localhost'] }] });
  const a = s.add(meta('provider/A'), Buffer.from(C('a')));
  const b = s.add(meta('provider/B'), Buffer.from(C('b')));
  s.lock();
  assert.throws(() => s.value(a.id), /locked/);
  for (const f of [{ kind: 'passphrase' as const, secret: Buffer.from(PASS) }, { kind: 'recovery' as const, secret: recovery }, { kind: 'passkey' as const, id: 'pk1', secret: prf }, { kind: 'device' as const }]) {
    s = new Store({ dir, deviceStore: fileStores(dir) });
    s.unlock(f);
    assert.equal(s.value(b.id).toString(), C('b'), `${f.kind} opens it`);
    s.lock();
  }
  assert.throws(() => s.unlock({ kind: 'passphrase', secret: Buffer.from('wrong-passphrase') }), /doesn’t open/);
  assert.throws(() => s.unlock({ kind: 'passkey', id: 'pk1', secret: randomBytes(32) }), /doesn’t open/);
  // Nothing on disk holds a value, the passphrase, the recovery key or the PRF output.
  const text = allText(dir);
  for (const v of [C('a'), C('b'), PASS, recovery.toString('base64'), prf.toString('base64')]) assert.equal(anyForm(text, v), null, `${v.slice(0, 12)}… is on disk`);
});

test('a tampered item fails on its own, a swapped or moved item is refused, and the others still open', () => {
  const s = store();
  s.create({ passphrase: Buffer.from(PASS) });
  const a = s.add(meta('provider/A'), Buffer.from(C('a')));
  const b = s.add(meta('provider/B'), Buffer.from(C('b')));
  const c = s.add(meta('provider/C'), Buffer.from(C('c')));
  const pa = join(s.dir, 'items', `${a.id}.json`);
  const f = JSON.parse(readFileSync(pa, 'utf8'));
  const ct = Buffer.from(f.value.c, 'base64');
  ct[0] = ct[0]! ^ 1;
  writeFileSync(pa, JSON.stringify({ ...f, value: { ...f.value, c: ct.toString('base64') } }));
  assert.throws(() => s.value(a.id));
  assert.equal(s.value(c.id).toString(), C('c'));
  // B's file put under C's name: refused before anything opens; and B's blob with C's id inside
  // fails authentication (the associated data names the item).
  const pb = join(s.dir, 'items', `${b.id}.json`);
  const pc = join(s.dir, 'items', `${c.id}.json`);
  const keepC = readFileSync(pc, 'utf8');
  cpSync(pb, pc);
  assert.throws(() => s.value(c.id), /isn’t the file it claims to be/);
  writeFileSync(pc, JSON.stringify({ ...JSON.parse(readFileSync(pb, 'utf8')), id: c.id }));
  assert.throws(() => s.value(c.id));
  writeFileSync(pc, keepC);
  const m = s.metas();
  assert.deepEqual(m.broken.sort(), [a.id].sort(), 'only the tampered item is broken');
  assert.equal(s.value(b.id).toString(), C('b'));
});

test('a deleted item doesn’t open from an older copy of the store, with any key that still exists', () => {
  const dir = join(tmp(), 'broker');
  const s = store(dir);
  s.create({ passphrase: Buffer.from(PASS) });
  const keep = s.add(meta('provider/KEEP'), Buffer.from(C('keep')));
  const gone = s.add(meta('provider/GONE'), Buffer.from(C('gone')));
  const old = join(tmp(), 'old-copy');
  cpSync(dir, old, { recursive: true });
  const oldKey = readFileSync(join(dir, 'device.key'));
  s.remove(gone.id);
  assert.equal(existsSync(join(dir, 'items', `${gone.id}.json`)), false);
  assert.notDeepEqual(readFileSync(join(dir, 'device.key')), oldKey, 'this device’s own key was renewed too');
  assert.equal(s.value(keep.id).toString(), C('keep'), 'the others still open');
  // The old blob, put back beside the current header: stale generation, refused.
  cpSync(join(old, 'items', `${gone.id}.json`), join(dir, 'items', `${gone.id}.json`));
  assert.throws(() => s.value(gone.id));
  // The old copy as a whole, opened with every key that exists now (device key and passphrase are
  // the person's; the device key file is the current one): the device wrap doesn't open.
  cpSync(join(dir, 'device.key'), join(old, 'device.key'));
  cpSync(join(dir, 'device.json'), join(old, 'device.json'));
  const o = new Store({ dir: old, deviceStore: fileStores(old) });
  assert.throws(() => o.unlock({ kind: 'device' }));
  // The stated limit: an old header copy with the person's own passphrase still opens what it
  // held. That is why no header ever goes into a backup, and the outbox carries none of its
  // factor wraps (see the holder-sync test and tests/core/broker-canary.test.ts).
  o.unlock({ kind: 'passphrase', secret: Buffer.from(PASS) });
  assert.equal(o.value(gone.id).toString(), C('gone'));
  rmSync(join(dir, 'items', `${gone.id}.json`));
});

test('a rotation cut short is finished at the next unlock; no item is lost', () => {
  const dir = join(tmp(), 'broker');
  const s = store(dir);
  s.create({ passphrase: Buffer.from(PASS) });
  const ids = [1, 2, 3, 4].map((n) => s.add(meta(`provider/K${n}`), Buffer.from(C(`k${n}`))).id);
  // Run a rotation and stop it after the header names the next generation and one item moved.
  const before = readFileSync(join(dir, 'vault.json'), 'utf8');
  const copies = Object.fromEntries(ids.map((id) => [id, readFileSync(join(dir, 'items', `${id}.json`), 'utf8')]));
  s.rotateRoot();
  const afterHeader = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'));
  const moved = readFileSync(join(dir, 'items', `${ids[0]}.json`), 'utf8');
  const h0 = JSON.parse(before);
  // Rebuild the cut-short state: the old generation current, the new one in `next`, item 0 moved.
  writeFileSync(join(dir, 'vault.json'), JSON.stringify({ ...h0, next: { gen: afterHeader.gen, wraps: afterHeader.wraps } }));
  for (const id of ids) writeFileSync(join(dir, 'items', `${id}.json`), copies[id]!);
  writeFileSync(join(dir, 'items', `${ids[0]}.json`), moved);
  const t = new Store({ dir, deviceStore: fileStores(dir) });
  t.unlock({ kind: 'passphrase', secret: Buffer.from(PASS) });
  const h = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'));
  assert.equal(h.next, undefined, 'finished');
  assert.equal(h.gen, afterHeader.gen);
  for (const [n, id] of ids.entries()) assert.equal(t.value(id).toString(), C(`k${n + 1}`));
});

test('holder sync: the standby opens the hub’s vault with its own wrap; the outbox carries ciphertext and public keys only', () => {
  const hubDir = join(tmp(), 'hub-broker');
  const sbDir = join(tmp(), 'standby-broker');
  const hub = store(hubDir);
  hub.create({ passphrase: Buffer.from(PASS), recovery: Buffer.alloc(32, 7) });
  const a = hub.add(meta('connector/home-assistant/HA_TOKEN', 'token'), Buffer.from(C('ha')));
  const sb = store(sbDir);
  const dev = sb.device();
  hub.enrollHolder(dev.id, dev.public, 'standby');
  const out = JSON.parse(readFileSync(join(hubDir, 'outbox', 'header.json'), 'utf8'));
  assert.deepEqual(Object.keys(out.factor_pubs).sort(), ['passphrase', 'recovery'], 'factor public keys only');
  assert.equal(JSON.stringify(out).includes('"box"') && Object.keys(out.device_wraps).every((n: string) => n.startsWith('device:')), true, 'the only wraps are device wraps');
  const items = Object.fromEntries(readdirSync(join(hubDir, 'items')).map((n) => [n.slice(0, -5), readFileSync(join(hubDir, 'items', n), 'utf8')]));
  const travelled = JSON.stringify(out) + Object.values(items).join('');
  for (const v of [C('ha'), PASS, Buffer.alloc(32, 7).toString('base64'), readFileSync(join(hubDir, 'device.key')).toString('base64'), readFileSync(join(sbDir, 'device.key')).toString('base64')]) assert.equal(anyForm(travelled, v), null);
  sb.adopt(out, items);
  assert.equal(sb.value(a.id).toString(), C('ha'));
  // The standby sealed the root key to the person's factors itself: the passphrase opens it there.
  sb.lock();
  const sb2 = new Store({ dir: sbDir, deviceStore: fileStores(sbDir) });
  sb2.unlock({ kind: 'passphrase', secret: Buffer.from(PASS) });
  assert.equal(sb2.value(a.id).toString(), C('ha'));
  sb2.lock();
  sb2.unlock({ kind: 'device' });
  // A device that isn't a holder can't adopt it.
  const other = store();
  assert.throws(() => other.adopt(out, items), /no wrap for this device/);
  // A forged vault, sealed to the standby's public key by anyone who has it (core, say): its
  // header isn't signed by the hub the standby pinned, so it isn't adopted, unsigned or not.
  const forger = store();
  forger.create({ passphrase: Buffer.from('forger-passphrase') });
  forger.add(meta('provider/FORGED'), Buffer.from('forged-value-123456'));
  forger.enrollHolder(dev.id, dev.public, 'standby');
  const forged = JSON.parse(readFileSync(join(forger.dir, 'outbox', 'header.json'), 'utf8'));
  const forgedItems = Object.fromEntries(readdirSync(join(forger.dir, 'items')).map((n) => [n.slice(0, -5), readFileSync(join(forger.dir, 'items', n), 'utf8')]));
  assert.throws(() => sb2.adopt(forged, forgedItems), /isn’t from the hub/);
  assert.throws(() => sb2.adopt({ ...out, gen: out.gen + 1 }, items), /isn’t signed/, 'a header changed after signing');
  const { sig: _s, ...unsigned } = out;
  assert.throws(() => sb2.adopt(unsigned, items), /isn’t signed/);
  assert.equal(sb2.value(a.id).toString(), C('ha'), 'the vault held is untouched');
});

test('sealed entry: the person’s WebCrypto envelope opens only for the digest it was sealed to', async () => {
  const k = entryKey();
  const d1 = 'a'.repeat(64);
  const env = await sealValue(k.pub, d1, C('sealed'));
  assert.equal(openEnvelope(k.priv, env, d1).toString(), C('sealed'));
  assert.throws(() => openEnvelope(k.priv, env, 'b'.repeat(64)));
  assert.throws(() => openEnvelope(entryKey().priv, env, d1), Error, 'another boot’s entry key');
  assert.equal(anyForm(JSON.stringify(env), C('sealed')), null);
});
