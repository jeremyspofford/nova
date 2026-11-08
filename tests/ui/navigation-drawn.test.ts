// The navigation crawl's step (navigation-support.ts press, then drawn) must not return into a
// conversation whose entrance hasn't begun. app.js renderAll draws a conversation whole under
// no-anim and enables its fade from opacity 0 on the next frame; a crawl read on that fade's first
// frame saw no links in the thread (#356's phone failure: the /schedules link "missing"). Here that
// frame is held for 300 ms, so the window is open every time, not by chance. press() also waits for
// the tap's route to change first: until it does, the page it left still reads as ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, until } from './support.ts';
import { drawn, press, trackDocument } from './navigation-support.ts';
import { placement } from '../../ui/js/nav.js';

test('press() waits for the route, then drawn() waits out a conversation’s held entrance before anything is read', { timeout: 120_000 }, async () => {
  const b = await browser();
  assert.notEqual(typeof b, 'string', 'needs a real browser');
  if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-drawn-');
  const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    writeFileSync(join(m.home, 'sessions', '2026-11-02-nav001.jsonl'), [
      { ts: '2026-11-02T12:00:00Z', type: 'session', id: '2026-11-02-nav001', title: 'Navigation example', v: 1 },
      { ts: '2026-11-02T12:01:00Z', type: 'handoff', id: 'navigation-report', name: 'Navigation schedule', schedule: 'navigation-example', text: 'A synthetic completed report.', ok: true },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const d = await device(b, { width: 390, height: 900, touch: true, serviceWorkers: 'block' });
    const page = d.page;
    trackDocument(page);
    await d.ctx.addInitScript(() => {
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => (String(cb).includes("el.thread.classList.remove('no-anim')") ? (setTimeout(() => original.call(window, cb), 300), -1) : original.call(window, cb));
    });
    await page.goto(`${m.base}/`);
    await drawn(page);
    await press(page, { button: '#nav-menu', label: 'Navigation' }, true);
    await press(page, { href: '/chat', label: 'Chat', section: '' }, true);
    await press(page, { button: '#menu', label: 'Conversations' }, true);
    await press(page, { href: '/c/2026-11-02-nav001', label: 'Navigation example', section: '' }, true);
    const at = await page.evaluate(() => {
      const t = document.getElementById('thread')!;
      const a = document.querySelector<HTMLElement>('a[href="/schedules#sc-navigation-example"]');
      return { noAnim: t.classList.contains('no-anim'), opacity: getComputedStyle(t).opacity, link: !!a?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) };
    });
    assert.deepEqual(at, { noAnim: false, opacity: '1', link: true }, 'drawn() returned after the entrance ran, with the thread’s links readable');
  } finally { await b.close(); await stop(nova); }
});

