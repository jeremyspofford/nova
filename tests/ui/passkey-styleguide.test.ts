// T2 design-first: the passkey confirmation for tier 3 (approved in #291), in the living styleguide.
// No app flow, no WebAuthn call, no approval: the specimen must never touch navigator.credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, webkitBrowser, device, still, ROOT, shortTargets } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const STATES = ['ready', 'waiting', 'cancelled', 'failed', 'expired', 'no-passkey', 'unavailable', 'rate', 'confirmed'];
const SETUP = ['start', 'waiting', 'added', 'failed', 'unavailable'];
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 }, halfopen: { width: 842, height: 675 } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-passkey-styleguide-'));
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

// Any WebAuthn call from the specimen is recorded; the test requires none.
const WATCH_CREDENTIALS = `(() => {
  const calls = (window.__passkeyCalls = []);
  const c = navigator.credentials;
  if (c) for (const m of ['get', 'create']) { const f = c[m]?.bind(c); c[m] = (...a) => { calls.push(m); return f ? f(...a) : Promise.reject(new Error('blocked')); }; }
})();`;

async function themeApplied(page: Page, css: string) {
  await page.waitForFunction((text) => document.getElementById('ds')?.textContent === text && !document.getElementById('ds-boot'), css);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function choose(page: Page, id: string, value: string, marker: string) {
  await page.locator(`#${id}`).selectOption(value);
  await page.locator(marker).waitFor();
}
// A review image with the page's own margin around the specimen, not cropped flush to its border.
async function padded(page: Page, selector: string, path: string) {
  // One read: page-absolute bounds, so smooth scrolling can't shift the clip between measurements.
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height, vw: document.documentElement.clientWidth }; }, selector);
  const x = Math.max(0, r.x - 16), y = Math.max(0, r.y - 16);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', fullPage: true, clip: { x, y, width: Math.min(r.vw - x, r.w + 32), height: r.h + 32 } });
}
async function geometry(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageWidth <= width, `${label}: page overflow ${pageWidth} > ${width}`);
  const root = page.locator('#sg-passkey-approval');
  assert.deepEqual(await root.evaluate((r) => [...r.querySelectorAll<HTMLElement>('button, label, p, h2, h3')].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)), [], `${label}: clipped text`);
  assert.deepEqual(await shortTargets(page, '#sg-passkey-approval :is(button, input)', { label: true }), [], `${label}: touch targets (a wrapped input's target is its label)`);
  const ids = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ids`);
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Passkey confirmation ${engine}: every state, posture and theme; demo-only and accessible`, { timeout: 600_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        for (const [size, dimensions] of Object.entries(SIZES)) {
          const d = await device(b!, { ...dimensions, touch: size !== 'desktop', scheme: 'dark', serviceWorkers: 'block' });
          const p = d.page;
          await p.addInitScript(WATCH_CREDENTIALS);
          const changes: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${r.url()}`); });
          await p.goto(`${base}/styleguide?entry=passkey-approval`);
          assert.equal(await p.getByRole('heading', { name: 'Passkey confirmation', exact: true }).count(), 1);
          const themes = await p.locator('#sg-ds option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
          assert.equal(themes.length, 7);
          for (const theme of themes) {
            const response = p.waitForResponse((r) => r.url().includes('/preview.css') && r.status() === 200);
            await p.locator('#sg-ds').selectOption(theme);
            await themeApplied(p, await (await response).text());
            for (const s of STATES) {
              await choose(p, 'passkey-state', s, `[data-passkey-specimen="${s}"]`);
              if (process.env.NOVA_PASSKEY_STYLEGUIDE_SHOTS && theme === 'nebula') {
                const folder = resolve(process.env.NOVA_PASSKEY_STYLEGUIDE_SHOTS, engine);
                mkdirSync(folder, { recursive: true });
                await p.mouse.move(0, 0);
                await padded(p, '#sg-passkey-approval [data-passkey-content]', join(folder, `${s}-${size}.png`));
              }
              const tier3 = p.locator('[data-passkey-specimen] .approval-sheet[data-tier="3"]');
              assert.equal(await tier3.locator(`[data-passkey-state="${s}"]`).count(), 1, `${s}: its line is shown`);
              assert.equal(await tier3.locator('[data-action="approve"]').count(), 0, `${s}: no plain Confirm on tier 3`);
              const confirm = tier3.locator('[data-action="passkey-confirm"]');
              if (['ready', 'cancelled', 'failed'].includes(s)) {
                assert.equal(await confirm.isDisabled(), true, `${s}: confirm waits for the box`);
                await tier3.locator('input[name="confirm"]').check();
                assert.equal(await confirm.isDisabled(), false, `${s}: the box enables it`);
                await confirm.click();
                assert.match(await p.locator('[data-passkey-demo-notice]').innerText(), /Demo only/);
              }
              if (s === 'rate') assert.equal(await confirm.isDisabled(), true);
              if (['unavailable', 'confirmed'].includes(s)) assert.equal(await confirm.count(), 0, `${s}: nothing to press`);
              // Tier 2 is unchanged: an ordinary Approve, no passkey.
              const tier2 = p.locator('[data-passkey-specimen] .approval-sheet[data-tier="2"]');
              assert.equal(await tier2.locator('[data-action="approve"]').innerText(), 'Approve');
              assert.equal(await tier2.locator('[data-passkey-state]').count(), 0);
              await geometry(p, `${engine}/${theme}/${size}/${s}`);
              if (theme === themes[0]) {
                await still(p);
                await p.evaluate(readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8'));
                const axe = await p.evaluate(async () => (window as any).axe.run(document.querySelector('#sg-passkey-approval')));
                assert.deepEqual(axe.violations.map((v: { id: string }) => v.id), [], `${engine}/${size}/${s}: axe`);
              }
            }
            for (const s of SETUP) {
              await choose(p, 'passkey-setup-state', s, `[data-passkey-setup-state="${s}"]`);
              await geometry(p, `${engine}/${theme}/${size}/setup-${s}`);
              if (process.env.NOVA_PASSKEY_STYLEGUIDE_SHOTS && theme === 'nebula') {
                await p.mouse.move(0, 0);
                await padded(p, '[data-passkey-setup-content]', join(resolve(process.env.NOVA_PASSKEY_STYLEGUIDE_SHOTS, engine), `setup-${s}-${size}.png`));
              }
            }
          }
          assert.deepEqual(await p.evaluate(() => (window as any).__passkeyCalls), [], 'the specimen never calls WebAuthn');
          assert.deepEqual(changes, [], 'the specimen changes nothing');
          assert.deepEqual(d.errors, []);
          await d.ctx.close();
        }
      });
    } finally { await b?.close(); }
  });
}
