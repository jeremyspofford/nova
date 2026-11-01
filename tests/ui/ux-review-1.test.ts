// The first UX review (2026-10-31), in the real PWA: the composer keeps its shape however much is
// typed (F0); the Health card says what's wrong in human terms, the path stays in Health (F1); the
// rail's labels stay inside the rail, in every design system (F2); the orb is a luminous sphere,
// lit and glowing, in every state and design system (F3). Each test prints what it measured
// (`UX1 …` lines) for the before/after record in docs/plans/ux-review-1.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { decodePng } from '../../src/core/browser/png.ts';
import { browser, device, ready } from './support.ts';
import { CHAT, seeded, settled } from './m9-support.ts';
import { reviewProfile } from './axe-support.ts';

const record = (what: string, v: unknown) => console.log(`UX1 ${what} ${JSON.stringify(v)}`);
// What the review typed (nova-qa/harness/ux-composer.mjs): one short line, five long ones, twenty.
const LONG = 'This is a long line of text meant to see how the composer grows when a user writes a full paragraph into the chat box.';
const LINE = 'Paragraph of a very long prompt that keeps going and going with detailed instructions about many things at once.';
const TYPED: [number, string][] = [[1, 'short one line'], [5, Array(5).fill(LONG).join('\n')], [20, Array(20).fill(LINE).join('\n')]];

// ---- F0: the composer ---------------------------------------------------------------------------

// The composer's geometry, as the review measured it: its height, the radius it is drawn with
// (a pill's 999px is drawn as half the height), whether the field scrolls inside, where the text
// starts, and whether the controls and the conversation stay in view.
function composerGeometry(page: Page) {
  return page.evaluate(() => {
    const f = document.getElementById('composer')!;
    const ta = document.getElementById('input') as HTMLTextAreaElement;
    const r = f.getBoundingClientRect();
    const tr = ta.getBoundingClientRect();
    const s = document.getElementById('scroller')!.getBoundingClientRect();
    const cs = getComputedStyle(f);
    const radius = Math.min(Number.parseFloat(cs.borderTopLeftRadius), r.height / 2, r.width / 2);
    const inside = (id: string) => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return b.width > 0 && b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5 && b.bottom <= innerHeight && b.top >= 0;
    };
    return {
      vh: innerHeight,
      height: Math.round(r.height),
      share: Math.round((r.height / innerHeight) * 1000) / 10,
      radius: Math.round(radius * 10) / 10,
      radiusToken: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-input')),
      scrolls: ta.scrollHeight > ta.clientHeight + 1,
      insetLeft: Math.round(tr.left - r.left),
      insetTop: Math.round(tr.top - r.top),
      // How far the curve of the drawn corner reaches in at 45°, against where the text starts.
      cornerCut: Math.round(radius * (1 - Math.SQRT1_2)),
      overlap: Math.max(0, Math.round(s.bottom - r.top)),
      conversation: Math.round(s.height),
      send: inside('send'),
      mic: inside('mic'),
    };
  });
}

for (const [name, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`F0: the composer keeps its shape with 1, 5 and 20 lines (${name}, ${size.width}×${size.height})`, { timeout: 180_000 }, async (t) => {
    const b = await browser();
    if (typeof b === 'string') return t.skip(b);
    const { m, nova } = await seeded(`nova-ux1-f0-${name}-`);
    try {
      const { page, errors } = await device(b, size);
      await page.goto(`${m.base}/c/${CHAT}`);
      await settled(page, 'chat');
      const input = page.locator('#input');
      const one = await composerGeometry(page);
      const seen: [number, Awaited<ReturnType<typeof composerGeometry>>][] = [];
      for (const [n, text] of TYPED) {
        await input.fill(text);
        seen.push([n, await composerGeometry(page)]);
      }
      for (const [n, g] of seen) record(`F0 ${name} ${n}-line${n === 1 ? '' : 's'}`, g);
      for (const [n, g] of seen) {
        // Capped at 25–30% of the viewport; past it the field scrolls inside.
        assert.ok(g.share <= 30, `${n} lines: the composer is ${g.height}px, ${g.share}% of a ${g.vh}px viewport (cap 30%)`);
        // A grown composer keeps the input radius; the pill is only for one line.
        if (g.height > one.height + 2) assert.equal(g.radius, g.radiusToken, `${n} lines: drawn with the input radius (${g.radiusToken}px), not ${g.radius}px`);
        else assert.ok(g.radius <= one.height / 2 + 0.5, `${n} line: a pill no rounder than its height`);
        // The text starts clear of the curve; the controls and the conversation stay in view.
        assert.ok(g.insetLeft >= g.cornerCut && g.insetTop >= g.cornerCut, `${n} lines: the text starts inside the curve (inset ${g.insetLeft}/${g.insetTop}px, curve ${g.cornerCut}px)`);
        assert.ok(g.send && g.mic, `${n} lines: Send and the microphone are in view, inside the composer`);
        assert.equal(g.overlap, 0, `${n} lines: the composer doesn't cover the conversation`);
        assert.ok(g.conversation >= g.vh * 0.4, `${n} lines: the conversation keeps ${g.conversation}px of ${g.vh}px`);
        if (n === 20) assert.ok(g.scrolls, '20 lines: past the cap the field scrolls inside');
      }
      // Sent or cleared, the composer is a pill again.
      await input.fill('');
      assert.equal((await composerGeometry(page)).height, one.height, 'empty again: back to one line');
      assert.deepEqual(errors, []);
    } finally {
      await b.close();
      await stop(nova);
    }
  });
}

