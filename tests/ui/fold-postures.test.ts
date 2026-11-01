// Fold postures (UX review 2026-10-31, F8 and F9; owner-approved fix). The review's ten postures,
// every main view, in Chromium and in WebKit (the engine of every iPhone browser): nothing past the
// viewport without a way to scroll to it, no text under 8 characters a line, no siblings drawn over
// each other, no card under its minimum width, and a right column that scrolls or isn't there. The
// three-column band starts at the sum of its regions' minimums, derived in every design system.
// Then screenshot baselines of the fold postures, and the iOS standalone safe area. Each test
// prints what it measured (`FOLD …` lines) for the before/after record in docs/plans/fold-postures.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { decodePng } from '../../src/core/browser/png.ts';
import { ROOT, browser, device, shotsDir, still, webkitBrowser } from './support.ts';
import { POSTURES, VIEWS, reviewProfile } from './axe-support.ts';
import { audit, problems, summary, withMesh, type FoldAudit } from './fold-support.ts';

const record = (what: string, v: unknown) => console.log(`FOLD ${what} ${JSON.stringify(v)}`);
const DESIGNS = ['orb-teal', 'companion-light', 'nova', 'obsidian', 'aurora', 'paper'];

// A view, drawn from its data and still.
async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('html[data-ready]', { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('[data-skeleton]'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await still(page);
}

// One device with the review's mesh. Service workers are blocked so the mesh reaches the page in
// both engines (a worker's fetch would pass Playwright's route by); nothing here is about offline.
async function folded(b: Browser, opts: Parameters<typeof device>[1]) {
  const d = await device(b, { ...opts, serviceWorkers: 'block' });
  await withMesh(d.ctx);
  return d;
}

async function engines(): Promise<[string, Browser][] | string> {
  const c = await browser();
  if (typeof c === 'string') return c;
  const w = await webkitBrowser();
  if (typeof w === 'string') { await c.close(); return w; }
  return [['chromium', c], ['webkit', w]];
}

// ---- the matrix ---------------------------------------------------------------------------------

test('F8/F9 gate: ten postures × every main view, in Chromium and WebKit', { timeout: 900_000 }, async (t) => {
  const bs = await engines();
  if (typeof bs === 'string') return t.skip(bs);
  const { m, nova } = await reviewProfile('nova-fold-matrix-');
  const bad: string[] = [];
  let n = 0;
  try {
    for (const [engine, b] of bs) {
      for (const [posture, p] of Object.entries(POSTURES)) {
        const d = await folded(b, { width: p.width, height: p.height, touch: !!p.touch });
        for (const view of VIEWS) {
          await open(d.page, `${m.base}${view}`);
          const a = await audit(d.page);
          n++;
          record(`matrix ${engine} ${posture} ${view}`, summary(a));
          for (const pr of problems(a)) bad.push(`${engine} ${posture} (${p.width}×${p.height}) ${view}: ${pr}`);
        }
        bad.push(...d.errors.map((e) => `${engine} ${posture}: page error ${e}`));
        await d.ctx.close();
      }
      // F9: the fold on its side, short enough that the right column holds more than it shows.
      // It must scroll inside the viewport, never run off its bottom edge.
      const d = await folded(b, { width: 1100, height: 560, touch: true });
      for (const view of ['/chat', '/tasks']) {
        await open(d.page, `${m.base}${view}`);
        const a = await audit(d.page);
        n++;
        record(`matrix ${engine} short-landscape ${view}`, { ...summary(a), rightColumn: a.rightColumn });
        for (const pr of problems(a)) bad.push(`${engine} 1100×560 ${view}: ${pr}`);
        if (!a.rightColumn.overflowing) bad.push(`${engine} 1100×560 ${view}: the right column was meant to hold more than it shows here (the check didn't run)`);
        if (!a.rightColumn.scrollable) bad.push(`${engine} 1100×560 ${view}: the right column doesn't scroll`);
        // It really scrolls to its last card's end.
        const end = await d.page.evaluate(() => { const s = document.getElementById('aside')!; s.scrollTop = s.scrollHeight; const last = s.lastElementChild!.getBoundingClientRect(); return { last: Math.round(last.bottom), bottom: Math.round(s.getBoundingClientRect().bottom) }; });
        if (end.last > end.bottom + 1) bad.push(`${engine} 1100×560 ${view}: scrolled to its end, the last card still runs past the column (${end.last} > ${end.bottom})`);
      }
      await d.ctx.close();
    }
    record('matrix combinations', n);
    assert.deepEqual(bad, [], `${bad.length} problem(s) across ${n} combinations`);
  } finally {
    for (const [, b] of bs) await b.close();
    await stop(nova);
  }
});

// ---- the derivation, in every design system ----------------------------------------------------

// Each design system's tokens give different minimums, so different bands. Every width from a
// phone's to a laptop's, in each, on the views whose right column and cards crushed (F8, F9).
test('F8/F9 gate: the bands are derived from the regions, in every design system, at every width', { timeout: 900_000 }, async (t) => {
  const bs = await engines();
  if (typeof bs === 'string') return t.skip(bs);
  const { m, nova } = await reviewProfile('nova-fold-bands-');
  const bad: string[] = [];
  const widths: number[] = [];
  for (let w = 560; w <= 1440; w += 40) widths.push(w);
  try {
    for (const [engine, b] of bs) {
      const d = await folded(b, { width: 1280, height: 860 });
      for (const ds of DESIGNS) {
        assert.equal((await m.send('POST', `/api/v1/design-systems/${ds}/apply`, { scope: 'device', device_id: d.id })).status, 200);
        for (const view of ['/', '/chat', '/settings']) {
          await open(d.page, `${m.base}${view}`);
          let bands: FoldAudit['bands'] = null;
          for (const w of widths) {
            await d.page.setViewportSize({ width: w, height: 860 });
            await d.page.waitForFunction((x) => document.documentElement.clientWidth === x, w);
            await d.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const a = await audit(d.page);
            bands ??= a.bands;
            if (!a.bands) { bad.push(`${engine} ${ds}: no derived bands on the page`); break; }
            for (const pr of problems(a)) bad.push(`${engine} ${ds} ${view} ${w}px: ${pr}`);
            // The band follows the derived widths, nothing else.
            const want = w < a.bands.two ? 'phone' : w < a.bands.three ? 'tablet' : 'desktop';
            if (a.layout !== want) bad.push(`${engine} ${ds} ${view} ${w}px: ${a.layout}, but the derived bands say ${want} (${a.bands.two}/${a.bands.three})`);
          }
          if (bands && view === '/') {
            record(`bands ${engine} ${ds}`, bands);
            const sum = bands.rail + bands.main + bands.asideMin;
            if (Math.abs(sum - bands.three) > 1) bad.push(`${engine} ${ds}: the three-column band (${bands.three}) isn't the sum of its regions (${sum})`);
          }
        }
      }
      // A design system swapped live moves the band with it, no reload.
      await d.page.setViewportSize({ width: 1280, height: 860 });
      await open(d.page, `${m.base}/`);
      const before = (await audit(d.page)).bands!.three;
      assert.equal((await m.send('POST', '/api/v1/design-systems/companion-light/apply', { scope: 'device', device_id: d.id })).status, 200);
      await d.page.waitForFunction((x) => {
        const p = document.createElement('div'); p.style.cssText = 'position:absolute;visibility:hidden;width:var(--band-three)'; document.body.append(p);
        const w = p.getBoundingClientRect().width; p.remove(); return Math.abs(w - x) > 0.5;
      }, before, { timeout: 10_000 }).catch(() => {});
      record(`bands ${engine} live swap`, { before, after: (await audit(d.page)).bands?.three });
      await d.ctx.close();
    }
    assert.deepEqual(bad, [], `${bad.length} problem(s)`);
  } finally {
    for (const [, b] of bs) await b.close();
    await stop(nova);
  }
});

// ---- screenshot baselines -----------------------------------------------------------------------

// The fold postures as they should look, committed: the cover screen, the inner screen upright
// (Settings is F8's view) and on its side (Chat is F9's). A layout that crushes or clips a column
// changes a large part of the picture; text rendering and antialiasing change a little, which the
// tolerance allows. What moves with the clock (times, the greeting, "last seen") is masked.
// NOVA_UPDATE_BASELINES=1 writes them (scripts/ui-test.sh tests/ui/fold-postures.test.ts).
const BASELINES = join(ROOT, 'tests/ui/baselines/fold');
const SHOTS: [string, { width: number; height: number }, string[]][] = [
  ['duo-cover', { width: 380, height: 900 }, ['/', '/chat', '/settings']],
  ['duo-inner', { width: 900, height: 1100 }, ['/', '/chat', '/settings']],
  ['duo-inner-landscape', { width: 1100, height: 900 }, ['/', '/chat']],
  // F8's own case: an inner screen under 840 px, where Settings drew three columns and crushed
  // the right one (the review's ipad-portrait posture measured the same).
  ['duo-inner-820', { width: 820, height: 1100 }, ['/', '/settings']],
];
const MASK = 'time, .greeting, .greeting-sub, .device-detail, .task-meta, .verified-result-card .card-line, .capture-chip';
// A pixel differs when a channel moves more than this; a picture differs when more than this share does.
const CHANNEL = 48;
const SHARE = 0.02;

function differs(a: Buffer, b: Buffer): { share: number; size: boolean } {
  const x = decodePng(a);
  const y = decodePng(b);
  if (x.width !== y.width || x.height !== y.height) return { share: 1, size: true };
  let n = 0;
  for (let i = 0, j = 0; i < x.data.length; i += x.channels, j += y.channels) {
    if (Math.abs(x.data[i]! - y.data[j]!) > CHANNEL || Math.abs(x.data[i + 1]! - y.data[j + 1]!) > CHANNEL || Math.abs(x.data[i + 2]! - y.data[j + 2]!) > CHANNEL) n++;
  }
  return { share: n / (x.width * x.height), size: false };
}

test('F8/F9 gate: the fold postures match their baselines (Chromium and WebKit)', { timeout: 600_000 }, async (t) => {
  const bs = await engines();
  if (typeof bs === 'string') return t.skip(bs);
  const { m, nova } = await reviewProfile('nova-fold-shots-');
  const update = process.env.NOVA_UPDATE_BASELINES === '1';
  mkdirSync(BASELINES, { recursive: true });
  const bad: string[] = [];
  try {
    for (const [engine, b] of bs) {
      for (const [posture, size, views] of SHOTS) {
        const d = await folded(b, { ...size, touch: true });
        // The review conversation is dated 2026-10-31 (axe-support.ts): the page's clock is held on
        // that day, so a run on a later day draws no "today" divider the baselines don't have.
        await d.page.clock.setFixedTime(new Date('2026-10-31T12:00:00.000Z'));
        for (const view of views) {
          await open(d.page, `${m.base}${view}`);
          const file = join(BASELINES, `${engine}-${posture}-${view === '/' ? 'home' : view.slice(1)}.png`);
          const png = await d.page.screenshot({ animations: 'disabled', caret: 'hide', mask: [d.page.locator(MASK)] });
          if (update || !existsSync(file)) {
            if (!update && process.env.CI) { bad.push(`${file}: no baseline (run with NOVA_UPDATE_BASELINES=1 and commit it)`); continue; }
            writeFileSync(file, png);
            record(`baseline written ${engine} ${posture} ${view}`, file.slice(ROOT.length + 1));
            continue;
          }
          const diff = differs(readFileSync(file), png);
          record(`baseline ${engine} ${posture} ${view}`, { share: Math.round(diff.share * 10000) / 100 });
          if (diff.size || diff.share > SHARE) {
            bad.push(`${engine} ${posture} ${view}: ${diff.size ? 'a different size' : `${(diff.share * 100).toFixed(2)}% of pixels differ (at most ${SHARE * 100}%)`}`);
            // What it looked like instead, beside the other evidence (the CI job uploads it).
            const dir = shotsDir();
            if (dir) writeFileSync(join(dir, `fold-actual-${engine}-${posture}-${view === '/' ? 'home' : view.slice(1)}.png`), png);
          }
        }
        await d.ctx.close();
      }
    }
    assert.deepEqual(bad, [], 'the fold postures match their baselines');
  } finally {
    for (const [, b] of bs) await b.close();
    await stop(nova);
  }
});

// ---- the iOS standalone safe area ---------------------------------------------------------------

// F8's screenshot (an installed app on the inner screen) showed a tall empty band at the top.
// Playwright can't run either engine as an installed app (no standalone display mode to emulate),
// and WebKit's safe-area insets are always 0. So: in WebKit, what the app itself adds at the top
// with no insets (nothing); in Chromium, which can report insets (DevTools' safe-area override, as
// an installed app with viewport-fit=cover gets them), that each inset is kept clear exactly once,
// never twice and never ignored, upright and on its side.
async function topBand(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('.shell')!;
    const cs = getComputedStyle(shell);
    const firstContent = [...document.querySelectorAll('#main .view-title, #main .greeting, #main .settings-search, #main input, #main .card')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).sort((a, b) => a.top - b.top)[0];
    const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
    const hits = (sel: string) => [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).checkVisibility()).map((e) => e.getBoundingClientRect());
    return {
      paddingTop: parseFloat(cs.paddingTop), paddingBottom: parseFloat(cs.paddingBottom), paddingLeft: parseFloat(cs.paddingLeft), paddingRight: parseFloat(cs.paddingRight),
      topbar: Math.round(topbar.height), firstContent: firstContent ? Math.round(firstContent.top) : null,
      controls: hits('#rail .nav-item, #rail .rail-home, #tabs .nav-item, #composer button, .topbar button, .topbar a').map((r) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) })),
      vw: innerWidth, vh: innerHeight,
    };
  });
}

