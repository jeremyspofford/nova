// A workspace's egress (M10a gate: egress outside the declaration is refused). The workspace has no
// network; a relay inside carries connections to Nova's proxy, which applies the safe-fetch rules.
// Tested on the decision alone, then end to end from inside a real workspace with real clients
// (Node and curl), against stand-in hosts on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerComputer } from '../../src/core/computer/docker.ts';
import { IMAGE } from '../../src/core/computer/policy.ts';
import { RELAY_ARGV, RELAY_USER, Tunnel, decide, proxyConnection, type Attempt } from '../../src/core/computer/egress.ts';
import type { Machine } from '../../src/core/computer/computer.ts';
import { TEST_LABELS, dockerSkip, folderIdOf, removeTestContainers, tlsStandIn } from './computer-support.ts';

const skip = await dockerSkip();

test('the decision: declared and public, or refused with the reason', async () => {
  const lookup = (map: Record<string, string[]>) => (h: string, cb: (e: Error | null, a: { address: string }[]) => void) => (map[h] ? cb(null, map[h]!.map((address) => ({ address }))) : cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), []));
  const o = { hosts: () => ['registry.example.test:443', '*.cdn.example.test', '93.184.215.14:443', 'localhost:443', '127.0.0.1:443'], lookup: lookup({ 'registry.example.test': ['93.184.215.14'], 'a.cdn.example.test': ['93.184.215.15'], 'rebind.cdn.example.test': ['93.184.215.15', '127.0.0.1'], 'tailnet.cdn.example.test': ['100.101.102.103'] }) };
  assert.deepEqual(await decide('registry.example.test:443', o), { ok: true, host: 'registry.example.test', port: 443, address: '93.184.215.14' });
  assert.equal((await decide('a.cdn.example.test:8443', o)).ok, true, 'a declared host without a port allows any port');
  assert.equal((await decide('93.184.215.14:443', o)).ok, true);
  const no = async (a: string, why: RegExp) => { const d = await decide(a, o); assert.equal(d.ok, false, a); assert.match((d as { why: string }).why, why, a); };
  await no('registry.example.test:80', /not declared/);
  await no('other.example.test:443', /not declared/);
  await no('cdn.example.test:443', /not declared/);
  await no('rebind.cdn.example.test:443', /private address/);
  await no('tailnet.cdn.example.test:443', /private address/);
  await no('missing.cdn.example.test:443', /didn’t resolve/);
  // Declared, but private: a declaration can't open the way to this machine.
  await no('localhost:443', /private network/);
  await no('127.0.0.1:443', /private address/);
  await no('registry.example.test', /host:port/);
  await no('registry.example.test:99999', /not a host:port|not declared/);
});


// Inside the workspace: a raw CONNECT through the relay with TLS over it, plain HTTP to the proxy,
// and a direct connection with no proxy.
const CLIENT = `
const net = require('net'), tls = require('tls');
const [mode, host, port] = process.argv.slice(1);
const s = net.connect(mode === 'direct' ? { host, port: Number(port) } : { host: '127.0.0.1', port: 3128 });
let out = '';
let over = false;
const done = () => { if (over) return; over = true; process.stdout.write(out); process.exit(0); };
s.setTimeout(8000, () => { out = 'TIMEOUT ' + out; done(); });
s.on('error', (e) => { out += 'ERROR ' + e.code; done(); });
s.on('connect', () => s.write(mode === 'connect' ? 'CONNECT ' + host + ':' + port + ' HTTP/1.1\\r\\nHost: ' + host + ':' + port + '\\r\\n\\r\\n' : mode === 'plain' ? 'GET http://' + host + ':' + port + '/ HTTP/1.1\\r\\nHost: ' + host + '\\r\\n\\r\\n' : ''));
const onData = (d) => {
  out += d;
  if (mode !== 'connect' || !out.includes('\\r\\n\\r\\n') || !/^HTTP\\/1\\.1 200 /.test(out)) return;
  s.off('data', onData);
  const t = tls.connect({ socket: s, rejectUnauthorized: false });
  t.on('data', (x) => { out += x; });
  t.on('end', done);
  t.on('error', (e) => { out += 'TLS ' + (e.code || e.message); done(); });
};
s.on('data', onData);
s.on('end', () => { if (!/^HTTP\\/1\\.1 200 /.test(out)) done(); });
`;

