// The mesh's wire primitives: Era 1's code and confirmation vectors (computed independently there,
// with Python's hashlib), the limiter, keys and signatures, the fingerprint, canonical JSON, sealed
// boxes, the signed roster, and the hybrid logical clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HLC_MAX_COUNTER, HybridClock, PAIRING_CODE_ALPHABET, SlidingWindowLimiter, canonicalJson, compareHlc, displayPairingCode,
  exportDeviceKeys, formatHlc, generateDeviceKeys, hlcProblem, importDeviceKeys, keyFingerprint, maxHlc, newPairingCode,
  normalizeConfirmation, normalizePairingCode, open, pairingCodeHash, pairingCommitment, pairingConfirmation, pairingConfirmationV2,
  parseHlc, revealMessage, seal, sessionMessage, signMessage, signRoster, statusMessage, verifyDeviceSignature, verifyRoster,
  x25519Statement, freshTime,
} from '../../src/core/index.ts';

test('codes: Crockford base32, display form, normalizing what a person types', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = newPairingCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 200);
  assert.equal(PAIRING_CODE_ALPHABET.length, 32);
  assert.doesNotMatch(PAIRING_CODE_ALPHABET, /[ILOU]/);
  assert.equal(displayPairingCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(normalizePairingCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizePairingCode(' ab cd ef gh '), 'ABCDEFGH');
  assert.equal(normalizePairingCode('O1IL-0000'), '01110000');
  assert.equal(normalizePairingCode('ABCD-EFGU'), null);
  assert.equal(normalizePairingCode('ABCD-EFG'), null);
  assert.equal(normalizePairingCode('ABCD-EFGHJ'), null);
  assert.equal(normalizeConfirmation('123 456'), '123456');
  assert.equal(normalizeConfirmation('12345'), null);
});

test('Era 1 vectors: code hash, commitment and both confirmations', () => {
  const base = { pairingId: '01920000-0000-7000-8000-00000000aaaa', publicKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', code: 'abcd-efgh' };
  const fp = 'yAs9pQmQ0Kq6tU1t7mNfLwVd9a4m8Wq3b5r2s1x0z7c';
  assert.equal(pairingConfirmation({ ...base, hubFingerprint: '' }), '894633');
  assert.equal(pairingConfirmation({ ...base, hubFingerprint: fp }), '159184');
  assert.equal(pairingCodeHash(base.pairingId, 'ABCD-EFGH'), 'b9cf464b464cbc25c935ca9b478d4bec7f57d005fc5bf346139c494f0eb1b229');
  assert.equal(pairingCodeHash(base.pairingId, base.code), pairingCodeHash(base.pairingId, 'ABCDEFGH'));
  assert.equal(pairingCommitment(base.publicKey, 'n'.repeat(43)), 'oGgjvQosYMHcFu38ZkxXFuaQSn8Z9bQQeOn1AmdB6zo');
  const v2 = { ...base, deviceNonce: 'n'.repeat(43), hubNonce: 'h'.repeat(43) };
  assert.equal(pairingConfirmationV2({ ...v2, hubFingerprint: '' }), '914051');
  assert.equal(pairingConfirmationV2({ ...v2, hubFingerprint: fp }), '721154');
});

test('the limiter allows the limit per key per window and forgets old keys', () => {
  let now = 0;
  const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => now });
  assert.deepEqual([lim.take('a'), lim.take('a'), lim.take('a')], [true, true, false]);
  assert.equal(lim.take('b'), true);
  now = 1001;
  assert.equal(lim.take('a'), true);
  lim.take('c');
  assert.equal(lim.size, 2);
  lim.clear();
  assert.equal(lim.size, 0);
});

