// T2: passkeys on the hub's own screen, through a software ES256 authenticator (real WebAuthn
// authenticator data, client data and signatures; no browser, no real authenticator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Db } from '../../src/core/db.ts';
import { ConsolePasskeys } from '../../src/core/passkeys.ts';
import { CoreError } from '../../src/core/errors.ts';

const ORIGIN = 'http://localhost:4318';
const rpHash = (rp = 'localhost') => createHash('sha256').update(rp).digest();

class SoftKey {
  id = randomBytes(32).toString('base64url');
  #key: KeyObject;
  spki: string;
  #count = 0;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    this.spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  }
  create(challenge: string, o: { origin?: string; flags?: number; rp?: string; id?: string } = {}) {
    const cred = Buffer.from(o.id ?? this.id, 'base64url');
    const len = Buffer.alloc(2); len.writeUInt16BE(cred.length);
    const auth = Buffer.concat([rpHash(o.rp), Buffer.from([o.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), len, cred, Buffer.from([0xa0])]);
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? ORIGIN }));
    return { credential_id: this.id, public_key: this.spki, authenticator_data: auth.toString('base64url'), client_data_json: cdj.toString('base64url') };
  }
  get(c: { id: string; digest: string; challenge: string }, o: { origin?: string } = {}) {
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.#count);
    const auth = Buffer.concat([rpHash(), Buffer.from([0x05]), count]);
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: c.challenge, origin: o.origin ?? ORIGIN }));
    const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(cdj).digest()]), this.#key);
    return { id: c.id, digest: c.digest, credential_id: this.id, authenticator_data: auth.toString('base64url'), client_data_json: cdj.toString('base64url'), signature: signature.toString('base64url') };
  }
}

function setup() {
  const db = new Db(':memory:');
  db.migrate();
  return { db, p: new ConsolePasskeys({ db }) };
}
const refused = (fn: () => unknown, code: string, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof CoreError && e.code === code && re.test(e.message));

test('the first passkey is taken on trust; a second needs the first; two complete setup', () => {
  const { p } = setup();
  assert.deepEqual(p.state(), { count: 0, complete: false, first_enrolled_at: null, passkeys: [] });
  const a = new SoftKey();
  const o1 = p.options(ORIGIN);
  assert.equal(o1.approval, undefined, 'nothing to sign with yet');
  assert.equal(o1.rp.id, 'localhost');
  const s1 = p.add({ registration: o1.registration, name: 'Security key', ...a.create(o1.challenge) }, ORIGIN);
  assert.equal(s1.count, 1);
  assert.equal(s1.complete, false, 'one passkey is not a complete setup');
  assert.ok(s1.first_enrolled_at);

  const b = new SoftKey();
  const o2 = p.options(ORIGIN);
  assert.ok(o2.approval, 'adding another needs an existing passkey');
  refused(() => p.add({ registration: o2.registration, ...b.create(o2.challenge) }, ORIGIN), 'forbidden', /needs one you already have/);
  const o3 = p.options(ORIGIN);
  const s2 = p.add({ registration: o3.registration, ...b.create(o3.challenge), approval: a.get(o3.approval!) }, ORIGIN);
  assert.equal(s2.count, 2);
  assert.equal(s2.complete, true);
  assert.equal(s2.first_enrolled_at, s1.first_enrolled_at, 'the first enrollment date stays');
});

test('an approval confirms exactly one action, once', () => {
  const { p } = setup();
  const a = new SoftKey();
  const o = p.options(ORIGIN);
  p.add({ registration: o.registration, ...a.create(o.challenge) }, ORIGIN);
  const action = { method: 'POST', path: '/tasks/t1/approve', body: { confirm: true } };
  const c = p.challenge(action, 'Approve the task');
  const signed = a.get(c);
  assert.match(p.verify({ ...action, path: '/tasks/t2/approve' }, signed) ?? '', /another action/, 'not for another action');
  assert.equal(p.verify(action, signed), null, 'the action it was made for');
  assert.match(p.verify(action, signed) ?? '', /used/, 'and only once');
  const c2 = p.challenge(action, 'Approve the task');
  assert.match(p.verify(action, a.get(c2, { origin: 'http://localhost:9999' })) ?? '', /origin/, 'signed on another page');
});

test('a tier-3 request is approved for exactly its method, path and body', () => {
  const { p } = setup();
  const a = new SoftKey();
  const o = p.options(ORIGIN);
  p.add({ registration: o.registration, ...a.create(o.challenge) }, ORIGIN);
  const c = p.requestChallenge({ method: 'post', path: '/mesh/promote', body: { confirm: true } });
  const signed = a.get(c);
  const same = ConsolePasskeys.action('POST', '/mesh/promote', { confirm: true, passkey_approval: signed });
  assert.match(p.verify(ConsolePasskeys.action('POST', '/mesh/promote', { confirm: true, extra: 1 }), signed) ?? '', /another action/, 'another body');
  assert.equal(p.verify(same, signed), null, 'the approval itself is not part of the action');
  refused(() => p.requestChallenge({ method: 'GET', path: '/x', body: {} }), 'validation', /names the request/);
});

