// Owner C: defensive public fixtures, ordinary approved metadata changes, no owner data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { addressClass, requestPath } from '../../src/broker/origin.ts';
import { MARK, Scrubber } from '../../src/broker/scrub.ts';
import { Person, boundCredential, inProcess, standIn, type A } from '../support/broker-support.ts';

const publicValue = 'PUBLIC-é😀<>&\'"\\\n-FIXTURE';
// Literal expected JSON spellings, independent of the production form generator.
const echoes = [
  'PUBLIC-é😀\\u003c\\u003e\\u0026\'\\"\\\\\\n-FIXTURE',
  'PUBLIC-\\u00e9\\ud83d\\ude00<>&\'\\"\\\\\\n-FIXTURE',
  'PUBLIC-\\u00e9\\ud83d\\ude00\\u003c\\u003e\\u0026\\u0027\\"\\\\\\n-FIXTURE',
];
for (const [i, lower] of echoes.entries()) for (const upper of [false, true]) {
  const echo = upper ? lower.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => `\\u${h.toUpperCase()}`) : lower;
  test(`C F1 JSON form ${i} ${upper ? 'upper' : 'lower'} UTF16 escapes and safe text`, () => {
    const s = new Scrubber([publicValue]);
    assert.equal(s.text(`prefix ${echo} suffix`), `prefix ${MARK} suffix`);
    assert.equal(s.text('ordinary safe Unicode é😀 and <tags>'), 'ordinary safe Unicode é😀 and <tags>');
  });
}

test('C F1 ordinary JSON echo responses use the same scrubbing boundary', async () => {
  const site = await standIn((_req, res) => res.end(echoes.join('|')));
  const b = inProcess();
  try {
    const p = new Person(b.call); await p.setup();
    const made = await boundCredential(p, site.origin, { value: publicValue, how: 'sign', header: 'X-Public-Signature' });
    const used = await b.call('use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api' } });
    assert.equal(used.ok, true); assert.equal(used.outcome.body, [MARK, MARK, MARK].join('|'));
  } finally { await site.close(); b.broker.store.lock(); rmSync(join(b.dir, '..'), { recursive: true, force: true }); }
});

