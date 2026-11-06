// Appearance settings are filled in place (surfaces.js drawAppearance). A refresh that changes
// nothing leaves every element where it was, so focus, hover and an open "More designs" survive
// it; a refresh that changes the appearance still redraws the design cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';

// Runs the page's own theme.refresh(), whose nova:appearance event redraws Appearance.
const refresh = (page: any) => page.evaluate(async () => {
  const url = '/js/theme.js';
  const theme = await import(url);
  await theme.refresh();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});
// Keeps every element in Appearance, to ask later which are still in the page.
const mark = (page: any) => page.evaluate(() => {
  const all = [...document.querySelectorAll('#appearance *')];
  (window as any).__marked = all.map((n) => ({ n, design: !!n.closest('#appearance-design') }));
  return { all: all.length, design: all.filter((n) => n.closest('#appearance-design')).length };
});
const replaced = (page: any) => page.evaluate(() => {
  const gone = (window as any).__marked.filter((m: any) => !m.n.isConnected);
  return { all: gone.length, design: gone.filter((m: any) => m.design).length };
});

test('Appearance: a refresh that changes nothing keeps every element; a real change redraws the cards', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-look-redraw-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280 });
    await page.goto(`${m.base}/settings#appearance`);
    await ready(page);
    await page.locator('#appearance-design .ds-card').first().waitFor();
    await refresh(page);

    // 1. Nothing changed: the same elements, all still in place.
    const marked = await mark(page);
    assert.ok(marked.design > 10, `design cards drawn (${marked.design} elements)`);
    const card = page.locator('#appearance-design .ds-card').first();
    await card.focus();
    await refresh(page);
    await refresh(page);
    assert.deepEqual(await replaced(page), { all: 0, design: 0 }, `no element replaced of ${marked.all}`);
    assert.equal(await page.evaluate(() => !!document.activeElement?.matches('#appearance-design .ds-card')), true, 'focus stays on the card');

    // 2. The appearance really changes (Paper for all devices, over the API): the cards say so.
    const applied = await m.send('POST', '/api/v1/design-systems/paper/apply', { scope: 'user' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    await page.locator('#appearance-design .ds-card[data-ds="paper"][aria-pressed="true"]').waitFor({ timeout: 5000 });
    await refresh(page);
    assert.match(await page.locator('#appearance-design .ds-card[data-ds="paper"]').innerText(), /All devices/);
    assert.ok((await replaced(page)).design > 0, 'the design cards were redrawn');
    assert.match(await page.locator('#appearance-scope').innerText(), /Paper/);
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
  }
});
