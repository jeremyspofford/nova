// The orb's fixed semantic states (DESIGN-SYSTEM §1; owner decision 2026-10-31), in the real PWA:
// every installed design system, light and dark, with and without reduced motion, draws all seven
// states so that no two look alike once colour is taken away, and stopped unlike any other.
//
// "Colour taken away": each orb's colours are forced to one grey (the custom properties a state's
// colour reaches the orb through), and the orbs are compared in luminance only. Two states that
// differed by hue alone would then be pixel-for-pixel the same. With motion, every animation is
// paused at the same moments and the orbs are compared frame by frame, so a difference in motion
// counts; under reduced motion nothing moves, and the still orbs must differ by brightness pattern.
// Each comparison prints its numbers (`ORB …` lines) for the record in docs/plans/orb-states.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { decodePng } from '../../src/core/browser/png.ts';
import { ORB_STATES } from '../../src/core/index.ts';
import { browser } from './support.ts';
import { seeded } from './m9-support.ts';

const record = (what: string, v: unknown) => console.log(`ORB ${what} ${JSON.stringify(v)}`);
const round = (n: number) => Math.round(n * 10000) / 10000;
// Moments every animation is paused at, with motion: across one beat of the longest pattern.
const FRAMES = [0, 300, 600, 900, 1200, 1500, 1800, 2400, 3000, 3600];
// The least luminance difference (0–1, a cell grid's mean absolute difference) that counts as two
// states looking different. Two renders of the same state differ by 0 (the renders are
// deterministic); the closest pairs of built-in states are printed on every run (`ORB least`).
const DIFFERENT = 0.004;
// Stopped must be further from its nearest state than the least the check demands.
const STOPPED_APART = 2 * DIFFERENT;
const GRID = 12;

// Lays out one rail-sized orb per state, apart from each other on the page's own background.
async function stage(page: Page, grey: boolean) {
  await page.evaluate(([states, g]) => {
    document.getElementById('orb-stage')?.remove();
    const st = document.createElement('div');
    st.id = 'orb-stage';
    st.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-wrap:wrap;align-content:flex-start;gap:96px;padding:96px;background:var(--bg-base)';
    for (const s of states as string[]) {
      const o = document.createElement('span');
      o.className = 'orb orb-rail';
      o.dataset.state = s;
      o.innerHTML = '<span class="orb-glow"></span><span class="orb-core"></span><span class="orb-swirl"></span><span class="orb-sheen"></span>';
      st.append(o);
    }
    document.body.append(st);
    document.getElementById('orb-grey')?.remove();
    if (g) {
      const css = document.createElement('style');
      css.id = 'orb-grey';
      // One grey for every state: what is left to tell them apart isn't hue.
      css.textContent = '#orb-stage .orb { --orb-c: #8a8a8a !important; --orb-g: rgba(138, 138, 138, 0.45) !important; --orb-hi: #b4b4b4 !important; }';
      document.head.append(css);
    }
  }, [[...ORB_STATES] as string[], grey] as [string[], boolean]);
}

// Every orb's luminance as a GRID×GRID grid of cell means, from one screenshot of the stage.
async function frame(page: Page): Promise<Record<string, number[]>> {
  const boxes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#orb-stage .orb')].map((o) => {
    const r = o.getBoundingClientRect();
    return { state: o.dataset.state!, x: r.x, y: r.y, w: r.width };
  }));
  const img = decodePng(await page.screenshot());
  const scale = img.width / page.viewportSize()!.width;
  const out: Record<string, number[]> = {};
  for (const b of boxes) {
    // The orb, its mark and most of its glow.
    const pad = b.w * 0.8;
    const x0 = (b.x - pad) * scale;
    const y0 = (b.y - pad) * scale;
    const side = (b.w + 2 * pad) * scale;
    const cells = new Array(GRID * GRID).fill(0);
    const counts = new Array(GRID * GRID).fill(0);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const px = Math.round(x0 + x);
        const py = Math.round(y0 + y);
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
        const i = (py * img.width + px) * img.channels;
        const l = (0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!) / 255;
        const c = Math.min(GRID - 1, Math.floor((y / side) * GRID)) * GRID + Math.min(GRID - 1, Math.floor((x / side) * GRID));
        cells[c] += l;
        counts[c]++;
      }
    }
    out[b.state] = cells.map((v, k) => v / Math.max(1, counts[k]));
  }
  return out;
}

const diff = (a: number[], b: number[]) => a.reduce((s, v, k) => s + Math.abs(v - b[k]!), 0) / a.length;

// Pauses every animation on the page at `t` ms (all at the same moment), so frames can be compared.
const at = (page: Page, t: number) => page.evaluate((ms) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } }, t);

// The orbs' look with motion: a frame per moment. Under reduced motion: one still frame (nothing
// may be running, which is checked).
async function looks(page: Page, reduced: boolean): Promise<Record<string, number[][]>> {
  const out: Record<string, number[][]> = Object.fromEntries(ORB_STATES.map((s) => [s, []]));
  for (const t of reduced ? [0] : FRAMES) {
    if (!reduced) await at(page, t);
    const f = await frame(page);
    for (const s of ORB_STATES) out[s]!.push(f[s]!);
  }
  return out;
}

