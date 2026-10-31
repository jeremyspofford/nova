// A browser task never reaches Nova itself (M5 review, blocker 1), in Chromium. The task's
// browser runs on the hub, so a request from it comes from this machine; without these walls a
// paired phone that may not approve could delegate a browser task that reads approver-only routes
// as the console, or loads the console's UI and drives it. Each wall is tested on its own:
//  - the browser refuses Nova's own listeners even when the declared hosts take them in (here a
//    stand-in listener plays Nova, so the header can't be what stops it);
//  - every request the browser lets through carries the task's mark, which a page can't remove or
//    forge, and Nova treats a marked request as nobody in particular (here the browser is told
//    nothing about Nova's ports, so only the mark stands in the way).
// Runs where Chromium can start (scripts/ui-test.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { sleep, stop } from '../acceptance/support.ts';
import { call, enroll } from '../core/mesh-support.ts';
import { blank, browser, chromiumPath, finishSetup } from './support.ts';
import { browserEnv, browserTask, events, settled, waitTask } from './m5c-support.ts';
import { Session } from '../../src/core/browser/session.ts';
import { HUB_REFUSAL, NO_HUB, type Hub } from '../../src/core/browser/plan.ts';
import { BROWSER_TASK_HEADER } from '../../src/core/index.ts';

const MARK = BROWSER_TASK_HEADER;

// A listener that writes down every request it gets, with the mark and the cookie it carried.
async function recorder(page: (port: number) => string = () => '<h1>Recorder</h1>') {
  const hits: { path: string; mark: string | undefined; cookie: string | undefined }[] = [];
  const srv = createServer((req: IncomingMessage, res) => {
    hits.push({ path: req.url!, mark: req.headers[MARK] as string | undefined, cookie: req.headers.cookie });
    const port = (srv.address() as AddressInfo).port;
    if (req.url === '/hop') { res.writeHead(302, { location: '/landed' }); res.end(); return; }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'seen=yes; Path=/' }); res.end(page(port)); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${req.url}`);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as AddressInfo).port, hits, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

const session = (hosts: string[], hub: Hub) => new Session({ taskId: 'task-guard-1', chromium: chromiumPath(), hosts, sandbox: false, hub: () => hub });

test('wall 1: the browser refuses Nova’s own listeners, even inside the declared hosts', { timeout: 60_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const nova = await recorder();
  // A local site the task may use, whose page reaches for "Nova" every way it can.
  const site = await recorder((p) => `<!doctype html><h1 id="t">Site</h1><img src="http://localhost:${nova.port}/img">
<script>fetch('http://127.0.0.1:${nova.port}/api/v1/mesh/requests', { mode: 'no-cors' }).catch(() => {});
setTimeout(() => { const i = document.createElement('i'); i.id = 'fin'; document.body.append(i); }, 800);</script>`);
  const s = session([`127.0.0.1:${site.port}`, `127.0.0.1:${nova.port}`, `localhost:${nova.port}`], { ports: [nova.port], hosts: [] });
  try {
    await s.open();
    await s.navigate(`http://127.0.0.1:${site.port}/`);
    for (let i = 0; i < 40 && !(await s.evaluate<boolean>('!!document.getElementById("fin")')); i++) await sleep(100);
    await assert.rejects(s.navigate(`http://127.0.0.1:${nova.port}/`), /outside the hosts this task may reach/);
    await sleep(300);
    assert.deepEqual(nova.hits, [], 'nothing reached the listener playing Nova');
    const refused = [...s.blocked.values()].filter((x) => x.reason === HUB_REFUSAL).map((x) => x.host).sort();
    assert.deepEqual(refused, [`127.0.0.1:${nova.port}`, `localhost:${nova.port}`].sort(), JSON.stringify([...s.blocked.values()]));
    assert.ok(site.hits.length >= 1, 'the declared site itself was reached');
  } finally {
    await s.close();
    await nova.close();
    await site.close();
  }
});

