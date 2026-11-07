// UI rebuild compositions, design-first (2026-11-06; docs/plans/ui-rebuild-compositions-2026-11-06.md):
// every frame of the shell and chat, Settings, About, the changelog, the pipeline dashboard and the
// Nebula orb, full screen, across the house matrix, in Nebula light and dark, in Chromium and WebKit.
// Each must hold: no sideways scroll anywhere, 44 px targets, every control labelled, no duplicate
// ids, no page errors, no changes sent. Styleguide only: the app never loads these compositions.
// With NOVA_UC_SHOTS set it writes the owner's screenshots (desktop-1440 and phone) and, in Chromium,
// one side-by-side per surface: the filed reference on the left, the composition on the right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, webkitBrowser, device, still, ROOT, shortTargets } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const FRAMES = [
  ['ui-shell-chat', 'shell-chat-empty'], ['ui-shell-chat', 'shell-chat-reply'], ['ui-shell-chat', 'shell-chat-rail'], ['ui-shell-chat', 'shell-chat-palette'],
  ['ui-settings', 'settings-top'], ['ui-settings', 'settings-privacy'],
  ['ui-about', 'about-current'], ['ui-about', 'about-pending'], ['ui-about', 'about-unknown'], ['ui-about', 'changelog-list'], ['ui-about', 'pipeline-tracks'],
  ['ui-orb', 'orb-states'],
] as const;
const ENTRIES = ['ui-shell-chat', 'ui-settings', 'ui-about', 'ui-orb'];
// The house matrix.
const MATRIX = {
  'phone': { width: 390, height: 844 }, 'tablet-portrait': { width: 820, height: 1180 }, 'fold-cover': { width: 344, height: 882 },
  'fold-half-open': { width: 884, height: 540 }, 'duo-open': { width: 720, height: 540 }, 'desktop-1440': { width: 1440, height: 900 },
};
const THEMES = ['light', 'dark'] as const;
const SHOTS = process.env.NOVA_UC_SHOTS ? resolve(process.env.NOVA_UC_SHOTS) : null;

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-uc-styleguide-'));
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

// Opens a page in Nebula's light or dark look, and waits until it is drawn in it.
async function open(page: Page, url: string, theme: string) {
  await page.goto(`${url}&ds=nebula&mode=${theme}`);
  await page.waitForSelector(`html[data-sg-preview="nebula-${theme}"]`);
  await page.locator('[data-uc-frame]').first().waitFor();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Each check queries and measures in one page.evaluate, so a redraw can't hand it stale nodes.
async function geometry(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-uc-frame], [data-uc-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways inside a frame`);
  assert.deepEqual(await shortTargets(page, '[data-uc-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-uc-frame] input[type="radio"]', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-uc-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => (e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) ? !e.labels?.length : !(e.getAttribute('aria-label') || e.textContent?.trim()))
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ids`);
}

