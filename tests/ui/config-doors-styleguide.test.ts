// Config onboarding, design-first (owner direction 2026-11-04): the three doors into one layered
// store, in the living styleguide only, across the responsive matrix (desktop, tablet, phones,
// foldables folded, open and half-open). Demo only: the specimen reads no file and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, webkitBrowser, device, still, ROOT } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const STATES = ['import-choose', 'import-review', 'import-refused', 'import-applied', 'form-step', 'form-review', 'chat-asking', 'chat-asking-tier-3', 'chat-applied', 'chat-declined'];
// The owner's matrix: desktop bands, iPad-class, phones, and the foldables' postures.
const MATRIX = {
  'desktop-1920': { width: 1920, height: 1080 }, 'desktop-1440': { width: 1440, height: 900 }, 'desktop-1280': { width: 1280, height: 800 },
  'tablet-portrait': { width: 820, height: 1180 }, 'tablet-landscape': { width: 1180, height: 820 },
  'phone': { width: 390, height: 844 }, 'phone-large': { width: 430, height: 932 }, 'pixel': { width: 412, height: 915 },
  'fold-cover': { width: 344, height: 882 }, 'fold-open': { width: 884, height: 1104 }, 'fold-half-open': { width: 884, height: 540 },
  'pixel-fold-open': { width: 840, height: 701 }, 'duo-open': { width: 720, height: 540 },
};

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-config-styleguide-'));
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

async function padded(page: Page, selector: string, path: string) {
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height, vw: document.documentElement.clientWidth }; }, selector);
  const x = Math.max(0, r.x - 16), y = Math.max(0, r.y - 16);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', fullPage: true, clip: { x, y, width: Math.min(r.vw - x, r.w + 32), height: r.h + 32 } });
}
async function geometry(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  const root = page.locator('#sg-config-doors');
  assert.deepEqual(await root.evaluate((r) => [...r.querySelectorAll<HTMLElement>('button, label, p, h3, del, ins, .pill')].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)), [], `${label}: clipped text`);
  // In one task, from the live page: a locator's evaluateAll can be handed nodes a styleguide redraw has just replaced.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#sg-config-doors :is(button, select:not(#config-state), input:not([type="file"]))')].filter((e) => !(e as HTMLInputElement).disabled && e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 80))), [], `${label}: 44px targets`);
  const ids = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ids`);
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Config doors ${engine}: every door and state across the responsive matrix; demo-only and accessible`, { timeout: 900_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        for (const [size, dimensions] of Object.entries(MATRIX)) {
          const d = await device(b!, { ...dimensions, touch: !size.startsWith('desktop'), scheme: 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const changes: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${r.url()}`); });
          await p.goto(`${base}/styleguide?entry=config-doors`);
          assert.equal(await p.getByRole('heading', { name: 'Configuration: three doors (proposed)', exact: true }).count(), 1);
          for (const s of STATES) {
            await p.locator('#config-state').selectOption(s);
            await p.locator(`[data-config-specimen="${s}"]`).waitFor();
            const root = p.locator('#sg-config-doors');
            if (s === 'import-review') {
              assert.equal(await root.locator('[data-config-key="connectors.mail.key"] [role="alert"]').count(), 1, 'a secret in the file is refused, said why');
              assert.equal(await root.locator('[data-config-diff] .pill[data-layer]').count(), 4, 'every applied change names its layer');
            }
            if (s === 'form-step') assert.equal(await root.locator('[data-action="config-reset"]').count(), 2, 'an overlaid setting can go back to its default');
            if (s === 'chat-asking-tier-3') assert.match(await root.innerText(), /tier 3: confirmed every time/);
            const act = root.locator('[data-action^="config-"]').first();
            if (await act.count()) { await act.click(); assert.match(await p.locator('[data-config-demo-notice]').innerText(), /Demo only/); }
            await geometry(p, `${engine}/${size}/${s}`);
            if (process.env.NOVA_CONFIG_STYLEGUIDE_SHOTS) {
              const folder = resolve(process.env.NOVA_CONFIG_STYLEGUIDE_SHOTS, engine);
              mkdirSync(folder, { recursive: true });
              await p.mouse.move(0, 0);
              await padded(p, '#sg-config-doors [data-config-content]', join(folder, `${s}-${size}.png`));
            }
            if (size === 'phone' || size === 'desktop-1440') {
              await still(p);
              await p.addScriptTag({ content: readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8') });
              const axe = await p.evaluate(async () => (window as any).axe.run(document.querySelector('#sg-config-doors')));
              assert.deepEqual(axe.violations.map((v: { id: string }) => v.id), [], `${engine}/${size}/${s}: axe`);
            }
          }
          assert.deepEqual(changes, [], 'the specimen changes nothing');
          assert.deepEqual(d.errors, []);
          await d.ctx.close();
        }
      });
    } finally { await b?.close(); }
  });
}
