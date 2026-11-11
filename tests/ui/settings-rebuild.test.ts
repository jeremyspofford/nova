// UI rebuild: Settings, built to the approved composition (docs/plans/ui-rebuild-compositions-
// 2026-11-06.md §2, sg-compositions.js settingsPane). The search sits at the head of the category
// list and "/" reaches it; while searching only the categories with a match are listed, each with
// its count, and the matches are marked in the detail; on a phone Settings is two screens, the list
// and then a category with a back row; every setting in the IA is reachable, in exactly one place.
// With NOVA_UI_SHOTS set it also writes the PR's screenshots (Nebula, light and dark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shortTargets, shotsDir, snap } from './support.ts';
import { CATEGORIES, ENTRIES, filterSettings } from '../../ui/js/settings-ia.js';

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 1024, height: 768 };
const PHONE = { width: 390, height: 844 };
const DUO = { width: 380, height: 900 };

const listed = (page: Page) => page.$$eval('#settings-nav .settings-cats > li', (lis) => lis.filter((li) => (li as HTMLElement).checkVisibility()).map((li) => ({ cat: (li as HTMLElement).dataset.cat!, count: (li.querySelector('.cat-count') as HTMLElement).checkVisibility() ? Number.parseInt(li.querySelector('.cat-count')!.textContent!, 10) : null })));
const settled = (page: Page) => page.waitForFunction(() => document.querySelector('#settings-you .settings-row') && document.querySelector('#settings-privacy input[name="privacy"]'));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.getElementById('scroller')!.scrollWidth > document.getElementById('scroller')!.clientWidth);