// A phone's and a cover screen's navigation (owner decision 2026-11-08): the title bar's menu button
// opens the rail as a drawer holding every place. A modal while open: focus moves in and stays in,
// the page behind is inert, and Esc, the scrim and the close button shut it, focus back on the menu
// button. Choosing a place, or search, closes it. No bottom tabs.
test('the navigation drawer: every place, focus in and back, Esc, scrim and close', { timeout: 120_000 }, async () => {
  const b = await browser();
  assert.notEqual(typeof b, 'string', 'needs a real browser');
  if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-nav-drawer-');
  const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    const p = placement('phone');
    const places = [...p.primary, ...p.foot];
    for (const [what, vp, q] of [['phone', { width: 390, height: 844 }, ''], ['cover screen', { width: 412, height: 960 }, '?posture=folded']] as const) {
      const d = await device(b, { ...vp, touch: true, serviceWorkers: 'block' });
      const page = d.page;
      trackDocument(page);
      await page.goto(`${m.base}/${q}`);
      await drawn(page);
      assert.equal(await page.evaluate(() => document.body.dataset.layout), 'phone', `${what}: the phone layout`);
      assert.equal(await page.locator('#tabs').count(), 0, `${what}: no bottom tabs`);
      const menu = page.locator('#nav-menu');
      assert.ok(await menu.isVisible(), `${what}: the menu button is in the title bar`);
      assert.equal(await menu.evaluate((e) => !!e.closest('.topbar')), true);
      assert.deepEqual([await menu.getAttribute('aria-controls'), await menu.getAttribute('aria-expanded')], ['rail', 'false']);
      assert.equal(await page.locator('#rail a[href]').filter({ visible: true }).count(), 0, `${what}: closed, nothing in it is on screen`);
      const box = (await menu.boundingBox())!;
      assert.ok(box.width >= 44 && box.height >= 44, `${what}: the menu button is a 44 px target`);

      // Open: every place is a row in it, focus moves in, the page behind is inert.
      await menu.tap();
      await until(page, () => document.querySelector('#nav-menu')?.getAttribute('aria-expanded') === 'true' && !!document.activeElement?.closest('#rail'));
      assert.deepEqual(await page.locator('#rail [data-dest]').filter({ visible: true }).evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.dest)), places, `${what}: every place, in order`);
      assert.equal(await page.locator('#more-btn').count(), 0, `${what}: nothing hidden under More`);
      assert.ok(await page.locator('#rail-search').isVisible() && await page.locator('#nav-close').isVisible(), `${what}: search and close`);
      assert.equal(await page.evaluate(() => document.getElementById('main')!.inert), true, `${what}: the page behind is inert`);
      for (const r of await page.locator('#rail a[href], #rail button').filter({ visible: true }).evaluateAll((es) => es.map((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })))) assert.ok(r.w >= 44 && r.h >= 44, `${what}: a 44 px target (${JSON.stringify(r)})`);
      // Focus stays inside: Tab and Shift Tab wrap at its ends.
      for (let i = 0; i < places.length + 4; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#rail')), true, `${what}: Tab stays in the drawer`);
      }
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#rail')), true, `${what}: Shift Tab stays in the drawer`);

      // Esc closes it, and focus goes back to the menu button.
      await page.keyboard.press('Escape');
      await until(page, () => document.activeElement?.id === 'nav-menu' && !document.querySelector('.app.nav-open'));
      assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.getElementById('main')!.inert), false, `${what}: the page is back`);
      // The scrim (a tap outside it) and the close button do the same.
      await menu.tap();
      await page.waitForSelector('.app.nav-open #nav-close', { state: 'visible' });
      await page.mouse.click(vp.width - 10, vp.height / 2);
      await until(page, () => document.activeElement?.id === 'nav-menu' && !document.querySelector('.app.nav-open'));
      await menu.tap();
      await page.locator('#nav-close').tap();
      await until(page, () => document.activeElement?.id === 'nav-menu' && !document.querySelector('.app.nav-open'));
      // Search closes it and opens the palette; the palette gives focus back to the menu button.
      await menu.tap();
      await page.locator('#rail-search').tap();
      await until(page, () => document.querySelector<HTMLDialogElement>('#palette')?.open && !document.querySelector('.app.nav-open'));
      await page.keyboard.press('Escape');
      await until(page, () => document.activeElement?.id === 'nav-menu');
      // A place chosen goes there and closes it.
      await menu.tap();
      await press(page, { href: '/tasks', label: 'Tasks', section: 'rail' }, true);
      assert.equal(await page.evaluate(() => document.body.dataset.view), 'tasks');
      assert.equal(await page.locator('.app.nav-open').count(), 0, `${what}: choosing a place closes it`);
      assert.equal(await page.locator('#rail [data-dest="tasks"]').getAttribute('aria-current'), 'page');
      assert.deepEqual(d.errors, [], `${what}: no errors`);
      await d.ctx.close();
    }
  } finally { await b.close(); await stop(nova); }
});

test('until() awaits an async check, as page.waitForFunction does not', { timeout: 60_000 }, async () => {
  const b = await browser();
  if (typeof b === 'string') throw new Error(b);
  try {
    const d = await device(b, {});
    await d.page.setContent('<p>x</p>');
    // The trap this replaces: a Promise is truthy, so an async predicate that says false "passes".
    assert.ok(await d.page.waitForFunction(async () => false, null, { timeout: 2000 }), 'waitForFunction resolves on an async false');
    await assert.rejects(until(d.page, async () => false, undefined, { timeout: 400 }), /Timed out after 400 ms/);
    const t0 = Date.now();
    await d.page.evaluate(() => { setTimeout(() => { (window as unknown as { done: boolean }).done = true; }, 300); });
    assert.equal(await until(d.page, async () => (window as unknown as { done?: boolean }).done === true), true);
    assert.ok(Date.now() - t0 >= 250, 'it waited for the check to come true');
  } finally { await b.close(); }
});