// ---- F1: the Health card ------------------------------------------------------------------------

test('F1: the Health card says what is wrong in human terms; the technical message stays in Health', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await reviewProfile('nova-ux1-f1-');
  try {
    const problems = await m.get('/api/v1/problems?open=1') as { message: string }[];
    assert.ok(problems.length >= 1, 'the profile has an open problem');
    const { page } = await device(b, { width: 1366, height: 768 });
    for (const path of ['/', '/tasks']) {
      await page.goto(m.base + path);
      await ready(page);
      const lead = page.locator('.health-card:visible .card-lead').first();
      await lead.waitFor({ timeout: 15000 });
      const cardText = await page.locator('.health-card:visible').first().innerText();
      record(`F1 card ${path}`, cardText.replace(/\s+/g, ' ').trim());
      assert.match(cardText, /problems? to look at/);
      assert.doesNotMatch(cardText, /\w\/\w|\\|\.(sqlite|wal|json|md|log|db|ts|js|txt)\b|\bat \S+ \(/i, `${path}: no path, file name or stack on the card`);
      for (const p of problems) assert.ok(!cardText.includes(p.message.slice(0, 30)), `${path}: the card doesn't repeat the raw message`);
    }
    await page.goto(`${m.base}/health`);
    await ready(page);
    await page.locator('#health-view .settings-list').first().waitFor();
    const health = await page.locator('#health-view').textContent() ?? '';
    for (const p of problems) assert.ok(health.includes(p.message.slice(0, 30)), 'Health itself shows the full message');
  } finally {
    await b.close();
    await stop(nova);
  }
});

// ---- F2 and F3: across the design systems -------------------------------------------------------

const DESIGNS = ['orb-teal', 'companion-light', 'nova', 'obsidian', 'aurora', 'paper'];

test('F2: every rail label stays inside the rail, in every design system, even a long one', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-ux1-f2-');
  const bad: string[] = [];
  try {
    for (const [name, size] of [['laptop', { width: 1366, height: 768 }], ['desktop', { width: 1920, height: 1080 }], ['tablet', { width: 820, height: 1180 }]] as const) {
      const d = await device(b, size);
      for (const ds of DESIGNS) {
        assert.equal((await m.send('POST', `/api/v1/design-systems/${ds}/apply`, { scope: 'device', device_id: d.id })).status, 200);
        await d.page.goto(`${m.base}/chat`);
        await ready(d.page);
        await d.page.locator('#rail .nav-item').first().waitFor();
        const fits = () => d.page.evaluate(() => {
          const rail = document.getElementById('rail')!.getBoundingClientRect();
          return [...document.querySelectorAll('#rail .nav-item')].map((el) => {
            const r = el.getBoundingClientRect();
            const label = el.querySelector('.nav-label') as HTMLElement | null;
            const l = label?.getBoundingClientRect();
            return {
              label: label?.textContent ?? '',
              width: Math.round(r.width),
              inRail: r.left >= rail.left - 0.5 && r.right <= rail.right + 0.5,
              labelFits: !label || (label.scrollWidth <= label.clientWidth + 1 && l!.left >= r.left - 0.5 && l!.right <= r.right + 0.5),
            };
          });
        });
        const railWidth = await d.page.evaluate(() => Math.round(document.getElementById('rail')!.getBoundingClientRect().width));
        const items = await fits();
        record(`F2 ${name} ${ds} rail ${railWidth}`, items.map((i) => `${i.label}:${i.width}${i.inRail && i.labelFits ? '' : ' OVERFLOWS'}`));
        for (const i of items) if (!(i.inRail && i.labelFits)) bad.push(`${name} ${ds}: “${i.label}” overflows the rail`);
        // The rule holds for a label longer than any today: it wraps inside the rail.
        await d.page.evaluate(() => { const l = document.querySelector('#rail [data-dest="automations"] .nav-label'); if (l) l.textContent = 'Housekeeping and automations'; });
        for (const i of await fits()) if (!(i.inRail && i.labelFits)) bad.push(`${name} ${ds}: a long label (“${i.label}”) overflows the rail`);
      }
      await d.ctx.close();
    }
    assert.deepEqual(bad, [], 'every rail label stays inside the rail');
  } finally {
    await b.close();
    await stop(nova);
  }
});