test('from inside a workspace: a declared host is reached through Nova; anything else is refused, and nothing gets out around it', { skip: skip ?? false, timeout: 180_000 }, async (t) => {
  const declared = await tlsStandIn('hello from the declared host\n');
  const other = await tlsStandIn('hello from an undeclared port\n');
  if (!declared || !other) { t.skip('openssl isn’t here to make the stand-in hosts’ certificates'); return; }
  const home = mkdtempSync(join(tmpdir(), 'nova-egress-home-'));
  const folder = mkdtempSync(join(tmpdir(), 'nova-egress-project-'));
  const c = new DockerComputer({ home, labels: TEST_LABELS });
  const hosts = [`127.0.0.1:${declared.port}`, `localhost:${declared.port}`];
  const m: Machine = { id: `e${Date.now().toString(36)}`, folder, folderId: folderIdOf(folder), egress: { mode: 'hosts', hosts }, container: null, image: IMAGE };
  const record: Attempt[] = [];
  // The stand-ins are on this machine's loopback, which the real rule never reaches: for this test
  // only, loopback counts as public. The real rule is checked below.
  let allow: ((a: string) => boolean) | undefined = (a) => a === '127.0.0.1';
  let tunnel: Tunnel | null = null;
  try {
    await c.create(m);
    const open = async () => {
      await tunnel?.close();
      tunnel = new Tunnel(c.attach(m, RELAY_ARGV, RELAY_USER), (d) => proxyConnection(d, { hosts: () => hosts, record: (a) => record.push(a), ...(allow ? { allow } : {}) }));
      await tunnel.ready;
    };
    await open();
    const inside = async (...args: string[]) => (await c.exec(m, { argv: ['node', '-e', CLIENT, ...args], timeoutS: 30 })).stdout;

    const ok = await inside('connect', '127.0.0.1', String(declared.port));
    assert.match(ok, /^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nhello from the declared host\n$/);
    // A real client, with the proxy settings every workspace command that may reach out gets.
    const curl = await c.exec(m, { argv: ['curl', '-sSk', '--proxytunnel', `https://127.0.0.1:${declared.port}/`], timeoutS: 30 });
    assert.equal(curl.stdout, 'hello from the declared host\n', curl.stderr);

    assert.match(await inside('connect', '127.0.0.1', String(other.port)), /^HTTP\/1\.1 403 Forbidden[\s\S]*not declared/);
    assert.match(await inside('connect', 'undeclared.example.test', '443'), /^HTTP\/1\.1 403 Forbidden[\s\S]*not declared/);
    assert.match(await inside('plain', '127.0.0.1', String(declared.port)), /^HTTP\/1\.1 405[\s\S]*HTTPS \(CONNECT\) only/);
    const curlRefused = await c.exec(m, { argv: ['curl', '-sSk', '--proxytunnel', `https://127.0.0.1:${other.port}/`], timeoutS: 30 });
    assert.notEqual(curlRefused.exit, 0);
    assert.match(curlRefused.stderr, /403/);
    assert.equal(other.seen(), 0, 'the undeclared port was never connected to');
    // Around the proxy there is no way out: no route, no names.
    assert.match(await inside('direct', '127.0.0.1', String(declared.port)), /^ERROR ECONNREFUSED/);
    assert.match(await inside('direct', 'host.docker.internal', String(declared.port)), /^ERROR (EAI_AGAIN|ENOTFOUND)/);
    assert.match(await inside('direct', '93.184.215.14', '443'), /^ERROR ENETUNREACH/);

    // The real rule: a declared host on this machine is still refused, by address and by name.
    allow = undefined;
    await open();
    assert.match(await inside('connect', '127.0.0.1', String(declared.port)), /^HTTP\/1\.1 403 Forbidden[\s\S]*private address/);
    assert.match(await inside('connect', 'localhost', String(declared.port)), /^HTTP\/1\.1 403 Forbidden[\s\S]*private network/);

    // Every attempt is on the record, allowed or not, with its fixed reason code.
    assert.deepEqual(record.map((a) => [a.host, a.port === declared.port ? 'declared' : a.port === other.port ? 'other' : a.port, a.allowed, a.code]), [
      ['127.0.0.1', 'declared', true, 'allowed'], ['127.0.0.1', 'declared', true, 'allowed'], ['127.0.0.1', 'other', false, 'not-declared'], ['undeclared.example.test', 443, false, 'not-declared'],
      ['127.0.0.1', 'declared', false, 'plain-http'], ['127.0.0.1', 'other', false, 'not-declared'], ['127.0.0.1', 'declared', false, 'private-address'], ['localhost', 'declared', false, 'private-name'],
    ]);
  } finally {
    await (tunnel as Tunnel | null)?.close();
    await c.destroy(m, []).catch(() => {});
    await removeTestContainers();
    declared.close();
    other.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
