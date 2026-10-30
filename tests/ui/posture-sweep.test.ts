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

function expected(width: number, posture: string) {
  if (posture === 'folded') return 'phone';
  if (posture.startsWith('half-open')) return 'tablet';
  return width < 600 ? 'phone' : width < 1024 ? 'tablet' : 'desktop';
}

const visible = (page: Page, sel: string) => page.$$eval(sel, (els) => els.filter((e) => (e as HTMLElement).checkVisibility()).map((e) => (e as HTMLElement).dataset.dest!));

// The destinations a person can get to from here: what the rail or tabs show, plus More.
async function reachable(page: Page): Promise<string[]> {
  const seen = new Set(await visible(page, '#rail [data-dest], #tabs [data-dest]'));
  const more = page.locator('#more-btn');
  if (await more.isVisible()) {
    await more.click();
    for (const d of await visible(page, '#more [data-dest]')) seen.add(d);
    await page.keyboard.press('Escape');
  }
  return [...seen].sort();
}

async function orbs(page: Page) {
  return page.$$eval('.orb', (els) => els.map((o) => ({
    visible: (o as HTMLElement).checkVisibility(),
    parts: [...o.querySelectorAll('*')].map((c) => c.className.toString()).sort(),
    media: o.querySelectorAll('img, svg, picture, canvas').length,
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
        assert.equal(body.layout, expected(width, posture), `${at}: layout`);
        const overflow = await d.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${at}: ${overflow}px of sideways scrolling`);
        const found = await orbs(d.page);
        assert.ok(found.some((o) => o.visible), `${at}: an orb is on screen`);
        for (const o of found) {
          assert.deepEqual(o.parts, ORB_PARTS, `${at}: the orb has only its four layers, no features`);
          assert.equal(o.media, 0, `${at}: no image or drawing inside the orb`);
        }
        if (shots) await shoot(d.page, join(shots, `sweep-${width}-${posture}.png`));
        assert.deepEqual(await reachable(d.page), ALL, `${at}: every destination is reachable`);
        assert.deepEqual(d.errors, [], `${at}: no errors in the page`);
        rows.push(`${String(width).padStart(4)}px  ${posture.padEnd(21)} ${body.layout}`);
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
        const direct = d.page.locator(`#rail [data-dest="${dest}"], #tabs [data-dest="${dest}"]`).filter({ visible: true });
        if (await direct.count()) await direct.first().click();
        else {
          await d.page.click('#more-btn');
          await d.page.locator(`#more [data-dest="${dest}"]`).click();
        }
        await d.page.waitForFunction((want) => document.querySelector(`[data-dest="${want}"][aria-current="page"]`) !== null || (want !== 'home' && document.querySelector('#more-btn[data-current]') !== null), dest);
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
