// The 44 px hit-target check (shortTargets in support.ts) reads heights at the browser's own layout
// precision, 1/64 px. A box that layout made exactly 44 px tall passes even where
// getBoundingClientRect reports it a hair short (here: under a fractional translate, as an entrance
// animation leaves it; #347 caught 43.99993896 in CI with offsetHeight 44). A box that is really
// short, even by 0.02 px, still fails. Chromium and WebKit; a static page, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { browser, webkitBrowser, shortTargets } from './support.ts';

const PAGE = `<!doctype html><body style="margin:0">
<div style="height:100px"></div>
<div id="t" style="translate: 0 0.1507px">
  <button id="exact" style="all:unset;display:block;box-sizing:border-box;height:44px;width:120px">exact</button>
  <button id="short-half" style="all:unset;display:block;box-sizing:border-box;height:43.5px;width:120px">43.5</button>
  <button id="short-hair" style="all:unset;display:block;box-sizing:border-box;height:43.98px;width:120px">43.98</button>
  <button id="tall" style="all:unset;display:block;box-sizing:border-box;height:48px;width:120px">48</button>
</div></body>`;

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`hit targets ${engine}: a 44 px box at a fractional position passes; 43.5 px and 43.98 px fail`, async (t) => {
    const b = await launch();
    if (typeof b === 'string') return t.skip(b);
    try {
      const page = await (b as Browser).newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(PAGE);
      const raw = await page.evaluate(() => document.getElementById('exact')!.getBoundingClientRect().height);
      assert.ok(raw < 44, `this page reproduces the float error: the 44 px box reads ${raw}`);
      assert.equal(await page.evaluate(() => (document.getElementById('exact') as HTMLElement).offsetHeight), 44, 'layout made it 44 px');
      const short = await shortTargets(page, '#t button');
      assert.deepEqual(short.map((h) => /id="([^"]+)"/.exec(h)?.[1]), ['short-half', 'short-hair'], 'only the boxes that are really short');
      await page.close();
    } finally { await (b as Browser).close(); }
  });
}