test('wall 2: whatever the browser lets through carries the task’s mark; a page can neither drop nor forge it, and cookies still work', { timeout: 60_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const site = await recorder(() => `<!doctype html><h1>Site</h1><img src="/pixel">
<script>fetch('/api', { headers: { '${MARK}': 'forged' } }).then(() => fetch('/hop')).then(() => { const i = document.createElement('i'); i.id = 'fin'; document.body.append(i); });</script>`);
  const s = session([`127.0.0.1:${site.port}`], NO_HUB);
  try {
    await s.open();
    await s.navigate(`http://127.0.0.1:${site.port}/`);
    for (let i = 0; i < 40 && !(await s.evaluate<boolean>('!!document.getElementById("fin")')); i++) await sleep(100);
    const paths = site.hits.map((h) => h.path);
    for (const p of ['/', '/pixel', '/api', '/hop', '/landed']) assert.ok(paths.includes(p), `${p} in ${paths}`);
    for (const h of site.hits) assert.equal(h.mark, 'task-guard-1', `${h.path} carries the task’s own mark, once`);
    assert.equal(site.hits.find((h) => h.path === '/api')!.cookie, 'seen=yes', 'the page’s cookie still goes along');
  } finally {
    await s.close();
    await site.close();
  }
});

test('wall 2 alone stops the reviewer’s probe: the marked browser gets the pairing page, not the console', { timeout: 90_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const m = blank('nova-ui-hub-mark-');
  const nova = await m.start(browserEnv());
  const port = Number(new URL(m.base).port);
  // The browser knows nothing of Nova's ports here: only the mark is in the way.
  const s = session([`127.0.0.1:${port}`], NO_HUB);
  try {
    await finishSetup(m);
    assert.equal((await fetch(`${m.base}/api/v1/mesh/requests`)).status, 200, 'unmarked, this machine is the console');
    await s.open();
    await s.navigate(`${m.base}/api/v1/mesh/requests`);
    const text = await s.text();
    assert.match(text, /isn’t paired with Nova/, text.slice(0, 200));
    await s.navigate(`${m.base}/`);
    assert.match(s.url, /\/pair$/, 'the console UI sends it to pair, like any stranger');
  } finally {
    await s.close();
    await stop(nova);
  }
});

