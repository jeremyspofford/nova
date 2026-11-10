// M3 gate: the resize/posture sweep (DESIGN-SYSTEM §5). Every width, upright and in each emulated
// posture: the layout DESIGN-SYSTEM §5 names, no sideways scrolling, the same destinations
// reachable, and the orb present with no face. Then every destination is actually opened in each
// of the three layouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, shoot, device, finishSetup, ready, shotsDir } from './support.ts';

const WIDTHS = [320, 375, 600, 768, 1024, 1280, 1920];
const POSTURES = ['continuous', 'folded', 'half-open-vertical', 'half-open-horizontal'];
const ALL = ['activity', 'automations', 'chat', 'health', 'home', 'memory', 'settings', 'skills', 'tasks'];
// The orb's parts. Anything else inside it (eyes, a mouth, an image) would be a face.
const ORB_PARTS = ['orb-core', 'orb-glow', 'orb-sheen', 'orb-swirl'];

// The bands start where their regions fit (UX review 2026-10-31, F8/F9): the widths layout.css
// derives from the applied design system, as the page measures them.
function expected(width: number, posture: string, bands: { two: number; three: number }) {
  if (posture === 'folded') return 'phone';
  if (posture.startsWith('half-open')) return 'tablet';
  return width < bands.two ? 'phone' : width < bands.three ? 'tablet' : 'desktop';
}
const bandsOf = (page: Page) => page.evaluate(() => {
  const w = (b: string) => document.querySelector(`.band-probe[data-band="${b}"]`)!.getBoundingClientRect().width;
  return { two: w('two'), three: w('three') };
});

const visible = (page: Page, sel: string) => page.$$eval(sel, (els) => els.filter((e) => (e as HTMLElement).checkVisibility()).map((e) => (e as HTMLElement).dataset.dest!));

// The destinations a person can get to from here: what the rail shows (in its drawer on a phone).
async function reachable(page: Page): Promise<string[]> {
  const menu = page.locator('#nav-menu');
  const drawer = await menu.isVisible();
  if (drawer) { await menu.click(); await page.waitForSelector('.app.nav-open #rail .rail-foot', { state: 'visible' }); }
  const seen = new Set(await visible(page, '#rail [data-dest]'));
  if (drawer) await page.keyboard.press('Escape');
  return [...seen].sort();
}

// The live state: the orb before status icons part B, the status icon since (owner, 2026-11-08). The
// icon is Nova's mark, one inline SVG (UI item 24), drawn by status-icon.js with its state's treatment.
async function orbs(page: Page) {
  return page.$$eval('.orb, .status-icon[data-presence]', (els) => els.map((o) => ({
    icon: o.classList.contains('status-icon'),
    visible: (o as HTMLElement).checkVisibility(),
    parts: o.classList.contains('status-icon') ? [...o.children].map((c) => `${c.localName}${c.getAttribute('aria-hidden') === 'true' ? ':hidden' : ''}`) : [...o.querySelectorAll('*')].map((c) => c.className.toString()).sort(),
    media: o.querySelectorAll(o.classList.contains('status-icon') ? 'img, picture, video, canvas, image' : 'img, svg, picture, canvas').length,
  })));
}

test('M3 gate: posture sweep — layout, no overflow, the same destinations everywhere, a faceless orb', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-sweep-');
  const nova = await m.start();
  const shots = shotsDir();
  const rows: string[] = [];
  try {
    await finishSetup(m);
    for (const width of WIDTHS) {
      for (const posture of POSTURES) {
        const height = width < 600 ? 740 : 900;
        const d = await device(b, { width, height });
        const at = `${width}px ${posture}`;
        await d.page.goto(`${m.base}/?posture=${posture}`);
        await ready(d.page);
        const body = await d.page.evaluate(() => ({ layout: document.body.dataset.layout, posture: document.body.dataset.posture }));
        assert.equal(body.posture, posture, `${at}: posture`);
        const bands = await bandsOf(d.page);
        assert.equal(body.layout, expected(width, posture, bands), `${at}: layout (bands ${Math.round(bands.two)}/${Math.round(bands.three)})`);
        const overflow = await d.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${at}: ${overflow}px of sideways scrolling`);
        // Home draws its hero orb once its data arrives; on a busy machine that can trail "ready".
        await d.page.waitForFunction(() => [...document.querySelectorAll('.orb, .status-icon[data-presence]')].some((o) => (o as HTMLElement).checkVisibility()), null, { timeout: 5000 }).catch(() => {});
        const found = await orbs(d.page);
        assert.ok(found.some((o) => o.visible), `${at}: an orb is on screen`);
        for (const o of found) {
          assert.deepEqual(o.parts, o.icon ? ['svg:hidden'] : ORB_PARTS, `${at}: the orb has only its ${o.icon ? 'one SVG' : 'four layers'}, no features`);
          assert.equal(o.media, 0, `${at}: no image or drawing inside the orb`);
        }
        if (shots) await shoot(d.page, join(shots, `sweep-${width}-${posture}.png`));
        assert.deepEqual(await reachable(d.page), ALL, `${at}: every destination is reachable`);
        assert.deepEqual(d.errors, [], `${at}: no errors in the page`);
        rows.push(`${String(width).padStart(4)}px  ${posture.padEnd(21)} ${body.layout} (bands ${Math.round(bands.two)}/${Math.round(bands.three)})`);
        await d.ctx.close();
      }
    }
    console.log(`sweep: ${rows.length} combinations passed\n${rows.join('\n')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});

test('M3 gate: every destination opens in every layout', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-dest-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    for (const width of [375, 768, 1280]) {
      const d = await device(b, { width, height: 860 });
      await d.page.goto(`${m.base}/`);
      await ready(d.page);
      for (const dest of ALL) {
        // The drawer first: a closing drawer's rows stay visible for its transition.
        if (await d.page.locator('#nav-menu').isVisible()) await d.page.click('#nav-menu');
        await d.page.locator(`#rail [data-dest="${dest}"]`).click();
        await d.page.waitForFunction((want) => document.querySelector(`[data-dest="${want}"][aria-current="page"]`) !== null, dest);
        const path = new URL(d.page.url()).pathname;
        assert.equal(path, dest === 'home' ? '/' : `/${dest}`, `${width}px: ${dest} opened`);
        const title = (await d.page.textContent('#title'))?.trim() ?? '';
        assert.ok(title.length > 0 || dest === 'home', `${width}px: ${dest} has a title`);
      }
      assert.equal(await d.page.evaluate(() => performance.getEntriesByType('navigation').length), 1, `${width}px: moving around never reloads the page`);
      assert.deepEqual(d.errors, [], `${width}px: no errors in the page`);
      await d.ctx.close();
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
