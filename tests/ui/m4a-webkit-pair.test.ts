// Pairing in WebKit, the engine every iPhone browser runs on. WebKit can't keep an X25519 key in
// IndexedDB: the whole stored identity reads back as nothing, so a phone that joined and showed its
// digits could never sign its "am I approved yet?" check and sat on the digits for good. Here an
// iPhone-sized WebKit pairs end to end (the hub's side by its API) and reaches Home signed in, and
// a phone left with a pending request but no keys starts again instead of waiting forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { stop } from '../acceptance/support.ts';
import { blank, finishSetup, ready, webkitBrowser } from './support.ts';

const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });

test('M4a in WebKit: an iPhone pairs, is approved, and reaches Home signed in', async (t) => {
  const b = await webkitBrowser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m4a-webkit-');
  const port = await freePort();
  const mesh = `http://127.0.0.1:${port}`;
  const nova = await m.start({ NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  try {
    await finishSetup(m);
    const made = await m.send('POST', '/api/v1/mesh/pairings');
    assert.equal(made.status, 201);

    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(made.body.url);
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

    const [request] = (await m.send('GET', '/api/v1/mesh/requests')).body;
    assert.equal(request.confirmation, digits, 'the hub shows the same six digits');
    assert.equal((await m.send('POST', `/api/v1/mesh/requests/${request.id}/approve`, { confirm: true })).status, 200);

    await page.waitForURL(`${mesh}/`, { timeout: 15000 });
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
    await page.goto(`${mesh}/pair`);
    await page.locator('#join').waitFor({ timeout: 10000 });
    assert.match((await page.locator('#pair-body').textContent()) ?? '', /pair it again/i);
    await ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});
