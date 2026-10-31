// M9 gate, skeletons (Amendment 2026-10-30-C Part 2; DESIGN-SYSTEM §1): a view whose data is slow
// shows nothing for its first second, then a skeleton whose blocks stand exactly where the view's
// blocks land (to half a pixel), so the swap moves nothing (no layout shift). Home, Tasks, Memory and
// a conversation, at a phone's width and a desktop's. The skeleton is the view's own last layout on
// this device (ui/js/skeleton.js), so the test opens each view once, then again with its data held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Route } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { join } from 'node:path';
import { browser, device, shoot, still } from './support.ts';
import { CHAT, SIZES, VIEWS, m9Shots, seeded, settled } from './m9-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CORE = /\/api\/v1\/(tasks|problems|health|profile|identity|memory|triggers|messages|workers|mesh|resilience)/;
type Box = [number, number, number, number];
const CASES: [string, string, RegExp | string][] = [
  ['home', '#home', CORE],
  ['tasks', '#tasks-view', CORE],
  ['memory', '#memory', /\/api\/memory$/],
  ['chat', '#thread', new RegExp(`/api/sessions/${CHAT}/events`)],
];

const visible = (b: Box[]) => b.filter(([, , w, h]) => w > 0 && h > 0);
const rects = async (page: Page, sel: string) => visible(await page.$$eval(sel, (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] as Box; })));
// The view's own blocks, by the same rule the app keeps their shape with (skeleton.js blocksOf).
const finals = async (page: Page, view: string, sel: string) => visible(await page.evaluate(async ([v, s]) => {
  const { blocksOf } = await import(String('/js/skeleton.js'));
  return blocksOf(v, document.querySelector(s!)).map((e: Element) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] as Box; });
}, [view, sel]));

test('M9 gate, skeletons: none under 1 s, then the final geometry exactly, and the swap moves nothing', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-skeleton-');
  const rows: string[] = [];
  const shots = m9Shots();
  try {
    for (const [size, vp] of SIZES) {
      for (const [view, sel, pattern] of CASES) {
        const where = `${size}, ${view}`;
        // The service worker would answer what the test holds back (page.route doesn't see its requests).
        const d = await device(b, { ...vp, touch: size === 'phone', serviceWorkers: 'block' });
        await d.ctx.addInitScript(() => {
          (window as any).__shifts = [];
          new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) (window as any).__shifts.push({ at: e.startTime, value: e.value, input: e.hadRecentInput }); }).observe({ type: 'layout-shift', buffered: true });
        });
        // Once with its data: the view's layout is kept on this device.
        await d.page.goto(`${m.base}${VIEWS[view]}`);
        await settled(d.page, view);
        await still(d.page);
        await d.page.waitForFunction(([v]) => Object.keys(JSON.parse(localStorage.getItem('nova.shape') ?? '{}')).some((k) => k.startsWith(`${v}|`) || k.startsWith(`${v}:`)), [view], { timeout: 5000 });

        // Again, with its data held.
        const held: Route[] = [];
        let open = false;
        await d.page.route(pattern, (r) => { if (open || r.request().method() !== 'GET') r.fallback(); else held.push(r); });
        await d.page.reload();
        await d.page.waitForSelector('html[data-ready]');
        await d.page.waitForSelector(`${sel} [data-skeleton]`, { state: 'attached', timeout: 5000 });
        await sleep(400);
        const early = await d.page.$eval(`${sel} [data-skeleton]`, (e) => Number(getComputedStyle(e).opacity));
        assert.equal(early, 0, `${where}: under 1 s nothing is seen`);
        await sleep(1100);
        const late = await d.page.$eval(`${sel} [data-skeleton]`, (e) => Number(getComputedStyle(e).opacity));
        assert.equal(late, 1, `${where}: from 1 s the skeleton shows`);
        assert.ok(await d.page.$$eval(`${sel} .skel-line`, (l) => l.length) > 0, `${where}: the skeleton has the content's lines, not just frames`);
        if (shots && (view === 'home' || view === 'chat')) await d.page.screenshot({ path: join(shots, `skeleton-${size}-${view}.png`) });
        const skel = await rects(d.page, `${sel} .skel-block`);
        const scroll = () => d.page.evaluate(() => { const s = document.getElementById('scroller')!; return `${s.scrollTop}/${s.scrollHeight}/${s.clientHeight}`; });
        const scrollSkel = await scroll();
        const before = await d.page.evaluate(() => performance.now());
        open = true;
        await d.page.unroute(pattern);
        for (const r of held.splice(0)) await r.fallback().catch(() => {});
        await settled(d.page, view);
        await still(d.page);
        const final = await finals(d.page, view, sel);
        if (shots && (view === 'home' || view === 'chat')) await shoot(d.page, join(shots, `skeleton-${size}-${view}-loaded.png`));
        assert.equal(skel.length, final.length, `${where}: a skeleton block for every block (${skel.length} vs ${final.length})`);
        let worst = 0;
        let at = -1;
        // A conversation lays out turns far above the screen as estimates (content-visibility), in
        // the skeleton and the view alike: what must match there is what is on screen.
        const h = vp.height;
        const seen = (i: number) => view !== 'chat' || (final[i]![1] < h && final[i]![1] + final[i]![3] > 0);
        skel.forEach((s, i) => seen(i) && s.forEach((v, k) => { const off = Math.abs(v - final[i]![k]!); if (off > worst) { worst = off; at = i; } }));
        const show = (r?: Box) => (r ? r.map((x) => Math.round(x)).join(',') : '-');
        assert.ok(worst <= 0.5, `${where}: every block lands where its skeleton stood (off by up to ${worst.toFixed(2)} px: block ${at}, skeleton ${show(skel[at])}, final ${show(final[at])}; scroller ${scrollSkel} then ${await scroll()})`);
        const shift = await d.page.evaluate((t0) => (window as any).__shifts.filter((s: any) => s.at >= t0 && !s.input).reduce((n: number, s: any) => n + s.value, 0), before);
        assert.equal(shift, 0, `${where}: the swap moved nothing (layout shift ${shift})`);
        assert.deepEqual(d.errors, [], `${where}: no errors in the page`);
        rows.push(`${where.padEnd(16)} ${String(skel.length).padStart(3)} blocks, off by ≤ ${worst.toFixed(2)} px, shift ${shift}`);
        await d.ctx.close();
      }
    }
    console.log(`skeletons:\n${rows.join('\n')}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
