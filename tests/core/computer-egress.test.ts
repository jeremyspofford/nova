// A workspace's egress (M10a gate: egress outside the declaration is refused). The workspace has no
// network; a relay inside carries connections to Nova's proxy, which applies the safe-fetch rules.
// Tested on the decision alone, then end to end from inside a real workspace with real clients
// (Node and curl), against stand-in hosts on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerComputer } from '../../src/core/computer/docker.ts';
import { IMAGE } from '../../src/core/computer/policy.ts';
import { RELAY_ARGV, RELAY_USER, Tunnel, decide, proxyConnection, type Attempt } from '../../src/core/computer/egress.ts';
import type { Machine } from '../../src/core/computer/computer.ts';
import { dockerSkip } from './computer-support.ts';

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
  await no('registry.example.test:99999', /not a port|not declared/);
});

function listen(reply: string): Promise<Server> {
  return new Promise((ok) => {
    const s = createServer((c) => { c.end(reply); });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}
const portOf = (s: Server) => (s.address() as { port: number }).port;

// Inside the workspace: a raw CONNECT through the relay, and a direct connection with no proxy.
const CLIENT = `
const net = require('net');
const [mode, host, port] = process.argv.slice(1);
const s = net.connect(mode === 'direct' ? { host, port: Number(port) } : { host: '127.0.0.1', port: 3128 });
let out = '';
s.setTimeout(8000, () => { process.stdout.write('TIMEOUT ' + out); process.exit(0); });
s.on('connect', () => s.write(mode === 'connect' ? 'CONNECT ' + host + ':' + port + ' HTTP/1.1\\r\\nHost: ' + host + ':' + port + '\\r\\n\\r\\n' : mode === 'plain' ? 'GET http://' + host + ':' + port + '/ HTTP/1.1\\r\\nHost: ' + host + '\\r\\n\\r\\n' : ''));
s.on('data', (d) => { out += d; });
s.on('end', () => { process.stdout.write(out); process.exit(0); });
s.on('error', (e) => { process.stdout.write('ERROR ' + e.code); process.exit(0); });
`;

test('from inside a workspace: a declared host is reached through Nova; anything else is refused, and nothing gets out around it', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const declared = await listen('hello from the declared host\n');
  const other = await listen('hello from an undeclared port\n');
  const home = mkdtempSync(join(tmpdir(), 'nova-egress-home-'));
  const folder = mkdtempSync(join(tmpdir(), 'nova-egress-project-'));
  const c = new DockerComputer({ home });
  const hosts = [`127.0.0.1:${portOf(declared)}`, `localhost:${portOf(declared)}`];
  const m: Machine = { id: `e${Date.now().toString(36)}`, folder, egress: { mode: 'hosts', hosts }, container: null, image: IMAGE };
  const record: Attempt[] = [];
  // The stand-ins are on this machine's loopback, which the real rule never reaches: for this test
  // only, loopback counts as public. The real rule is checked below.
  let allow: ((a: string) => boolean) | undefined = (a) => a === '127.0.0.1';
  let tunnel: Tunnel | null = null;
  try {
    await c.create(m);
    const open = async () => {
      tunnel?.close();
      tunnel = new Tunnel(c.attach(m, RELAY_ARGV, RELAY_USER), (d) => proxyConnection(d, { hosts: () => hosts, record: (a) => record.push(a), ...(allow ? { allow } : {}) }));
      await tunnel.ready;
    };
    await open();
    const inside = async (...args: string[]) => (await c.exec(m, { argv: ['node', '-e', CLIENT, ...args], timeoutS: 30 })).stdout;

    const ok = await inside('connect', '127.0.0.1', String(portOf(declared)));
    assert.match(ok, /^HTTP\/1\.1 200 Connection Established\r\n\r\nhello from the declared host\n$/);
    // A real client, with the proxy settings every workspace command that may reach out gets.
    const curl = await c.exec(m, { argv: ['curl', '-sS', '--http0.9', '--proxytunnel', `http://127.0.0.1:${portOf(declared)}/`], timeoutS: 30 });
    assert.equal(curl.stdout, 'hello from the declared host\n', curl.stderr);

    assert.match(await inside('connect', '127.0.0.1', String(portOf(other))), /^HTTP\/1\.1 403 Forbidden[\s\S]*not declared/);
    assert.match(await inside('connect', 'undeclared.example.test', '443'), /^HTTP\/1\.1 403 Forbidden[\s\S]*not declared/);
    assert.match(await inside('plain', '127.0.0.1', String(portOf(declared))), /^HTTP\/1\.1 405[\s\S]*HTTPS \(CONNECT\) only/);
    const curlRefused = await c.exec(m, { argv: ['curl', '-sS', '--proxytunnel', `http://127.0.0.1:${portOf(other)}/`], timeoutS: 30 });
    assert.notEqual(curlRefused.exit, 0);
    assert.match(curlRefused.stderr, /403/);
    // Around the proxy there is no way out: no route, no names.
    assert.match(await inside('direct', '127.0.0.1', String(portOf(declared))), /^ERROR ECONNREFUSED/);
    assert.match(await inside('direct', 'host.docker.internal', String(portOf(declared))), /^ERROR (EAI_AGAIN|ENOTFOUND)/);
    assert.match(await inside('direct', '93.184.215.14', '443'), /^ERROR ENETUNREACH/);

    // The real rule: a declared host on this machine is still refused, by address and by name.
    allow = undefined;
    await open();
    assert.match(await inside('connect', '127.0.0.1', String(portOf(declared))), /^HTTP\/1\.1 403 Forbidden[\s\S]*private address/);
    assert.match(await inside('connect', 'localhost', String(portOf(declared))), /^HTTP\/1\.1 403 Forbidden[\s\S]*private network/);

    // Every attempt is on the record, allowed or not.
    assert.deepEqual(record.map((a) => [a.host, a.port === portOf(declared) ? 'declared' : a.port === portOf(other) ? 'other' : a.port, a.allowed]), [
      ['127.0.0.1', 'declared', true], ['127.0.0.1', 'declared', true], ['127.0.0.1', 'other', false], ['undeclared.example.test', 443, false],
      ['127.0.0.1', 'declared', false], ['127.0.0.1', 'other', false], ['127.0.0.1', 'declared', false], ['localhost', 'declared', false],
    ]);
  } finally {
    (tunnel as Tunnel | null)?.close();
    await c.destroy(m, []).catch(() => {});
    declared.close();
    other.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
