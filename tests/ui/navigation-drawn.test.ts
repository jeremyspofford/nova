// The navigation crawl's step (navigation-support.ts press, then drawn) must not return into a
// conversation whose entrance hasn't begun. app.js renderAll draws a conversation whole under
// no-anim and enables its fade from opacity 0 on the next frame; a crawl read on that fade's first
// frame saw no links in the thread (#356's phone failure: the /schedules link "missing"). Here that
// frame is held for 300 ms, so the window is open every time, not by chance. press() also waits for
// the tap's route to change first: until it does, the page it left still reads as ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, snap, until } from './support.ts';
import { drawn, press, trackDocument } from './navigation-support.ts';
import { DESTINATIONS, placement } from '../../ui/js/nav.js';

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
    await press(page, { button: '#nav-menu', label: 'Navigation' }, true);
    await press(page, { href: '/c/2026-11-02-nav001', label: 'Navigation example', section: 'rail' }, true);
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
      if (what === 'phone') {
        // No conversations yet: no Recent group at all, not an empty heading. Then six of them.
        assert.equal(await page.locator('#rail-recent, #nav-all').count(), 0, 'no conversations, no Recent');
        for (let i = 1; i <= 6; i++) {
          const id = `2026-11-0${i}-rec00${i}`;
          writeFileSync(join(m.home, 'sessions', `${id}.jsonl`), JSON.stringify({ ts: `2026-11-0${i}T12:00:00Z`, type: 'session', id, title: `Recent example ${i}`, v: 1 }) + '\n');
        }
        // The app reads the list again when it comes back into view (no reload: the router keeps the document).
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await until(page, () => document.querySelectorAll('#toc a[data-id]').length === 6);
      }
      assert.equal(await page.locator('#tabs').count(), 0, `${what}: no bottom tabs`);
      const menu = page.locator('#nav-menu');
      assert.ok(await menu.isVisible(), `${what}: the menu button is in the title bar`);
      assert.equal(await menu.evaluate((e) => !!e.closest('.topbar')), true);
      assert.deepEqual([await menu.getAttribute('aria-controls'), await menu.getAttribute('aria-expanded')], ['rail', 'false']);
      assert.equal(await page.locator('#rail a[href]').filter({ visible: true }).count(), 0, `${what}: closed, nothing in it is on screen`);
      const box = (await menu.boundingBox())!;
      assert.ok(snap(box.width) >= 44 && snap(box.height) >= 44, `${what}: the menu button is a 44 px target`);

      // Open: every place is a row in it, focus moves in, the page behind is inert.
      await menu.tap();
      await until(page, () => document.querySelector('#nav-menu')?.getAttribute('aria-expanded') === 'true' && !!document.activeElement?.closest('#rail'));
      assert.deepEqual(await page.locator('#rail [data-dest]').filter({ visible: true }).evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.dest)), places, `${what}: every place, in order`);
      assert.equal(await page.locator('#more-btn').count(), 0, `${what}: nothing hidden under More`);
      assert.ok(await page.locator('#rail-search').isVisible() && await page.locator('#nav-close').isVisible(), `${what}: search and close`);
      assert.equal(await page.evaluate(() => document.getElementById('main')!.inert), true, `${what}: the page behind is inert`);
      for (const r of await page.locator('#rail a[href], #rail button').filter({ visible: true }).evaluateAll((es) => es.map((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })))) assert.ok(snap(r.w) >= 44 && snap(r.h) >= 44, `${what}: a 44 px target (${JSON.stringify(r)})`);
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

      // Recent (owner decision 2026-11-08, option B): the newest four conversations under Places, and
      // All conversations; one menu button in the title bar, no separate conversations button.
      await menu.tap();
      assert.ok(await page.locator('#rail-recent').isVisible(), `${what}: a Recent group`);
      const recent = page.locator('#rail .rail-recent a[href]');
      assert.deepEqual(await recent.evaluateAll((es) => es.map((e) => e.textContent)), [6, 5, 4, 3].map((i) => `Recent example ${i}`), `${what}: the newest four, newest first`);
      await press(page, { href: '/c/2026-11-05-rec005', label: 'Recent example 5', section: 'rail' }, true);
      assert.equal(await page.evaluate(() => document.body.dataset.view), 'chat');
      assert.equal(await page.locator('.app.nav-open').count(), 0, `${what}: opening a conversation closes it`);
      assert.equal(await page.locator('#rail a[href="/c/2026-11-05-rec005"]').getAttribute('aria-current'), 'page', `${what}: the open conversation is marked`);
      assert.equal(await page.locator('#rail [aria-current="page"]').count(), 1, `${what}: one current page, not Chat as well`);
      // Focus on a Recent row survives the drawer redrawing (a new badge, a renamed conversation).
      await menu.tap();
      await page.locator('#rail a[href="/c/2026-11-04-rec004"]').focus();
      await page.evaluate(() => import(String('/js/shell.js')).then((s) => s.setBadge('tasks', { tone: 'attention', label: 'test' })));
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), '/c/2026-11-04-rec004', `${what}: focus kept on the Recent row`);
      await page.keyboard.press('Escape');
      await until(page, () => !document.querySelector('.app.nav-open'));
      assert.equal(await page.locator('#menu').isVisible(), false, `${what}: no separate conversations button`);
      // All conversations: the conversations drawer, with every one; closing it gives focus back to the menu button.
      await menu.tap();
      await page.locator('#nav-all').tap();
      await until(page, () => !!document.querySelector('.app.drawer-open') && !document.querySelector('.app.nav-open') && !!document.activeElement?.closest('#sidebar'));
      assert.equal(await page.locator('#toc a[data-id]').filter({ visible: true }).count(), 6, `${what}: every conversation is reachable`);
      await page.locator('#drawer-close').tap();
      await until(page, () => document.activeElement?.id === 'nav-menu' && !document.querySelector('.app.drawer-open'));
      // New conversation, beside search.
      await menu.tap();
      await page.locator('#nav-new').tap();
      await until(page, () => location.pathname === '/new' && !document.querySelector('.app.nav-open'));
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

