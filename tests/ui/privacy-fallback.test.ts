// Settings › Privacy names a privacy mode only once the profile has answered (V-3). surfaces.js
// privacy() reads Local only for an unread profile: the strict default for what Nova may do, not a
// fact to show. #518 (V-1) kept the composer's chip from saying it; on main the Privacy section still
// drew its choices from it, so with /profile slow or down, Settings showed "Local-only" checked and
// "Model calls stay on your own devices." to a person whose mode was Local first. Now, until the
// profile is known, no choice is checked, the choices wait disabled, the note says the setting is on
// its way (or couldn't be read, with a retry), and the chat routing note waits too. Once known, the
// section is as before. The real server underneath; only the browser's profile reads are held or
// cut. Chromium and WebKit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, webkitBrowser } from './support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIDE = { width: 1280, height: 820, serviceWorkers: 'block' as const };
// The profile reads: GET /profile and GET /identity (surfaces.js load, part 'profile').
const PROFILE = /\/api\/v1\/(profile|identity)(\?|$)/;
// What Local only says when it is the mode: its description, and its choice checked.
const LOCAL_ONLY_NOTE = /Model calls stay on your own devices/;

const said = (page: Page) => page.evaluate(() => {
  const s = document.querySelector('#settings-privacy #privacy')!;
  return {
    checked: [...s.querySelectorAll<HTMLInputElement>('input[name="privacy"]:checked')].map((i) => i.value),
    disabled: (s.querySelector('fieldset') as HTMLFieldSetElement).disabled,
    text: (s as HTMLElement).innerText,
    unknown: s.querySelector('[data-privacy-unknown]')?.getAttribute('data-privacy-unknown') ?? null,
  };
});

async function unknownMode(b: Browser, base: string, engine: string) {
  // (a) The profile on its way: held 6 s, everything else at speed.
  {
    const d = await device(b, WIDE);
    await d.ctx.route(PROFILE, async (r) => { await sleep(6000); await r.fallback().catch(() => {}); });
    await d.page.goto(`${base}/settings#privacy`, { waitUntil: 'commit' });
    await d.page.waitForSelector('#settings-privacy #privacy input[name="privacy"]', { state: 'attached', timeout: 15000 });
    const waiting = await said(d.page);
    assert.deepEqual(waiting.checked, [], `${engine}: no mode is checked before the profile is in (${JSON.stringify(waiting)})`);
    assert.doesNotMatch(waiting.text, LOCAL_ONLY_NOTE, `${engine}: the section claims no mode it hasn't read:\n${waiting.text}`);
    assert.equal(waiting.unknown, 'pending', `${engine}: it says the setting is on its way`);
    assert.equal(waiting.disabled, true, `${engine}: the choices wait`);
    const tree = await d.page.locator('#settings-privacy').ariaSnapshot();
    assert.doesNotMatch(tree, /radio[^\n]*\[checked\]/, `${engine}: assistive tech hears no checked mode:\n${tree}`);
    // Then the profile answers: Local first, checked, with its own words, as before.
    await d.page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-privacy input[name="privacy"]:checked')?.value === 'local-preferred', null, { timeout: 30000 });
    const after = await said(d.page);
    assert.equal(after.disabled, false, `${engine}: the choices are open once the mode is known`);
    assert.equal(after.unknown, null);
    assert.match(after.text, /runs on your devices first/, `${engine}: Local first's own note`);
    assert.deepEqual(d.errors, [], `${engine}: no page errors`);
    await d.ctx.close();
  }
  // (b) The profile down: it couldn't be read, says so, still claims nothing, and Try again reads it.
  {
    const d = await device(b, WIDE);
    await d.ctx.route(PROFILE, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"held by the test"}' }));
    await d.page.goto(`${base}/settings#privacy`);
    await d.page.waitForSelector('#settings-privacy [data-privacy-unknown="failed"]', { timeout: 30000 });
    const failed = await said(d.page);
    assert.deepEqual(failed.checked, [], `${engine}: no mode is checked when the profile couldn't be read`);
    assert.doesNotMatch(failed.text, LOCAL_ONLY_NOTE, `${engine}: the section claims no mode it couldn't read:\n${failed.text}`);
    assert.match(failed.text, /can’t say what it is/);
    await d.ctx.unroute(PROFILE);
    await d.page.locator('#settings-privacy [data-action="retry-privacy"]').click();
    await d.page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-privacy input[name="privacy"]:checked')?.value === 'local-preferred', null, { timeout: 30000 });
    await d.ctx.close();
  }
}

test('V-3: Settings › Privacy names no mode until the profile has answered, then the true one', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-privacy-fallback-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    // Local first: under the Local only default the fallback would be the truth and hide the claim.
    assert.equal((await m.send('PUT', '/api/v1/profile/privacy/default', { value: 'local-preferred', confirm: true })).status, 200);
    await unknownMode(b, m.base, 'chromium');
    const w = await webkitBrowser();
    if (typeof w !== 'string') { try { await unknownMode(w, m.base, 'webkit'); } finally { await w.close(); } } else t.diagnostic(`webkit skipped: ${w}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