test('keys: signatures verify only for their own message and key; key files round-trip', () => {
  const k = generateDeviceKeys();
  const other = generateDeviceKeys();
  const msg = sessionMessage('dev-1', 1000);
  const sig = signMessage(k.ed25519.privateKey, msg);
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, msg, sig), true);
  assert.equal(verifyDeviceSignature(other.ed25519.publicKey, msg, sig), false, 'another key');
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, sessionMessage('dev-1', 1001), sig), false, 'another time');
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, revealMessage('dev-1', 1000), sig), false, 'another purpose');
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, statusMessage('dev-1', 1000), sig), false);
  assert.equal(verifyDeviceSignature('not a key', msg, sig), false);
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, msg, 'short'), false);
  // An X25519 key isn't an Ed25519 key.
  assert.equal(verifyDeviceSignature(k.x25519.publicKey, msg, sig), false);
  const vouch = signMessage(k.ed25519.privateKey, x25519Statement(k.x25519.publicKey));
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, x25519Statement(k.x25519.publicKey), vouch), true);

  const back = importDeviceKeys(exportDeviceKeys(k));
  assert.equal(back.ed25519.publicKey, k.ed25519.publicKey);
  assert.equal(verifyDeviceSignature(k.ed25519.publicKey, msg, signMessage(back.ed25519.privateKey, msg)), true);
  const mixed = exportDeviceKeys(k);
  mixed.ed25519.public = other.ed25519.publicKey;
  assert.throws(() => importDeviceKeys(mixed), /doesn't match/);
  assert.equal(freshTime(1000, 1060), true);
  assert.equal(freshTime(1000, 1061), false);
  assert.equal(freshTime(1.5, 1), false);
});

test('fingerprint: 20 bytes of SHA-256 in eight Crockford groups', () => {
  const k = generateDeviceKeys().ed25519.publicKey;
  const fp = keyFingerprint(k);
  assert.match(fp, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(keyFingerprint(k), fp);
  // A fixed vector: the 32 zero bytes key.
  assert.equal(keyFingerprint(Buffer.alloc(32).toString('base64url')), 'CSM7-NBFR-CAYQ-EV4F-R65R-X7WE-4049-E545');
});

test('canonical JSON sorts keys at every level and refuses what JSON can’t say', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: 2 }], z: undefined }), '{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson({ a: () => 1 }));
});

test('sealed boxes open only for the pair they were sealed between, and only untouched', () => {
  const a = generateDeviceKeys();
  const b = generateDeviceKeys();
  const c = generateDeviceKeys();
  const box = seal(b.x25519.publicKey, a.x25519.privateKey, Buffer.from('the notes'));
  assert.equal(open(a.x25519.publicKey, b.x25519.privateKey, box).toString(), 'the notes');
  // Two seals of the same bytes differ (fresh salt and iv).
  assert.notDeepEqual(seal(b.x25519.publicKey, a.x25519.privateKey, Buffer.from('the notes')), box);
  assert.throws(() => open(a.x25519.publicKey, c.x25519.privateKey, box), 'someone else can’t open it');
  assert.throws(() => open(c.x25519.publicKey, b.x25519.privateKey, box), 'it says who sealed it');
  const bent = Buffer.from(box);
  bent[40] = bent[40]! ^ 1;
  assert.throws(() => open(a.x25519.publicKey, b.x25519.privateKey, bent), 'tampering is caught');
  const withAad = seal(b.x25519.publicKey, a.x25519.privateKey, Buffer.from('x'), Buffer.from('batch 7'));
  assert.equal(open(a.x25519.publicKey, b.x25519.privateKey, withAad, Buffer.from('batch 7')).toString(), 'x');
  assert.throws(() => open(a.x25519.publicKey, b.x25519.privateKey, withAad, Buffer.from('batch 8')));
  assert.throws(() => open(a.x25519.publicKey, b.x25519.privateKey, Buffer.from('short')));
});

