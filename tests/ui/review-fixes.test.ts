import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, browser, device, finishSetup, ready } from './support.ts';
import { stop } from '../acceptance/support.ts';

for (const width of [375, 768, 1280]) {
  test(`review fixes: honest health and paged history at ${width}px`, async (t) => {
    const b = await browser();
    if (typeof b === 'string') return t.skip(b);
    const m = blank('nova-review-ui-');
    const running = await m.start();
    try {
      await finishSetup(m, { passkeys: false });
      for (let i = 0; i < 105; i++) {
        const id = `2026-11-05-${i.toString(36).padStart(6, '0')}`;
        writeFileSync(join(m.home, 'sessions', `${id}.jsonl`), JSON.stringify({ type: 'session', id, title: `Review history ${i}`, ts: '2026-11-05T12:00:00Z' }) + '\n');
      }
      const { page, errors } = await device(b, { width, height: 820 });
      await page.goto(m.base + '/health');
      await ready(page);
      await page.getByText('Not checked', { exact: true }).first().waitFor();
      assert.ok((await page.locator('body').innerText()).includes('Not checked'));
      assert.ok(!(await page.locator('body').innerText()).includes('All systems normal'));
      await page.goto(m.base + '/chat');
      await ready(page);
      await page.getByRole('button', { name: 'Conversations', exact: true }).click();
      await page.locator('[data-more-conversations]').waitFor();
      assert.equal(await page.locator('#toc a[data-id]').count(), 100);
      await page.locator('[data-more-conversations]').click();
      await page.waitForFunction(() => document.querySelectorAll('#toc a[data-id]').length === 105);
      assert.equal(await page.locator('[data-more-conversations]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await b.close(); await stop(running); }
  });
}
