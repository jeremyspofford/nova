// Capture screening, job 1, in a real browser against the real server (plan
// docs/plans/capture-screening-consumers.md): the capture timeline shows every verdict with its
// reason, so nothing is held, redacted or excluded silently.
//   - With a trusted check (the Tev1 stand-in at the build that passed): checked items as before;
//     a redacted one says what was redacted and can be remembered; a held one says why, keeps its
//     words behind a tap, and can't be remembered; an excluded one says its text wasn't kept; each
//     opens to how it was checked (template version, seat and model, scores, source).
//   - With no model on the device (option B): everything is held, the holding area shows the
//     owner's notice and what stands in the way, and nothing can be remembered; at phone width too.
// Synthetic placeholders only (a published test card number, marker words for the stand-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { stop, until } from '../acceptance/support.ts';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { captureCheckServer } from '../support/capture-check.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const NOTICE = 'This device can’t check captured text for private details yet, so it’s being held, not kept. Add the Tev1 4B model to fix that.';

async function capturing(m: ReturnType<typeof blank>, sp: Awaited<ReturnType<typeof startFakeScreenpipe>>) {
  await finishSetup(m);
  await m.send('PUT', '/api/v1/capture/settings', { signals: [{ kind: 'app', app: 'Notes', space: 'personal' }, { kind: 'app', app: 'Editor', space: 'personal' }, { kind: 'app', app: 'Chat', space: 'personal' }], spaces: ['personal'] });
  const src = (await m.send('POST', '/api/v1/capture/sources/screenpipe', { url: sp.base })).body;
  assert.equal((await m.send('POST', `/api/v1/capture/sources/${encodeURIComponent(src.id)}/enable`)).status, 200);
  const now = Date.now();
  sp.add(
    { at: new Date(now + 60_000).toISOString(), app: 'Editor', window: 'plan.md', text: 'Draft the quarterly plan outline' },
    { at: new Date(now + 120_000).toISOString(), app: 'Notes', window: 'card', text: 'Pay the plumber with card 4242 4242 4242 4242 today' },
    { at: new Date(now + 180_000).toISOString(), app: 'Notes', window: 'clinic', text: 'Alex Placeholder CANARY-GREY-HEALTH follow-up next week' },
    { at: new Date(now + 240_000).toISOString(), app: 'Chat', window: 'wifi', text: 'the wifi word is CANARY-GREY-PASSWORD maple' },
  );
}

const item = (page: Page, window: string) => page.locator('#capture-view .capture-item', { hasText: window });

