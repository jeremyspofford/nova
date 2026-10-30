// M9 gate, Core Web Vitals at p75 (Amendment 2026-10-30-C Part 2; UX-RESEARCH §2): LCP ≤ 2.5 s,
// INP ≤ 200 ms, CLS ≤ 0.1 on Home, chat, Tasks, Settings and Memory, at a phone's width (390×844,
// touch) and a desktop's (1280×820). Each run is a fresh page in a new browser context, against the
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
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { SIZES, VIEWS, seeded, settled } from './m9-support.ts';

const RUNS = Number(process.env.NOVA_VITALS_RUNS ?? 12);
const LIMIT = { lcp: 2500, inp: 200, cls: 0.1 };

function observe() {
  const v = { lcp: [] as number[][], shifts: [] as number[][], events: [] as number[][], firstInput: Infinity };
  (window as any).__v = v;
  const watch = (type: string, f: (e: any) => void, extra = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(f)).observe({ type, buffered: true, ...extra }); } catch { /* not supported */ } };
  watch('largest-contentful-paint', (e) => v.lcp.push([e.startTime]));
  watch('layout-shift', (e) => { v.shifts.push([e.startTime, e.value, e.hadRecentInput ? 1 : 0]); if (!e.hadRecentInput) ((v as any).moved ??= []).push(`${Math.round(e.startTime)} ms ${e.value.toFixed(3)}: ${(e.sources ?? []).map((x: any) => x.node?.id || x.node?.className || x.node?.nodeName).join(', ')}`); });
  watch('event', (e) => { if (e.interactionId) { v.events.push([e.interactionId, e.duration, e.startTime]); (v as any).names ??= {}; (v as any).names[e.interactionId] = `${e.name} on ${e.target?.id || e.target?.className || e.target?.tagName || '?'}`; } }, { durationThreshold: 16 });
  watch('first-input', (e) => { v.firstInput = Math.min(v.firstInput, e.startTime); });
}

function compute() {
  const v = (window as any).__v;
  const lcps = v.lcp.filter((x: number[]) => x[0]! < v.firstInput);
  const lcp = lcps.length ? lcps.at(-1)[0] : (v.lcp.at(-1)?.[0] ?? 0);
  let cls = 0;
  let win = 0;
  let first = 0;
  let last = 0;
  for (const [t, value, input] of v.shifts) {
    if (input) continue;
    if (win && t - last < 1000 && t - first < 5000) { win += value; last = t; } else { win = value; first = t; last = t; }
    cls = Math.max(cls, win);
  }
  const by = new Map<number, number>();
  for (const [id, d] of v.events) by.set(id, Math.max(by.get(id) ?? 0, d));
  const inp = Math.max(0, ...by.values());
  const worst = [...by].find(([, d]) => d === inp)?.[0];
  return { moved: (v.moved ?? []).join(' | '), lcp, cls, inp, interactions: by.size, worst: worst ? `${v.names?.[worst]} (${Math.round(inp)} ms)` : '' };
}

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
    await press('#input');
    await page.keyboard.type('Which bed gets the beans?', { delay: 30 });
    await press('#thread .msg-user .bubble');
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

const p75 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.75 * xs.length) - 1]!;

test('M9 gate, Core Web Vitals at p75: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, on the main views at phone and desktop widths', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-vitals-');
  const rows: string[] = ['| View | Width | Runs | LCP p75 | INP p75 | CLS p75 | Interactions per run |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const misses: string[] = [];
  try {
    for (const [size, vp] of SIZES) {
      for (const view of Object.keys(VIEWS)) {
        const runs: { lcp: number; cls: number; inp: number; interactions: number; worst: string; moved: string }[] = [];
        for (let i = 0; i < RUNS; i++) {
          const d = await device(b, { ...vp, touch: size === 'phone' });
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
        rows.push(`| ${view} | ${size} ${vp.width}×${vp.height} | ${RUNS} | ${Math.round(r.lcp)} ms | ${r.inp ? `${Math.round(r.inp)} ms` : '< 16 ms'} | ${r.cls.toFixed(3)} | ${n}–${Math.max(...runs.map((x) => x.interactions))} |`);
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
