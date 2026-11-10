// Nebula theme match (amendment 2026-11-08): the acceptance entry (/styleguide?entry=nebula-match)
// draws Nebula's surfaces and components beside every status icon state at 16, 24 and 48 px, in
// light and dark; stopped reads red in dark; the Appearance picker leads with Nebula, labelled
// Recommended. With NOVA_UI_SHOTS set: the entry at desktop 1440×900 and phone 390×844 in both
// modes, the picker, and the sampled palette beside the filed sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { ROOT, blank, browser, device, finishSetup, ready, shotsDir } from './support.ts';

const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline'];
const SIZES = [16, 24, 48];
// Sampled from docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg (median
// of the bright ribbon pixels per hue family, in a canvas), and the Nebula dark token each one became.
const SAMPLED: [string, string, string][] = [
  ['teal', '#25aaf7', 'orb/core'],
  ['violet', '#ab3fe2', 'accent/secondary'],
  ['magenta', '#dc3b9c', 'orb/listening'],
  ['coral', '#f37a23', 'orb/attention'],
  ['red', '#e84747', 'status/error'],
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The styleguide redraws once the appearance arrives: wait until the sheet stays the same sheet.
async function settled(page: Page) {
  for (let i = 0; i < 20; i++) {
    const tag = `t${i}`;
    await page.evaluate((t) => { (document.querySelector('[data-si-sheet]') as HTMLElement).dataset.probe = t; }, tag);
    await sleep(400);
    if (await page.evaluate((t) => (document.querySelector('[data-si-sheet]') as HTMLElement | null)?.dataset.probe === t, tag)) return;
  }
  assert.fail('the entry never settled');
}

// Each sheet cell: whether its mark is drawn (the SVG's two ribbons, sized), and the mean colour of
// its stops as drawn.
const cells = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-si-sheet] [data-si-cell]')].map((cell) => {
  const svg = cell.querySelector('svg')!;
  const stops = [...svg.querySelectorAll('stop[data-stop]')].map((s) => (getComputedStyle(s).stopColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number));
  const rgb = [0, 1, 2].map((i) => stops.reduce((m, c) => m + (c[i] ?? 0), 0) / Math.max(stops.length, 1));
  return { cell: cell.dataset.siCell!, drawn: svg.querySelectorAll('path[data-ribbon]').length === 2 && svg.getBoundingClientRect().width > 0, rgb };
}));

test('the Nebula acceptance entry: surfaces, components and every status icon state, light and dark', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-theme-match-');
  const nova = await m.start();
  const shots = shotsDir();
  try {
    await finishSetup(m);
    // A fresh profile shows Nebula as the default, not as a stored pick.
    const a = (await m.get('/api/v1/design-systems/active')) as { id: string; scope: string };
    assert.deepEqual([a.id, a.scope], ['nebula', 'default'], 'a fresh profile gets Nebula');
    const tokens = (await m.get('/api/v1/design-systems/nebula')).manifest;
    for (const [, , token] of SAMPLED) assert.ok(tokens.modes.dark[token], `${token} has a dark value`);
    for (const [family, hex, token] of SAMPLED.slice(0, 4)) assert.equal(tokens.modes.dark[token], hex, `${token} is the sheet's ${family}`);

    for (const mode of ['dark', 'light'] as const) {
      for (const [size, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
        const where = `${mode}, ${size}`;
        const d = await device(b, { ...vp, scheme: mode, serviceWorkers: 'block' });
        try {
          await d.page.goto(`${m.base}/styleguide?entry=nebula-match&ds=nebula&mode=${mode}`);
          await d.page.waitForFunction((n) => document.querySelectorAll('[data-si-sheet] .status-icon').length === n, STATES.length * SIZES.length);
          await settled(d.page);
          const drawn = await cells(d.page);
          assert.equal(drawn.length, STATES.length * SIZES.length, `${where}: every state at every size`);
          for (const c of drawn) assert.ok(c.drawn, `${where} ${c.cell}: the mark is drawn`);
          // Stopped is red, not salmon or pink: red well above green, and above blue.
          const [r, g, bl] = drawn.find((c) => c.cell === 'stopped-48')!.rgb as [number, number, number];
          assert.ok(r > g * 1.8 && r > bl, `${where}: stopped reads red (${[r, g, bl].map(Math.round)})`);
          assert.equal(await d.page.locator('#sg-nebula-match .sg-chip').count(), 15, `${where}: surface and material swatches`);
          assert.ok(await d.page.locator('#sg-nebula-match .brief-card, #sg-nebula-match .card').count() >= 1, `${where}: a real card`);
          assert.deepEqual(d.errors, [], `${where}: no page errors`);
          if (shots) await d.page.screenshot({ path: join(shots, `styleguide-${size}-${mode}.png`), fullPage: true });
        } finally { await d.ctx.close(); }
      }
    }

    // The picker: Nebula first, labelled Recommended.
    const d = await device(b, { width: 1440, height: 900, scheme: 'dark', serviceWorkers: 'block' });
    try {
      await d.page.goto(`${m.base}/settings#appearance`);
      await ready(d.page);
      const look = d.page.locator('#appearance');
      await look.locator('.ds-recommended .ds-card').waitFor();
      assert.equal(await look.locator('.ds-picker > :first-child .ds-card').getAttribute('data-ds'), 'nebula', 'Nebula first');
      assert.equal(((await look.locator('.ds-recommended .ds-kicker').textContent()) ?? '').trim(), 'Recommended · Nova’s design');
      if (shots) { await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await look.scrollIntoViewIfNeeded(); await look.screenshot({ path: join(shots, 'appearance-recommended.png') }); }
    } finally { await d.ctx.close(); }

    // The sampled palette beside the filed sheet, and the token each became (evidence only).
    if (shots) {
      const p = await device(b, { width: 1440, height: 900, scheme: 'dark' });
      try {
        const sheet = readFileSync(join(ROOT, 'docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg')).toString('base64');
        const rows = SAMPLED.map(([f, hex, token]) => `<tr><td>${f}</td><td><i style="background:${hex}"></i>${hex}</td><td><i style="background:${tokens.modes.dark[token]}"></i>${tokens.modes.dark[token]}</td><td><i style="background:${tokens.tokens[token]}"></i>${tokens.tokens[token]}</td><td>${token}</td></tr>`).join('');
        await p.page.setContent(`<body style="margin:0;padding:24px;background:${tokens.modes.dark['bg/base']};color:${tokens.modes.dark['text/primary']};font:14px system-ui;display:flex;gap:24px;align-items:flex-start">
<img src="data:image/jpeg;base64,${sheet}" style="width:860px;border-radius:12px">
<table style="border-collapse:collapse"><tr><th align=left>family</th><th align=left>sampled</th><th align=left>dark token</th><th align=left>light token</th><th align=left>token</th></tr>${rows}
<tr><td>field</td><td><i style="background:#0b0b13"></i>#0b0b13</td><td><i style="background:${tokens.modes.dark['bg/base']}"></i>${tokens.modes.dark['bg/base']}</td><td></td><td>bg/base</td></tr></table>
<style>td,th{padding:6px 10px}i{display:inline-block;width:28px;height:28px;border-radius:6px;vertical-align:middle;margin-right:8px;border:1px solid #333}</style></body>`);
        await p.page.screenshot({ path: join(shots, 'palette-vs-sheet.png') });
      } finally { await p.ctx.close(); }
    }
  } finally {
    await stop(nova);
  }
});
