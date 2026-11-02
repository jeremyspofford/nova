// The layout sweep must use the app router: a full navigation tears down a live refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop } from '../acceptance/support.ts';
import { reviewProfile } from './axe-support.ts';
import { withMesh } from './fold-support.ts';
import { openFoldView } from './fold-navigation.ts';
import { device, webkitBrowser } from './support.ts';

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
    const corsError = new Promise<void>((resolve) => d.page.on('console', (msg) => { if (msg.type() === 'error' && /access.control|Access-Control|Origin/.test(msg.text())) resolve(); }));
    assert.equal(await d.page.evaluate(async (url) => {
      try { await fetch(url); return false; } catch { return true; }
    }, `${m.base.replace('127.0.0.1', 'localhost')}/api/v1/problems`), true);
    await corsError;
    const forbiddenError = d.page.waitForEvent('console', (msg) => msg.type() === 'error' && msg.text().includes('403'));
    assert.equal(await d.page.evaluate(async () => (await fetch('/api/v1/problems/1/resolve', { method: 'POST' })).status), 403);
    await forbiddenError;
    assert.ok(d.errors.some((e) => /access.control|Access-Control|Origin/.test(e)), 'genuine CORS errors are collected');
    assert.ok(d.errors.some((e) => e.includes('403')), 'genuine refused mutation errors are collected');
    await d.ctx.close();
  } finally { await b.close(); await stop(nova); }
});
