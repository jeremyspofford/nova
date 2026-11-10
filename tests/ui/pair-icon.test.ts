// /pair draws the status icon (ui/js/status-icon.js) where the orb was (owner, 2026-11-08). The page
// is what an unpaired device reaches, so here it is reached as one: over the mesh listener, with no
// session. The icon loads (it is on the public allowlist, on the owner's condition that it only
// draws: tests/public-status-icon.test.js), draws from the design system's tokens, and follows the
// page: idle on the form, needs-you on the digits, stopped on a wrong address. It is decorative;
// the heading and the live text keep saying the state.
// With NOVA_UI_SHOTS set it writes the PR's screenshots (Nebula dark, desktop and phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { freePort } from '../acceptance/m4c-support.ts';
import { blank, browser, device, finishSetup, shotsDir } from './support.ts';

function shots(): string | null {
  const m3 = shotsDir();
  if (!m3) return null;
  const dir = join(dirname(m3), 'pair-icon-2026-11-08');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const icon = (page: Page) => page.locator('#pair-icon .status-icon');
const statusIs = (page: Page, s: string) => page.waitForFunction((want) => (document.querySelector('#pair-icon .status-icon') as HTMLElement | null)?.dataset.status === want, s);

test('/pair: the status icon where the orb was, loaded before pairing, following the page’s state', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-pair-icon-');
  const mesh = `http://127.0.0.1:${await freePort()}`;
  const nova = await m.start({ NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  const dir = shots();
  try {
    await finishSetup(m);
    assert.equal((await m.send('POST', '/api/v1/design-systems/nebula/apply', { scope: 'user' })).status, 200);
    for (const [name, vp, touch] of [['desktop-1440x900', { width: 1440, height: 900 }, false], ['phone-390x844', { width: 390, height: 844 }, true]] as const) {
      const d = await device(b, { ...vp, scheme: 'dark', touch, serviceWorkers: 'block' });
      const refused: string[] = [];
      d.page.on('response', (r) => { if (r.status() >= 400) refused.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await d.page.goto(`${mesh}/pair`);
      await d.page.locator('#join').waitFor();

      // The icon, not the orb: drawn, at the hero size, decorative.
      await icon(d.page).waitFor();
      assert.equal(await d.page.locator('.orb').count(), 0, `${name}: no orb left on /pair`);
      assert.equal(await icon(d.page).count(), 1);
      await statusIs(d.page, 'idle');
      assert.equal(await icon(d.page).getAttribute('data-renderer'), 'svg', `${name}: it drew`);
      // The mark itself (UI item 24): an inline SVG on a transparent background, no picture in a box.
      const mark = await icon(d.page).evaluate((el) => ({ svg: el.querySelectorAll('svg path[data-ribbon]').length, raster: el.querySelectorAll('img, canvas, image').length, bg: getComputedStyle(el.querySelector('svg')!).backgroundColor }));
      assert.deepEqual(mark, { svg: 2, raster: 0, bg: 'rgba(0, 0, 0, 0)' }, `${name}: the SVG N, transparent`);
      assert.equal(await d.page.locator('img[data-nova-mark]').count(), 0, `${name}: no inline artwork left on the page`);
      assert.equal(Math.round((await icon(d.page).boundingBox())!.width), 112, `${name}: the app’s hero size`);
      assert.equal(await d.page.locator('#pair-icon').getAttribute('aria-hidden'), 'true', `${name}: decorative`);
      // Its colours come from the public design system: every token it reads is set here.
      const tokens = await d.page.evaluate(() => ['--mark-left-outer', '--mark-left-mid', '--mark-left-inner', '--mark-right-outer', '--mark-right-mid', '--mark-right-inner', '--orb-core', '--orb-attention', '--status-error', '--bg-base'].map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()]));
      for (const [n, v] of tokens) assert.ok(v, `${name}: ${n} is defined on the public page`);
      // The page's accessible names are as they were.
      assert.equal(await d.page.getByRole('heading', { level: 1 }).textContent(), 'Pair with Nova');
      assert.ok(await d.page.getByRole('textbox', { name: 'Code from your hub' }).isVisible());
      assert.ok(await d.page.getByRole('button', { name: 'Pair this device' }).isVisible());
      assert.deepEqual(refused, [], `${name}: everything /pair loads is public`);
      assert.deepEqual(d.errors, [], `${name}: no page errors`);
      if (dir) { await d.page.waitForTimeout(1200); await d.page.screenshot({ path: join(dir, `after-pair-${name}-nebula-dark.png`) }); }

      // The digits: needs-you.
      const code = (await m.send('POST', '/api/v1/mesh/pairings')).body.code as string;
      await d.page.fill('#code', code);
      await d.page.click('#join');
      await d.page.locator('.pair-digits').waitFor({ timeout: 15000 });
      await statusIs(d.page, 'needs-you');
      if (dir) { await d.page.waitForTimeout(1200); await d.page.screenshot({ path: join(dir, `after-pair-digits-${name}-nebula-dark.png`) }); }
      await d.ctx.close();
    }

    // A wrong address: stopped.
    const w = await device(b, { width: 390, height: 844, scheme: 'dark', touch: true, serviceWorkers: 'block' });
    await w.page.goto(`${mesh}/pair#c=ABCD-EFGH&h=AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH`);
    await w.page.getByRole('heading', { name: 'Wrong address' }).waitFor();
    await statusIs(w.page, 'stopped');
    await w.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});
