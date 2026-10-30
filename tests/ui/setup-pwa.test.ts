// M3 gate: a blank profile's setup completed from the PWA alone, by clicking and typing, in each
// layout. A real server on a blank home; nothing goes over the API except to check the result.
// It ends on the welcome task, Verified, with its evidence open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, shoot, device, ready, shotsDir } from './support.ts';

const ANSWERS = ['Hi! I’m Alex.', 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'yes'];

for (const [layout, width] of [['phone', 375], ['tablet', 768], ['desktop', 1280]] as const) {
  test(`M3 gate: blank-profile setup from the PWA alone (${layout}, ${width}px)`, async (t) => {
    const b = await browser();
    if (typeof b === 'string') return t.skip(b);
    const m = blank(`nova-ui-setup-${layout}-`);
    const nova = await m.start();
    const shots = shotsDir();
    try {
      assert.equal((await m.get('/api/v1/health')).setup.done, false, 'a blank profile');
      const { page, errors } = await device(b, { width, height: 860 });
      await page.goto(`${m.base}/`);
      await ready(page);
      await page.locator('#setup').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.body.dataset.layout), layout);
      // Full screen, with the app behind it out of reach.
      const box = await page.locator('#setup').boundingBox();
      assert.ok(box && box.width >= width - 1 && box.x <= 1, 'setup takes the whole width');
      assert.equal(await page.evaluate(() => (document.getElementById('app') as HTMLElement).inert), true);
      if (shots) await shoot(page, join(shots, `setup-${layout}-1-start.png`));

      for (const text of ANSWERS) {
        const before = await page.locator('#setup-log .chat-bubble').count();
        await page.fill('#setup-input', text);
        await page.keyboard.press('Enter');
        await page.waitForFunction((n) => document.querySelectorAll('#setup-log .chat-bubble').length >= n + 2, before, { timeout: 5000 });
      }

      // Done: the welcome task shows as Verified, and its evidence opens.
      const verified = page.locator('#setup .verified-result-card [data-status="verified"]');
      await verified.waitFor({ timeout: 15000 });
      if (shots) await shoot(page, join(shots, `setup-${layout}-2-verified.png`));
      await verified.click();
      const sheet = page.locator('#sheet');
      await sheet.waitFor({ state: 'visible' });
      const evidence = (await sheet.textContent()) ?? '';
      assert.match(evidence, /Read back/, 'the evidence names what Nova read back');
      assert.ok(await sheet.locator('.check[data-ok="true"]').count() > 0, 'with its passed checks');
      if (shots) await shoot(page, join(shots, `setup-${layout}-3-evidence.png`));
      await page.keyboard.press('Escape');

      await page.click('[data-action="setup-continue"]');
      await page.locator('#setup').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => (document.getElementById('app') as HTMLElement).inert), false, 'the app is usable');

      // What the clicks and typing wrote, read back from the core.
      const health = await m.get('/api/v1/health');
      assert.equal(health.setup.done, true);
      const profile = await m.get('/api/v1/profile');
      assert.equal(profile.user.name, 'Alex');
      assert.equal(profile.privacy.default, 'local-only');
      const tasks = await m.get('/api/v1/tasks');
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].state, 'done');
      assert.equal(tasks[0].verification.ok, true);
      assert.equal(readFileSync(m.egress, 'utf8'), '', 'local-only: nothing tried to leave the machine');
      assert.deepEqual(errors, [], 'no errors in the page');
    } finally {
      await b.close();
      await stop(nova);
    }
  });
}