const apart = (a: number[][], b: number[][]) => a.reduce((s, f, k) => s + diff(f, b[k]!), 0) / a.length;

// The channels a state shows that aren't colour, as the page computed them: what the glow and the
// swirl run, and the mark around the orb.
const channels = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('#orb-stage .orb')].map((o) => {
  const glow = getComputedStyle(o.querySelector('.orb-glow')!);
  const swirl = getComputedStyle(o.querySelector('.orb-swirl')!);
  const me = getComputedStyle(o);
  return [o.dataset.state!, { glow: `${glow.animationName} ${glow.animationDuration} ${glow.animationTimingFunction}`, swirl: swirl.animationName, mark: me.outlineStyle, filter: me.filter, running: o.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length }];
})));

test('the orb’s seven states differ in more than colour, and stopped is unmistakable, in every design system', { timeout: 600_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-orb-states-');
  const bad: string[] = [];
  const least = { moving: Infinity, still: Infinity, stopped: Infinity };
  try {
    for (const reduced of [false, true]) {
      const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
      const page = await ctx.newPage();
      await page.goto(`${m.base}/styleguide`);
      await page.locator('#sg-ds').waitFor();
      // Every installed design system the style reference can show.
      const designs = await page.$$eval('#sg-ds option', (os) => os.map((o) => (o as HTMLOptionElement).value));
      assert.ok(designs.length >= 6, `the installed design systems: ${designs.join(', ')}`);
      for (const ds of designs) {
        for (const mode of ['light', 'dark']) {
          await page.selectOption('#sg-ds', ds);
          await page.selectOption('#sg-mode', mode);
          await page.waitForFunction(([d, mo]) => (document.getElementById('ds')?.textContent ?? '').includes(`(${d}), mode ${mo}`), [ds, mode]);
          const where = `${ds} ${mode}${reduced ? ' reduced-motion' : ''}`;

          // With colour taken away, every pair of states still looks different.
          await stage(page, true);
          await page.waitForTimeout(150);
          const ch = await channels(page);
          const grey = await looks(page, reduced);
          const pairs: Record<string, number> = {};
          for (let i = 0; i < ORB_STATES.length; i++) {
            for (let j = i + 1; j < ORB_STATES.length; j++) {
              const [a, c] = [ORB_STATES[i]!, ORB_STATES[j]!];
              const d = apart(grey[a]!, grey[c]!);
              pairs[`${a}~${c}`] = round(d);
              least[reduced ? 'still' : 'moving'] = Math.min(least[reduced ? 'still' : 'moving'], d);
              if (!(d >= DIFFERENT)) bad.push(`${where}: ${a} and ${c} look alike without colour (${round(d)}, want ≥ ${DIFFERENT})`);
            }
          }
          record(`${where} pairs`, pairs);
          // Stopped is unmistakable: well apart from its nearest state, without colour.
          const near = Math.min(...ORB_STATES.filter((s) => s !== 'stopped').map((s) => apart(grey.stopped!, grey[s]!)));
          least.stopped = Math.min(least.stopped, near);
          if (!(near >= STOPPED_APART)) bad.push(`${where}: stopped is only ${round(near)} from its nearest state without colour (want ≥ ${STOPPED_APART})`);
          // …and in the channels themselves: its motion and its mark are its own.
          for (const s of ORB_STATES.filter((x) => x !== 'stopped')) {
            if (ch[s]!.mark === ch.stopped!.mark) bad.push(`${where}: ${s} has stopped’s mark (${ch.stopped!.mark})`);
            if (!reduced && ch[s]!.glow === ch.stopped!.glow) bad.push(`${where}: ${s} moves like stopped (${ch.stopped!.glow})`);
          }
          // Reduced motion: nothing on the orb runs; its equivalent is the still look above.
          if (reduced) for (const s of ORB_STATES) if (ch[s]!.running) bad.push(`${where}: ${s} still has ${ch[s]!.running} animation(s) running under reduced motion`);
          record(`${where} channels`, ch);

          // With its own colours, stopped also differs from every other state (the colour is red,
          // which no other state may take).
          await stage(page, false);
          await page.waitForTimeout(150);
          const lit = await looks(page, reduced);
          const nearLit = Math.min(...ORB_STATES.filter((s) => s !== 'stopped').map((s) => apart(lit.stopped!, lit[s]!)));
          if (!(nearLit >= STOPPED_APART)) bad.push(`${where}: in colour, stopped is only ${round(nearLit)} from its nearest state`);
          if (!reduced) await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
        }
      }
      await ctx.close();
    }
    record('least', Object.fromEntries(Object.entries(least).map(([k, v]) => [k, round(v)])));
    assert.deepEqual(bad, [], 'every state differs from every other in more than colour, and stopped is unmistakable');
  } finally {
    await b.close();
    await stop(nova);
  }
});