test('roster: signed by the hub, verified against pinned keys only', () => {
  const hub = generateDeviceKeys();
  const standby = generateDeviceKeys();
  const stranger = generateDeviceKeys();
  const roster = {
    epoch: 2, issued_at: '2026-10-29T10:00:00.000Z',
    hub: { id: 'hub-1', url: 'https://hub.example:4320', public_key: hub.ed25519.publicKey, x25519_public_key: hub.x25519.publicKey },
  };
  const signed = signRoster(roster, hub.ed25519.privateKey);
  assert.equal(verifyRoster(signed, [hub.ed25519.publicKey]), true);
  assert.equal(verifyRoster(signed, [standby.ed25519.publicKey, hub.ed25519.publicKey]), true);
  assert.equal(verifyRoster(signed, [stranger.ed25519.publicKey]), false);
  assert.equal(verifyRoster({ ...signed, roster: { ...roster, epoch: 3 } }, [hub.ed25519.publicKey]), false, 'a changed roster fails');
  assert.equal(verifyRoster(signRoster(roster, stranger.ed25519.privateKey), [hub.ed25519.publicKey]), false);
});

const T = Date.parse('2026-10-17T09:00:00.000Z');

test('HLC values: fixed widths, parse back, order by time, counter, node', () => {
  const v = formatHlc({ pt: T, c: 10, node: 'hub' });
  assert.equal(v, `00${T}-000a-hub`);
  assert.deepEqual(parseHlc(v), { pt: T, c: 10, node: 'hub' });
  for (const bad of ['', 'x', `${T}-0000-hub`, `00${T}-000g-hub`, `00${T}-0000-`, `00${T}-0000-a b`]) assert.equal(parseHlc(bad), null, bad);
  const a = formatHlc({ pt: T, c: 0, node: 'zzz' });
  const b = formatHlc({ pt: T, c: 1, node: 'aaa' });
  const c = formatHlc({ pt: T + 1, c: 0, node: 'aaa' });
  const d = formatHlc({ pt: T + 1, c: 0, node: 'bbb' });
  assert.deepEqual([d, c, b, a].sort(compareHlc), [a, b, c, d]);
  assert.equal(compareHlc(a, a), 0);
  assert.ok(compareHlc('', a) < 0);
  assert.equal(maxHlc(a, d), d);
  assert.equal(maxHlc(d, a), d);
});

test('HybridClock never goes back, carries on after a restart, and follows remote clocks', () => {
  let now = T;
  const clock = new HybridClock({ node: 'hub', now: () => now });
  assert.deepEqual(parseHlc(clock.tick()), { pt: T, c: 0, node: 'hub' });
  assert.deepEqual(parseHlc(clock.tick()), { pt: T, c: 1, node: 'hub' });
  now = T - 60_000;
  assert.deepEqual(parseHlc(clock.tick()), { pt: T, c: 2, node: 'hub' }, 'a wall clock stepping back');
  const persisted = clock.last();
  const again = new HybridClock({ node: 'hub', now: () => T - 3_600_000, initial: persisted });
  assert.equal(again.last(), persisted);
  assert.ok(compareHlc(again.tick(), persisted) > 0);
  const remote = formatHlc({ pt: T + 5000, c: 7, node: 'dev' });
  assert.deepEqual(parseHlc(clock.receive(remote)), { pt: T + 5000, c: 8, node: 'hub' });
  assert.equal(clock.receive('junk'), clock.last());
  const full = new HybridClock({ node: 'n', now: () => T, initial: formatHlc({ pt: T, c: HLC_MAX_COUNTER, node: 'n' }) });
  assert.deepEqual(parseHlc(full.tick()), { pt: T + 1, c: 0, node: 'n' }, 'the counter overflows into the next millisecond');
  assert.equal(hlcProblem('junk', { node: 'dev', nowMs: T, maxSkewMs: 1000 }), 'invalid_hlc');
  assert.equal(hlcProblem(remote, { node: 'other', nowMs: T + 5000, maxSkewMs: 1000 }), 'hlc_device_mismatch');
  assert.equal(hlcProblem(remote, { node: 'dev', nowMs: T, maxSkewMs: 1000 }), 'clock_skew');
  assert.equal(hlcProblem(remote, { node: 'dev', nowMs: T + 5000, maxSkewMs: 1000 }), null);
});
