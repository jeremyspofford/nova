// Settings › Connections › Site sign-ins (M10b) in a real browser, against the real server: save a
// sign-in for the stand-in shop from the PWA (never chat), see it listed without its value, forget
// it through a sheet that is confirmed every time, and it is gone from the vault. Neutral
// placeholders and per-test fake credentials only. The takeover sheet's Pause and Stop are drawn
// for a live browser task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';
import { fakeLogin, startShop } from './m10b-support.ts';

test('M10b: a site sign-in saved and forgotten in Settings › Connections › Site sign-ins', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const shop = await startShop();
  const m = blank('nova-ui-m10b-settings-');
  const nova = await m.start();
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm10b') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const cred = fakeLogin();
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#connections`);
    await ready(page);
    const section = page.locator('#browser-sites');
    await section.locator('.memory-lede').waitFor();
    assert.match((await section.textContent()) ?? '', /hasn’t kept anything for a site yet/);
    await section.locator('details summary').click();
    await section.locator('input[name="site"]').fill(shop.host);
    await section.locator('input[name="username"]').fill(cred.username);
    await section.locator('input[name="password"]').fill(cred.password);
    assert.equal(await section.locator('input[name="password"]').getAttribute('type'), 'password');
    await section.locator('.site-login button[type="submit"]').click();
    const row = section.locator(`.conn[data-site="${shop.host}"]`);
    await row.waitFor();
    assert.match((await row.textContent()) ?? '', /Sign-in saved[\s\S]*A sign-in is saved/);
    assert.ok(!((await section.textContent()) ?? '').includes(cred.password), 'its value is never shown');
    assert.equal(await section.locator('input[name="password"]').inputValue(), '', 'the form is cleared');
    if (shots) { await section.evaluate((el) => el.scrollIntoView({ block: 'start' })); await shoot(page, join(shots, 'site-sign-ins.png')); }

    await row.locator('[data-action="forget-site"]').click();
    const sheet = page.locator('#sheet .site-forget');
    await sheet.waitFor();
    assert.match((await sheet.textContent()) ?? '', /deletes the cookies and storage[\s\S]*can’t be undone[\s\S]*Also delete its saved sign-in/);
    if (shots) await shoot(page, join(shots, 'site-forget.png'));
    await sheet.locator('button[type="submit"]').click();
    await page.waitForFunction((h) => !document.querySelector(`.conn[data-site="${h}"]`), shop.host);
    const sites = await m.get('/api/v1/browser/sites');
    assert.deepEqual(sites.sites, [], 'nothing kept, and no sign-in in the vault');
    assert.deepEqual(errors, []);
  } finally {
    await stop(nova);
    await shop.close();
    await b.close();
  }
});
