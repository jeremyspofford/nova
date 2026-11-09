// Jarvis rings (owner direction 2026-11-08, step 1; /styleguide?entry=jarvis), in Chromium and
// WebKit: all 40 cells (ten states at 16, 24, 48 and 96 px) drawn and named by state and size, the
// HUD core cross-fading between states, success settling to idle, the amplitude slider, and a
// reduced-motion switch that stops every loop. With NOVA_UI_SHOTS set: desktop 1440×900 (and full
// page), phone 390×844, a greyscale 16/24/48 grid, and the hero idle → working → idle as frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, webkitBrowser, device, shotsDir } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline'];
const SIZES = [16, 24, 48, 96];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Core = HTMLElement & { setStatus: (s: string) => void };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-jarvis-'));
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

// The styleguide redraws itself once the appearance arrives, which replaces every ring. Wait until
// the preview stays the same preview for a while.
async function settled(page: Page) {
  for (let i = 0; i < 20; i++) {
    const tag = `t${i}`;
    await page.evaluate((t) => { (document.querySelector('[data-jv-hero]') as HTMLElement).dataset.probe = t; }, tag);
    await sleep(400);
    if (await page.evaluate((t) => (document.querySelector('[data-jv-hero]') as HTMLElement | null)?.dataset.probe === t, tag)) return;
  }
  assert.fail('the preview never settled');
}
async function open(page: Page, base: string) {
  await page.goto(`${base}/styleguide?entry=jarvis`);
  // The styleguide redraws its catalogue once the appearance arrives (styleguide.js): until then a
  // ring found here can be replaced under the test (the detached hero, CI on 423c1522).
  await page.waitForSelector('html[data-sg-appearance]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-jv-cell] .jv-core svg').length >= n && document.querySelector('[data-jv-hero] .jv-core svg'), STATES.length * SIZES.length);
  await settled(page);
}
const heroLabel = (page: Page) => page.locator('[data-jv-hero] .jv-core').getAttribute('aria-label');
const heroLayers = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-jv-hero] .jv-ring')].map((s) => s.getAttribute('data-state')));
// Animations running inside the Jarvis surface.
const running = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('[data-jv-preview]')!;
  return document.getAnimations().filter((a) => a.playState === 'running' && root.contains((a.effect as KeyframeEffect | null)?.target ?? null)).length;
});