// No overflow navigation (owner ruling 2026-11-08, ui-references/nova-ui-no-more-overflow-ruling):
// at every rail width each destination is its own link in the rail, a short window scrolls the
// rail's list instead of hiding places, moving between places never opens a floating panel, and
// Health's badge is on Health itself.
test('the rail holds every destination, scrolls when short, opens no popover, and Health wears its own badge', { timeout: 180_000 }, async () => {
  const b = await browser();
  assert.notEqual(typeof b, 'string', 'needs a real browser');
  if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-nav-no-more-');
  const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    // A synthetic Health problem: a backup to a folder that went away.
    const target = join(m.dir, 'backups');
    mkdirSync(target);
    assert.equal((await m.send('PUT', '/api/v1/backups/settings', { target })).status, 200);
    rmSync(target, { recursive: true });
    const run = (await m.send('POST', '/api/v1/backups')).body.id;
    for (let i = 0; i < 100 && !['done', 'failed'].includes((await m.get(`/api/v1/tasks/${run}`)).state); i++) await new Promise((r) => setTimeout(r, 100));
    const places = DESTINATIONS.filter((d) => !d.parent).map((d) => d.id);
    for (const [w, h] of [[1440, 900], [1024, 768], [832, 750], [1024, 600], [1280, 600]] as const) {
      const what = `${w}×${h}`;
      const d = await device(b, { width: w, height: h, serviceWorkers: 'block' });
      const page = d.page;
      trackDocument(page);
      await page.goto(`${m.base}/memory`);
      await drawn(page);
      assert.notEqual(await page.evaluate(() => document.body.dataset.layout), 'phone', `${what}: a rail layout`);
      assert.equal(await page.locator('#more, #more-btn').count(), 0, `${what}: no More`);
      assert.equal(await page.locator('#rail .rail-list [aria-haspopup]').count(), 0, `${what}: no place opens a menu`);
      // Every place a link of its own, with an accessible name, reachable inside the rail's box.
      const rail = (await page.locator('#rail').boundingBox())!;
      assert.ok(rail.y >= 0 && rail.y + rail.height <= h + 1, `${what}: the rail fits the window (${JSON.stringify(rail)})`);
      for (const id of places) {
        const link = page.locator(`#rail a[data-dest="${id}"]`);
        assert.equal(await link.count(), 1, `${what}: ${id} has one link in the rail`);
        await link.scrollIntoViewIfNeeded();
        assert.ok(await link.isVisible(), `${what}: ${id} is visible`);
        const name = await link.evaluate((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? '');
        assert.ok(name.length > 0, `${what}: ${id} has a name`);
        const r = (await link.boundingBox())!;
        assert.ok(r.y >= rail.y - 1 && r.y + r.height <= rail.y + rail.height + 1, `${what}: ${id} lies inside the rail, not past it`);
      }
      // Health's problem shows on the Health link in its tone: the toned dot, beside the count where the rail is open (ruling item 3).
      const health = page.locator('#rail a[data-dest="health"]');
      const mark = health.locator('.nav-badge[data-tone]').filter({ visible: true });
      await mark.first().waitFor();
      // Its name says the severity in words (F-075): needs-you for attention, Nova stopped for alert.
      const tone = (await mark.first().getAttribute('data-tone')) ?? '';
      assert.match(tone, /^(alert|attention)$/, `${what}: the dot carries the problem's tone`);
      const said = (await health.getAttribute('aria-label')) ?? '';
      assert.match(said, tone === 'alert' ? /^Health, \d+ problems?, Nova is stopped$/ : /^Health, (1 problem, it needs you|\d+ problems, they need you)$/, `${what}: Health says it has a problem, and how serious (${tone})`);
      const [hb, bb] = [(await health.boundingBox())!, (await mark.first().boundingBox())!];
      assert.notEqual(await mark.first().evaluate((e) => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', `${what}: the dot is painted`);
      assert.ok(bb.width > 0 && bb.x >= hb.x && bb.x + bb.width <= hb.x + hb.width && bb.y >= hb.y && bb.y + bb.height <= hb.y + hb.height, `${what}: the badge sits on the Health row`);
      // Moving between places never opens a floating panel over the page.
      for (const id of places) {
        const link = page.locator(`#rail a[data-dest="${id}"]`); // click() scrolls the rail to it
        await link.click();
        await until(page, (want) => document.querySelector(`#rail a[data-dest="${want}"]`)?.getAttribute('aria-current') === 'page', id);
        const open = await page.evaluate(() => [...document.querySelectorAll('dialog[open], [role="dialog"], [role="menu"], [popover]')].filter((e) => (e as HTMLElement).checkVisibility() && (e.tagName !== 'DIALOG' || (e as HTMLDialogElement).open) && !(e as HTMLElement).hidden).map((e) => e.id || e.className));
        assert.deepEqual(open, [], `${what}: going to ${id} opens no popover`);
      }
      assert.deepEqual(d.errors, [], `${what}: no errors`);
      await d.ctx.close();
    }
  } finally { await b.close(); await stop(nova); }
});
