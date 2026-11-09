// The supernova N (owner direction 2026-11-08, single mark, step 1; /styleguide?entry=n-mark), in
// Chromium: the three constructions, A, B and C, side by side, each drawn at 240, 96, 48, 24 and
// 16 px on the near-black tile, as the 180 px app icon, and at 16 and 24 px on a light surface;
// every one an image named "Nova", its canvas drawn (not blank), black at its heart. Still: two
// pictures apart are the same. With NOVA_UI_SHOTS set it writes the owner's screenshots to
// docs/screenshots/n-mark-2026-11-08: desktop dark and light, phone, each variant at 96 px and at
// 16 px scaled up 8× (nearest neighbour), and a greyscale sheet of all three at 16, 24 and 48 px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, device, shotsDir } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const VARIANTS = [['accretion', 'A', 'Accretion N'], ['swirl', 'B', 'Swirl N'], ['eclipse', 'C', 'Eclipse N']] as const;
const SIZES = [240, 96, 48, 24, 16];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-n-mark-'));
  chmodSync(dir, 0o700);
  let nova: ReturnType<typeof createNova> | undefined;
  try {
    const home = join(dir, 'nova');
    const user = join(dir, 'user');
    mkdirSync(user, { mode: 0o700 });
    ensureMark(home, { userHome: user });
    nova = createNova(loadConfig({ HOME: user, NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' }));
    const server = nova.server;
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (nova) {
      nova.scheduler.stop();
      nova.server.closeAllConnections();
      if (nova.server.listening) await new Promise<void>((done) => nova!.server.close(() => done()));
      await nova.core.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// The styleguide redraws itself once the appearance arrives, which replaces every mark. Wait until
// the preview stays the same preview for a while.
async function settled(page: Page) {
  for (let i = 0; i < 20; i++) {
    const tag = `t${i}`;
    await page.evaluate((t) => { (document.querySelector('[data-nm-preview]') as HTMLElement).dataset.probe = t; }, tag);
    await sleep(400);
    if (await page.evaluate((t) => (document.querySelector('[data-nm-preview]') as HTMLElement | null)?.dataset.probe === t, tag)) return;
  }
  assert.fail('the preview never settled');
}
async function open(page: Page, base: string) {
  await page.goto(`${base}/styleguide?entry=n-mark`);
  await page.waitForFunction(() => document.querySelectorAll('[data-nm-preview] .n-mark canvas').length >= 3 * 8 + 9); // each variant's eight, and the sheet's nine
  await settled(page);
}

// Every mark on the page: where it sits, its name, its size, and what its canvas holds.
const marks = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-nm-preview] .n-mark')].map((el) => {
  const slot = el.parentElement!;
  const where = slot.dataset.nmCell ?? (slot.dataset.nmIcon ? `${slot.dataset.nmIcon}-icon` : slot.dataset.nmLight ? `${slot.dataset.nmLight}-light` : `${slot.dataset.nmCmp}-sheet`);
  const c = el.querySelector('canvas')!;
  const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let lit = 0, colour = 0, top = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a > 24) lit++;
    if (a > 128 && i < data.length / 4) top++; // the top quarter
    if (a > 128 && Math.max(r, g, b) - Math.min(r, g, b) > 60) colour++;
  }
  const mid = (c.height / 2) * c.width * 4 + (c.width / 2) * 4;
  const box = el.getBoundingClientRect();
  return { where, variant: el.dataset.variant, role: el.getAttribute('role'), label: el.getAttribute('aria-label'), w: box.width, h: box.height, renderer: el.dataset.renderer,
    lit: lit / (data.length / 4), top: top / (data.length / 16), colour: colour / (data.length / 4), heart: [...data.slice(mid, mid + 4)], corner: data[3] };
}));

const luma = ([r, g, b]: number[]) => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
const surfaces = (page: Page) => page.evaluate(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgb = (c: string) => { ctx.fillStyle = '#010203'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
  return { tile: rgb(getComputedStyle(document.querySelector('.nm-dark')!).backgroundColor), light: rgb(getComputedStyle(document.querySelector('.nm-light')!).backgroundColor) };
});

