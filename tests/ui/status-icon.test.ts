// The agent status icon's preview (/styleguide?entry=status-icon), in Chromium and WebKit: Nova's mark,
// the owner's artwork, drawn by every state's treatment at 16, 24 and 48 px with its name as its
// label; canvases that aren't blank; looping states that move; a reduced-motion switch that leaves
// still frames and swaps without a transition; success settling to idle by itself; the mid-transition
// demo; and the 180 px hero drawn whole. With NOVA_UI_SHOTS set: the entry at desktop 1440×900 and
// phone 390×844 in Nebula dark, every state at 96 and 24 px, and an idle → working → idle sequence.
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

        // The 180 px hero is drawn whole: a fresh offscreen canvas is 300 × 150, and sizing it by its
        // width alone once left the bottom of anything taller than 150 px blank (#393). The artwork
        // has a shape of its own (transparent round it, 2026-11-10), so the hero's bottom rows are
        // measured against the same rows of the artwork itself, drawn plainly at the same size.
        const rows = await p.evaluate(() => {
          const c = document.querySelector<HTMLCanvasElement>('[data-si-hero] canvas')!;
          const lit = (ctx: CanvasRenderingContext2D) => {
            const d = ctx.getImageData(0, Math.round(c.height * 0.8), c.width, Math.round(c.height * 0.15)).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i]! > 64) n++;
            return n / (d.length / 4);
          };
          const ref = document.createElement('canvas');
          ref.width = c.width; ref.height = c.height;
          const g = ref.getContext('2d')!;
          g.drawImage(document.querySelector<HTMLImageElement>('img[data-nova-mark]')!, 0, 0, c.width, c.height);
          return { share: lit(c.getContext('2d')!), art: lit(g), css: c.getBoundingClientRect().width };
        });
        assert.equal(rows.css, 180, 'the hero is 180 px');
        assert.ok(rows.art > 0.3, `the artwork reaches the bottom rows (${(rows.art * 100).toFixed(0)}% lit)`);
        assert.ok(Math.abs(rows.share - rows.art) < 0.08, `the hero's bottom rows are drawn as the artwork's are (${(rows.share * 100).toFixed(0)}% lit, the artwork ${(rows.art * 100).toFixed(0)}%)`);
        // It is the artwork: the page's own <img data-nova-mark> sources, each loaded once, at the
        // sizes scripts/app-icon.py makes from the one master (owner, 2026-11-10).
        assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('img[data-nova-mark]')].map((i) => i.naturalWidth)), [128, 1024]);

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
          await seq.page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img[data-nova-mark]')].every((i) => i.complete && i.naturalWidth > 0));
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