test('passkeys only on localhost, with presence and verification, for this site', () => {
  const { p } = setup();
  refused(() => p.options('http://127.0.0.1:4318'), 'validation', /localhost/);
  refused(() => p.options('https://hub.example:4320'), 'validation', /localhost/);
  const a = new SoftKey();
  let o = p.options(ORIGIN);
  refused(() => p.add({ registration: o.registration, ...a.create(o.challenge, { flags: 0x41 }) }, ORIGIN), 'validation', /presence and verification/);
  o = p.options(ORIGIN);
  refused(() => p.add({ registration: o.registration, ...a.create(o.challenge, { rp: 'example.com' }) }, ORIGIN), 'validation', /another site/);
  o = p.options(ORIGIN);
  refused(() => p.add({ registration: o.registration, ...a.create('wrong-challenge') }, ORIGIN), 'validation', /another request/);
  o = p.options(ORIGIN);
  refused(() => p.add({ registration: o.registration, ...a.create(o.challenge, { id: new SoftKey().id }) }, ORIGIN), 'validation', /don’t match/);
  assert.equal(p.state().count, 0);
});

test('no passkey yet: nothing to approve with; the last passkey stays', () => {
  const { p } = setup();
  refused(() => p.challenge({ op: 'x' }, 'x'), 'conflict', /No passkey yet/);
  const a = new SoftKey();
  const b = new SoftKey();
  let o = p.options(ORIGIN);
  p.add({ registration: o.registration, ...a.create(o.challenge) }, ORIGIN);
  refused(() => p.remove(a.id, a.get(p.removeChallenge(a.id))), 'conflict', /only passkey/);
  o = p.options(ORIGIN);
  p.add({ registration: o.registration, ...b.create(o.challenge), approval: a.get(o.approval!) }, ORIGIN);
  refused(() => p.remove(a.id, null), 'forbidden', /needs one you already have/);
  const s = p.remove(a.id, b.get(p.removeChallenge(a.id)));
  assert.deepEqual(s.passkeys.map((x) => x.id), [b.id]);
});

test('passkeys are managed on the hub’s own screen only', () => {
  const { p } = setup();
  const routes = Object.fromEntries(p.routes().map((r) => [`${r.method} ${r.path}`, r]));
  const device = { principal: { kind: 'device', device: {} }, listener: 'mesh', address: 'x' } as never;
  refused(() => routes['GET /security/passkeys']!.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: device }), 'forbidden', /own screen only/);
  const console = { principal: { kind: 'console' }, listener: 'console', address: 'console' } as never;
  assert.equal((routes['GET /security/passkeys']!.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: console }) as { count: number }).count, 0);
});

// Core's port of the broker's checks must give the broker's answers (core may not import broker code).
import { challengeBytes as brokerChallenge, checkAssertion as brokerCheck, digestOf as brokerDigest } from '../../src/broker/policy.ts';
import { challengeBytes as coreChallenge, checkAssertion as coreCheck, digestOf as coreDigest } from '../../src/core/passkeys.ts';

test('core’s passkey checks give the broker’s answers', () => {
  for (const action of [{ op: 'x' }, { method: 'POST', path: '/tasks/t1/approve', body: { confirm: true, b: [1, { z: 1, a: 2 }] } }, { a: undefined, b: null }]) {
    assert.equal(coreDigest(action), brokerDigest(action));
    assert.ok(coreChallenge('ap_1', coreDigest(action)).equals(brokerChallenge('ap_1', brokerDigest(action))));
  }
  const k = new SoftKey();
  const keys = { [k.id]: { public_key: k.spki, rp_id: 'localhost', origins: [ORIGIN], sign_count: 0, registered_at: 'x' } };
  const c = { id: 'ap_1', digest: coreDigest({ op: 'x' }), challenge: coreChallenge('ap_1', coreDigest({ op: 'x' })).toString('base64url') };
  const ch = Buffer.from(c.challenge, 'base64url');
  const good = k.get(c);
  const tamper = (f: (x: Record<string, string>) => void) => { const x: Record<string, string> = { ...k.get(c) }; f(x); return x; };
  const cases: Record<string, Record<string, string>> = {
    good,
    'wrong challenge': k.get({ ...c, challenge: 'x' }),
    'another page': k.get(c, { origin: 'http://localhost:1' }),
    'bad signature': tamper((x) => { x.signature = Buffer.alloc(70, 1).toString('base64url'); }),
    'no verification': tamper((x) => { const a = Buffer.from(x.authenticator_data!, 'base64url'); a[32] = 0x01; x.authenticator_data = a.toString('base64url'); }),
    'unknown key': tamper((x) => { x.credential_id = 'AAAAAAAAAAAAAAAAAAAAAA'; }),
  };
  for (const [name, a] of Object.entries(cases)) {
    const b = brokerCheck(a, ch, structuredClone(keys), () => {});
    const m = coreCheck(a, ch, structuredClone(keys), () => {});
    assert.equal(m === null, b === null, `${name}: core ${m} vs broker ${b}`);
  }
  assert.equal(coreCheck(good, ch, structuredClone(keys), () => {}), null, 'a good one passes');
  const seen = { [k.id]: { ...keys[k.id]!, sign_count: 99 } };
  assert.equal(coreCheck(k.get(c), ch, structuredClone(seen), () => {}) === null, brokerCheck(k.get(c), ch, structuredClone(seen), () => {}) === null, 'counter went back');
});
