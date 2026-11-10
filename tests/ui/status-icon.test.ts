// The agent status icon's preview (/styleguide?entry=status-icon), in Chromium and WebKit: Nova's mark,
// the SVG N (UI item 24), drawn by every state's treatment at 16, 24 and 48 px with its name as its
// label; each an inline SVG of the two ribbons, its stops resolved; looping states that move; a
// reduced-motion switch that leaves still frames and swaps without a transition; success settling to
// idle by itself; the mid-transition demo; and the 180 px hero. With NOVA_UI_SHOTS set: the entry at
// desktop 1440×900 and phone 390×844 in Nebula dark, every state at 96 and 24 px, and an
// idle → working → idle sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumPath, webkitBrowser, device, shotsDir } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline'];
const SIZES = [16, 24, 48];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-status-icon-'));
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

// The hero's frame: the SVG as drawn (its stops' colours, the light's turn, the pulse's scale).
const heroFrame = (page: Page) => page.evaluate(() => document.querySelector('[data-si-hero] svg')!.outerHTML);
// The styleguide redraws itself once the appearance arrives (sooner or later, by machine), which
// replaces every icon. Wait until the preview stays the same preview for a while.
async function settled(page: Page) {
  for (let i = 0; i < 20; i++) {
    const tag = `t${i}`;
    await page.evaluate((t) => { (document.querySelector('[data-si-hero]') as HTMLElement).dataset.probe = t; }, tag);
    await sleep(400);
    if (await page.evaluate((t) => (document.querySelector('[data-si-hero]') as HTMLElement | null)?.dataset.probe === t, tag)) return;
  }
  assert.fail('the preview never settled');
}
const open = async (page: Page, base: string) => {
  await page.goto(`${base}/styleguide?entry=status-icon`);
  await page.waitForFunction((n) => document.querySelectorAll('[data-si-sheet] .status-icon').length === n && document.querySelector('[data-si-hero] .status-icon'), STATES.length * SIZES.length);
  await settled(page);
  await sleep(100); // a frame for every icon to take its state's colours
};
// Every cell, measured in one task (a redraw between finding a node and measuring it would hand back
// a node no longer in the page): its label, size, renderer, and what its SVG holds.
const drawn = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-si-cell]')].map((cell) => {
  const el = cell.querySelector<HTMLElement>('.status-icon')!;
  const svg = el.querySelector('svg')!;
  const ribbons = [...svg.querySelectorAll('path[data-ribbon]')];
  const stops = [...svg.querySelectorAll('stop[data-stop]')].map((s) => getComputedStyle(s).stopColor);
  return {
    cell: cell.dataset.siCell!, role: el.getAttribute('role'), label: el.getAttribute('aria-label'), title: el.getAttribute('title'), renderer: el.dataset.renderer,
    css: svg.getBoundingClientRect().width, ribbons: ribbons.length, filled: ribbons.every((r) => /^url\(/.test(getComputedStyle(r).fill)),
    stops: stops.length, resolved: stops.every((c) => c && !/^rgba\(0, 0, 0, 0\)$|transparent/.test(c)),
    raster: el.querySelectorAll('img, canvas, image').length,
  };
}));
function assertDrawn(cells: Awaited<ReturnType<typeof drawn>>, label: string) {
  assert.equal(cells.length, STATES.length * SIZES.length, `${label}: every state at every size`);
  for (const c of cells) {
    const [, s, px] = /^(.+)-(\d+)$/.exec(c.cell)!;
    assert.equal(c.role, 'img', `${label} ${c.cell}: role`);
    if (s !== 'success') { assert.equal(c.label, s, `${label} ${c.cell}: label`); assert.equal(c.title, s, `${label} ${c.cell}: title`); }
    assert.equal(c.css, Number(px), `${label} ${c.cell}: drawn at its size`);
    assert.equal(c.renderer, 'svg', `${label} ${c.cell}: renderer`);
    assert.equal(c.ribbons, 2, `${label} ${c.cell}: the N's two ribbons`);
    assert.ok(c.filled, `${label} ${c.cell}: each filled by its gradient`);
    assert.equal(c.stops, 6, `${label} ${c.cell}: six stops`);
    assert.ok(c.resolved, `${label} ${c.cell}: every stop has a colour`);
    assert.equal(c.raster, 0, `${label} ${c.cell}: no picture inside`);
  }
}

const chromiumBrowser = () => chromium.launch({ executablePath: chromiumPath(), args: ['--disable-background-networking'] });

