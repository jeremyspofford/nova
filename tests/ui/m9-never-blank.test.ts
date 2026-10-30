// Review of #234: the shell is hidden until the app has set the layout and drawn its first view (no
// layout shift at start), so it must never stay hidden. A hub that never answers, or something that
// throws while the page starts, still gives a page within about a second; a hub that never answers
// is then said to be out of reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { DESKTOP, seeded } from './m9-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shown = (page: import('playwright-core').Page) => page.evaluate(() => getComputedStyle(document.querySelector('.shell')!).visibility);

test('M9 gate: the page is never left blank — a silent hub or a failure at start still shows the page, and says so', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-blank-');
  try {
    // A hub that takes every request and never answers.
    const d = await device(b, { ...DESKTOP, serviceWorkers: 'block' });
    await d.page.route('**/api/**', () => { /* never answered */ });
    await d.page.goto(`${m.base}/`, { waitUntil: 'commit' });
    await sleep(1500);
    assert.equal(await shown(d.page), 'visible', 'the page shows within a second or so');
    await d.page.waitForFunction(() => /isn’t answering/.test(document.getElementById('banner')?.textContent ?? ''), null, { timeout: 20000 });
    assert.match(await d.page.locator('#banner').innerText(), /Nova’s server isn’t answering/, 'and says the server isn’t answering');
    await d.ctx.close();

    // Something throws while the page starts.
    const e = await device(b, DESKTOP);
    await e.ctx.addInitScript(() => { (window as any).EventSource = function broken() { throw new Error('no streams here'); }; });
    await e.page.goto(`${m.base}/`, { waitUntil: 'commit' });
    await sleep(1500);
    assert.equal(await shown(e.page), 'visible', 'a failure at start still shows the page');
    await e.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});
