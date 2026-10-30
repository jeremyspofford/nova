// Capture in a real browser (M6 plan §1), against the real server and the stand-in Screenpipe:
// no indicator while nothing captures; adding Screenpipe and turning it on in Settings › Capture;
// the indicator then on every page, in every layout, a phone's Home included; the Capture view with
// real items only (a private window never appears), an unclassified one filed into a space, one
// remembered with provenance, one forgotten, and at most one standout; pausing hides the indicator.
// Neutral placeholders only; nothing on this machine is captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop, until } from '../acceptance/support.ts';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const indicator = (page: Page) => page.locator('#capture-ind');

test('M6a: the capture indicator on every page, Settings › Capture, and the Capture view', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const sp = await startFakeScreenpipe();
  const m = blank('nova-ui-m6a-');
  const nova = await m.start({ NOVA_CAPTURE_POLL_MS: '150' });
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm6') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await finishSetup(m);
    await m.send('PUT', '/api/v1/capture/settings', { signals: [{ kind: 'app', app: 'Editor', space: 'work' }], spaces: ['personal', 'work'] });
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    // Every answer the page got that was an error, whatever the page made of it.
    const failures: string[] = [];
    page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    await page.goto(`${m.base}/`);
    await ready(page);
    assert.equal(await indicator(page).isVisible(), false, 'nothing captures, so no indicator');

    // Settings › Capture: add Screenpipe, then turn it on (consent).
    await page.goto(`${m.base}/settings#capture`);
    await ready(page);
    const section = page.locator('#capture');
    await section.locator('form[data-form="screenpipe"]').waitFor();
    assert.match((await section.textContent()) ?? '', /Nothing is captured until you turn a source on/);
    await section.locator('details.raw summary', { hasText: 'What each kind of device can capture' }).click();
    assert.match((await section.textContent()) ?? '', /No passive capture of other apps/);
    // Private windows: said plainly how they are recognised, and what is surer.
    assert.match((await section.textContent()) ?? '', /recognises them by the window’s title/);
    assert.match((await section.textContent()) ?? '', /Screenpipe’s own ignored-windows setting/);
    // Each exclusion says what it keeps out; an app's can't stop audio.
    await section.locator('form[data-form="exclusion"] select[name="kind"]').selectOption('app');
    await section.locator('form[data-form="exclusion"] input[name="value"]').fill('Password Keeper');
    await section.locator('form[data-form="exclusion"] button[type="submit"]').click();
    await section.locator('.capture-rules li', { hasText: 'Password Keeper' }).waitFor();
    assert.match((await section.locator('.capture-rules li', { hasText: 'Password Keeper' }).textContent()) ?? '', /doesn’t stop audio/);
    await section.locator('input[name="url"]').fill(sp.base);
    await section.locator('form[data-form="screenpipe"] button[type="submit"]').click();
    const row = section.locator('.conn[data-source^="screenpipe:"]');
    await row.waitFor();
    assert.match((await row.textContent()) ?? '', /Off/);
    if (shots) await shoot(page, join(shots, 'capture-settings-off.png'));
    await row.locator('[data-action="capture-on"]').click();
    await indicator(page).waitFor({ state: 'visible' });
    assert.match((await indicator(page).getAttribute('aria-label')) ?? '', /Capturing: Screenpipe/);
    await page.waitForFunction(() => /Capturing/.test(document.querySelector('#capture .conn')?.textContent ?? ''));

    // Things happen on the (made-up) computer.
    const now = Date.now();
    sp.add(
      { at: new Date(now + 60_000).toISOString(), app: 'Editor', window: 'plan.md', text: 'Draft the quarterly plan outline' },
      { at: new Date(now + 120_000).toISOString(), app: 'Notes', window: 'list', text: 'Buy a new kettle before the weekend' },
      { at: new Date(now + 180_000).toISOString(), app: 'Browser', window: 'New Incognito Tab - Browser', text: 'PRIVATE-UI-SENTINEL' },
    );
    await until(() => m.get('/api/v1/capture/events'), (l: any[]) => l.length === 2, 400);

    // The indicator is on every page, in every layout.
    for (const path of ['/', '/chat', '/tasks', '/memory', '/automations', '/skills', '/activity', '/health', '/settings']) {
      await page.goto(`${m.base}${path}`);
      await ready(page);
      await indicator(page).waitFor({ state: 'visible' });
    }
    for (const width of [375, 768]) {
      const d = await device(b, { width, height: 800 });
      for (const path of ['/', '/tasks', '/settings']) {
        await d.page.goto(`${m.base}${path}`);
        await ready(d.page);
        await indicator(d.page).waitFor({ state: 'visible' });
        if (shots && width === 375 && path === '/') await shoot(d.page, join(shots, 'capture-indicator-phone-home.png'));
        const overflow = await d.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${width}px ${path}: no sideways scrolling`);
      }
      assert.deepEqual(d.errors, []);
      await d.ctx.close();
    }

    // The Capture view, from the indicator.
    await page.goto(`${m.base}/`);
    await ready(page);
    await indicator(page).click();
    await page.waitForURL(/\/capture$/);
    const view = page.locator('#capture-view');
    await view.locator('#cap-recent').waitFor();
    const text = (await view.textContent()) ?? '';
    assert.match(text, /Which space is this\?/);
    assert.match(text, /Buy a new kettle/);
    assert.match(text, /Draft the quarterly plan outline/);
    assert.equal(text.includes('PRIVATE-UI-SENTINEL'), false, 'a private window never appears');
    assert.ok((await view.locator('.btn.primary').count()) <= 1, 'at most one standout');
    if (shots) await shoot(page, join(shots, 'capture-view.png'));

    // File the unclassified item, and keep Notes in that space from now on.
    const sort = view.locator('.capture-sort');
    await sort.locator('#capture-always').check();
    await sort.locator('[data-action="capture-space"][data-space="personal"]').click();
    await page.waitForFunction(() => !document.querySelector('#capture-view .capture-sort'));
    const kettle = (await m.get('/api/v1/capture/events')).find((e: any) => /kettle/.test(e.text));
    assert.deepEqual([kettle.space, kettle.space_by], ['personal', 'person']);
    assert.ok((await m.get('/api/v1/capture')).settings.signals.some((s: any) => s.app === 'Notes' && s.space === 'personal'));

    // Remember one, deliberately: it becomes a memory with provenance back to the capture.
    await view.locator(`.capture-item[data-event="${kettle.id}"] [data-action="capture-remember"]`).click();
    const sheet = page.locator('#sheet .capture-remember');
    await sheet.waitFor();
    await sheet.locator('textarea[name="content"]').fill('Buy a new kettle before the weekend.');
    if (shots) await shoot(page, join(shots, 'capture-remember.png'));
    await sheet.locator('button[type="submit"]').click();
    const mems = await until(() => m.get('/api/v1/memory'), (l: any[]) => l.length === 1, 400);
    assert.deepEqual([mems[0].content, mems[0].source, mems[0].scope], ['Buy a new kettle before the weekend.', `capture:${kettle.id}`, 'personal']);
    await view.locator(`.capture-item[data-event="${kettle.id}"] .pill.is-on`).waitFor();

    // Forget the other for good.
    const plan = (await m.get('/api/v1/capture/events')).find((e: any) => /quarterly/.test(e.text));
    await view.locator(`.capture-item[data-event="${plan.id}"] [data-action="capture-forget"]`).click();
    await page.locator('#sheet .capture-forget button[type="submit"]').click();
    await page.waitForFunction((id) => !document.querySelector(`#capture-view .capture-item[data-event="${id}"]`), plan.id);
    assert.equal((await m.send('GET', `/api/v1/capture/events/${plan.id}`)).status, 404);

    // A suggestion for something with no space: accepting it asks which space, never a silent one.
    sp.add({ at: new Date(now + 240_000).toISOString(), app: 'Reader', window: 'article', text: 'The library closes early on Fridays' });
    const library = (await until(() => m.get('/api/v1/capture/events'), (l: any[]) => l.some((e: any) => /library/.test(e.text)), 400)).find((e: any) => /library/.test(e.text));
    assert.equal(library.space, null);
    // A proposal, as a triage decision with a provider would leave it (no model runs in this test).
    const db = new DatabaseSync(join(m.home, 'nova.db'));
    db.prepare(`INSERT INTO capture_proposal (id, event_id, template_id, version, provider, p, state, at) VALUES ('proposal-ui-1', ?, 'capture-promote', 1, 'stand-in', 0.9, 'proposed', ?)`).run(library.id, new Date().toISOString());
    db.close();
    await page.goto(`${m.base}/capture`);
    await ready(page);
    await view.locator('#cap-suggest').waitFor();
    await view.locator('[data-action="capture-accept"]').click();
    const ask = page.locator('#sheet .capture-remember');
    await ask.waitFor();
    assert.equal(await ask.locator('input[name="scope"]').inputValue(), '', 'no space chosen for the person');
    await ask.locator('input[name="scope"]').fill('work');
    await ask.locator('button[type="submit"]').click();
    const accepted = await until(() => m.get('/api/v1/memory'), (l: any[]) => l.some((x: any) => /library/.test(x.content)), 400);
    assert.equal(accepted.find((x: any) => /library/.test(x.content)).scope, 'work');

    // Pause everything: the indicator goes, and the page says Screenpipe itself keeps recording.
    await page.goto(`${m.base}/settings#capture`);
    await ready(page);
    await section.locator('[data-action="capture-pause-all"]').click();
    await indicator(page).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => /Paused/.test(document.querySelector('#capture .conn')?.textContent ?? ''));
    assert.match((await section.locator('.conn').first().textContent()) ?? '', /Screenpipe itself keeps recording/);

    // Nova's server stops answering: capture may be on there, so the indicator says it can't tell.
    const cut = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const cutPage = await cut.newPage();
    await cutPage.goto(`${m.base}/`);
    await ready(cutPage);
    assert.equal(await indicator(cutPage).isVisible(), false, 'paused: nothing captures');
    await cutPage.route('**/api/v1/capture', (r) => r.abort());
    await cutPage.evaluate(() => window.dispatchEvent(new Event('online')));
    await indicator(cutPage).waitFor({ state: 'visible' });
    assert.match((await indicator(cutPage).textContent()) ?? '', /Capture state unknown/);
    await cutPage.unroute('**/api/v1/capture');
    await cutPage.evaluate(() => window.dispatchEvent(new Event('online')));
    await indicator(cutPage).waitFor({ state: 'hidden' });
    await cut.close();
    if (shots) await shoot(page, join(shots, 'capture-settings-paused.png'));
    assert.deepEqual(failures, []);
    // Leaving a page cuts its event streams mid-answer; the browser says so, and that's all it is.
    assert.deepEqual(errors.filter((e) => !/ERR_INCOMPLETE_CHUNKED_ENCODING/.test(e)), []);
  } finally {
    await stop(nova);
    await sp.close();
    await b.close();
  }
});