test('C F2 alias collision refuses rename without changing metadata or use resolution', async () => {
  const site = await standIn((_req, res) => res.end('public response'));
  const b = inProcess();
  try {
    const p = new Person(b.call); await p.setup();
    const alpha = await boundCredential(p, site.origin, { name: 'provider/ALPHA', value: 'PUBLIC-ALPHA-FIXTURE' });
    const beta = await boundCredential(p, site.origin, { name: 'provider/BETA', value: 'PUBLIC-BETA-FIXTURE' });
    const before = (await b.call('list_refs')).refs;
    const denied = await p.approve('update', { ref: beta.ref, change: { meta: { name: 'provider/ALPHA' } } });
    assert.equal(denied.error, 'failed');
    assert.deepEqual((await b.call('list_refs')).refs, before);
    const used = await b.call('use', { ref: 'secret://provider/ALPHA', target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api' } });
    assert.equal(used.ok, true); assert.equal(site.requests[0]!.headers.authorization, 'Bearer PUBLIC-ALPHA-FIXTURE');
    assert.equal((await p.approve('update', { ref: beta.ref, change: { meta: { name: 'provider/GAMMA' } } })).ok, true);
    assert.equal((await p.approve('update', { ref: alpha.ref, change: { meta: { name: 'provider/ALPHA', username: 'public-user' } } })).ok, true);
  } finally { await site.close(); b.broker.store.lock(); rmSync(join(b.dir, '..'), { recursive: true, force: true }); }
});

for (const change of ['narrow', 'withdraw', 'detail']) test(`FR1 approved binding ${change} advances generation and keeps effective metadata`, async () => {
  const b = inProcess();
  try {
    const p = new Person(b.call); await p.setup();
    const target = { kind: 'http', origin: 'https://example.test' };
    const binding: A = { target, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' }, consent: {} };
    const made = await p.approve('create', { meta: { name: 'test/PUBLIC', kind: 'secret', class: 'standard' }, source: 'generate', bind: [binding] });
    assert.equal(made.ok, true);
    const add: A = { ...binding, ...(change === 'narrow' ? { scope: { methods: ['GET'], paths: ['/public'] } } : change === 'withdraw' ? { consent: null } : { inject: { how: 'basic' } }) };
    const before = b.broker.store.header!.gen;
    const changed = await p.approve('bind', { ref: made.ref, add });
    assert.equal(changed.ok, true);
    assert.equal(b.broker.store.header!.gen, before + 1);
    assert.deepEqual(changed.bindings[0].scope, add.scope);
    assert.deepEqual(changed.bindings[0].inject, add.inject);
    if (change === 'withdraw') assert.equal(changed.bindings[0].consent, null);
    assert.equal((await b.call('bind', { ref: made.ref, remove: { target } })).ok, true);
    assert.equal(b.broker.store.header!.gen, before + 2);
  } finally { b.broker.store.lock(); rmSync(join(b.dir, '..'), { recursive: true, force: true }); }
});

test('C N1 compatible IPv4 and Teredo classify private with boundaries', () => {
  for (const addr of ['::192.168.1.1', '::c0a8:101', '0:0:0:0:0:0:ffff:ffff', '2001::1', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff']) assert.equal(addressClass(addr), 'private', addr);
  for (const addr of ['::1:0:0', '2001:1::', '2001:4860:4860::8888', '2606:4700::1111']) assert.equal(addressClass(addr), 'public', addr);
  assert.equal(addressClass('::1'), 'loopback');
});

test('C N2 N3 paths refuse ambiguous encoded delimiters and raw nonASCII while retaining benign encoding', () => {
  for (const path of ['/api/%252fother', '/api/%255Cother', '/api/%252e%252e', '/api/%25252fother', '/api/%25%32%66other', '/api/café']) assert.throws(() => requestPath(path), /request path/, path);
  for (const path of ['/api/caf%C3%A9', '/api/hello%20world', '/api/%41', '/api/percent%25value', '/api?name=caf%C3%A9']) assert.equal(requestPath(path).path, path);
});

test('C N2 N3 real HTTP wire retains benign ASCII percent encoding and refuses ambiguous paths before connecting', async () => {
  const site = await standIn((_req, res) => res.end('public response')), b = inProcess();
  try {
    const p = new Person(b.call); await p.setup();
    const made = await boundCredential(p, site.origin);
    const use = (path: string) => b.call('use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path } });
    for (const path of ['/api/%252fother', '/api/café']) assert.equal((await use(path)).refused, 'out_of_scope');
    assert.equal(site.connections, 0);
    assert.equal((await use('/api/caf%C3%A9?name=%41')).ok, true);
    assert.equal(site.requests[0]!.url, '/api/caf%C3%A9?name=%41');
  } finally { await site.close(); b.broker.store.lock(); rmSync(join(b.dir, '..'), { recursive: true, force: true }); }
});

test('FR5 sanitized HTTP body does not retain upstream length or content validator', async () => {
  const value = 'PUBLIC-HTTP-BODY-FIXTURE';
  const site = await standIn((_req, res) => {
    res.setHeader('content-type', 'text/plain'); res.setHeader('content-length', Buffer.byteLength(value));
    res.setHeader('etag', '"public-body-validator"'); res.setHeader('retry-after', '10'); res.end(value);
  });
  const b = inProcess();
  try {
    const p = new Person(b.call); await p.setup();
    const made = await boundCredential(p, site.origin, { value });
    const used = await b.call('use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api' } });
    assert.equal(used.ok, true); assert.equal(used.outcome.body, MARK);
    assert.equal(used.outcome.headers['content-length'], undefined);
    assert.equal(used.outcome.headers.etag, undefined);
    assert.equal(used.outcome.headers['content-type'], 'text/plain'); assert.equal(used.outcome.headers['retry-after'], '10');
  } finally { await site.close(); b.broker.store.lock(); rmSync(join(b.dir, '..'), { recursive: true, force: true }); }
});
