// The agent status icon's preview (owner spec 2026-11-08; /styleguide?entry=status-icon), in
// Chromium and WebKit: every state at 16, 24 and 48 px with its name as its label, canvases that
// aren't blank, looping states that move, a reduced-motion switch that leaves still frames and swaps
// without a morph, success settling to idle by itself, and the mid-transition demo. With
// NOVA_UI_SHOTS set: desktop 1440×900 and phone 390×844 in Nebula dark, and a greyscale sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { ROOT, chromiumPath, webkitBrowser, device, shotsDir } from './support.ts';
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

// The hero's pixels, to compare frames.
const heroFrame = (page: Page) => page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-si-hero] canvas')!.toDataURL());
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
};
// Every cell, measured in one task (a redraw between finding a node and measuring it would hand back
// a node no longer in the page): its label, size, renderer and how much of it is lit.
const drawn = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-si-cell]')].map((cell) => {
  const el = cell.querySelector<HTMLElement>('.status-icon')!;
  const c = el.querySelector('canvas')!;
  const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 64) n++;
  return { cell: cell.dataset.siCell!, role: el.getAttribute('role'), label: el.getAttribute('aria-label'), title: el.getAttribute('title'), renderer: el.dataset.renderer, css: c.getBoundingClientRect().width, px: c.width, share: n / (c.width * c.height) };
}));
function assertDrawn(cells: Awaited<ReturnType<typeof drawn>>, label: string, renderer?: string) {
  assert.equal(cells.length, STATES.length * SIZES.length, `${label}: every state at every size`);
  for (const c of cells) {
    const [, s, px] = /^(.+)-(\d+)$/.exec(c.cell)!;
    assert.equal(c.role, 'img', `${label} ${c.cell}: role`);
    if (s !== 'success') { assert.equal(c.label, s, `${label} ${c.cell}: label`); assert.equal(c.title, s, `${label} ${c.cell}: title`); }
    assert.equal(c.css, Number(px), `${label} ${c.cell}: drawn at its size`);
    assert.ok(c.px >= Number(px), `${label} ${c.cell}: a backing store at least its size`);
    assert.ok(c.share > 0.08, `${label} ${c.cell}: not blank (${(c.share * 100).toFixed(1)}% lit)`);
    if (renderer) assert.equal(c.renderer, renderer, `${label} ${c.cell}: renderer`);
  }
}