for (const [engine, launch] of [['chromium', chromiumBrowser], ['webkit', webkitBrowser]] as const) {
  test(`Status icon ${engine}: every state at 16/24/48 labelled and drawn; motion, reduced motion, success and retargeting`, { timeout: 600_000 }, async () => {
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
        assert.equal(await p.getByRole('heading', { name: 'Status icon', exact: true }).count(), 1);

        // Every state at every size: role img, named by its state, drawn at its size, and not blank.
        assertDrawn(await drawn(p), engine);
        for (const s of STATES) for (const px of SIZES) {
          const sel = `[data-si-cell="${s}-${px}"] .status-icon`;
          // Success is a flourish the sheet replays and that settles to idle, so its name changes
          // under any lookup by name: find it by its cell and read role, name and title in one
          // snapshot. That it says success while flourishing is the hero's check below.
          if (s === 'success') {
            const [role, name, title] = await p.locator(sel).evaluate((e) => [e.getAttribute('role'), e.getAttribute('aria-label'), e.getAttribute('title')]);
            assert.equal(role, 'img', `${s}-${px}: role`);
            assert.ok(name === 'success' || name === 'idle', `${s}-${px}: named success, or idle once settled (got ${name})`);
            assert.equal(title, name, `${s}-${px}: title matches its name`);
            continue;
          }
          assert.equal(await p.getByRole('img', { name: s, exact: true }).and(p.locator(sel)).count(), 1, `${s}-${px}: found by its accessible name`);
        }
        assert.equal(await p.locator('[data-si-hero] .status-icon').getAttribute('data-renderer'), 'svg');

        // The 180 px hero: the same SVG, at its size, its two ribbons inside the box (the pulse scales
        // about the core, so nothing reaches past the edge).
        const hero = await p.evaluate(() => {
          const svg = document.querySelector('[data-si-hero] svg') as SVGSVGElement;
          const box = svg.getBoundingClientRect();
          const inside = [...svg.querySelectorAll('path[data-ribbon]')].every((r) => { const b = r.getBoundingClientRect(); return b.left >= box.left - 1 && b.right <= box.right + 1 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1; });
          return { css: box.width, inside, raster: document.querySelectorAll('img[data-nova-mark]').length };
        });
        assert.equal(hero.css, 180, 'the hero is 180 px');
        assert.ok(hero.inside, 'the ribbons are inside the hero’s box');
        assert.equal(hero.raster, 0, 'no hidden artwork for it to sample: the mark is the SVG');

        // Moving: a looping state changes frame to frame.
        await p.getByRole('button', { name: 'working', exact: true }).click();
        await sleep(600);
        const a = await heroFrame(p);
        await sleep(250);
        assert.notEqual(await heroFrame(p), a, 'working loops');

        // Reduced motion: still frames, and a change swaps at once (no morph).
        await p.getByLabel('Reduced motion').check();
        await sleep(100);
        const still = await heroFrame(p);
        await sleep(300);
        assert.equal(await heroFrame(p), still, 'reduced: working is a still frame');
        await p.getByRole('button', { name: 'paused', exact: true }).click();
        await sleep(60);
        const swapped = await heroFrame(p);
        await sleep(500);
        assert.equal(await heroFrame(p), swapped, 'reduced: paused is drawn at once, with no morph after it');
        assert.notEqual(swapped, still, 'and it is a different frame');
        for (const s of STATES.filter((x) => x !== 'success')) { // the sheet replays success on purpose
          const frames = await p.evaluate((st) => [...document.querySelectorAll(`[data-si-cell^="${st}-"] svg`)].map((c) => c.outerHTML), s);
          await sleep(120);
          assert.deepEqual(await p.evaluate((st) => [...document.querySelectorAll(`[data-si-cell^="${st}-"] svg`)].map((c) => c.outerHTML), s), frames, `reduced: ${s} is still at every size`);
        }
        // Still told apart: no two states draw the same still frame.
        const stills = await p.evaluate(async (states) => {
          const el = document.querySelector('[data-si-hero] .status-icon') as HTMLElement & { setStatus: (s: string) => void };
          const out: string[] = [];
          for (const s of states.filter((x) => x !== 'success')) {
            el.setStatus(s);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            // Its colours as drawn (the gradient ids differ per icon, so compare what they resolve to).
            out.push([...el.querySelectorAll('stop[data-stop]')].map((st) => getComputedStyle(st).stopColor).join(' '));
          }
          return out;
        }, STATES);
        assert.equal(new Set(stills).size, stills.length, 'every still frame differs');

        // Success: a flourish that settles to idle by itself, reduced or not.
        await p.getByRole('button', { name: 'success', exact: true }).click();
        assert.equal(await p.locator('[data-si-hero] .status-icon').getAttribute('aria-label'), 'success');
        await p.waitForFunction(() => document.querySelector('[data-si-hero] .status-icon')!.getAttribute('aria-label') === 'idle', null, { timeout: 3500 });
        await p.getByLabel('Reduced motion').uncheck();
        await p.getByRole('button', { name: 'success', exact: true }).click();
        await p.waitForFunction(() => document.querySelector('[data-si-hero] .status-icon')!.getAttribute('aria-label') === 'idle', null, { timeout: 3500 });

        // The mid-transition demo ends on needs-you, having moved through working.
        await p.getByRole('button', { name: /then needs-you 150 ms later/ }).click();
        await p.waitForFunction(() => document.querySelector('[data-si-hero] .status-icon')!.getAttribute('aria-label') === 'working', null, { timeout: 2000 });
        await p.waitForFunction(() => document.querySelector('[data-si-hero] .status-icon')!.getAttribute('aria-label') === 'needs-you', null, { timeout: 2000 });

        assert.deepEqual(changes, [], 'demo only: nothing is sent');
        assert.deepEqual(d.errors, [], 'no page errors');

        const dir = shotsDir();
        if (dir && engine === 'chromium') {
          await p.evaluate(() => (document.querySelector('[data-si-hero] .status-icon') as HTMLElement & { setStatus: (s: string) => void }).setStatus('idle'));
          // Catch a success replay from its start, then wait out its 800 ms change: fully swept in.
          const label48 = (page: Page, l: string) => page.waitForFunction((x) => document.querySelector('[data-si-cell="success-48"] .status-icon')!.getAttribute('aria-label') === x, l, { timeout: 5000 });
          const flourishing = async (page: Page) => { await label48(page, 'idle'); await label48(page, 'success'); await sleep(850); };
          await flourishing(p);
          await p.screenshot({ path: join(dir, 'entry-desktop-1440x900-nebula-dark.png') });
          await p.screenshot({ path: join(dir, 'entry-desktop-1440x900-nebula-dark-full.png'), fullPage: true });
          // Every state's treatment at 96 and at 24 px, still (as reduced motion draws them).
          for (const px of [96, 24]) {
            await p.evaluate(async ({ states, px }) => {
              const { statusIcon, setReducedMotion } = await import('/js/status-icon.js' as string);
              setReducedMotion(true);
              const grid = document.createElement('div');
              grid.id = 'si-grid';
              grid.style.cssText = `display:grid;grid-template-columns:repeat(5,${Math.max(px, 72)}px);gap:12px 16px;padding:16px;background:var(--bg-base);color:var(--text-secondary);font:12px/1.4 var(--font-mono);width:max-content`;
              for (const s of states) {
                const cell = document.createElement('div');
                cell.style.cssText = 'display:grid;justify-items:center;gap:6px';
                const name = document.createElement('span');
                name.textContent = s;
                cell.append(statusIcon({ status: s, size: px }), name);
                grid.append(cell);
              }
              document.body.prepend(grid);
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            }, { states: STATES, px });
            await p.locator('#si-grid').screenshot({ path: join(dir, `every-state-${px}px.png`) });
            await p.evaluate(() => { document.getElementById('si-grid')!.remove(); });
          }
          // idle → working → idle at the real timing, on a manual clock so each frame lands exactly at
          // its offset: 8 frames evenly across the two 800 ms changes (back to idle at 800 ms).
          const seq = await device(b!, { width: 400, height: 300, scheme: 'dark', serviceWorkers: 'block' });
          await seq.ctx.addInitScript(() => {
            let now = 0;
            let queue: FrameRequestCallback[] = [];
            performance.now = () => now;
            window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
            (window as unknown as { clockTo: (t: number) => void }).clockTo = (t) => {
              while (now < t) { now = Math.min(t, now + 16); const q = queue; queue = []; q.forEach((cb) => cb(now)); }
            };
          });
          await seq.page.goto(`${base}/styleguide?entry=status-icon`);
          await seq.page.waitForFunction(() => document.querySelector('[data-si-hero] .status-icon'));
          await seq.page.evaluate(async () => {
            const { statusIcon } = await import('/js/status-icon.js' as string);
            const tile = document.createElement('div');
            tile.id = 'si-seq';
            tile.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9;padding:8px;background:var(--bg-base)';
            const icon = statusIcon({ status: 'idle', size: 180 });
            tile.append(icon);
            document.body.append(tile);
            (window as unknown as { seqIcon: HTMLElement }).seqIcon = icon;
          });
          const clock = (t: number) => seq.page.evaluate((x) => (window as unknown as { clockTo: (t: number) => void }).clockTo(x), t);
          const T0 = 1000;
          await clock(T0);
          await seq.page.evaluate(() => (window as unknown as { seqIcon: { setStatus: (s: string) => void } }).seqIcon.setStatus('working'));
          for (let i = 0; i < 8; i++) {
            const at = Math.round((i * 1600) / 7);
            if (at >= 800 && Math.round(((i - 1) * 1600) / 7) < 800) {
              await clock(T0 + 800);
              await seq.page.evaluate(() => (window as unknown as { seqIcon: { setStatus: (s: string) => void } }).seqIcon.setStatus('idle'));
            }
            await clock(T0 + at + 1);
            await seq.page.locator('#si-seq').screenshot({ path: join(dir, `idle-working-idle-${String(at).padStart(4, '0')}ms.png`) });
          }
          await seq.ctx.close();
          const phone = await device(b!, { width: 390, height: 844, scheme: 'dark', touch: true, serviceWorkers: 'block' });
          await open(phone.page, base);
          await flourishing(phone.page);
          await phone.page.screenshot({ path: join(dir, 'entry-phone-390x844-nebula-dark.png') });
          await phone.page.screenshot({ path: join(dir, 'entry-phone-390x844-nebula-dark-full.png'), fullPage: true });
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
