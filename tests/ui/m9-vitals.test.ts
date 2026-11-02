// M9 gate, Core Web Vitals at p75 (Amendment 2026-10-30-C Part 2; UX-RESEARCH §2): LCP ≤ 2.5 s,
// INP ≤ 200 ms, CLS ≤ 0.1 on Home, chat, Tasks, Settings and Memory, at a phone's width (390×844,
// touch, its CPU slowed 4× through CDP, as a mid-range phone) and a desktop's (1280×820). Each run is a fresh page in a new browser context, against the
// real server with a profile that has something in it; 12 runs per view and width, and p75 is the
// nearest-rank 75th percentile (the 9th of 12). Measured as web-vitals does, with
// PerformanceObserver:
//   LCP  the last largest-contentful-paint before the first input;
//   CLS  the largest session window (gaps under 1 s, at most 5 s) of layout shifts, leaving out
//        those within 500 ms of input (hadRecentInput);
//   INP  the longest interaction (event timing, grouped by interactionId, durationThreshold 16 ms;
//        under 50 interactions, so none is dropped as an outlier), from real, trusted input.
// The numbers are printed for the evidence (docs/evidence/m9-gate.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { ROOT, stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { observe, compute, p75 } from './vitals-support.ts';
import { SIZES, VIEWS, seeded, settled } from './m9-support.ts';

const RUNS = Number(process.env.NOVA_VITALS_RUNS ?? 12);
const LIMIT = { lcp: 2500, inp: 200, cls: 0.1 };

// Real use of each view, through Playwright's (trusted) input: then a move to another view, whose
// drawing is part of that interaction.
async function use(page: Page, view: string, touch: boolean) {
  const press = async (sel: string) => { const l = page.locator(sel).filter({ visible: true }).first(); if (touch) await l.tap(); else await l.click(); };
  const nav = async (dest: string) => press(`#rail [data-dest="${dest}"], #tabs [data-dest="${dest}"]`);
  if (view === 'home') {
    const open = '#home [data-action="open-task"], #home [data-action="evidence"]';
    await press(open);
    await page.waitForSelector('#sheet[open]');
    await page.keyboard.press('Escape');
    await nav('tasks');
  } else if (view === 'chat') {
    await press('#thread .msg-user .bubble');
    // A message sent, and measured through Nova's reply streaming in (a model that thinks briefly,
    // then writes in pieces), until it is done.
    await press('#input');
    await page.keyboard.type('Which bed gets the beans?', { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /the peas go first/.test(document.getElementById('thread')?.textContent ?? '') && document.getElementById('send')?.getAttribute('aria-label') === 'Send', null, { timeout: 20000 });
    await nav('home');
  } else if (view === 'tasks') {
    await press('#tasks-view [data-action="open-task"]');
    await page.waitForSelector('#sheet[open]');
    await page.keyboard.press('Escape');
    await nav('memory');
  } else if (view === 'settings') {
    await press('#settings-search');
    await page.keyboard.type('theme', { delay: 30 });
    await page.waitForSelector('#settings-results .settings-result');
    await press('#settings-results .settings-result');
    await nav('home');
  } else if (view === 'memory') {
    await press('#memory .memory-item .memory-text');
    await page.keyboard.press('Escape');
    await nav('chat');
  }
  await page.waitForTimeout(300);
}


test('M9 gate, Core Web Vitals at p75: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, on the main views at phone and desktop widths', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-vitals-', { NOVA_AGENT_CMD: `THINK_MS=400 node ${join(ROOT, 'tests/ui/m9-thinker.js')}`, NOVA_AGENT_EGRESS: 'none' });
  const rows: string[] = ['| View | Width | Runs | LCP p75 | INP p75 | CLS p75 | Interactions per run |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const misses: string[] = [];
  try {
    for (const [size, vp] of SIZES) {
      for (const view of Object.keys(VIEWS)) {
        const runs: { lcp: number; cls: number; inp: number; interactions: number; worst: string; moved: string }[] = [];
        for (let i = 0; i < RUNS; i++) {
          const d = await device(b, { ...vp, touch: size === 'phone' });
          // A phone's CPU: 4× slower than this machine's (Chrome DevTools' mid-range mobile setting).
          if (size === 'phone') await (await d.ctx.newCDPSession(d.page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
          await d.ctx.addInitScript(observe);
          await d.page.goto(`${m.base}${VIEWS[view]}`);
          await settled(d.page, view);
          await d.page.waitForTimeout(500);
          await use(d.page, view, size === 'phone');
          runs.push(await d.page.evaluate(compute));
          assert.deepEqual(d.errors, [], `${size}, ${view}, run ${i + 1}: no errors in the page`);
          await d.ctx.close();
        }
        const r = { lcp: p75(runs.map((x) => x.lcp)), inp: p75(runs.map((x) => x.inp)), cls: p75(runs.map((x) => x.cls)) };
        const n = Math.min(...runs.map((x) => x.interactions));
        rows.push(`| ${view} | ${size} ${vp.width}×${vp.height}${size === 'phone' ? ', CPU 4×' : ''} | ${RUNS} | ${Math.round(r.lcp)} ms | ${r.inp ? `${Math.round(r.inp)} ms` : '< 16 ms'} | ${r.cls.toFixed(3)} | ${n}–${Math.max(...runs.map((x) => x.interactions))} |`);
        assert.ok(n >= 2, `${size}, ${view}: real interactions were measured (${n})`);
        if (r.lcp > LIMIT.lcp) misses.push(`${size}, ${view}: LCP p75 ${Math.round(r.lcp)} ms`);
        if (r.inp > LIMIT.inp) misses.push(`${size}, ${view}: INP p75 ${Math.round(r.inp)} ms (slowest: ${runs.map((x) => x.worst).join('; ')})`);
        if (r.cls > LIMIT.cls) misses.push(`${size}, ${view}: CLS p75 ${r.cls.toFixed(3)} (${runs.map((x) => x.moved).join(' / ')})`);
        if (r.cls > 0) console.log(`${size}, ${view} shifts: ${runs[0]!.moved}`);
      }
    }
    console.log(`Core Web Vitals, p75 of ${RUNS} runs each:\n${rows.join('\n')}`);
    assert.deepEqual(misses, [], 'every view, at both widths, within the gate');
  } finally {
    await b.close();
    await stop(nova);
  }
});
