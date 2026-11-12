// W-12 (UI walker, 2026-11-11): nothing on Automations moves when its rules arrive after the page
// is up, and the schedules are never kept back for long while they wait for the rules. The walker
// measured CLS 0.008–0.025 there against a live Nova: the Rules panel waits with a one-line
// "Loading rules…", the schedules below it were drawn as soon as they were read, and when the rules
// came in (a two-line "No rules yet" or a list) the panel grew and pushed the schedules down. A
// server on loopback answers before the view's entrance has finished, so the shift goes unseen;
// here the rules are held back LATE_MS, past the entrance.
//
// The fix holds the schedules until the rules settle, for at most QUIET_MS (1 s, wait.js) after the
// view opens; then they are drawn anyway (app.js showSchedules). So:
//   1. rules late, within the bound: CLS 0 in every run (Chromium, the M9 method), and in WebKit
//      the schedules' top never moves once shown;
//   2. rules that never answer: the schedules still appear, about QUIET_MS after the view opens,
//      while the Rules panel still waits, not at the 15 s a read with no answer is given up;
//   3. rules answering at once: the schedules show with the rules, within QUICK_MS of the view
//      opening. That is the hold's cost: before the fix they showed with the view (+0 ms); after,
//      when the rules settle, +24 to +56 ms here (2026-11-12, Docker UI gate, both engines), inside
//      the view's own entrance. Rules later than QUIET_MS are not held for (2): they may move them.
//
// Measured as the M9 gate measures (vitals-support.ts; m9-vitals.test.ts): its two widths, a phone
// at 390×844 with touch and its CPU slowed 4× through CDP, and a desktop at 1280×820; a fresh
// context per run; CLS the largest session window of shifts without recent input; p75 of
// NOVA_VITALS_RUNS (12) runs. The M9 limit is 0.1 and Automations met it before this fix (0.023 at
// the phone, 0.003 at the desktop, p75, rules 1.5 s late), so this holds the page to what it is
// meant to do: no shift at all. Service workers are blocked so the held-back read is the page's
// own (a worker's fetch would go around the delay); layout is the same either way.
// WebKit has no layout-shift entries, so it holds the same thing by geometry (offsetTop: the
// entrance's translate is not a move).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, webkitBrowser } from './support.ts';
import { observe, compute, p75 } from './vitals-support.ts';
import { SIZES, seeded } from './m9-support.ts';
import { QUIET_MS } from '../../ui/js/wait.js';

const RUNS = Number(process.env.NOVA_VITALS_RUNS ?? 12);
// Late, but inside the hold's bound (QUIET_MS after the view opens; the view opens ~0.2 s in).
const LATE_MS = 700;
// Quick rules: the schedules within this of the view opening (measured +24 to +56 ms; room for CI).
const QUICK_MS = 250;
const RULES = '**/api/v1/triggers/rules';

const lateRules = (ctx: BrowserContext) => ctx.route(RULES, async (route) => {
  await new Promise((r) => setTimeout(r, LATE_MS));
  await route.continue();
});
// A rules read that never answers: no response, no error (the page gives it up at NO_ANSWER_MS).
const hungRules = (ctx: BrowserContext) => ctx.route(RULES, () => new Promise<void>(() => {}));