// At 2× (#icon-clip, 2026-11-08): the shader draws on one shared canvas that starts at 300×150, and
// only its width was ever grown, so a draw of 151 to 300 device px (the 96 px empty-chat hero, the
// 112 px phone Home and /pair) read rows above that canvas and lost the icon's top. Each state's
// topmost lit row, as a share of its height, must match the 48 px icon's (96 device px, never
// clipped), and a 48 px icon drawn after the big ones must come out exactly as it did before them.
test('Status icon chromium at 2×: 96 and 112 px keep their top; a small icon after a big one is unchanged', { timeout: 300_000 }, async () => {
  let b: Browser | undefined;
  try {
    b = await webglChromium();
    await fixture(async (base) => {
      const d = await device(b!, { width: 1024, height: 768, scheme: 'dark', serviceWorkers: 'block', scale: 2 });
      await d.page.goto(`${base}/styleguide?entry=status-icon`);
      await d.page.waitForSelector('[data-si-hero] .status-icon');
      const out = await d.page.evaluate(async (states) => {
        const { statusIcon, setReducedMotion } = await import('/js/status-icon.js' as string);
        setReducedMotion(true); // still frames, so two draws of one state are the same pixels
        const row = document.createElement('div');
        row.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9;display:flex;flex-wrap:wrap;gap:4px';
        document.body.append(row);
        const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const draw = async (s: string, size: number) => { const el = statusIcon({ status: s, size }); row.append(el); await settle(); return el.querySelector('canvas') as HTMLCanvasElement; };
        const read = (c: HTMLCanvasElement) => {
          const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let top = -1;
          for (let i = 3; i < data.length && top < 0; i += 4) if (data[i]! > 64) top = Math.floor((i - 3) / 4 / c.width);
          return { px: c.width, renderer: (c.parentElement as HTMLElement).dataset.renderer, top: top / c.height, pixels: Array.from(data) };
        };
        const res: Record<string, { px: number; renderer?: string; top: number }[]> = {};
        const again: Record<string, number> = {};
        for (const s of states) {
          const first = read(await draw(s, 48));
          const big = [read(await draw(s, 96)), read(await draw(s, 112))];
          const after = read(await draw(s, 48));
          res[s] = [first, ...big, after].map(({ px, renderer, top }) => ({ px, renderer, top }));
          again[s] = first.pixels.reduce((m, v, i) => Math.max(m, Math.abs(v - after.pixels[i]!)), 0);
        }
        row.remove();
        return { res, again, dpr: devicePixelRatio };
      }, ['idle', 'listening', 'needs-you', 'stopped', 'paused', 'offline']);
      assert.equal(out.dpr, 2, 'a 2× screen');
      for (const [s, [first, i96, i112, after]] of Object.entries(out.res)) {
        console.log(`${s}: top ${[first, i96, i112, after].map((x) => `${x!.px}px ${(x!.top * 100).toFixed(1)}%`).join(', ')}`);
        assert.deepEqual([first!.px, i96!.px, i112!.px, after!.px], [96, 192, 224, 96], `${s}: backing stores at 2×`);
        for (const x of [first, i96, i112, after]) assert.equal(x!.renderer, 'webgl', `${s}: the shader draws`);
        assert.ok(first!.top >= 0, `${s}: the 48 px icon is drawn`);
        for (const x of [i96, i112]) {
          // Two device px either way, at 48 px's resolution (96 px), for the larger icons' finer rows.
          assert.ok(Math.abs(x!.top - first!.top) <= 2 / 96, `${s} at ${x!.px / 2} px: topmost lit row at ${(x!.top * 100).toFixed(1)}%, the full form's is ${(first!.top * 100).toFixed(1)}%`);
        }
        assert.ok(out.again[s]! <= 2, `${s}: a 48 px icon drawn after 96 and 112 px matches the one before them (max channel diff ${out.again[s]})`);
      }
      assert.deepEqual(d.errors, [], 'no page errors');
      await d.ctx.close();
    });
  } finally {
    await b?.close();
  }
});

