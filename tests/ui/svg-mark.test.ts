// Nova's mark as SVG, theme-matched (UI item 24, owner 2026-11-10): the N itself, an inline SVG on a
// transparent background, never a picture in a box. The styleguide entry (/styleguide?entry=nova-mark)
// shows it at 16, 24, 48, 96 and 180 px on Nebula dark, Nebula light and the Jarvis HUD study; each
// look changes the gradient's stops (the theme's mark tokens, or the HUD's variant), and the light
// look's every stop reaches 4.5:1 against its surface, measured here in the browser. In the app the
// rail's mark takes the dark or light stops with the device's appearance, and About shows the mark.
// With NOVA_UI_SHOTS set: the entry at desktop 1440×900 (dark and light pages) and phone 390×844.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shotsDir } from './support.ts';

const SIZES = [16, 24, 48, 96, 180];
const STOPS = ['left-outer', 'left-mid', 'left-inner', 'right-outer', 'right-mid', 'right-inner'];

// WCAG contrast of two sRGB colours (0..255).
function ratio(a: number[], b: number[]) {
  const lum = (c: number[]) => { const [r, g, bl] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// One look's panel: each mark in it, what it is made of, and its stops and surface as drawn
// (resolved through a canvas, so color-mix() comes back as sRGB).
const look = (page: Page, id: string) => page.evaluate((lookId) => {
  const panel = document.querySelector<HTMLElement>(`[data-mark-look="${lookId}"]`)!;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const srgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'transparent'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
  const marks = [...panel.querySelectorAll<HTMLElement>('[data-mark-size] .status-icon')].map((el) => {
    const svg = el.querySelector('svg')!;
    return {
      size: Number(el.closest<HTMLElement>('[data-mark-size]')!.dataset.markSize),
      inline: svg.parentElement === el && svg.namespaceURI === 'http://www.w3.org/2000/svg',
      css: svg.getBoundingClientRect().width,
      // Transparent: no background on the SVG or its holder, no shape behind the N, no picture.
      background: [getComputedStyle(svg).backgroundColor, getComputedStyle(el).backgroundColor],
      shapes: [...svg.querySelectorAll('path, rect, circle, ellipse, polygon, image, foreignObject')].map((s) => s.localName + (s.hasAttribute('data-ribbon') ? ':ribbon' : '')),
      raster: el.querySelectorAll('img, canvas, image').length,
      stops: Object.fromEntries([...svg.querySelectorAll<SVGStopElement>('stop[data-stop]')].map((s) => [s.dataset.stop!, srgb(getComputedStyle(s).stopColor)])),
    };
  });
  const surface = srgb(getComputedStyle(panel).backgroundColor);
  return { marks, surface, weakest: Number(panel.dataset.weakest ?? 0) };
}, id);

test('Nova’s mark: an inline SVG on a transparent background, its stops per theme, the light look at 4.5:1', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-svg-mark-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    assert.equal((await m.send('POST', '/api/v1/design-systems/nebula/apply', { scope: 'user' })).status, 200);
    const nebula = (await m.get('/api/v1/design-systems/nebula')).manifest as { tokens: Record<string, string>; modes: { dark: Record<string, string> } };
    const want = { dark: { ...nebula.tokens, ...nebula.modes.dark }, light: nebula.tokens };

    // ---- the styleguide entry, on a dark page and a light one: the panels are the same either way.
    for (const scheme of ['dark', 'light'] as const) {
      const d = await device(b, { width: 1440, height: 900, scheme, serviceWorkers: 'block' });
      try {
        await d.page.goto(`${m.base}/styleguide?entry=nova-mark`);
        await d.page.waitForSelector('[data-mark-preview][data-ready]');
        await d.page.waitForTimeout(300); // a frame for every mark
        const seen: Record<string, Awaited<ReturnType<typeof look>>> = {};
        for (const id of ['dark', 'light', 'hud']) {
          const l = await look(d.page, id);
          seen[id] = l;
          assert.deepEqual(l.marks.map((x) => x.size), SIZES, `${scheme} page, ${id}: 16, 24, 48, 96 and 180 px`);
          for (const x of l.marks) {
            const at = `${scheme} page, ${id} ${x.size} px`;
            assert.ok(x.inline, `${at}: an inline SVG`);
            assert.equal(x.css, x.size, `${at}: at its size`);
            assert.deepEqual(x.background, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'], `${at}: no background fill`);
            assert.deepEqual(x.shapes, ['path:ribbon', 'path:ribbon'], `${at}: the N’s two ribbons and nothing behind them`);
            assert.equal(x.raster, 0, `${at}: no picture`);
            assert.deepEqual(x.stops, l.marks[0]!.stops, `${at}: one set of stops at every size`);
          }
        }
        // The stops change with the look: Nebula dark's and light's are the theme's mark tokens, the
        // HUD's its own cyan family.
        for (const id of ['dark', 'light'] as const) {
          for (const n of STOPS) assert.deepEqual(seen[id]!.marks[0]!.stops[n], hex(want[id][`mark/${n}`]!), `${id}: ${n} is the theme’s mark/${n}`);
        }
        const key = (id: string) => STOPS.map((n) => seen[id]!.marks[0]!.stops[n]!.join(',')).join(' ');
        assert.equal(new Set(['dark', 'light', 'hud'].map(key)).size, 3, 'each look has its own stops');
        const hud = seen.hud!.marks[0]!.stops;
        for (const n of STOPS) { const [r, g, bl] = hud[n]!; assert.ok(bl! >= r! && g! >= r!, `hud: ${n} is in the cyan family (${hud[n]})`); }

        // The light look: every stop against its surface, the weakest at 4.5:1 or more.
        const light = seen.light!;
        assert.deepEqual(light.surface, hex(want.light['bg/base']!), 'the light panel is Nebula light’s surface');
        const ratios = STOPS.map((n) => [n, ratio(light.marks[0]!.stops[n]!, light.surface)] as const);
        const weakest = Math.min(...ratios.map(([, r]) => r));
        console.log(`svg mark, light look on ${want.light['bg/base']}: ${ratios.map(([n, r]) => `${n} ${r.toFixed(2)}:1`).join(', ')}; weakest ${weakest.toFixed(2)}:1`);
        assert.ok(weakest >= 4.5, `the light look’s weakest stop is ${weakest.toFixed(2)}:1; it needs 4.5:1`);
        assert.ok(Math.abs(light.weakest - weakest) < 0.02, `the entry says the same (${light.weakest})`);
        // Dark: the full nebula, every stop a graphic's 3:1 on its surface.
        const dark = seen.dark!;
        const darkWeakest = Math.min(...STOPS.map((n) => ratio(dark.marks[0]!.stops[n]!, dark.surface)));
        console.log(`svg mark, dark look on ${want.dark['bg/base']}: weakest ${darkWeakest.toFixed(2)}:1`);
        assert.ok(darkWeakest >= 3, `the dark look’s weakest stop is ${darkWeakest.toFixed(2)}:1; it needs 3:1`);

        assert.deepEqual(d.errors, [], `${scheme} page: no page errors`);
        if (shots) await d.page.locator('#sg-nova-mark').screenshot({ path: join(shots, `svg-mark-entry-desktop-${scheme}.png`) });
      } finally { await d.ctx.close(); }
    }
    if (shots) {
      const p = await device(b, { width: 390, height: 844, scheme: 'dark', touch: true, serviceWorkers: 'block' });
      try {
        await p.page.goto(`${m.base}/styleguide?entry=nova-mark`);
        await p.page.waitForSelector('[data-mark-preview][data-ready]');
        assert.ok(await p.page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no horizontal scroll');
        await p.page.locator('#sg-nova-mark').screenshot({ path: join(shots, 'svg-mark-entry-phone-dark.png') });
      } finally { await p.ctx.close(); }
    }

    // ---- in the app: the rail's mark takes the device's look; About carries the mark.
    for (const scheme of ['dark', 'light'] as const) {
      const d = await device(b, { width: 1440, height: 900, scheme, serviceWorkers: 'block' });
      try {
        await d.page.goto(`${m.base}/tasks`);
        await ready(d.page);
        const rail = d.page.locator('#rail .rail-home .status-icon[data-presence]');
        await rail.waitFor();
        await d.page.waitForTimeout(300);
        const stops = await rail.evaluate((el) => {
          const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
          return Object.fromEntries([...el.querySelectorAll<SVGStopElement>('stop[data-stop]')].map((s) => { ctx.fillStyle = getComputedStyle(s).stopColor; ctx.fillRect(0, 0, 1, 1); return [s.dataset.stop!, [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]]; }));
        });
        for (const n of STOPS) assert.deepEqual(stops[n], hex(want[scheme][`mark/${n}`]!), `rail, ${scheme}: ${n} is Nebula ${scheme}’s`);
        assert.equal(await rail.locator('svg path[data-ribbon]').count(), 2, `rail, ${scheme}: the SVG N`);

        await d.page.goto(`${m.base}/about`);
        await ready(d.page);
        const about = d.page.locator('.about-card .card-title svg.nova-mark');
        await about.waitFor();
        assert.equal(await about.getAttribute('aria-hidden'), 'true', `about, ${scheme}: the heading says the name; the mark is decorative`);
        assert.equal(Math.round((await about.boundingBox())!.width), 32, `about, ${scheme}: 32 px`);
        assert.match((await d.page.locator('.about-card .card-title').textContent()) ?? '', /^Nova\b/, `about, ${scheme}: the heading still reads Nova`);
        assert.deepEqual(d.errors, [], `app, ${scheme}: no page errors`);
        if (shots) await d.page.locator('.about-card').screenshot({ path: join(shots, `svg-mark-about-${scheme}.png`) });
      } finally { await d.ctx.close(); }
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
