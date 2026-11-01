// The broker's only outbound path (docs/plans/vault-broker.md §3 "No network surface", §5 "Devices
// on the LAN"): TLS verified, or pinned for a LAN device; a public name resolving to a private or
// loopback address refused unless the binding is a pinned LAN device; a loopback binding must stay
// on loopback. The certificate is a throwaway made with openssl for this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { C, Person, boundCredential, inProcess, standIn, tmp } from '../support/broker-support.ts';

function cert(host: string) {
  const d = tmp('nova-cert-');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(d, 'k.pem'), '-out', join(d, 'c.pem'), '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const pem = readFileSync(join(d, 'c.pem'));
  return { key: readFileSync(join(d, 'k.pem')), cert: pem, pin: new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase() };
}

test('a public name that resolves to a private address is refused; a loopback binding must stay on loopback', async () => {
  const names: Record<string, string[]> = { 'api.example.com': ['192.168.1.20'], localhost: ['203.0.113.9'] };
  const b = inProcess(join(tmp(), 'broker'), { resolve: async (h) => names[h] ?? [] });
  const p = new Person(b.call);
  await p.setup();
  await boundCredential(p, 'https://api.example.com', { value: C('rebind'), class: 'standard' });
  const r = await b.call('use', { ref: 'secret://provider/EXAMPLE_KEY', target: { kind: 'http', origin: 'https://api.example.com' }, request: { method: 'GET', path: '/api' } });
  assert.equal(r.error, 'failed');
  assert.equal(r.record.outcome, 'failed:address');
  const site = await standIn();
  await boundCredential(p, `http://localhost:${site.port}`, { name: 'provider/LOCAL', value: C('local'), class: 'standard' });
  const l = await b.call('use', { ref: 'secret://provider/LOCAL', target: { kind: 'http', origin: `http://localhost:${site.port}` }, request: { method: 'GET', path: '/api' } });
  assert.equal(l.record.outcome, 'failed:address');
  assert.equal(site.connections, 0);
  // A LAN binding needs a pinned certificate.
  const lan = await b.call('bind', { ref: 'secret://provider/EXAMPLE_KEY', add: { target: { kind: 'http', origin: 'https://router.lan.example' }, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' }, lan: true } });
  assert.match(String(lan.words), /pinned certificate/);
  await site.close();
});

test('TLS: a pinned LAN device is reached only with its own certificate; unpinned, a name resolving here is refused before any TLS', { skip: !cert('probe.example') && 'openssl isn’t available' }, async () => {
  const good = cert('router.example')!;
  const other = cert('router.example')!;
  let requests = 0;
  const srv = createServer({ key: good.key, cert: good.cert }, (_req, res) => { requests++; res.end('ok'); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as { port: number }).port;
  const origin = `https://router.example:${port}`;
  const b = inProcess(join(tmp(), 'broker'), { resolve: async (h) => (h === 'router.example' ? ['127.0.0.1'] : []) });
  const p = new Person(b.call);
  await p.setup();
  try {
    // Not LAN, not pinned: it resolves to loopback, so it is refused before any TLS.
    await boundCredential(p, origin, { name: 'network/plain/token', value: C('tls'), class: 'standard' });
    assert.equal((await b.call('use', { ref: 'secret://network/plain/token', target: { kind: 'http', origin }, request: { method: 'GET', path: '/api' } })).record.outcome, 'failed:address');
    const scope = { methods: ['GET'], paths: ['/api'] };
    const mk = async (name: string, pin: string) => p.approve('create', { meta: { name, kind: 'token', class: 'standard' }, source: 'sealed', bind: [{ target: { kind: 'http', origin }, scope, inject: { how: 'bearer' }, consent: { scope }, lan: true, pin }] }, { seal: C('lan'), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) });
    await mk('network/wrong/token', other.pin);
    const w = await b.call('use', { ref: 'secret://network/wrong/token', target: { kind: 'http', origin }, request: { method: 'GET', path: '/api' } });
    assert.equal(w.record.outcome, 'failed:tls');
    assert.equal(requests, 0, 'nothing was sent over a certificate that isn’t the pinned one');
    await mk('network/router/token', good.pin);
    const ok = await b.call('use', { ref: 'secret://network/router/token', target: { kind: 'http', origin }, request: { method: 'GET', path: '/api' } });
    assert.equal(ok.outcome.status, 200);
    assert.equal(requests, 1);
  } finally { srv.close(); srv.closeAllConnections(); }
});