// The reference on the left, the composition on the right, in one picture (Chromium decodes AVIF).
const REFS: Record<string, [string, string]> = {
  'shell-chat': ['claude-ai-chat.jpg', 'shell-chat-empty-desktop-1440-light'],
  'shell': ['linear-my-issues.avif', 'shell-chat-reply-desktop-1440-dark'],
  'settings': ['', 'settings-privacy-desktop-1440-dark'],
  'about': ['linear-my-issues.avif', 'about-pending-desktop-1440-dark'],
  'pipeline': ['linear-my-issues.avif', 'pipeline-tracks-desktop-1440-dark'],
  'orb': ['nova-orb-icon-reference-2026-11-06.jpg', 'orb-icon-large-dark'],
  'orb-states': ['nova-orb-icon-reference-2026-11-06.jpg', 'orb-states-desktop-1440-dark'],
};
async function sideBySide(b: Browser) {
  const page = await b.newPage({ viewport: { width: 2400, height: 800 } });
  const uri = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString('base64')}`;
  for (const [surface, [ref, shot]] of Object.entries(REFS)) {
    const mine = join(SHOTS!, 'chromium', `${shot}.png`);
    if (!existsSync(mine)) continue;
    const left = ref
      ? `<img src="${uri(join(ROOT, 'docs/builder-packet/ui-references', ref), ref.endsWith('avif') ? 'image/avif' : 'image/jpeg')}" alt="">`
      : '<div class="text"><b>Raycast (text reference)</b><p>Search first. Keyboard first. Zero decoration.</p><p>A clear category list and a detail pane.</p><p>No local image: the owner filed Raycast as text.</p></div>';
    await page.setContent(`<style>body{margin:0;background:#202024;color:#eee;font:16px system-ui}.row{display:flex;gap:24px;padding:24px;align-items:flex-start}.col{flex:1}.col p{margin:0 0 8px}img{width:100%;height:auto;display:block;border-radius:8px}.text{background:#2b2b31;border-radius:8px;padding:48px;min-height:500px;font-size:28px}.text p{font-size:22px;color:#bbb}</style>
<div class="row"><div class="col"><p>Reference: ${ref || 'Raycast (text)'}</p>${left}</div><div class="col"><p>Composition: ${shot}</p><img src="${uri(mine, 'image/png')}" alt=""></div></div>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: join(SHOTS!, `side-by-side-${surface}.png`), fullPage: true });
  }
  await page.close();
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`UI rebuild compositions ${engine}: every frame across the matrix in Nebula light and dark`, { timeout: 1_800_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        for (const [size, dimensions] of Object.entries(MATRIX)) {
          for (const theme of THEMES) {
            const d = await device(b!, { ...dimensions, touch: !size.startsWith('desktop'), scheme: theme, serviceWorkers: 'block' });
            const p = d.page;
            const changes: string[] = [];
            p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${r.url()}`); });
            for (const [entry, frame] of FRAMES) {
              const label = `${engine}/${size}/${theme}/${frame}`;
              await open(p, `${base}/styleguide?entry=${entry}&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-uc-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await geometry(p, label);
              if (SHOTS && (size === 'desktop-1440' || size === 'phone')) {
                const folder = join(SHOTS, engine);
                mkdirSync(folder, { recursive: true });
                await p.mouse.move(0, 0);
                await still(p);
                await p.screenshot({ path: join(folder, `${frame}-${size}-${theme}.png`), animations: 'disabled', caret: 'hide' });
                if (frame === 'orb-states' && size === 'desktop-1440') {
                  await p.emulateMedia({ reducedMotion: 'reduce' });
                  await p.screenshot({ path: join(folder, `${frame}-reduced-motion-${size}-${theme}.png`), animations: 'disabled', caret: 'hide' });
                  await p.emulateMedia({ reducedMotion: null });
                  // The app icon drawn large (not upscaled: the swirl is redrawn at this size), for the side-by-side.
                  await p.evaluate(() => document.querySelector<HTMLElement>('.orb-icon[data-k="3"]')!.setAttribute('style', 'width: 480px; height: 480px; --uc-icon-orb: 408px; border-radius: 96px'));
                  await p.locator('.orb-icon[data-k="3"]').screenshot({ path: join(folder, `orb-icon-large-${theme}.png`), animations: 'disabled' });
                }
              }
            }
            // Every entry, all its frames stacked in the styleguide's column.
            for (const entry of ENTRIES) {
              await open(p, `${base}/styleguide?entry=${entry}`, theme);
              await geometry(p, `${engine}/${size}/${theme}/${entry}`);
              if (engine === 'chromium' && theme === 'dark' && (size === 'phone' || size === 'desktop-1440')) {
                if (!await p.evaluate(() => 'axe' in window)) await p.addScriptTag({ content: readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8') });
                const axe = await p.evaluate(async () => (window as any).axe.run(document.querySelector('.sg-main'), { rules: { region: { enabled: false } } }));
                assert.deepEqual(axe.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), [], `${engine}/${size}/${entry}: axe`);
              }
            }
            assert.deepEqual(changes, [], 'the compositions change nothing');
            assert.deepEqual(d.errors, [], `${engine}/${size}/${theme}: no page errors`);
            await d.ctx.close();
          }
        }
        if (SHOTS && engine === 'chromium') await sideBySide(b!);
      });
    } finally { await b?.close(); }
  });
}
