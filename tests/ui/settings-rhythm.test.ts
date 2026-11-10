// Settings' group titles read as headings, not rows (owner, 2026-11-10; verified defect at f3922203):
// a title is larger than the rows it heads and in the primary colour, and a group's title has more
// space above it than the rows inside a group have between them, on a desktop and a phone. The
// command palette's group titles take the same treatment. And the slim rail's version stamp is the
// short version, never a bare letter. With NOVA_UI_SHOTS set it also writes the PR's screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// The space above each non-first group's title, the gap between two rows in one group, and the sizes.
const rhythm = (page: Page) => page.evaluate(() => {
  const px = (v: string) => Number.parseFloat(v) || 0;
  const groups = [...document.querySelectorAll<HTMLElement>('#settings-nav .settings-group')].filter((g) => g.checkVisibility());
  const titles = groups.map((g) => g.querySelector<HTMLElement>('.settings-group-title')!);
  const rows = [...groups[0]!.querySelectorAll<HTMLElement>('.settings-cats > li')].filter((li) => li.checkVisibility());
  const rowGap = rows.length > 1 ? rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().bottom : 0;
  const above = titles.slice(1).map((t, i) => t.getBoundingClientRect().top - groups[i]!.getBoundingClientRect().bottom);
  const cat = groups[0]!.querySelector<HTMLElement>('.settings-cat')!;
  return {
    count: groups.length,
    above,
    rowGap,
    marginTop: titles.slice(1).map((t) => px(getComputedStyle(t).marginTop)),
    titleSize: px(getComputedStyle(titles[0]!).fontSize),
    rowSize: px(getComputedStyle(cat).fontSize),
    titleColor: getComputedStyle(titles[0]!).color,
    rowColor: getComputedStyle(cat).color,
    transform: getComputedStyle(titles[0]!).textTransform,
  };
});

test('Settings group titles are headings with real separation; the palette matches; the slim rail shows no bare letter', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-rhythm-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    assert.equal((await m.send('POST', '/api/v1/design-systems/nebula/apply', { scope: 'user' })).status, 200);
    for (const [name, size] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
      for (const scheme of ['dark', 'light'] as const) {
        const where = `${name} ${scheme}`;
        const d = await device(b, { ...size, scheme });
        await d.page.goto(`${m.base}/settings`);
        await ready(d.page);
        await d.page.waitForSelector('#settings-nav .settings-group-title');
        const r = await rhythm(d.page);
        assert.ok(r.count >= 2, `${where}: more than one group`);
        for (const [i, gap] of r.above.entries()) assert.ok(gap > r.rowGap + 8, `${where}: group ${i + 2}'s title has a group's worth of space above it (${gap}px), not a row's (${r.rowGap}px)`);
        for (const mt of r.marginTop) assert.ok(mt > r.rowGap, `${where}: a non-first title's top margin (${mt}px) is more than the rows' gap (${r.rowGap}px)`);
        assert.ok(r.titleSize > r.rowSize, `${where}: a title (${r.titleSize}px) is larger than its rows (${r.rowSize}px)`);
        assert.equal(r.titleColor, r.rowColor, `${where}: a title is in the primary colour, as the rows`);
        assert.equal(r.transform, 'none');
        if (shots) await shoot(d.page, join(shots, `settings-nav-${name}-nebula-${scheme}.png`));
        await d.ctx.close();
      }
    }
    // The command palette's group titles: the same treatment.
    const d = await device(b, { ...DESKTOP, scheme: 'dark' });
    await d.page.goto(`${m.base}/`);
    await ready(d.page);
    await d.page.keyboard.press('Control+k');
    const title = d.page.locator('.palette-group-title').first();
    if (await title.count()) {
      await title.waitFor({ state: 'attached' });
      const p = await d.page.evaluate(() => {
        const ts = [...document.querySelectorAll<HTMLElement>('.palette-group-title')];
        const px = (v: string) => Number.parseFloat(v) || 0;
        return { size: px(getComputedStyle(ts[0]!).fontSize), transform: getComputedStyle(ts[0]!).textTransform, second: ts[1] ? px(getComputedStyle(ts[1]).marginTop) : null };
      });
      assert.equal(p.transform, 'none', 'the palette title isn’t a caption in capitals');
      if (p.second !== null) assert.ok(p.second >= 24, `the palette's next group has a group's worth of space above (${p.second}px)`);
    }
    await d.page.keyboard.press('Escape');
    // The slim rail's stamp: the short version, never a lone letter.
    await d.page.evaluate(() => { document.body.dataset.rail = 'slim'; });
    const stamp = await d.page.locator('#rail .rail-stamp-v').textContent();
    assert.match(String(stamp), /^\d+\.\d+\.\d+$/, `the slim stamp is a version, not a letter: "${stamp}"`);
    if (shots) await shoot(d.page, join(shots, 'rail-slim-stamp-nebula-dark.png'));
    await d.ctx.close();
  } finally {
    await stop(nova);
  }
});