test('F8: the iOS standalone safe area — no inset added twice, none ignored', { timeout: 300_000 }, async (t) => {
  const bs = await engines();
  if (typeof bs === 'string') return t.skip(bs);
  const { m, nova } = await reviewProfile('nova-fold-safe-');
  const bad: string[] = [];
  try {
    const [[, chromium], [, webkit]] = bs as [[string, Browser], [string, Browser]];
    // WebKit: no insets to report, so the app adds no top padding of its own.
    for (const [posture, size] of [['duo-inner', { width: 900, height: 1100 }], ['duo-cover', { width: 380, height: 900 }], ['iphone', { width: 390, height: 844 }]] as const) {
      const d = await folded(webkit, { ...size, touch: true });
      for (const view of ['/settings', '/chat', '/']) {
        await open(d.page, `${m.base}${view}`);
        const band = await topBand(d.page);
        record(`safe-area webkit ${posture} ${view}`, { paddingTop: band.paddingTop, topbar: band.topbar, firstContent: band.firstContent });
        if (band.paddingTop > 0) bad.push(`webkit ${posture} ${view}: ${band.paddingTop}px of top padding with no inset reported`);
      }
      await d.ctx.close();
    }
    // Chromium: an installed app on a notched phone and on the fold, upright and on its side.
    const INSETS: [string, { width: number; height: number }, { top: number; bottom: number; left: number; right: number }][] = [
      ['iphone standalone', { width: 390, height: 844 }, { top: 47, bottom: 34, left: 0, right: 0 }],
      ['duo-inner standalone', { width: 900, height: 1100 }, { top: 47, bottom: 34, left: 0, right: 0 }],
      ['duo-inner landscape standalone', { width: 1100, height: 900 }, { top: 0, bottom: 21, left: 47, right: 47 }],
    ];
    for (const [what, size, inset] of INSETS) {
      const d = await folded(chromium, { ...size, touch: true });
      const cdp = await d.ctx.newCDPSession(d.page);
      let emulated = true;
      // The check never passes by not running: a Chromium that can't report insets fails it.
      try { await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: inset } as never); } catch (e) { emulated = false; bad.push(`chromium ${what}: can't emulate safe-area insets (${(e as Error).message.split('\n')[0]})`); }
      for (const view of ['/settings', '/chat', '/']) {
        await open(d.page, `${m.base}${view}`);
        const band = await topBand(d.page);
        record(`safe-area chromium ${what} ${view}`, { paddingTop: band.paddingTop, paddingBottom: band.paddingBottom, paddingLeft: band.paddingLeft, paddingRight: band.paddingRight, topbar: band.topbar, firstContent: band.firstContent });
        if (!emulated) continue;
        // Each control clear of every inset: nothing under the status bar, the notch or the home indicator.
        for (const c of band.controls) {
          if (c.top < inset.top - 0.5 || c.bottom > band.vh - inset.bottom + 0.5 || c.left < inset.left - 0.5 || c.right > band.vw - inset.right + 0.5) bad.push(`chromium ${what} ${view}: a control at ${JSON.stringify(c)} sits in the safe-area inset`);
        }
        // And no inset kept clear twice.
        if (band.paddingTop > inset.top + 0.5) bad.push(`chromium ${what} ${view}: ${band.paddingTop}px kept clear at the top for a ${inset.top}px inset`);
      }
      await d.ctx.close();
    }
    assert.deepEqual(bad, [], 'the safe area');
  } finally {
    for (const [, b] of bs) await b.close();
    await stop(nova);
  }
});