test('the capture timeline shows each verdict with its reason; held and excluded items can’t be remembered', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const sp = await startFakeScreenpipe();
  const m = blank('nova-ui-capture-screen-');
  const check = await captureCheckServer(m.dir);
  const nova = await m.start({ NOVA_CAPTURE_POLL_MS: '150', ...check.env });
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'capture-screening') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await capturing(m, sp);
    const evs = await until(() => m.get('/api/v1/capture/events'), (l: any[]) => l.length === 4 && l.every((e) => !['unscreened', 'held'].includes(e.sensitivity.state)), 400);
    assert.deepEqual(Object.fromEntries(evs.map((e: any) => [e.window_title, e.sensitivity.state])), { 'plan.md': 'index', card: 'redact', clinic: 'hold', wifi: 'exclude' });

    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/capture`);
    await ready(page);
    await page.locator('#capture-view #cap-recent').waitFor();

    // Checked: no label, can be remembered.
    const plan = item(page, 'plan.md');
    assert.equal(await plan.getAttribute('data-sensitivity'), 'index');
    assert.equal(await plan.locator('.pill[data-sensitivity]').count(), 0, 'a checked item carries no label');
    assert.equal(await plan.locator('[data-action="capture-remember"]').count(), 1);

    // Redacted: says what, shows the redacted words, can be remembered.
    const card = item(page, 'card');
    assert.equal(await card.locator('.pill[data-sensitivity="redact"]').textContent(), 'Redacted: a card number');
    assert.match((await card.locator('.capture-text').textContent()) ?? '', /\[redacted: card number\]/);
    assert.equal(((await card.textContent()) ?? '').includes('4242 4242'), false, 'the number is nowhere on the page');
    assert.equal(await card.locator('[data-action="capture-remember"]').count(), 1);

    // Held: says why, words behind a tap, can't be remembered, can be forgotten.
    const clinic = item(page, 'clinic');
    assert.equal(await clinic.locator('.pill[data-sensitivity="hold"]').textContent(), 'Sensitive: held, not added to memory');
    assert.match((await clinic.locator('.capture-why').textContent()) ?? '', /a person’s health details/);
    assert.equal(await clinic.locator('.capture-text').isVisible(), false, 'its words are behind a tap');
    await clinic.locator('summary', { hasText: 'Show what was captured' }).click();
    assert.match((await clinic.locator('.capture-text').textContent()) ?? '', /CANARY-GREY-HEALTH/);
    assert.equal(await clinic.locator('[data-action="capture-remember"]').count(), 0);
    assert.equal(await clinic.locator('[data-action="capture-forget"]').count(), 1);

    // Excluded: says its text wasn't kept; there is no text to show.
    const wifi = item(page, 'wifi');
    assert.equal(await wifi.locator('.pill[data-sensitivity="exclude"]').textContent(), 'Sensitive: excluded, text not kept');
    assert.match((await wifi.locator('.capture-why').textContent()) ?? '', /found a password/);
    assert.equal(await wifi.locator('.capture-text').count(), 0);
    assert.equal(((await page.locator('#capture-view').textContent()) ?? '').includes('CANARY-GREY-PASSWORD'), false);
    assert.equal(await wifi.locator('[data-action="capture-remember"]').count(), 0);

    // Each opens to how it was checked.
    await clinic.locator('summary', { hasText: 'How this was checked' }).click();
    const record = (await clinic.locator('.capture-record').textContent()) ?? '';
    assert.match(record, /capture-sensitive v1/);
    assert.match(record, /tev1 \(tev1:4b@7954dce2/);
    assert.match(record, /health details 0\.96/);
    assert.match(record, /Capture source: screenpipe:/);
    if (shots) await shoot(page, join(shots, 'capture-timeline-verdicts.png'));

    // Nothing waits, so there is no holding area.
    assert.equal(await page.locator('#cap-held').count(), 0);
    assert.deepEqual(errors.filter((e) => !/ERR_INCOMPLETE_CHUNKED_ENCODING/.test(e)), []);
  } finally {
    await stop(nova);
    await sp.close();
    await check.close();
    await b.close();
  }
});

test('option B: with no model on the device, the holding area shows the notice, every item is held, nothing can be remembered', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const sp = await startFakeScreenpipe();
  const m = blank('nova-ui-capture-held-');
  // No Ollama at all: nothing on this device can check captured text.
  const nova = await m.start({ NOVA_CAPTURE_POLL_MS: '150', NOVA_OLLAMA_URL: 'http://127.0.0.1:9' });
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'capture-screening') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await capturing(m, sp);
    await until(() => m.get('/api/v1/capture/events'), (l: any[]) => l.length === 4 && l.every((e) => e.sensitivity.state === 'held'), 400);
    for (const width of [1280, 375]) {
      const { page, errors, ctx } = await device(b, { width, height: 900 });
      await page.goto(`${m.base}/capture`);
      await ready(page);
      const held = page.locator('#capture-view .capture-holding');
      await held.waitFor();
      const text = (await held.textContent()) ?? '';
      assert.match(text, /Held, not kept/);
      assert.ok(text.includes(NOTICE), 'the owner’s notice, word for word');
      assert.match(text, /4 items are held: not added to memory/);
      assert.equal(await held.locator('a[href="/settings#models"]').count(), 1, 'what fixes it is one tap away');
      const items = page.locator('#capture-view .capture-item');
      assert.equal(await items.count(), 4);
      for (let i = 0; i < 4; i++) {
        assert.equal(await items.nth(i).getAttribute('data-sensitivity'), 'held');
        assert.equal(await items.nth(i).locator('.pill[data-sensitivity="held"]').textContent(), 'Held, not kept: not checked yet');
        assert.equal(await items.nth(i).locator('[data-action="capture-remember"]').count(), 0);
      }
      // Nova's own rules still ran: the card number was blanked out before it was kept.
      const all = (await page.locator('#capture-view').textContent()) ?? '';
      assert.equal(all.includes('4242 4242'), false);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width}px: no sideways scrolling`);
      if (shots) await shoot(page, join(shots, `capture-held-${width}.png`));
      assert.deepEqual(errors.filter((e) => !/ERR_INCOMPLETE_CHUNKED_ENCODING/.test(e)), []);
      await ctx.close();
    }
    // Remembering one through the API is refused too, in words.
    const [e] = await m.get('/api/v1/capture/events');
    const r = await m.send('POST', '/api/v1/capture/promote', { event_ids: [e.id] });
    assert.equal(r.status, 409);
    assert.ok(JSON.stringify(r.body).includes('held, not kept'));
  } finally {
    await stop(nova);
    await sp.close();
    await b.close();
  }
});
