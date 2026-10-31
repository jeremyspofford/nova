// The second review of PR #238: live probes, each written before its fix, in real Chromium sessions
// on the stand-in shop (scripts/stand-ins/shop-site.js, pages under /r2/). The stand-in's own server
// log is the proof: what it never saw never left.
//  1. WebSockets, WebRTC and event streams after the checkout stop.
//  3. One non-GET per declared send, from the page itself: the same path with other bodies, by a
//     timer, a microtask and an animation frame, is refused.
//  4. While the person holds the browser, the page's own script can't post to a pay address; the
//     person's own pay button can.
//  5. A pause shuts an open send window.
//  6. Workers that start workers, a SharedWorker, and a service worker (including one registered
//     in an earlier task, before Nova attaches) are held like the page.
//  and: 307/308 redirects into a POST, pagehide beacons and keepalive fetches, a form sent on
//  unload, a POST form into a new window, a meta refresh to a pay address, and GET payloads after
//  the stop (a known limit, unless the address pays).
// Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../../src/core/browser/session.ts';
import { CLICK } from '../../src/core/browser/facts.ts';
import { chromiumPath } from './support.ts';
import { canBrowse, sleep, startShop, type Shop } from './m10b-support.ts';

const H = { key: 'console', label: 'The hub’s own screen' };
const sel = (q: string) => JSON.stringify(q);
const hits = (shop: Shop, ...paths: string[]) => shop.log.filter((l: { path: string }) => paths.includes(l.path));
const click = (s: Session, q: string) => s.act(`(${CLICK}).apply(document.querySelector(${sel(q)}), [])`);
const session = (shop: Shop, profile?: string) => new Session({ taskId: 'task-review2', chromium: chromiumPath(), hosts: [shop.host], sandbox: false, ...(profile ? { profile } : {}) });
async function waitDone(s: Session, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end && !(await s.evaluate<boolean>('!!document.getElementById("done")').catch(() => false))) await sleep(100); }

test('second review 1: after the checkout stop, no WebSocket upgrade, frame or WebRTC connection reaches the site', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const s = session(shop);
  try {
    await s.open();
    await s.navigate(`${shop.url}/r2/ws`);
    s.lockSends();
    await waitDone(s);
    await sleep(500);
    assert.deepEqual(shop.log.filter((l: { method: string }) => ['UPGRADE', 'WSFRAME', 'RAW'].includes(l.method)), [], 'no WebSocket, no raw (TURN) connection');
    // An event stream is a GET: what it carries in its address is the known limit of GETs.
    console.log(`  · event stream requests: ${hits(shop, '/es').map((h: { method: string }) => h.method).join(', ') || 'none'}`);
  } finally {
    await s.close();
    await shop.close();
  }
});

test('second review 3: one non-GET per declared send, from the page itself; other bodies to the same path are refused', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const s = session(shop);
  try {
    await s.open();
    await s.navigate(`${shop.url}/r2/multi`);
    // As the worker grants a click on a submit button: its form's own submission, as a navigation.
    s.allowSends(1, [{ url: `${shop.url}/cart/add`, doc: true }]);
    assert.equal(await click(s, '#go'), 'ok');
    await s.settle();
    await sleep(1000);
    s.allowSends(null);
    assert.equal(hits(shop, '/cart/add').length, 1, `one POST to /cart/add, not ${hits(shop, '/cart/add').length}`);
    assert.deepEqual(shop.cart(), ['mug'], 'and it was the form’s own');
    // A declared send (any kind of request): still one, whichever comes first.
    await s.navigate(`${shop.url}/r2/multi`);
    s.allowSends(1, [`${shop.url}/cart/add`]);
    assert.equal(await click(s, '#go'), 'ok');
    await s.settle();
    await sleep(1000);
    s.allowSends(null);
    assert.equal(hits(shop, '/cart/add').length, 2, 'one more, not four');
  } finally {
    await s.close();
    await shop.close();
  }
});

test('second review 5: a pause shuts an open send window', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const s = session(shop);
  try {
    await s.open();
    await s.navigate(`${shop.url}/about-nothing`).catch(() => {});
    s.allowSends(1, [`${shop.url}/api/commit`]);
    s.pause(H);
    await s.navigate(`${shop.url}/r2/loop`).catch(() => {});
    await sleep(1200);
    assert.equal(hits(shop, '/api/commit').length, 0, 'nothing while paused');
    s.resume(H);
    await sleep(800);
    assert.ok(hits(shop, '/api/commit').length <= 1, `at most the one declared, after resume: ${hits(shop, '/api/commit').length}`);
    s.allowSends(null);
  } finally {
    await s.close();
    await shop.close();
  }
});

