// The command palette (ui/js/palette.js; the UI rebuild's approved composition, 2026-11-06): Ctrl K
// opens it from anywhere, it searches real things (places, conversations, Settings' categories,
// actions), the arrow keys and Enter go through the app's own router (one document request for the
// whole test), Esc gives focus back, and it is a real modal: focus stays in it and the page behind
// it is inert. 44 px rows, no sideways overflow at a phone's 390 px or a desktop's 1440 px, full
// width at the top of a phone, and axe finds nothing in it. The rail's search button opens it (a
// click, and Enter), and the rail's foot stamps the running build's short commit. Chromium and WebKit.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, webkitBrowser, device, ready, shortTargets, shotsDir, still, until } from './support.ts';
import { CHAT2, seeded } from './m9-support.ts';
import { assertRetainedDocument, trackDocument } from './navigation-support.ts';
import { withMesh } from './fold-support.ts';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let server: Awaited<ReturnType<typeof seeded>> | null = null;
// The build the server says it runs (GET /api/v1/version), so the rail's stamp has a commit to show.
const COMMIT = 'b66f2c5e0d1a2b3c4d5e6f708192a3b4c5d6e7f8';
before(async () => { server = await seeded('nova-palette-', { NOVA_BUILD_COMMIT: COMMIT }); });
after(async () => { if (server) { await stop(server.nova); rmSync(server.m.dir, { recursive: true, force: true }); } });

const isOpen = (page: Page) => page.evaluate(() => !!document.querySelector<HTMLDialogElement>('#palette')?.open);
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');
// Each row's name as a screen reader gets it: its text, less what is hidden from it (the icon, the keys).
const labels = (page: Page) => page.$$eval('#palette [role="option"]', (rows) => rows.map((r) => {
  const copy = r.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? '').trim();
}));

async function open(page: Page) {
  await page.keyboard.press('Control+k');
  await until(page, () => document.querySelector<HTMLDialogElement>('#palette')?.open && document.activeElement?.id === 'palette-input');
  await still(page);
}

async function search(page: Page, text: string) {
  await page.fill('#palette-input', text);
  await until(page, (t) => (document.querySelector<HTMLInputElement>('#palette-input')?.value ?? '') === t, text);
}

