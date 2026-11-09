// Receipts, the egress viewer, design-first (2026-11-09; ui/js/sg-receipts.js): the styleguide entry
// for the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and
// WebKit, with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds
// the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids. The
// words stay exact for a privacy surface: the coverage frame names what gets no receipt, and no
// frame says that nothing (or everything) left. On a phone (390×844) and a Duo's cover screen
// (380×900) the list and a receipt are one column filling the screen. With NOVA_UI_SHOTS set
// (scripts/ui-test.sh), Chromium writes the owner's screenshots there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, device, shortTargets, shotsDir, still, watchCsp, webkitBrowser } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const FRAMES = ['list', 'filtered', 'receipt', 'screening', 'coverage', 'empty', 'empty-local'];
const NARROW_FRAMES = ['list', 'receipt', 'empty-local'];
const LIGHT_TOO = new Set(['list']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };
// Words a privacy surface must not say while receipts cover only model calls (honest-claims.md).
const OVERCLAIMS = [/nothing (?:left|leaves) (?:this|your)/i, /everything (?:that )?left/i, /everything stays/i, /(?<!not )every(?:thing)? Nova sends/i, /all (?:outgoing|egress|traffic)/i];

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-rc-styleguide-'));
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

async function open(page: Page, url: string, theme: string) {
  await page.goto(`${url}&ds=nebula&mode=${theme}`);
  await page.waitForSelector(`html[data-sg-preview="nebula-${theme}"]`);
  await page.locator('[data-rc-frame]').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rc-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-rc-frame], [data-rc-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-rc-frame] :is(button, a, select, input)', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-rc-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  const text = await page.evaluate(() => [...document.querySelectorAll('[data-rc-frame]')].map((f) => (f as HTMLElement).innerText).join('\n'));
  for (const re of OVERCLAIMS) assert.doesNotMatch(text, re, `${label}: no overclaim`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.rc-list, .rc-detail')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say, from the real backend.
async function words(page: Page, frame: string, label: string) {
  // textContent: group labels are uppercased by CSS, and innerText would return them so.
  const t = (await page.locator(`[data-rc-frame="${frame}"]`).textContent() ?? '').replace(/\s+/g, ' ');
  if (frame === 'coverage') {
    for (const w of ['Receipts record model calls, not everything Nova sends.', 'Web pages and searches Nova fetches, and browser tasks.', 'Gmail and Home Assistant.', 'Sync between your own devices.', 'Nova doesn’t yet have one place that checks everything it sends.']) assert.ok(t.includes(w), `${label}: says “${w}”`);
  }
  if (frame === 'receipt' || frame === 'list') {
    for (const w of ['Where it went', 'Provider', 'Model', 'Why, as recorded', 'Privacy setting for this call', 'Opt-in', 'Receipt', 'What it was told, by reference', 'Not in a receipt']) assert.ok(t.includes(w), `${label}: shows ${w}`);
  }
  if (frame === 'receipt') assert.ok(t.includes('Open the task'), `${label}: links its task`);
  if (frame === 'list') assert.ok(t.includes('Open the conversation'), `${label}: links its conversation`);
  if (frame === 'screening') assert.ok(t.includes('Screening, which you turned on'), `${label}: names the opt-in`);
  if (frame === 'empty-local') {
    assert.ok(t.includes('No receipt shows a model call leaving your devices.'), `${label}: says exactly what the receipts show`);
    assert.ok(t.includes('Receipts record model calls only.'), `${label}: says what they don't cover`);
  }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
  const scrolled = await page.evaluate(() => {
    const p = [...document.querySelectorAll<HTMLElement>('.rc-detail, .rc-panes')].find((e) => e.checkVisibility() && e.scrollHeight > e.clientHeight + 8);
    if (!p) return false;
    p.scrollTop = p.scrollHeight;
    return true;
  });
  if (scrolled) {
    await still(page);
    await page.screenshot({ path: join(dir, `${name}-end.png`), animations: 'disabled', caret: 'hide' });
  }
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Receipts styleguide (${engine}): every frame, exact words, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
    let b: Browser | undefined;
    const dir = engine === 'chromium' ? shotsDir() : null;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        const runs: [keyof typeof SIZES, string, string[]][] = [['desktop', 'dark', FRAMES], ['desktop', 'light', FRAMES.filter((f) => LIGHT_TOO.has(f))], ['phone', 'dark', NARROW_FRAMES], ['phone', 'light', NARROW_FRAMES], ['duo', 'dark', NARROW_FRAMES], ['duo', 'light', NARROW_FRAMES]];
        for (const [size, theme, frames] of runs) {
          const s = SIZES[size];
          const d = await device(b!, { width: s.width, height: s.height, touch: s.touch, scheme: theme as 'light' | 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const csp = await watchCsp(p);
          const sent: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) sent.push(`${r.method()} ${r.url()}`); });
          try {
            for (const frame of frames) {
              const label = `${engine}/${s.name}/${theme}/${frame}`;
              await open(p, `${base}/styleguide?entry=receipts&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-rc-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size !== 'desktop') await oneColumn(p, label);
              else await words(p, frame, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=receipts`, theme);
              assert.equal(await p.locator('[data-rc-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The filters filter the specimens in the page; nothing is fetched or sent.
              const list = p.locator('[data-rc-frame="list"] [data-rc-list]');
              const visible = () => list.locator('.rc-item:not([hidden])').count();
              assert.equal(await visible(), 8, 'all eight specimen receipts show');
              await list.locator('[data-rc-filter="where"]').selectOption('left');
              assert.equal(await visible(), 5, 'five left the devices');
              await list.locator('[data-rc-filter="mode"]').selectOption('local-preferred');
              assert.equal(await visible(), 2, 'two of them under Local first');
              assert.equal(await list.locator('[data-rc-count]').innerText(), '2 of 8 shown.');
              await list.locator('[data-rc-filter="mode"]').selectOption('local-only');
              assert.equal(await visible(), 0, 'none under Local-only');
              assert.equal(await list.locator('[data-rc-none]').innerText(), 'No receipt matches these filters.');
              assert.deepEqual(await csp(), [], `${engine}/${theme}/entry: no Content-Security-Policy violation`);
            }
            assert.deepEqual(sent, [], `${engine}/${s.name}/${theme}: the compositions send nothing`);
            assert.deepEqual(d.errors, [], `${engine}/${s.name}/${theme}: no page errors`);
          } finally {
            await d.ctx.close();
          }
        }
      });
    } finally { await b?.close(); }
  });
}
