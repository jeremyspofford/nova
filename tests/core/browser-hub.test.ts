// A browser task never reaches Nova itself (M5 review, blocker 1). The task's browser runs on the
// hub, so its requests come from this machine, and loopback from this machine is the console. Two
// walls, each tested on its own: the plan can't name Nova's own listeners and the browser refuses
// them whatever the plan says (here, and with Chromium in tests/ui/m5-browser-hub.test.ts); and
// every request the browser lets through carries a header that makes the console treat it as
// nobody in particular. What needs Chromium is in tests/ui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { BROWSER_TASK_HEADER } from '../../src/core/index.ts';
import { loopbackName, reachesHub, thisMachine, validatePlan, type Hub } from '../../src/core/browser/plan.ts';
import { CoreError } from '../../src/core/errors.ts';
import { Joiner, call } from './mesh-support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const nowS = () => Math.floor(Date.now() / 1000);
const HUB: Hub = { ports: [4318, 4320], hosts: ['192.0.2.10', 'nova-hub'] };
const details = (f: () => unknown) => {
  try { f(); } catch (e) { if (e instanceof CoreError) return e.details.join('\n'); throw e; }
  return '';
};

test('plan: this machine without a port, or at one of Nova’s own ports, can’t be declared or opened', () => {
  for (const h of ['127.0.0.1', 'localhost', '[::1]', '*.localhost', '0.0.0.0', '192.0.2.10', 'nova-hub', '127.8.9.10']) {
    assert.match(details(() => validatePlan({ allowed_hosts: [h], steps: [{ do: 'wait', selector: 'body' }] }, HUB)), /is this machine .*: name the port/, h);
  }
  for (const h of ['127.0.0.1:4318', 'localhost:4320', '[::1]:4318', '192.0.2.10:4320', 'nova-hub:4318', '[::ffff:127.0.0.1]:4318']) {
    assert.match(details(() => validatePlan({ allowed_hosts: [h], steps: [{ do: 'wait', selector: 'body' }] }, HUB)), /Nova’s own address: a browser task never reaches Nova itself/, h);
  }
  // The steps and the page to check, whatever the hosts say.
  const d = details(() => validatePlan({
    allowed_hosts: ['*.example.test'],
    steps: [{ do: 'navigate', url: 'http://2130706433:4318/api/v1/mesh/requests' }],
    verify: { url: 'http://localhost:4320/', expect: ['x'] },
  }, HUB));
  assert.match(d, /steps\[0\]\.url is Nova’s own address/);
  assert.match(d, /verify\.url is Nova’s own address/);
  // Another port on this machine is a local site like any other.
  assert.equal(validatePlan({ allowed_hosts: ['127.0.0.1:4321'], steps: [{ do: 'navigate', url: 'http://127.0.0.1:4321/' }] }, HUB).allowed_hosts[0], '127.0.0.1:4321');
  assert.equal(validatePlan({ allowed_hosts: ['example.test'], steps: [{ do: 'navigate', url: 'http://example.test:4318/' }] }, HUB).steps.length, 1, 'another machine at the same port is fine');
  // With no hub known (a core without listeners), loopback names still need their port.
  assert.match(details(() => validatePlan({ allowed_hosts: ['127.0.0.1'], steps: [{ do: 'wait', selector: 'body' }] })), /name the port/);
});

test('plan: what counts as this machine', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0', '[::ffff:7f00:1]', '::ffff:127.0.0.1']) assert.equal(loopbackName(h), true, h);
  for (const h of ['localhost.example.test', '10.0.0.1', '[::2]', 'example.test']) assert.equal(loopbackName(h), false, h);
  assert.equal(thisMachine('NOVA-HUB', HUB), true);
  assert.equal(reachesHub('http://[::ffff:c000:20a]:4320/', HUB), true, 'an IPv4-mapped spelling of a machine address');
  assert.equal(reachesHub('http://192.0.2.11:4320/', HUB), false);
  assert.equal(reachesHub('http://127.0.0.1:4321/', HUB), false);
});

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-hub-guard-'));
  const config = loadConfig({
    NOVA_HOME: home, NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_CHROMIUM: '/nonexistent/chromium',
    NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: 'http://hub.example:4320',
  });
  const nova = createNova(config);
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => nova.mesh!.listen(0, '127.0.0.1', r));
  const consolePort = (nova.server.address() as AddressInfo).port;
  const meshPort = (nova.mesh!.address() as AddressInfo).port;
  const consoleBase = `http://127.0.0.1:${consolePort}`;
  const mesh = `http://127.0.0.1:${meshPort}`;
  const c = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(consoleBase, method, path, body, headers);
  const stop = async () => {
    nova.server.closeAllConnections();
    nova.mesh!.closeAllConnections();
    nova.server.close();
    nova.mesh!.close();
    await nova.core.close();
  };
  return { nova, consoleBase, consolePort, mesh, meshPort, c, stop };
}