// No sideways scroll on the page, and the box and its rows sit inside the window.
const overflow = (page: Page) => page.evaluate(() => {
  const box = document.querySelector('#palette')!.getBoundingClientRect();
  const list = document.querySelector<HTMLElement>('#palette-list')!;
  return { page: document.documentElement.scrollWidth - innerWidth, left: box.left, right: innerWidth - box.right, list: list.scrollWidth - list.clientWidth };
});

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`command palette ${engine}: Ctrl K, search, keys, the router, focus and the modal`, async (t) => {
    const b = await launch();
    if (typeof b === 'string') { t.skip(b); return; }
    t.after(() => (b as Browser).close());
    const { m } = server!;

    // ---- desktop, 1440 × 900 ----
    const d = await device(b as Browser, { width: 1440, height: 900, serviceWorkers: 'block' });
    await withMesh(d.ctx);
    const page = d.page;
    trackDocument(page);
    await page.goto(`${m.base}/`);
    await ready(page);
    await page.waitForSelector('#palette', { state: 'attached' });
    await page.focus('#scroller');
    assert.equal(await focused(page), 'scroller');

    // Opens with Ctrl K, as a modal, with focus in the field.
    await open(page);
    const shape = await page.evaluate(() => {
      const dlg = document.querySelector<HTMLDialogElement>('#palette')!;
      const input = document.querySelector('#palette-input')!;
      return {
        modal: dlg.matches(':modal'), ariaModal: dlg.getAttribute('aria-modal'), name: dlg.getAttribute('aria-label'),
        role: input.getAttribute('role'), controls: input.getAttribute('aria-controls'), listbox: document.getElementById(input.getAttribute('aria-controls') ?? '')?.getAttribute('role'),
        active: input.getAttribute('aria-activedescendant'), first: document.querySelector('#palette [role="option"]')?.id,
        groups: [...document.querySelectorAll('#palette .palette-group-title')].map((g) => g.textContent),
      };
    });
    assert.deepEqual(shape, { modal: true, ariaModal: 'true', name: 'Search Nova', role: 'combobox', controls: 'palette-list', listbox: 'listbox', active: 'palette-opt-0', first: 'palette-opt-0', groups: ['Go to', 'Conversations', 'Settings', 'Actions'] });
    const all = await labels(page);
    assert.ok(all.every((l) => l.trim().length > 0), 'every row is labelled');
    for (const want of ['Home, Go to', 'Tasks, Go to', 'Machines and services, Settings', 'Appearance, Settings', 'New conversation']) assert.ok(all.includes(want), `${want} is offered: ${all.join(' | ')}`);
    assert.ok(all.some((l) => l.startsWith('The kitchen shelf, ')), 'a real conversation is offered');
    assert.ok(!all.some((l) => /space/i.test(l)), 'no Spaces: Nova has none');

    // 44 px rows (and field), no sideways overflow at 1440.
    assert.deepEqual(await shortTargets(page, '#palette [role="option"], #palette-input', { visible: true }), []);
    const wide = await overflow(page);
    assert.ok(wide.page <= 0 && wide.left >= 0 && wide.right >= 0 && wide.list <= 0, `no horizontal overflow at 1440: ${JSON.stringify(wide)}`);

    // axe, on the open palette.
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const res = await (window as any).axe.run({ include: [['#palette']] });
      return res.violations.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => String(n.target?.[0] ?? '')).join(', ')}`);
    });
    assert.deepEqual(violations, [], 'axe finds nothing in the palette');

    // Focus is trapped, and the page behind is inert.
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(await focused(page), 'palette-input', `${key} stays in the palette`);
    }
    assert.equal(await page.evaluate(() => { document.getElementById('scroller')!.focus(); return document.activeElement?.id; }), 'palette-input', 'the page behind it cannot take focus');

    // The arrow keys move the selection (and wrap); the field keeps focus.
    const activeId = () => page.evaluate(() => document.querySelector('#palette-input')!.getAttribute('aria-activedescendant'));
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeId(), 'palette-opt-1');
    assert.equal(await page.getAttribute('#palette-opt-1', 'aria-selected'), 'true');
    assert.equal(await page.getAttribute('#palette-opt-0', 'aria-selected'), 'false');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await activeId(), `palette-opt-${all.length - 1}`, 'up from the first row wraps to the last');
    assert.equal(await focused(page), 'palette-input');

    // Esc closes it, and focus goes back where it was.
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector<HTMLDialogElement>('#palette')!.open);
    assert.equal(await focused(page), 'scroller', 'focus returns to where it was');
    assert.equal(await page.evaluate(() => location.pathname), '/', 'Esc went nowhere');

    // The rail's search button is the palette's touch door: a click opens it, and so does Enter.
    assert.equal(await page.evaluate(() => document.body.dataset.rail), 'open', 'the rail is open at 1440');
    const railSearch = page.locator('#rail-search');
    assert.equal(await railSearch.getAttribute('aria-label'), 'Search or go to');
    await railSearch.click();
    await until(page, () => document.querySelector<HTMLDialogElement>('#palette')?.open && document.activeElement?.id === 'palette-input');
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector<HTMLDialogElement>('#palette')!.open);
    await page.focus('#rail-search');
    await page.keyboard.press('Enter');
    await until(page, () => document.querySelector<HTMLDialogElement>('#palette')?.open && document.activeElement?.id === 'palette-input');
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector<HTMLDialogElement>('#palette')!.open);
    assert.equal(await focused(page), 'rail-search', 'Esc gives focus back to the search button');

    // The rail's foot stamps the running build: the API's own short commit.
    const build = await page.evaluate(() => fetch('/api/v1/version').then((r) => r.json()));
    assert.equal(build.commit_short, COMMIT.slice(0, 8));
    await page.waitForSelector('#rail .rail-stamp-commit', { state: 'visible' });
    assert.equal(await page.locator('#rail .rail-stamp-commit').textContent(), build.commit_short);

    // Filtering: a conversation by name, a setting by the words people use, and nothing at all.
    await open(page);
    await search(page, 'kitchen');
    assert.deepEqual(await labels(page), [(await labels(page)).find((l) => l.startsWith('The kitchen shelf, '))]);
    await search(page, 'dark mode');
    assert.ok((await labels(page)).includes('Appearance, Settings'), `“dark mode” finds Appearance: ${(await labels(page)).join(' | ')}`);
    await search(page, 'zzqxw');
    assert.deepEqual(await labels(page), []);
    assert.equal(await page.isVisible('.palette-empty'), true, 'says nothing matches');
    assert.equal(await page.getAttribute('#palette-input', 'aria-expanded'), 'false');
    await search(page, 'tas');
    assert.equal((await labels(page))[0], 'Tasks, Go to');

    // Enter on a conversation opens it through the router: same document.
    await search(page, 'kitchen');
    await page.keyboard.press('Enter');
    await until(page, (p) => location.pathname === p && document.body.dataset.view === 'chat' && !document.querySelector<HTMLDialogElement>('#palette')!.open, `/c/${CHAT2}`);
    await assertRetainedDocument(page);

    // Arrow then Enter on a settings category: Settings opens at it, same document.
    await open(page);
    await search(page, 'appearance');
    const rows = await labels(page);
    const at = rows.indexOf('Appearance, Settings');
    assert.ok(at >= 0, rows.join(' | '));
    for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await until(page, () => location.pathname === '/settings' && location.hash === '#appearance' && document.body.dataset.view === 'settings');
    await assertRetainedDocument(page);

    // A destination with the pointer: same document.
    await open(page);
    await search(page, 'memory');
    await page.locator('#palette [role="option"]').filter({ has: page.locator('.palette-label', { hasText: /^Memory$/ }) }).click();
    await until(page, () => location.pathname === '/memory' && document.body.dataset.view === 'memory');
    await assertRetainedDocument(page);
    assert.equal(d.errors.length, 0, d.errors.join('\n'));
    await d.ctx.close();

    // ---- phone, 390 × 844: full width, at the top ----
    const p = await device(b as Browser, { width: 390, height: 844, serviceWorkers: 'block' });
    await withMesh(p.ctx);
    trackDocument(p.page);
    await p.page.goto(`${m.base}/`);
    await ready(p.page);
    await p.page.waitForSelector('#palette', { state: 'attached' });
    assert.equal(await p.page.evaluate(() => document.body.dataset.layout), 'phone');
    await open(p.page);
    const box = await p.page.evaluate(() => { const r = document.querySelector('#palette')!.getBoundingClientRect(); return { top: r.top, width: r.width }; });
    assert.ok(box.top <= 16 && box.width >= 390 - 16, `full width at the top: ${JSON.stringify(box)}`);
    const narrow = await overflow(p.page);
    assert.ok(narrow.page <= 0 && narrow.left >= 0 && narrow.right >= 0 && narrow.list <= 0, `no horizontal overflow at 390: ${JSON.stringify(narrow)}`);
    assert.deepEqual(await shortTargets(p.page, '#palette [role="option"], #palette-input', { visible: true }), []);
    await p.page.keyboard.press('Escape');
    await until(p.page, () => !document.querySelector<HTMLDialogElement>('#palette')!.open);
    await assertRetainedDocument(p.page);
    assert.equal(p.errors.length, 0, p.errors.join('\n'));
    await p.ctx.close();

    // Evidence, when NOVA_UI_SHOTS names a folder: phone and desktop, light and dark.
    const out = shotsDir();
    if (out && engine === 'chromium') {
      for (const [size, vp] of [['phone-390x844', { width: 390, height: 844 }], ['desktop-1440x900', { width: 1440, height: 900 }]] as const) {
        for (const scheme of ['light', 'dark'] as const) {
          const s = await device(b as Browser, { ...vp, scheme, serviceWorkers: 'block' });
          await withMesh(s.ctx);
          await s.page.goto(`${m.base}/c/${CHAT2}`);
          await ready(s.page);
          await s.page.waitForSelector('#thread .turn');
          await open(s.page);
          await search(s.page, 'mod');
          await still(s.page);
          await s.page.screenshot({ path: join(out, `palette-${size}-${scheme}.png`), caret: 'hide' });
          await s.ctx.close();
        }
      }
    }
  });
}
