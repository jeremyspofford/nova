// The Automations rule editor, design-first (2026-11-09; ui/js/sg-automations.js): the styleguide
// entry for the owner's reaction draws every frame, full screen, in Nebula light and dark, in
// Chromium and WebKit, with no Content-Security-Policy violation, no page error and nothing sent.
// Each frame holds the house rules: no sideways scroll, 44 px targets, every control labelled, no
// duplicate ids, a status icon in each rule's row. On a phone (390×844) and a Duo's cover screen
// (380×900) the list and the editor are one column filling the screen: one pane, full width, down to
// the foot, no dead band. With NOVA_UI_SHOTS set (scripts/ui-test.sh), Chromium writes the owner's
// screenshots there.
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

const FRAMES = ['list', 'empty', 'create', 'edit', 'run', 'run-failed', 'token-once', 'token-after', 'token-rotate'];
const NARROW_FRAMES = ['list', 'create'];
const LIGHT_TOO = new Set(['list', 'create']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };
const DEMO_TOKEN = 'Zq4mW8nT2vX7kP1rB6sD9fH3jL5cY0gA-eU7oI2k8Wd';

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-au-styleguide-'));
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
  await page.locator('[data-au-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-au-icon]').length > 0 && [...document.querySelectorAll('[data-au-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-au-frame], [data-au-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-au-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-au-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-au-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // Every rule row carries its own status icon, filled by the real status-icon component.
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.au-rule')].every((r) => r.querySelector('.au-icon .status-icon'))), `${label}: a status icon in every rule row`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.au-list, .au-detail')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
  // What's below the fold of a long pane (the editor's sentence and Save), scrolled to its end.
  const scrolled = await page.evaluate(() => {
    const p = [...document.querySelectorAll<HTMLElement>('.au-detail, .au-panes')].find((e) => e.checkVisibility() && e.scrollHeight > e.clientHeight + 8);
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
  test(`Automations rule editor styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=automations-editor&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-au-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size !== 'desktop') await oneColumn(p, label);
              // The token shows in the one frame that shows it once, and nowhere after.
              const html = await p.content();
              assert.equal(html.includes(DEMO_TOKEN), frame === 'token-once', `${label}: the token is shown only once`);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=automations-editor`, theme);
              assert.equal(await p.locator('[data-au-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // A switch flips, locally; nothing is sent.
              const sw = p.locator('[data-au-frame="list"] .au-detail .switch').first();
              await sw.click();
              assert.equal(await sw.getAttribute('aria-checked'), 'false', 'the specimen switch turns off');
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
