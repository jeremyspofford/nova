// The layout sweep must use the app router: a full navigation tears down a live refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop } from '../acceptance/support.ts';
import { reviewProfile } from './axe-support.ts';
import { withMesh } from './fold-support.ts';
import { foldCardRadius, foldDesignReady, openFoldView } from './fold-navigation.ts';
import { browser, device, webkitBrowser } from './support.ts';

test('fold navigation keeps the document and completes a real playbook refresh', { timeout: 120_000 }, async (t) => {
  const b = await webkitBrowser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await reviewProfile('nova-fold-navigation-');
  try {
    const d = await device(b, { width: 430, height: 932, touch: true, serviceWorkers: 'block' });
    await withMesh(d.ctx);
    await openFoldView(d.page, `${m.base}/chat`);
    assert.deepEqual(d.errors, [], 'initial full load has no errors');
    await d.page.evaluate(async () => {
      const surfaces = await import(String('/js/surfaces.js'));
      // Diagnostic only: reproduce a late refresh begun while an old document is leaving.
      window.addEventListener('pagehide', () => { void surfaces.load(['resilience', 'problems']); });
      document.documentElement.setAttribute('data-test-document', 'original');
    });
    const refreshed = ['/resilience', '/problems'].map((path) => d.page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1${path}` && r.request().method() === 'GET'));
    await d.page.evaluate(async () => {
      const core = await import(String('/js/core.js'));
      core.stream().dispatchEvent(new MessageEvent('playbook', { data: '{}' }));
    });
    await openFoldView(d.page, `${m.base}/tasks`);
    for (const response of await Promise.all(refreshed)) {
      assert.equal(response.status(), 200);
      assert.equal(await response.finished(), null, 'real refresh response completes');
    }
    // In the old helper the documented hazard emits these exact errors before the new boot.
    assert.deepEqual(d.errors, [], 'no pageerror or console error during real refresh/navigation');
    assert.equal(await d.page.getAttribute('html', 'data-test-document'), 'original', 'actual router retains the document');
    assert.equal(await d.page.getAttribute('body', 'data-view'), 'tasks');
    assert.match(await d.page.locator('#tasks-view').innerText(), /Save the shopping list/);
    await d.ctx.close();
  } finally { await b.close(); await stop(nova); }
});

test('fold error collector still detects genuine CORS and refused mutations', { timeout: 120_000 }, async (t) => {
  const b = await webkitBrowser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await reviewProfile('nova-fold-errors-');
  try {
    const d = await device(b, { width: 430, height: 932, touch: true, serviceWorkers: 'block' });
    await withMesh(d.ctx);
    await openFoldView(d.page, `${m.base}/chat`);
    assert.equal(d.errors.length, 0);
    // Nova's Content-Security-Policy (connect-src 'self') refuses the cross-origin request before
    // CORS is ever asked, so the genuine error is that refusal.
    const crossOrigin = /access.control|Access-Control|Origin|connect-src/;
    const corsError = new Promise<void>((resolve) => d.page.on('console', (msg) => { if (msg.type() === 'error' && crossOrigin.test(msg.text())) resolve(); }));
    assert.equal(await d.page.evaluate(async (url) => {
      try { await fetch(url); return false; } catch { return true; }
    }, `${m.base.replace('127.0.0.1', 'localhost')}/api/v1/problems`), true);
    await corsError;
    const forbiddenError = d.page.waitForEvent('console', (msg) => msg.type() === 'error' && msg.text().includes('403'));
    assert.equal(await d.page.evaluate(async () => (await fetch('/api/v1/problems/1/resolve', { method: 'POST' })).status), 403);
    await forbiddenError;
    assert.ok(d.errors.some((e) => crossOrigin.test(e)), 'genuine CORS errors are collected');
    assert.ok(d.errors.some((e) => e.includes('403')), 'genuine refused mutation errors are collected');
    await d.ctx.close();
  } finally { await b.close(); await stop(nova); }
});


for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`fold design readiness waits for installed CSS while ${engine} metadata arrives first`, { timeout: 120_000 }, async (t) => {
    const b = await launch();
    if (typeof b === 'string') return t.skip(b);
    const { m, nova } = await reviewProfile('nova-fold-css-');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const captured = new Promise<void>((resolve) => { held = resolve; });
    let delivery: Promise<void> | undefined;
    let readiness: Promise<void> | undefined;
    let resumeRead: (() => void) | undefined;
    let styleRead: Promise<string> | undefined;
    let restoreRead: (() => void) | undefined;
    let css = '';
    try {
      const d = await device(b, { serviceWorkers: 'block' });
      await withMesh(d.ctx);
      await openFoldView(d.page, `${m.base}/`);
      await d.page.waitForFunction(() => !!document.getElementById('ds')?.textContent && !document.getElementById('ds-boot'));
      const before = await foldCardRadius(d.page);
      const cssUrl = `${m.base}/design-system.css?device=${encodeURIComponent(d.id)}`;
      // Hold the real response to the production event's fetch, without changing its CSS.
      await d.page.route(cssUrl, (route) => {
        delivery = (async () => {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          css = await response.text();
          held();
          await gate;
          await route.fulfill({ response, body: css });
        })();
        return delivery;
      });
      assert.equal((await m.send('POST', '/api/v1/design-systems/nova/apply', { scope: 'device', device_id: d.id })).status, 200);
      await captured;
      await d.page.waitForFunction(() => document.documentElement.dataset.theme === 'nova');
      assert.notEqual(await d.page.locator('#ds').textContent(), css, 'metadata completed while the old CSS is still installed');
      readiness = foldDesignReady(d.page, 'nova', d.id);
      const outcome = await Promise.race([
        readiness.then(() => 'early'),
        d.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))).then(() => 'held'),
      ]);
      assert.equal(outcome, 'held', 'the actual boundary must not resolve while the intended CSS response is held');
      assert.equal(before, '12px');
      const oldCard = await d.page.locator('#home .card').first().elementHandle();
      assert.ok(oldCard);
      let started!: () => void;
      const readStarted = new Promise<void>((resolve) => { started = resolve; });
      const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
      const selected = d.page.locator('#home .card').first();
      // Hold the actual Locator.evaluate post-resolution phase, or the atomic page read before
      // it begins. The real core refresh replaces the card while either operation is held.
      const instrumented = selected as typeof selected & { _withElement: (task: (...args: any[]) => Promise<unknown>, options: unknown) => Promise<unknown> };
      const originalMethod = instrumented._withElement;
      const original = originalMethod.bind(instrumented);
      let sampledCard: typeof oldCard | undefined;
      instrumented._withElement = (task, options) => original(async (handle, ...args) => { sampledCard = handle; started(); await readGate; return task(handle, ...args); }, options);
      restoreRead = () => { instrumented._withElement = originalMethod; };
      const controlledPage = {
        locator: (selector: string) => { assert.equal(selector, '#home .card'); return { first: () => selected }; },
        evaluate: async (fn: () => string) => { started(); await readGate; return d.page.evaluate(fn); },
      } as unknown as typeof d.page;
      styleRead = foldCardRadius(controlledPage);
      await readStarted;
      const replacedCard = sampledCard ?? oldCard;
      await d.page.evaluate(async () => { const core = await import(String('/js/core.js')); core.stream().dispatchEvent(new MessageEvent('task', { data: '{}' })); });
      await d.page.waitForFunction((card) => !card.isConnected, replacedCard);
      const evidence = await replacedCard.evaluate((card) => ({ oldConnected: card.isConnected, oldRadius: getComputedStyle(card).borderTopLeftRadius, currentConnected: document.querySelector('#home .card')!.isConnected, currentRadius: getComputedStyle(document.querySelector('#home .card')!).borderTopLeftRadius }));
      console.log(`FOLD held card refresh ${JSON.stringify({ engine, ...evidence })}`);
      assert.deepEqual(evidence, { oldConnected: false, oldRadius: '', currentConnected: true, currentRadius: before });
      resumeRead!();
      assert.equal(await styleRead, before, 'the previous design is still painted');
      release();
      await delivery;
      await readiness;
      assert.equal(await d.page.locator('#ds').textContent(), css, 'the exact real response is installed');
      const design = await m.get('/api/v1/design-systems/nova');
      const after = await foldCardRadius(d.page);
      assert.equal(after, design.manifest.tokens['radius/card'], 'the intended design is rendered');
      assert.notEqual(after, before);
      assert.deepEqual(d.errors, []);
    } finally {
      release(); resumeRead?.(); restoreRead?.();
      try { await delivery; await readiness; await styleRead; } finally { await b.close(); await stop(nova); }
    }
  });
}