// In-page times (performance.now) of: the view opening (the Rules panel first drawn), the schedules
// first showing anything, and the rules settling (no waiting line in the panel); and the schedules'
// layout top in every frame they had something in them.
function track() {
  const t: Record<string, number> = {};
  const tops: number[] = [];
  (window as any).__w12 = { t, tops };
  const frame = () => {
    const now = performance.now();
    const panel = document.querySelector('#rules .panel');
    const s = document.getElementById('schedules');
    if (panel && t.view === undefined) t.view = now;
    if (panel && !panel.querySelector('.waiting') && t.rules === undefined) t.rules = now;
    if (s && document.body.dataset.shown !== undefined && s.childElementCount && s.offsetHeight) {
      if (t.schedules === undefined) { t.schedules = now; t.rulesWaitingThen = panel?.querySelector('.waiting') ? 1 : 0; }
      tops.push(s.offsetTop);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function settled(page: Page) {
  await page.waitForSelector('html[data-ready]');
  await page.waitForFunction(() => !document.querySelector('#automations .waiting') && !!document.querySelector('#automations #rules .panel') && !!document.querySelector('#schedules .memory-section'), null, { timeout: 15_000 });
  await page.waitForTimeout(500);
}

const ENGINES = [['chromium', browser], ['webkit', webkitBrowser]] as const;

test(`W-12: Automations, rules ${LATE_MS} ms late, CLS 0 at p75 and in every run (M9 method, phone CPU 4× and desktop)`, { timeout: 600_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-w12-cls-');
  const rows: string[] = [];
  const moved: string[] = [];
  try {
    for (const [size, vp] of SIZES) {
      const cls: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const d = await device(b, { ...vp, touch: size === 'phone', serviceWorkers: 'block' });
        if (size === 'phone') await (await d.ctx.newCDPSession(d.page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await d.ctx.addInitScript(observe);
        await lateRules(d.ctx);
        await d.page.goto(`${m.base}/automations`);
        await settled(d.page);
        const r = await d.page.evaluate(compute);
        cls.push(r.cls);
        if (r.cls > 0) moved.push(`${size} run ${i + 1}: CLS ${r.cls.toFixed(4)} (${r.moved})`);
        assert.deepEqual(d.errors, [], `${size}, run ${i + 1}: no errors in the page`);
        await d.ctx.close();
      }
      rows.push(`${size} ${vp.width}×${vp.height}${size === 'phone' ? ', CPU 4×' : ''}: CLS p75 ${p75(cls).toFixed(4)}, max ${Math.max(...cls).toFixed(4)} over ${RUNS} runs`);
    }
    console.log(`Automations, rules ${LATE_MS} ms late:\n${rows.join('\n')}`);
    assert.deepEqual(moved, [], 'nothing on Automations moves when the rules arrive');
  } finally {
    await b.close();
    await stop(nova);
  }
});

for (const [engine, launch] of ENGINES) {
  test(`W-12: ${engine}, Automations: schedules never move with rules ${LATE_MS} ms late, still appear about 1 s in when the rules never answer, and show with quick rules`, { timeout: 300_000 }, async (t) => {
    const b = await launch();
    if (typeof b === 'string') return t.skip(b);
    const { m, nova } = await seeded(`nova-w12-${engine}-`);
    const moved: string[] = [];
    const lines: string[] = [];
    try {
      for (const [size, vp] of SIZES) {
        for (const kind of ['late', 'hung', 'quick'] as const) {
          for (let i = 0; i < 3; i++) {
            const d = await device(b, { ...vp, touch: size === 'phone', serviceWorkers: 'block' });
            await d.ctx.addInitScript(track);
            if (kind === 'late') await lateRules(d.ctx);
            if (kind === 'hung') await hungRules(d.ctx);
            await d.page.goto(`${m.base}/automations`);
            if (kind === 'hung') {
              await d.page.waitForFunction(() => (window as any).__w12.t.schedules !== undefined, null, { timeout: 10_000 });
              await d.page.waitForSelector('#schedules .memory-section');
            } else await settled(d.page);
            const w = await d.page.evaluate(() => (window as any).__w12);
            const after = Math.round(w.t.schedules - w.t.view);
            lines.push(`${size} ${kind} run ${i + 1}: view at ${Math.round(w.t.view)} ms, schedules at ${Math.round(w.t.schedules)} ms (+${after} ms), rules settled ${w.t.rules === undefined ? 'not yet' : `at ${Math.round(w.t.rules)} ms`}`);
            if (kind === 'late') {
              const distinct = [...new Set(w.tops)];
              if (distinct.length > 1) moved.push(`${size} run ${i + 1}: schedules' top ${distinct.join(' → ')}`);
            }
            if (kind === 'hung') {
              assert.equal(w.t.rulesWaitingThen, 1, `${size}, run ${i + 1}: the rules were still on their way when the schedules showed`);
              assert.ok(after <= QUIET_MS + 1000, `${size}, run ${i + 1}: with the rules never answering, the schedules showed ${after} ms after the view opened (bound ${QUIET_MS} ms, a second's slack for a busy machine)`);
            }
            if (kind === 'quick') {
              // Before the fix the schedules were drawn as soon as they were read, whatever the rules
              // did; now they wait for the rules (3 in the header): with them, and soon after the view.
              assert.ok(w.t.rules !== undefined && w.t.schedules <= w.t.rules + 50, `${size}, run ${i + 1}: with quick rules the schedules show with the rules (schedules at ${Math.round(w.t.schedules)} ms, rules at ${Math.round(w.t.rules)} ms)`);
              assert.ok(after <= QUICK_MS, `${size}, run ${i + 1}: with quick rules the schedules showed ${after} ms after the view opened (at most ${QUICK_MS} ms)`);
            }
            assert.deepEqual(d.errors, [], `${size}, ${kind}, run ${i + 1}: no errors in the page`);
            await d.ctx.close();
          }
        }
      }
      console.log(`${engine}, Automations timings:\n${lines.join('\n')}`);
      assert.deepEqual(moved, [], 'the schedules stay where they first showed');
    } finally {
      await b.close();
      await stop(nova);
    }
  });
}