test('server: a request from a browser task is nobody in particular, on either listener, even from this machine', async () => {
  const b = await boot();
  try {
    const tag = { [BROWSER_TASK_HEADER]: 'some-task' };
    assert.equal((await b.c('GET', '/api/v1/tasks')).status, 200, 'the console, without the header');
    assert.equal((await b.c('GET', '/api/v1/tasks', undefined, tag)).status, 401);
    assert.equal((await b.c('GET', '/api/v1/mesh/requests', undefined, tag)).status, 401);
    assert.equal((await b.c('GET', '/api/sessions', undefined, tag)).status, 401, 'Era 2’s routes too');
    assert.equal((await b.c('POST', '/api/v1/memory', { kind: 'fact', content: 'x' }, tag)).status, 401);
    const nav = await b.c('GET', '/', undefined, { ...tag, accept: 'text/html' });
    assert.deepEqual([nav.status, nav.headers.get('location')], [303, '/pair'], 'the console UI is not served to it');
    assert.equal((await b.c('GET', '/js/app.js', undefined, tag)).status, 401);
    // Any value, any case: its presence is what counts.
    assert.equal((await b.c('GET', '/api/v1/tasks', undefined, { 'X-Nova-Browser-Task': '' })).status, 401);
    // A WebSocket handshake goes around request interception; the console never takes one.
    const handshake = await new Promise<number>((ok, fail) => {
      const req = httpRequest(`${b.consoleBase}/api/v1/tasks`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }, (r) => { r.resume(); ok(r.statusCode!); });
      req.on('upgrade', () => ok(101));
      req.on('error', fail);
      req.end();
    });
    assert.equal(handshake, 401);

    // A device session doesn't count either: a page in the task's browser can't act as a device.
    const code = (await b.c('POST', '/api/v1/mesh/pairings')).body.code;
    const dev = new Joiner(b.mesh, nowS, { name: 'Example laptop', kind: 'browser' });
    assert.equal((await dev.join(code)).status, 201);
    assert.equal((await dev.reveal()).status, 200);
    assert.equal((await b.c('POST', `/api/v1/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
    await dev.poll();
    const bearer = { authorization: `Bearer ${(await dev.session()).body.token}` };
    assert.equal((await call(b.mesh, 'GET', '/api/v1/tasks', undefined, bearer)).status, 200);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/tasks', undefined, { ...bearer, ...tag })).status, 401);
  } finally {
    await b.stop();
  }
});

test('server: a task can’t name Nova’s own listeners, whoever delegates it (the reviewer’s probe)', async () => {
  const b = await boot();
  try {
    const task = (inputs: unknown) => ({ title: 'Probe', owner: 'browser', goal: 'Read it.', evidence_required: [{ kind: 'screenshot' }], inputs });
    for (const [hosts, url] of [
      [['127.0.0.1'], `${b.consoleBase}/api/v1/mesh/requests`],
      [['localhost'], `http://localhost:${b.consolePort}/`],
      [[`127.0.0.1:${b.consolePort}`], `${b.consoleBase}/`],
      [[`localhost:${b.meshPort}`], `http://localhost:${b.meshPort}/`],
    ] as [string[], string][]) {
      const r = await b.c('POST', '/api/v1/tasks', task({ allowed_hosts: hosts, steps: [{ do: 'navigate', url }, { do: 'read', selector: 'body' }] }));
      assert.equal(r.status, 400, `${hosts} ${url}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.details.join(' '), /name the port|Nova’s own address/);
    }
  } finally {
    await b.stop();
  }
});