// Owner, 2026-11-11 (#486): the scroll budget stands and the render is fixed instead. An animating
// icon is redrawn at ANIMATION_FPS, not on every display frame (each redraw is a copy out of the
// shader's canvas, a synchronous readback without a GPU); a change is drawn at once, the frame a
// morph ends on is drawn (never left part-way), a still state isn't redrawn at all, reduced motion
// doesn't loop, and however many icons there are, they share one WebGL context. Redraws are counted
// by each icon canvas's clearRect, which paint() calls once per draw on every path.
test('Status icon chromium: an animating icon is redrawn at ANIMATION_FPS; changes and a morph’s end are drawn at once; one WebGL context', { timeout: 300_000 }, async () => {
  let b: Browser | undefined;
  try {
    b = await webglChromium();
    await fixture(async (base) => {
      const d = await device(b!, { width: 1024, height: 768, scheme: 'dark', serviceWorkers: 'block' });
      await d.ctx.addInitScript(() => {
        const w = window as unknown as { __paints: WeakMap<HTMLCanvasElement, number>; __gl: number };
        w.__paints = new WeakMap();
        w.__gl = 0;
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (this: CanvasRenderingContext2D, ...a: [number, number, number, number]) {
          if (this.canvas.closest?.('.status-icon')) w.__paints.set(this.canvas, (w.__paints.get(this.canvas) ?? 0) + 1);
          return clear.apply(this, a);
        };
        for (const proto of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype].filter(Boolean) as { getContext: (...a: unknown[]) => unknown }[]) {
          const real = proto.getContext;
          proto.getContext = function (this: unknown, kind: unknown, ...rest: unknown[]) { if (/webgl/.test(String(kind))) w.__gl++; return real.call(this, kind, ...rest); };
        }
      });
      await open(d.page, base);
      const out = await d.page.evaluate(async () => {
        const { statusIcon, setReducedMotion, ANIMATION_FPS } = await import('/js/status-icon.js' as string);
        const w = window as unknown as { __paints: WeakMap<HTMLCanvasElement, number>; __gl: number };
        setReducedMotion(false);
        const row = document.createElement('div');
        row.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9;display:flex;flex-wrap:wrap;gap:4px';
        document.body.append(row);
        const frames = (n: number) => new Promise<void>((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        const paints = (el: HTMLElement) => w.__paints.get(el.querySelector('canvas')!) ?? 0;
        // Paints and display frames over a window of real time.
        const over = async (el: HTMLElement, ms: number) => {
          const p0 = paints(el), t0 = performance.now();
          let n = 0;
          await new Promise<void>((r) => { const f = (t: number) => { n++; if (t - t0 >= ms) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); });
          return { paints: paints(el) - p0, frames: n, ms: performance.now() - t0 };
        };
        const icon = statusIcon({ status: 'working', size: 24 });
        row.append(icon);
        await frames(30);
        const loop = await over(icon, 2000);
        // A change is drawn on the next frame, not when the cadence next comes round.
        await frames(1);
        const before = paints(icon);
        icon.setStatus('paused');
        await frames(1);
        const change = paints(icon) - before;
        // The morph to a still state runs out and its last frame is drawn; then nothing is redrawn.
        await new Promise((r) => setTimeout(r, 1200));
        const still = await over(icon, 1000);
        const fresh = statusIcon({ status: 'paused', size: 24 });
        row.append(fresh);
        await frames(2);
        const px = (el: HTMLElement) => { const c = el.querySelector('canvas')!; return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; };
        const [a, z] = [px(icon), px(fresh)];
        const endDiff = a.reduce((m, v, i) => Math.max(m, Math.abs(v - z[i]!)), 0);
        // Reduced motion: a looping state doesn't loop. (A change under reduced motion still counts
        // as moving for MORPH_MS, redrawing the same still frame, as before; measured after that.)
        setReducedMotion(true);
        icon.setStatus('working');
        await new Promise((r) => setTimeout(r, 1000));
        const reduced = await over(icon, 1000);
        setReducedMotion(null);
        // Forty more icons, every one looping: still the one WebGL context.
        for (let i = 0; i < 40; i++) row.append(statusIcon({ status: i % 2 ? 'thinking' : 'idle', size: 16 + (i % 3) * 8 }));
        await frames(5);
        const renderer = icon.dataset.renderer;
        row.remove();
        return { fps: ANIMATION_FPS, loop, change, still, endDiff, reduced, gl: w.__gl, renderer };
      });
      console.log(`cadence: ${JSON.stringify(out)}`);
      assert.equal(out.fps, 20, 'ANIMATION_FPS is the owner’s ~15–20 fps');
      assert.equal(out.renderer, 'webgl', 'the shader draws');
      const secs = out.loop.ms / 1000;
      assert.ok(out.loop.paints <= out.fps * secs * 1.1 + 2, `a looping icon is redrawn at no more than ${out.fps} fps (${out.loop.paints} redraws in ${out.loop.ms.toFixed(0)} ms over ${out.loop.frames} display frames)`);
      assert.ok(out.loop.paints >= Math.min(out.loop.frames, out.fps * secs) * 0.4, `a looping icon keeps moving (${out.loop.paints} redraws in ${out.loop.ms.toFixed(0)} ms over ${out.loop.frames} display frames)`);
      assert.ok(out.change >= 1, `a change is drawn on the next frame (${out.change})`);
      assert.equal(out.still.paints, 0, `a still state isn’t redrawn (${out.still.paints} in ${out.still.ms.toFixed(0)} ms)`);
      assert.ok(out.endDiff <= 2, `the morph ends drawn on its final form, as a fresh icon of it is (max channel diff ${out.endDiff})`);
      assert.equal(out.reduced.paints, 0, `reduced motion: a looping state isn’t redrawn (${out.reduced.paints})`);
      assert.equal(out.gl, 1, `one WebGL context for every icon on the page (${out.gl})`);
      assert.deepEqual(d.errors, [], 'no page errors');
      await d.ctx.close();
    });
  } finally {
    await b?.close();
  }
});

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