function shots(): string | null {
  const m3 = shotsDir();
  if (!m3) return null;
  const dir = join(dirname(m3), 'n-mark-2026-11-08');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('the supernova N: A, B and C at every size, named Nova, drawn, black at the heart, still', { timeout: 600_000 }, async () => {
  let b: Browser | undefined;
  try {
    const launched = await browser();
    assert.notEqual(typeof launched, 'string', 'a browser is required');
    b = launched as Browser;
    await fixture(async (base) => {
      const dir = shots();
      for (const scheme of ['dark', 'light'] as const) {
        const d = await device(b!, { width: 1440, height: 900, scheme, serviceWorkers: 'block' });
        const p = d.page;
        const changes: string[] = [];
        p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${r.url()}`); });
        await open(p, base);
        assert.equal(await p.getByRole('heading', { name: 'The supernova N (proposed)', exact: true }).count(), 1);
        assert.match((await p.locator('.nm-note').textContent()) ?? '', /owner’s reaction/);
        // A, B and C, side by side, each labelled with its letter and name.
        const heads = await p.locator('.nm-name').allTextContents();
        assert.deepEqual(heads.map((h) => h.trim()), VARIANTS.map(([, l, n]) => `${l} ${n}`));
        const tops = await p.locator('.nm-variant').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        assert.equal(new Set(tops).size, 1, `${scheme}: side by side at 1440 px (${tops})`);

        const all = await marks(p);
        const want: string[] = [];
        for (const [id] of VARIANTS) {
          for (const px of SIZES) want.push(`${id}-${px}`);
          want.push(`${id}-icon`, `${id}-16-light`, `${id}-24-light`, `${id}-16-sheet`, `${id}-24-sheet`, `${id}-48-sheet`);
        }
        assert.deepEqual(all.map((m) => m.where).sort(), want.sort(), `${scheme}: every variant at every size`);
        for (const m of all) {
          const px = m.where.endsWith('-icon') ? 180 : Number(/-(\d+)/.exec(m.where)![1]);
          assert.equal(m.role, 'img', `${m.where}: an image`);
          assert.equal(m.label, 'Nova', `${m.where}: named Nova`);
          assert.equal(m.w, px, `${m.where}: width`);
          assert.equal(m.h, px, `${m.where}: height`);
          assert.ok(m.renderer === 'webgl' || m.renderer === 'canvas2d', `${m.where}: drawn by the shared material (${m.renderer})`);
          assert.ok(m.lit > 0.15, `${m.where}: not blank (${(m.lit * 100).toFixed(1)}% drawn)`);
          assert.ok(m.top > 0.08, `${m.where}: drawn to the top, not clipped (${(m.top * 100).toFixed(1)}% of the top quarter)`);
          assert.ok(m.colour > 0.05, `${m.where}: in the nebula’s colours (${(m.colour * 100).toFixed(1)}%)`);
          const [r, g, bl, a] = m.heart as [number, number, number, number];
          assert.ok(a > 200 && Math.max(r, g, bl) < 40, `${m.where}: black at the heart (${m.heart})`);
          if (m.where.endsWith('-icon')) assert.equal(m.corner, 0, `${m.where}: the app icon’s corners are rounded`);
        }
        for (const [id] of VARIANTS) assert.equal(await p.locator(`[data-nm-variant="${id}"]`).getByRole('img', { name: 'Nova', exact: true }).count(), SIZES.length + 3, `${id}: by its accessible name`);
        // Still: nothing redraws.
        const pic = () => p.evaluate(() => (document.querySelector('[data-nm-cell="swirl-96"] canvas') as HTMLCanvasElement).toDataURL());
        const first = await pic();
        await sleep(600);
        assert.equal(await pic(), first, `${scheme}: still`);
        // The tile is near-black and the light surface light, whichever mode is on show.
        const s = await surfaces(p);
        assert.ok(luma(s.tile) < 0.12, `${scheme}: near-black tile ${s.tile}`);
        assert.ok(luma(s.light) > 0.75, `${scheme}: light surface ${s.light}`);
        assert.deepEqual(changes, [], 'demo only: nothing is sent');
        assert.deepEqual(d.errors, [], `${scheme}: no page errors`);

        if (dir) {
          await p.evaluate(() => window.scrollTo(0, 0));
          await p.screenshot({ path: join(dir, `n-mark-desktop-1440x900-nebula-${scheme}.png`) });
          await p.screenshot({ path: join(dir, `n-mark-desktop-1440x900-nebula-${scheme}-full.png`), fullPage: true });
        }
        if (dir && scheme === 'dark') {
          for (const [id, letter] of VARIANTS) {
            await p.locator(`[data-nm-cell="${id}-96"]`).screenshot({ path: join(dir, `n-mark-${letter}-${id}-96.png`) });
            // 16 px, pixel for pixel on its tile, scaled up 8× with no smoothing.
            const png = await p.evaluate((sel) => {
              const src = document.querySelector(`${sel} canvas`) as HTMLCanvasElement;
              const out = document.createElement('canvas');
              out.width = out.height = 16 * 8;
              const x = out.getContext('2d')!;
              x.fillStyle = getComputedStyle(document.querySelector('.nm-sizes')!).backgroundColor;
              x.fillRect(0, 0, out.width, out.height);
              const one = document.createElement('canvas');
              one.width = one.height = 16;
              const o = one.getContext('2d')!;
              o.fillStyle = x.fillStyle;
              o.fillRect(0, 0, 16, 16);
              o.drawImage(src, 0, 0, 16, 16);
              x.imageSmoothingEnabled = false;
              x.drawImage(one, 0, 0, 16, 16, 0, 0, 16 * 8, 16 * 8);
              return out.toDataURL('image/png');
            }, `[data-nm-cell="${id}-16"]`);
            writeFileSync(join(dir, `n-mark-${letter}-${id}-16-8x.png`), Buffer.from(String(png).split(',')[1]!, 'base64'));
          }
          // Legibility without colour: all three at 16, 24 and 48 px in greyscale.
          const sheet = p.locator('[data-nm-sheet]');
          await sheet.evaluate((el) => { (el as HTMLElement).style.filter = 'grayscale(1)'; });
          await sheet.screenshot({ path: join(dir, 'n-mark-greyscale-16-24-48.png') });
          await sheet.evaluate((el) => { (el as HTMLElement).style.filter = ''; });
        }
        await d.ctx.close();
      }

      // Phone: the three stack, and nothing scrolls sideways.
      const phone = await device(b!, { width: 390, height: 844, scheme: 'dark', touch: true, serviceWorkers: 'block' });
      await open(phone.page, base);
      assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no horizontal scroll');
      assert.deepEqual(phone.errors, [], 'phone: no page errors');
      if (dir) {
        await phone.page.screenshot({ path: join(dir, 'n-mark-phone-390x844-nebula-dark.png') });
        await phone.page.screenshot({ path: join(dir, 'n-mark-phone-390x844-nebula-dark-full.png'), fullPage: true });
      }
      await phone.ctx.close();
    });
  } finally {
    await b?.close();
  }
});
