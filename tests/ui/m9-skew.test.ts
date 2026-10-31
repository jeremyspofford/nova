// Review of #234, item 4: the waiting bands are timed by the page's own clock, from when the page
// first saw the wait (a send, a turn, a step), never from the server's timestamps. A device whose
// clock is minutes off from the hub's must still show nothing under 1 s and its indicator from 1 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { ROOT, stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { DESKTOP, seeded, settled } from './m9-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const thinking = (page: Page) => page.evaluate(() => [...document.querySelectorAll('#thread [data-waiting="reply"]')].map((e) => ({
  seen: Number(getComputedStyle(e).opacity) > 0.5,
  text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
})));

test('M9 gate, progress: the bands hold on a device whose clock is minutes off the hub’s', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-skew-', { NOVA_AGENT_CMD: `THINK_MS=3500 node ${join(ROOT, 'tests/ui/m9-thinker.js')}`, NOVA_AGENT_EGRESS: 'none' });
  try {
    for (const skew of [5 * 60_000, -5 * 60_000]) {
      const what = `the device ${skew > 0 ? 'ahead of' : 'behind'} the hub by 5 min`;
      const d = await device(b, DESKTOP);
      await d.ctx.addInitScript((off) => {
        const real = Date.now.bind(Date);
        const Real = Date;
        Date.now = () => real() + off;
        // new Date() too: the page's whole sense of now is off, as on a device with a wrong clock.
        (globalThis as any).Date = class extends Real { constructor(...a: any[]) { if (a.length) super(...(a as [])); else super(real() + off); } static override now() { return real() + off; } };
      }, skew);
      await d.page.goto(`${m.base}/chat`);
      await settled(d.page, 'chat').catch(() => {});
      await d.page.waitForSelector('html[data-ready]');
      await d.page.fill('#input', `A question, with ${what}`);
      await d.page.keyboard.press('Enter');
      await d.page.waitForFunction(() => document.querySelector('#thread [data-waiting="reply"]'), null, { timeout: 5000 });
      await sleep(300);
      let w = await thinking(d.page);
      assert.equal(w[0]?.seen, false, `${what}: under 1 s, no indicator`);
      await sleep(1500);
      w = await thinking(d.page);
      assert.equal(w[0]?.seen, true, `${what}: from 1 s, it shows`);
      assert.equal(w[0]?.text, 'Thinking…', `${what}: and says nothing of minutes gone by (${w[0]?.text})`);
      await d.page.waitForFunction(() => /the peas go first/.test(document.getElementById('thread')?.textContent ?? ''), null, { timeout: 15000 });
      assert.deepEqual(d.errors, [], `${what}: no errors in the page`);
      await d.ctx.close();
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
