// Pairing in WebKit, the engine every iPhone browser runs on. WebKit can't keep an X25519 key in
// IndexedDB: the whole stored identity reads back as nothing, so a phone that joined and showed its
// digits could never sign its "am I approved yet?" check and sat on the digits for good. Here an
// iPhone-sized WebKit pairs end to end (the hub's side by its API) and reaches Home signed in, and
// a phone left with a pending request but no keys starts again instead of waiting forever.
//
// WebKit also turns down a freshly made key now and then (OperationError, about one Ed25519 key in
// 150 and one X25519 key in 500 in Playwright's WebKit). /pair once took that for "this browser
// can't pair" and stopped, which made this gate flaky; a browser that does that every other time
// must still pair, and one with no Ed25519 at all must still be told so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
// A port below the ephemeral range: the hub's own listener is on port 0, and a port from there
// could be handed to it before the mesh listener binds (EADDRINUSE).
import { freePort } from '../acceptance/m4c-support.ts';
import { blank, finishSetup, ready, webkitBrowser } from './support.ts';

// A hub with a mesh listener the browser reaches, set up and holding a pairing code.
async function hub() {
  const m = blank('nova-ui-m4a-webkit-');
  const mesh = `http://127.0.0.1:${await freePort()}`;
  const nova = await m.start({ NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  await finishSetup(m);
  const made = await m.send('POST', '/api/v1/mesh/pairings');
  assert.equal(made.status, 201);
  return { m, mesh, nova, url: made.body.url as string };
}

// An iPhone-sized WebKit, with page errors kept.
async function phone(b: Browser): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

// The phone joins, the hub approves the same six digits, and the phone reaches Home signed in.
async function pairAndApprove(h: Awaited<ReturnType<typeof hub>>, page: Page) {
  await page.goto(h.url);
  await page.locator('#join').waitFor();
  await page.click('#join');
  const digits = ((await page.locator('.pair-digits').textContent({ timeout: 10000 })) ?? '').replace(/\s/g, '');
  assert.match(digits, /^\d{6}$/);
  const [request] = (await h.m.send('GET', '/api/v1/mesh/requests')).body;
  assert.equal(request.confirmation, digits, 'the hub shows the same six digits');
  assert.equal((await h.m.send('POST', `/api/v1/mesh/requests/${request.id}/approve`, { confirm: true })).status, 200);
  await page.waitForURL(`${h.mesh}/`, { timeout: 15000 });
  await ready(page);
}

test('M4a in WebKit: an iPhone pairs, is approved, and reaches Home signed in', async (t) => {
  const b = await webkitBrowser();
  if (typeof b === 'string') return t.skip(b);
  const h = await hub();
  try {
    const { ctx, page, errors } = await phone(b);
    await page.goto(h.url);
    await page.locator('#join').waitFor();
    await page.click('#join');
    const digits = ((await page.locator('.pair-digits').textContent({ timeout: 10000 })) ?? '').replace(/\s/g, '');
    assert.match(digits, /^\d{6}$/);

    // What this browser kept: its signing key, unreadable, and the public half of its sealing key.
    const kept = await page.evaluate(() => new Promise<unknown>((ok) => {
      const r = indexedDB.open('nova-device');
      r.onsuccess = () => {
        const g = r.result.transaction('keys').objectStore('keys').get('self');
        g.onsuccess = () => ok(g.result ? { ed: g.result.ed?.privateKey?.extractable, x: 'x' in g.result, pub: typeof g.result.x25519PublicKey } : null);
      };
    }));
    assert.deepEqual(kept, { ed: false, x: false, pub: 'string' }, 'the identity reads back in WebKit');

    const [request] = (await h.m.send('GET', '/api/v1/mesh/requests')).body;
    assert.equal(request.confirmation, digits, 'the hub shows the same six digits');
    assert.equal((await h.m.send('POST', `/api/v1/mesh/requests/${request.id}/approve`, { confirm: true })).status, 200);

    await page.waitForURL(`${h.mesh}/`, { timeout: 15000 });
    await ready(page);
    const status = await page.evaluate(() => fetch('/api/v1/memory', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ kind: 'fact', content: 'The spare key is in the blue box.' }) }).then((r) => r.status));
    assert.equal(status, 201, 'signed in, it can do what the person does');
    assert.deepEqual(errors, []);

    // A phone that was left showing digits with no keys behind them (what WebKit did before) is
    // told to pair again, with a fresh key, instead of waiting forever.
    await page.evaluate(() => new Promise<void>((ok) => {
      const r = indexedDB.open('nova-device');
      r.onsuccess = () => {
        const tx = r.result.transaction('keys', 'readwrite');
        tx.objectStore('keys').put({ pending: { requestId: '00000000-0000-4000-8000-000000000000', digits: '123456' } }, 'self');
        tx.oncomplete = () => ok();
      };
    }));
    await page.goto(`${h.mesh}/pair`);
    await page.locator('#join').waitFor({ timeout: 10000 });
    assert.match((await page.locator('#pair-body').textContent()) ?? '', /pair it again/i);
    await ctx.close();
  } finally {
    await b.close();
    await stop(h.nova);
  }
});

test('M4a in WebKit: a key the browser turns down once is made again, and the phone still pairs', async (t) => {
  const b = await webkitBrowser();
  if (typeof b === 'string') return t.skip(b);
  const h = await hub();
  try {
    const { ctx, page, errors } = await phone(b);
    // Every first try at a key fails as WebKit's does now and then, so each key /pair makes (the
    // check that this browser can pair, then the device's own) needs a second try.
    await ctx.addInitScript(() => {
      const real = SubtleCrypto.prototype.generateKey;
      let calls = 0;
      SubtleCrypto.prototype.generateKey = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['generateKey']>) {
        calls += 1;
        if (calls % 2 === 1) return Promise.reject(new DOMException('The operation failed for an operation-specific reason', 'OperationError'));
        return real.apply(this, args);
      } as SubtleCrypto['generateKey'];
    });
    await pairAndApprove(h, page);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await b.close();
    await stop(h.nova);
  }
});

test('M4a in WebKit: a browser with no Ed25519 is told plainly it can’t pair', async (t) => {
  const b = await webkitBrowser();
  if (typeof b === 'string') return t.skip(b);
  const h = await hub();
  try {
    const { ctx, page } = await phone(b);
    await ctx.addInitScript(() => {
      const real = SubtleCrypto.prototype.generateKey;
      SubtleCrypto.prototype.generateKey = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['generateKey']>) {
        if ((args[0] as { name?: string })?.name === 'Ed25519') return Promise.reject(new DOMException('Algorithm: Unrecognized name', 'NotSupportedError'));
        return real.apply(this, args);
      } as SubtleCrypto['generateKey'];
    });
    await page.goto(h.url);
    await page.locator('#pair-title', { hasText: 'This browser can’t pair' }).waitFor({ timeout: 10000 });
    assert.match((await page.locator('#pair-body').textContent()) ?? '', /Ed25519/);
    assert.equal(await page.locator('#join').count(), 0, 'no form to fill in');
    await ctx.close();
  } finally {
    await b.close();
    await stop(h.nova);
  }
});