// Chromium with software WebGL (the container has no GPU), so the shader path is what's checked;
// WebKit uses whatever its container offers. The fallback has its own test below, with WebGL refused.
const webglChromium = () => chromium.launch({ executablePath: chromiumPath(), args: ['--disable-background-networking', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });

for (const [engine, launch, expected] of [['chromium', webglChromium, 'webgl'], ['webkit', webkitBrowser, null]] as const) {
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
        assertDrawn(await drawn(p), engine, expected ?? undefined);
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
        const renderer = await p.locator('[data-si-hero] .status-icon').getAttribute('data-renderer');
        console.log(`${engine}: renderer ${renderer}`);
        assert.ok(renderer === 'webgl' || renderer === 'canvas2d');
        if (expected) assert.equal(renderer, expected, 'the shader renders where WebGL is');

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
          const frames = await p.evaluate((st) => [...document.querySelectorAll<HTMLCanvasElement>(`[data-si-cell^="${st}-"] canvas`)].map((c) => c.toDataURL()), s);
          await sleep(120);
          assert.deepEqual(await p.evaluate((st) => [...document.querySelectorAll<HTMLCanvasElement>(`[data-si-cell^="${st}-"] canvas`)].map((c) => c.toDataURL()), s), frames, `reduced: ${s} is still at every size`);
        }
        // Still told apart: no two states draw the same still frame.
        const hero = await p.evaluate(async (states) => {
          const el = document.querySelector('[data-si-hero] .status-icon') as HTMLElement & { setStatus: (s: string) => void };
          const out: string[] = [];
          for (const s of states.filter((x) => x !== 'success')) {
            el.setStatus(s);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            out.push(el.querySelector('canvas')!.toDataURL());
          }
          return out;
        }, STATES);
        assert.equal(new Set(hero).size, hero.length, 'every still frame differs');

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
          // Catch a replay from its start, then wait out its 800 ms morph: the check, fully formed.
          const label48 = (page: Page, l: string) => page.waitForFunction((x) => document.querySelector('[data-si-cell="success-48"] .status-icon')!.getAttribute('aria-label') === x, l, { timeout: 5000 });
          const flourishing = async (page: Page) => { await label48(page, 'idle'); await label48(page, 'success'); await sleep(850); };
          await flourishing(p);
          await p.screenshot({ path: join(dir, 'status-icons-desktop-1440x900-nebula-dark.png') });
          await p.screenshot({ path: join(dir, 'status-icons-desktop-1440x900-nebula-dark-full.png'), fullPage: true });
          const sheet = p.locator('[data-si-sheet]');
          await flourishing(p);
          await sheet.evaluate((el) => { el.style.filter = 'grayscale(1)'; });
          await sheet.screenshot({ path: join(dir, 'status-icons-greyscale-16-24-48.png') });
          await sheet.evaluate((el) => { el.style.filter = ''; });
          // Every state at the hero size, still (as reduced motion draws them), for a close look.
          await p.evaluate(async (states) => {
            const { statusIcon, setReducedMotion } = await import('/js/status-icon.js' as string);
            setReducedMotion(true);
            const row = document.createElement('div');
            row.id = 'si-contact';
            row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;padding:8px;background:var(--bg-base)';
            for (const s of states) row.append(statusIcon({ status: s, size: 96 }));
            document.body.prepend(row);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          }, STATES);
          await p.locator('#si-contact').screenshot({ path: join(dir, 'status-icons-every-state-96px-still.png') });
          await p.evaluate(() => { document.getElementById('si-contact')!.remove(); });
          // Side by side with the binding art: each of the sheet's tiles above the state it maps to.
          const art = `data:image/jpeg;base64,${readFileSync(resolve(ROOT, 'docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg')).toString('base64')}`;
          await p.evaluate(async ({ art, pairs }: { art: string; pairs: [string, [number, number] | null][] }) => {
            const { statusIcon } = await import('/js/status-icon.js' as string);
            const k = 100 / 232; // the sheet's tiles are about 232 px square; ours are 100, holding a 96 px icon
            const grid = document.createElement('div');
            grid.id = 'si-compare';
            grid.style.cssText = 'display:grid;grid-template-columns:repeat(10,100px);gap:12px;padding:16px;background:var(--bg-base);color:var(--text-secondary);font:12px/1.4 var(--font-mono);width:max-content';
            const tile = 'box-sizing:border-box;width:100px;height:100px;border-radius:22px;display:grid;place-items:center;background:var(--bg-raised);border:1px solid var(--border-subtle)';
            for (const [, at] of pairs) {
              const t = document.createElement('div');
              t.style.cssText = at ? `${tile};background:url(${art}) ${-at[0] * k}px ${-at[1] * k}px / ${1536 * k}px auto no-repeat` : `${tile};opacity:.3`;
              grid.append(t);
            }
            for (const [s] of pairs) { const t = document.createElement('div'); t.style.cssText = tile; t.append(statusIcon({ status: s, size: 96 })); grid.append(t); }
            for (const [s, at] of pairs) { const l = document.createElement('div'); l.textContent = at ? s : `${s} (no tile)`; grid.append(l); }
            document.body.prepend(grid);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          }, { art, pairs: [['idle', [185, 77]], ['listening', [490, 77]], ['thinking', [803, 77]], ['success', [1116, 77]], ['needs-you', [185, 353]], ['stopped', [493, 353]], ['paused', [805, 353]], ['offline', [1115, 353]], ['working', null], ['speaking', null]] as [string, [number, number] | null][] });
          await p.locator('#si-compare').screenshot({ path: join(dir, 'status-icons-vs-sheet-96px.png') });
          await p.evaluate(() => { document.getElementById('si-compare')!.remove(); });
          // idle → working → idle at the real timing, on a manual clock so each frame lands exactly at
          // its offset: 8 frames evenly across the two 800 ms morphs (back to idle at 800 ms).
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
          await seq.page.evaluate(async () => {
            const { statusIcon } = await import('/js/status-icon.js' as string);
            const tile = document.createElement('div');
            tile.id = 'si-seq';
            tile.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9;padding:8px;background:var(--bg-base)';
            const icon = statusIcon({ status: 'idle', size: 96 });
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
          await phone.page.screenshot({ path: join(dir, 'status-icons-phone-390x844-nebula-dark.png') });
          await phone.page.screenshot({ path: join(dir, 'status-icons-phone-390x844-nebula-dark-full.png'), fullPage: true });
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

// No WebGL at all (a browser without it, or one whose context is refused): the Canvas2D fallback
// draws every state, at every size, sized from creation and not blank; and changes still land.
for (const [engine, launch] of [['chromium', webglChromium], ['webkit', webkitBrowser]] as const) {
  test(`Status icon ${engine}, WebGL refused: the Canvas2D fallback draws every state at 16/24/48`, { timeout: 300_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        const d = await device(b!, { width: 1440, height: 900, scheme: 'dark', serviceWorkers: 'block' });
        await d.ctx.addInitScript(() => {
          const real = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
            return /webgl/.test(kind) ? null : (real as (...a: unknown[]) => unknown).call(this, kind, ...rest);
          } as typeof real;
        });
        await open(d.page, base);
        assertDrawn(await drawn(d.page), `${engine} fallback`, 'canvas2d');
        await d.page.getByRole('button', { name: 'stopped', exact: true }).click();
        await d.page.waitForFunction(() => document.querySelector('[data-si-hero] .status-icon')!.getAttribute('aria-label') === 'stopped');
        const shown = await d.page.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('[data-si-hero] canvas')!; return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 64); });
        assert.ok(shown, 'the hero still draws after a change');
        assert.deepEqual(d.errors, [], 'no page errors');
        await d.ctx.close();
      });
    } finally {
      await b?.close();
    }
  });
}