test('second review 6: workers, nested workers, a SharedWorker and service workers (one from an earlier task) are held like the page', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const profile = mkdtempSync(join(tmpdir(), 'nova-m10b-r2-profile-'));
  const paths = ['/api/commit-nested', '/api/commit-worker', '/api/commit-shared', '/api/commit-sw-install', '/api/commit-sw-fetch'];
  try {
    const a = session(shop, profile);
    try {
      await a.open();
      await a.navigate(`${shop.url}/r2/workers`);
      await waitDone(a);
      await sleep(1500);
    } finally { await a.close(); }
    assert.deepEqual(hits(shop, ...paths), [], 'first task: nothing from any worker');
    // The next task on the same profile: the service worker registered before Nova attached.
    const b = session(shop, profile);
    try {
      await b.open();
      await b.navigate(`${shop.url}/shop`);
      await b.navigate(`${shop.url}/cart`);
      await sleep(1500);
    } finally { await b.close(); }
    assert.deepEqual(hits(shop, ...paths), [], 'second task: nothing from the service worker either');
    console.log(`  · worker scripts fetched: ${hits(shop, '/r2-sw.js', '/r2-shared.js').length}`);
  } finally {
    await shop.close();
  }
});

test('second review, and: redirects into a POST, leaving the page, a POST form in a new window, a meta refresh to pay, GETs after the stop', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const s = session(shop);
  try {
    await s.open();
    // 307 and 308: the declared POST is redirected, still a POST, to a pay address and elsewhere.
    await s.navigate(`${shop.url}/r2/redirect`);
    s.allowSends(1, [`${shop.url}/r307`]);
    await click(s, '#go');
    await s.settle().catch(() => {});
    s.allowSends(null);
    await s.navigate(`${shop.url}/r2/redirect`);
    s.allowSends(1, [`${shop.url}/r308`]);
    await click(s, '#go2');
    await s.settle().catch(() => {});
    s.allowSends(null);
    assert.deepEqual(hits(shop, '/pay', '/api/commit'), [], 'the redirected POSTs went nowhere');
    // Leaving a page: pagehide beacon, keepalive fetch, a form sent on unload.
    await s.navigate(`${shop.url}/r2/leave`);
    await s.navigate(`${shop.url}/shop`);
    await sleep(800);
    assert.deepEqual(hits(shop, '/api/leave-beacon', '/api/leave-keepalive', '/api/leave-form'), []);
    // A POST form into a new window.
    await s.navigate(`${shop.url}/r2/popup-post`);
    await waitDone(s);
    await sleep(500);
    assert.deepEqual(hits(shop, '/api/popup-post'), []);
    // A meta refresh to a pay address.
    await s.navigate(`${shop.url}/r2/meta`).catch(() => {});
    await sleep(1000);
    assert.deepEqual(hits(shop, '/pay'), []);
    // After the stop: GETs carry what they carry (the known limit), never to a pay address.
    await s.navigate(`${shop.url}/r2/gets`);
    s.lockSends();
    await waitDone(s);
    await sleep(500);
    assert.deepEqual(hits(shop, '/pay'), [], 'no GET to a pay address');
    console.log(`  · GETs after the stop that reached the site (the known limit): ${hits(shop, '/collect-get', '/collect-prefetch').map((h: { path: string }) => h.path).join(', ') || 'none'}`);
  } finally {
    await s.close();
    await shop.close();
  }
});

test('second review 4: while the person holds the browser, the page’s own script can’t post to a pay address; the person’s own pay button can', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const s = session(shop);
  try {
    await s.open();
    await s.navigate(`${shop.url}/r2/payloop`);
    s.lockSends();
    s.takeOver(H);
    await sleep(1200);
    assert.equal(hits(shop, '/pay').length, 0, 'the page’s script, with the person holding the browser: refused');
    await s.input(H, { type: 'click', x: 40 / 1280, y: 40 / 800 });
    await sleep(1500);
    assert.equal(hits(shop, '/pay').length, 1, 'the person’s own click on Pay went through, once');
  } finally {
    await s.close();
    await shop.close();
  }
});
