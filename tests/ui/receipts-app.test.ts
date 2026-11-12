// The Receipts screen (F-028), in Chromium against the real server: a chat program declared remote,
// Local first, one message sent; then Settings › Privacy leads to Receipts, which lists the real
// receipt of that turn as the owner's composition draws it (where it went, why, what it was told by
// reference), filters it, opens it, and says what receipts cover. On a phone, one pane at a time.
// No model is called: the chat program is the project's fake agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { ROOT, blank, browser, composerShown, device, finishSetup, ready, shortTargets, watchCsp } from './support.ts';

test('Receipts: from Settings › Privacy, the real receipt of a cloud chat turn, filtered, opened, and what receipts cover', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-receipts-');
  const nova = await m.start({ NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'remote' });
  try {
    await finishSetup(m);
    assert.equal((await m.send('PUT', '/api/v1/profile/privacy/default', { value: 'local-preferred', confirm: true })).status, 200);
    const { page, errors } = await device(b, { width: 1440, height: 900, serviceWorkers: 'block' });
    const csp = await watchCsp(page);
    await page.goto(`${m.base}/chat`);
    await ready(page);
    await composerShown(page);
    await page.fill('#input', 'hello');
    await page.keyboard.press('Enter');
    const receipts = await until<any[]>(() => m.get('/api/v1/receipts?egress=remote'), (x) => Array.isArray(x) && x.length > 0);
    assert.ok(receipts.length > 0, 'the chat turn was receipted');
    const r = receipts[0];

    // The door: Settings › Privacy.
    await page.goto(`${m.base}/settings#privacy`);
    await ready(page);
    await page.locator('#privacy a[href="/receipts"]').click();
    await page.waitForFunction(() => document.body.dataset.view === 'receipts');
    const screen = page.locator('#receipts-view [data-rc-frame="app"]');
    await screen.locator('.rc-item').first().waitFor();
    const list = screen.locator('[data-rc-list]');
    assert.match(await list.innerText(), /A message in a conversation/);
    assert.match(await list.innerText(), new RegExp(`Sent to ${r.egress.slice('remote:'.length)}`));
    assert.equal(await list.locator('.rc-item').count(), (await m.get('/api/v1/receipts')).length, 'every receipt the hub has');
    // The newest is open beside the list, with every field the composition shows.
    const detail = screen.locator('.rc-detail');
    assert.ok(await list.isVisible() && await detail.isVisible(), 'both panes, side by side, on a desktop');
    // textContent: group labels are uppercased by CSS, and innerText would return them so.
    const said = (await detail.textContent()) ?? '';
    for (const w of ['Where it went', 'Provider', 'Model', 'Why, as recorded', 'Privacy setting for this call', 'Opt-in', 'Receipt', 'What it was told, by reference', 'Not in a receipt']) assert.ok(said.includes(w), w);
    assert.match(said, /Local first/);

    // The filters: what left, under Local first.
    await list.locator('[data-rc-filter="where"]').selectOption('left');
    assert.equal(await list.locator('.rc-item:not([hidden])').count(), receipts.length);
    await list.locator('[data-rc-filter="mode"]').selectOption('local-only');
    assert.equal(await list.locator('.rc-item:not([hidden])').count(), 0);
    assert.equal(await list.locator('[data-rc-none]').innerText(), 'No receipt matches these filters.');

    // One receipt by its address, and what receipts cover. The filters stay as set while the screen
    // is open, so they are put back first.
    await list.locator('[data-rc-filter="where"]').selectOption('all');
    await list.locator('[data-rc-filter="mode"]').selectOption('all');
    await page.goto(`${m.base}/receipts#${r.id}`);
    await ready(page);
    await page.locator(`#receipts-view .rc-open[aria-current="true"][href="/receipts#${r.id}"]`).waitFor();
    assert.match(await page.locator('#receipts-view .rc-detail').innerText(), new RegExp(r.id));
    await page.locator('#receipts-view a[href="/receipts#coverage"]').first().click();
    await page.locator('#receipts-view .rc-cov').first().waitFor();
    assert.match(await page.locator('#receipts-view .rc-detail').innerText(), /Receipts record model calls and calls to connected services, not everything Nova sends\./);
    assert.deepEqual(await shortTargets(page, '#receipts-view :is(a, select, button)', { visible: true }), [], '44 px targets');

    // A phone: one pane at a time, the list first.
    const phone = await device(b, { width: 390, height: 844, touch: true, serviceWorkers: 'block' });
    await phone.page.goto(`${m.base}/receipts`);
    await ready(phone.page);
    await phone.page.locator('#receipts-view .rc-item').first().waitFor();
    const shown = await phone.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#receipts-view .rc-list, #receipts-view .rc-detail')].filter((p) => p.checkVisibility()).map((p) => p.className));
    assert.deepEqual(shown, ['rc-list'], 'one pane on a phone');
    assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');

    assert.deepEqual(await csp(), [], 'no Content-Security-Policy violation');
    assert.deepEqual(errors, []);
    assert.deepEqual(phone.errors, []);
  } finally {
    await b.close();
    await stop(nova);
  }
});