// The colours the Jarvis surface resolves to, as sRGB 0..255 (a canvas resolves color-mix(),
// light-dark() and oklch() the way the page does): its background, its ink, and stopped's stroke.
const colours = (page: Page) => page.evaluate(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgb = (c: string) => { ctx.fillStyle = '#010203'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
  const surface = getComputedStyle(document.querySelector('.jv-surface')!);
  return { bg: rgb(surface.backgroundColor), ink: rgb(surface.color), red: rgb(getComputedStyle(document.querySelector('[data-jv-cell="stopped-96"] .jv-red')!).stroke) };
});
const luma = ([r, g, b]: number[]) => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
function assertColours(c: Awaited<ReturnType<typeof colours>>, label: string) {
  assert.notDeepEqual(c.bg, [1, 2, 3], `${label}: the surface's colour resolves`);
  assert.ok(luma(c.bg) < 0.12, `${label}: near-black surface ${c.bg}`); // a little cyan in the black
  assert.ok(luma(c.ink) > 0.75, `${label}: light ink ${c.ink}`);
  const [r, g, b] = c.red as [number, number, number];
  assert.ok(r > 150 && r > g * 1.8 && r > b * 1.8, `${label}: stopped reads red ${c.red}`);
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Jarvis rings ${engine}: 40 cells labelled and drawn; morph, success, amplitude and reduced motion`, { timeout: 600_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        const d = await device(b!, { width: 1440, height: 900, scheme: 'dark', serviceWorkers: 'block' });
        const p = d.page;
        const changes: string[] = [];
        p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${r.url()}`); });
        await open(p, base);
        assert.equal(await p.getByRole('heading', { name: 'Jarvis rings (proposed)', exact: true }).count(), 1);
        assert.match((await p.locator('.jv-note').textContent()) ?? '', /not a shipped theme/);

        // All 40 cells: an image named by state and size, holding a ring drawn at that size.
        const cells = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-jv-cell]')].map((cell) => {
          const svg = cell.querySelector('svg.jv-ring')!;
          const box = svg.getBoundingClientRect();
          const drawn = [...svg.querySelectorAll('circle')].some((c) => c.getBBox().width > 0 && getComputedStyle(c).stroke !== 'none');
          return { cell: cell.dataset.jvCell!, role: cell.getAttribute('role'), label: cell.getAttribute('aria-label'), w: box.width, h: box.height, drawn, hidden: cell.querySelector('.jv-core')!.getAttribute('aria-hidden') };
        }));
        assert.equal(cells.length, 40, 'ten states at four sizes');
        for (const c of cells) {
          const [, s, px] = /^(.+)-(\d+)$/.exec(c.cell)!;
          assert.equal(c.role, 'img', `${c.cell}: role`);
          assert.equal(c.label, `${s}, ${px} px`, `${c.cell}: label`);
          assert.equal(c.w, Number(px), `${c.cell}: width`);
          assert.equal(c.h, Number(px), `${c.cell}: height`);
          assert.ok(c.drawn, `${c.cell}: drawn`);
          assert.equal(c.hidden, 'true', `${c.cell}: the cell names it, once`);
        }
        for (const s of STATES) for (const px of SIZES) assert.equal(await p.getByRole('img', { name: `${s}, ${px} px`, exact: true }).count(), 1, `${s}-${px} by its accessible name`);
        assert.equal(await p.getByRole('img', { name: 'idle', exact: true }).count(), 1, 'the HUD core, named by its state');

        // The hero cross-fades in 800 ms: both layers part way, the new one alone after.
        assert.ok(await running(p) > 0, 'the loops run');
        await p.getByRole('button', { name: 'working', exact: true }).click();
        await sleep(250);
        assert.deepEqual((await heroLayers(p)).sort(), ['idle', 'working'], 'mid-morph: both');
        await sleep(900);
        assert.deepEqual(await heroLayers(p), ['working'], 'then working alone');
        assert.equal(await heroLabel(p), 'working');
        assert.equal(await p.getByRole('button', { name: 'working', exact: true }).getAttribute('aria-pressed'), 'true');

        // Success: a flourish that settles to idle by itself, and the buttons follow.
        await p.getByRole('button', { name: 'success', exact: true }).click();
        assert.equal(await heroLabel(p), 'success');
        await p.waitForFunction(() => document.querySelector('[data-jv-hero] .jv-core')!.getAttribute('aria-label') === 'idle', null, { timeout: 2500 });
        await p.waitForFunction(() => document.querySelector('[data-jv-set="idle"]')!.getAttribute('aria-pressed') === 'true');

        // Amplitude: the slider makes the hero speak with the voice's level, not the default pulse.
        await p.getByLabel('Speaking amplitude').fill('80');
        await p.waitForFunction(() => document.querySelector('[data-jv-hero] .jv-core')!.getAttribute('aria-label') === 'speaking');
        await sleep(1000);
        const voice = await p.evaluate(() => { const s = document.querySelector<SVGElement>('[data-jv-hero] .jv-ring[data-state="speaking"]')!; return { amp: s.style.getPropertyValue('--jv-amp'), voiced: !!s.querySelector('.jv-amp'), pulse: !!s.querySelector('.jv-a-pulse') }; });
        assert.deepEqual(voice, { amp: '0.8', voiced: true, pulse: false });
        await p.getByRole('button', { name: 'Gentle default pulse' }).click();
        await sleep(100);
        assert.ok(await p.evaluate(() => !!document.querySelector('[data-jv-hero] .jv-ring[data-state="speaking"] .jv-a-pulse')), 'back to the gentle pulse');

        // Reduced motion: every loop stops, a change swaps at once, and the states still differ.
        await p.getByLabel('Reduced motion').check();
        await sleep(100);
        assert.equal(await running(p), 0, 'reduced: nothing moves');
        await p.getByRole('button', { name: 'paused', exact: true }).click();
        assert.deepEqual(await heroLayers(p), ['paused'], 'reduced: swapped at once, no morph');
        // (success is left out: it rests at idle between the sheet's replays)
        const still = await p.evaluate(() => [...document.querySelectorAll('[data-jv-cell$="-16"]:not([data-jv-cell^="success-"]) svg')].map((s) => s.innerHTML));
        assert.equal(new Set(still).size, 9, 'reduced: every resting state draws its own rings at 16 px');
        await p.getByLabel('Reduced motion').uncheck();
        await sleep(100);
        assert.ok(await running(p) > 0, 'the loops run again');
        await p.getByRole('button', { name: 'idle', exact: true }).click();

        assert.deepEqual(changes, [], 'demo only: nothing is sent');
        assert.deepEqual(d.errors, [], 'no page errors');

        // Colours from the theme's tokens: near-black surface and light ink in dark and in light
        // (light-dark() picks the light or dark token of each pair), and stopped in the theme's red.
        const dark = await colours(p);
        console.log(`${engine} dark: ${JSON.stringify(dark)}`);
        assertColours(dark, `${engine} dark`);
        const light = await device(b!, { width: 1280, height: 820, scheme: 'light', serviceWorkers: 'block' });
        await open(light.page, base);
        const lit = await colours(light.page);
        console.log(`${engine} light: ${JSON.stringify(lit)}`);
        assertColours(lit, `${engine} light`);
        assert.deepEqual(light.errors, [], 'light: no page errors');
        await light.ctx.close();

        const dir = shotsDir();
        if (dir && engine === 'chromium') {
          // Success is caught once its layer has fully morphed in (800 ms) and before it settles (1 s).
          const flourishing = (page: Page, after = 840) => page.waitForFunction(() => document.querySelector('[data-jv-cell="success-48"] .jv-core')!.getAttribute('aria-label') === 'success', null, { timeout: 5000, polling: 'raf' }).then(() => sleep(after));
          await sleep(900);
          await flourishing(p);
          await p.locator('#sg-jarvis').scrollIntoViewIfNeeded();
          await p.evaluate(() => window.scrollTo(0, 0));
          await p.screenshot({ path: join(dir, 'jarvis-desktop-1440x900-nebula-dark.png') });
          await flourishing(p);
          await p.screenshot({ path: join(dir, 'jarvis-desktop-1440x900-nebula-dark-full.png'), fullPage: true });
          // Shape legibility: 16, 24 and 48 px in greyscale.
          const sheet = p.locator('[data-jv-sheet]');
          await sheet.evaluate((el) => {
            el.style.gridTemplateColumns = 'minmax(88px, auto) repeat(3, minmax(48px, auto))';
            el.style.filter = 'grayscale(1)';
            el.querySelectorAll<HTMLElement>('[data-jv-cell$="-96"], .jv-head:nth-child(5)').forEach((x) => { x.style.display = 'none'; });
          });
          await flourishing(p);
          await sheet.screenshot({ path: join(dir, 'jarvis-greyscale-16-24-48.png') });
          await sheet.evaluate((el) => {
            el.style.gridTemplateColumns = '';
            el.style.filter = '';
            el.querySelectorAll<HTMLElement>('[data-jv-cell$="-96"], .jv-head:nth-child(5)').forEach((x) => { x.style.display = ''; });
          });
          // Every state still at 96 px, greyscale, as reduced motion draws them.
          await p.getByLabel('Reduced motion').check();
          await sleep(100);
          await sheet.evaluate((el) => { el.style.filter = 'grayscale(1)'; });
          await flourishing(p, 100); // reduced: success swaps in at once
          await sheet.screenshot({ path: join(dir, 'jarvis-greyscale-reduced-all-sizes.png') });
          await sheet.evaluate((el) => { el.style.filter = ''; });
          await p.getByLabel('Reduced motion').uncheck();

          // The hero idle → working → idle on a paused clock, frame by frame through the 800 ms morph.
          const seq = await device(b!, { width: 1440, height: 900, scheme: 'dark', serviceWorkers: 'block' });
          await seq.page.clock.install();
          await open(seq.page, base);
          const hero = seq.page.locator('.jv-hero');
          await hero.scrollIntoViewIfNeeded();
          await seq.page.clock.pauseAt(Date.now() + 60_000);
          const step = async (name: string, ms: number) => { await seq.page.clock.runFor(ms); await hero.screenshot({ path: join(dir, name) }); };
          await step('jarvis-sequence-1-idle.png', 50);
          await seq.page.evaluate(() => (document.querySelector('[data-jv-hero] .jv-core') as Core).setStatus('working'));
          await step('jarvis-sequence-2-idle-to-working-400ms.png', 400);
          await step('jarvis-sequence-3-working.png', 450);
          await seq.page.evaluate(() => (document.querySelector('[data-jv-hero] .jv-core') as Core).setStatus('idle'));
          await step('jarvis-sequence-4-working-to-idle-400ms.png', 400);
          await step('jarvis-sequence-5-idle.png', 450);
          await seq.ctx.close();

          const phone = await device(b!, { width: 390, height: 844, scheme: 'dark', touch: true, serviceWorkers: 'block' });
          await open(phone.page, base);
          await flourishing(phone.page);
          await phone.page.screenshot({ path: join(dir, 'jarvis-phone-390x844-nebula-dark.png') });
          await phone.page.screenshot({ path: join(dir, 'jarvis-phone-390x844-nebula-dark-full.png'), fullPage: true });
          assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no horizontal scroll');
          await phone.ctx.close();
        }
        await d.ctx.close();
      });
    } finally {
      await b?.close();
    }
  });
}