test('Settings: search at the head with "/", a filtered list with counts and marks, two screens on a phone, every setting reachable', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-settings-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    const r = await m.send('POST', '/api/v1/design-systems/nebula/apply', { scope: 'user' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // ---- a wide screen: the list beside the detail ------------------------------------------------
    for (const scheme of ['dark', 'light'] as const) {
      const where = `1440×900 ${scheme}`;
      const d = await device(b, { ...DESKTOP, scheme });
      await d.page.goto(`${m.base}/settings#privacy`);
      await ready(d.page);
      await settled(d.page);
      const side = await d.page.locator('.settings-side').boundingBox();
      const detail = await d.page.locator('.settings-detail').boundingBox();
      assert.ok(side && detail && side.x + side.width <= detail.x, `${where}: the list beside the detail`);
      assert.ok(await d.page.locator('#settings-search').isVisible(), `${where}: the search is there`);
      const search = await d.page.locator('.settings-search').boundingBox();
      const firstCat = await d.page.locator('#settings-nav .settings-cat').first().boundingBox();
      assert.ok(search && firstCat && search.y < firstCat.y && search.x < side!.x + side!.width, `${where}: the search heads the category list`);
      assert.equal(await d.page.locator('#settings-back').isVisible(), false, `${where}: no back row beside the list`);
      assert.equal(await d.page.locator('.settings-pane:not([hidden]) .settings-pane-title').textContent(), 'Privacy and permissions');
      assert.deepEqual(await shortTargets(d.page, '#settings-view a, #settings-view button, #settings-view input, #settings-view select', { visible: true, label: true }), [], `${where}: every control at least 44 px`);
      // No card around a part: rows on hairlines.
      assert.equal(await d.page.locator('#settings-privacy > section').evaluate((e) => getComputedStyle(e).borderTopWidth), '0px', `${where}: no card`);
      assert.equal(await d.page.locator('#settings-privacy .choices').evaluate((e) => getComputedStyle(e).flexDirection), 'column', `${where}: a mode is radio rows`);
      if (shots) await shoot(d.page, join(shots, `desktop-1440x900-privacy-nebula-${scheme}.png`));

      // "/" from anywhere in Settings puts focus in the search.
      await d.page.locator('.settings-pane:not([hidden]) .settings-pane-title').click();
      await d.page.keyboard.press('/');
      assert.equal(await d.page.evaluate(() => document.activeElement?.id), 'settings-search', `${where}: "/" focuses the search`);
      assert.equal(await d.page.inputValue('#settings-search'), '', `${where}: and types nothing`);

      // Searching filters the list, with counts, and marks the matches in the detail.
      await d.page.keyboard.type('cloud');
      const want = filterSettings('cloud');
      assert.ok(want.cats.length >= 1 && want.cats.length < CATEGORIES.length);
      await d.page.waitForFunction((n) => document.querySelectorAll('#settings-nav .settings-cats > li:not([hidden])').length === n, want.cats.length);
      assert.deepEqual(await listed(d.page), want.cats.map((c) => ({ cat: c.id, count: c.count })), `${where}: only categories with a match, each with its count`);
      assert.match((await d.page.locator('#settings-count').textContent()) ?? '', /^\d+ settings? match “cloud”, in \d+ categor(y|ies)\. Only categories with a match are listed\.$/);
      assert.equal(await d.page.locator('#settings-count').getAttribute('role'), 'status');
      const open = await d.page.locator('.settings-pane:not([hidden])').getAttribute('data-cat');
      assert.ok(want.cats.some((c) => c.id === open), `${where}: the open category has a match (${open})`);
      const marks = d.page.locator('.settings-pane:not([hidden]) mark.settings-mark');
      assert.ok((await marks.count()) >= 1, `${where}: matches are marked in the detail`);
      assert.ok((await marks.allTextContents()).some((s) => /cloud/i.test(s)), `${where}: the word searched for is what is marked`);
      if (shots) await shoot(d.page, join(shots, `desktop-1440x900-search-cloud-nebula-${scheme}.png`));
      // A match found by a word people use, not its label, has its name marked.
      await d.page.fill('#settings-search', 'dark mode');
      await d.page.waitForFunction(() => document.querySelector('.settings-pane:not([hidden])')?.getAttribute('data-cat') === 'appearance');
      await d.page.waitForSelector('#appearance-mode[data-match]');
      // Enter opens the best match, focused, and keeps the search.
      await d.page.press('#settings-search', 'Enter');
      await d.page.waitForFunction(() => document.getElementById('appearance-mode')?.contains(document.activeElement));
      assert.equal(await d.page.inputValue('#settings-search'), 'dark mode');
      // Nothing found: said plainly; the list empties; clearing brings everything back.
      await d.page.fill('#settings-search', 'zzqx');
      assert.deepEqual(await listed(d.page), []);
      assert.match((await d.page.locator('#settings-count').textContent()) ?? '', /^Nothing matches “zzqx”/);
      await d.page.locator('#settings-clear').click();
      assert.equal((await listed(d.page)).length, CATEGORIES.length, `${where}: the whole list again`);
      assert.equal(await d.page.locator('mark.settings-mark').count(), 0, `${where}: no marks left`);
      assert.equal(await d.page.evaluate(() => document.activeElement?.id), 'settings-search');
      assert.equal(await sideways(d.page), false);
      assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
      await d.ctx.close();
    }

    // ---- every setting is reachable, in exactly one place ------------------------------------------
    {
      const d = await device(b, DESKTOP);
      await d.page.goto(`${m.base}/settings`);
      await ready(d.page);
      await settled(d.page);
      assert.equal(await d.page.locator('.settings-pane').count(), CATEGORIES.length);
      for (const c of CATEGORIES) {
        assert.equal(await d.page.locator(`#settings-nav .settings-cat[data-cat="${c.id}"]`).count(), 1, `${c.id}: one link`);
        for (const k of c.parts) assert.equal(await d.page.locator(`.settings-pane[data-cat="${c.id}"] > #settings-${k}`).count(), 1, `${c.id}: holds ${k}`);
      }
      for (const e of ENTRIES) {
        const where = await d.page.evaluate((id) => [...document.querySelectorAll(`[id="${id}"]`)].map((n) => n.closest('.settings-pane')?.getAttribute('data-cat') ?? null), e.target);
        assert.deepEqual(where, [e.cat], `${e.label}: #${e.target} is in ${e.cat}, once`);
      }
      for (const c of CATEGORIES) {
        await d.page.locator(`#settings-nav .settings-cat[data-cat="${c.id}"]`).click();
        await d.page.waitForFunction((id) => !(document.querySelector(`.settings-pane[data-cat="${id}"]`) as HTMLElement).hidden, c.id);
        assert.equal(await d.page.locator('#settings-nav [aria-current="page"]').getAttribute('data-cat'), c.id);
        assert.equal(new URL(d.page.url()).hash, `#${c.id}`);
      }
      assert.deepEqual(d.errors, []);
      await d.ctx.close();
    }

    // ---- a tablet --------------------------------------------------------------------------------
    for (const scheme of ['dark', 'light'] as const) {
      const d = await device(b, { ...TABLET, scheme });
      await d.page.goto(`${m.base}/settings#appearance`);
      await ready(d.page);
      await settled(d.page);
      await d.page.locator('#appearance').waitFor();
      assert.equal(await sideways(d.page), false, `1024×768 ${scheme}: nothing sideways`);
      if (shots) await shoot(d.page, join(shots, `tablet-1024x768-appearance-nebula-${scheme}.png`));
      assert.deepEqual(d.errors, []);
      await d.ctx.close();
    }

    // ---- a phone and a Duo's cover: two screens ---------------------------------------------------
    for (const [name, vp] of [['phone-390x844', PHONE], ['duo-cover-380x900', DUO]] as const) {
      for (const scheme of ['dark', 'light'] as const) {
        const where = `${name} ${scheme}`;
        const d = await device(b, { ...vp, scheme, touch: true });
        await d.page.goto(`${m.base}/settings`);
        await ready(d.page);
        await settled(d.page);
        const side = d.page.locator('.settings-side');
        assert.ok(await side.isVisible(), `${where}: the list screen first`);
        assert.equal(await d.page.locator('.settings-pane:not([hidden])').count(), 0, `${where}: no category open`);
        assert.ok(await d.page.locator('#settings-search').isVisible(), `${where}: the search heads the list`);
        assert.deepEqual(await shortTargets(d.page, '#settings-view a, #settings-view button, #settings-view input', { visible: true, label: true }), [], `${where}: 44 px targets`);
        assert.equal(await sideways(d.page), false, `${where}: nothing sideways`);
        if (shots) await shoot(d.page, join(shots, `${name}-list-nebula-${scheme}.png`));
        await d.page.locator('#settings-nav .settings-cat[data-cat="privacy"]').click();
        await d.page.locator('#privacy').waitFor();
        assert.equal(await side.isVisible(), false, `${where}: the category replaces the list`);
        const back = d.page.locator('#settings-back');
        assert.ok(await back.isVisible(), `${where}: with a back row`);
        const row = await back.boundingBox();
        const title = await d.page.locator('.settings-pane:not([hidden]) .settings-pane-title').boundingBox();
        assert.ok(row && title && row.y < title.y && snap(row.height) >= 44, `${where}: the back row above the category's name`);
        assert.equal(await sideways(d.page), false, `${where}: nothing sideways in the detail`);
        if (shots) await shoot(d.page, join(shots, `${name}-privacy-nebula-${scheme}.png`));
        await back.click();
        await side.waitFor();
        assert.equal(await d.page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.cat), 'privacy', `${where}: back to the list, on the category it came from`);
        // "/" on the category screen goes back to the list, to the search.
        await d.page.locator('#settings-nav .settings-cat[data-cat="appearance"]').click();
        await d.page.locator('#appearance').waitFor();
        await d.page.locator('.settings-pane:not([hidden]) .settings-pane-title').click();
        await d.page.keyboard.press('/');
        assert.equal(await d.page.evaluate(() => document.activeElement?.id), 'settings-search', `${where}: "/" from a category`);
        await d.page.keyboard.type('backup');
        const want = filterSettings('backup');
        await d.page.waitForFunction((n) => document.querySelectorAll('#settings-nav .settings-cats > li:not([hidden])').length === n, want.cats.length);
        assert.equal(await d.page.locator('.settings-pane:not([hidden])').count(), 0, `${where}: searching stays on the list`);
        await d.page.locator(`#settings-nav .settings-cat[data-cat="${want.cats[0]!.id}"]`).click();
        assert.ok((await d.page.locator('.settings-pane:not([hidden]) mark.settings-mark').count()) >= 1, `${where}: the category it opens has its matches marked`);
        assert.deepEqual(d.errors, [], `${where}: no errors`);
        await d.ctx.close();
      }
    }
  } finally {
    await stop(nova);
    await b.close();
  }
});