// The orb at the rail's size, from a screenshot: is it lit like a sphere (a highlight on the lit
// side, and shade toward the far edge: a flat disc has neither), and does its glow reach past the
// disc and fall off (measured above it; the swatch's name sits below). Luminance 0–1; the glow as a
// colour distance from the page around it.
const lum = (p: number[]) => (0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!) / 255;
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) / 255;
const round = (n: number) => Math.round(n * 1000) / 1000;
async function orbLight(page: Page, state: string) {
  const orb = page.locator(`#ux1-stage .orb[data-state="${state}"]`);
  const box = (await orb.boundingBox())!;
  const pad = box.width;
  const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad };
  const img = decodePng(await page.screenshot({ clip }));
  const scale = img.width / clip.width;
  const at = (x: number, y: number) => {
    const i = (Math.round((y - clip.y) * scale) * img.width + Math.round((x - clip.x) * scale)) * img.channels;
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
  };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = box.width / 2;
  const mean = (ps: number[][]) => [0, 1, 2].map((c) => ps.reduce((s, p) => s + p[c]!, 0) / ps.length);
  // Above the orb only: the half-ring from left to right over the top.
  const ring = (k: number) => [0, 1, 2, 3, 4].map((a) => at(cx + Math.cos(Math.PI + (a * Math.PI) / 4) * r * k, cy + Math.sin(Math.PI + (a * Math.PI) / 4) * r * k));
  const lit = lum(at(cx - r * 0.35, cy - r * 0.4));
  const middle = lum(at(cx, cy));
  const far = lum(at(cx + r * 0.62, cy + r * 0.62));
  const page0 = mean([at(clip.x + 2, clip.y + 2), at(clip.x + clip.width - 3, clip.y + 2)]);
  return {
    highlight: round(lit - middle),
    shade: round(middle - far),
    glowNear: round(dist(mean(ring(1.15)), page0)),
    glowOut: round(dist(mean(ring(1.6)), page0)),
  };
}

test('F3: the orb is a luminous sphere, lit and glowing, in every state and design system', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-ux1-f3-');
  const bad: string[] = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${m.base}/styleguide`);
    await page.locator('#sg-ds').waitFor();
    const states = ['idle', 'listening', 'working', 'speaking', 'needs-you', 'stopped', 'offline'];
    for (const ds of DESIGNS) {
      for (const mode of ['light', 'dark']) {
        await page.selectOption('#sg-ds', ds);
        await page.selectOption('#sg-mode', mode);
        await page.waitForFunction(([d, mo]) => (document.getElementById('sg-ds') as HTMLSelectElement).value === d && (document.getElementById('sg-mode') as HTMLSelectElement).value === mo, [ds, mode]);
        await page.waitForTimeout(300);
        // The style reference's rail-sized orbs, one per state, set apart on the page's own
        // background so nothing else on the page is measured with them.
        await page.evaluate(() => {
          document.getElementById('ux1-stage')?.remove();
          const stage = document.createElement('div');
          stage.id = 'ux1-stage';
          stage.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-wrap:wrap;align-content:flex-start;gap:120px;padding:120px;background:var(--bg-base)';
          for (const o of document.querySelectorAll('.sg-grid .sg-swatch > .orb')) stage.append(o.cloneNode(true));
          document.body.append(stage);
        });
        for (const s of states) {
          const l = await orbLight(page, s);
          record(`F3 ${ds} ${mode} ${s}`, l);
          // Lit from the upper left and turning away from the light toward the far edge: a sphere.
          if (!(l.highlight >= 0.04)) bad.push(`${ds} ${mode} ${s}: no highlight (lit side over the middle ${l.highlight}, want ≥ 0.04)`);
          if (!(l.shade >= 0.06)) bad.push(`${ds} ${mode} ${s}: no shade (middle over the far edge ${l.shade}, want ≥ 0.06)`);
          // Its glow reaches past the disc and falls off: stronger near it than further out.
          if (!(l.glowNear >= 0.04 && l.glowNear > l.glowOut)) bad.push(`${ds} ${mode} ${s}: no glow falloff (near ${l.glowNear}, out ${l.glowOut})`);
        }
      }
    }
    await ctx.close();
    assert.deepEqual(bad, [], 'the orb is lit and glowing in every state');
  } finally {
    await b.close();
    await stop(nova);
  }
});
