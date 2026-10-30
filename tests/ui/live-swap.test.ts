// M3 gate: the design system swaps live, with no reload and no restart. Then a preview in its
// sandboxed frame, a change for this device only, and a rollback of each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, shoot, cssVar, device, finishSetup, ready, shotsDir } from './support.ts';

test('M3 gate: a design system swaps live, previews in a frame, applies per device and rolls back', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-swap-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    const bg = async (id: string) => String((await m.get(`/api/v1/design-systems/${id}`)).manifest.tokens['bg/base']).toLowerCase();
    const [teal, light, paper] = [await bg('orb-teal'), await bg('companion-light'), await bg('paper')];
    assert.equal(new Set([teal, light, paper]).size, 3, 'three distinct backgrounds to tell them apart');

    const one = await device(b, { width: 1280 });
    const other = await device(b, { width: 1280 });
    for (const d of [one, other]) {
      await d.page.goto(`${m.base}/`);
      await ready(d.page);
    }
    const page = one.page;
    await page.evaluate(() => { (window as any).__boot = 'first-load'; });
    assert.equal(await cssVar(page, '--bg-base'), teal, 'Orb Teal shows on a fresh profile');
    if (shots) await shoot(page, join(shots, 'swap-1-orb-teal.png'));

    // 1. Applied for everyone over the API: both open pages change without reloading.
    const pid = nova.proc.pid;
    const applied = await m.send('POST', '/api/v1/design-systems/companion-light/apply', { scope: 'user' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    for (const d of [one, other]) {
      await d.page.waitForFunction((want) => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().toLowerCase() === want, light, { timeout: 5000 });
    }
    assert.equal(await page.evaluate(() => (window as any).__boot), 'first-load', 'no reload: the page kept its state');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1);
    assert.equal(nova.proc.pid, pid);
    assert.equal(nova.proc.exitCode, null, 'no restart: the same server process is still serving');
    assert.equal((await m.get('/api/v1/health')).ok, true);
    if (shots) await shoot(page, join(shots, 'swap-2-companion-light.png'));

    // 2. Preview another in the sandboxed frame: the frame shows it, the page does not change.
    await page.goto(`${m.base}/settings`);
    await ready(page);
    await page.evaluate(() => { (window as any).__boot = 'settings'; });
    await page.click('[data-action="preview-ds"][data-ds="paper"]');
    const frame = page.frameLocator('#ds-preview');
    await frame.locator('body').waitFor();
    const framed = await frame.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--bg-base').trim().toLowerCase());
    assert.equal(framed, paper, 'the preview frame shows Paper');
    assert.equal(await page.locator('#ds-preview').getAttribute('sandbox'), '', 'the frame is sandboxed with no allowances');
    assert.equal(await cssVar(page, '--bg-base'), light, 'previewing applies nothing');
    if (shots) await page.locator('#ds-preview').scrollIntoViewIfNeeded().then(() => shoot(page, join(shots, 'swap-3-preview-paper.png')));

    // 3. Use it on this device only: this page changes, the other device keeps the person's choice.
    await page.click('[data-action="apply-ds"][data-scope="device"][data-ds="paper"]');
    await page.waitForFunction((want) => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().toLowerCase() === want, paper, { timeout: 5000 });
    await other.page.waitForTimeout(300);
    assert.equal(await cssVar(other.page, '--bg-base'), light, 'another device is untouched');
    assert.equal(await page.evaluate(() => (window as any).__boot), 'settings');
    if (shots) await shoot(page, join(shots, 'swap-4-paper-this-device.png'));

    // 4. Roll back this device: back to the person's choice.
    await page.locator('[data-action="rollback-ds"][data-scope="device"]:not([disabled])').click();
    await page.waitForFunction((want) => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().toLowerCase() === want, light, { timeout: 5000 });

    // 5. Roll back for everyone: both pages return to Orb Teal, still with no reload.
    await page.locator('[data-action="rollback-ds"][data-scope="user"]:not([disabled])').click();
    for (const d of [one, other]) {
      await d.page.waitForFunction((want) => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().toLowerCase() === want, teal, { timeout: 5000 });
    }
    assert.equal(await page.evaluate(() => (window as any).__boot), 'settings');
    assert.equal(nova.proc.exitCode, null);
    assert.deepEqual([...one.errors, ...other.errors], [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
  }
});