test('the reviewer’s probe, end to end: a phone that may not approve can’t send a browser task to Nova itself', { timeout: 90_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const m = blank('nova-ui-hub-probe-');
  const free = await recorder();
  const meshPort = free.port;
  await free.close();
  const mesh = `http://127.0.0.1:${meshPort}`;
  const nova = await m.start({ ...browserEnv(), NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  try {
    await finishSetup(m);
    const h = { mesh, nowS: () => Math.floor(Date.now() / 1000), c: (method: string, path: string, body?: unknown) => call(m.base, method, `/api/v1${path}`, body) };
    const { token } = await enroll(h as never, { name: 'Plain phone', kind: 'phone' });
    const phone = (method: string, path: string, body?: unknown) => call(mesh, method, `/api/v1${path}`, body, { authorization: `Bearer ${token}` });
    assert.equal((await phone('GET', '/mesh/requests')).status, 403, 'it may not read this itself');
    const consolePort = new URL(m.base).port;
    for (const hosts of [['127.0.0.1'], ['localhost'], [`127.0.0.1:${consolePort}`], [`localhost:${meshPort}`]]) {
      const r = await phone('POST', '/tasks', browserTask({ allowed_hosts: hosts, steps: [{ do: 'navigate', url: `http://${hosts[0]!.includes(':') ? hosts[0] : `${hosts[0]}:${consolePort}`}/api/v1/mesh/requests` }, { do: 'read', selector: 'body' }] }, 'probe'));
      assert.equal(r.status, 400, `${hosts}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.details.join(' '), /name the port|Nova’s own address/);
    }
  } finally {
    await stop(nova);
  }
});

// M5 review, minor 8: Chromium looks up only the declared names, which must still work; its
// profile names this process (so a later start can tell it was left behind) and goes when it closes.
test('declared names still resolve under the resolver rules; the profile names its process and is removed on close', { timeout: 60_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const site = await recorder(() => '<!doctype html><h1 id="t">Declared</h1>');
  const ours = () => readdirSync(tmpdir()).filter((n) => n.startsWith('nova-browser-')).map((n) => join(tmpdir(), n))
    .filter((p) => { try { return readFileSync(join(p, '.nova-owner'), 'utf8') === String(process.pid); } catch { return false; } });
  const before = new Set(ours());
  // Closed in `finally`: a failed assertion must not leave the server holding this file's process
  // open (the 90-minute UI-gate run of PR #236 was exactly that).
  try {
  for (const [hosts, url] of [
    [[`localhost:${site.port}`], `http://localhost:${site.port}/`],
    [[`*.localhost:${site.port}`], `http://app.localhost:${site.port}/`],
    [[`127.0.0.1:${site.port}`], `http://127.0.0.1:${site.port}/`],
  ] as [string[], string][]) {
    const s = session(hosts, NO_HUB);
    try {
      await s.open();
      const mine = ours().filter((p) => !before.has(p));
      assert.equal(mine.length, 1, 'one profile, naming this process');
      await s.navigate(url);
      assert.equal(await s.evaluate<string>('document.getElementById("t")?.textContent ?? ""'), 'Declared', `${hosts}: ${url}`);
      await s.close();
      assert.equal(existsSync(mine[0]!), false, 'removed when the browser closed');
    } finally {
      await s.close();
    }
  }
  } finally {
    await site.close();
  }
});

// The review's egress probe: a page on a declared host reaches for an undeclared listener every
// way a page can (preconnect, prefetch, a stylesheet and an image under another name, an iframe,
// a beacon, fetch, a redirect, a WebSocket, an event stream, a worker, popups, a form post, a
// service worker, WebRTC). None of it arrives.
test('a hostile page on a declared host gets nothing through to anywhere else', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const sinkHits: string[] = [];
  const sink = createServer((req, res) => { sinkHits.push(`${req.method} ${req.url}`); res.writeHead(302, { location: '/x' }); res.end(); });
  sink.on('upgrade', (req, sock) => { sinkHits.push(`UPGRADE ${req.url}`); sock.destroy(); });
  sink.on('connect', (req, sock) => { sinkHits.push(`CONNECT ${req.url}`); sock.destroy(); });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  const sp = (sink.address() as AddressInfo).port;
  const S = `http://127.0.0.1:${sp}`;
  const L = `http://localhost:${sp}`;
  const html = `<!doctype html><html><head>
<link rel="preconnect" href="${S}/preconnect"><link rel="dns-prefetch" href="//leak-dns.example.test">
<link rel="prefetch" href="${S}/prefetch"><link rel="stylesheet" href="${L}/css">
</head><body><h1 id="t">Hostile</h1><div id="out">pending</div>
<iframe src="${S}/iframe"></iframe><img src="${L}/img">
<script>
try { navigator.sendBeacon('${S}/beacon', 'x'); } catch {}
fetch('${S}/fetch', { mode: 'no-cors' }).catch(() => {});
fetch('/redir').catch(() => {});
try { new WebSocket('ws://127.0.0.1:${sp}/ws'); } catch {}
try { new EventSource('${S}/es'); } catch {}
try { new Worker(URL.createObjectURL(new Blob(["fetch('${S}/worker',{mode:'no-cors'}).catch(()=>{})"]))); } catch {}
try { window.open('${S}/popup'); } catch {}
const f = document.createElement('form'); f.method = 'post'; f.action = '${S}/formpost'; f.target = 'ifr2';
const i2 = document.createElement('iframe'); i2.name = 'ifr2'; document.body.append(i2, f); f.submit();
navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').catch(() => {});
try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${sp}' }, { urls: 'turn:127.0.0.1:${sp}?transport=tcp', username: 'a', credential: 'b' }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); } catch {}
setTimeout(() => { const i = document.createElement('i'); i.id = 'fin'; document.body.append(i); }, 2500);
</script></body></html>`;
  const page = createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: `${S}/redirected` }); res.end(); return; }
    if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`self.addEventListener('install', () => { fetch('${S}/sw-install', {mode:'no-cors'}).catch(()=>{}); });`); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((r) => page.listen(0, '127.0.0.1', r));
  const pp = (page.address() as AddressInfo).port;
  const m = blank('nova-ui-hub-egress-');
  const nova = await m.start(browserEnv());
  try {
    await finishSetup(m);
    const plan = { allowed_hosts: [`127.0.0.1:${pp}`], steps: [{ do: 'navigate', url: `http://127.0.0.1:${pp}/` }, { do: 'wait', selector: '#fin', timeout_ms: 8000 }, { do: 'read', selector: '#t', expect: 'Hostile' }], verify: { expect: ['Hostile'] } };
    const r = await m.send('POST', '/api/v1/tasks', browserTask(plan, 'Open a hostile page'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const task = await waitTask(m, r.body.id, settled);
    assert.equal(task.state, 'done', task.reason ?? '');
    await sleep(1000);
    assert.deepEqual(sinkHits, [], 'nothing reached the undeclared listener');
    const hosts = (await events(m, task.id)).filter((e) => e.kind === 'blocked_request').map((e) => e.detail.host);
    for (const h of [`127.0.0.1:${sp}`, `localhost:${sp}`]) assert.ok(hosts.includes(h), `${h} refused and recorded: ${hosts}`);
  } finally {
    await stop(nova);
    sink.closeAllConnections();
    sink.close();
    page.closeAllConnections();
    page.close();
  }
});
