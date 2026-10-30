// The access policy (M4 plan §0) on the real server, both listeners: who is the console, what a
// proxied request gets (nothing), what each kind of paired device gets by cookie or bearer, the
// X-Nova and Origin guard, sessions ending, and revocation cutting a device's open streams (the
// core's and Era 2's) at once. Also the transport rules at startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { ConfigError, loadConfig, meshConfig } from '../../src/config.js';
import { Joiner, call } from './mesh-support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const nowS = () => Math.floor(Date.now() / 1000);

async function boot(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-access-'));
  const config = loadConfig({
    NOVA_HOME: home, NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC',
    NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: 'http://hub.example:4320', ...extra,
  });
  const nova = createNova(config);
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => nova.mesh!.listen(0, '127.0.0.1', r));
  const consoleBase = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  const mesh = `http://127.0.0.1:${(nova.mesh!.address() as AddressInfo).port}`;
  const c = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(consoleBase, method, path, body, headers);
  // Enroll a device of some kind through the front door, approved at the console.
  const enroll = async (claims: Record<string, unknown>) => {
    const code = (await c('POST', '/api/v1/mesh/pairings')).body.code;
    const dev = new Joiner(mesh, nowS, claims);
    assert.equal((await dev.join(code)).status, 201);
    assert.equal((await dev.reveal()).status, 200);
    assert.equal((await c('POST', `/api/v1/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
    await dev.poll();
    return dev;
  };
  const stop = async () => {
    nova.server.closeAllConnections();
    nova.mesh!.closeAllConnections();
    nova.server.close();
    nova.mesh!.close();
    await nova.core.close();
  };
  return { nova, home, console: consoleBase, mesh, c, enroll, stop };
}

const cookieOf = (r: { headers: Headers }) => /nova_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0] ?? '';

test('the console is loopback, addressed to loopback, with no proxy in between; anything else must pair', async () => {
  const b = await boot();
  try {
    assert.equal((await b.c('GET', '/api/v1/tasks')).status, 200);
    assert.equal((await b.c('GET', '/api/sessions')).status, 200);
    assert.equal((await b.c('GET', '/')).status, 200);

    // The same requests through a proxy on this machine: no console rights.
    for (const h of [{ 'x-forwarded-for': '100.64.0.7' }, { forwarded: 'for=100.64.0.7' }, { 'tailscale-user-login': 'someone@example.com' }, { 'x-real-ip': '100.64.0.7' }, { 'x-forwarded-proto': 'https' }] as Record<string, string>[]) {
      assert.equal((await b.c('GET', '/api/v1/tasks', undefined, h)).status, 401, JSON.stringify(h));
      assert.equal((await b.c('GET', '/api/sessions', undefined, h)).status, 401, `Era 2 ${JSON.stringify(h)}`);
    }
    const proxied = { 'x-forwarded-for': '100.64.0.7' };
    const nav = await b.c('GET', '/settings', undefined, { ...proxied, accept: 'text/html' });
    assert.deepEqual([nav.status, nav.headers.get('location')], [303, '/pair'], 'a page navigation goes to /pair');
    assert.equal((await b.c('GET', '/styles/views.css', undefined, proxied)).status, 401);
    assert.equal((await b.c('GET', '/pair', undefined, { ...proxied, accept: 'text/html' })).status, 200, 'the pairing page is public');
    assert.equal((await b.c('GET', '/js/pair.js', undefined, proxied)).status, 200);
    assert.equal((await b.c('GET', '/design-system.css', undefined, proxied)).status, 200);
    assert.equal((await b.c('GET', '/api/v1/mesh/hello', undefined, proxied)).status, 200);
    assert.equal((await b.c('POST', '/api/v1/memory', { kind: 'fact', content: 'x' }, proxied)).status, 401);
    assert.equal((await b.c('GET', '/api/v1/nope', undefined, proxied)).status, 401, 'no session learns nothing, not even what exists');
    // A Host that isn't this machine is still turned away before anything else (DNS rebinding).
    const misdirected = await new Promise<number>((ok) => httpRequest(`${b.console}/api/sessions`, { headers: { host: 'evil.example' } }, (r: IncomingMessage) => { r.resume(); ok(r.statusCode!); }).end());
    assert.equal(misdirected, 421);

    // On the mesh listener, even from this machine, nothing is console.
    assert.equal((await call(b.mesh, 'GET', '/api/v1/tasks')).status, 401);
    assert.equal((await call(b.mesh, 'GET', '/', undefined, { accept: 'text/html' })).status, 303);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/mesh/hello')).status, 200);
  } finally {
    await b.stop();
  }
});

test('a browser by cookie and a phone by bearer get what the console gets, except approving; the guard still holds', async () => {
  const b = await boot();
  try {
    const browser = await b.enroll({ kind: 'browser', name: 'Laptop browser' });
    const s = await browser.session({ cookie: true });
    assert.equal(s.status, 200);
    assert.equal(s.body.token, undefined, 'a cookie session never shows the token to the page');
    const set = s.headers.get('set-cookie') ?? '';
    assert.match(set, /^nova_session=nvs_[\w-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict$/, 'not Secure over plain http');
    const jar = { cookie: cookieOf(s) };
    assert.equal((await call(b.mesh, 'GET', '/', undefined, jar)).status, 200);
    assert.equal((await call(b.mesh, 'GET', '/styles/views.css', undefined, jar)).status, 200);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/tasks', undefined, jar)).status, 200);
    assert.equal((await call(b.mesh, 'GET', '/api/sessions', undefined, jar)).status, 200);
    assert.equal((await call(b.mesh, 'POST', '/api/v1/memory', { kind: 'fact', content: 'The spare key is in the blue box.' }, jar)).status, 201);
    // The guard: no X-Nova, or a foreign Origin, is refused even with a session.
    assert.equal((await call(b.mesh, 'POST', '/api/v1/memory', { kind: 'fact', content: 'x' }, { ...jar, 'x-nova': '' })).status, 403);
    assert.equal((await call(b.mesh, 'POST', '/api/v1/memory', { kind: 'fact', content: 'x' }, { ...jar, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(b.mesh, 'POST', '/api/v1/memory', { kind: 'fact', content: 'x' }, { ...jar, origin: 'http://hub.example:4320' })).status, 201, 'its own origin is fine');
    assert.equal((await call(b.mesh, 'POST', '/api/sessions', { text: 'x' }, { ...jar, origin: 'https://evil.example' })).status, 403, 'Era 2 too');
    // Approving is for the console, or a device allowed to.
    const refused = await call(b.mesh, 'POST', '/api/v1/mesh/pairings', {}, jar);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /allowed to approve/);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/mesh/requests', undefined, jar)).status, 403);
    assert.equal((await call(b.mesh, 'PATCH', `/api/v1/mesh/devices/${browser.deviceId}`, { can_approve: true, confirm: true }, jar)).status, 403, 'it can’t promote itself');
    assert.equal((await call(b.mesh, 'PATCH', `/api/v1/mesh/devices/${browser.deviceId}`, { name: 'Work laptop' }, jar)).body.name, 'Work laptop', 'renaming is fine');

    const phone = await b.enroll({ kind: 'phone', name: 'Phone' });
    const ps = await phone.session();
    const bearer = { authorization: `Bearer ${ps.body.token}` };
    assert.equal((await call(b.mesh, 'GET', '/api/v1/memory', undefined, bearer)).status, 200);
    assert.equal((await call(b.mesh, 'GET', '/', undefined, bearer)).status, 200);
    // The person lets the phone approve (tier 3), from the console.
    assert.equal((await b.c('PATCH', `/api/v1/mesh/devices/${phone.deviceId}`, { can_approve: true })).status, 400, 'tier 3 needs confirm');
    assert.equal((await b.c('PATCH', `/api/v1/mesh/devices/${phone.deviceId}`, { can_approve: true, confirm: true })).body.can_approve, true);
    assert.equal((await call(b.mesh, 'POST', '/api/v1/mesh/pairings', {}, bearer)).status, 201);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/mesh/requests', undefined, bearer)).status, 200);
    // A session that ran out is a 401, and the device signs again.
    b.nova.core.db.run('UPDATE device_session SET expires_at = ? WHERE device_id = ?', '2000-01-01T00:00:00.000Z', phone.deviceId);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/memory', undefined, bearer)).status, 401);
    const renewed = await phone.session();
    assert.equal((await call(b.mesh, 'GET', '/api/v1/memory', undefined, { authorization: `Bearer ${renewed.body.token}` })).status, 200);
    // The same signed request can't start two sessions.
    const t = phone.time();
    assert.equal((await phone.session({ time: t })).status, 200);
    assert.equal((await phone.session({ time: t })).status, 401);
    // A made-up token is nobody.
    assert.equal((await call(b.mesh, 'GET', '/api/v1/memory', undefined, { authorization: `Bearer nvs_${'A'.repeat(43)}` })).status, 401);
  } finally {
    await b.stop();
  }
});

test('a malformed or "null" Origin is a 403, never a 500 or a problem, even on the public routes', async () => {
  const b = await boot();
  try {
    const before = b.nova.core.log.problems().length;
    for (const origin of ['null', 'not a url', '://', 'http://']) {
      const join = await call(b.mesh, 'POST', '/api/v1/mesh/join', { code: 'ABCD-EFGH' }, { origin });
      assert.equal(join.status, 403, `core, public: ${origin}`);
      assert.equal((await b.c('POST', '/api/v1/memory', { kind: 'fact', content: 'x' }, { origin })).status, 403, `core, console: ${origin}`);
      assert.equal((await b.c('POST', '/api/sessions', { text: 'x' }, { origin })).status, 403, `Era 2: ${origin}`);
    }
    assert.equal(b.nova.core.log.problems().length, before, 'nothing recorded: a refusal isn’t a problem');
  } finally {
    await b.stop();
  }
});

test('a webhook answers over the mesh listener without a session: its own token is its key', async () => {
  const b = await boot();
  try {
    const created = await b.c('POST', '/api/v1/triggers/rules', { name: 'Example events', class: 'event', hook: 'example', action: { kind: 'message', text: 'An example event arrived.' } });
    assert.equal(created.status, 201);
    const fired = await call(b.mesh, 'POST', '/api/v1/hooks/example', { n: 1 }, { 'x-nova': '', 'x-nova-hook-token': created.body.token });
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    assert.equal((await call(b.mesh, 'POST', '/api/v1/hooks/example', { n: 2 }, { 'x-nova': '', 'x-nova-hook-token': 'wrong' })).status, 403, 'a wrong token is still refused');
    assert.equal((await call(b.mesh, 'POST', '/api/v1/hooks/example', { n: 3 }, { 'x-nova': '' })).status, 403, 'and no token');
    assert.equal((await call(b.mesh, 'GET', '/api/v1/triggers/rules')).status, 401, 'the rest of automations stays the person’s');
  } finally {
    await b.stop();
  }
});

test('a computer gets only the device routes, a standby only sync; neither gets the person’s things', async () => {
  const b = await boot();
  try {
    for (const kind of ['computer', 'standby']) {
      const d = await b.enroll({ kind, name: `A ${kind}` });
      const auth = { authorization: `Bearer ${(await d.session()).body.token}` };
      assert.equal((await call(b.mesh, 'GET', '/api/v1/mesh/roster', undefined, auth)).status, 200, `${kind}: roster`);
      assert.equal((await call(b.mesh, 'GET', '/api/v1/mesh/status', undefined, auth)).body.you.kind, kind);
      for (const p of ['/api/v1/tasks', '/api/v1/memory', '/api/v1/events', '/api/sessions', '/api/memory', '/', '/styles/views.css']) {
        assert.equal((await call(b.mesh, 'GET', p, undefined, auth)).status, 403, `${kind}: ${p}`);
      }
      assert.equal((await call(b.mesh, 'POST', `/api/v1/mesh/devices/${d.deviceId}/revoke`, { confirm: true }, auth)).status, 403, `${kind} can’t revoke`);
    }
  } finally {
    await b.stop();
  }
});

// An event stream, kept open until the server ends it.
function stream(url: string, headers: Record<string, string>): Promise<{ status: number; text: () => string; ended: Promise<number> }> {
  return new Promise((ok, fail) => {
    const started = Date.now();
    httpRequest(url, { headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      const ended = new Promise<number>((done) => { res.on('close', () => done(Date.now() - started)); res.on('error', () => done(Date.now() - started)); });
      ok({ status: res.statusCode!, text: () => text, ended });
    }).on('error', fail).end();
  });
}

test('revoking a device closes its open streams at once, core and Era 2, and its next request is a 401', async () => {
  const b = await boot();
  try {
    const phone = await b.enroll({ kind: 'phone', name: 'Phone' });
    const watcher = await b.enroll({ kind: 'browser', name: 'Other browser' });
    const jar = { cookie: cookieOf(await phone.session({ cookie: true })) };
    const other = { cookie: cookieOf(await watcher.session({ cookie: true })) };
    const conv = (await b.c('POST', '/api/sessions', { text: 'What should I focus on today?' })).body.id;
    const core = await stream(`${b.mesh}/api/v1/events`, jar);
    const era2 = await stream(`${b.mesh}/api/events`, jar);
    const thread = await stream(`${b.mesh}/api/sessions/${conv}/events`, jar);
    const bystander = await stream(`${b.mesh}/api/v1/events`, other);
    for (const s of [core, era2, thread, bystander]) assert.equal(s.status, 200);
    assert.equal((await b.c('GET', '/api/v1/mesh/devices')).body.find((d: { id: string }) => d.id === phone.deviceId).online, true, 'online while it has a stream open');

    const t0 = Date.now();
    const r = await b.c('POST', `/api/v1/mesh/devices/${phone.deviceId}/revoke`, { confirm: true, reason: 'Left on a train.' });
    assert.equal(r.status, 200);
    const closed = await Promise.race([Promise.all([core.ended, era2.ended, thread.ended]).then(() => Date.now() - t0), new Promise<number>((done) => setTimeout(() => done(-1), 2000))]);
    assert.ok(closed >= 0 && closed < 1000, `streams closed at once (${closed} ms)`);
    assert.equal((await call(b.mesh, 'GET', '/api/v1/tasks', undefined, jar)).status, 401);
    assert.equal((await call(b.mesh, 'GET', '/', undefined, { ...jar, accept: 'text/html' })).status, 303);
    assert.equal((await phone.session()).status, 401, 'its key can’t start a session');
    // Someone else's stream is untouched, and heard the news.
    const still = await Promise.race([bystander.ended.then(() => 'ended'), new Promise((done) => setTimeout(() => done('open'), 300))]);
    assert.equal(still, 'open');
    assert.match(bystander.text(), /event: device\ndata: .*"action":"revoked"/);
    assert.doesNotMatch(bystander.text(), /event: join_request/, 'a browser that can’t approve doesn’t get the prompt');

    // A device may revoke itself.
    const self = await call(b.mesh, 'POST', `/api/v1/mesh/devices/${watcher.deviceId}/revoke`, { confirm: true }, other);
    assert.equal(self.status, 200);
    assert.equal(self.body.trust, 'revoked');
    await bystander.ended;
    // The hub can't be revoked.
    const hubId = (await b.c('GET', '/api/v1/mesh/hello')).body.id;
    assert.equal((await b.c('POST', `/api/v1/mesh/devices/${hubId}/revoke`, { confirm: true })).status, 409);
  } finally {
    await b.stop();
  }
});

test('the approval prompt streams to the console and to devices allowed to approve', async () => {
  const b = await boot();
  try {
    const phone = await b.enroll({ kind: 'phone', name: 'Phone' });
    await b.c('PATCH', `/api/v1/mesh/devices/${phone.deviceId}`, { can_approve: true, confirm: true });
    const auth = { authorization: `Bearer ${(await phone.session()).body.token}` };
    const consoleStream = await stream(`${b.console}/api/v1/events`, {});
    const phoneStream = await stream(`${b.mesh}/api/v1/events`, auth);
    const code = (await b.c('POST', '/api/v1/mesh/pairings')).body.code;
    const d = new Joiner(b.mesh, nowS, { name: 'Desk computer', kind: 'computer' });
    await d.join(code);
    const { confirmation } = (await d.reveal()).body;
    await new Promise((r) => setTimeout(r, 100));
    for (const s of [consoleStream, phoneStream]) assert.match(s.text(), new RegExp(`event: join_request\\ndata: .*"confirmation":"${confirmation}"`));
    assert.equal((await call(b.mesh, 'POST', `/api/v1/mesh/requests/${d.requestId}/approve`, { confirm: true }, auth)).status, 200, 'the phone approves');
  } finally {
    await b.stop();
  }
});

test('transport: plain HTTP is refused at startup unless a proxy or encrypted network is stated; HTTPS works and sets a Secure cookie', async () => {
  assert.equal(meshConfig({}), null);
  assert.throws(() => meshConfig({ NOVA_MESH_URL: 'http://0.0.0.0:4320' }), (e: Error) => e instanceof ConfigError && /plain HTTP/.test(e.message));
  assert.throws(() => meshConfig({ NOVA_MESH_URL: 'http://0.0.0.0:4320', NOVA_MESH_TRANSPORT: 'yes' }), /plain HTTP/);
  assert.throws(() => meshConfig({ NOVA_MESH_URL: 'http://0.0.0.0:4320', NOVA_MESH_TRANSPORT: 'network' }), /NOVA_MESH_PUBLIC_URL/);
  assert.throws(() => meshConfig({ NOVA_MESH_URL: 'https://0.0.0.0:4320', NOVA_MESH_PUBLIC_URL: 'https://hub.example:4320' }), /NOVA_TLS_CERT/);
  assert.throws(() => meshConfig({ NOVA_MESH_URL: 'http://127.0.0.1:4320', NOVA_MESH_TRANSPORT: 'proxy' }), /https:\/\//, 'a TLS proxy means devices use https');
  assert.throws(() => meshConfig({ NOVA_MESH_URL: 'http://127.0.0.1' , NOVA_MESH_TRANSPORT: 'network' }), /<port>/);
  assert.deepEqual(meshConfig({ NOVA_MESH_URL: 'http://127.0.0.1:4320', NOVA_MESH_TRANSPORT: 'proxy', NOVA_MESH_PUBLIC_URL: 'https://hub.example/' }), {
    bindHost: '127.0.0.1', port: 4320, transport: 'proxy', tls: null, publicUrl: 'https://hub.example',
  });

  // The real process says why and stops.
  const home = mkdtempSync(join(tmpdir(), 'nova-refuse-'));
  const run = spawnSync(process.execPath, ['src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: home, NOVA_HOME: join(home, 'n'), NOVA_PORT: '0', NOVA_MESH_URL: 'http://127.0.0.1:0' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Nova didn't start: Nova won't serve other devices over plain HTTP/);

  // HTTPS with a certificate made here.
  const dir = mkdtempSync(join(tmpdir(), 'nova-tls-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' });
  if (made.status !== 0) return;
  const b = await boot({ NOVA_MESH_URL: 'https://127.0.0.1:0', NOVA_MESH_TRANSPORT: '', NOVA_MESH_PUBLIC_URL: 'https://localhost:4320', NOVA_TLS_CERT: join(dir, 'cert.pem'), NOVA_TLS_KEY: join(dir, 'key.pem') });
  try {
    const port = (b.nova.mesh!.address() as AddressInfo).port;
    const ca = readFileSync(join(dir, 'cert.pem'));
    const tls = (method: string, path: string, body?: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, fail) => {
      const req = httpsRequest({ host: '127.0.0.1', servername: 'localhost', port, path, method, ca, headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'x-nova': '1' } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: text }));
      });
      req.on('error', fail);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const hello = await tls('GET', '/api/v1/mesh/hello');
    assert.equal(hello.status, 200);
    assert.equal((await tls('GET', '/api/v1/tasks')).status, 401);
    // Enroll over TLS and see the cookie is Secure.
    const code = (await b.c('POST', '/api/v1/mesh/pairings')).body.code;
    const dev = new Joiner('', nowS, { kind: 'browser' });
    const j = await tls('POST', '/api/v1/mesh/join', dev.joinBody(code));
    assert.equal(j.status, 201, j.body);
    Object.assign(dev, { requestId: JSON.parse(j.body).request_id, code });
    assert.equal((await tls('POST', `/api/v1/mesh/join/${dev.requestId}/reveal`, dev.revealBody())).status, 200);
    const a = await b.c('POST', `/api/v1/mesh/requests/${dev.requestId}/approve`, { confirm: true });
    dev.deviceId = a.body.device.id;
    const { sessionMessage, signMessage } = await import('../../src/core/index.ts');
    const t = dev.time();
    const s = await tls('POST', '/api/v1/mesh/session', { device_id: dev.deviceId, time: t, signature: signMessage(dev.keys.ed25519.privateKey, sessionMessage(dev.deviceId, t)), cookie: true });
    assert.equal(s.status, 200);
    assert.match(String(s.headers['set-cookie']), /HttpOnly; SameSite=Strict; Secure/);
  } finally {
    await b.stop();
  }
});

// The process lives long enough to say it's ready, with a mesh listener on loopback (this host
// never binds beyond loopback outside a container).
test('the server process announces its mesh address', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-meshproc-'));
  const proc = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: home, NOVA_HOME: join(home, 'n'), NOVA_PORT: '0', NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network' } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 200 && !/Devices pair and connect at/.test(out); i++) await new Promise((r) => setTimeout(r, 25));
  proc.kill('SIGTERM');
  await new Promise((r) => proc.on('exit', r));
  assert.match(out, /Devices pair and connect at http:\/\/127\.0\.0\.1:0 \(listening on 127\.0\.0\.1:\d+, over an encrypted network, as you said\)/);
});
